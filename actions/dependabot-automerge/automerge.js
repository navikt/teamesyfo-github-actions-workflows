'use strict'

const DEPENDABOT_LOGIN = 'dependabot[bot]'
const AUTOMERGEABLE_UPDATE_TYPES = new Set(['version-update:semver-patch', 'version-update:semver-minor'])
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
])
const OSLO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
})

const METADATA_START = '\n---\nupdated-dependencies:\n'
const METADATA_END = /\n\.\.\.(\n|$)/
const METADATA_FIELDS = { 'dependency-name': 'name', 'dependency-version': 'version', 'update-type': 'updateType' }
const YAML_NULL = /^(null|Null|NULL|~)?$/

// Returns null for an empty or YAML null value, so a required field without
// content counts as missing.
function scalarValue(value) {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  if (quoted) return quoted[2].trim() === '' ? null : quoted[2]
  return YAML_NULL.test(trimmed) ? null : trimmed
}

// Reads the YAML block that Dependabot appends to its commit message. Only the
// last block counts, because the release notes above it may quote other blocks.
// A line it does not understand, a repeated field or an entry without a name
// or a version gives null, so the update needs a manual review.
function parseUpdatedDependencies(message) {
  const start = message.lastIndexOf(METADATA_START)
  if (start === -1) return null
  const rest = message.slice(start + METADATA_START.length)
  const end = rest.search(METADATA_END)
  if (end === -1) return null

  const dependencies = []
  let keys = null
  for (const line of rest.slice(0, end).split('\n')) {
    if (line.trim() === '') continue
    const entry = /^(- |  )([a-z-]+):(.*)$/.exec(line)
    if (!entry) return null
    const [, indent, key, value] = entry
    if (indent === '- ') {
      dependencies.push({})
      keys = new Set()
    }
    if (!keys || keys.has(key)) return null
    keys.add(key)
    const field = METADATA_FIELDS[key]
    if (field) dependencies[dependencies.length - 1][field] = scalarValue(value)
  }
  if (dependencies.length === 0 || dependencies.some((dependency) => !dependency.name || !dependency.version)) {
    return null
  }
  return dependencies
}

// The one rule for every ecosystem, shared by the merge and the review steps:
// automerge only when every dependency in the update is a patch or a minor
// update. Everything else, also a missing update type, needs a review.
function classifyUpdate(dependencies) {
  if (!dependencies?.length) {
    return { automerge: false, reason: 'the commit has no Dependabot metadata' }
  }
  const blocking = dependencies.find((dependency) => !AUTOMERGEABLE_UPDATE_TYPES.has(dependency.updateType))
  if (blocking) {
    return {
      automerge: false,
      reason: `${blocking.name ?? 'a dependency'} has update type ${blocking.updateType ?? 'unknown'}`,
    }
  }
  return { automerge: true, reason: 'all updates are patch or minor' }
}

// Check the PR's single commit. The branch activity is checked separately
// because GitHub also signs commits created by other actors.
function checkProvenance({ headSha, commits }) {
  if (commits.length !== 1) {
    return { ok: false, reason: `the PR has ${commits.length} commits, expected 1` }
  }
  const [commit] = commits
  if (commit.sha !== headSha) return { ok: false, reason: 'the commit is not the PR head' }
  if (commit.author?.login !== DEPENDABOT_LOGIN) return { ok: false, reason: 'the commit author is not Dependabot' }
  if (commit.committer?.login !== 'web-flow') return { ok: false, reason: 'the committer is not GitHub' }
  if (commit.commit?.verification?.verified !== true) return { ok: false, reason: 'the commit signature is not verified' }
  return { ok: true, reason: 'one verified Dependabot commit' }
}

// A workflow can run again for the same commit, for example when a PR is
// reopened. A cancelled run then stops counting when the same workflow has a
// newer run for the same event and branch, and the newer run's own result
// counts. Any other failure still blocks; re-running it replaces its result.
function withoutReplacedCancellations(workflowRuns) {
  const sameContext = (a, b) => a.workflow_id === b.workflow_id && a.event === b.event && a.head_branch === b.head_branch
  return workflowRuns.filter(
    (run) =>
      run.conclusion !== 'cancelled' ||
      !workflowRuns.some((newer) => sameContext(newer, run) && newer.run_number > run.run_number),
  )
}

function summarizeChecks({ checkRuns, combinedStatus, workflowRuns: allWorkflowRuns }) {
  const workflowRuns = withoutReplacedCancellations(allWorkflowRuns)
  const failedRun = checkRuns.find((run) => run.status === 'completed' && FAILING_CONCLUSIONS.has(run.conclusion))
  if (failedRun) return { state: 'blocked', reason: `check "${failedRun.name}" concluded ${failedRun.conclusion}` }
  const failedWorkflow = workflowRuns.find(
    (run) => run.status === 'completed' && FAILING_CONCLUSIONS.has(run.conclusion),
  )
  if (failedWorkflow) {
    return { state: 'blocked', reason: `workflow "${failedWorkflow.name}" concluded ${failedWorkflow.conclusion}` }
  }
  const hasStatuses = combinedStatus.total_count > 0
  if (hasStatuses && ['failure', 'error'].includes(combinedStatus.state)) {
    return { state: 'blocked', reason: `the commit status is ${combinedStatus.state}` }
  }

  const runningCheck = checkRuns.find((run) => run.status !== 'completed')
  if (runningCheck) return { state: 'pending', reason: `check "${runningCheck.name}" is ${runningCheck.status}` }
  const runningWorkflow = workflowRuns.find((run) => run.status !== 'completed')
  if (runningWorkflow) return { state: 'pending', reason: `workflow "${runningWorkflow.name}" is ${runningWorkflow.status}` }
  if (hasStatuses && combinedStatus.state !== 'success') {
    return { state: 'pending', reason: `the commit status is ${combinedStatus.state}` }
  }

  const succeeded = checkRuns.some((run) => run.conclusion === 'success') || (hasStatuses && combinedStatus.state === 'success')
  if (!succeeded) return { state: 'blocked', reason: 'no check has succeeded' }
  return { state: 'success', reason: 'all checks are green' }
}

const PASSING_REQUIRED_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

// The repository decides which checks are required. A required check that has
// not started yet is missing from the list, so GitHub still enforces it when
// the workflow merges.
function summarizeRequiredChecks({ headSha, commit }) {
  if (commit?.oid !== headSha) return { state: 'blocked', reason: 'the required checks are not for the head commit' }
  const contexts = commit.statusCheckRollup?.contexts
  if (contexts?.pageInfo?.hasNextPage) return { state: 'blocked', reason: 'the head commit has more than 100 checks' }
  const required = (contexts?.nodes ?? []).filter((node) => node.isRequired === true)
  if (required.length === 0) return { state: 'blocked', reason: 'no required check has reported' }
  for (const node of required) {
    const result = node.__typename === 'CheckRun' && node.status === 'COMPLETED' ? node.conclusion : (node.state ?? node.status)
    if (!PASSING_REQUIRED_RESULTS.has(result)) {
      return { state: 'blocked', reason: `required check "${node.name ?? node.context}" is ${String(result).toLowerCase()}` }
    }
  }
  return { state: 'success', reason: 'all required checks passed' }
}

// Scheduled merges pause on weekends, 1 May, 17 May and 24 December to 1 January.
function isMergeWindowOpen(date) {
  const parts = Object.fromEntries(OSLO_DATE.formatToParts(date).map((part) => [part.type, part.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const monthDay = `${parts.month}-${parts.day}`
  if (monthDay === '05-01' || monthDay === '05-17') return false
  if (monthDay >= '12-24' || monthDay === '01-01') return false
  return true
}

const APPROVER_LOGIN = 'teamesyfo-automerge[bot]'
// The merge queue runs the required checks on the result of the merge, so it is
// the only path the workflow merges through.
const NO_MERGE_QUEUE = 'the default branch has no merge queue; merge the PR by hand'
const HEAD_UPDATES = new Set(['branch_creation', 'push', 'force_push'])
const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])
const SHA = /^[0-9a-f]{40}$/

// Each reviewer's latest decisive review counts, as in branch protection.
function hasChangesRequested(reviews) {
  const latestByUser = new Map()
  for (const review of reviews) {
    if (review.user && DECISIVE_REVIEW_STATES.has(review.state)) latestByUser.set(review.user.login, review.state)
  }
  return [...latestByUser.values()].includes('CHANGES_REQUESTED')
}

function isAppApproval(review) {
  return review.user?.login === APPROVER_LOGIN && review.state === 'APPROVED'
}

function isDependabotPullRequest(pull) {
  return (
    pull.user?.login === DEPENDABOT_LOGIN &&
    pull.head.ref.startsWith('dependabot/') &&
    pull.head.repo?.full_name === pull.base.repo.full_name
  )
}

// Runs with GITHUB_TOKEN and never approves. The output lists each pull request
// that is ready to merge, bound to the head commit that passed every gate.
async function findMergeCandidates({ github, context, core, now = new Date() }) {
  const { owner, repo } = context.repo
  const windowOpen = context.eventName !== 'schedule' || isMergeWindowOpen(now)
  if (!windowOpen) core.info('The merge window is closed. This run merges no pull requests.')

  // Lists PRs on every base, so it also finds App approvals on retargeted PRs.
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })
  const candidates = []
  for (const pull of pulls.filter(isDependabotPullRequest)) {
    const api = { github, owner, repo, pull_number: pull.number }
    const log = (message) => core.info(`PR #${pull.number}: ${message}`)
    try {
      const gates = await checkMergeGates({ api, core, windowOpen })
      if (gates.ok) {
        candidates.push({ number: pull.number, headSha: gates.headSha })
        log(`ready to merge commit ${gates.headSha}`)
      } else {
        log(`not ready: ${gates.reason}`)
      }
    } catch (error) {
      core.warning(`PR #${pull.number}: evaluation failed: ${error.message}`)
    }
  }
  core.setOutput('candidates', JSON.stringify(candidates))
  return candidates
}

function targetsDefaultBranch(pull) {
  return pull.base.ref === pull.base.repo.default_branch
}

// Read reviews before the PR so that cleanup compares each approval with a
// fresh head and base. Run the same gates again before the App approves.
async function checkMergeGates({ api, core, expectedHeadSha, windowOpen = true }) {
  const { github, owner, repo, pull_number } = api
  const blocked = (reason) => ({ ok: false, reason })
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number })
  if (pull.state !== 'open') return blocked('the PR is not open')
  if (!isDependabotPullRequest(pull)) return blocked('the PR is not a same-repository Dependabot update')
  if (!(await dismissStaleApprovals({ api, core, pull, approvals: reviews.filter(isAppApproval) }))) {
    return blocked('a stale approval could not be dismissed')
  }
  if (!targetsDefaultBranch(pull)) return blocked('the PR does not target the default branch')
  if (!windowOpen) return blocked('the merge window is closed')
  if (pull.draft) return blocked('the PR is a draft')
  const headSha = pull.head.sha
  if (expectedHeadSha !== undefined && headSha !== expectedHeadSha) return blocked('the head commit changed')
  if (hasChangesRequested(reviews)) return blocked('a reviewer has requested changes')
  if (pull.mergeable !== true) {
    return blocked(pull.mergeable === false ? 'has a merge conflict' : 'GitHub has not computed mergeability yet')
  }

  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 })
  const provenance = checkProvenance({ headSha, commits })
  if (!provenance.ok) return provenance
  const policy = classifyUpdate(parseUpdatedDependencies(commits[0].commit.message))
  if (!policy.automerge) return blocked(policy.reason)
  const checks = summarizeChecks(await readChecks({ api, headSha }))
  if (checks.state !== 'success') return blocked(checks.reason)
  const state = await readQueueAndRequiredChecks({ api })
  if (!state.isMergeQueueEnabled) return blocked(NO_MERGE_QUEUE)
  if (state.isInMergeQueue) return blocked('the PR is already in the merge queue')
  const removal = queueRemovalProblem({ headSha, timelineItems: state.timelineItems })
  if (removal) return blocked(removal)
  const required = summarizeRequiredChecks({ headSha, commit: state.commits.nodes[0]?.commit })
  if (required.state !== 'success') return blocked(required.reason)
  if (!(await dependabotSetHead(api, pull.head))) {
    return blocked('the latest branch activity does not confirm that Dependabot set the PR head')
  }
  return { ok: true, headSha, reason: `${checks.reason} and ${required.reason}`, reviews }
}

async function dependabotSetHead({ github, owner, repo }, head) {
  const ref = `refs/heads/${head.ref}`
  // Filtering by actor or event type could hide a more recent change to the ref.
  const { data } = await github.rest.repos.listActivities({ owner, repo, ref, direction: 'desc', per_page: 1 })
  const [latest] = data
  return (
    latest?.ref === ref &&
    latest.after === head.sha &&
    latest.actor?.login === DEPENDABOT_LOGIN &&
    HEAD_UPDATES.has(latest.activity_type)
  )
}

// GitHub removes a PR from the merge queue when the queue checks fail or a
// maintainer removes it, while the checks on its head can stay green. A head
// that has been in the queue must not return to it, but a new head may. The
// timeline records when the PR was added to and removed from the queue, and
// each force push with the heads before and after it. Dependabot changes the
// head only by force-pushing, so the head at an addition is the head after the
// force push before it. A head that is force-pushed while the PR is still in
// the queue counts as added as well, and so does a head that the timeline shows
// removed without an addition. A push without force leaves no event, so
// when the heads around a segment with an addition differ, the added commit is
// unknown. The timeline does not show the head before the first force push, so
// the first segment is assumed to end with the head it started with.
function queueRemovalProblem({ headSha, timelineItems }) {
  if (timelineItems.pageInfo.hasPreviousPage) {
    return 'the PR has more than 100 merge queue and force-push events; merge it by hand'
  }
  const firstPush = timelineItems.nodes.find((event) => event.__typename === 'HeadRefForcePushedEvent')
  let head = firstPush ? firstPush.beforeCommit?.oid : headSha
  let added = false
  let queued = false
  const endSegment = (endHead) => {
    if (!added) return null
    if (!head || endHead !== head) {
      return 'GitHub does not tell which commit was added to the merge queue; merge the PR by hand'
    }
    if (head === headSha) {
      return 'the head commit was removed from the merge queue; push a new commit, for example with "@dependabot rebase", or add the PR to the queue by hand'
    }
    return null
  }
  for (const event of timelineItems.nodes) {
    if (event.__typename === 'AddedToMergeQueueEvent') {
      added = queued = true
    } else if (event.__typename === 'RemovedFromMergeQueueEvent') {
      added = true
      queued = false
    } else {
      const problem = endSegment(event.beforeCommit?.oid)
      if (problem) return problem
      head = event.afterCommit?.oid
      added = queued
    }
  }
  return endSegment(headSha)
}

// Consumers do not dismiss stale approvals, so an App approval of an old commit
// would still count when a human merges a newer one. An approval on a PR that no
// longer targets the default branch is dismissed as well, because the workflow
// does not follow that PR. Returns false when an approval remains.
async function dismissStaleApprovals({ api, core, pull, approvals }) {
  let dismissedAll = true
  for (const review of approvals) {
    const message = staleApprovalMessage({ pull, review })
    if (message && !(await dismissApproval({ api, core, reviewId: review.id, message }))) dismissedAll = false
  }
  return dismissedAll
}

function staleApprovalMessage({ pull, review }) {
  if (!targetsDefaultBranch(pull)) return 'The PR no longer targets the default branch.'
  if (review.commit_id !== pull.head.sha) return 'The approved commit is no longer the head.'
  return null
}

async function dismissApproval({ api, core, reviewId, message }) {
  const { github, owner, repo, pull_number } = api
  try {
    await github.rest.pulls.dismissReview({ owner, repo, pull_number, review_id: reviewId, message })
    return true
  } catch (error) {
    core.warning(`PR #${pull_number}: could not dismiss approval ${reviewId}: ${error.message}`)
    return false
  }
}

async function readChecks({ api, headSha }) {
  const { github, owner, repo } = api
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: headSha, per_page: 100 })
  const { data: combinedStatus } = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: headSha })
  const workflowRuns = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    head_sha: headSha,
    per_page: 100,
  })
  return { checkRuns, combinedStatus, workflowRuns }
}

async function readQueueAndRequiredChecks({ api }) {
  const { github, owner, repo, pull_number } = api
  const { repository } = await github.graphql(QUEUE_AND_REQUIRED_CHECKS_QUERY, { owner, repo, number: pull_number })
  return repository.pullRequest
}

const MERGE_QUEUE_HISTORY = `
        timelineItems(
          itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]
          last: 100
        ) {
          pageInfo { hasPreviousPage }
          nodes {
            __typename
            ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } }
          }
        }`

const QUEUE_AND_REQUIRED_CHECKS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        isInMergeQueue
        isMergeQueueEnabled
        ${MERGE_QUEUE_HISTORY}
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
                    ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`

const PULL_REQUEST_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      pullRequest(number: $number) {
        id
        state
        isDraft
        headRefOid
        baseRefName
        isInMergeQueue
        isMergeQueueEnabled
        ${MERGE_QUEUE_HISTORY}
      }
    }
  }`

const ENQUEUE_MUTATION = `
  mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
    enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
      mergeQueueEntry { position }
    }
  }`

// Approves and merges only the exact commit that findMergeCandidates selected,
// after a fresh check of every gate. github is GITHUB_TOKEN; appGithub is the
// App, whose approval counts as the required review. Errors become warnings
// without a fallback, so a pull request that fails waits for the next run.
async function approveAndMerge({ github, appGithub, appSlug, context, core, candidates, getTime = () => new Date() }) {
  if (`${appSlug}[bot]` !== APPROVER_LOGIN) {
    core.setFailed(`The App token belongs to "${appSlug}", but the workflow expects ${APPROVER_LOGIN}.`)
    return
  }
  if (!Array.isArray(candidates)) {
    core.setFailed('The list of pull requests to merge is not an array.')
    return
  }
  const { owner, repo } = context.repo
  const canApproveNow = () => context.eventName !== 'schedule' || isMergeWindowOpen(getTime())
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate?.number) || !SHA.test(candidate?.headSha ?? '')) {
      core.warning(`Skipped an invalid candidate: ${JSON.stringify(candidate)}`)
      continue
    }
    const api = { github, owner, repo, pull_number: candidate.number }
    try {
      await approveAndMergePullRequest({ api, appGithub, core, headSha: candidate.headSha, canApproveNow })
    } catch (error) {
      core.warning(`PR #${candidate.number}: not merged: ${error.message}`)
    }
  }
}

async function approveAndMergePullRequest({ api, appGithub, core, headSha, canApproveNow }) {
  const { owner, repo, pull_number } = api
  const gates = await checkMergeGates({ api, core, expectedHeadSha: headSha })
  if (!gates.ok) throw new Error(gates.reason)
  if (!canApproveNow()) throw new Error('the merge window is closed')

  const approvals = gates.reviews.filter((review) => isAppApproval(review) && review.commit_id === headSha)
  if (approvals.length === 0) {
    const { data: approval } = await appGithub.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: 'APPROVE',
      commit_id: headSha,
      body: `Approved automatically for commit ${headSha}: an untouched Dependabot update that the policy allows, ${gates.reason}.`,
    })
    approvals.push(approval)
    core.info(`PR #${pull_number}: approved commit ${headSha}`)
  }

  try {
    await mergePullRequest({ github: appGithub, core, owner, repo, number: pull_number, headSha })
  } catch (error) {
    for (const approval of approvals) {
      await dismissApproval({ api, core, reviewId: approval.id, message: 'The merge failed after approval.' })
    }
    throw error
  }
}

async function mergePullRequest({ github, core, owner, repo, number, headSha }) {
  const { repository } = await github.graphql(PULL_REQUEST_QUERY, { owner, repo, number })
  const pull = repository.pullRequest
  const blocker =
    (pull.state !== 'OPEN' && 'the PR is not open') ||
    (pull.isDraft && 'the PR is a draft') ||
    (pull.headRefOid !== headSha && 'the head changed after approval') ||
    (pull.baseRefName !== repository.defaultBranchRef.name && 'the PR does not target the default branch')
  if (blocker) throw new Error(blocker)
  if (!pull.isMergeQueueEnabled) throw new Error(NO_MERGE_QUEUE)
  if (pull.isInMergeQueue) {
    core.info(`PR #${number}: already in the merge queue`)
    return
  }
  // Someone can add the PR to the queue, and GitHub remove it, while this run approves.
  // This read and the addition below are separate requests, and GitHub can make the
  // addition depend only on the head commit, so a short window remains.
  const removal = queueRemovalProblem({ headSha, timelineItems: pull.timelineItems })
  if (removal) throw new Error(removal)

  core.info(`PR #${number}: requesting merge queue entry for commit ${headSha} as ${APPROVER_LOGIN}`)
  await github.graphql(ENQUEUE_MUTATION, { pullRequestId: pull.id, expectedHeadOid: headSha })
  core.info(`PR #${number}: added commit ${headSha} to the merge queue`)
}

const COPILOT_REVIEWER = 'copilot-pull-request-reviewer[bot]'
// GitHub lists a pending request as the user Copilot and the review as the bot.
const COPILOT_LOGINS = new Set(['Copilot', COPILOT_REVIEWER])

// Runs with GITHUB_TOKEN. Asks Copilot to review each update that the policy
// leaves for a human, once per head commit. Copilot only comments; a human
// decides whether to approve and merge.
async function requestCopilotReviews({ github, context, core }) {
  const { owner, repo } = context.repo
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })
  const reviewable = pulls.filter((pull) => isDependabotPullRequest(pull) && targetsDefaultBranch(pull) && !pull.draft)
  let failures = 0
  for (const pull of reviewable) {
    const api = { github, owner, repo, pull_number: pull.number }
    try {
      const skip = await reasonToSkipCopilotReview({ api, pull })
      if (skip) {
        core.info(`PR #${pull.number}: no Copilot review requested: ${skip}`)
        continue
      }
      await github.rest.pulls.requestReviewers({ owner, repo, pull_number: pull.number, reviewers: [COPILOT_REVIEWER] })
      core.info(`PR #${pull.number}: requested a Copilot review of commit ${pull.head.sha}`)
    } catch (error) {
      failures++
      core.warning(`PR #${pull.number}: could not request a Copilot review: ${error.message}`)
    }
  }
  if (failures > 0) core.setFailed(`Could not request a Copilot review on ${failures} pull request(s).`)
}

// The latest Dependabot commit decides, so a maintainer's follow-up commit
// neither hides a major update nor turns a patch update into a review.
async function reasonToSkipCopilotReview({ api, pull }) {
  const { github, owner, repo, pull_number } = api
  if (pull.requested_reviewers?.some((reviewer) => COPILOT_LOGINS.has(reviewer.login))) {
    return 'a Copilot review is already requested'
  }
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 })
  const update = commits.findLast((commit) => commit.author?.login === DEPENDABOT_LOGIN)
  const policy = classifyUpdate(update && parseUpdatedDependencies(update.commit.message))
  if (policy.automerge) return policy.reason
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  if (reviews.some((review) => COPILOT_LOGINS.has(review.user?.login) && review.commit_id === pull.head.sha)) {
    return `Copilot has reviewed commit ${pull.head.sha}`
  }
  return null
}

module.exports = {
  parseUpdatedDependencies,
  classifyUpdate,
  checkProvenance,
  summarizeChecks,
  summarizeRequiredChecks,
  isMergeWindowOpen,
  findMergeCandidates,
  approveAndMerge,
  requestCopilotReviews,
}
