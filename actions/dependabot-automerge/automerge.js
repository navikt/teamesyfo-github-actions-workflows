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

function unquote(value) {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2] : trimmed
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
    if (field) dependencies[dependencies.length - 1][field] = unquote(value)
  }
  if (dependencies.length === 0 || dependencies.some((dependency) => !dependency.name || !dependency.version)) {
    return null
  }
  return dependencies
}

function ecosystemFromBranch(ref) {
  const match = /^dependabot\/([^/]+)\//.exec(ref)
  return match ? match[1] : null
}

function decidePolicy({ ecosystem, dependencies }) {
  if (ecosystem === 'github_actions') {
    return { automerge: true, reason: 'GitHub Actions updates are always automerged' }
  }
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

// The teamesyfo-automerge App approves and merges. GITHUB_TOKEN only reads,
// requests Copilot reviews and dismisses approvals.
const APPROVER_LOGIN = 'teamesyfo-automerge[bot]'
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

function isAppApproval(review) {
  return review.user?.login === APPROVER_LOGIN && review.state === 'APPROVED'
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

// Runs with GITHUB_TOKEN and never approves. The output lists each pull request
// that is ready to merge, bound to the head commit that passed every gate.
async function findMergeCandidates({ github, context, core, now = new Date(), copilotReview = true }) {
  const { owner, repo } = context.repo
  const { data: repository } = await github.rest.repos.get({ owner, repo })
  const windowOpen = context.eventName !== 'schedule' || isMergeWindowOpen(now)
  if (!windowOpen) core.info('The merge window is closed. This run merges no pull requests.')

  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    base: repository.default_branch,
    per_page: 100,
  })
  const candidates = []
  for (const pull of pulls.filter(isDependabotPullRequest)) {
    const api = { github, owner, repo, pull_number: pull.number }
    const log = (message) => core.info(`PR #${pull.number}: ${message}`)
    try {
      const candidate = await evaluatePullRequest({ api, core, log, pull, windowOpen, copilotReview })
      if (candidate) candidates.push(candidate)
    } catch (error) {
      core.warning(`PR #${pull.number}: evaluation failed: ${error.message}`)
    }
  }
  core.setOutput('candidates', JSON.stringify(candidates))
  return candidates
}

async function evaluatePullRequest({ api, core, log, pull, windowOpen, copilotReview }) {
  const { github, owner, repo, pull_number } = api
  const headSha = pull.head.sha
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  if (!(await dismissStaleApprovals({ api, core, reviews, headSha }))) {
    return skip(log, 'a stale approval could not be dismissed')
  }

  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 })
  const headCommit = commits.find((commit) => commit.sha === headSha)
  const dependencies = headCommit ? parseUpdatedDependencies(headCommit.commit.message) : null
  const manualReview = async (reason) => {
    log(`needs a manual review, because ${reason}`)
    if (copilotReview) await requestCopilotReview({ api, core, log, reviews, headSha, dependencies })
    return null
  }

  const policy = decidePolicy({ ecosystem: ecosystemFromBranch(pull.head.ref), dependencies })
  if (!policy.automerge) return manualReview(policy.reason)
  if (pull.draft) return skip(log, 'is a draft')
  const provenance = checkProvenance({ headSha, commits })
  if (!provenance.ok) return manualReview(provenance.reason)

  const gates = await checkMergeGates({ api, headSha })
  if (!gates.ok) return skip(log, gates.reason)
  if (!windowOpen) return skip(log, 'the merge window is closed')
  log(`ready to merge commit ${headSha}`)
  return { number: pull_number, headSha }
}

function skip(log, reason) {
  log(`not ready: ${reason}`)
  return null
}

// Reads fresh data every time, because a pull request can change between the
// two steps.
async function checkMergeGates({ api, headSha }) {
  const { github, owner, repo, pull_number } = api
  const blocked = (reason) => ({ ok: false, reason })
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number })
  if (pull.state !== 'open') return blocked('the PR is not open')
  if (pull.draft) return blocked('the PR is a draft')
  if (pull.base.ref !== pull.base.repo.default_branch) return blocked('the PR does not target the default branch')
  if (pull.head.sha !== headSha) return blocked('the head commit changed')
  if (pull.mergeable !== true) {
    return blocked(pull.mergeable === false ? 'has a merge conflict' : 'GitHub has not computed mergeability yet')
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  if (hasChangesRequested(reviews)) return blocked('a reviewer has requested changes')
  const checks = summarizeChecks(await readChecks({ api, headSha }))
  if (checks.state !== 'success') return blocked(checks.reason)
  const required = summarizeRequiredChecks({ headSha, commit: await readRequiredChecks({ api }) })
  if (required.state !== 'success') return blocked(required.reason)
  return { ok: true, reason: `${checks.reason} and ${required.reason}`, reviews }
}

// Consumers do not dismiss stale approvals, so an App approval of an old commit
// would still count when a human merges a newer one. Returns false when an
// approval remains.
async function dismissStaleApprovals({ api, core, reviews, headSha }) {
  let dismissedAll = true
  for (const review of reviews.filter((review) => isAppApproval(review) && review.commit_id !== headSha)) {
    const message = 'The approved commit is no longer the head.'
    if (!(await dismissApproval({ api, core, reviewId: review.id, message }))) dismissedAll = false
  }
  return dismissedAll
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

async function readRequiredChecks({ api }) {
  const { github, owner, repo, pull_number } = api
  const { repository } = await github.graphql(REQUIRED_CHECKS_QUERY, { owner, repo, number: pull_number })
  return repository.pullRequest.commits.nodes[0]?.commit
}

// Requests at most one Copilot review per set of dependency versions, so a
// Dependabot rebase does not start a new review. When it cannot read a commit
// that Copilot reviewed, it requests nothing and tries again on the next run.
async function requestCopilotReview({ api, core, log, reviews, headSha, dependencies }) {
  const { github, owner, repo, pull_number } = api
  try {
    const { data: requested } = await github.rest.pulls.listRequestedReviewers({ owner, repo, pull_number })
    if (requested.users.some((user) => COPILOT_LOGINS.has(user.login))) return

    const reviewedCommits = new Set(
      reviews.filter((review) => COPILOT_LOGINS.has(review.user?.login)).map((review) => review.commit_id),
    )
    if (reviewedCommits.has(headSha)) return
    for (const commitId of reviewedCommits) {
      if (await reviewedSameVersions({ api, commitId, dependencies })) return
    }

    await github.rest.pulls.requestReviewers({ owner, repo, pull_number, reviewers: [COPILOT_REVIEWER] })
    log('requested a Copilot review')
  } catch (error) {
    core.warning(`PR #${pull_number}: could not request a Copilot review: ${error.message}`)
  }
}

async function reviewedSameVersions({ api, commitId, dependencies }) {
  const current = dependencyFingerprint(dependencies)
  if (!current) return false
  const { github, owner, repo } = api
  let reviewed
  try {
    ;({ data: reviewed } = await github.rest.repos.getCommit({ owner, repo, ref: commitId }))
  } catch (error) {
    throw new Error(`could not read commit ${commitId}, which Copilot reviewed: ${error.message}`)
  }
  return dependencyFingerprint(parseUpdatedDependencies(reviewed.commit.message)) === current
}

const REQUIRED_CHECKS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
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
async function approveAndMerge({ github, appGithub, appSlug, context, core, candidates }) {
  if (`${appSlug}[bot]` !== APPROVER_LOGIN) {
    core.setFailed(`The App token belongs to "${appSlug}", but the workflow expects ${APPROVER_LOGIN}.`)
    return
  }
  if (!Array.isArray(candidates)) {
    core.setFailed('The list of pull requests to merge is not an array.')
    return
  }
  const { owner, repo } = context.repo
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate?.number) || !SHA.test(candidate?.headSha ?? '')) {
      core.warning(`Skipped an invalid candidate: ${JSON.stringify(candidate)}`)
      continue
    }
    const api = { github, owner, repo, pull_number: candidate.number }
    try {
      await approveAndMergePullRequest({ api, appGithub, core, headSha: candidate.headSha })
    } catch (error) {
      core.warning(`PR #${candidate.number}: not merged: ${error.message}`)
    }
  }
}

// The policy depends only on the head commit, which every write binds to. The
// list of commits also depends on the base branch, so provenance is checked
// again here.
async function approveAndMergePullRequest({ api, appGithub, core, headSha }) {
  const { github, owner, repo, pull_number } = api
  const gates = await checkMergeGates({ api, headSha })
  if (!gates.ok) throw new Error(gates.reason)
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 })
  const provenance = checkProvenance({ headSha, commits })
  if (!provenance.ok) throw new Error(provenance.reason)

  let approval = null
  if (!gates.reviews.some((review) => isAppApproval(review) && review.commit_id === headSha)) {
    ;({ data: approval } = await appGithub.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: 'APPROVE',
      commit_id: headSha,
      body: `Approved automatically for commit ${headSha}: an untouched Dependabot update that the policy allows, ${gates.reason}.`,
    }))
    core.info(`PR #${pull_number}: approved commit ${headSha}`)
  }

  try {
    await mergePullRequest({ github: appGithub, core, owner, repo, number: pull_number, headSha })
  } catch (error) {
    if (approval) await dismissApproval({ api, core, reviewId: approval.id, message: 'The merge failed after approval.' })
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
  summarizeRequiredChecks,
  isMergeWindowOpen,
  findMergeCandidates,
  approveAndMerge,
}
