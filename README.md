# Nori

A personal assistant designed around ADHD: easy capture, a clear next step, useful reminders, and a gentle way to restart.

Nori is a small TypeScript assistant adapted from the transport and routing patterns in the sibling `recipts` project. The live service runs in the **`receipts` macOS profile**, using a dedicated assistant Apple Account and a short list of approved contacts, each in their own direct iMessage chat.

The engine owns identity, permissions, conversation state, durable timers, and reliable delivery through a SQLite inbox, task queue, and outbox. Plugins supply capabilities. Reminders is the first plugin: local capture, scheduled messages, completion, snooze, and listing, isolated per contact. Engine commands and plugin grammars need no model. Other requests become jobs. With the optional Codex runtime configured, the owner's jobs run in sandboxed Codex threads with questions, approvals, budgets, and results handled over iMessage. Optional Jev routing runs in shadow mode by default and can be enabled per plugin with a confidence threshold.

The standalone `imsg` adapter uses JSON-RPC over stdio and AppleScript sends. Each contact's conversation is enrolled separately by the operator, and enrollment skips historical commands. Contact and chat checks reject groups and unrelated senders. Interrupted or uncertain sends are retained for review instead of automatically repeated. BlueBubbles is a planned fallback, not yet implemented here.

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
- `pause all`, `resume`, `status`, `help`, `cancel #1`
- With Codex: `approve A1`, `deny A1` (the code from the request), `continue #1`, `#1 use the cheaper option`, `stop`

Reminders send once unless explicitly snoozed. Snoozing preserves the original deadline. Ambiguous times or task references prompt one question. Other requests are durably queued and acknowledged as pending. Each contact sees and controls only their own reminders and jobs.

**Status: runnable local prototype; live account setup is still required.** Reminders are local to Nori, not synced to Apple Reminders or Calendar. The Codex runtime is implemented against the app-server protocol and tested with a simulated server; its wire format was checked against `codex-cli 0.158.0-alpha.2.1`, but it has not yet completed a real job in the assistant profile. It does not provide Computer Use. No background service or macOS permissions have been installed by this implementation.

See [the setup and permissions runbook](docs/RUNBOOK.md) and [runtime contracts](docs/CONTRACTS.md). The example configuration pins the live username to `receipts`. Planning notes in `docs/PLAN.md`, `docs/ROUTING.md`, and `docs/PLUGIN_REFACTOR.md` stay local and ignored per `AGENTS.md`.

Source layout: `src/engine.ts` (dispatch, timers, delivery, routing, runtime jobs), `src/host.ts` (plugin registry, permissions, contexts, tools, Jev catalog), `src/plugins/` (in-process plugins), `src/codex.ts` (Codex app-server runtime), `src/store.ts` (SQLite state), and `src/contracts.ts` (interfaces).

For development, [install the local Astra xHigh pre-push review](docs/PR_REVIEW.md). The personal `babysit-pr` skill works across repositories in Codex and Claude Code; the original implementation agent fixes the independent reviewer's findings.

```sh
npm test
npm run typecheck
npm run build
node dist/cli.js --help
```

Runtime state belongs outside the checkout, normally `/Users/receipts/Library/Application Support/Nori/`. Configurations, credentials, SQLite state, and generated builds are excluded from Git. The prototype retains accepted message text and task history until its database is removed; automatic retention and encrypted backups are not implemented yet. State databases created before approved contacts are refused; move them aside and enroll again.
