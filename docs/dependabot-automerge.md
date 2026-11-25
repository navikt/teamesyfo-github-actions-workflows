# Dependabot automerge

This document explains how to use `dependabot-automerge-v2.yaml` from `navikt/teamesyfo-github-actions-workflows`, what the consumer repository must configure, and how to migrate from `dependabot-automerge.yaml` (v1).

v1 is deprecated. It runs on `pull_request` with the App key as a Dependabot secret, and it enables auto-merge without binding the approval to a commit. See [Migrate from v1](#migrate-from-v1).

## Quick start

1. Grant the [`teamesyfo-automerge`](https://github.com/apps/teamesyfo-automerge) GitHub App access to the repository.
2. Create the environment `dependabot-automerge` in Settings -> Environments. Under **Deployment branches and tags**, select **Selected branches and tags** and add only the default branch. Do not add required reviewers, a wait timer or a custom deployment protection rule, because the workflow runs on a schedule without a deployment.
3. Test the environment before you add the key. Push a temporary branch with this workflow in `.github/workflows/test-environment.yaml`:

   ```yaml
   name: Test environment
   on: push
   permissions: {}
   jobs:
     test:
       runs-on: ubuntu-latest
       environment:
         name: dependabot-automerge
         deployment: false
       steps:
         - run: echo "This branch can use the environment."
   ```

   GitHub must reject the job because of the environment protection rules. Then delete the branch. If the job runs, every branch can read the App key: fix the environment before you continue.
4. Add the App private key as the **environment secret** `AUTOMERGE_APP_PRIVATE_KEY` in that environment. Do not store the key as a repository secret, an organization secret or a Dependabot secret.
5. Turn off **Allow GitHub Actions to create and approve pull requests** in Settings -> Actions -> General, unless another workflow needs it. The App approves, not `GITHUB_TOKEN`. The default workflow permissions can stay read-only, because the workflow sets its own permissions.
6. Allow squash merging in Settings -> General -> Pull Requests, unless the repository uses a merge queue.
7. Add at least one required status check on the default branch, in a ruleset or in branch protection. The check must come from CI that runs on `pull_request`, and also on `merge_group` with a merge queue. The workflow merges nothing until the required checks have passed on the head commit. Do not add the App to a bypass list in any ruleset or branch protection rule, because GitHub must enforce the required checks when the App merges.
8. Add the [caller workflow](#caller-workflow).
9. Start the workflow manually on the default branch once, and read the job log.
10. Optional: copy the [Copilot review instructions](#copilot-review-of-manual-updates).

## Policy

| Update | Automerged? | Notes |
| --- | --- | --- |
| GitHub Actions | ✅ Yes | Includes major updates |
| Patch or minor update in other ecosystems | ✅ Yes | All updates in a grouped PR must be patch or minor |
| Major update in other ecosystems | ❌ No | Manual review, with an optional Copilot review |
| Other ecosystems without valid Dependabot metadata in the commit | ❌ No | Manual review |

The ecosystem comes from the branch name (`dependabot/<ecosystem>/...`). The update types come from the metadata block that Dependabot adds to its commit message. Every entry in the block must have a name and a version that are not empty or `null`, and no field may occur twice in an entry. Otherwise the update needs a manual review.

## When the workflow approves and merges

The job runs only on the schedule or on a manual run on the default branch. It has two steps.

**1. Find the pull requests that are ready (`GITHUB_TOKEN`).** The workflow checks every open pull request that targets the default branch. A pull request is ready to merge only when all of these conditions are true:

- `dependabot[bot]` opened it from a `dependabot/` branch in the same repository.
- It follows the [policy](#policy) and is not a draft.
- It has exactly one commit. That commit is the head of the pull request, Dependabot wrote it, GitHub committed it, and GitHub verified its signature. If anyone else pushes to the branch, the pull request needs a manual review.
- No reviewer's latest review requests changes.
- GitHub reports no merge conflict.
- At least one required status check has reported on the head commit, and every required check that has reported has succeeded, been skipped or concluded neutral. The rulesets and branch protection of the repository decide which checks are required.
- On the head commit, no check run, commit status or workflow run has failed, been cancelled or timed out, none is still running, and at least one has succeeded. Skipped and neutral checks do not count as successful.
- The merge window is open. Scheduled runs pause on Saturdays, Sundays, 1 May, 17 May and from 24 December to 1 January (Europe/Oslo). A manual run (`workflow_dispatch`) ignores the merge window.

This step never approves. It dismisses approvals from the App of commits that are no longer the head. If it cannot dismiss such an approval, it skips the pull request.

**2. Approve and merge (the App).** When at least one pull request is ready, the workflow creates a short-lived token for the GitHub App. For each pull request, it:

1. Checks every condition again with fresh data, for the same head commit. If something has changed, it skips the pull request.
2. Approves exactly the head commit as `teamesyfo-automerge[bot]`. This approval counts as the required review.
3. Merges the approved commit:
   - With a merge queue, it adds the pull request to the queue with `expectedHeadOid`, so GitHub rejects it if the head has changed.
   - Without a merge queue, it squash-merges with the `sha` of the approved commit, so GitHub rejects the merge if the head has changed.

If the merge fails, the workflow tries to dismiss the new approval, the job log shows a warning, and the next run tries again. If the dismissal also fails, the approval stays until someone dismisses it (see [Troubleshooting](#troubleshooting)). The workflow does not fall back to another merge method, and it never checks out or runs code from a pull request.

```mermaid
flowchart TD
    A[Schedule or manual run on the default branch] --> B[List open Dependabot PRs with GITHUB_TOKEN]
    B --> S[Dismiss App approvals of old commits]
    S --> C{Policy allows automerge, and one verified Dependabot commit?}
    C -->|No| D[Request a comment-only Copilot review once per set of versions]
    C -->|Yes| E{No changes requested, no conflict, required checks and other checks green, merge window open?}
    E -->|No| F[Log the reason and wait for the next run]
    E -->|Yes| J[Create a GitHub App token]
    J --> R{Same head commit, and every condition still true?}
    R -->|No| F
    R -->|Yes| G[Approve the head commit as the App]
    G --> K{Merge queue?}
    K -->|Yes| L[Add to the queue with expectedHeadOid]
    K -->|No| M[Squash-merge with sha]
    L -->|Fails| I[Try to dismiss the new approval]
    M -->|Fails| I
```

## Caller workflow

Create `.github/workflows/dependabot-automerge.yaml` on the default branch:

```yaml
name: Dependabot automerge

on:
  schedule:
    # Every 30 minutes on weekdays, 07:00–15:30 in Oslo.
    - cron: "*/30 7-15 * * 1-5"
      timezone: "Europe/Oslo"
  workflow_dispatch:

permissions: {}

jobs:
  automerge:
    permissions:
      actions: read
      checks: read
      contents: read
      pull-requests: write
      statuses: read
    uses: navikt/teamesyfo-github-actions-workflows/.github/workflows/dependabot-automerge-v2.yaml@<full commit SHA> # main
    secrets:
      AUTOMERGE_APP_PRIVATE_KEY: ${{ secrets.AUTOMERGE_APP_PRIVATE_KEY }}
```

- Pin the workflow to a full commit SHA. The workflow uses the App key, so a change on `main` in this repository should not reach your repository before you update the pin.
- Add the caller only after you have created and tested the environment (steps 2–4 in the [quick start](#quick-start)). If the environment does not exist when the workflow runs, GitHub creates it without protection rules.
- The caller must pass the secret by name, although the secret only exists in the environment. The environment secret takes precedence.
- To turn off the Copilot review, add `with: copilot-review: false` to the job.
- Scheduled workflows run only on the default branch. In a public repository, GitHub disables scheduled workflows after 60 days without activity. Enable the workflow again in the Actions tab if that happens.

## Merge queue

A merge queue is recommended. With a merge queue, the required CI workflow must also run on `merge_group`:

```yaml
on:
  pull_request:
  merge_group:
    types: [checks_requested]
```

The App token is needed for the queue, because `GITHUB_TOKEN` cannot add pull requests to a merge queue, and changes from `GITHUB_TOKEN` do not trigger new workflow runs.

Without a merge queue, the workflow merges directly. Then:

- If the branch must be up to date before merging, the merge fails until Dependabot rebases the pull request.
- A pull request that changes files in `.github/workflows/` may need the `workflows` permission, which the App does not have. This has not been verified yet. If the merge fails, the workflow tries to dismiss its approval, the job log shows a warning and the pull request stays open. A merge queue avoids the problem.

## Copilot review of manual updates

For updates that need a manual review, the workflow requests a review from Copilot. This applies to updates that the [policy](#policy) does not allow, such as major updates, and to pull requests where someone other than Dependabot has pushed to the branch. It requests at most one review per set of dependency versions, so a Dependabot rebase does not start a new review. There is one exception: if someone removes the Copilot review request before Copilot has reviewed, the next run requests the review again. To stop the reviews in a repository, add `with: copilot-review: false` to the caller job. The repository must have access to Copilot code review. Otherwise the job log shows a warning.

Copilot reviews with comments only. A human must review and merge the pull request.

To give Copilot the same review rules as other Team eSyfo repositories, copy [`docs/templates/dependency-updates.instructions.md`](templates/dependency-updates.instructions.md) to `.github/instructions/dependency-updates.instructions.md` in the consumer repository. The template asks Copilot to read the upstream release notes, to name what must change in the repository, and never to approve.

## Migrate from v1

1. Do steps 2–7 in the [quick start](#quick-start): create and test the environment, add the environment secret, turn off **Allow GitHub Actions to create and approve pull requests**, and add a required status check.
2. Delete the Dependabot secret `AUTOMERGE_APP_PRIVATE_KEY`, and any repository secret that contains the App key. Do this before you add the v2 caller, because the caller would otherwise pass a repository secret to the workflow if the environment secret is missing. Without the secret, v1 stops before it approves anything.
3. On open Dependabot pull requests, turn off the auto-merge that v1 enabled, and dismiss the approvals from `github-actions[bot]`. Do this before you add the v2 caller. v2 dismisses only approvals from the App, so an old approval from v1 still counts as the required review, also for a later commit. Run this from a clone of the repository, as a user who can dismiss reviews:

   ```bash
   for number in $(gh pr list --author app/dependabot --state open --limit 200 --json number --jq '.[].number'); do
     if [ "$(gh pr view "$number" --json autoMergeRequest --jq '.autoMergeRequest != null')" = true ]; then
       gh pr merge --disable-auto "$number"
     fi
     for id in $(gh api --paginate "repos/{owner}/{repo}/pulls/$number/reviews" \
       --jq '.[] | select(.user.login == "github-actions[bot]" and .state == "APPROVED") | .id'); do
       gh api -X PUT "repos/{owner}/{repo}/pulls/$number/reviews/$id/dismissals" \
         -f message="Replaced by Dependabot automerge v2." -f event=DISMISS
     done
   done
   ```

4. Replace the caller workflow with the [v2 caller](#caller-workflow). Remove the `pull_request` trigger.
5. Start the workflow manually on the default branch once, and read the job log.

When all consumer repositories use v2, the team creates a new private key for the App, stores it only in the environments, and revokes the old key. Then `dependabot-automerge.yaml` (v1) can be deleted.

## Security model and remaining risks

- The job that holds the App key never checks out or runs pull request code. The key is only available to the default branch, through the environment, and the job runs only on the schedule or on a manual run on the default branch.
- The first step uses only `GITHUB_TOKEN` and never approves. The workflow creates the App token only when at least one pull request is ready.
- The approval and the merge are bound to the head commit that the workflow checked, and the workflow checks every condition again just before it approves.
- Only an untouched, verified Dependabot commit can be automerged, and only after the required checks of the repository have passed.
- The App approves, not `GITHUB_TOKEN`. With **Allow GitHub Actions to create and approve pull requests** turned off, a workflow on another branch cannot use `GITHUB_TOKEN` to approve a pull request. The App approval counts as the required review, but not as a code owner review.

Remaining risks:

- A malicious version of a dependency that passes CI is still merged. CI, required checks and a Dependabot cooldown reduce this risk.
- Anyone who can push to the default branch can change the caller workflow and use the key, as with other secrets that only the default branch can use.
- If someone pushes to a pull request that the App has approved, the App approval of the old commit still counts until the next run dismisses it. During that time, a human can merge the new commit without a new approval. If the workflow cannot dismiss the approval, it skips the pull request, and the approval stays until someone dismisses it. To close this gap, turn on **Dismiss stale pull request approvals when new commits are pushed**. Then every push to any pull request needs a new approval.
- If only some people may dismiss reviews in the repository, `GITHUB_TOKEN` may not be allowed to dismiss approvals. Then the workflow skips pull requests with an App approval of an old commit, and a person must dismiss the approval.
- A required check that has not started yet is not visible on the commit. The workflow then evaluates only the required checks that have reported, and relies on GitHub to reject the merge until every required check has passed. This works only when the App cannot bypass the rules. Team eSyfo verifies it once in a test repository: add a required check that never reports, start the workflow manually while a Dependabot pull request is ready, and confirm that GitHub does not merge the pull request. Then remove that check, start the workflow again and confirm that the pull request is merged. The second run shows that the first run was stopped by the required check and not by another error.
- The merge binds to the head commit, but GitHub cannot bind it to the base branch. The workflow checks the base branch just before it approves and again just before it merges. Someone who changes the base branch in the short time between that check and the merge can make the App merge the pull request into another branch. Changing the base branch requires write access to the repository.
- The workflow reads which checks are required with `GITHUB_TOKEN`. This has not been verified in a consumer repository yet. If it does not work, the workflow merges nothing. The log then shows `not ready: no required check has reported`, or, if the lookup fails, `evaluation failed: ...` in the first step or `not merged: ...` in the second step.

## Troubleshooting

The job log has one line for each Dependabot pull request, such as `PR #12: not ready: <reason>`, `PR #12: needs a manual review, because <reason>` or `PR #12: not merged: <reason>`.

| Message or symptom | What to do |
| --- | --- |
| The workflow never runs | Check that the caller workflow is on the default branch, and that GitHub has not disabled the schedule. |
| The job waits for or is rejected by the environment | Check that the environment allows the default branch, and that it has no required reviewers, wait timer or custom deployment protection rule. |
| `The secret AUTOMERGE_APP_PRIVATE_KEY is empty` | Add the key as an environment secret in `dependabot-automerge`. |
| `The App token belongs to "...", but the workflow expects teamesyfo-automerge[bot].` | The secret contains the key of another App. Add the key of `teamesyfo-automerge`. |
| `The merge window is closed. This run merges no pull requests.` or `not ready: the merge window is closed` | Wait for the merge window, or start the workflow manually. |
| `not ready: no required check has reported` | Add a required status check on the default branch, and make sure that CI runs on `pull_request`. See [Security model](#security-model-and-remaining-risks) if the repository already has one. |
| `not ready: required check "..." is failure` | Fix the build, or run the check again. |
| `not ready: no check has succeeded` | Add CI that runs on `pull_request`. |
| `not ready: check "..." concluded cancelled` | Run the check again. |
| `not ready: GitHub has not computed mergeability yet` | Wait for the next run. |
| `needs a manual review, because the PR has 2 commits, expected 1` or `... the committer is not GitHub` | Someone pushed to the Dependabot branch. Review the pull request manually, or comment `@dependabot recreate`. |
| `not ready: a stale approval could not be dismissed` and `could not dismiss approval ...` | Dismiss the App approval manually. After `not merged: ...`, this is the approval of the current commit. Check whether the repository restricts who can dismiss reviews. |
| `evaluation failed: ...` | Read the error. It can come from a failed lookup of the pull request or its checks. The next run tries again. |
| `not merged: ...` | Check that the App has access to the repository, that squash merging is allowed, and see [Merge queue](#merge-queue). A failed lookup of the required checks also gives this message. The next run tries again. |
| `Skipped an invalid candidate: ...` | This is an error in the workflow. Tell Team eSyfo. |
| `could not request a Copilot review` | Check that the repository has access to Copilot code review, or set `copilot-review: false`. If the message says `could not read commit ...`, the workflow could not compare the versions with an earlier Copilot review. It tries again on the next run. |

## v1 (deprecated)

`dependabot-automerge.yaml` runs on `pull_request`, receives the App key as the secret `APP_PRIVATE_KEY` (callers pass their Dependabot secret `AUTOMERGE_APP_PRIVATE_KEY`), approves eligible pull requests and enables auto-merge with `gh pr merge --auto --squash`. Existing callers keep working until they migrate. Do not use v1 in new setups.
