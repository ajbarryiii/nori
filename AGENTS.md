# General Development

When writing production code, define the API contract or interface first, then write the tests, and only then write the implementation. Do not write tests after the implementation except to capture a newly discovered contract or interface bug. Only modify existing tests when the contract or interface itself changes.

When writing production code, define the API contract or interface first, then write the tests, and only then write the implementation. Do not write tests after the implementation except to capture a newly discovered contract or interface bug. Only modify existing tests when the contract or interface itself changes.

Do not commit plan markdown documents.

# PR Review

Use the repository's `babysit-pr` skill when babysitting a pull request. Independent review runs through `npm run review` with GPT-6 Astra at xHigh; the original implementation agent verifies findings and makes fixes. The local pre-push hook enforces review for committed changes. Do not bypass it or substitute another model without the user's instruction. See `docs/PR_REVIEW.md` for setup and report locations.
