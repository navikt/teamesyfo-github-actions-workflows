# Team eSyfo reusable GitHub Actions workflows

Dette repoet samler reusable workflows og composite actions for Team eSyfo sine GitHub-repoer. README-en er en kort inngangsside. Detaljerte oppsettguider ligger i [docs/](docs/).

## Reusable workflows for consumer-repoer

| Workflow-fil                                  | Kort beskrivelse                                                                                                              | Mer dokumentasjon                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `.github/workflows/next-app-v2.yaml`          | Next.js-workflow med `pnpm`, `actions/setup-pnpm`, `actions/build-next-app`, merge-gate og sperrer mot publisering og deploy fra merge queue. | [docs/next-app.md](docs/next-app.md)                         |
| `.github/workflows/jar-app.yaml`              | JVM-workflow for `shadowJar`-baserte apper i GCP.                                                                             | [docs/jvm-app.md](docs/jvm-app.md)                           |
| `.github/workflows/dependabot-automerge-v2.yaml` | Godkjenner og merger trygge Dependabot-PR-er etter tidsplan. Nøkkelen til GitHub-appen ligger i et miljø som bare default-branchen får bruke. | [docs/dependabot-automerge.md](docs/dependabot-automerge.md) |
| `.github/workflows/next-app.yaml`             | **Legacy!** Next.js-workflow med `npm`, `actions/npm-cached` og `actions/next-to-docker`. **New apps shall not use npm!**     | [docs/next-app.md](docs/next-app.md)                         |
| `.github/workflows/boot-jar-app.yaml`         | **Legacy!** JVM-workflow for `bootJar`-baserte apper i GCP.                                                                   | [docs/jvm-app.md](docs/jvm-app.md)                           |
| `.github/workflows/dependabot-automerge.yaml` | **Utgått!** Første versjon av Dependabot-automerge. Bytt til `dependabot-automerge-v2.yaml`.                                 | [Migrering fra v1](docs/dependabot-automerge.md#migrate-from-v1) |

## Composite actions

| Action                       | Kort beskrivelse                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `actions/build-next-app`     | Setter opp `pnpm`, bygger Next.js-appen, laster opp statiske filer til CDN og bygger Docker-image.            |
| `actions/jar-to-docker`      | Bygger `shadowJar` og bygger Docker-image.                                                                    |
| `actions/setup-pnpm`         | Setter opp Node.js, `pnpm` og installerer avhengigheter med cache.                                            |
| `actions/gradle-cached`      | Setter opp Java og Gradle, validerer wrapper og bruker Gradle-cache.                                          |
| `actions/playwright-e2e`     | Installerer Playwright-browsere, kjører E2E-tester og laster opp rapport.                                     |
| `actions/dependabot-automerge` | Motoren i `dependabot-automerge-v2.yaml`. Brukes gjennom workflowen, ikke direkte.                          |
| `actions/next-to-docker`     | **Legacy!** Setter opp `npm`, bygger Next.js-appen, laster opp statiske filer til CDN og bygger Docker-image. |
| `actions/boot-jar-to-docker` | **Legacy!** Bygger `bootJar` og bygger Docker-image.                                                          |
| `actions/npm-cached`         | **Legacy!** Setter opp Node.js og installerer `npm`-avhengigheter med cache.                                  |

## Oppsettguider

- [docs/next-app.md](docs/next-app.md) — oppsett for `next-app-v2.yaml`
- [docs/jvm-app.md](docs/jvm-app.md) — oppsett for `jar-app.yaml`; **Legacy!**: `boot-jar-app.yaml`
- [docs/dependabot-automerge.md](docs/dependabot-automerge.md) — oppsett for `dependabot-automerge-v2.yaml` og migrering fra v1

## Kontakt

Dette prosjektet vedlikeholdes av [navikt/team-esyfo](CODEOWNERS).

Jobber du i [@navikt](https://github.com/navikt), kan du kontakte oss i Slack-kanalen [#esyfo](https://nav-it.slack.com/archives/C012X796B4L).
