# Running Nori in the receipts profile

This runbook describes the implemented prototype. Run the synthetic demo in either account; run every live command in `receipts`. The service checks the current OS username before opening state or launching a provider. Keep `assistantUser` set to `receipts` in the real configuration.

## What is connected

| Component | Current behavior |
| --- | --- |
| Local coordinator | Durable owner-only capture, reminders, completion, snooze, pause, and job queue. |
| `imsg` | Adapter implemented and tested against fixtures; needs a compatible installation and an on-device test in `receipts`. |
| Jev | Optional shadow routing; disabled by default. Unknown request text and timezone leave the Mac only when enabled. |
| Codex | Read-only app-server handshake. No model turn, delegated execution, approvals, or desktop tool connection yet. |
| iCloud Reminders / Calendar | Interfaces defined; native EventKit helper and sync are not implemented. Shared lists do not receive these local tasks yet. |
| BlueBubbles | Future alternative transport; no adapter or server installed by this project. |

The repository's durable inbox/outbox and bounded routing adapt patterns from `recipts`; its group scoring, hourly sweeps, and hosted application are not dependencies. The original MIT notice is retained in `LICENSE`.

## Account and permissions

Use the dedicated assistant Apple Account in `receipts`. Do not sign the main personal account into that profile just to expose its entire Messages history. Start one private conversation from the owner's phone to the assistant's iMessage email address. Share only the intended Reminders lists and calendars with the assistant Apple Account; accept invitations there when preparing the native integration.

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
4. Sign in to Messages and send a setup greeting from the owner's phone. In `receipts`, inspect `imsg chats --json` and the selected chat's history to obtain the exact chat `id`, `guid`, and inbound `sender`. Do not copy this personal output into Git or shared logs. Use the owner's actual email/E.164 handle, not a display name.
5. Create the data directory and copy the template:

   ```sh
   mkdir -p "$HOME/Library/Application Support/Nori"
   chmod 700 "$HOME/Library/Application Support/Nori"
   cp nori.config.example.json "$HOME/Library/Application Support/Nori/config.json"
   chmod 600 "$HOME/Library/Application Support/Nori/config.json"
   ```

   Replace the owner placeholders and `chatId: 0` (deliberately invalid). Set `imsgPath` to the absolute result of `command -v imsg`. Check the timezone and quiet hours. Email handles are matched case-insensitively; phone handles require E.164. The direct chat GUID must match exactly. Leave `jev: null` for the initial smoke test.

## Enroll and test in the foreground

Run these in the `receipts` checkout:

```sh
node dist/cli.js doctor --config "$HOME/Library/Application Support/Nori/config.json"
node dist/cli.js enroll --config "$HOME/Library/Application Support/Nori/config.json"
node dist/cli.js run --config "$HOME/Library/Application Support/Nori/config.json"
```

`doctor` checks database readability and protocol readiness, not sending, phone delivery, iCloud sync, or Codex authentication. Enrollment scans only the configured chat and discards old content. It saves a physical scan watermark only after finding an inbound owner message with complete direct-chat metadata. Messages at or before that watermark are never executed. Send new requests after enrollment.

From the owner's phone, try `remind me to stretch in 1 minute`, then `snooze #1 20m` and `done #1`. Use the actual number in the acknowledgement. Verify the reminder reaches the phone once and completion prevents a later reminder. Quiet hours hold reminder messages; replies still work. `pause` affects discretionary nudges (none exist yet); `pause all` also holds requested reminders. `resume` respects quiet hours.

Text `status` for a short task/queue summary. A complex request should explicitly remain queued. No task is silently sent to a Codex worker. Attachments, reactions, groups, and unauthorized senders are not supported inputs.

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

- `service.lock` prevents concurrent owners. After a crash, inspect its PID and ensure the former service and its `imsg` child have stopped before manually removing it. Never remove a lock merely because a second launch failed.
- An outgoing `uncertain` item may already have been sent. Review the assistant's Messages conversation before deciding what to do. There is no automatic retry or resend command for these items yet. `sent` means a local message GUID was observed; it is not proof of phone delivery.
- A new Messages database inode/path/birth time, changed owner/chat, or changed assistant username invalidates enrollment. Stop, back up Nori state, and reconcile pending work. There is no automatic cursor reset or migration command. Changing Apple Accounts in an existing Messages database also needs manual review; filesystem identity is not an Apple Account sign-in detector.
- Stop Nori before making a filesystem backup, and preserve `state.sqlite` plus any SQLite sidecars together. Keep backups encrypted and outside iCloud Drive. Do not sync the live database as a file. Restore is an operator task in this prototype.
- The database contains accepted owner text, reminders, jobs, and outgoing message bodies. It uses a private directory and file permissions, not application-level encryption. Automatic content retention, deletion/export controls, Keychain integration, and schema rollback tooling remain pending.

## Jev and Codex probes

To evaluate Jev later, set `jev` to a pinned model and timeout, for example `{"model":"jev-1.13.0","timeoutMs":2500}`, and supply `TYPESAFE_API_KEY` to the process from a protected local source. Do not put the key in the plist, repository, or command arguments. The prototype does not load `.env` automatically. See [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) for the request/response contract and confirm model availability in the account.

Only queued unknown requests go to Jev; exact commands stay local. Results retain confidence and probabilities, but are advisory. Failures leave jobs queued. Each job receives one advisory attempt, and the prototype has no daily model-spending ceiling or automatic retry. Leave Jev disabled outside a controlled evaluation until usage limits are added.

In `receipts`, install the intended Codex CLI and run:

```sh
node dist/cli.js probe-codex --config "$HOME/Library/Application Support/Nori/config.json" --codex /absolute/path/to/codex
```

The probe sends `initialize` and `initialized` only. It establishes protocol connectivity, not model access or Computer Use. The implementation was handshake-tested with `codex-cli 0.155.1` in the development profile without starting a task. See [app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Computer Use](https://learn.chatgpt.com/docs/computer-use). The next integration must verify a supported tool connection and a harmless complete task in the actual assistant profile before queued jobs can execute.
