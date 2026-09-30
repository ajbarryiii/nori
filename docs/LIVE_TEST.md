# Live test in the `receipts` profile

Step-by-step instructions for testing branch `feat/plugin-runtime` on the real assistant account. Run everything in the **`receipts` macOS profile**. Live commands refuse to run in any other account. `docs/RUNBOOK.md` has background on every step.

The goals are the plan's first two milestones:

- **Reminders**: reminders work end to end over iMessage.
- **Codex**: one Codex job is started, followed up, approved once, and completed over iMessage.

Keep notes of anything that differs from the expected results below.

## 1. Get the code

```sh
mkdir -p ~/workspace/github.com && cd ~/workspace/github.com
git clone https://github.com/ajbarryiii/nori.git
cd nori
git checkout feat/plugin-runtime
```

Install Node 22.19 or newer for this account, for example with nvm (`nvm install 22 && nvm use`). Then:

```sh
npm ci
npm test            # expect: all tests pass
npm run build
npm run demo        # synthetic run; sends nothing
```

## 2. Messages and imsg

1. Sign in to Messages with the **dedicated assistant Apple Account**, not your personal one.
2. From your phone, send a setup greeting (for example `hi`) to the assistant's iMessage address.
3. Install standalone imsg (https://github.com/openclaw/imsg) and note its path: `command -v imsg`.
4. Grant **Full Disk Access** to the Terminal app you are using: System Settings → Privacy & Security → Full Disk Access.
5. Find the chat details. Do not paste this output anywhere shared:

   ```sh
   imsg chats --json
   ```

   Record the chat's numeric `id` and its `guid` (it starts with `iMessage;-;` or, on newer macOS, `any;-;`). Also record the exact `sender` handle your phone uses: an email address, or a phone number in `+1…` form.

## 3. Configure

```sh
mkdir -p "$HOME/Library/Application Support/Nori"
chmod 700 "$HOME/Library/Application Support/Nori"
cp nori.config.example.json "$HOME/Library/Application Support/Nori/config.json"
chmod 600 "$HOME/Library/Application Support/Nori/config.json"
open -e "$HOME/Library/Application Support/Nori/config.json"
```

Edit the file:

- `contacts[0].handles`: your handle from step 2.
- `contacts[0].conversation.chatId` and `.chatGuid`: the chat `id` and `guid`. The placeholder `0` is deliberately invalid.
- `imsgPath`: the absolute path from `command -v imsg`.
- Check `timezone` and `quietHours`.
- Leave `jev` and `runtime` as `null` for now.

## 4. Reminders test

Use one shell variable to keep commands short:

```sh
CFG="$HOME/Library/Application Support/Nori/config.json"
node dist/cli.js doctor --config "$CFG"
node dist/cli.js enroll --config "$CFG" --contact owner
node dist/cli.js run --config "$CFG"
```

- `doctor` should show `messages.ready: true` and your contact with `enrolled: false`.
- `enroll` should print `Enrolled owner at cursor …`. If it asks for an inbound message, send another greeting from your phone and retry.
- `run` stays in the foreground. Leave it running.

From your phone, send these in order. Use the numbers the replies actually give you.

| Send | Expect |
| --- | --- |
| `remind me to stretch in 1 minute` | `Saved locally #1: stretch. I'll remind you …` |
| (wait one minute) | `Reminder #1: stretch. …`, **exactly once** |
| `snooze #1 2m` | `Snoozed #1 until …` |
| `done #1` | `Completed #1: stretch.` No further reminder arrives. |
| `note buy milk`, then `list` | The list shows `buy milk` |
| `status` | Active tasks and `0 queued jobs.` |
| `research a laptop for me` | `Saved job #1. It is queued; Codex execution is not connected yet. …` |
| `cancel #1` | `Cancelled job #1.` |

Stop `run` with Control-C. Then check local state (it prints metadata only):

```sh
node dist/cli.js status --config "$CFG"
```

Expect no `uncertain` items in `outbox`. If any appear, check the Messages conversation to see whether they were delivered. Do not delete them.

## 5. Codex setup

1. Sign in to Codex for Nori. Nori runs Codex with its own Codex home inside its data directory, not this account's `~/.codex`, so it needs its own sign-in even if Codex.app is already signed in. The CLI bundled with Codex.app works:

   ```sh
   CODEX=/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex
   NORI_CODEX_HOME="$HOME/Library/Application Support/Nori/codex"
   "$CODEX" --version
   mkdir -p -m 700 "$NORI_CODEX_HOME"
   CODEX_HOME="$NORI_CODEX_HOME" "$CODEX" login
   CODEX_HOME="$NORI_CODEX_HOME" "$CODEX" login status   # expect: Logged in …
   ```

2. Add nothing else to Nori's Codex home: no configuration, no execution rules, and in particular **no MCP servers**, whose tools would bypass Nori's checks. If Codex execution rules exist there or in `/etc/codex/rules`, every job fails with `Job #N couldn't be finished: Codex has execution rules in …`.
3. Probe the connection. This starts no model turn:

   ```sh
   node dist/cli.js probe-codex --config "$CFG" --codex "$CODEX"
   ```

   Expect `"connected": true`.

4. Add the runtime to the config. Replace `"runtime": null` with:

   ```json
   "runtime": { "codexPath": "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex" }
   ```

   The defaults are a 30-minute, 8-turn, 40-tool-call budget per job, 20 jobs per day, and a 60-minute approval window.

5. Run `node dist/cli.js doctor --config "$CFG"`. Expect `codexExecution: "configured; …"`.

A Codex job can read any file this account can read, including Nori's state database. Keep personal files out of `receipts`.

## 6. Codex test

Start the service again: `node dist/cli.js run --config "$CFG"`. From your phone:

1. Send: `Look up the current weather forecast for San Francisco and remind me tomorrow at 9 am if it will rain`.
   - Expect **one** acknowledgement: `Got it — job #N. I'll message you when it's done or if I need you. …`
2. The job needs network access, so expect an approval request: `Job #N needs your OK to run a command: … Reply ‘approve A1’ or ‘deny A1’ within 60 minutes.` Each request has its own code.
   - Check that the command shown is what it claims to be, then reply with its code, for example `approve A1`. Expect `Approved A1 for job #N.`
   - If Codex asks for more approvals, they arrive one at a time.
3. If Codex asks a question (`Job #N asks: …`), just reply. Expect `Thanks — continuing job #N.`
4. Expect a final result: `Job #N is done. …`
   - If it created a reminder, `list` should show it. The reminder was made through Nori's reminders tool, not a separate message.
5. Send `status` at any point during the job. It should list the job as running, or waiting for your reply or approval.

**Restart test.**
1. Send another request, for example `compare two budget laptops and summarize`.
2. While it is running (`status` shows `Running: #M.`), stop the service with Control-C and start it again.
3. Expect `Job #M was interrupted before it finished. Reply ‘continue #M’ …`. Nori must not restart it on its own.
4. Reply `continue #M` and expect it to resume and finish.

**Optional checks:**
- `stop` while a job runs: expect `Stopped job #M. …`.
- `deny A<code>` on an approval: the job continues without that command, or explains that it couldn't.

## 7. What to report back

- Which expectations above failed, with the exact reply text you saw.
- Whether the approval request and the tool-created reminder worked. These are the parts not yet verified against a real Codex model.
- After the restart test, whether the resumed job could still use Nori's tools (for example `list` its reminders). This checks whether Codex keeps dynamic tools after a thread resume.
- Output of `node dist/cli.js status --config "$CFG"`. It contains no message text.

Afterwards, stop the service. The test data lives in `~/Library/Application Support/Nori/`. Move `state.sqlite*` aside to start fresh, or keep it for the next round.
