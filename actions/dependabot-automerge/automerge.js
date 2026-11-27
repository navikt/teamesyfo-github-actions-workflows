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

function ecosystemFromBranch(ref) {
  const match = /^dependabot\/([^/]+)\//.exec(ref)
  return match ? match[1] : null
}

// Repositories can change the branch template, so the branch name alone does
// not prove an Actions update. The exception also requires that the head
// commit only changes existing workflow and action files.
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/
const ACTION_FILE = /(^|\/)action\.ya?ml$/

function changesOnlyActionsFiles(files) {
  return (
    files?.length > 0 &&
    files.every(
      (file) => file.status === 'modified' && (WORKFLOW_FILE.test(file.filename) || ACTION_FILE.test(file.filename)),
    )
  )
}

// The rule for every ecosystem: automerge patch and minor updates. A major
// GitHub Actions update is an exception, and only then are the files read.
async function decidePolicy({ ecosystem, dependencies, readFiles }) {
  const byMetadata = metadataPolicy(dependencies)
  if (byMetadata.automerge || ecosystem !== 'github_actions') return byMetadata
  if (!changesOnlyActionsFiles(await readFiles())) return byMetadata
  return { automerge: true, reason: 'GitHub Actions updates are always automerged' }
}

function metadataPolicy(dependencies) {
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

// Returns why a commit is not an untouched Dependabot commit, or null.
function dependabotCommitProblem(commit) {
  if (commit.author?.login !== DEPENDABOT_LOGIN) return 'the commit author is not Dependabot'
  if (commit.committer?.login !== 'web-flow') return 'the committer is not GitHub'
  if (commit.commit?.verification?.verified !== true) return 'the commit signature is not verified'
  return null
}

// Only an untouched Dependabot commit may be automerged: one commit, written by
// Dependabot, committed and signed by GitHub, and still the head of the PR.
function checkProvenance({ headSha, commits }) {
  if (commits.length !== 1) {
    return { ok: false, reason: `the PR has ${commits.length} commits, expected 1` }
  }
  const [commit] = commits
  if (commit.sha !== headSha) return { ok: false, reason: 'the commit is not the PR head' }
  const problem = dependabotCommitProblem(commit)
  if (problem) return { ok: false, reason: problem }
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
  const windowOpen = context.eventName !== 'schedule' || isMergeWindowOpen(now)
  if (!windowOpen) core.info('The merge window is closed. This run merges no pull requests.')

  // Lists PRs on every base, so it also finds App approvals on retargeted PRs.
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })
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

async function evaluatePullRequest({ api, core, log, pull: listed, windowOpen, copilotReview }) {
  const { github, owner, repo, pull_number } = api
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  const approvals = reviews.filter(isAppApproval)
  // The list can be older than the reviews, so a PR with App approvals is read
  // again, and the rest of the evaluation uses that read.
  const pull = approvals.length > 0 ? (await github.rest.pulls.get({ owner, repo, pull_number })).data : listed
  if (!(await dismissStaleApprovals({ api, core, pull, approvals }))) {
    return skip(log, 'a stale approval could not be dismissed')
  }
  if (!targetsDefaultBranch(pull)) return skip(log, `targets ${pull.base.ref}, not the default branch`)

  const headSha = pull.head.sha
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 })
  const headCommit = commits.find((commit) => commit.sha === headSha)
  const dependencies = headCommit ? parseUpdatedDependencies(headCommit.commit.message) : null
  const manualReview = async (reason) => {
    log(`needs a manual review, because ${reason}`)
    if (copilotReview) await requestCopilotReview({ api, core, log, pull })
    return null
  }

  const provenance = checkProvenance({ headSha, commits })
  if (!provenance.ok) return manualReview(provenance.reason)
  const ecosystem = ecosystemFromBranch(pull.head.ref)
  const readFiles = () => readHeadCommitFiles({ api, headSha })
  const policy = await decidePolicy({ ecosystem, dependencies, readFiles })
  if (!policy.automerge) return manualReview(policy.reason)
  if (pull.draft) return skip(log, 'is a draft')

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

function targetsDefaultBranch(pull) {
  return pull.base.ref === pull.base.repo.default_branch
}

// Reads fresh data every time, because a pull request can change between the
// two steps.
async function checkMergeGates({ api, headSha }) {
  const { github, owner, repo, pull_number } = api
  const blocked = (reason) => ({ ok: false, reason })
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number })
  if (pull.state !== 'open') return blocked('the PR is not open')
  if (pull.draft) return blocked('the PR is a draft')
  if (!targetsDefaultBranch(pull)) return blocked('the PR does not target the default branch')
  if (pull.head.sha !== headSha) return blocked('the head commit changed')
  if (pull.mergeable !== true) {
    return blocked(pull.mergeable === false ? 'has a merge conflict' : 'GitHub has not computed mergeability yet')
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
  if (hasChangesRequested(reviews)) return blocked('a reviewer has requested changes')
  const checks = summarizeChecks(await readChecks({ api, headSha }))
  if (checks.state !== 'success') return blocked(checks.reason)
  const state = await readQueueAndRequiredChecks({ api })
  if (state.isInMergeQueue) return blocked('the PR is already in the merge queue')
  const removal = queueRemovalProblem({ headSha, timelineItems: state.timelineItems })
  if (removal) return blocked(removal)
  const required = summarizeRequiredChecks({ headSha, commit: state.commits.nodes[0]?.commit })
  if (required.state !== 'success') return blocked(required.reason)
  return { ok: true, reason: `${checks.reason} and ${required.reason}`, reviews }
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

// The Actions exception reads the files of the head commit, not of the PR, so
// the result belongs to an immutable SHA. Provenance is checked first, so that
// commit is the PR's only commit and its diff is the PR's diff. GitHub returns up to
// 300 files and pages the rest; the exception then does not apply.
async function readHeadCommitFiles({ api, headSha }) {
  const { github, owner, repo } = api
  const { data, headers } = await github.rest.repos.getCommit({ owner, repo, ref: headSha })
  if (/rel="next"/.test(headers.link ?? '')) return null
  return data.files
}

async function readQueueAndRequiredChecks({ api }) {
  const { github, owner, repo, pull_number } = api
  const { repository } = await github.graphql(QUEUE_AND_REQUIRED_CHECKS_QUERY, { owner, repo, number: pull_number })
  return repository.pullRequest
}

// Requests at most one Copilot review per dependency update, so a Dependabot
// rebase or a maintainer's fix on top of the update does not start a new
// review. A request that someone removes before Copilot reviews leaves no
// trace, so it is requested again. When it cannot compare a commit with the
// base branch, it requests nothing and tries again on the next run.
// It reads the reviews after the pending requests, so a review that Copilot
// submits between the two reads is still seen.
async function requestCopilotReview({ api, core, log, pull }) {
  const { github, owner, repo, pull_number } = api
  try {
    const { data: requested } = await github.rest.pulls.listRequestedReviewers({ owner, repo, pull_number })
    if (requested.users.some((user) => COPILOT_LOGINS.has(user.login))) return

    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 })
    const reviewedCommits = new Set(
      reviews.filter((review) => COPILOT_LOGINS.has(review.user?.login)).map((review) => review.commit_id),
    )
    if (await reviewedSameUpdate({ api, pull, reviewedCommits })) return

    await github.rest.pulls.requestReviewers({ owner, repo, pull_number, reviewers: [COPILOT_REVIEWER] })
    log('requested a Copilot review')
  } catch (error) {
    core.warning(`PR #${pull_number}: could not request a Copilot review: ${error.message}`)
  }
}

async function reviewedSameUpdate({ api, pull, reviewedCommits }) {
  if (reviewedCommits.has(pull.head.sha)) return true
  if (reviewedCommits.size === 0) return false
  const head = await commitsAddedToBase({ api, base: pull.base.ref, commitId: pull.head.sha })
  const current = head && updateIdentity(head.commits)
  if (!current) return false
  for (const commitId of reviewedCommits) {
    const reviewed = await commitsAddedToBase({ api, base: head.baseSha, commitId })
    if (reviewed && updateIdentity(reviewed.commits) === current) return true
  }
  return false
}

// Lists the commits that a commit adds to the base branch, in chronological
// order, and the base commit it compared with. A PR's commit list is not the
// ancestry of a commit when the history branches, and GitHub does not document
// its order. The head is compared with the base branch by name, so commits on
// that branch, such as earlier Dependabot squash merges, are left out. The
// reviewed commits are compared with the same base commit, even if the branch
// has moved. Returns null when GitHub no longer has the commit or lists only
// part of the history.
async function commitsAddedToBase({ api, base, commitId }) {
  const { github, owner, repo } = api
  let data
  try {
    ;({ data } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${commitId}` }))
  } catch (error) {
    if (error.status === 404) return null
    throw new Error(`could not compare commit ${commitId} with ${base}: ${error.message}`)
  }
  if (data.total_commits > data.commits.length) return null
  return { baseSha: data.base_commit.sha, commits: data.commits }
}

// A maintainer can push a fix on top of the update, so the update is what the
// commits that Dependabot wrote and GitHub signed agree on. Their versions
// identify the update, or the commit itself when its message has no metadata.
// When they disagree, for example after someone merges two updates, the update
// that the commit contains is unknown.
function updateIdentity(commits) {
  const identities = new Set(
    commits
      .filter((commit) => dependabotCommitProblem(commit) === null)
      .map((commit) => dependencyFingerprint(parseUpdatedDependencies(commit.commit.message)) ?? `commit ${commit.sha}`),
  )
  return identities.size === 1 ? [...identities][0] : null
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

// The policy depends only on the head commit and the files it changes, which
// every write binds to. The list of commits also depends on the base branch, so
// provenance is checked again here.
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
  if (pull.isInMergeQueue) {
    core.info(`PR #${number}: already in the merge queue`)
    return
  }
  // Someone can add the PR to the queue, and GitHub remove it, while this run approves.
  // This read and the addition below are separate requests, and GitHub can make the
  // addition depend only on the head commit, so a short window remains.
  const removal = queueRemovalProblem({ headSha, timelineItems: pull.timelineItems })
  if (removal) throw new Error(removal)

  if (pull.isMergeQueueEnabled) {
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
