# Contributing

All contributions must go through the [no-mistakes](https://github.com/kunchenguid/no-mistakes) pipeline. Pull requests that have not passed it are not eligible to merge. Release PRs opened by automation are exempt (see `.github/workflows/no-mistakes-required.yml`). Every pull request title must use a Conventional Commit type: `feat`, `fix`, `chore`, `ci`, `docs`, `refactor`, `test`, `perf`, `build`, or `revert`. A title may include a scope in parentheses and `!` before the colon.

Review each proposed change against the existing contract and classify its effect:

- **Restore** — returns behavior or documentation to the existing contract. May merge after maintainer review and green checks.
- **Opt-in** — adds behavior that users must explicitly choose, without changing existing defaults. May merge after maintainer review and green checks.
- **New-default** — changes default behavior or expands the existing contract for users who did not opt in. Waits for an explicit maintainer decision; green checks alone are not approval.
- **Cannot-tell** — available evidence does not establish the change's effect on the existing contract. It never has merge authority; clarify the behavior or retain it for maintainer decision.

The maintainer approves every CI approval, public comment, close, and merge. There is no standing delegation.
