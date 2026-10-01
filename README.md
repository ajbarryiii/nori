# Nori

A personal assistant designed around ADHD: easy capture, a clear next step, useful reminders, and a gentle way to restart.

You text Nori over iMessage. It keeps a local task list, reminds you when things are due, and can hand bigger requests to Codex as jobs, asking you before anything risky. Anything it can't handle is kept as a job instead of guessed at.

## Features

- **Capture and reminders.** Save notes and tasks, schedule reminders, mark them done, or snooze them, all from iMessage.
- **Dependable delivery.** A reminder is sent once unless you snooze it. Snoozing keeps the original deadline. A send that may or may not have gone through is held for review, never repeated automatically.
- **Quiet hours and pause.** Reminders wait outside quiet hours. `pause all` holds them until you `resume`.
- **Approved contacts.** One owner and optional members, each in their own direct chat. Each person sees and controls only their own reminders and jobs.
- **Codex jobs (optional, owner only).** Research and multi-step requests run in sandboxed Codex threads. Questions, approvals, budgets, and results all go through iMessage.
- **Conversational replies (optional).** With a classifier and a language model configured, you can write naturally. Code still decides what changes (see [Conversational replies](#conversational-replies)).

## Try the demo

Requires **Node 22.19 or later**.

```sh
nvm use
npm ci
npm run demo
```

The demo runs on any OS with synthetic messages and a temporary database. It calls no models and sends no iMessages.

## Commands

| Example | Effect |
| --- | --- |
| `note buy milk` | Save a note. |
| `remind me to call the dentist tomorrow at 10 am` | Schedule a reminder. |
| `remind me to stretch in 20 minutes` | Schedule a relative reminder. |
| `list` | Show active reminders. |
| `done #1` | Complete a reminder and cancel its pending messages. |
| `snooze #1 20m` | Delay the next reminder. |
| `pause all`, `resume` | Hold or release reminder messages. |
| `status`, `help` | Summarize reminders and jobs, or list what Nori can do. |
| `cancel #1`, `stop` | Cancel a job, or stop every running job. |
| `approve A1`, `deny A1` | Answer a Codex job's approval request, using the code from the request. |
| `continue #1`, `#1 use the cheaper option` | Resume a paused job, or add instructions to an open one. |

These commands run instantly and never call a model. Anything else becomes a job: queued, or run by Codex for the owner when it is configured.

## Conversational replies

Conversational mode is optional and off by default. It needs two configured services:

- **Jev**, a [TypeSafe](https://docs.typesafe.ai/primitives/choice) classifier, reads each message with the recent conversation and estimates what was meant.
- **A responder** extracts details and phrases replies. It can be an OpenRouter model (for example MiMo-V2.6-Flash) or GPT-6 Luna through the Codex CLI and a ChatGPT plan.

Then you can write things like "can you ping me at 3 to move the laundry", "done with the dentist one", "push it to after lunch", or "never mind the laptop research". Code resolves dates and reminder numbers, and a second Jev check confirms the change before it is saved; otherwise Nori asks "Did you mean …?". Bigger requests still become jobs. If a model fails or reaches its daily call limit, Nori falls back to the command grammar.

See the [runbook](docs/RUNBOOK.md#conversational-replies) for configuration, API keys, what data is sent to each provider, and daily call limits.

## How it works

- **Engine and plugins.** The engine owns identity, permissions, conversation state, durable timers, jobs, and delivery. Plugins supply capabilities; reminders is the first one. Each plugin declares a grammar, a command schema, and optional natural-language and tool hooks, and never touches the database or transport directly.
- **Storage.** A SQLite database holds the inbox, plugin state, timers, jobs, approvals, and outbox. Each incoming message is processed exactly once, and its effects commit in a single transaction.
- **Transport.** The [`imsg`](https://github.com/openclaw/imsg) adapter reads Messages over JSON-RPC on stdio and sends through AppleScript. Nori accepts only approved contacts in their own direct chats; groups and other senders are rejected. Each conversation is enrolled by the operator, and enrollment skips message history, so old commands are never replayed.
- **Safety.** Models never produce actions directly; code gates and validates every change. Codex runs with its own Codex home, a workspace-write sandbox without network access, and approvals that come to you over iMessage.

Source layout: `src/engine.ts` (dispatch, timers, delivery, routing, conversation, runtime jobs), `src/host.ts` (plugin registry, permissions, contexts, tools, routing catalogs), `src/plugins/` (in-process plugins), `src/conversation.ts` (gate, prompts, and reply checks), `src/codex.ts` (Codex job runtime and responder), `src/store.ts` (SQLite state), and `src/contracts.ts` (interfaces). The behavioral guarantees are specified in [runtime contracts](docs/CONTRACTS.md).

## Running it for real

The live service needs macOS, a dedicated macOS user account for the assistant, and a separate Apple Account signed into Messages there. The config's `assistantUser` names that account, and live commands refuse to run under any other username.

The [runbook](docs/RUNBOOK.md) covers permissions, configuration, enrollment, a foreground smoke test, an optional LaunchAgent, Codex jobs, and conversational replies. [The live test](docs/LIVE_TEST.md) is a step-by-step checklist. Nothing in this repository installs a background service or grants macOS permissions on its own.

## Development

```sh
npm test
npm run typecheck
npm run build
node dist/cli.js --help
```

`chat` runs the real service loop in a terminal, with a console transport in place of iMessage and its own database. It works on Linux and macOS. It is a development harness, not a deployment path.

```sh
node dist/cli.js chat                       # command grammar and templates only
node dist/cli.js chat --config dev.json     # adds jev/responder from dev.json; keys come from the environment
node dist/cli.js eval --config dev.json     # scores Jev routing on eval/cases.json (sends them to TypeSafe)
```

The process-tree tests in `test/config-rpc.test.ts` use macOS `/bin/ps` and do not pass on systems without it. An optional pre-push review is described in [PR review](docs/PR_REVIEW.md).

## Status

Nori is a runnable prototype.

- Reminders are stored locally. They are not synced to Apple Reminders or Calendar.
- The Codex runtime is tested against a simulated app-server; its wire format was checked against `codex-cli 0.158.0-alpha.2.1`. It does not use Computer Use.
- Conversational replies are tested with simulated models. An earlier version of the Codex responder was checked with live turns; the current one has not been. Thresholds have not yet been tuned on real traffic.
- BlueBubbles is a possible future transport; it is not implemented.
- Accepted message text and task history stay in the database until it is deleted. Automatic retention and encrypted backups are not implemented.

Configuration files, credentials, SQLite state, and build output are excluded from Git. Keep runtime state outside the checkout.

## Credits

The transport and routing patterns are adapted from the author's earlier `recipts` project; its MIT notice is retained in [`LICENSE`](LICENSE). Notes on the author's own deployment are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
