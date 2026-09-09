---
description: "Review priorities for teamesyfo-github-actions-workflows"
applyTo: "**"
---

# Review priorities

Review the requested change against repository evidence and `.github/workflows/validate-next-app-queue-policy.yaml`.
Report concrete regressions, unmet acceptance criteria, security/privacy
exposure and unrelated scope before cosmetic suggestions. Include the affected
location, user-visible consequence and a useful correction. Read all changed
files; do not turn a clean review into a claim that unrun checks passed.

For reusable workflows, check caller inputs, outputs, permissions, event trust and merge-queue behavior.
Never expose tokens, personal data or secrets in code, logs, fixtures or review comments.
Detailed review methods come from the available client skills; these priorities
remain repository-owned and also apply to GitHub Copilot Code Review.
