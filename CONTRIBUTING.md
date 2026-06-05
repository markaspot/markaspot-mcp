# Contributing to markaspot-mcp

Thanks for your interest in contributing.

## License of contributions

markaspot-mcp is licensed under AGPL-3.0-or-later. By contributing, you agree
that your contributions are licensed under the same license.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. Every commit must be signed off, certifying that you wrote the
patch or otherwise have the right to submit it under the project license:

    git commit -s -m "your message"

This appends a `Signed-off-by: Your Name <you@example.com>` line to the commit
message. Pull requests whose commits are not signed off cannot be merged.

## Workflow

1. Open an issue describing the change (for non-trivial work).
2. Fork, create a branch, implement, and sign off your commits.
3. Run `pnpm run lint` and `pnpm run typecheck` before opening a pull request.
4. Open the pull request against `main`.
