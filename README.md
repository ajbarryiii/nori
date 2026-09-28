# Nori

A personal assistant designed around ADHD: easy capture, a clear next step, useful reminders, and a gentle way to restart.

Nori is a small TypeScript assistant adapted from the transport and routing patterns in the sibling `recipts` project. The live service runs in the **`receipts` macOS profile**, using a dedicated assistant Apple Account and one authorized owner iMessage chat.

The first implementation has a SQLite inbox, task/reminder ledger, job queue, and outbox. It supports local task capture, scheduled messages, completion, snooze, quiet hours, pause/resume, and queued complex requests. Exact commands need no model. Optional Jev routing records advice without executing work.

The standalone `imsg` adapter uses JSON-RPC over stdio and AppleScript sends. Enrollment skips historical commands; owner/chat checks reject groups and unrelated senders. Interrupted or uncertain sends are retained for review instead of automatically repeated. BlueBubbles is a planned fallback, not yet implemented here.

Try the isolated demo with **Node 22.19+**:

```sh
nvm use
npm ci
npm run demo
```

The demo uses synthetic messages and a temporary database. It calls no models and sends no iMessages.

Supported examples:

- `note buy milk`
- `remind me to call the dentist tomorrow at 10 am`
- `remind me to stretch in 20 minutes`
- `list`, `done #1`, `snooze #1 20m`
- `pause all`, `resume`, `status`, `cancel job #1`

Reminders send once unless explicitly snoozed. Snoozing preserves the original deadline. Ambiguous times or task references prompt one question. Other requests are durably queued and acknowledged as pending.

**Status: runnable local prototype; live account setup is still required.** Reminders are local to Nori, not synced to Apple Reminders or Calendar. Codex integration currently probes the app-server protocol only; it does not execute tasks or provide Computer Use. No background service or macOS permissions have been installed by this implementation.

See [the setup and permissions runbook](docs/RUNBOOK.md) and [runtime contracts](docs/CONTRACTS.md). The example configuration pins the live username to `receipts`. Planning notes in `docs/PLAN.md` and `docs/ROUTING.md` stay local and ignored per `AGENTS.md`.

```sh
npm test
npm run typecheck
npm run build
node dist/cli.js --help
```

Runtime state belongs outside the checkout, normally `/Users/receipts/Library/Application Support/Nori/`. Configurations, credentials, SQLite state, and generated builds are excluded from Git. The prototype retains accepted message text and task history until its database is removed; automatic retention and encrypted backups are not implemented yet.
