---
description: "Repository workflow contracts and permissions for teamesyfo-github-actions-workflows"
applyTo: ".github/workflows/**,actions/**"
---

# Workflow contract for teamesyfo-github-actions-workflows

`.github/workflows/validate-next-app-queue-policy.yaml` is the existing verification entry point.
Reusable workflows live in `.github/workflows/`, composite actions in `actions/`, and caller-facing contracts in `docs/`. Preserve declared inputs, secrets, outputs and required job names; review consumers before breaking a contract.

- Keep third-party actions pinned to full commit SHAs, with version comments;
  follow the established explicit policy for internal `nais/*` actions.
- Set minimal job permissions, bounded timeouts and the appropriate existing
  concurrency group. Never use `permissions: write-all` or log secrets.
- Do not check out an untrusted PR head in a privileged `pull_request_target`
  workflow. Keep validation on `pull_request` and `merge_group` where required.
- Check protected status names before renaming or deleting jobs. Branch rules
  are separate administration and are not changed by editing workflow YAML.
- New secrets, reusable workflow contracts or deployment ordering require a
  resolved decision within the task.
