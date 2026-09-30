---
name: babysit-pr
description: Babysit a Nori pull request through independent GPT-6 Astra xHigh review, fixes by the original implementation agent, and CI on the latest commit. Use when asked to babysit a PR or work through its review findings.
---

# Babysit a Nori PR

You remain the implementation agent. Delegate review to the repository's read-only Codex runner using **gpt-6-astra** at **xhigh**. The reviewer produces findings; you verify and implement them. Do not substitute a Claude reviewer or let the reviewer patch the code.

Read `docs/PR_REVIEW.md` for runner setup, exit codes, and report locations. This repo has no automated GitHub review bots. Do not wait for a bot approval that will never arrive.

## Review and fix loop

1. Identify the requested PR with `gh pr view`. Check its state, head commit, base branch, head repository, checks, and human feedback. Stop on a closed or merged PR. Work on its actual branch, preserving unrelated work. Fetch the base branch and ensure local HEAD matches the PR before claiming to have reviewed its current contents.
2. Run relevant validation. For Nori runtime changes use `npm test`, `npm run typecheck`, and `npm run build`; for review tooling also run `npm run test:review`. Use synthetic tests and the demo; do not start the live messaging service or send messages as part of a code review.
3. Commit the intended implementation, then run `npm run review -- --base <remote/base>`. The pre-push hook performs the same review automatically and reuses a matching passing report. Reviews concern committed snapshots, not pending working-tree edits.
4. Read the report. Verify each P0–P2 finding in the source. Following `AGENTS.md`, define a changed contract first, write a failing regression test, then implement the fix. Keep fixes in this original session. P3 suggestions are optional. For a false positive, explain the evidence in the session and request a fresh review with `--force`; do not edit the report to manufacture a pass. If the reviewer and implementation agent cannot resolve a material disagreement, present that concrete disagreement to the user.
5. After fixes, validate, commit only intended files, and repeat review. Once clean, push the PR branch. Never bypass the hook or switch reviewer models just to make the push pass. An auth/model/setup error is not a code finding; correct it or report the missing prerequisite.
6. Monitor CI and new human feedback for the current head. Use `gh pr checks` and fetch review comments/threads as needed. Fix real failures, then repeat the local review and push. Recheck the PR head after waiting: a result on an older commit does not establish readiness. Where review threads exist, assess whether they remain actionable; do not silently dismiss them.

Finish when the current PR head has a complete passing Astra review, relevant validation and CI pass, and no actionable feedback remains. Report the reviewed SHA and remaining limitations. If the user authorized merging this PR, merge only that checked head using `--match-head-commit`; otherwise report it ready. Authorization for a previous PR does not authorize merging this one.

Keep the loop bounded: after three review/fix rounds without converging, report the unresolved findings and what decision is needed. While CI runs, use waits of at most 60 seconds and give concise progress updates when state changes. Stop on user cancellation, a closed PR, or an external prerequisite that prevents progress. The skill runs in the active agent session; it does not install a permanent background watcher or resume a different agent automatically.
