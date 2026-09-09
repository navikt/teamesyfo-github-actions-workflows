---
description: "Security boundaries for teamesyfo-github-actions-workflows"
applyTo: "**"
---

# Repository security boundaries

Workflows operate on caller repositories. Keep untrusted pull-request code separate from privileged tokens; never check out an untrusted head under pull_request_target.

- Never commit secrets or log tokens, headers, personal identifiers or complete
  request/response payloads.
- Validate external input at the existing system boundary. Keep token exchange
  and credentials out of browser code.
- Preserve explicit access policies and least privilege. Resolve material
  changes to authentication, exposed data or permissions before implementing.
- For SQL-bearing code or examples, use parameterized queries.
- Synthetic fixtures must remain synthetic; do not copy production data to
  tests, screenshots, prompts or documentation.
