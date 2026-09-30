# Running Nori in the receipts profile

This runbook describes the implemented prototype. Run the synthetic demo in either account; run every live command in `receipts`. The service checks the current OS username before opening state or launching a provider. Keep `assistantUser` set to `receipts` in the real configuration.

## What is connected

| Component | Current behavior |
| --- | --- |
| Local engine | Approved contacts, per-contact enrollment, durable timers, job queue, pause, and delivery. Reminders run as an in-process plugin with per-contact state. |
| `imsg` | Adapter implemented and tested against fixtures; needs a compatible installation and an on-device test in `receipts`. |
| Jev | Optional routing; disabled by default and shadow-only until a plugin route is enabled. Unmatched request text and timezone leave the Mac only when enabled. |
| Codex | Optional owner-only runtime over the app-server protocol: sandboxed per-job threads, approvals and follow-ups by iMessage, plugin tools, budgets. Off unless `runtime` is configured. No desktop or Computer Use tasks. |
| iCloud Reminders / Calendar | Interfaces defined; native EventKit helper and sync are not implemented. Shared lists do not receive these local tasks yet. |
| BlueBubbles | Future alternative transport; no adapter or server installed by this project. |

The repository's durable inbox/outbox and bounded routing adapt patterns from `recipts`; its group scoring, hourly sweeps, and hosted application are not dependencies. The original MIT notice is retained in `LICENSE`.

## Account and permissions

Use the dedicated assistant Apple Account in `receipts`. Do not sign the main personal account into that profile just to expose its entire Messages history. Start one private conversation from each approved contact's phone to the assistant's iMessage email address, beginning with the owner. Share only the intended Reminders lists and calendars with the assistant Apple Account; accept invitations there when preparing the native integration.

| Permission/access | When it is needed | Scope |
| --- | --- | --- |
| Messages sign-in | Live transport setup | Dedicated assistant Apple Account in `receipts`. |
| Full Disk Access | Reading that profile's Messages database | Grant to the responsible executable/launcher shown by macOS for the tested invocation. Recheck after changing how the service launches. |
| Automation → Messages | First AppleScript send | Grant to the responsible process in `receipts`; test with a reminder requested by the owner. |
| Calendar and Reminders | Future EventKit helper | Grant to the eventual stable helper identity, after configuring selected resource IDs. Not needed for the local demo or local task ledger. |
| Accessibility / Screen Recording | Future Computer Use integration | Grant only to the verified desktop runtime after that integration works. Not needed by this implementation. |
| Admin credentials | Specific installation or permission changes if macOS requests them | The coordinator itself runs as a standard user; do not use `sudo node` or turn it into a root daemon. |

The `imsg` adapter explicitly requests AppleScript for sending; it does not call bridge launch/injection or private mutation methods. The relevant upstream contracts are [RPC](https://github.com/openclaw/imsg/blob/main/docs/rpc.md) and [message metadata](https://github.com/openclaw/imsg/blob/main/docs/json.md). Keep SIP enabled. Full Disk Access in Terminal does not establish access under a LaunchAgent: verify both launch contexts separately.

## Build and configure

1. Switch into `receipts`. Use a checkout owned by that account, for example `/Users/receipts/workspace/github.com/nori`. Install a supported Node 22 release (at least 22.19) there. An executable in `ajbarry`'s home is not a deployment dependency.
2. Run `npm ci`, `npm test`, and `npm run build` in that checkout. `npm run demo` verifies the local flow without personal data. Node 22 may emit an experimental warning for its built-in SQLite module.
3. Install a release of [standalone imsg](https://github.com/openclaw/imsg) that implements `status`, `messages.after`, `messages.history`, and `send`. Record its version; this code targets the documented protocol, not a confirmed release installed on this Mac. Do not run `imsg launch` for Nori's basic transport.
4. Sign in to Messages and send a setup greeting from each contact's phone. In `receipts`, inspect `imsg chats --json` and each selected chat's history to obtain the exact chat `id`, `guid`, and inbound `sender`. Do not copy this personal output into Git or shared logs. Use each contact's actual email/E.164 handle, not a display name.
5. Create the data directory and copy the template:

   ```sh
   mkdir -p "$HOME/Library/Application Support/Nori"
   chmod 700 "$HOME/Library/Application Support/Nori"
   cp nori.config.example.json "$HOME/Library/Application Support/Nori/config.json"
   chmod 600 "$HOME/Library/Application Support/Nori/config.json"
   ```

   Replace the owner placeholders and `chatId: 0` (deliberately invalid). Set `imsgPath` to the absolute result of `command -v imsg`. Check the timezone and quiet hours. Email handles are matched case-insensitively; phone handles require E.164. The direct chat GUID must match exactly. Leave `jev: null` for the initial smoke test.

   To approve another person, add a second entry to `contacts` with its own lowercase `id`, `name`, handles, and conversation, `"role": "member"`, and a `plugins` allowlist such as `["reminders"]`. Exactly one contact is the owner. Ids, handles, and conversations cannot be shared. A plugin runs for a contact only if the allowlist names it and the plugin permits that role.

## Enroll and test in the foreground

Run these in the `receipts` checkout:

```sh
node dist/cli.js doctor --config "$HOME/Library/Application Support/Nori/config.json"
node dist/cli.js enroll --config "$HOME/Library/Application Support/Nori/config.json" --contact owner
node dist/cli.js run --config "$HOME/Library/Application Support/Nori/config.json"
```

`doctor` checks database readability and protocol readiness, not sending, phone delivery, iCloud sync, or Codex authentication. Enrollment handles one contact at a time. It scans only that contact's chat and discards old content, and saves a physical scan watermark only after finding an inbound message from that contact with complete direct-chat metadata. Messages at or before that watermark are never executed. Send new requests after enrollment. Stop the service and run `enroll --contact <id>` for each additional contact; configured contacts that are not enrolled are ignored. Messages can never enroll anyone.

From the owner's phone, try `remind me to stretch in 1 minute`, then `snooze #1 20m` and `done #1`. Use the actual number in the acknowledgement. Verify the reminder reaches the phone once and completion prevents a later reminder. Quiet hours hold reminder messages; replies still work. `pause` affects discretionary nudges (none exist yet); `pause all` also holds requested reminders. `resume` respects quiet hours.

With a second contact enrolled, confirm that each person's `list` and `status` show only their own reminders and jobs, and that `pause all` from one person does not hold the other's reminders. Text `status` for a short task/queue summary. Without a configured runtime, a complex request explicitly remains queued; see [Codex jobs](#codex-jobs) for the runtime. Attachments, reactions, groups, and unauthorized senders are not supported inputs.

Stop the foreground service with Control-C. Once stopped, inspect local metadata without message bodies:

```sh
node dist/cli.js status --config "$HOME/Library/Application Support/Nori/config.json"
```

The local `status`, `doctor`, and enrollment commands also take the process lock, so stop the live service before running them. This avoids competing recovery/migration operations in the prototype. Use iMessage `status` while it is running.

## Optional background launcher

After the foreground smoke test passes, copy `launchd/ai.nori.agent.plist.example` into `~/Library/LaunchAgents/ai.nori.agent.plist` in `receipts`. Replace `REPLACE_WITH_ABSOLUTE_NODE_PATH` with that account's stable Node executable and check the checkout/config paths. The plist intentionally contains no secrets and does not install itself. Validate it with `plutil -lint` before loading it.

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.nori.agent.plist"
launchctl print "gui/$(id -u)/ai.nori.agent"
```

Repeat the phone smoke test under the launcher. Then switch to the main profile without logging `receipts` out and repeat it. Background messaging, active-session desktop access, and switched-user desktop access are separate tests. This prototype makes no computer-use claim for any of them.

The template starts at login and stops on errors. It deliberately does not loop on an account mismatch, stale lock, revoked permission, or unknown send outcome. After correcting the issue and reviewing pending state, restart it with `launchctl kickstart "gui/$(id -u)/ai.nori.agent"`. To stop/uninstall the launcher:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.nori.agent.plist"
rm "$HOME/Library/LaunchAgents/ai.nori.agent.plist"
```

The template writes operational output into the data directory; it does not rotate logs. Raw owner text and credentials are not logged. OS sleep, logout, and power loss prevent on-time delivery. On restart, due reminders wait for message catch-up so a completion already received can cancel them.

## Recovery and data

- `service.lock` prevents concurrent owners. After a crash, inspect its PID and ensure the former service and its `imsg` and `codex app-server` children, and any commands Codex started, have stopped before manually removing it. Never remove a lock merely because a second launch failed.
- An outgoing `uncertain` item may already have been sent. Review the assistant's Messages conversation before deciding what to do. There is no automatic retry or resend command for these items yet. `sent` means a local message GUID was observed; it is not proof of phone delivery.
- A new Messages database inode/path/birth time or changed assistant username invalidates every enrollment. A contact whose configured conversation no longer matches its enrollment halts the service. Stop, back up Nori state, and reconcile pending work. There is no automatic cursor reset, unenroll, or migration command. Changing Apple Accounts in an existing Messages database also needs manual review; filesystem identity is not an Apple Account sign-in detector.
- A state database created before approved contacts is refused. Move `state.sqlite` and its sidecars aside and enroll each contact again. Its reminders and jobs are not migrated.
- Stop Nori before making a filesystem backup, and preserve `state.sqlite` plus any SQLite sidecars together. Keep backups encrypted and outside iCloud Drive. Do not sync the live database as a file. Restore is an operator task in this prototype.
- The database contains accepted contact text, reminders, jobs, and outgoing message bodies. It uses a private directory and file permissions, not application-level encryption. Automatic content retention, deletion/export controls, Keychain integration, and schema rollback tooling remain pending.

## Jev and Codex probes

To evaluate Jev, set `jev` to a pinned model, for example `{"model":"jev-1.13.0","timeoutMs":2500,"dailyLimit":100,"routes":{}}`, and supply `TYPESAFE_API_KEY` to the process from a protected local source. Do not put the key in the plist, repository, or command arguments. The prototype does not load `.env` automatically. See [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) and [Noul](https://docs.typesafe.ai/primitives/noul) for the request/response contract and confirm model availability in the account.

Only queued unmatched requests go to Jev; engine commands and plugin grammars stay local. Each call asks which catalog option fits (the contact's permitted plugins, plus runtime for the owner, continue, and clarify) and whether the request contains more than one action. Decisions retain the catalog version, confidence, and probabilities. With `routes` empty, Jev is shadow-only: decisions are recorded and jobs stay queued. Failures leave jobs queued. Each job receives one routing attempt, and `dailyLimit` (default 100) caps calls per local day; later jobs wait unrouted until the next day.

After reviewing recorded decisions against labeled examples such as `test/fixtures/routing.json`, enable one plugin at a time by adding its threshold, for example `"routes": {"reminders": 0.9}`. A route acts only for a confident, single, non-compound request from a contact allowed to use that plugin; the plugin's `interpret` result is validated before it runs. The contact first receives the acknowledgement, then the plugin's reply. With a runtime configured, every other owner request goes to Codex, including when Jev abstains, fails, or has used its daily budget.

## Codex jobs

The runtime is off until `runtime` is set in the configuration. It is owner-only: members' other requests stay queued.

1. In `receipts`, install the Codex CLI to use. The CLI bundled with Codex.app lives at `/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex`. Nori was built against `codex-cli 0.158.0-alpha.2.1` and uses experimental app-server features (dynamic tools and structured final messages), so re-run the tests below after upgrading Codex. Nori runs Codex with its own Codex home, `codex` inside the data directory, never the account's `~/.codex`. Sign in there once:

   ```sh
   NORI_CODEX_HOME="$HOME/Library/Application Support/Nori/codex"
   mkdir -p -m 700 "$NORI_CODEX_HOME"
   CODEX_HOME="$NORI_CODEX_HOME" /absolute/path/to/codex login
   CODEX_HOME="$NORI_CODEX_HOME" /absolute/path/to/codex login status
   ```

2. Check the connection without starting a model turn:

   ```sh
   node dist/cli.js probe-codex --config "$HOME/Library/Application Support/Nori/config.json" --codex /absolute/path/to/codex
   ```

3. Add the runtime to the configuration. Only `codexPath` is required; these are the defaults:

   ```json
   "runtime": {
     "codexPath": "/absolute/path/to/codex",
     "model": null,
     "workspaceDir": "/Users/receipts/Library/Application Support/Nori/workspaces",
     "budget": { "minutes": 30, "turns": 8, "toolCalls": 40, "tokens": 2000000 },
     "daily": { "tasks": 20, "tokens": 10000000 },
     "approvalMinutes": 60,
     "maxJobs": 1
   }
   ```

   `model: null` uses the Codex default for that login. `maxJobs` (1–8) is how many jobs may run at once; they share one Codex connection, so when Nori has to close it (an interrupt or turn start it cannot confirm, or a shutdown) every running job is interrupted and waits for `continue #n`. `doctor` reports whether the runtime is configured; `run` refuses to start if `codexPath` is not executable.

How a job behaves over iMessage:

- An unmatched request gets one acknowledgement (`Got it — job #3 …`). Codex starts it in a new thread, in a private directory `workspaces/task-<id>`, with the `workspace-write` sandbox. Up to `maxJobs` jobs run at once; others wait to start, oldest first.
- Codex's result arrives as `Job #3 is done. …` only when it reports what it checked. A question arrives as `Job #3 asks: …`; reply normally to answer it, or `#3 <answer>` when several jobs are waiting. `#3 <text>` also adds instructions to a running job for its next step.
- When Codex needs to leave the sandbox (network access, files outside the job directory) or calls a high-impact plugin tool, Nori asks `Job #3 needs your OK to …` with the exact command, the files it would change, any extra access, or the tool's full arguments. Reply with the code from that message, for example `approve A7` or `deny A7`; a code only ever answers its own request. A job asks one approval at a time. Unanswered or overdue requests are refused after `approvalMinutes`, and anything too long to show in full is refused without asking.
- Reaching a time, turn, tool-call, or usage limit pauses the job with a message; `continue #3` allows one more allowance. Daily limits hold new jobs until the next day. `status` lists running, waiting, paused, and waiting-to-start jobs.
- `cancel #3` or `stop` interrupts a running job. Anything it already did stays done.
- If Nori stops or loses the Codex connection mid-job, the job waits as interrupted and is never resubmitted automatically. `continue #3` resumes the same thread and tells Codex to check what was already done first. When Nori stops, cancels a job whose interrupt fails, or closes the connection, it kills Codex and every command Codex started before the job ends or the service exits. If it cannot confirm they stopped, Nori stops with `Codex commands from a closed connection could not be confirmed stopped.` and leaves `service.lock` in place: check for leftover Codex commands (for example `ps -A -o pid,ppid,command`), stop any, then remove the lock and restart.

Boundaries and known limits:

- Codex gets a minimal environment (no `TYPESAFE_API_KEY` or other Nori secrets) and is never passed Nori's database, transport, or credentials. Its plugin tools act only for the job's contact, and each call is re-checked and recorded.
- Every turn pins approvals to you (not an automatic reviewer) and a sandbox with no extra writable roots or network, overriding the Codex configuration. Because Nori uses its own Codex home, the `receipts` account's Codex configuration, execution rules, trusted projects, and MCP servers do not apply to jobs. Keep Nori's Codex home to the login alone: add no configuration, rules, or MCP servers there, since MCP tools would bypass Nori's broker.
- Codex execution rules (`rules/*.rules`) can run a matching command outside the sandbox without asking you. Before every turn Nori asks Codex which configuration layers apply to the job's directory. If any has execution rules, including machine-wide ones in `/etc/codex/rules`, or cannot be checked, the job fails with a message naming the problem and nothing runs. Remove the rules, then send the request again. A configuration layer Nori cannot inspect, such as one managed by MDM, also stops jobs. Other machine-wide Codex configuration in `/etc/codex` still applies.
- The Codex sandbox limits writes and network access, not reads. Commands can read files the `receipts` account can read, including Nori's state database, and inherit the service's macOS privacy permissions such as Full Disk Access. Keep personal data out of that account, and treat Codex jobs as able to see Nori's stored messages. Stronger isolation, such as running Codex under a separate account, is future work.
- Web pages and files are untrusted input. Approvals show the exact command, and high-impact tools always ask, but a prompt-injected job can still read data and write inside its sandbox.
- Plugin tools are passed when a thread starts and are assumed to persist when Nori resumes that thread after a restart. Verify this with a real job before relying on it.
- Computer Use is unverified. Nori does not send GUI tasks to Codex.

Smoke test in `receipts` after the reminder test: from the owner's phone, send a small research request, answer its question if it asks one, and approve one sandbox escalation (for example, ask it to fetch a public web page, which needs network access). Confirm one acknowledgement, one approval question, and one final result arrive. Then stop and restart Nori during a second job and confirm it reports the interruption and resumes with `continue #n`. See [app-server documentation](https://learn.chatgpt.com/docs/app-server).
