# Local PR review

Nori uses a local Codex reviewer, not a hosted review bot. The implementation agent (Codex or Claude Code) owns fixes; a separate **GPT-6 Astra** session at **xHigh** only reviews. The pre-push hook blocks on P0–P2 findings or an incomplete/failed review. P3 suggestions are advisory.

## Setup and use

Use Node 22.19+, Git, and a recent Codex CLI with `exec --ignore-user-config --output-schema` support. Run `codex login` with your existing account. Review uses saved Codex authentication; no new API key or GitHub bot is required. It consumes your Codex usage and may take several minutes.

```sh
npm run review:install
npm run review -- --base origin/main
git push
```

Installation copies the tracked `.githooks/pre-push` template into Git's persistent default hooks directory. Other hooks remain active, and switching to an older branch cannot silently remove this hook: it blocks if that checkout lacks the runner. Installation refuses an existing unrelated pre-push hook or a custom `core.hooksPath`; integrate those manually. Clones need to install the hook themselves. To uninstall, remove only the generated pre-push file at `git rev-parse --git-path hooks/pre-push` after checking its Nori marker.

The installer resolves the repository and hook destination independently of the current subdirectory, including linked worktrees.

The runner resolves `codex` from PATH. If an IDE or agent has a different PATH from your terminal, configure its absolute executable with `git config --local nori.codexPath /absolute/path/to/codex`. This selects the CLI executable only; the review model and effort remain pinned.

Invoke the personal `$babysit-pr` skill in Codex or `/babysit-pr` in Claude Code, with the PR number. Its canonical installation is `~/.codex/skills/babysit-pr`, exposed through user-level skill directories for Codex and Claude Code. It is available across repositories on this machine; it is no longer bundled in Nori. Copy the complete personal skill directory when setting up another machine.

Use the session that implemented the PR so findings return to the agent with the implementation context. The shared skill uses Nori's existing `npm run review` entrypoint and installed hook here; other repositories can use the portable runner bundled with the personal skill. Nori's scripts remain self-contained for developers without the personal skill. The skill reviews, fixes, pushes, and monitors CI; merging requires authorization for that PR. There are no review-bot checks to wait for.

For Nori runtime changes, validate with `npm test`, `npm run typecheck`, and `npm run build`; for review tooling also use `npm run test:review`. Use synthetic tests and the demo; do not start the live messaging service or send messages during review. Follow `AGENTS.md` for contract-first, test-first fixes.

## Runner contract

`node scripts/review-pr.mjs [--base REF] [--head REF] [--force]` reviews committed changes from the merge base of `REF` (default `origin/main`) to the head (default `HEAD`). Commit fixes before requesting a new review. Unstaged, staged, untracked, and ignored files are excluded from the review snapshot.

`--pre-push REMOTE LOCATION` consumes Git's pre-push ref-update records on stdin. Each nondeleted ref is reviewed at its supplied local object ID, including refs other than the checked-out branch. Feature branches and commit tags use the configured base (`git config nori.reviewBase`, default `origin/main`). Updates to that base branch review the remote's old commit through the new commit, so pushing `main` cannot accidentally review an empty diff. Deletions and unchanged trees need no model call. Missing history or unsupported noncommit objects fail closed; fetch the base/history and retry.

The reviewer gets an isolated Git clone at the exact target commit, full local history, a read-only sandbox, and no permission to fix, commit, push, merge, install dependencies, or run live Nori commands. Repository-local Git environment variables from the calling hook are cleared before operating in the clone. The model is pinned to `gpt-6-astra` with `model_reasoning_effort="xhigh"`; unavailability is an error, never a silent model substitution. User Codex configuration is ignored for this invocation while saved authentication remains available.

Results live under Git's common directory in `nori-review/`, outside committed files. Each report records base/head commits, model, effort, findings, limitations, and completion. A complete passing result is reused only for the same commits and runner/prompt/schema contents; `--force` requests fresh review. The runner validates structured output itself. Exit codes are **0** for pass, **1** for blocking findings, and **2** for setup, timeout, invalid output, or incomplete review. Default timeout is 20 minutes; `NORI_REVIEW_TIMEOUT_SECONDS` can set a positive number of seconds.

On macOS/Linux, each review runs in its own process group. Timeout or interruption pauses and then kills the reviewer and all its descendants, including tool commands that start their own sessions and processes left behind by commands that have exited (found by an environment tag each review sets, `NORI_PROCESS_TAG`, and by sharing a process group with a process already found), before returning a failure. A process with neither, such as a macOS system binary, whose environment is hidden, orphaned alone in its group, cannot be traced. If that cannot be confirmed (for example, `ps` fails), the review fails and its `running` lock stays in place: stop any leftover reviewer processes, then remove it.

Only one review of a given commit pair and policy may run at a time. A concurrent invocation fails closed with the lock location; retry after the active review finishes. After a hard crash, inspect `running/owner.json` and the log, ensure the reviewer has stopped, and remove that stale `running` directory manually. Failed forced reviews cannot reuse a result written by an older concurrent review.

The hook never edits code or launches an implementation agent. On failure it prints findings and the report path, then returns control to whoever ran `git push`. That original agent verifies findings, defines any changed contract, writes regression tests first, implements fixes, commits, and retries. Reports are local; this does not post GitHub reviews or supply branch protection. Git's `--no-verify` can bypass local hooks; agents must not use it to evade review without the user's explicit instruction.

## Provenance

The workflow adapts [Theo/T3 Code's published babysitting guidance](https://github.com/pingdotgg/t3code/blob/b528a701102f95089544596856a3f208f4404613/AGENTS.md#pull-requests): inspect fresh feedback, verify findings, fix real issues, and monitor checks for the latest commit. A standalone Theo-authored `babysit/SKILL.md` was not found in the public repository or his public gists. This is an original Nori-specific adaptation, replacing review bots with the local Astra reviewer.

References: [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills), and [Claude Code skills](https://code.claude.com/docs/en/skills).
