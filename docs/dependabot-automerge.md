# Dependabot automerge

This document explains how to use `dependabot-automerge-v2.yaml` from `navikt/teamesyfo-github-actions-workflows`, what the consumer repository must configure, and how to migrate from `dependabot-automerge.yaml` (v1).

v1 is deprecated. Both versions use the same GitHub App. Before the first v2 pilot, retire the v1 credentials across all consumers. See [Migrate from v1](#migrate-from-v1).

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

   Confirm that GitHub rejects the job because of the environment branch rules, then delete the temporary branch. If the job runs, fix the branch rules and repeat the test before storing the key.
4. Store the v2 App key as the **environment secret** `AUTOMERGE_APP_PRIVATE_KEY` after the environment test passes. During migration, the App owner distributes the replacement key in the [order below](#migrate-from-v1).
5. Turn off **Allow GitHub Actions to create and approve pull requests** in Settings -> Actions -> General, unless another workflow needs it. The App approves, not `GITHUB_TOKEN`. The default workflow permissions can stay read-only, because the workflow sets its own permissions.
6. Allow squash merging in Settings -> General -> Pull Requests, unless the repository uses a merge queue.
7. Add at least one required status check on the default branch, in a ruleset or in branch protection. The check must come from CI that runs on `pull_request`, and also on `merge_group` with a merge queue. The workflow merges nothing until the required checks have passed on the head commit. Do not add the App to a bypass list in any ruleset or branch protection rule, because GitHub must enforce the required checks when the App merges.
8. If updates left open by this workflow require human approval, require a review in the branch rules and check which identities can satisfy it. Repository and organization settings must prevent another automated reviewer from satisfying that requirement.
9. After the [pilot](#verify-the-pilot) passes, add or enable the [caller workflow](#caller-workflow) on the default branch. The caller in this workflow repository is enabled by setting the repository variable `DEPENDABOT_AUTOMERGE_ENABLED=true`.

## Policy

| Update | Automerged? | Notes |
| --- | --- | --- |
| GitHub Actions | ✅ Yes | Includes major updates, when the pull request only changes existing workflow and action files |
| Patch or minor update in other ecosystems | ✅ Yes | All updates in a grouped PR must be patch or minor |
| Major update in other ecosystems | ❌ No | Manual review |
| Other ecosystems without valid Dependabot metadata in the commit | ❌ No | Manual review |

The ecosystem comes from the branch name (`dependabot/<ecosystem>/...`). The update types come from the metadata block that Dependabot adds to its commit message. Every entry in the block must have a name and a version that are not empty or `null`, and no field may occur twice in an entry. Otherwise the patch and minor rule does not apply. A repository can change the branch names that Dependabot uses, so the branch name alone does not prove a GitHub Actions update. When the patch and minor rule does not apply on a GitHub Actions branch, the workflow reads the files that the head commit changes. The update is automerged when every changed file already exists and is either a workflow file directly in `.github/workflows/` or an `action.yml` or `action.yaml` file. This exception does not need the metadata block. It does not apply when GitHub lists the changed files on more than one page, which happens above 300 files. Otherwise the update needs a manual review.

## When the workflow approves and merges

The job runs only on the schedule or on a manual run on the default branch. It has two steps.

**1. Find the pull requests that are ready (`GITHUB_TOKEN`).** The workflow checks every open Dependabot pull request. A pull request is ready to merge only when all of these conditions are true:

- `dependabot[bot]` opened it from a `dependabot/` branch in the same repository.
- It targets the default branch.
- It follows the [policy](#policy) and is not a draft.
- It has exactly one commit. The commit matches the head SHA, has `dependabot[bot]` as author and `web-flow` as committer, and carries a verified signature. GitHub's latest repository activity for the exact head ref must record a branch creation, push or force push by Dependabot with that SHA as its result. A missing or mismatched record prevents approval.
- No reviewer's latest review requests changes.
- GitHub reports no merge conflict.
- At least one required status check has reported on the head commit, and every required check that has reported has succeeded, been skipped or concluded neutral. The rulesets and branch protection of the repository decide which checks are required.
- On the head commit, no check run, commit status or workflow run has failed, been cancelled or timed out, none is still running, and at least one has succeeded. Skipped and neutral checks do not count as successful. A cancelled workflow run stops counting when the same workflow has started a newer run for the same event and branch, for example after the pull request was reopened. A newer run does not replace a run that failed or timed out. That run blocks until someone re-runs it and it succeeds.
- It is not in the merge queue, and its head commit has never been in the merge queue. See [Merge queue](#merge-queue).
- The merge window is open. Scheduled runs pause on Saturdays, Sundays, 1 May, 17 May and from 24 December to 1 January (Europe/Oslo). A manual run (`workflow_dispatch`) ignores the merge window.

This step never approves. It dismisses approvals from the App of commits that are no longer the head. It also dismisses every approval from the App on a pull request that no longer targets the default branch, and then skips that pull request. If it cannot dismiss such an approval, it skips the pull request.

**2. Approve and merge (the App).** When at least one pull request is ready, the workflow creates a short-lived token for the GitHub App. For each pull request, it:

1. Reads the current pull request, reviews, checks, queue history, commits and head-branch activity again. Scheduled runs also check the merge window for each candidate before approval.
2. Approves exactly the head commit as `teamesyfo-automerge[bot]`, reusing an existing App approval of that SHA if present.
3. Merges the approved commit:
   - With a merge queue, it adds the pull request to the queue with `expectedHeadOid`, so GitHub rejects it if the head has changed.
   - Without a merge queue, it squash-merges with the `sha` of the approved commit, so GitHub rejects the merge if the head has changed.

If the merge or enqueue step fails after approval, the workflow tries to dismiss the App approvals it used for that SHA, including any reused approvals. A failed dismissal leaves the approval in place and the job logs its review ID. See [Troubleshooting](#troubleshooting).

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

GitHub removes a pull request from the queue when the checks in the queue fail or when someone removes it. The checks on the head commit can still be green. The workflow therefore does not add the same commit to the queue again. It waits until the head commit changes, for example after you comment `@dependabot rebase`. You can also add the pull request to the queue by hand. The workflow follows the head commit through the force pushes in the timeline of the pull request, so a commit that has been in the queue cannot return with a force push either. GitHub does not document whether a push removes a pull request from the queue. A commit that is force-pushed while the timeline still shows the pull request in the queue therefore also counts as having been in the queue. A commit that the timeline shows removed from the queue counts as having been in the queue, even when the timeline does not show the addition. The workflow checks this again just before it adds the pull request to the queue. The workflow does not merge the pull request if the timeline has more than 100 merge queue and force-push events, if GitHub does not tell which commit was added to the queue, or if someone has pushed without force after an addition and the workflow therefore cannot tell which commit was added.

One case is not covered, because the timeline does not show the head before the first force push. Suppose someone pushes without force after the pull request was added to the queue and before the first force push, and later force-pushes the added commit back. Then the workflow can add that commit to the queue again. This requires write access to the repository, which also allows adding the pull request to the queue by hand.

The last check and the addition to the queue are two separate requests. GitHub can only make the addition depend on the head commit, not on the queue history. If someone adds the pull request to the queue and it is removed again between the two requests, while the head commit stays the same, the workflow adds the same commit to the queue once more. The queue checks then run again, so the required checks still apply. The cost is an extra run of the queue checks, or that a manual removal is undone once.

Without a merge queue, the workflow merges directly. Then:

- If the branch must be up to date before merging, the merge fails until Dependabot rebases the pull request.
- A pull request that changes files in `.github/workflows/` may need the `workflows` permission, which the App does not have. This has not been verified yet. If the merge fails, the workflow tries to dismiss its approval, the job log shows a warning and the pull request stays open. A merge queue avoids the problem.

## Migrate from v1

Coordinate the change across all repositories that use `teamesyfo-automerge`. Each private key authenticates as the same App and can be used for repositories covered by its installations. A valid v1 key in one repository therefore still affects repositories already configured for v2. [GitHub App private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)

1. The App owner identifies all v1 callers, installations and keys used by v1. Owners preparing to run v2 create and test their protected environment and configure branch protection as described in [Quick start](#quick-start). Keep v2 callers disabled.
2. Disable every v1 caller, cancel queued and running v1 jobs and wait for those runs to finish. Remove the old keys from Dependabot, repository and organization secrets. On open Dependabot pull requests, cancel auto-merge requests and queue entries left by v1 and dismiss its outstanding `github-actions[bot]` approvals. Verify that these requests and approvals are gone.
3. The App owner generates a replacement key, distributes it only to the tested environments and revokes every v1 key in the GitHub App settings. Allow already-issued installation tokens to expire before starting the pilot. GitHub installation tokens expire one hour after issuance. [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
4. Run the pilot below. Once it passes, enable the v2 caller in each prepared repository. Repositories awaiting setup continue with manual merges.

## Verify the pilot

Use a test repository with the App installed, squash merging enabled and a protected default branch without a merge queue for the first test. Install the pinned [caller](#caller-workflow) there with just the `workflow_dispatch` trigger. Use a single eligible Dependabot pull request, with no existing App approval of its head and no changes to `.github/workflows/`. A manual run evaluates every eligible PR, and each part of the test needs a fresh approval.

1. Require a real CI check on the default branch and wait for it to pass on the PR head. Record the SHA. Add a second required check with a name that no workflow reports. Confirm that the App has no ruleset or branch protection bypass.
2. Run the caller on the default branch. Confirm that the find step reports `ready to merge commit <sha>` using the job's `GITHUB_TOKEN`, and the PR shows a review by `teamesyfo-automerge[bot]` on that SHA. The job log must show `requesting squash merge of commit <sha> as teamesyfo-automerge[bot]` followed by GitHub's refusal because of the outstanding required check. Confirm the PR remains open and the new approval was dismissed. A skipped candidate, an earlier lookup failure or an unexplained denial leaves the result inconclusive.
3. Remove only the extra required check. Run the caller again on the same SHA. Confirm the App's new approval, the successful squash merge in the job log and the merged PR on the default branch. Keep links to the two runs and the pull request with the rollout record.

For repositories using a merge queue, also verify the queue path in the pilot. Use an eligible PR with green head checks, a required CI workflow that runs on `merge_group`, and the same App permissions as the consumer. Confirm the log shows `requesting merge queue entry for commit <sha> as teamesyfo-automerge[bot]` and `added commit <sha> to the merge queue`. Follow the entry through successful merge-group checks to the merged PR on the default branch.

## Security model and remaining risks

- The job that holds the App key never checks out or runs pull request code. The key is only available to the default branch, through the environment, and the job runs only on the schedule or on a manual run on the default branch.
- The App approves, not `GITHUB_TOKEN`. With **Allow GitHub Actions to create and approve pull requests** turned off, a workflow on another branch cannot use `GITHUB_TOKEN` to approve a pull request. The App approval counts as the required review, but not as a code owner review.

Remaining risks:

- A malicious version of a dependency that passes CI is still merged. CI, required checks and a Dependabot cooldown reduce this risk.
- Anyone who can change workflows on a trusted default branch or change its environment protections can gain access to the App key. Consumers holding a key for this App therefore share trust across its installations, even after the v1 keys have been revoked.
- If someone pushes to a pull request that the App has approved, the App approval of the old commit still counts until the next run dismisses it. During that time, a human can merge the new commit without a new approval. The same applies when someone changes the base branch of a pull request that the App has approved. If the workflow cannot dismiss the approval, it skips the pull request, and the approval stays until someone dismisses it. **Dismiss stale pull request approvals when new commits are pushed** closes this gap for pushes, but then every push to any pull request needs a new approval. No setting closes the gap for a changed base branch.
- If only some people may dismiss reviews in the repository, `GITHUB_TOKEN` may not be allowed to dismiss approvals. Then the workflow skips pull requests with an App approval of an old commit, and a person must dismiss the approval.
- A required check appears on a commit only after it reports. The App relies on GitHub to enforce outstanding required checks at merge time. Verify the App has no bypass in each repository and run the [pilot](#verify-the-pilot) before rollout.
- The merge binds to the head commit, but GitHub cannot bind it to the base branch. The workflow checks the base branch just before it approves and again just before it merges. Someone who changes the base branch in the short time between that check and the merge can make the App merge the pull request into another branch. Changing the base branch requires write access to the repository.
- The workflow reads which checks are required with `GITHUB_TOKEN`. This has not been verified in a consumer repository yet. If it does not work, the workflow merges nothing. The log then shows `not ready: no required check has reported`, or, if the lookup fails, `evaluation failed: ...` in the first step or `not merged: ...` in the second step.

## Troubleshooting

The job log records each evaluated pull request and its outcome, including `PR #12: not ready: <reason>` and `PR #12: not merged: <reason>`.

| Message or symptom | What to do |
| --- | --- |
| The workflow never runs | Check that the caller workflow is on the default branch, and that GitHub has not disabled the schedule. |
| The job waits for or is rejected by the environment | Check that the environment allows the default branch, and that it has no required reviewers, wait timer or custom deployment protection rule. |
| `The secret AUTOMERGE_APP_PRIVATE_KEY is empty` | Add the key as an environment secret in `dependabot-automerge`. |
| `The App token belongs to "...", but the workflow expects teamesyfo-automerge[bot].` | Check that the configured App, its current slug and its environment key all belong to `teamesyfo-automerge`. |
| `The merge window is closed. This run merges no pull requests.` or `not ready: the merge window is closed` | Wait for the merge window, or start the workflow manually. |
| `not ready: no required check has reported` | Add a required status check on the default branch, and make sure that CI runs on `pull_request`. See [Security model](#security-model-and-remaining-risks) if the repository already has one. |
| `not ready: required check "..." is failure` | Fix the build, or run the check again. |
| `not ready: no check has succeeded` | Add CI that runs on `pull_request`. |
| `not ready: check "..." concluded cancelled` | Run the check again. |
| `not ready: GitHub has not computed mergeability yet` | Wait for the next run. |
| `not ready: the PR does not target the default branch` | The workflow merges only pull requests to the default branch, and it has dismissed its own approvals on this pull request. Someone has changed the base branch, or `dependabot.yml` sets `target-branch`. Change the base branch back, or review the pull request manually. |
| `not ready: the PR is already in the merge queue` | Wait for the merge queue. |
| `not ready: the head commit was removed from the merge queue; ...` | Find out why GitHub or a person removed the pull request from the queue. Then comment `@dependabot rebase`, or add the pull request to the queue by hand. |
| `not ready: the PR has more than 100 merge queue and force-push events; ...` or `not ready: GitHub does not tell which commit was added to the merge queue; ...` | The workflow cannot tell whether the head commit has been in the queue. Review the pull request, and add it to the queue by hand. |
| `not ready: the PR has 2 commits, expected 1` or `... the committer is not GitHub` | Check the commits and review the pull request manually, or comment `@dependabot recreate`. |
| `not ready: the latest branch activity does not confirm that Dependabot set the PR head` | Check the latest repository activity for the PR head branch. The ref, resulting SHA and actor must match. Review manually if GitHub cannot confirm the update. |
| `could not dismiss approval <id>` | Check the review ID on the PR. It can be an old approval, an approval on a retargeted PR, or an approval used for a failed merge attempt. Dismiss it manually and check who has permission to dismiss reviews. |
| `evaluation failed: ...` | Read the error. It can come from a failed lookup of the pull request or its checks. The next run tries again. |
| `not merged: ...` | Check that the App has access to the repository, that squash merging is allowed, and see [Merge queue](#merge-queue). A failed lookup of the required checks also gives this message. The next run tries again. |
| `Skipped an invalid candidate: ...` | This is an error in the workflow. Tell Team eSyfo. |

## v1 (deprecated)

`dependabot-automerge.yaml` runs on `pull_request`, receives the App key as the secret `APP_PRIVATE_KEY` (callers pass their Dependabot secret `AUTOMERGE_APP_PRIVATE_KEY`), approves eligible pull requests and enables auto-merge with `gh pr merge --auto --squash`. Use the coordinated migration above to retire v1.
