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

function unquote(value) {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2] : trimmed
}

// Reads the YAML block that Dependabot appends to its commit message. Only the
// last block counts, because the release notes above it may quote other blocks.
function parseUpdatedDependencies(message) {
  const start = message.lastIndexOf(METADATA_START)
  if (start === -1) return null
  const rest = message.slice(start + METADATA_START.length)
  const end = rest.search(METADATA_END)
  if (end === -1) return null

  const dependencies = []
  for (const line of rest.slice(0, end).split('\n')) {
    const entry = /^(- |  )([a-z-]+):(.*)$/.exec(line)
    if (!entry) continue
    if (entry[1] === '- ') dependencies.push({})
    const current = dependencies[dependencies.length - 1]
    if (!current) return null
    const value = unquote(entry[3])
    if (entry[2] === 'dependency-name') current.name = value
    if (entry[2] === 'dependency-version') current.version = value
    if (entry[2] === 'update-type') current.updateType = value
  }
  return dependencies.length > 0 ? dependencies : null
}

function ecosystemFromBranch(ref) {
  const match = /^dependabot\/([^/]+)\//.exec(ref)
  return match ? match[1] : null
}

function decidePolicy({ ecosystem, dependencies }) {
  if (ecosystem === 'github_actions') {
    return { automerge: true, reason: 'GitHub Actions updates are always automerged' }
  }
  if (!dependencies) {
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

// Only an untouched Dependabot commit may be automerged: one commit, written by
// Dependabot, committed and signed by GitHub, and still the head of the PR.
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

function summarizeChecks({ checkRuns, combinedStatus, workflowRuns }) {
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

// Scheduled merges pause on weekends, 1 May, 17 May and 24 December to 1 January.
function isMergeWindowOpen(date) {
  const parts = Object.fromEntries(OSLO_DATE.formatToParts(date).map((part) => [part.type, part.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const monthDay = `${parts.month}-${parts.day}`
  if (monthDay === '05-01' || monthDay === '05-17') return false
  if (monthDay >= '12-24' || monthDay === '01-01') return false
  return true
}

const APPROVER_LOGIN = 'github-actions[bot]'
const COPILOT_REVIEWER = 'copilot-pull-request-reviewer[bot]'
const COPILOT_LOGINS = new Set([COPILOT_REVIEWER, 'Copilot'])
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

function dependencyFingerprint(dependencies) {
  if (!dependencies) return null
  return dependencies
    .map((dependency) => `${dependency.name}@${dependency.version}`)
    .sort()
    .join(',')
}

function isDependabotPullRequest(pull) {
  return (
    pull.user?.login === DEPENDABOT_LOGIN &&
    pull.head.ref.startsWith('dependabot/') &&
    pull.head.repo?.full_name === pull.base.repo?.full_name
  )
}

async function evaluateAndApprove({ github, context, core, now = new Date(), copilotReview = true }) {
  const { owner, repo } = context.repo
  const { data: repository } = await github.rest.repos.get({ owner, repo })
  const windowOpen = context.eventName !== 'schedule' || isMergeWindowOpen(now)
  if (!windowOpen) core.info('The merge window is closed. This run approves no pull requests.')

  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    base: repository.default_branch,
    per_page: 100,
  })
  const approved = []
  for (const pull of pulls.filter(isDependabotPullRequest)) {
    const api = { github, owner, repo, pull_number: pull.number }
    const log = (message) => core.info(`PR #${pull.number}: ${message}`)
    try {
      const result = await evaluatePullRequest({ api, core, log, pull, windowOpen, copilotReview })
      if (result) approved.push(result)
    } catch (error) {
      core.warning(`PR #${pull.number}: evaluation failed: ${error.message}`)
    }
  }
  core.setOutput('approved', JSON.stringify(approved))
  return approved
}

async function evaluatePullRequest({ api, core, log, pull, windowOpen, copilotReview }) {
  const { github, owner, repo, pull_number } = api
  const headSha = pull.head.sha
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  await dismissStaleApprovals({ api, core, reviews, headSha })

  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 })
  const headCommit = commits.find((commit) => commit.sha === headSha)
  const dependencies = headCommit ? parseUpdatedDependencies(headCommit.commit.message) : null
  const policy = decidePolicy({ ecosystem: ecosystemFromBranch(pull.head.ref), dependencies })
  if (!policy.automerge) {
    log(`needs a manual review, because ${policy.reason}`)
    if (copilotReview) await requestCopilotReview({ api, core, log, reviews, headSha, dependencies })
    return null
  }

  if (pull.draft) return skip(log, 'is a draft')
  const provenance = checkProvenance({ headSha, commits })
  if (!provenance.ok) return skip(log, provenance.reason)
  if (hasChangesRequested(reviews)) return skip(log, 'a reviewer has requested changes')

  const { data: details } = await github.rest.pulls.get({ owner, repo, pull_number })
  if (details.head.sha !== headSha) return skip(log, 'the head changed during the evaluation')
  if (details.mergeable !== true) {
    return skip(log, details.mergeable === false ? 'has a merge conflict' : 'GitHub has not computed mergeability yet')
  }

  const checks = summarizeChecks(await readChecks({ api, headSha }))
  if (checks.state !== 'success') return skip(log, checks.reason)
  if (!windowOpen) return skip(log, 'is ready, but the merge window is closed')

  const alreadyApproved = reviews.some(
    (review) => review.user?.login === APPROVER_LOGIN && review.state === 'APPROVED' && review.commit_id === headSha,
  )
  let approval = null
  if (!alreadyApproved) {
    ;({ data: approval } = await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: 'APPROVE',
      commit_id: headSha,
      body: `Approved automatically for commit ${headSha}: ${policy.reason}, ${provenance.reason}, ${checks.reason}.`,
    }))
  }

  const { data: after } = await github.rest.pulls.get({ owner, repo, pull_number })
  if (after.state !== 'open' || after.head.sha !== headSha) {
    if (approval) await dismissApproval({ api, core, reviewId: approval.id, message: 'The PR changed after approval.' })
    return skip(log, 'changed after approval')
  }
  log(`approved commit ${headSha}`)
  return { number: pull_number, headSha }
}

function skip(log, reason) {
  log(`not approved: ${reason}`)
  return null
}

// Consumers do not dismiss stale approvals, so a bot approval of an old commit
// would still count when a human merges a newer one.
async function dismissStaleApprovals({ api, core, reviews, headSha }) {
  for (const review of reviews) {
    if (review.user?.login === APPROVER_LOGIN && review.state === 'APPROVED' && review.commit_id !== headSha) {
      await dismissApproval({ api, core, reviewId: review.id, message: 'The approved commit is no longer the head.' })
    }
  }
}

async function dismissApproval({ api, core, reviewId, message }) {
  const { github, owner, repo, pull_number } = api
  try {
    await github.rest.pulls.dismissReview({ owner, repo, pull_number, review_id: reviewId, message })
  } catch (error) {
    core.warning(`PR #${pull_number}: could not dismiss approval ${reviewId}: ${error.message}`)
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

// Requests at most one Copilot review per set of dependency versions, so a
// Dependabot rebase does not start a new review.
async function requestCopilotReview({ api, core, log, reviews, headSha, dependencies }) {
  const { github, owner, repo, pull_number } = api
  try {
    const { data: requested } = await github.rest.pulls.listRequestedReviewers({ owner, repo, pull_number })
    if (requested.users.some((user) => COPILOT_LOGINS.has(user.login))) return

    const latest = reviews.filter((review) => COPILOT_LOGINS.has(review.user?.login)).at(-1)
    if (latest?.commit_id === headSha) return
    if (latest && (await reviewedSameVersions({ api, log, commitId: latest.commit_id, dependencies }))) return

    await github.rest.pulls.requestReviewers({ owner, repo, pull_number, reviewers: [COPILOT_REVIEWER] })
    log('requested a Copilot review')
  } catch (error) {
    core.warning(`PR #${pull_number}: could not request a Copilot review: ${error.message}`)
  }
}

async function reviewedSameVersions({ api, log, commitId, dependencies }) {
  const current = dependencyFingerprint(dependencies)
  if (!current) return false
  try {
    const { github, owner, repo } = api
    const { data } = await github.rest.repos.getCommit({ owner, repo, ref: commitId })
    return dependencyFingerprint(parseUpdatedDependencies(data.commit.message)) === current
  } catch (error) {
    log(`could not read the commit Copilot reviewed: ${error.message}`)
    return false
  }
}

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
      }
    }
  }`

const ENQUEUE_MUTATION = `
  mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
    enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
      mergeQueueEntry { position }
    }
  }`

// Merges only the exact commit that evaluateAndApprove approved. Errors become
// warnings without a fallback, so a failed merge leaves the PR for the next run.
async function merge({ github, context, core, approved }) {
  const { owner, repo } = context.repo
  for (const entry of approved) {
    if (!Number.isInteger(entry?.number) || !SHA.test(entry?.headSha ?? '')) {
      core.warning(`Skipped an invalid entry: ${JSON.stringify(entry)}`)
      continue
    }
    try {
      await mergePullRequest({ github, core, owner, repo, ...entry })
    } catch (error) {
      core.warning(`PR #${entry.number}: not merged: ${error.message}`)
    }
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
  if (blocker) {
    core.warning(`PR #${number}: not merged: ${blocker}`)
    return
  }

  if (pull.isMergeQueueEnabled) {
    if (pull.isInMergeQueue) {
      core.info(`PR #${number}: already in the merge queue`)
      return
    }
    await github.graphql(ENQUEUE_MUTATION, { pullRequestId: pull.id, expectedHeadOid: headSha })
    core.info(`PR #${number}: added commit ${headSha} to the merge queue`)
    return
  }
  await github.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: 'squash', sha: headSha })
  core.info(`PR #${number}: squash-merged commit ${headSha}`)
}

module.exports = {
  parseUpdatedDependencies,
  decidePolicy,
  checkProvenance,
  summarizeChecks,
  isMergeWindowOpen,
  evaluateAndApprove,
  merge,
}
