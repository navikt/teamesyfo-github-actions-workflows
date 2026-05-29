# Team eSyfo reusable GitHub Actions workflows

Dette repoet samler reusable workflows og composite actions for Team eSyfo sine GitHub-repoer. README-en er en kort inngangsside. Detaljerte oppsettguider ligger i [docs/](docs/).

## Reusable workflows for consumer-repoer

| Workflow-fil                                  | Kort beskrivelse                                                                                                              | Mer dokumentasjon                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `.github/workflows/next-app.yaml`             | Next.js-workflow med `npm`, `actions/npm-cached` og `actions/next-to-docker`. **New apps shall not use npm!**                 | [docs/next-app.md](docs/next-app.md)                                     |
| `.github/workflows/next-app-v2.yaml`          | Next.js-workflow med `pnpm`, `actions/setup-pnpm`, `actions/build-next-app`, merge-gate og `merge_group`-guard i deploy-steg. | [docs/next-app.md](docs/next-app.md)                                     |
| `.github/workflows/jar-app.yaml`              | JVM-workflow for `shadowJar`-baserte apper i GCP.                                                                             | [docs/jvm-app.md](docs/jvm-app.md)                                       |
| `.github/workflows/boot-jar-app.yaml`         | JVM-workflow for `bootJar`-baserte apper i GCP.                                                                               | [docs/jvm-app.md](docs/jvm-app.md)                                       |
| `.github/workflows/fss-boot-jar-app.yaml`     | JVM-workflow for `bootJar`-baserte apper i FSS.                                                                               | [docs/jvm-app.md](docs/jvm-app.md)                                       |
| `.github/workflows/dependabot-automerge.yaml` | Anbefalt workflow for auto-approval og auto-merge av trygge Dependabot-PR-er.                                                 | [docs/dependabot-automerge.md](docs/dependabot-automerge.md)             |
| `.github/workflows/label-dependabot-pr.yaml`  | Godkjenner patch/minor-oppdateringer og legger på `automerge`-label. For nye oppsett anbefales `dependabot-automerge.yaml`.   | [docs/dependabot-label-and-merge.md](docs/dependabot-label-and-merge.md) |
| `.github/workflows/merge-dependabot-pr.yaml`  | Merger én PR med `automerge`-label og grønne checks. For nye oppsett anbefales `dependabot-automerge.yaml`.                   | [docs/dependabot-label-and-merge.md](docs/dependabot-label-and-merge.md) |

## Composite actions

| Action                       | Kort beskrivelse                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `actions/build-next-app`     | Setter opp `pnpm`, bygger Next.js-appen, laster opp statiske filer til CDN og bygger Docker-image. |
| `actions/next-to-docker`     | Setter opp `npm`, bygger Next.js-appen, laster opp statiske filer til CDN og bygger Docker-image.  |
| `actions/jar-to-docker`      | Bygger `shadowJar` og bygger Docker-image.                                                         |
| `actions/boot-jar-to-docker` | Bygger `bootJar` og bygger Docker-image.                                                           |
| `actions/setup-pnpm`         | Setter opp Node.js, `pnpm` og installerer avhengigheter med cache.                                 |
| `actions/npm-cached`         | Setter opp Node.js og installerer `npm`-avhengigheter med cache. **Legacy!**                       |
| `actions/gradle-cached`      | Setter opp Java og Gradle, validerer wrapper og bruker Gradle-cache.                               |
| `actions/playwright-e2e`     | Installerer Playwright-browsere, kjører E2E-tester og laster opp rapport.                          |

## Oppsettguider

- [docs/next-app.md](docs/next-app.md) — oppsett for `next-app-v2.yaml`
- [docs/jvm-app.md](docs/jvm-app.md) — oppsett for `jar-app.yaml`, `boot-jar-app.yaml` og `fss-boot-jar-app.yaml`
- [docs/dependabot-automerge.md](docs/dependabot-automerge.md) — anbefalt oppsett for Dependabot auto-merge
- [docs/dependabot-label-and-merge.md](docs/dependabot-label-and-merge.md) — oppsett for `label-dependabot-pr.yaml` og `merge-dependabot-pr.yaml`

## Kontakt

Dette prosjektet vedlikeholdes av [navikt/team-esyfo](CODEOWNERS).

Jobber du i [@navikt](https://github.com/navikt), kan du kontakte oss i Slack-kanalen [#esyfo](https://nav-it.slack.com/archives/C012X796B4L).
