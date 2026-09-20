# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**:

- X DM: [@proof_of_arc](https://x.com/proof_of_arc)
- Or via the contact form on https://proofofarchitect.builders

Do **not** open a public issue for security problems.

Please include: a description, impact, reproduction steps, and the affected component/commit.

## Scope

- `contracts/` — Solidity contracts
- `web/` — Next.js application and APIs
- `mcp/` — MCP server

## Notes

- The contracts hold no user funds except during mint/claim/craft flows; the treasury address is immutable.
- We acknowledge valid reports in release notes (no bounty program is promised at this time).
