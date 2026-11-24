'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseUpdatedDependencies,
  decidePolicy,
  checkProvenance,
  summarizeChecks,
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
})

describe('decidePolicy', () => {
  const cases = [
    ['github_actions major', 'github_actions', [{ updateType: MAJOR }], true],
    ['github_actions without metadata', 'github_actions', null, true],
    ['npm patch and minor', 'npm_and_yarn', [{ updateType: PATCH }, { updateType: MINOR }], true],
    ['gradle group with one major', 'gradle', [{ updateType: PATCH }, { updateType: MAJOR }], false],
    ['npm without update type', 'npm_and_yarn', [{ updateType: undefined }], false],
    ['npm without metadata', 'npm_and_yarn', null, false],
  ]
  for (const [name, ecosystem, dependencies, expected] of cases) {
    it(`${name} -> automerge ${expected}`, () => {
      assert.equal(decidePolicy({ ecosystem, dependencies }).automerge, expected)
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
  ]
  for (const [name, checkRuns, combinedStatus, workflowRuns, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      assert.equal(summarizeChecks({ checkRuns, combinedStatus, workflowRuns }).state, expected)
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

const { evaluateAndApprove, merge } = require('./automerge')

const BOT = 'github-actions[bot]'
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
    base: { ref: 'main', repo: { full_name: 'navikt/app' } },
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
    checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
    combinedStatus: { state: 'pending', total_count: 0 },
    workflowRuns: [],
    isInMergeQueue: false,
    ...overrides,
  }
}

// A small in-memory GitHub that records every write. It only implements the
// calls the action makes.
function fakeGitHub({ pulls, mergeQueue = false, oldCommits = {}, onApprove, failMergeQueueLookup = false }) {
  const byNumber = new Map(pulls.map((pr) => [pr.number, pr]))
  const pr = (number) => byNumber.get(number)
  const writes = { approvals: [], dismissals: [], reviewRequests: [], merges: [], enqueues: [] }
  let reviewId = 100
  const github = {
    writes,
    paginate: async (method, params) => {
      const { data } = await method(params)
      return Array.isArray(data) ? data : (data.check_runs ?? data.workflow_runs)
    },
    graphql: async (query, variables) => {
      if (query.includes('enqueuePullRequest')) {
        writes.enqueues.push(variables)
        return { enqueuePullRequest: { mergeQueueEntry: { position: 1 } } }
      }
      if (failMergeQueueLookup) throw new Error('GraphQL is unavailable')
      const p = pr(variables.number)
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
          },
          defaultBranchRef: { name: 'main' },
        },
      }
    },
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main', full_name: 'navikt/app' } }),
        getCombinedStatusForRef: async ({ ref }) => ({
          data: pulls.find((p) => p.head.sha === ref).combinedStatus,
        }),
        getCommit: async ({ ref }) => {
          if (!oldCommits[ref]) throw Object.assign(new Error('Not Found'), { status: 404 })
          return { data: { sha: ref, commit: { message: oldCommits[ref] } } }
        },
      },
      checks: {
        listForRef: async ({ ref }) => {
          const checkRuns = pulls.find((p) => p.head.sha === ref).checkRuns
          return { data: { total_count: checkRuns.length, check_runs: checkRuns } }
        },
      },
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha }) => ({
          data: { workflow_runs: pulls.find((p) => p.head.sha === head_sha).workflowRuns },
        }),
      },
      pulls: {
        list: async () => ({ data: pulls.filter((p) => p.state === 'open') }),
        get: async ({ pull_number }) => ({ data: pr(pull_number) }),
        listCommits: async ({ pull_number }) => ({ data: pr(pull_number).commits }),
        listReviews: async ({ pull_number }) => ({ data: pr(pull_number).reviews }),
        listRequestedReviewers: async ({ pull_number }) => ({
          data: { users: pr(pull_number).requestedReviewers, teams: [] },
        }),
        requestReviewers: async ({ pull_number, reviewers }) => {
          writes.reviewRequests.push({ number: pull_number, reviewers })
          pr(pull_number).requestedReviewers.push({ login: 'Copilot' })
          return { data: {} }
        },
        createReview: async ({ pull_number, event, commit_id }) => {
          writes.approvals.push({ number: pull_number, event, commit_id })
          const review = { id: reviewId++, user: { login: BOT }, state: 'APPROVED', commit_id }
          pr(pull_number).reviews.push(review)
          onApprove?.(pr(pull_number))
          return { data: review }
        },
        dismissReview: async ({ pull_number, review_id }) => {
          writes.dismissals.push({ number: pull_number, review_id })
          pr(pull_number).reviews.find((r) => r.id === review_id).state = 'DISMISSED'
          return { data: {} }
        },
        merge: async ({ pull_number, sha, merge_method }) => {
          if (sha !== pr(pull_number).head.sha) {
            throw Object.assign(new Error('Head branch was modified'), { status: 409 })
          }
          writes.merges.push({ number: pull_number, sha, merge_method })
          return { data: { merged: true } }
        },
      },
    },
  }
  return github
}

function fakeCore() {
  const core = { outputs: {}, warnings: [], logs: [] }
  core.info = (message) => core.logs.push(message)
  core.warning = (message) => core.warnings.push(message)
  core.setOutput = (name, value) => {
    core.outputs[name] = value
  }
  return core
}

const scheduled = { repo: { owner: 'navikt', repo: 'app' }, eventName: 'schedule' }

async function evaluate(pulls, { now = TUESDAY, context = scheduled, copilotReview = true, ...options } = {}) {
  const github = fakeGitHub({ pulls, ...options })
  const core = fakeCore()
  await evaluateAndApprove({ github, context, core, now, copilotReview })
  return { github, core, approved: JSON.parse(core.outputs.approved) }
}

describe('evaluateAndApprove', () => {
  it('approves an eligible update on exactly its head commit', async () => {
    const { github, approved } = await evaluate([dependabotPr()])
    assert.deepEqual(github.writes.approvals, [{ number: 1, event: 'APPROVE', commit_id: HEAD }])
    assert.deepEqual(approved, [{ number: 1, headSha: HEAD }])
  })

  it('approves a major GitHub Actions update', async () => {
    const head = { ...dependabotPr().head, ref: 'dependabot/github_actions/actions/checkout-6.0.0' }
    const { approved } = await evaluate([dependabotPr({ updateType: MAJOR, head })])
    assert.deepEqual(approved, [{ number: 1, headSha: HEAD }])
  })

  const notApproved = [
    ['a semver-major update', { updateType: MAJOR }],
    ['a draft', { draft: true }],
    ['an extra commit', { commits: [...dependabotPr().commits, { ...dependabotPr().commits[0], sha: 'b'.repeat(40) }] }],
    ['a PR from a fork', { head: { ...dependabotPr().head, repo: { full_name: 'someone/app' } } }],
    ['a PR opened by someone else', { user: { login: 'someone' } }],
    ['a merge conflict', { mergeable: false }],
    ['a PR whose mergeability GitHub has not computed', { mergeable: null }],
    ['a failed check', { checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure' }] }],
    ['a requested change', { reviews: [{ id: 1, user: { login: 'someone' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }] }],
  ]
  for (const [name, overrides] of notApproved) {
    it(`does not approve ${name}`, async () => {
      const { github, approved } = await evaluate([dependabotPr(overrides)], { copilotReview: false })
      assert.deepEqual(github.writes.approvals, [])
      assert.deepEqual(approved, [])
    })
  }

  it('does not approve on a scheduled run outside the merge window', async () => {
    const { github, approved } = await evaluate([dependabotPr()], { now: SATURDAY })
    assert.deepEqual(github.writes.approvals, [])
    assert.deepEqual(approved, [])
  })

  it('approves on a manual run outside the merge window', async () => {
    const context = { ...scheduled, eventName: 'workflow_dispatch' }
    const { approved } = await evaluate([dependabotPr()], { now: SATURDAY, context })
    assert.deepEqual(approved, [{ number: 1, headSha: HEAD }])
  })

  it('dismisses its approval when the head moves while it approves', async () => {
    const moved = 'd'.repeat(40)
    const { github, approved } = await evaluate([dependabotPr()], {
      onApprove: (pr) => {
        pr.head = { ...pr.head, sha: moved }
      },
    })
    assert.equal(github.writes.dismissals.length, 1)
    assert.deepEqual(approved, [])
  })

  it('dismisses an earlier bot approval of a commit that is no longer the head', async () => {
    const stale = { id: 7, user: { login: BOT }, state: 'APPROVED', commit_id: 'e'.repeat(40) }
    const { github } = await evaluate([dependabotPr({ updateType: MAJOR, reviews: [stale] })], { copilotReview: false })
    assert.deepEqual(github.writes.dismissals, [{ number: 1, review_id: 7 }])
  })

  it('requests one Copilot review for a major update, also outside the merge window', async () => {
    const pulls = [dependabotPr({ updateType: MAJOR })]
    const github = fakeGitHub({ pulls })
    for (let run = 0; run < 2; run++) {
      await evaluateAndApprove({ github, context: scheduled, core: fakeCore(), now: SATURDAY, copilotReview: true })
    }
    assert.deepEqual(github.writes.reviewRequests, [{ number: 1, reviewers: [COPILOT] }])
  })

  const reviewedEarlier = [
    ['the head commit', HEAD, '1.0.1', 0],
    ['the same versions on an older commit', 'f'.repeat(40), '1.0.1', 0],
    ['other versions on an older commit', 'f'.repeat(40), '1.0.0', 1],
  ]
  for (const [name, reviewedCommit, reviewedVersion, expectedRequests] of reviewedEarlier) {
    it(`after a Copilot review of ${name}, requests ${expectedRequests} new review`, async () => {
      const pulls = [
        dependabotPr({
          updateType: MAJOR,
          reviews: [{ id: 3, user: { login: COPILOT }, state: 'COMMENTED', commit_id: reviewedCommit }],
        }),
      ]
      const oldCommits =
        reviewedCommit === HEAD
          ? {}
          : { [reviewedCommit]: dependabotMessage({ name: 'left-pad', version: reviewedVersion, updateType: MAJOR }) }
      const { github } = await evaluate(pulls, { oldCommits })
      assert.equal(github.writes.reviewRequests.length, expectedRequests)
    })
  }

  it('does not request Copilot when the caller opts out', async () => {
    const { github } = await evaluate([dependabotPr({ updateType: MAJOR })], { copilotReview: false })
    assert.deepEqual(github.writes.reviewRequests, [])
  })
})

describe('merge', () => {
  async function runMerge(pulls, approved, options = {}) {
    const github = fakeGitHub({ pulls, ...options })
    const core = fakeCore()
    await merge({ github, context: scheduled, core, approved })
    return { github, core }
  }

  it('squash-merges the approved head commit when the branch has no merge queue', async () => {
    const { github } = await runMerge([dependabotPr()], [{ number: 1, headSha: HEAD }])
    assert.deepEqual(github.writes.merges, [{ number: 1, sha: HEAD, merge_method: 'squash' }])
  })

  it('adds the approved head commit to the merge queue when the branch has one', async () => {
    const { github } = await runMerge([dependabotPr()], [{ number: 1, headSha: HEAD }], { mergeQueue: true })
    assert.deepEqual(github.writes.enqueues, [{ pullRequestId: 'PR_1', expectedHeadOid: HEAD }])
    assert.deepEqual(github.writes.merges, [])
  })

  for (const mergeQueue of [false, true]) {
    it(`does not merge a PR whose head changed after approval (merge queue: ${mergeQueue})`, async () => {
      const { github, core } = await runMerge([dependabotPr({ sha: 'b'.repeat(40) })], [{ number: 1, headSha: HEAD }], {
        mergeQueue,
      })
      assert.deepEqual(github.writes.merges, [])
      assert.deepEqual(github.writes.enqueues, [])
      assert.equal(core.warnings.length, 1)
    })
  }

  it('does not add a PR to the merge queue twice', async () => {
    const { github } = await runMerge([dependabotPr({ isInMergeQueue: true })], [{ number: 1, headSha: HEAD }], {
      mergeQueue: true,
    })
    assert.deepEqual(github.writes.enqueues, [])
  })

  it('does not merge when it cannot tell whether the branch has a merge queue', async () => {
    const { github, core } = await runMerge([dependabotPr()], [{ number: 1, headSha: HEAD }], {
      failMergeQueueLookup: true,
    })
    assert.deepEqual(github.writes.merges, [])
    assert.deepEqual(github.writes.enqueues, [])
    assert.equal(core.warnings.length, 1)
  })
})
