module.exports = async function run({ github, context, core }) {
    const logSection = (title = '') => console.log(`\n==== ${title} ====`)
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    const today = new Date()
    const currentYear = today.getFullYear()

    const holidayWindows = [
        { name: 'Summer',    start: new Date(currentYear, 6, 6),  end: new Date(currentYear, 6, 27) },
        { name: 'Christmas', start: new Date(currentYear, 11, 20), end: new Date(currentYear, 11, 31) },
        { name: 'NewYear',   start: new Date(currentYear, 0, 1),  end: new Date(currentYear, 0, 5) }
    ]

    const activeHoliday = holidayWindows.find(win => today >= win.start && today <= win.end)
    if (activeHoliday) {
        console.log(`Skipping due to holiday window: ${activeHoliday.name} (${activeHoliday.start.toISOString().slice(0,10)} - ${activeHoliday.end.toISOString().slice(0,10)})`)
        return
    }

    logSection('FETCH OPEN PULL REQUESTS')
    console.log('Fetching open PRs for automerge evaluation...')
    let pullsResponse
    try {
        pullsResponse = await github.request('GET /repos/{owner}/{repo}/pulls', {
            owner: context.repo.owner,
            repo: context.repo.repo,
            per_page: 50
        })
    } catch (error) {
        core.setFailed(`Failed to list pull requests: ${error.message}`)
        return
    }

    console.log(`Total open PRs returned: ${pullsResponse.data.length}`)

    const candidatePulls = pullsResponse.data
        .filter(pr => pr.state === 'open')
        .filter(pr => !pr.head?.repo?.fork)
        .filter(pr => pr.labels?.some(label => label.name === 'automerge'))

    console.log(`Automerge-labeled PRs: ${candidatePulls.length ? candidatePulls.map(p => '#' + p.number).join(', ') : '(none)'}`)

    if (!candidatePulls.length) {
        console.log('No candidates. Exiting.')
        return
    }

    candidatePulls.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

    logSection('ENRICH & STATUS CHECKS')
    const enrichedPulls = await Promise.all(candidatePulls.map(async pull => {
        const maxAttempts = 3
        let prDetails = null
        let mergeableState = null
        let mergeStateStatus = null

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const graphqlResp = await github.graphql(
                    `query($owner:String!,$repo:String!,$number:Int!){
             repository(owner:$owner,name:$repo){
               pullRequest(number:$number){
                 commits(last:1){
                   nodes{
                     commit{
                       oid
                       statusCheckRollup{ state }
                     }
                   }
                 }
                 mergeable
                 mergeStateStatus
                 isDraft
                 maintainerCanModify
               }
             }
           }`,
                    { owner: context.repo.owner, repo: context.repo.repo, number: pull.number }
                )
                prDetails = graphqlResp.repository.pullRequest
                mergeableState = prDetails.mergeable
                mergeStateStatus = prDetails.mergeStateStatus
                if (mergeableState !== 'UNKNOWN') break
                console.log(`#${pull.number} mergeable=UNKNOWN (attempt ${attempt + 1}/${maxAttempts}) waiting 2s`)
                await sleep(2000)
            } catch (error) {
                console.warn(`GraphQL fetch failed for #${pull.number}: ${error.message}`)
                await sleep(1000)
            }
        }

        if (!prDetails) {
            return {
                number: pull.number,
                title: pull.title,
                error: 'GraphQL data unavailable'
            }
        }

        const lastCommitNode = prDetails.commits.nodes[0]
        const rollupState = lastCommitNode?.commit?.statusCheckRollup?.state
        const checksSuccessful = rollupState === 'SUCCESS'
        const mergeCriteriaMet =
            (mergeableState === 'MERGEABLE') &&
            (mergeStateStatus === 'CLEAN') &&
            !prDetails.isDraft

        console.log(JSON.stringify({
            pr: `#${pull.number}`,
            title: pull.title,
            mergeable: mergeableState,
            mergeStateStatus,
            isDraft: prDetails.isDraft,
            maintainerCanModify: prDetails.maintainerCanModify,
            lastCommit: lastCommitNode?.commit?.oid,
            rollupState,
            checksSuccessful,
            mergeCriteriaMet
        }, null, 2))

        return {
            number: pull.number,
            title: pull.title,
            checksOk: checksSuccessful,
            mergeableRaw: mergeableState,
            mergeStateStatus,
            mergeable: mergeCriteriaMet,
            isDraft: prDetails.isDraft
        }
    }))

    const nonMergeable = enrichedPulls.filter(p => !p.mergeable || !p.checksOk)
    if (nonMergeable.length) {
        logSection('NON-MERGEABLE SUMMARY')
        nonMergeable.forEach(p => {
            console.log(`#${p.number} reasons: ${
                [
                    p.error && 'graphql-error',
                    !p.checksOk && 'checks-not-success',
                    !p.mergeable && 'not-clean-or-mergeable',
                    p.isDraft && 'draft'
                ].filter(Boolean).join(', ')
            }`)
        })
    }

    const readyToMerge = enrichedPulls.filter(p => p.checksOk && p.mergeable)
    logSection('READY LIST')
    console.log(readyToMerge.length ? JSON.stringify(readyToMerge, null, 2) : 'No PRs ready.')

    if (!readyToMerge.length) {
        console.log('No PRs qualify for merge this run.')
        return
    }

    const selectedPull = readyToMerge[0]
    logSection(`MERGE PR #${selectedPull.number}`)
    console.log(`Attempting merge of #${selectedPull.number} - ${selectedPull.title}`)

    try {
        const mergeResponse = await github.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: selectedPull.number,
            merge_method: 'squash'
        })
        console.log(`Merge status: ${mergeResponse.status} (sha: ${mergeResponse.data?.sha})`)
    } catch (error) {
        console.error('Merge failed:', error?.response?.status, error?.response?.data || error.message)
        return
    }

    logSection('DISPATCH FOLLOW-UP WORKFLOW')
    try {
        await github.request(
            'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
            {
                owner: context.repo.owner,
                repo: context.repo.repo,
                workflow_id: 'build-and-deploy.yaml',
                ref: 'main'
            }
        )
        console.log('Dispatch sent for build-and-deploy.yaml on ref main.')
    } catch (error) {
        console.error('Failed to dispatch post-merge workflow:', error?.response?.status, error?.response?.data || error.message)
    }

    logSection('DONE')
}
