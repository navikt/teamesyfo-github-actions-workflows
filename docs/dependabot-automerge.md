# Dependabot automerge

This document explains how to use `dependabot-automerge-v2.yaml` from `navikt/teamesyfo-github-actions-workflows`, what the consumer repository must configure, and how to migrate from `dependabot-automerge.yaml` (v1).

The workflow has two jobs. The `automerge` job approves patch and minor updates and adds them to the merge queue. The `review` job asks Copilot to review the other updates, such as major updates, so that a human can decide faster.

v1 is deprecated. Both versions use the same GitHub App. After the v2 pilot, repositories migrate one at a time, and the App owner revokes the v1 keys when the last repository has migrated. See [Migrate from v1](#migrate-from-v1).

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
4. Store the v2 App key as the **environment secret** `AUTOMERGE_APP_PRIVATE_KEY` after the environment test passes. The App owner gives out the v2 key. Never reuse a key from v1. See [Migrate from v1](#migrate-from-v1).
5. Turn off **Allow GitHub Actions to create and approve pull requests** in Settings -> Actions -> General, unless another workflow needs it. The App approves, not `GITHUB_TOKEN`. The default workflow permissions can stay read-only, because the workflow sets its own permissions.
6. Turn on a merge queue for the default branch, in a ruleset or in branch protection. The workflow merges nothing without one. See [Merge queue](#merge-queue).
7. Add at least one required status check on the default branch, in a ruleset or in branch protection. The check must come from CI that runs on `pull_request` and `merge_group`. The workflow merges nothing until the required checks have passed on the head commit. Do not add the App to a bypass list in any ruleset or branch protection rule, because GitHub must enforce the required checks when the App merges.
8. If updates left open by this workflow require human approval, require a review in the branch rules and check which identities can satisfy it. Repository and organization settings must prevent another automated reviewer from satisfying that requirement.
9. Make sure that Copilot code review is available in the repository, and that a Copilot review never counts as an approval. In Settings -> Copilot -> Code review, under **Auto-approval**, turn off **Allow Copilot to approve pull requests** and **Allow Copilot approvals to count toward merge requirements**. An organization owner must check that **Count Copilot approvals toward merge requirements** in the organization settings does not enable Copilot approvals for the repository. The API cannot read these settings, so the workflow cannot check them. See [Copilot review](#copilot-review).
10. Optional: copy the [review instructions](#copilot-review) to the repository.
11. After the [pilot](#verify-the-pilot) passes, add or enable the [caller workflow](#caller-workflow) on the default branch. The caller in this workflow repository is enabled by setting the repository variable `DEPENDABOT_AUTOMERGE_ENABLED=true`.

## Policy

The same rule decides which updates the `automerge` job merges and which updates the `review` job sends to Copilot.

| Update | Automerged? | Notes |
| --- | --- | --- |
| Patch or minor update, in every ecosystem | ✅ Yes, through the merge queue | All updates in a grouped PR must be patch or minor |
| Major update, also of GitHub Actions | ❌ No | Copilot review, then a human decides |
| Update without valid Dependabot metadata in the commit | ❌ No | Copilot review, then a human decides |

The update types come from the metadata block that Dependabot adds to its commit message. Every entry in the block must have a name and a version that are not empty or `null`, and no field may occur twice in an entry. Otherwise the update is left for a human. A major update of a GitHub action can change its inputs, outputs or permissions, so the policy treats it as any other major update.

## When the workflow approves and merges

The `automerge` job runs only on the schedule or on a manual run on the default branch. It has two steps.

**1. Find the pull requests that are ready (`GITHUB_TOKEN`).** The workflow checks every open Dependabot pull request. A pull request is ready to merge only when all of these conditions are true:

- `dependabot[bot]` opened it from a `dependabot/` branch in the same repository.
- It targets the default branch.
- It follows the [policy](#policy) and is not a draft.
- It has exactly one commit. The commit matches the head SHA, has `dependabot[bot]` as author and `web-flow` as committer, and carries a verified signature. GitHub's latest repository activity for the exact head ref must record a branch creation, push or force push by Dependabot with that SHA as its result. A missing or mismatched record prevents approval.
- No reviewer's latest review requests changes.
- GitHub reports no merge conflict.
- At least one required status check has reported on the head commit, and every required check that has reported has succeeded, been skipped or concluded neutral. The rulesets and branch protection of the repository decide which checks are required.
- On the head commit, no check run, commit status or workflow run has failed, been cancelled or timed out, none is still running, and at least one has succeeded. Skipped and neutral checks do not count as successful. A cancelled workflow run stops counting when the same workflow has started a newer run for the same event and branch, for example after the pull request was reopened. A newer run does not replace a run that failed or timed out. That run blocks until someone re-runs it and it succeeds.
- The default branch has a merge queue. The pull request is not in the queue, and its head commit has never been in the queue. See [Merge queue](#merge-queue).
- The merge window is open. Scheduled runs pause on Saturdays, Sundays, 1 May, 17 May and from 24 December to 1 January (Europe/Oslo). A manual run (`workflow_dispatch`) ignores the merge window.

This step never approves. It dismisses approvals from the App of commits that are no longer the head. It also dismisses every approval from the App on a pull request that no longer targets the default branch, and then skips that pull request. If it cannot dismiss such an approval, it skips the pull request.

**2. Approve and add to the merge queue (the App).** When at least one pull request is ready, the workflow creates a short-lived token for the GitHub App. For each pull request, it:

1. Reads the current pull request, reviews, checks, queue history, commits and head-branch activity again. Scheduled runs also check the merge window for each candidate before approval.
2. Approves exactly the head commit as `teamesyfo-automerge[bot]`, reusing an existing App approval of that SHA if present.
3. Adds the pull request to the merge queue with `expectedHeadOid`, so GitHub rejects it if the head has changed. GitHub merges the pull request when the checks in the queue pass.

If the workflow cannot add the pull request to the queue after approval, it tries to dismiss the App approvals it used for that SHA, including any reused approvals. A failed dismissal leaves the approval in place and the job logs its review ID. See [Troubleshooting](#troubleshooting).

## Copilot review

The `review` job runs on the same triggers as the `automerge` job. It uses only `GITHUB_TOKEN` with `contents: read` and `pull-requests: write`. It needs neither the environment nor the App key, and it never approves.

The job checks every open Dependabot pull request that targets the default branch and is not a draft. It reads the update types from the latest commit by Dependabot in the pull request, and applies the [policy](#policy). A commit that a person pushes on top therefore does not change the result. When the policy does not allow automerge, the job requests a review from Copilot of the head commit. It does not request a review when:

- the policy allows automerge, also when the `automerge` job cannot merge the pull request for another reason, for example because a person has pushed a commit;
- a review request to Copilot is already pending;
- Copilot has already reviewed the head commit.

The job ignores the merge window, because a review request changes no code. If a request fails, the job logs a warning, continues with the next pull request and fails at the end. This happens on every run until the cause is fixed, for example when Copilot code review is not available in the repository.

Copilot code review takes no instructions with the request. To tell Copilot how to review dependency updates, copy [`docs/templates/dependency-updates.instructions.md`](templates/dependency-updates.instructions.md) to `.github/instructions/dependency-updates.instructions.md` in the repository. The instructions ask Copilot to read the release notes and migration guides of the new versions, to find the affected code in the repository, and to comment only. [Path-specific instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)

Known limitations:

- Copilot reviews each new head commit again, for example after `@dependabot rebase` or after a person pushes a fix.
- If a person removes the review request before Copilot has reviewed the head commit, the next run requests the review again.
- If Copilot finishes without a review, the next run requests the review again.

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
- The caller runs both jobs. The permissions above cover both.
- Add the caller only after you have created and tested the environment (steps 2–4 in the [quick start](#quick-start)). If the environment does not exist when the workflow runs, GitHub creates it without protection rules.
- The caller must pass the secret by name, although the secret only exists in the environment. The environment secret takes precedence.
- Scheduled workflows run only on the default branch. In a public repository, GitHub disables scheduled workflows after 60 days without activity. Enable the workflow again in the Actions tab if that happens.

## Merge queue

The workflow merges only through a merge queue on the default branch. The required CI workflow must also run on `merge_group`:

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

Without a merge queue, the workflow merges nothing. The job log then shows `not ready: the default branch has no merge queue; merge the PR by hand`. The workflow has no direct merge, so GitHub tests every update on top of the latest default branch before it merges.

GitHub Actions updates change files in `.github/workflows/`. Whether the App can add such a pull request to the queue without the `workflows` permission has not been verified. The [pilot](#verify-the-pilot) checks it.

## Migrate from v1

Migrate one repository at a time. Repositories that have not migrated keep running v1 until they do.

v2 merges fewer updates than v1. v1 automerges every GitHub Actions update, also major updates, and merges without a merge queue. v2 merges only patch and minor updates, only through a merge queue, and asks Copilot to review the rest.

Both versions use the same App, and every private key of the App can create tokens for all its installations. A v1 key that is still valid can therefore approve and merge in a repository that already uses v2. The v2 protection of the key, which limits it to the default branch, applies to the App as a whole only after the App owner has revoked every key that v1 uses. Until then, the risk is the same as with v1 alone. Keep the migration short for this reason. In this guide, the App owner is an owner of the `navikt` organization or a person who is App manager for the App. Other members cannot see the App settings, so they cannot create or revoke keys. [GitHub App managers](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/adding-and-removing-github-app-managers-in-your-organization) [GitHub App private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)

1. **Run the pilot.** The App owner creates a new private key for the App. This is the v2 key. Store it in the environment of a test repository, and run the [pilot](#verify-the-pilot). Do not migrate other repositories before the pilot passes.
2. **Migrate each repository.** In each repository:
   1. Do steps 2–10 in the [quick start](#quick-start), with the v2 key in step 4.
   2. Delete the Dependabot secret `AUTOMERGE_APP_PRIVATE_KEY`, and any repository secret that contains an App key. Do this before you add the v2 caller, because the caller would otherwise pass a repository secret to the workflow if the environment secret is missing. Without the secret, v1 stops before it approves anything.
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
3. **Revoke the v1 keys.** When no repository uses v1, the App owner revokes every key except the v2 key in the GitHub App settings. Check that no Dependabot, repository or organization secret still contains an old key. Tokens that an old key has already created stay valid for up to one hour. [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) Then `dependabot-automerge.yaml` (v1) can be deleted.

## Verify the pilot

Use a test repository with the App installed, the v2 key in its environment, a protected default branch with a merge queue, and Copilot code review set up as in step 9 of the [quick start](#quick-start). Install the pinned [caller](#caller-workflow) there with just the `workflow_dispatch` trigger. A manual run evaluates every open Dependabot pull request, so keep only the pull requests for the current part of the test open. Keep links to the runs and the pull requests with the rollout record.

**Merge queue.** Use a single eligible patch or minor update, with no existing App approval of its head.

1. Require a real CI check that runs on `pull_request` and `merge_group`, and wait for it to pass on the PR head. Record the SHA. Add a second required check with a name that no workflow reports. Confirm that the App has no ruleset or branch protection bypass.
2. Run the caller on the default branch. Confirm that the find step reports `ready to merge commit <sha>` using the job's `GITHUB_TOKEN`. This also shows that `GITHUB_TOKEN` can read the branch activity and the merge queue setting. Confirm that the PR shows a review by `teamesyfo-automerge[bot]` on that SHA, and that the job log shows `requesting merge queue entry for commit <sha> as teamesyfo-automerge[bot]`. GitHub must not merge the pull request: either GitHub refuses the entry and the job dismisses the new approval, or the queue removes the pull request because the extra check never reports. Record which. A skipped candidate, an earlier lookup failure or an unexplained denial leaves the result inconclusive.
3. Remove only the extra required check. If the queue removed the pull request, comment `@dependabot rebase` and wait for green checks on the new head commit, because the workflow does not add the same commit to the queue again. Run the caller again. Confirm `added commit <sha> to the merge queue` in the job log, and follow the entry through the queue checks to the merged PR on the default branch.
4. Repeat step 3 with a patch or minor GitHub Actions update. This verifies that the App can add a pull request that changes `.github/workflows/` to the queue.

**Copilot review.** Use two major updates: one that needs no code change, and one with a breaking change that affects the repository.

1. Run the caller. Confirm that the `review` job logs `requested a Copilot review of commit <sha>` for both pull requests, and that Copilot posts a review with the state *Commented* on each head commit. Confirm that the reviews do not satisfy a required review. If the repository has the review instructions, confirm that the review of the second pull request names the breaking change and the affected code.
2. Run the caller again. Confirm that the log shows `no Copilot review requested` for both pull requests, and that no new request appears.
3. Comment `@dependabot rebase` on one of the pull requests. When the new head commit is there, run the caller and confirm a new Copilot review of that commit.
4. Check in the organization's Copilot usage which account the reviews were billed to.

## Security model and remaining risks

- The job that holds the App key never checks out or runs pull request code. The key is only available to the default branch, through the environment, and the job runs only on the schedule or on a manual run on the default branch.
- The first step of the `automerge` job and the whole `review` job use only `GITHUB_TOKEN` and never approve. The workflow creates the App token only when at least one pull request is ready.
- The approval and the queue entry are bound to the head commit that the workflow checked, and the workflow checks every condition again just before it approves.
- Only an untouched, verified Dependabot commit that GitHub's branch activity shows Dependabot pushed can be automerged, and only after the required checks of the repository have passed.
- The App approves, not `GITHUB_TOKEN`. With **Allow GitHub Actions to create and approve pull requests** turned off, a workflow on another branch cannot use `GITHUB_TOKEN` to approve a pull request. The App approval counts as the required review, but not as a code owner review.
- A Copilot review is input for a human. With Copilot approvals turned off, it cannot satisfy a required review.

Remaining risks:

- A malicious version of a dependency that passes CI is still merged. CI, required checks and a Dependabot cooldown reduce this risk.
- If Copilot approvals are turned on in the repository or the organization, a Copilot approval can satisfy the required review of an update that the policy left for a human. The workflow cannot read these settings. Check them in every repository, see step 9 in the [quick start](#quick-start).
- Copilot reads release notes and other text that the maintainers of a dependency control. Such text can try to steer the review. The review instructions tell Copilot not to follow it, and a human still decides.
- Anyone who can change workflows on a trusted default branch or change its environment protections can gain access to the App key. Consumers holding a key for this App therefore share trust across its installations, even after the v1 keys have been revoked.
- Until the App owner has revoked every v1 key, a v1 key can approve and merge in every repository where the App is installed, also in repositories that use v2. See [Migrate from v1](#migrate-from-v1).
- If someone pushes to a pull request that the App has approved, the App approval of the old commit still counts until the next run dismisses it. During that time, a human can merge the new commit without a new approval. The same applies when someone changes the base branch of a pull request that the App has approved. If the workflow cannot dismiss the approval, it skips the pull request, and the approval stays until someone dismisses it. **Dismiss stale pull request approvals when new commits are pushed** closes this gap for pushes, but then every push to any pull request needs a new approval. No setting closes the gap for a changed base branch.
- If only some people may dismiss reviews in the repository, `GITHUB_TOKEN` may not be allowed to dismiss approvals. Then the workflow skips pull requests with an App approval of an old commit, and a person must dismiss the approval.
- A required check appears on a commit only after it reports. The App relies on GitHub to enforce outstanding required checks at merge time. Verify the App has no bypass in each repository and run the [pilot](#verify-the-pilot) before rollout.
- The queue entry binds to the head commit, but GitHub cannot bind it to the base branch. The workflow checks the base branch just before it approves and again just before it adds the pull request to the queue. Someone who changes the base branch in the short time between that check and the queue entry can make the App add the pull request to the merge queue of another branch. Changing the base branch requires write access to the repository.
- The workflow reads which checks are required, and whether the default branch has a merge queue, with `GITHUB_TOKEN`. This has not been verified in a consumer repository yet. If it does not work, the workflow merges nothing. The log then shows `not ready: no required check has reported`, or, if the lookup fails, `evaluation failed: ...` in the first step or `not merged: ...` in the second step.
- The workflow reads the branch activity with `GITHUB_TOKEN`. Team eSyfo has seen that GitHub records `dependabot[bot]` as the actor when Dependabot creates or force-pushes a branch. It has not verified that `GITHUB_TOKEN` with `contents: read` can read the activity, or how long GitHub keeps it. If the lookup fails, the workflow merges nothing, and the log shows `evaluation failed: ...` or `not ready: the latest branch activity does not confirm that Dependabot set the PR head`. The [pilot](#verify-the-pilot) verifies the lookup.

## Troubleshooting

The job log records each evaluated pull request and its outcome, including `PR #12: not ready: <reason>` and `PR #12: not merged: <reason>`. The log of the `review` job shows `PR #12: requested a Copilot review of commit <sha>` or `PR #12: no Copilot review requested: <reason>`.

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
| `not ready: the default branch has no merge queue; merge the PR by hand` | Turn on a merge queue for the default branch, see [Merge queue](#merge-queue). Until then, merge the pull request by hand. |
| `not ready: the head commit was removed from the merge queue; ...` | Find out why GitHub or a person removed the pull request from the queue. Then comment `@dependabot rebase`, or add the pull request to the queue by hand. |
| `not ready: the PR has more than 100 merge queue and force-push events; ...` or `not ready: GitHub does not tell which commit was added to the merge queue; ...` | The workflow cannot tell whether the head commit has been in the queue. Review the pull request, and add it to the queue by hand. |
| `not ready: the PR has 2 commits, expected 1` or `... the committer is not GitHub` | Check the commits and review the pull request manually, or comment `@dependabot recreate`. |
| `not ready: the latest branch activity does not confirm that Dependabot set the PR head` | Check the latest repository activity for the PR head branch. The ref, resulting SHA and actor must match. Review manually if GitHub cannot confirm the update. |
| `could not dismiss approval <id>` | Check the review ID on the PR. It can be an old approval, an approval on a retargeted PR, or an approval used for a failed merge attempt. Dismiss it manually and check who has permission to dismiss reviews. |
| `evaluation failed: ...` | Read the error. It can come from a failed lookup of the pull request or its checks. The next run tries again. |
| `not merged: ...` | Check that the App has access to the repository and that the default branch has a merge queue, and see [Merge queue](#merge-queue). A failed lookup of the required checks also gives this message. The next run tries again. |
| `could not request a Copilot review: ...` or `Could not request a Copilot review on 1 pull request(s).` | Check that Copilot code review is available in the repository. The next run tries again. |
| `Skipped an invalid candidate: ...` | This is an error in the workflow. Tell Team eSyfo. |

## v1 (deprecated)

`dependabot-automerge.yaml` runs on `pull_request`, receives the App key as the secret `APP_PRIVATE_KEY` (callers pass their Dependabot secret `AUTOMERGE_APP_PRIVATE_KEY`), approves eligible pull requests and enables auto-merge with `gh pr merge --auto --squash`. Follow [Migrate from v1](#migrate-from-v1) to retire v1.
