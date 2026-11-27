'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseUpdatedDependencies,
  classifyUpdate,
  checkProvenance,
  summarizeChecks,
  summarizeRequiredChecks,
  isMergeWindowOpen,
} = require('./automerge')

const HEAD = 'a'.repeat(40)

function dependabotMessage(...entries) {
  const yaml = entries
    .map((entry) =>
      [
        `- dependency-name: ${entry.name}`,
        `  dependency-version: ${entry.version}`,
        '  dependency-type: direct:production',
        entry.updateType ? `  update-type: ${entry.updateType}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n')
  return [
    'chore(deps): bump things',
    '',
    'Bumps things.',
    '---',
    'updated-dependencies:',
    yaml,
    '...',
    '',
    'Signed-off-by: dependabot[bot] <support@github.com>',
  ].join('\n')
}

const PATCH = 'version-update:semver-patch'
const MINOR = 'version-update:semver-minor'
const MAJOR = 'version-update:semver-major'

describe('parseUpdatedDependencies', () => {
  it('reads every dependency in a grouped update and strips quotes', () => {
    const message = dependabotMessage(
      { name: '"@navikt/ds-css"', version: '8.22.1', updateType: MINOR },
      { name: 'jsdom', version: '31.0.0', updateType: MAJOR },
    )
    assert.deepEqual(parseUpdatedDependencies(message), [
      { name: '@navikt/ds-css', version: '8.22.1', updateType: MINOR },
      { name: 'jsdom', version: '31.0.0', updateType: MAJOR },
    ])
  })

  it('uses the last metadata block when the body quotes an earlier one', () => {
    const quoted = dependabotMessage({ name: 'quoted', version: '1.0.0', updateType: PATCH })
    const real = dependabotMessage({ name: 'real', version: '2.0.0', updateType: MAJOR })
    assert.deepEqual(parseUpdatedDependencies(`${quoted}\n${real}`), [
      { name: 'real', version: '2.0.0', updateType: MAJOR },
    ])
  })

  it('returns null without a metadata block', () => {
    assert.equal(parseUpdatedDependencies('chore: bump\n\nNo metadata here.'), null)
  })

  const malformed = [
    ['a line it does not recognise', '- dependency-name: a\n  update-type: version-update:semver-patch\n    nested: value'],
    ['an entry without a name', '- dependency-name: a\n- update-type: version-update:semver-patch'],
    ['an entry without a version', '- dependency-name: a\n  update-type: version-update:semver-patch'],
    ['a blank quoted name', '- dependency-name: "  "\n  dependency-version: 1.0.0\n  update-type: version-update:semver-patch'],
    ['a null version', '- dependency-name: a\n  dependency-version: null\n  update-type: version-update:semver-patch'],
    ['a tilde name', '- dependency-name: ~\n  dependency-version: 1.0.0\n  update-type: version-update:semver-patch'],
    ['a field before the first entry', '  update-type: version-update:semver-patch\n- dependency-name: a\n  dependency-version: 1.0.0'],
    [
      'an entry with two update types',
      '- dependency-name: a\n  dependency-version: 2.0.0\n  update-type: version-update:semver-major\n  update-type: version-update:semver-patch',
    ],
  ]
  for (const [name, block] of malformed) {
    it(`returns null for a block with ${name}`, () => {
      assert.equal(parseUpdatedDependencies(`chore: bump\n---\nupdated-dependencies:\n${block}\n...\n`), null)
    })
  }
})

describe('classifyUpdate', () => {
  const cases = [
    ['patch and minor updates', [{ updateType: PATCH }, { updateType: MINOR }], true],
    ['a group with one major update', [{ updateType: PATCH }, { updateType: MAJOR }], false],
    ['an update without update type', [{ updateType: undefined }], false],
    ['an update without metadata', null, false],
    ['an empty list', [], false],
  ]
  for (const [name, dependencies, expected] of cases) {
    it(`${name} -> automerge ${expected}`, () => {
      assert.equal(classifyUpdate(dependencies).automerge, expected)
    })
  }
})

describe('checkProvenance', () => {
  const dependabotCommit = {
    sha: HEAD,
    author: { login: 'dependabot[bot]' },
    committer: { login: 'web-flow' },
    commit: { verification: { verified: true } },
  }
  const cases = [
    ['one verified Dependabot commit', [dependabotCommit], true],
    ['an extra commit', [dependabotCommit, { ...dependabotCommit, sha: 'b'.repeat(40) }], false],
    ['an unverified commit', [{ ...dependabotCommit, commit: { verification: { verified: false } } }], false],
    ['another author', [{ ...dependabotCommit, author: { login: 'someone' } }], false],
    ['another committer', [{ ...dependabotCommit, committer: { login: 'someone' } }], false],
    ['a commit that is not the head', [{ ...dependabotCommit, sha: 'c'.repeat(40) }], false],
  ]
  for (const [name, commits, expected] of cases) {
    it(`${name} -> ok ${expected}`, () => {
      assert.equal(checkProvenance({ headSha: HEAD, commits }).ok, expected)
    })
  }
})

describe('summarizeChecks', () => {
  const run = (status, conclusion) => ({ name: 'ci', status, conclusion })
  const workflowRun = (runNumber, conclusion, { event = 'pull_request', branch = 'dependabot/npm/a' } = {}) => ({
    name: 'ci',
    workflow_id: 7,
    run_number: runNumber,
    event,
    head_branch: branch,
    status: 'completed',
    conclusion,
  })
  const noStatus = { state: 'pending', total_count: 0 }
  const cases = [
    ['all checks green', [run('completed', 'success'), run('completed', 'skipped')], noStatus, [], 'success'],
    ['a check still running', [run('completed', 'success'), run('in_progress', null)], noStatus, [], 'pending'],
    ['a failed check', [run('completed', 'success'), run('completed', 'failure')], noStatus, [], 'blocked'],
    ['only neutral checks', [run('completed', 'neutral')], noStatus, [], 'blocked'],
    ['a pending commit status', [run('completed', 'success')], { state: 'pending', total_count: 1 }, [], 'pending'],
    ['a failed commit status', [run('completed', 'success')], { state: 'failure', total_count: 1 }, [], 'blocked'],
    ['a queued workflow run', [run('completed', 'success')], noStatus, [{ status: 'queued' }], 'pending'],
    [
      'a workflow that failed to start',
      [run('completed', 'success')],
      noStatus,
      [{ name: 'ci', status: 'completed', conclusion: 'startup_failure' }],
      'blocked',
    ],
    [
      'a cancelled workflow run that a newer run of the same workflow, event and branch replaced',
      [run('completed', 'success')],
      noStatus,
      [workflowRun(2, 'success'), workflowRun(1, 'cancelled')],
      'success',
    ],
    [
      'a newer failed workflow run after a successful one',
      [run('completed', 'success')],
      noStatus,
      [workflowRun(1, 'success'), workflowRun(2, 'failure')],
      'blocked',
    ],
    [
      'a workflow run that failed to start before a newer successful run',
      [run('completed', 'success')],
      noStatus,
      [workflowRun(1, 'startup_failure'), workflowRun(2, 'success')],
      'blocked',
    ],
    [
      'a cancelled workflow run after an older successful run',
      [run('completed', 'success')],
      noStatus,
      [workflowRun(1, 'success'), workflowRun(2, 'cancelled')],
      'blocked',
    ],
    [
      'a cancelled workflow run and a newer run for another event',
      [run('completed', 'success')],
      noStatus,
      [workflowRun(2, 'success', { event: 'push' }), workflowRun(1, 'cancelled')],
      'blocked',
    ],
    [
      'a cancelled workflow run and a newer run on another branch',
      [run('completed', 'success')],
      noStatus,
      [workflowRun(2, 'success', { branch: 'main' }), workflowRun(1, 'cancelled')],
      'blocked',
    ],
  ]
  for (const [name, checkRuns, combinedStatus, workflowRuns, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      assert.equal(summarizeChecks({ checkRuns, combinedStatus, workflowRuns }).state, expected)
    })
  }
})

describe('summarizeRequiredChecks', () => {
  const checkRun = (status, conclusion, isRequired = true) => ({
    __typename: 'CheckRun',
    name: 'Merge gate',
    status,
    conclusion,
    isRequired,
  })
  const status = (state) => ({ __typename: 'StatusContext', context: 'ci', state, isRequired: true })
  const commit = (nodes, { oid = HEAD, hasNextPage = false } = {}) => ({
    oid,
    statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes } },
  })
  const cases = [
    ['a passed required check', commit([checkRun('COMPLETED', 'SUCCESS'), checkRun('COMPLETED', 'FAILURE', false)]), 'success'],
    ['skipped and neutral required checks', commit([checkRun('COMPLETED', 'SKIPPED'), checkRun('COMPLETED', 'NEUTRAL')]), 'success'],
    ['a passed required commit status', commit([status('SUCCESS')]), 'success'],
    ['no required check', commit([checkRun('COMPLETED', 'SUCCESS', false)]), 'blocked'],
    ['no checks at all', { oid: HEAD, statusCheckRollup: null }, 'blocked'],
    ['a running required check', commit([checkRun('IN_PROGRESS', null)]), 'blocked'],
    ['a failed required check', commit([checkRun('COMPLETED', 'SUCCESS'), checkRun('COMPLETED', 'FAILURE')]), 'blocked'],
    ['a pending required commit status', commit([status('PENDING')]), 'blocked'],
    ['more checks than one page', commit([checkRun('COMPLETED', 'SUCCESS')], { hasNextPage: true }), 'blocked'],
    ['checks for another commit', commit([checkRun('COMPLETED', 'SUCCESS')], { oid: 'b'.repeat(40) }), 'blocked'],
  ]
  for (const [name, headCommit, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      assert.equal(summarizeRequiredChecks({ headSha: HEAD, commit: headCommit }).state, expected)
    })
  }
})

describe('isMergeWindowOpen', () => {
  const cases = [
    ['an ordinary Tuesday', '2026-11-24T09:00:00Z', true],
    ['a Saturday', '2026-11-28T09:00:00Z', false],
    ['1 May on a Friday', '2026-05-01T09:00:00Z', false],
    ['17 May on a Monday', '2027-05-17T09:00:00Z', false],
    ['00:30 on 18 May in Oslo, still 17 May in UTC', '2027-05-17T22:30:00Z', true],
    ['23 December', '2026-12-23T09:00:00Z', true],
    ['24 December', '2026-12-24T09:00:00Z', false],
    ['1 January on a Friday', '2027-01-01T09:00:00Z', false],
    ['00:30 on 2 January in Oslo, still 1 January in UTC', '2026-01-01T23:30:00Z', true],
  ]
  for (const [name, iso, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      assert.equal(isMergeWindowOpen(new Date(iso)), expected)
    })
  }
})

const { findMergeCandidates, approveAndMerge } = require('./automerge')

const APP = 'teamesyfo-automerge[bot]'
const ACTIONS = 'github-actions[bot]'
const TUESDAY = new Date('2026-11-24T09:00:00Z')
const SATURDAY = new Date('2026-11-28T09:00:00Z')

function dependabotPr(overrides = {}) {
  const sha = overrides.sha ?? HEAD
  const head = overrides.head ?? { sha, ref: 'dependabot/npm_and_yarn/left-pad-1.0.1', repo: { full_name: 'navikt/app' } }
  const updateType = overrides.updateType ?? PATCH
  const message = overrides.message ?? dependabotMessage({ name: 'left-pad', version: '1.0.1', updateType })
  return {
    number: 1,
    node_id: 'PR_1',
    draft: false,
    state: 'open',
    mergeable: true,
    user: { login: 'dependabot[bot]' },
    head,
    activities: [
      { ref: `refs/heads/${head.ref}`, after: head.sha, activity_type: 'branch_creation', actor: { login: 'dependabot[bot]' } },
    ],
    base: { ref: 'main', repo: { full_name: 'navikt/app', default_branch: 'main' } },
    commits: [
      {
        sha,
        author: { login: 'dependabot[bot]' },
        committer: { login: 'web-flow' },
        commit: { message, verification: { verified: true } },
      },
    ],
    reviews: [],
    requested_reviewers: [],
    checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
    combinedStatus: { state: 'pending', total_count: 0 },
    workflowRuns: [],
    rollupContexts: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true },
    ],
    isInMergeQueue: false,
    isMergeQueueEnabled: true,
    queueEvents: [],
    moreQueueEvents: false,
    ...overrides,
  }
}

const added = { __typename: 'AddedToMergeQueueEvent' }
const removed = { __typename: 'RemovedFromMergeQueueEvent' }
const forcePush = (before, after) => ({
  __typename: 'HeadRefForcePushedEvent',
  beforeCommit: before && { oid: before },
  afterCommit: after && { oid: after },
})

// A small in-memory GitHub that records every write and who made it. Each
// client acts as one identity, so tests can tell GITHUB_TOKEN from the App.
function fakeGitHub({
  pulls,
  onApprove,
  failMergeQueueLookup = false,
  failEnqueue = false,
  failDismissal = false,
  failReviewRequest = false,
}) {
  const byNumber = new Map(pulls.map((pr) => [pr.number, pr]))
  const pr = (number) => byNumber.get(number)
  const noChecks = { checkRuns: [], combinedStatus: { state: 'pending', total_count: 0 }, workflowRuns: [] }
  const byHead = (sha) => pulls.find((p) => p.head.sha === sha) ?? noChecks
  const writes = { approvals: [], dismissals: [], enqueues: [], reviewRequests: [] }
  const activityReads = []
  let reviewId = 100

  const client = (login) => ({
    paginate: async (method, params) => {
      const { data } = await method(params)
      return Array.isArray(data) ? data : (data.check_runs ?? data.workflow_runs)
    },
    graphql: async (query, variables) => {
      if (query.includes('enqueuePullRequest')) {
        if (failEnqueue) throw new Error('The pull request cannot enter the merge queue')
        writes.enqueues.push({ by: login, ...variables })
        return { enqueuePullRequest: { mergeQueueEntry: { position: 1 } } }
      }
      const p = pr(variables.number)
      const timelineItems = {
        pageInfo: { hasPreviousPage: p.moreQueueEvents },
        nodes: p.queueEvents.slice(-100),
      }
      if (query.includes('statusCheckRollup')) {
        const contexts = { pageInfo: { hasNextPage: false }, nodes: p.rollupContexts }
        const commit = { oid: p.head.sha, statusCheckRollup: { contexts } }
        return {
          repository: {
            pullRequest: {
              isInMergeQueue: p.isInMergeQueue,
              isMergeQueueEnabled: p.isMergeQueueEnabled,
              timelineItems,
              commits: { nodes: [{ commit }] },
            },
          },
        }
      }
      if (failMergeQueueLookup) throw new Error('GraphQL is unavailable')
      return {
        repository: {
          pullRequest: {
            id: p.node_id,
            state: p.state.toUpperCase(),
            isDraft: p.draft,
            headRefOid: p.head.sha,
            baseRefName: p.base.ref,
            isInMergeQueue: p.isInMergeQueue,
            isMergeQueueEnabled: p.isMergeQueueEnabled,
            timelineItems,
          },
          defaultBranchRef: { name: 'main' },
        },
      }
    },
    rest: {
      repos: {
        listActivities: async (params) => {
          activityReads.push({ by: login, ...params })
          const pull = pulls.find((item) => params.ref === `refs/heads/${item.head.ref}`)
          if (!pull) return { data: [] }
          if (pull.activities instanceof Error) throw pull.activities
          return { data: pull.activities.slice(0, params.per_page) }
        },
        getCombinedStatusForRef: async ({ ref }) => ({ data: byHead(ref).combinedStatus }),
      },
      checks: {
        listForRef: async ({ ref }) => ({
          data: { total_count: byHead(ref).checkRuns.length, check_runs: byHead(ref).checkRuns },
        }),
      },
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha }) => ({ data: { workflow_runs: byHead(head_sha).workflowRuns } }),
      },
      pulls: {
        // listedAs holds fields that were out of date when the PR was listed.
        list: async ({ base }) => ({
          data: pulls
            .filter((p) => p.state === 'open')
            .map((p) => (p.listedAs ? { ...p, ...p.listedAs } : p))
            .filter((p) => !base || p.base.ref === base),
        }),
        get: async ({ pull_number }) => ({ data: pr(pull_number) }),
        listCommits: async ({ pull_number }) => ({ data: pr(pull_number).commits }),
        listReviews: async ({ pull_number }) => ({ data: [...pr(pull_number).reviews] }),
        createReview: async ({ pull_number, event, commit_id }) => {
          writes.approvals.push({ by: login, number: pull_number, event, commit_id })
          const review = { id: reviewId++, user: { login }, state: 'APPROVED', commit_id }
          pr(pull_number).reviews.push(review)
          onApprove?.(pr(pull_number))
          return { data: review }
        },
        dismissReview: async ({ pull_number, review_id }) => {
          if (failDismissal === true || failDismissal === review_id) {
            throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
          }
          writes.dismissals.push({ by: login, number: pull_number, review_id })
          pr(pull_number).reviews.find((r) => r.id === review_id).state = 'DISMISSED'
          return { data: {} }
        },
        requestReviewers: async ({ pull_number, reviewers }) => {
          if (failReviewRequest === pull_number) {
            throw Object.assign(new Error('Reviews may only be requested from collaborators'), { status: 422 })
          }
          writes.reviewRequests.push({ by: login, number: pull_number, reviewers })
          return { data: {} }
        },
      },
    },
  })

  return { writes, activityReads, actions: client(ACTIONS), app: client(APP) }
}

function fakeCore() {
  const core = { outputs: {}, warnings: [], logs: [], failures: [] }
  core.info = (message) => core.logs.push(message)
  core.warning = (message) => core.warnings.push(message)
  core.setFailed = (message) => core.failures.push(message)
  core.setOutput = (name, value) => {
    core.outputs[name] = value
  }
  return core
}

const scheduled = { repo: { owner: 'navikt', repo: 'app' }, eventName: 'schedule' }

async function find(pulls, { now = TUESDAY, context = scheduled, ...options } = {}) {
  const fake = fakeGitHub({ pulls, ...options })
  const core = fakeCore()
  await findMergeCandidates({ github: fake.actions, context, core, now })
  return { writes: fake.writes, core, candidates: JSON.parse(core.outputs.candidates) }
}

describe('findMergeCandidates', () => {
  it('selects an eligible update with its head commit, without approving it', async () => {
    const { writes, candidates } = await find([dependabotPr()])
    assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
    assert.deepEqual(writes.approvals, [])
  })

  for (const type of ['push', 'force_push']) {
    it(`selects a head updated by a Dependabot ${type}`, async () => {
      const pull = dependabotPr()
      pull.activities[0].activity_type = type
      const { candidates } = await find([pull])
      assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
    })
  }

  const [creation] = dependabotPr().activities
  const invalidActivities = [
    ['a newer push by another actor', [{ ...creation, activity_type: 'push', actor: { login: 'maintainer' } }, creation]],
    ['an unknown actor', [{ ...creation, actor: null }]],
    ['an update to a different commit', [{ ...creation, after: 'b'.repeat(40) }]],
    ['an update to a different ref', [{ ...creation, ref: 'refs/heads/main' }]],
    ['a branch deletion', [{ ...creation, activity_type: 'branch_deletion' }]],
    ['a merge on the branch', [{ ...creation, activity_type: 'pr_merge' }]],
    ['an unknown activity type', [{ ...creation, activity_type: 'other' }]],
    ['no activity', []],
    ['an unavailable activity log', new Error('Activity unavailable')],
  ]
  for (const [name, activities] of invalidActivities) {
    it(`does not select a PR with ${name}`, async () => {
      const { candidates } = await find([dependabotPr({ activities })])
      assert.deepEqual(candidates, [])
    })
  }

  const extraCommit = { ...dependabotPr().commits[0], sha: 'b'.repeat(40) }
  const actionsBranch = { ...dependabotPr().head, ref: 'dependabot/github_actions/actions/checkout-6.0.0' }
  const notSelected = [
    ['a semver-major update', { updateType: MAJOR }],
    ['a semver-major GitHub Actions update', { updateType: MAJOR, head: actionsBranch }],
    ['a draft', { draft: true }],
    ['an extra commit', { commits: [...dependabotPr().commits, extraCommit] }],
    ['a PR from a fork', { head: { ...dependabotPr().head, repo: { full_name: 'someone/app' } } }],
    ['a PR opened by someone else', { user: { login: 'someone' } }],
    ['a merge conflict', { mergeable: false }],
    ['a PR whose mergeability GitHub has not computed', { mergeable: null }],
    ['a PR that is already in the merge queue', { isInMergeQueue: true }],
    ['a PR whose default branch has no merge queue', { isMergeQueueEnabled: false }],
    ['a failed check', { checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure' }] }],
    ['a PR without a required check', { rollupContexts: [{ ...dependabotPr().rollupContexts[0], isRequired: false }] }],
    ['a requested change', { reviews: [{ id: 1, user: { login: 'someone' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }] }],
  ]
  for (const [name, overrides] of notSelected) {
    it(`does not select ${name}`, async () => {
      const { core, candidates } = await find([dependabotPr(overrides)])
      assert.deepEqual(candidates, [])
      assert.deepEqual(core.warnings, [])
    })
  }

  it('does not select a PR on a scheduled run outside the merge window', async () => {
    const { candidates } = await find([dependabotPr()], { now: SATURDAY })
    assert.deepEqual(candidates, [])
  })

  it('selects a PR on a manual run outside the merge window', async () => {
    const context = { ...scheduled, eventName: 'workflow_dispatch' }
    const { candidates } = await find([dependabotPr()], { now: SATURDAY, context })
    assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
  })

  const other = 'c'.repeat(40)
  const moved = 'd'.repeat(40)
  const wasRemoved = 'removed from the merge queue'
  const unknown = 'does not tell which commit was added'
  const queueHistories = [
    ['left the merge queue at its head', [forcePush(other, HEAD), added, removed], wasRemoved],
    ['entered the merge queue before any force push', [added, removed], wasRemoved],
    ['left the merge queue without an addition in the timeline', [removed], wasRemoved],
    ['brought a removed head back by force push', [added, removed, forcePush(HEAD, other), forcePush(other, HEAD)], wasRemoved],
    ['was still in the merge queue when its head was force-pushed', [forcePush(other, moved), added, forcePush(moved, HEAD)], wasRemoved],
    ['entered the merge queue at a head GitHub does not name', [added, removed, forcePush(null, HEAD)], unknown],
    ['entered the merge queue after a force push to a head GitHub does not name', [forcePush(other, null), added, removed, forcePush(moved, HEAD)], unknown],
    [
      'moved its head without force after it entered the merge queue',
      [forcePush(other, moved), added, removed, forcePush(HEAD, other), forcePush(other, HEAD)],
      unknown,
    ],
    ['moved its head without force after it last entered the merge queue', [forcePush(other, moved), added, removed], unknown],
    ['has a new head after it left the merge queue', [added, removed, forcePush(other, HEAD)], null],
    ['has a new head after an old head entered the merge queue twice', [forcePush(other, moved), added, removed, added, removed, forcePush(moved, HEAD)], null],
  ]
  for (const [name, queueEvents, reason] of queueHistories) {
    const outcome = reason ? `does not select it because it was ${reason === unknown ? 'unknown' : 'removed'}` : 'selects it'
    it(`${outcome} when a PR ${name}`, async () => {
      const { core, candidates } = await find([dependabotPr({ queueEvents })])
      if (!reason) return assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
      assert.deepEqual(candidates, [])
      assert.ok(core.logs.some((log) => log.includes(reason)), core.logs.join('\n'))
    })
  }

  it('does not select a PR with more merge queue events than one page', async () => {
    const { core, candidates } = await find([dependabotPr({ queueEvents: [forcePush(other, HEAD)], moreQueueEvents: true })])
    assert.deepEqual(candidates, [])
    assert.ok(core.logs.some((log) => log.includes('more than 100 merge queue')))
  })

  it('skips a PR that was listed on the default branch but now targets another', async () => {
    const approval = { id: 5, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }
    const release = { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } }
    const main = dependabotPr().base
    const pull = dependabotPr({ updateType: MAJOR, base: release, reviews: [approval], listedAs: { base: main } })
    const { writes, candidates } = await find([pull])
    assert.deepEqual(candidates, [])
    assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 5 }])
  })

  it('dismisses every App approval on a PR that no longer targets the default branch, and skips it', async () => {
    const approval = (id) => ({ id, user: { login: APP }, state: 'APPROVED', commit_id: HEAD })
    const human = { id: 6, user: { login: 'someone' }, state: 'APPROVED', commit_id: HEAD }
    const base = { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } }
    const reviews = [approval(5), human, approval(8)]
    const { writes, candidates } = await find([dependabotPr({ updateType: MAJOR, base, reviews })])
    assert.deepEqual(candidates, [])
    assert.deepEqual(writes.dismissals, [
      { by: ACTIONS, number: 1, review_id: 5 },
      { by: ACTIONS, number: 1, review_id: 8 },
    ])
  })

  it('keeps an App approval when the PR targets the default branch again after it was listed', async () => {
    const approval = { id: 5, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }
    const release = { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } }
    const { writes } = await find([dependabotPr({ reviews: [approval], listedAs: { base: release } })])
    assert.deepEqual(writes.dismissals, [])
  })

  const staleApproval = { id: 7, user: { login: APP }, state: 'APPROVED', commit_id: 'e'.repeat(40) }

  it('dismisses an earlier App approval of a commit that is no longer the head', async () => {
    const { writes } = await find([dependabotPr({ updateType: MAJOR, reviews: [{ ...staleApproval }] })])
    assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 7 }])
  })

  it('does not select a PR when it cannot dismiss a stale App approval', async () => {
    const { core, candidates } = await find([dependabotPr({ reviews: [{ ...staleApproval }] })], {
      failDismissal: true,
    })
    assert.deepEqual(candidates, [])
    assert.equal(core.warnings.length, 1)
  })
})

describe('approveAndMerge', () => {
  const candidate = [{ number: 1, headSha: HEAD }]

  async function run(pulls, candidates, { appSlug = 'teamesyfo-automerge', context = scheduled, getTime = () => TUESDAY, ...options } = {}) {
    const fake = fakeGitHub({ pulls, ...options })
    const core = fakeCore()
    await approveAndMerge({ github: fake.actions, appGithub: fake.app, appSlug, context, core, candidates, getTime })
    return { writes: fake.writes, core }
  }

  it('approves the head commit as the App and adds it to the merge queue', async () => {
    const { writes, core } = await run([dependabotPr()], candidate)
    assert.deepEqual(writes.approvals, [{ by: APP, number: 1, event: 'APPROVE', commit_id: HEAD }])
    assert.deepEqual(writes.enqueues, [{ by: APP, pullRequestId: 'PR_1', expectedHeadOid: HEAD }])
    assert.ok(core.logs.includes(`PR #1: requesting merge queue entry for commit ${HEAD} as ${APP}`))
  })

  it('does not approve again when the App has already approved the head commit', async () => {
    const approval = { id: 5, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }
    const { writes } = await run([dependabotPr({ reviews: [approval] })], candidate)
    assert.deepEqual(writes.approvals, [])
    assert.equal(writes.enqueues.length, 1)
  })

  it('dismisses all existing App approvals of the current head when GitHub refuses the queue entry', async () => {
    const approval = (id, login) => ({ id, user: { login }, state: 'APPROVED', commit_id: HEAD })
    const humanApproval = approval(6, 'maintainer')
    const pull = dependabotPr({ reviews: [approval(5, APP), humanApproval, approval(7, APP)] })
    const { writes, core } = await run([pull], candidate, { failEnqueue: true })
    assert.deepEqual(writes.approvals, [])
    assert.deepEqual(writes.enqueues, [])
    assert.deepEqual(writes.dismissals, [
      { by: ACTIONS, number: 1, review_id: 5 },
      { by: ACTIONS, number: 1, review_id: 7 },
    ])
    assert.equal(humanApproval.state, 'APPROVED')
    assert.match(core.warnings.join('\n'), /cannot enter the merge queue/)
  })

  it('continues withdrawing App approvals when GitHub refuses one dismissal', async () => {
    const reviews = [5, 7].map((id) => ({ id, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }))
    const { writes, core } = await run([dependabotPr({ reviews })], candidate, { failEnqueue: true, failDismissal: 5 })
    assert.match(core.warnings.join('\n'), /could not dismiss approval 5/)
    assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 7 }])
  })

  for (const [eventName, expectedApprovals] of [['schedule', 0], ['workflow_dispatch', 1]]) {
    it(`honours the ${eventName} window policy when Saturday starts after selection`, async () => {
      const pull = dependabotPr()
      const context = { ...scheduled, eventName }
      const { candidates } = await find([pull], { context, now: new Date('2026-11-27T22:59:59Z') })
      assert.deepEqual(candidates, candidate)
      const { writes } = await run([pull], candidates, { context, getTime: () => new Date('2026-11-27T23:00:00Z') })
      assert.equal(writes.approvals.length, expectedApprovals)
      assert.equal(writes.enqueues.length, expectedApprovals)
    })
  }

  for (const [name, overrides] of [
    ['a PR opened by a maintainer', { user: { login: 'maintainer' } }],
    ['a major npm update', { updateType: MAJOR }],
  ]) {
    it(`rejects a well-formed candidate for ${name} before requesting a merge`, async () => {
      const { writes, core } = await run([dependabotPr(overrides)], candidate)
      assert.deepEqual(writes.approvals, [])
      assert.deepEqual(writes.enqueues, [])
      assert.equal(core.logs.some((line) => line.includes('requesting merge queue entry')), false)
    })
  }

  const changedSinceFind = [
    ['the head changed', { sha: 'b'.repeat(40) }, 'the head commit changed'],
    ['the PR was closed', { state: 'closed' }, 'the PR is not open'],
    ['the PR became a draft', { draft: true }, 'the PR is a draft'],
    [
      'the base branch changed',
      { base: { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } } },
      'the PR does not target the default branch',
    ],
    [
      'the PR got another commit below the head',
      { commits: [{ ...dependabotPr().commits[0], sha: 'b'.repeat(40) }, ...dependabotPr().commits] },
      'the PR has 2 commits, expected 1',
    ],
    ['a check failed', { checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure' }] }, 'concluded failure'],
    ['a reviewer requested changes', { reviews: [{ id: 1, user: { login: 'someone' }, state: 'CHANGES_REQUESTED' }] }, 'requested changes'],
    ['the PR left the merge queue', { queueEvents: [added, removed] }, 'removed from the merge queue'],
    ['the merge queue was turned off', { isMergeQueueEnabled: false }, 'has no merge queue'],
  ]
  for (const [name, overrides, reason] of changedSinceFind) {
    it(`neither approves nor merges when ${name} after the PR was selected`, async () => {
      const { writes, core } = await run([dependabotPr(overrides)], candidate)
      assert.deepEqual(writes.approvals, [])
      assert.deepEqual(writes.enqueues, [])
      assert.equal(core.warnings.length, 1)
      assert.match(core.warnings[0], new RegExp(`not merged: .*${reason}`))
    })
  }

  const mergeFailures = [
    ['GitHub refuses the queue entry', { failEnqueue: true }, 'cannot enter the merge queue'],
    ['the head moves during the approval', { onApprove: (pr) => (pr.head = { ...pr.head, sha: 'd'.repeat(40) }) }, 'the head changed after approval'],
    ['it cannot tell whether the branch has a merge queue', { failMergeQueueLookup: true }, 'GraphQL is unavailable'],
    ['the merge queue is turned off during the approval', { onApprove: (pr) => (pr.isMergeQueueEnabled = false) }, 'has no merge queue'],
    [
      'the PR enters and leaves the merge queue during the approval',
      { onApprove: (pr) => pr.queueEvents.push(added, removed) },
      'removed from the merge queue',
    ],
  ]
  for (const [name, options, reason] of mergeFailures) {
    it(`dismisses its new approval when ${name}`, async () => {
      const { writes, core } = await run([dependabotPr()], candidate, options)
      assert.deepEqual(writes.enqueues, [])
      assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 100 }])
      assert.equal(core.warnings.length, 1)
      assert.match(core.warnings[0], new RegExp(`not merged: .*${reason}`))
      const requestedQueueEntry = core.logs.includes(`PR #1: requesting merge queue entry for commit ${HEAD} as ${APP}`)
      assert.equal(requestedQueueEntry, options.failEnqueue === true)
    })
  }

  it('keeps its approval and does not enqueue again when the PR enters the merge queue during the run', async () => {
    const onApprove = (pr) => (pr.isInMergeQueue = true)
    const { writes } = await run([dependabotPr()], candidate, { onApprove })
    assert.equal(writes.approvals.length, 1)
    assert.deepEqual(writes.enqueues, [])
    assert.deepEqual(writes.dismissals, [])
  })

  it('fails on a list that is not an array', async () => {
    const { writes, core } = await run([dependabotPr()], { number: 1, headSha: HEAD })
    assert.deepEqual(writes.approvals, [])
    assert.equal(core.failures.length, 1)
  })

  const invalid = [
    ['an entry without a full SHA', { number: 1, headSha: 'abc' }],
    ['an entry without a number', { number: '1', headSha: HEAD }],
  ]
  for (const [name, entry] of invalid) {
    it(`skips ${name}`, async () => {
      const { writes, core } = await run([dependabotPr()], [entry])
      assert.deepEqual(writes.approvals, [])
      assert.deepEqual(writes.enqueues, [])
      assert.deepEqual(core.warnings, [`Skipped an invalid candidate: ${JSON.stringify(entry)}`])
    })
  }

  it('fails when the App token belongs to another App', async () => {
    const { writes, core } = await run([dependabotPr()], candidate, { appSlug: 'another-app' })
    assert.deepEqual(writes.approvals, [])
    assert.equal(core.failures.length, 1)
  })

  it('checks the latest activity on the exact branch in both steps and merges the selected head', async () => {
    const pull = dependabotPr()
    const fake = fakeGitHub({ pulls: [pull] })
    const core = fakeCore()
    const expectedRead = { by: ACTIONS, owner: 'navikt', repo: 'app', ref: `refs/heads/${pull.head.ref}`, direction: 'desc', per_page: 1 }
    await findMergeCandidates({ github: fake.actions, context: scheduled, core, now: TUESDAY })
    const candidates = JSON.parse(core.outputs.candidates)
    assert.deepEqual(fake.activityReads, [expectedRead])
    await approveAndMerge({
      github: fake.actions,
      appGithub: fake.app,
      appSlug: 'teamesyfo-automerge',
      context: scheduled,
      core,
      candidates,
      getTime: () => TUESDAY,
    })
    assert.deepEqual(fake.activityReads, [expectedRead, expectedRead])
    assert.deepEqual(fake.writes.enqueues, [{ by: APP, pullRequestId: 'PR_1', expectedHeadOid: HEAD }])
  })

  it('withholds approval when the same SHA returns to the branch through another actor after selection', async () => {
    const pull = dependabotPr()
    const fake = fakeGitHub({ pulls: [pull] })
    const core = fakeCore()
    const candidates = await findMergeCandidates({ github: fake.actions, context: scheduled, core, now: TUESDAY })
    assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
    pull.activities.unshift({ ...pull.activities[0], activity_type: 'force_push', actor: { login: 'maintainer' } })
    await approveAndMerge({
      github: fake.actions,
      appGithub: fake.app,
      appSlug: 'teamesyfo-automerge',
      context: scheduled,
      core,
      candidates,
      getTime: () => TUESDAY,
    })
    assert.deepEqual(fake.writes.approvals, [])
    assert.deepEqual(fake.writes.enqueues, [])
  })
})

describe('requestCopilotReviews', () => {
  const { requestCopilotReviews } = require('./automerge')
  const COPILOT = 'copilot-pull-request-reviewer[bot]'
  const OLDER = 'e'.repeat(40)
  const FOLLOW_UP = 'f'.repeat(40)
  const copilotReview = (commitId) => ({ id: 9, user: { login: COPILOT }, state: 'COMMENTED', commit_id: commitId })
  // A maintainer adds a commit on top of the Dependabot update.
  const withFollowUp = (overrides) => {
    const pull = dependabotPr(overrides)
    const followUp = { sha: FOLLOW_UP, author: { login: 'maintainer' }, commit: { message: 'Fix the build' } }
    return { ...pull, head: { ...pull.head, sha: FOLLOW_UP }, commits: [...pull.commits, followUp] }
  }
  const actionsBranch = { ...dependabotPr().head, ref: 'dependabot/github_actions/actions/checkout-6.0.0' }
  const release = { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } }

  async function request(pulls, options = {}) {
    const fake = fakeGitHub({ pulls, ...options })
    const core = fakeCore()
    await requestCopilotReviews({ github: fake.actions, context: scheduled, core })
    return { writes: fake.writes, core }
  }

  const cases = [
    ['a major update', dependabotPr({ updateType: MAJOR }), true],
    ['a major GitHub Actions update', dependabotPr({ updateType: MAJOR, head: actionsBranch }), true],
    ['an update without Dependabot metadata', dependabotPr({ message: 'Bump left-pad from 1.0.0 to 2.0.0' }), true],
    ['a major update that Copilot reviewed at an older commit', dependabotPr({ updateType: MAJOR, reviews: [copilotReview(OLDER)] }), true],
    ['a major update with a maintainer commit on top', withFollowUp({ updateType: MAJOR }), true],
    ['a patch update', dependabotPr(), false],
    ['a patch update with a maintainer commit on top', withFollowUp(), false],
    ['a major update that Copilot reviewed at its head', dependabotPr({ updateType: MAJOR, reviews: [copilotReview(HEAD)] }), false],
    ['a major update with a pending Copilot request', dependabotPr({ updateType: MAJOR, requested_reviewers: [{ login: 'Copilot' }] }), false],
    ['a draft', dependabotPr({ updateType: MAJOR, draft: true }), false],
    ['a PR on another base', dependabotPr({ updateType: MAJOR, base: release }), false],
    ['a PR from a fork', dependabotPr({ updateType: MAJOR, head: { ...dependabotPr().head, repo: { full_name: 'someone/app' } } }), false],
    ['a PR opened by someone else', dependabotPr({ updateType: MAJOR, user: { login: 'someone' } }), false],
  ]
  for (const [name, pull, expected] of cases) {
    it(`${expected ? 'requests' : 'does not request'} a Copilot review of ${name}`, async () => {
      const { writes, core } = await request([pull])
      const expectedRequests = expected ? [{ by: ACTIONS, number: 1, reviewers: [COPILOT] }] : []
      assert.deepEqual(writes.reviewRequests, expectedRequests)
      assert.deepEqual(core.warnings, [])
      assert.deepEqual(core.failures, [])
    })
  }

  it('continues with the next PR and fails the run when one request fails', async () => {
    const first = dependabotPr({ updateType: MAJOR })
    const second = { ...dependabotPr({ updateType: MAJOR, sha: OLDER }), number: 2 }
    const { writes, core } = await request([first, second], { failReviewRequest: 1 })
    assert.deepEqual(writes.reviewRequests, [{ by: ACTIONS, number: 2, reviewers: [COPILOT] }])
    assert.match(core.warnings.join('\n'), /PR #1: .*only be requested from collaborators/)
    assert.equal(core.failures.length, 1)
  })
})
