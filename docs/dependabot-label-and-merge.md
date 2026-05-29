# Dependabot-workflows med label og merge

Denne guiden dekker disse workflowene:

- `.github/workflows/label-dependabot-pr.yaml`
- `.github/workflows/merge-dependabot-pr.yaml`

De kan fortsatt brukes, men for nye oppsett anbefaler vi [docs/dependabot-automerge.md](dependabot-automerge.md), fordi den samler godkjennings- og merge-logikken bedre.

## Hva workflowene gjør

### `label-dependabot-pr.yaml`

- kjører bare for PR-er fra `dependabot[bot]` som ikke kommer fra fork
- henter Dependabot-metadata
- godkjenner patch- og minor-oppdateringer
- legger på labelen `automerge`

### `merge-dependabot-pr.yaml`

- finner åpne PR-er med labelen `automerge`
- sjekker at siste commit har grønne status checks
- merger den første mergeable PR-en med squash
- starter deretter workflowen `build-and-deploy.yaml` på `main`
- hopper over kjøring i faste ferieperioder rundt sommer, jul og nyttår

## Når workflowene fortsatt kan passe

Workflowene kan fortsatt være riktige hvis consumer-repoet allerede er satt opp rundt `automerge`-label og en egen merge-workflow.

For nye oppsett er `dependabot-automerge.yaml` anbefalt, fordi den bruker GitHub sin auto-merge-flyt i én samlet workflow.

## Kort migreringsanvisning

Hvis du vil gå over til anbefalt oppsett:

1. Legg til en caller workflow som bruker `.github/workflows/dependabot-automerge.yaml`.
2. Legg inn `APP_PRIVATE_KEY` som Dependabot secret i consumer-repoet.
3. Slå på auto-merge og workflow-tillatelser i repository settings.
4. Sørg for at required checks er på plass. Hvis repoet bruker merge queue, må CI-workflowen også lytte på `merge_group`.
5. Når det nye oppsettet er verifisert, kan du slutte å kalle disse workflowene i consumer-repoet.

Se [docs/dependabot-automerge.md](dependabot-automerge.md) for komplett oppsett og feilsøking.
