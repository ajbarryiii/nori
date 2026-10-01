# Running Nori

This runbook describes the implemented prototype. Nori runs in a dedicated macOS user account, called the *assistant account* here; the examples name it `nori`. Run the synthetic demo anywhere; run every live command in the assistant account. The service checks the current OS username against `assistantUser` before opening state or launching a provider, so set `assistantUser` to the assistant account's short name in the real configuration.

## What is connected

| Component | Current behavior |
| --- | --- |
| Local engine | Approved contacts, per-contact enrollment, durable timers, job queue, pause, and delivery. Reminders run as an in-process plugin with per-contact state. |
| `imsg` | Adapter implemented and tested against fixtures; needs a compatible installation and an on-device test in the assistant account. |
| Jev | Optional routing; disabled by default and shadow-only until a plugin route is enabled. Unmatched request text and timezone leave the Mac only when enabled. |
| Conversational replies | Optional `responder` (OpenRouter or Codex) with Jev. Off by default; see [Conversational replies](#conversational-replies). |
| Codex | Optional owner-only runtime over the app-server protocol: sandboxed per-job threads, approvals and follow-ups by iMessage, plugin tools, budgets. Off unless `runtime` is configured. No desktop or Computer Use tasks. |
| iCloud Reminders / Calendar | Interfaces defined; native EventKit helper and sync are not implemented. Shared lists do not receive these local tasks yet. |
| BlueBubbles | Future alternative transport; no adapter or server installed by this project. |


## Account and permissions

Use a dedicated assistant Apple Account in the assistant account. Do not sign your personal Apple Account into that macOS account just to expose its entire Messages history. Start one private conversation from each approved contact's phone to the assistant's iMessage email address, beginning with the owner. Share only the intended Reminders lists and calendars with the assistant Apple Account; accept invitations there when preparing the native integration.

| Permission/access | When it is needed | Scope |
| --- | --- | --- |
| Messages sign-in | Live transport setup | Dedicated assistant Apple Account in the assistant account. |
| Full Disk Access | Reading that profile's Messages database | Grant to the responsible executable/launcher shown by macOS for the tested invocation. Recheck after changing how the service launches. |
| Automation → Messages | First AppleScript send | Grant to the responsible process in the assistant account; test with a reminder requested by the owner. |
| Calendar and Reminders | Future EventKit helper | Grant to the eventual stable helper identity, after configuring selected resource IDs. Not needed for the local demo or local task ledger. |
| Accessibility / Screen Recording | Future Computer Use integration | Grant only to the verified desktop runtime after that integration works. Not needed by this implementation. |
| Admin credentials | Specific installation or permission changes if macOS requests them | The coordinator itself runs as a standard user; do not use `sudo node` or turn it into a root daemon. |

The `imsg` adapter explicitly requests AppleScript for sending; it does not call bridge launch/injection or private mutation methods. The relevant upstream contracts are [RPC](https://github.com/openclaw/imsg/blob/main/docs/rpc.md) and [message metadata](https://github.com/openclaw/imsg/blob/main/docs/json.md). Keep SIP enabled. Full Disk Access in Terminal does not establish access under a LaunchAgent: verify both launch contexts separately.

## Build and configure

1. Switch into the assistant account. Use a checkout owned by that account, for example `/Users/nori/workspace/github.com/nori`. Install a supported Node 22 release (at least 22.19) there. Do not depend on executables in another account's home.
2. Run `npm ci`, `npm test`, and `npm run build` in that checkout. `npm run demo` verifies the local flow without personal data. Node 22 may emit an experimental warning for its built-in SQLite module.
3. Install a release of [standalone imsg](https://github.com/openclaw/imsg) that implements `status`, `messages.after`, `messages.history`, and `send`. Record its version; this code targets the documented protocol, not a specific confirmed release. Do not run `imsg launch` for Nori's basic transport.
4. Sign in to Messages and send a setup greeting from each contact's phone. In the assistant account, inspect `imsg chats --json` and each selected chat's history to obtain the exact chat `id`, `guid`, and inbound `sender`. Do not copy this personal output into Git or shared logs. Use each contact's actual email/E.164 handle, not a display name.
5. Create the data directory and copy the template:

   ```sh
   mkdir -p "$HOME/Library/Application Support/Nori"
   chmod 700 "$HOME/Library/Application Support/Nori"
   cp nori.config.example.json "$HOME/Library/Application Support/Nori/config.json"
   chmod 600 "$HOME/Library/Application Support/Nori/config.json"
   ```

   Set `assistantUser` to the assistant account's short name and `dataDir` to its data directory. Replace the owner placeholders and `chatId: 0` (deliberately invalid). Set `imsgPath` to the absolute result of `command -v imsg`. Check the timezone and quiet hours. Email handles are matched case-insensitively; phone handles require E.164. The direct chat GUID must match exactly. Leave `jev`, `responder`, and `runtime` as `null` for the initial smoke test.

   To approve another person, add a second entry to `contacts` with its own lowercase `id`, `name`, handles, and conversation, `"role": "member"`, and a `plugins` allowlist such as `["reminders"]`. Exactly one contact is the owner. Ids, handles, and conversations cannot be shared. A plugin runs for a contact only if the allowlist names it and the plugin permits that role.

## Enroll and test in the foreground

Run these in the assistant account's checkout:

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

After the foreground smoke test passes, copy `launchd/ai.nori.agent.plist.example` into `~/Library/LaunchAgents/ai.nori.agent.plist` in the assistant account. Replace `REPLACE_WITH_ABSOLUTE_NODE_PATH` with that account's stable Node executable, and replace the example `/Users/nori` paths with the account's checkout and data directory. The plist intentionally contains no secrets and does not install itself. Validate it with `plutil -lint` before loading it.

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.nori.agent.plist"
launchctl print "gui/$(id -u)/ai.nori.agent"
```

Repeat the phone smoke test under the launcher. Then switch to your everyday account without logging the assistant account out, and repeat it. Background messaging, active-session desktop access, and switched-user desktop access are separate tests. This prototype makes no computer-use claim for any of them.

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
- The database contains accepted contact text, reminders, jobs, and outgoing message bodies. It uses a private directory and file permissions, not application-level encryption. Model API keys live in the login Keychain; Nori's own state does not. Automatic content retention, deletion/export controls, and schema rollback tooling remain pending.
- A database from before conversational replies (schema 2) is upgraded in place on first open; existing messages are treated as handled.

## Jev and Codex probes

To evaluate Jev, set `jev` to a pinned model, for example `{"model":"jev-1.13.0","timeoutMs":2500,"dailyLimit":100,"routes":{}}`, and store the TypeSafe key as described under [Keys](#keys). Do not put the key in the plist, repository, or command arguments. The prototype does not load `.env` automatically. See [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) and [Noul](https://docs.typesafe.ai/primitives/noul) for the request/response contract and confirm model availability in the account.

Only queued unmatched requests go to Jev; engine commands and plugin grammars stay local. Each call asks which catalog option fits (the contact's permitted plugins, plus runtime for the owner, continue, and clarify) and whether the request contains more than one action. Decisions retain the catalog version, confidence, and probabilities. With `routes` empty, Jev is shadow-only: decisions are recorded and jobs stay queued. Failures leave jobs queued. Each job receives one routing attempt, and `dailyLimit` (default 100) caps all Jev calls per local day, including conversational ones; later jobs wait unrouted until the next day.

After reviewing recorded decisions against labeled examples such as `test/fixtures/routing.json`, enable one plugin at a time by adding its threshold, for example `"routes": {"reminders": 0.9}`. A route acts only for a confident, single, non-compound request from a contact allowed to use that plugin; the plugin's `interpret` result is validated before it runs. The contact first receives the acknowledgement, then the plugin's reply. With a runtime configured, every other owner request goes to Codex, including when Jev abstains, fails, or has used its daily budget.

## Codex jobs

The runtime is off until `runtime` is set in the configuration. It is owner-only: members' other requests stay queued.

1. In the assistant account, install the Codex CLI to use. The CLI bundled with Codex.app lives at `/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex`. Nori was built against `codex-cli 0.158.0-alpha.2.1` and uses experimental app-server features (dynamic tools and structured final messages), so re-run the tests below after upgrading Codex. Nori runs Codex with its own Codex home, `codex` inside the data directory, never the account's `~/.codex`. Sign in there once:

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
     "workspaceDir": "/Users/nori/Library/Application Support/Nori/workspaces",
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
- Every turn pins approvals to you (not an automatic reviewer) and a sandbox with no extra writable roots or network, overriding the Codex configuration. Because Nori uses its own Codex home, the assistant account's Codex configuration, execution rules, trusted projects, and MCP servers do not apply to jobs. Keep Nori's Codex home to the login alone: add no configuration, rules, or MCP servers there, since MCP tools would bypass Nori's broker.
- Codex execution rules (`rules/*.rules`) can run a matching command outside the sandbox without asking you. Before every turn Nori asks Codex which configuration layers apply to the job's directory. If any has execution rules, including machine-wide ones in `/etc/codex/rules`, or cannot be checked, the job fails with a message naming the problem and nothing runs. Remove the rules, then send the request again. A configuration layer Nori cannot inspect, such as one managed by MDM, also stops jobs. Other machine-wide Codex configuration in `/etc/codex` still applies.
- The Codex sandbox limits writes and network access, not reads. Commands can read files the assistant account can read, including Nori's state database, and inherit the service's macOS privacy permissions such as Full Disk Access. Keep personal data out of that account, and treat Codex jobs as able to see Nori's stored messages. Stronger isolation, such as running Codex under a separate account, is future work.
- Web pages and files are untrusted input. Approvals show the exact command, and high-impact tools always ask, but a prompt-injected job can still read data and write inside its sandbox.
- Plugin tools are passed when a thread starts and are assumed to persist when Nori resumes that thread after a restart. Verify this with a real job before relying on it.
- Computer Use is unverified. Nori does not send GUI tasks to Codex.

Smoke test in the assistant account after the reminder test: from the owner's phone, send a small research request, answer its question if it asks one, and approve one sandbox escalation (for example, ask it to fetch a public web page, which needs network access). Confirm one acknowledgement, one approval question, and one final result arrive. Then stop and restart Nori during a second job and confirm it reports the interruption and resumes with `continue #n`. See [app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Conversational replies

Leave `responder` null for the first smoke test. Once the templated service works under the launcher, enable conversation with Jev plus a responder, and enable the reminders route:

```json
"jev": { "model": "jev-1.13.0", "timeoutMs": 2500, "dailyLimit": 1000, "routes": { "reminders": 0.8 } },
"responder": { "provider": "openrouter", "model": "xiaomi/mimo-v2.6-flash", "timeoutMs": 20000, "dailyLimit": 300 }
```

A `responder` without `jev` is rejected. Restart the service after changing the configuration, then run `doctor` to confirm the keys are found.

**How a message is handled.** Engine commands (`status`, `pause all`, `cancel #2`, `approve A7`, …) and plugin grammar (`list`, `done #1`, `snooze #1 20m`, …) apply immediately without a model. Anything else waits, in order for that contact, while Jev reads it with the contact's tracked items, open jobs, and recent conversation:

1. Requests that ask Nori itself to contact someone or act in another app, messages with several instructions, and requests for research or other bigger work become jobs (handled by Codex for the owner when `runtime` is set).
2. A change needs confidence of at least its acting threshold: `jev.routes` for a plugin such as reminders, `thresholds.act` (default 0.8) for pause, resume, and cancelling a job. Between `thresholds.clarify` (default 0.5) and that threshold, Nori asks which of the two likeliest options was meant. Below `clarify`, the message is kept as a job. A plugin missing from `routes` never acts; its messages become jobs.
3. For a confident change, the plugin extracts details with the responder into a strict schema, and code resolves them. For reminders, the time must be in the future, within a year, and not in a DST gap or repeat, and the reminder number must exist. A second Jev check must agree with the code-written description at `thresholds.verify` (default 0.6), or Nori asks "Did you mean …?"; replying "yes" confirms it.
4. The change and a template reply commit together. The responder may then rephrase the reply. Code keeps the rephrased text only if it still has the numbers and each time with its calendar date (never "today" or "tomorrow", since it may be read later), and a Jev check confirms it claims nothing beyond what was committed. Questions and answers such as status are always sent exactly as code wrote them, and a phrased reply may name no other time, date, or weekday. Otherwise the template is sent.

Vague times get sensible defaults (morning 9:00, afternoon 15:00, tonight 20:00), and the reply always states the exact time, so a wrong guess is visible. A contact's due reminders wait while one of their earlier messages is still being understood, so "done" cannot lose a race with the reminder. Any model failure, timeout, or budget stop falls back to keeping the message as a job, with the usual acknowledgement.

### Keys

Store keys in the assistant account's login Keychain so they never appear in files, the plist, or process arguments. With `-w` last, `security` prompts for the value instead of taking it from the command line:

```sh
security add-generic-password -a "$USER" -s ai.nori.typesafe -w
security add-generic-password -a "$USER" -s ai.nori.openrouter -w
```

Environment variables named `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` take precedence when set. The first Keychain read from the LaunchAgent may show an access prompt; verify under launchd, not only in Terminal. Child processes (`imsg`, Codex) never receive the keys.

**What leaves the Mac.** For each message that needs understanding, Nori sends its text, up to eight turns of the last six hours of that contact's conversation, the status lines of their plugins (reminder titles and times), and up to five of their open jobs to TypeSafe and to the responder. This applies to every enrolled contact, not only the owner. OpenRouter requests are restricted to providers that do not collect prompts and that support strict JSON output, with reasoning off. Commands, grammar matches, and reminder delivery never call a model.

**Budgets.** `jev.dailyLimit` and `responder.dailyLimit` cap calls per local day, counted in SQLite before a request is sent, so restarts do not reset them. A conversational message usually costs two or three Jev calls and one or two responder calls. `chat` and `eval` keep separate ceilings, so running them with the live keys adds to real spend. At a limit, Nori falls back to templates and `status` says so. The local `status` command prints today's usage.

### Using a ChatGPT plan through Codex

The responder can run on the ChatGPT plan signed in to Nori's Codex home (see [Codex jobs](#codex-jobs) for signing in). It uses its own app-server, separate from job execution:

```json
"responder": { "provider": "codex", "model": "gpt-6-luna", "timeoutMs": 90000, "dailyLimit": 300 }
```

`codexPath` defaults to `runtime.codexPath`; set it when no runtime is configured. Each call is its own ephemeral, read-only thread with approvals set to never, and shell, apps, plugins, browser, computer use, image generation and viewing, skills search, sleep, sub-agents, memories, hooks, web search, and MCP servers disabled. Before using a connection, Nori reads Codex's effective configuration and refuses to use it if any MCP server is still enabled, for example one added in `/etc/codex/config.toml`; the responder then falls back to templates. Calls count against the plan's Codex allowance; Luna is the lightest model. The adapter was verified against `codex-cli 0.156.1` with live Luna turns, at roughly 2 to 4 seconds per turn.

This signs a ChatGPT account into the assistant account. Anyone with access to that macOS account can use the plan. OpenAI's terms for driving Codex from a personal assistant process were not verified.

### Tuning the thresholds

`eval` sends the labelled messages in `eval/cases.json` to TypeSafe and prints each routing decision, the gate's verdict, routing accuracy, and the number of confident wrong changes. It needs only a `jev` section and the TypeSafe key, and it runs on any machine:

```sh
node dist/cli.js eval --config dev.json
```

Adjust `jev.thresholds` and `jev.routes` from the results. Keep Jev pinned to a version and re-run the evaluation before changing it.

## Developing on another machine

`chat` runs the real service loop with a console transport: each typed line is a message from a synthetic owner, and replies print to the terminal. It never touches iMessage and runs on Linux. It reads only `timezone`, `quietHours`, `jev`, and `responder` from `--config`; identity, contacts, transport, paths, and the Codex runtime are forced to console values. State lives in `console.sqlite` under `--data-dir` (default `~/.local/state/nori-console`), protected by the same lock. Keys come from the environment. The live service still requires macOS and the assistant account.
