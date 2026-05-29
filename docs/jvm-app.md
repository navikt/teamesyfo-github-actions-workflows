# JVM-workflows

Denne guiden dekker de tre JVM-workflowene i repoet:

- `.github/workflows/jar-app.yaml`
- `.github/workflows/boot-jar-app.yaml`
- `.github/workflows/fss-boot-jar-app.yaml`

Alle tre bygger Docker-image og deployer med `nais/deploy/actions/deploy`. Forskjellen ligger først og fremst i artifact-type, build-steg, cluster og merge-gate.

## Sammenligning

| Workflow-fil            | Artifact-type | Build-action                 | CodeQL-build                                                                                                                         | Test-kommando     | Cluster                 | Merge-gate | Deploy-betingelser                                                                               |
| ----------------------- | ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `jar-app.yaml`          | `shadowJar`   | `actions/jar-to-docker`      | Kjører `github/codeql-action/init` med `tools: linked`, og deretter `./gradlew clean shadowJar -x test --no-daemon --no-build-cache` | `./gradlew test`  | `dev-gcp` og `prod-gcp` | Ja         | `deploy-dev` hopper over Dependabot og draft pull requests. `deploy-prod` kjører bare på `main`. |
| `boot-jar-app.yaml`     | `bootJar`     | `actions/boot-jar-to-docker` | `./gradlew bootJar -x test` etter `actions/setup-java`                                                                               | `./gradlew check` | `dev-gcp` og `prod-gcp` | Ja         | `deploy-dev` hopper over Dependabot og draft pull requests. `deploy-prod` kjører bare på `main`. |
| `fss-boot-jar-app.yaml` | `bootJar`     | `actions/boot-jar-to-docker` | `./gradlew bootJar -x test` etter `actions/setup-java`                                                                               | `./gradlew test`  | `dev-fss` og `prod-fss` | Nei        | `deploy-dev` hopper over Dependabot og draft pull requests. `deploy-prod` kjører bare på `main`. |

## Felles inputs

| Input          | Påkrevd | Standard | Beskrivelse                                                       |
| -------------- | ------- | -------- | ----------------------------------------------------------------- |
| `app`          | Ja      | –        | Navn på applikasjonen.                                            |
| `java-version` | Nei     | `19`     | Java-versjon for `actions/setup-java` og `actions/gradle-cached`. |

## Krav i consumer-repoet

1. Opprett en caller-workflow i consumer-repoet som bruker den reusable workflowen med `secrets: inherit`.
2. Ha en `Dockerfile` i rotmappen som passer til artifactet prosjektet bygger.
3. Ha NAIS-manifester i `nais/`:
   - `nais/nais-dev.yaml`
   - `nais/nais-prod.yaml`
4. Prosjektet må bruke Gradle wrapper. `actions/gradle-cached` validerer wrapperen og setter opp Gradle-cache.
5. Hvis prosjektet henter private avhengigheter fra GitHub Packages, bruker workflowene `ORG_GRADLE_PROJECT_githubUser=x-access-token` og `ORG_GRADLE_PROJECT_githubPassword=${{ secrets.GITHUB_TOKEN }}` i build- og test-steg.

## Velg riktig workflow

### `jar-app.yaml`

Bruk denne når applikasjonen bygger en `shadowJar`.

Det er også den eneste av de tre workflowene som i analysejobben først kjører CodeQL-init med `tools: linked` og deretter bygger `shadowJar`.

```yaml
name: Build and deploy

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  jar-app:
    uses: navikt/teamesyfo-github-actions-workflows/.github/workflows/jar-app.yaml@main
    secrets: inherit
    with:
      app: my-jar-app
```

### `boot-jar-app.yaml`

Bruk denne når applikasjonen bygger en `bootJar` og skal deployes til GCP.

Workflowen kjører `./gradlew check` i testjobben og har en egen `merge-gate`-jobb for branch protection.

```yaml
name: Build and deploy

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  boot-jar-app:
    uses: navikt/teamesyfo-github-actions-workflows/.github/workflows/boot-jar-app.yaml@main
    secrets: inherit
    with:
      app: my-boot-app
```

### `fss-boot-jar-app.yaml`

Bruk denne når applikasjonen bygger en `bootJar` og skal deployes til FSS.

Denne workflowen deployer til `dev-fss` og `prod-fss`. Den har ikke egen `merge-gate`.

```yaml
name: Build and deploy

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  fss-boot-jar-app:
    uses: navikt/teamesyfo-github-actions-workflows/.github/workflows/fss-boot-jar-app.yaml@main
    secrets: inherit
    with:
      app: my-fss-boot-app
```
