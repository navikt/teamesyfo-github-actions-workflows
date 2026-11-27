'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseUpdatedDependencies,
  decidePolicy,
  checkProvenance,
  summarizeChecks,
  summarizeRequiredChecks,
  isMergeWindowOpen,
} = require('./automerge')

const HEAD = 'a'.repeat(40)
const MAIN_SHA = '9'.repeat(40)

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

describe('decidePolicy', () => {
  const workflow = { filename: '.github/workflows/build.yaml', status: 'modified' }
  const action = { filename: 'actions/setup/action.yml', status: 'modified' }
  const packageJson = { filename: 'package.json', status: 'modified' }
  const major = [{ updateType: MAJOR }]
  const cases = [
    ['github_actions major in workflow and action files', 'github_actions', major, [workflow, action], true],
    ['github_actions without metadata in a workflow file', 'github_actions', null, [workflow], true],
    ['github_actions major that also changes package.json', 'github_actions', major, [workflow, packageJson], false],
    ['github_actions major that adds a workflow', 'github_actions', major, [{ ...workflow, status: 'added' }], false],
    ['github_actions major in a subdirectory of .github/workflows', 'github_actions', major, [{ ...workflow, filename: '.github/workflows/x/build.yaml' }], false],
    ['github_actions major without changed files', 'github_actions', major, [], false],
    ['github_actions minor that changes package.json', 'github_actions', [{ updateType: MINOR }], [packageJson], true],
    ['npm patch and minor', 'npm_and_yarn', [{ updateType: PATCH }, { updateType: MINOR }], [packageJson], true],
    ['npm major in a workflow file', 'npm_and_yarn', major, [workflow], false],
    ['gradle group with one major', 'gradle', [{ updateType: PATCH }, { updateType: MAJOR }], [], false],
    ['npm without update type', 'npm_and_yarn', [{ updateType: undefined }], [], false],
    ['npm without metadata', 'npm_and_yarn', null, [], false],
    ['npm with an empty list', 'npm_and_yarn', [], [], false],
  ]
  for (const [name, ecosystem, dependencies, files, expected] of cases) {
    it(`${name} -> automerge ${expected}`, async () => {
      const policy = await decidePolicy({ ecosystem, dependencies, readFiles: async () => files })
      assert.equal(policy.automerge, expected)
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
const COPILOT = 'copilot-pull-request-reviewer[bot]'
const TUESDAY = new Date('2026-11-24T09:00:00Z')
const SATURDAY = new Date('2026-11-28T09:00:00Z')

function dependabotPr(overrides = {}) {
  const sha = overrides.sha ?? HEAD
  const updateType = overrides.updateType ?? PATCH
  const message = overrides.message ?? dependabotMessage({ name: 'left-pad', version: '1.0.1', updateType })
  return {
    number: 1,
    node_id: 'PR_1',
    draft: false,
    state: 'open',
    mergeable: true,
    user: { login: 'dependabot[bot]' },
    head: { sha, ref: 'dependabot/npm_and_yarn/left-pad-1.0.1', repo: { full_name: 'navikt/app' } },
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
    requestedReviewers: [],
    // The files that the head commit changes, whether GitHub has more of them
    // on another page, and whether reading them fails.
    files: [{ filename: 'package.json', status: 'modified' }],
    moreFiles: false,
    filesUnavailable: false,
    checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
    combinedStatus: { state: 'pending', total_count: 0 },
    workflowRuns: [],
    rollupContexts: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true },
    ],
    isInMergeQueue: false,
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
  mergeQueue = false,
  oldHistories: histories = {},
  onApprove,
  onListRequestedReviewers,
  failMergeQueueLookup = false,
  failDismissal = false,
  failMerge = false,
}) {
  const byNumber = new Map(pulls.map((pr) => [pr.number, pr]))
  const pr = (number) => byNumber.get(number)
  const noChecks = { checkRuns: [], combinedStatus: { state: 'pending', total_count: 0 }, workflowRuns: [] }
  const byHead = (sha) => pulls.find((p) => p.head.sha === sha) ?? noChecks
  const writes = { approvals: [], dismissals: [], reviewRequests: [], merges: [], enqueues: [] }
  const reads = { compareBases: [] }
  let reviewId = 100

  const client = (login) => ({
    paginate: async (method, params) => {
      const { data } = await method(params)
      return Array.isArray(data) ? data : (data.check_runs ?? data.workflow_runs)
    },
    graphql: async (query, variables) => {
      if (query.includes('enqueuePullRequest')) {
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
            pullRequest: { isInMergeQueue: p.isInMergeQueue, timelineItems, commits: { nodes: [{ commit }] } },
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
            isMergeQueueEnabled: mergeQueue,
            timelineItems,
          },
          defaultBranchRef: { name: 'main' },
        },
      }
    },
    rest: {
      repos: {
        getCombinedStatusForRef: async ({ ref }) => ({ data: byHead(ref).combinedStatus }),
        getCommit: async ({ ref }) => {
          const pull = pulls.find((p) => p.head.sha === ref)
          if (!pull) throw Object.assign(new Error('Not Found'), { status: 404 })
          if (pull.filesUnavailable) throw Object.assign(new Error('Server Error'), { status: 502 })
          const headers = pull.moreFiles ? { link: '<https://api.github.com/commit?page=2>; rel="next"' } : {}
          return { data: { sha: ref, files: pull.files }, headers }
        },
        // histories holds the commits that GitHub lists between the default
        // branch and a commit, or the error that GitHub returns. Without an
        // entry, a commit in a PR has the linear history of the PR's commits
        // up to and including it. The default branch is at MAIN_SHA.
        compareCommitsWithBasehead: async ({ basehead }) => {
          const [base, ref] = basehead.split('...')
          reads.compareBases.push(base)
          const prefix = (pull) => pull.commits.slice(0, pull.commits.findIndex((commit) => commit.sha === ref) + 1)
          const pull = pulls.find((p) => p.commits.some((commit) => commit.sha === ref))
          const commits = histories[ref] ?? (pull && prefix(pull))
          if (commits instanceof Error) throw commits
          if (!['main', MAIN_SHA].includes(base) || !commits) throw Object.assign(new Error('Not Found'), { status: 404 })
          const data = { base_commit: { sha: MAIN_SHA }, total_commits: commits.total ?? commits.length, commits: [...commits] }
          return { data }
        },
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
        listRequestedReviewers: async ({ pull_number }) => {
          onListRequestedReviewers?.(pr(pull_number))
          return { data: { users: [...pr(pull_number).requestedReviewers], teams: [] } }
        },
        requestReviewers: async ({ pull_number, reviewers }) => {
          writes.reviewRequests.push({ by: login, number: pull_number, reviewers })
          pr(pull_number).requestedReviewers.push({ login: 'Copilot' })
          return { data: {} }
        },
        createReview: async ({ pull_number, event, commit_id }) => {
          writes.approvals.push({ by: login, number: pull_number, event, commit_id })
          const review = { id: reviewId++, user: { login }, state: 'APPROVED', commit_id }
          pr(pull_number).reviews.push(review)
          onApprove?.(pr(pull_number))
          return { data: review }
        },
        dismissReview: async ({ pull_number, review_id }) => {
          if (failDismissal) throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
          writes.dismissals.push({ by: login, number: pull_number, review_id })
          pr(pull_number).reviews.find((r) => r.id === review_id).state = 'DISMISSED'
          return { data: {} }
        },
        merge: async ({ pull_number, sha, merge_method }) => {
          if (failMerge) throw Object.assign(new Error('Required status check "build" is expected'), { status: 405 })
          if (sha !== pr(pull_number).head.sha) {
            throw Object.assign(new Error('Head branch was modified'), { status: 409 })
          }
          writes.merges.push({ by: login, number: pull_number, sha, merge_method })
          return { data: { merged: true } }
        },
      },
    },
  })

  return { writes, reads, actions: client(ACTIONS), app: client(APP) }
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

async function find(pulls, { now = TUESDAY, context = scheduled, copilotReview = true, ...options } = {}) {
  const fake = fakeGitHub({ pulls, ...options })
  const core = fakeCore()
  await findMergeCandidates({ github: fake.actions, context, core, now, copilotReview })
  return { writes: fake.writes, reads: fake.reads, core, candidates: JSON.parse(core.outputs.candidates) }
}

describe('findMergeCandidates', () => {
  it('selects an eligible update with its head commit, without approving it', async () => {
    const { writes, candidates } = await find([dependabotPr()])
    assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
    assert.deepEqual(writes.approvals, [])
  })

  const actionsUpdate = (files) =>
    dependabotPr({
      updateType: MAJOR,
      head: { ...dependabotPr().head, ref: 'dependabot/github_actions/actions/checkout-6.0.0' },
      files,
    })

  it('selects a major GitHub Actions update that changes only workflow and action files', async () => {
    const files = [
      { filename: '.github/workflows/build.yaml', status: 'modified' },
      { filename: 'actions/setup/action.yaml', status: 'modified' },
    ]
    const { candidates } = await find([actionsUpdate(files)])
    assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
  })

  it('requests a manual review of a major update on a GitHub Actions branch that changes other files', async () => {
    const { writes, candidates } = await find([actionsUpdate([{ filename: 'package.json', status: 'modified' }])])
    assert.deepEqual(candidates, [])
    assert.equal(writes.reviewRequests.length, 1)
  })

  it('requests a manual review of a major GitHub Actions update when GitHub lists its files on several pages', async () => {
    const pull = actionsUpdate([{ filename: '.github/workflows/build.yaml', status: 'modified' }])
    const { writes, candidates } = await find([{ ...pull, moreFiles: true }])
    assert.deepEqual(candidates, [])
    assert.equal(writes.reviewRequests.length, 1)
  })

  it('selects a patch update on a GitHub Actions branch without reading its files', async () => {
    const head = { ...dependabotPr().head, ref: 'dependabot/github_actions/actions/checkout-5.0.1' }
    const { candidates } = await find([dependabotPr({ head, filesUnavailable: true })])
    assert.deepEqual(candidates, [{ number: 1, headSha: HEAD }])
  })

  const extraCommit = { ...dependabotPr().commits[0], sha: 'b'.repeat(40) }
  const notSelected = [
    ['a semver-major update', { updateType: MAJOR }],
    ['a draft', { draft: true }],
    ['an extra commit', { commits: [...dependabotPr().commits, extraCommit] }],
    ['a PR from a fork', { head: { ...dependabotPr().head, repo: { full_name: 'someone/app' } } }],
    ['a PR opened by someone else', { user: { login: 'someone' } }],
    ['a merge conflict', { mergeable: false }],
    ['a PR whose mergeability GitHub has not computed', { mergeable: null }],
    ['a PR that is already in the merge queue', { isInMergeQueue: true }],
    ['a failed check', { checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure' }] }],
    ['a PR without a required check', { rollupContexts: [{ ...dependabotPr().rollupContexts[0], isRequired: false }] }],
    ['a requested change', { reviews: [{ id: 1, user: { login: 'someone' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }] }],
  ]
  for (const [name, overrides] of notSelected) {
    it(`does not select ${name}`, async () => {
      const { candidates } = await find([dependabotPr(overrides)], { copilotReview: false })
      assert.deepEqual(candidates, [])
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

  it('skips without a review request a PR that was listed on the default branch but now targets another', async () => {
    const approval = { id: 5, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }
    const release = { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } }
    const main = dependabotPr().base
    const pull = dependabotPr({ updateType: MAJOR, base: release, reviews: [approval], listedAs: { base: main } })
    const { writes, candidates } = await find([pull])
    assert.deepEqual(candidates, [])
    assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 5 }])
    assert.deepEqual(writes.reviewRequests, [])
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
    assert.deepEqual(writes.reviewRequests, [])
  })

  it('keeps an App approval when the PR targets the default branch again after it was listed', async () => {
    const approval = { id: 5, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }
    const release = { ref: 'release', repo: { full_name: 'navikt/app', default_branch: 'main' } }
    const { writes } = await find([dependabotPr({ reviews: [approval], listedAs: { base: release } })])
    assert.deepEqual(writes.dismissals, [])
  })

  const staleApproval = { id: 7, user: { login: APP }, state: 'APPROVED', commit_id: 'e'.repeat(40) }

  it('dismisses an earlier App approval of a commit that is no longer the head', async () => {
    const { writes } = await find([dependabotPr({ updateType: MAJOR, reviews: [{ ...staleApproval }] })], {
      copilotReview: false,
    })
    assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 7 }])
  })

  it('does not select a PR when it cannot dismiss a stale App approval', async () => {
    const { core, candidates } = await find([dependabotPr({ reviews: [{ ...staleApproval }] })], {
      failDismissal: true,
    })
    assert.deepEqual(candidates, [])
    assert.equal(core.warnings.length, 1)
  })

  it('requests one Copilot review for a major update, also outside the merge window', async () => {
    const fake = fakeGitHub({ pulls: [dependabotPr({ updateType: MAJOR })] })
    for (let run = 0; run < 2; run++) {
      await findMergeCandidates({ github: fake.actions, context: scheduled, core: fakeCore(), now: SATURDAY })
    }
    assert.deepEqual(fake.writes.reviewRequests, [{ by: ACTIONS, number: 1, reviewers: [COPILOT] }])
  })

  it('requests a Copilot review when someone else has pushed to the branch', async () => {
    const { writes, candidates } = await find([dependabotPr({ commits: [...dependabotPr().commits, extraCommit] })])
    assert.deepEqual(candidates, [])
    assert.equal(writes.reviewRequests.length, 1)
  })

  const copilotReview = (commitId) => ({ id: 3, user: { login: COPILOT }, state: 'COMMENTED', commit_id: commitId })
  const older = 'f'.repeat(40)
  const fixSha = 'e'.repeat(40)
  const majorCommit = (sha, version) => ({
    ...dependabotPr().commits[0],
    sha,
    commit: {
      message: dependabotMessage({ name: 'left-pad', version, updateType: MAJOR }),
      verification: { verified: true },
    },
  })
  const maintainerFix = (sha) => ({
    sha,
    author: { login: 'someone' },
    committer: { login: 'someone' },
    commit: { message: 'fix: adapt to the new version', verification: { verified: false } },
  })
  const head = dependabotPr({ updateType: MAJOR }).commits[0]
  const mergeSha = '7'.repeat(40)
  const withoutMetadata = { ...head, commit: { ...head.commit, message: 'Bump left-pad from 1.0.0 to 2.0.0' } }
  const reviewedEarlier = [
    ['the head commit', { reviews: [copilotReview(HEAD)] }, {}, 0],
    ['the same versions on a commit that left the PR', { reviews: [copilotReview(older)] }, { [older]: [majorCommit(older, '1.0.1')] }, 0],
    ['other versions on a commit that left the PR', { reviews: [copilotReview(older)] }, { [older]: [majorCommit(older, '1.0.0')] }, 1],
    ['the head commit before another commit', { reviews: [copilotReview(HEAD), copilotReview(older)] }, { [older]: [majorCommit(older, '1.0.0')] }, 0],
    [
      'a maintainer fix of the same versions that left the PR',
      { reviews: [copilotReview(fixSha)] },
      { [fixSha]: [majorCommit(older, '1.0.1'), maintainerFix(fixSha)] },
      0,
    ],
    [
      'a maintainer fix of other versions that left the PR',
      { reviews: [copilotReview(fixSha)] },
      { [fixSha]: [majorCommit(older, '1.0.0'), maintainerFix(fixSha)] },
      1,
    ],
    [
      'other versions on a commit that is still in the PR',
      { reviews: [copilotReview(older)], commits: [majorCommit(older, '1.0.0'), head] },
      {},
      1,
    ],
    [
      'a commit with more history than GitHub lists',
      { reviews: [copilotReview(older)] },
      { [older]: Object.assign([majorCommit(older, '1.0.1')], { total: 300 }) },
      1,
    ],
    [
      'the same versions on a head with more history than GitHub lists',
      { reviews: [copilotReview(older)] },
      { [older]: [majorCommit(older, '1.0.1')], [HEAD]: Object.assign([head], { total: 300 }) },
      1,
    ],
    [
      'a maintainer fix beside a newer Dependabot commit',
      {
        reviews: [copilotReview(fixSha)],
        commits: [majorCommit(older, '1.0.0'), head, maintainerFix(fixSha), maintainerFix(mergeSha)],
      },
      { [fixSha]: [majorCommit(older, '1.0.0'), maintainerFix(fixSha)] },
      1,
    ],
    [
      'the newer of two Dependabot commits that a maintainer has merged',
      { reviews: [copilotReview(HEAD)], commits: [majorCommit(older, '1.0.0'), head, maintainerFix(mergeSha)] },
      { [HEAD]: [head] },
      1,
    ],
    ['a commit that no longer exists', { reviews: [copilotReview(older)] }, {}, 1],
    [
      'a commit that no longer exists and a commit with the same versions',
      { reviews: [copilotReview(older), copilotReview(fixSha)] },
      { [fixSha]: [majorCommit(fixSha, '1.0.1')] },
      0,
    ],
    [
      'a Dependabot commit without metadata that a maintainer has fixed',
      { reviews: [copilotReview(HEAD)], commits: [withoutMetadata, maintainerFix(fixSha)] },
      {},
      0,
    ],
    [
      'a rebased Dependabot commit without metadata',
      { reviews: [copilotReview(older)], commits: [withoutMetadata] },
      { [older]: [{ ...withoutMetadata, sha: older }] },
      1,
    ],
  ]
  for (const [name, overrides, oldHistories, expectedRequests] of reviewedEarlier) {
    it(`after a Copilot review of ${name}, requests ${expectedRequests} new review`, async () => {
      const pull = dependabotPr({ updateType: MAJOR, ...overrides })
      pull.head = { ...pull.head, sha: pull.commits.at(-1).sha }
      const { writes, core } = await find([pull], { oldHistories })
      assert.deepEqual(core.warnings, [])
      assert.equal(writes.reviewRequests.length, expectedRequests)
    })
  }

  it('requests nothing and warns when GitHub fails to compare a commit that Copilot reviewed', async () => {
    const oldHistories = { [older]: Object.assign(new Error('Server Error'), { status: 502 }) }
    const { writes, core } = await find([dependabotPr({ updateType: MAJOR, reviews: [copilotReview(older)] })], { oldHistories })
    assert.deepEqual(writes.reviewRequests, [])
    assert.match(core.warnings.join('\n'), /could not compare commit f{40} with 9{40}: Server Error/)
  })

  it('compares the reviewed commits with the commit that the default branch was at for the head', async () => {
    const oldHistories = { [older]: [majorCommit(older, '1.0.1')] }
    const { reads } = await find([dependabotPr({ updateType: MAJOR, reviews: [copilotReview(older)] })], { oldHistories })
    assert.deepEqual(reads.compareBases, ['main', MAIN_SHA])
  })

  const withMaintainerFix = (reviews) => {
    const pull = dependabotPr({ updateType: MAJOR, reviews })
    const fix = maintainerFix('b'.repeat(40))
    return Object.assign(pull, { head: { ...pull.head, sha: fix.sha }, commits: [...pull.commits, fix] })
  }

  it('does not request Copilot again when a maintainer pushes a fix after its review', async () => {
    const { writes } = await find([withMaintainerFix([copilotReview(HEAD)])])
    assert.deepEqual(writes.reviewRequests, [])
  })

  it('does not request Copilot again for the same versions after a rebase and a maintainer fix', async () => {
    const oldHistories = { [older]: [majorCommit(older, '1.0.1')] }
    const { writes } = await find([withMaintainerFix([copilotReview(older)])], { oldHistories })
    assert.deepEqual(writes.reviewRequests, [])
  })

  it('requests Copilot for a GitHub Actions update that someone else has pushed to, without reading its files', async () => {
    const pull = withMaintainerFix([])
    Object.assign(pull, { head: { ...pull.head, ref: 'dependabot/github_actions/actions/checkout-5' }, filesUnavailable: true })
    const { writes, core } = await find([pull])
    assert.deepEqual(core.warnings, [])
    assert.equal(writes.reviewRequests.length, 1)
  })

  it('does not request Copilot again when it submits its pending review just before the requests are read', async () => {
    const submitPendingCopilotReview = (pull) => {
      if (pull.requestedReviewers.length === 0) return
      pull.requestedReviewers = []
      pull.reviews.push(copilotReview(HEAD))
    }
    const { writes } = await find([dependabotPr({ updateType: MAJOR, requestedReviewers: [{ login: 'Copilot' }] })], {
      onListRequestedReviewers: submitPendingCopilotReview,
    })
    assert.deepEqual(writes.reviewRequests, [])
  })

  it('does not request Copilot when the caller opts out', async () => {
    const { writes } = await find([dependabotPr({ updateType: MAJOR })], { copilotReview: false })
    assert.deepEqual(writes.reviewRequests, [])
  })
})

describe('approveAndMerge', () => {
  const candidate = [{ number: 1, headSha: HEAD }]

  async function run(pulls, candidates, { appSlug = 'teamesyfo-automerge', ...options } = {}) {
    const fake = fakeGitHub({ pulls, ...options })
    const core = fakeCore()
    await approveAndMerge({ github: fake.actions, appGithub: fake.app, appSlug, context: scheduled, core, candidates })
    return { writes: fake.writes, core }
  }

  it('approves the head commit as the App and squash-merges it', async () => {
    const { writes } = await run([dependabotPr()], candidate)
    assert.deepEqual(writes.approvals, [{ by: APP, number: 1, event: 'APPROVE', commit_id: HEAD }])
    assert.deepEqual(writes.merges, [{ by: APP, number: 1, sha: HEAD, merge_method: 'squash' }])
  })

  it('approves and adds the head commit to the merge queue when the branch has one', async () => {
    const { writes } = await run([dependabotPr()], candidate, { mergeQueue: true })
    assert.equal(writes.approvals.length, 1)
    assert.deepEqual(writes.enqueues, [{ by: APP, pullRequestId: 'PR_1', expectedHeadOid: HEAD }])
    assert.deepEqual(writes.merges, [])
  })

  it('does not approve again when the App has already approved the head commit', async () => {
    const approval = { id: 5, user: { login: APP }, state: 'APPROVED', commit_id: HEAD }
    const { writes } = await run([dependabotPr({ reviews: [approval] })], candidate)
    assert.deepEqual(writes.approvals, [])
    assert.equal(writes.merges.length, 1)
  })

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
  ]
  for (const [name, overrides, reason] of changedSinceFind) {
    it(`neither approves nor merges when ${name} after the PR was selected`, async () => {
      const { writes, core } = await run([dependabotPr(overrides)], candidate)
      assert.deepEqual(writes.approvals, [])
      assert.deepEqual(writes.merges, [])
      assert.equal(core.warnings.length, 1)
      assert.match(core.warnings[0], new RegExp(`not merged: .*${reason}`))
    })
  }

  const mergeFailures = [
    ['GitHub rejects the merge', { failMerge: true }, 'Required status check'],
    ['the head moves during the approval', { onApprove: (pr) => (pr.head = { ...pr.head, sha: 'd'.repeat(40) }) }, 'the head changed after approval'],
    ['it cannot tell whether the branch has a merge queue', { failMergeQueueLookup: true }, 'GraphQL is unavailable'],
    [
      'the PR enters and leaves the merge queue during the approval',
      { mergeQueue: true, onApprove: (pr) => pr.queueEvents.push(added, removed) },
      'removed from the merge queue',
    ],
  ]
  for (const [name, options, reason] of mergeFailures) {
    it(`dismisses its new approval when ${name}`, async () => {
      const { writes, core } = await run([dependabotPr()], candidate, options)
      assert.deepEqual(writes.merges, [])
      assert.deepEqual(writes.enqueues, [])
      assert.deepEqual(writes.dismissals, [{ by: ACTIONS, number: 1, review_id: 100 }])
      assert.equal(core.warnings.length, 1)
      assert.match(core.warnings[0], new RegExp(`not merged: .*${reason}`))
    })
  }

  it('keeps its approval and does not enqueue again when the PR enters the merge queue during the run', async () => {
    const onApprove = (pr) => (pr.isInMergeQueue = true)
    const { writes } = await run([dependabotPr()], candidate, { mergeQueue: true, onApprove })
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
      assert.deepEqual(writes.merges, [])
      assert.deepEqual(core.warnings, [`Skipped an invalid candidate: ${JSON.stringify(entry)}`])
    })
  }

  it('fails when the App token belongs to another App', async () => {
    const { writes, core } = await run([dependabotPr()], candidate, { appSlug: 'another-app' })
    assert.deepEqual(writes.approvals, [])
    assert.equal(core.failures.length, 1)
  })

  it('merges what findMergeCandidates selected', async () => {
    const fake = fakeGitHub({ pulls: [dependabotPr()] })
    const core = fakeCore()
    await findMergeCandidates({ github: fake.actions, context: scheduled, core, now: TUESDAY })
    const candidates = JSON.parse(core.outputs.candidates)
    await approveAndMerge({ github: fake.actions, appGithub: fake.app, appSlug: 'teamesyfo-automerge', context: scheduled, core, candidates })
    assert.deepEqual(fake.writes.merges, [{ by: APP, number: 1, sha: HEAD, merge_method: 'squash' }])
  })
})
