# Author's deployment

These notes describe how Nori is set up on the author's machines. They are not requirements. Adapt the names and paths to your own setup; the [runbook](RUNBOOK.md) uses a generic assistant account named `nori`.

## Profiles and machines

- **`receipts` macOS profile.** The assistant account, and the only place the live service runs. It is signed into a dedicated assistant Apple Account and talks to the approved contacts' direct iMessage chats. The live config sets `assistantUser` to `receipts`.
- **`ajbarry` macOS profile.** The author's main profile on the same Mac. It is not a deployment dependency; nothing in `receipts` should run executables from this home directory.
- **NixOS machine.** Development only, using `chat`, `eval`, and the test suite. It never runs the live service. It has no `/bin/ps`, so the process-tree tests in `test/config-rpc.test.ts` hang or fail there; they are checked on the Mac.

Each profile keeps its own checkout. The repository is public so both macOS profiles and the development machine can clone it without sharing credentials between accounts.

## Paths

| Item | Location |
| --- | --- |
| Live checkout | `/Users/receipts/workspace/github.com/nori` |
| Data directory | `/Users/receipts/Library/Application Support/Nori/` |
| Live config | `/Users/receipts/Library/Application Support/Nori/config.json` |
| Nori's Codex home | `/Users/receipts/Library/Application Support/Nori/codex` |
| Codex CLI | `/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex` |
| LaunchAgent | `~/Library/LaunchAgents/ai.nori.agent.plist` in `receipts` |
| Console store (`chat`) | `~/.local/state/nori-console` on the development machine |

API keys for the live service are stored in the `receipts` login Keychain. On the development machine they come from the environment.

## Verification history

- Codex app-server handshake: tested with `codex-cli 0.155.1` in the development profile.
- Codex job runtime: wire format checked against `codex-cli 0.158.0-alpha.2.1`; not yet run end to end in `receipts`.
- Codex responder (GPT-6 Luna): the pre-port version was verified with `codex-cli 0.156.1` on the development machine, at about 2 to 4 seconds per turn. The ported version, which uses Nori's own Codex home, has not been run live yet.
- The `imsg` transport has been tested against fixtures only. An on-device test in `receipts` is still pending; see [the live test](LIVE_TEST.md).
