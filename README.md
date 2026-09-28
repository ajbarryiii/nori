# Nori

A personal assistant designed around ADHD: easy capture, a clear next step, useful reminders, and a gentle way to restart.

Nori is planned as a small custom assistant adapted from the sibling `recipts` project, running in a second macOS user profile with a dedicated Apple Account. Selected iCloud calendars and reminder lists will be shared with that account.

Messages enter a durable task inbox. Known requests use deterministic scripts; Jev helps route less obvious requests; Codex handles reasoning and multi-step work, using computer use when needed. The user sees one assistant and does not have to choose an execution mode.

The recommended messaging transport is standalone `imsg`, subject to a compatibility test on this Mac. BlueBubbles remains the fallback. Neither route requires adopting the OpenClaw runtime.

Local planning notes live in `docs/PLAN.md` and `docs/ROUTING.md`. They cover implementation, permissions, routing, and the Codex computer-use compatibility test, and are kept out of version control per `AGENTS.md`.

Status: planning only. No assistant has been installed or connected to personal data.
