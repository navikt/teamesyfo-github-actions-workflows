# Analyse og anbefalinger – teamesyfo-github-actions-workflows

> Dato: 2026-02-13

## Innholdsfortegnelse

1. [Nåværende tilstand](#nåværende-tilstand)
2. [Funn – Workflows](#funn--workflows)
3. [Funn – Composite Actions](#funn--composite-actions)
4. [Funn – Action-struktur og kompleksitet](#funn--action-struktur-og-kompleksitet)
5. [Duplisering og teknisk gjeld](#duplisering-og-teknisk-gjeld)
6. [Sikkerhet](#sikkerhet)
7. [Anbefalinger](#anbefalinger)
8. [Utfasingsplan](#utfasingsplan)
9. [Migrasjonsrisiko og bakoverkompatibilitet](#migrasjonsrisiko-og-bakoverkompatibilitet)

---

## Nåværende tilstand

### Oversikt over filer

| Type | Fil | Status |
|------|-----|--------|
| **Workflow** | `jar-app.yaml` | ✅ Aktiv – Ktor-apper (shadowJar) |
| **Workflow** | `boot-jar-app.yaml` | ✅ Aktiv – Spring Boot (java-version default 19) |
| **Workflow** | `boot-jar-app-21.yaml` | ✅ Aktiv – Spring Boot (hardkodet Java 21) |
| **Workflow** | `next-app.yaml` | ✅ Aktiv – Next.js-apper |
| **Workflow** | `vite-mikrofrontend.yaml` | ⏳ Fases ut – Vite mikrofrontends |
| **Workflow** | `dependabot-automerge.yaml` | ✅ Aktiv – Ny Dependabot-løsning |
| **Workflow** | `label-dependabot-pr.yaml` | ⛔ Fases ut – Erstattes av dependabot-automerge |
| **Workflow** | `merge-dependabot-pr.yaml` | ⛔ Fases ut – Erstattes av dependabot-automerge |
| **Workflow** | `redis.yaml` | ⛔ Fases ut |
| **Workflow** | `fss-boot-jar-app.yaml` | ⛔ Fases ut – FSS (java-version default 19) |
| **Workflow** | `fss-boot-jar-app-21.yaml` | ⛔ Fases ut – FSS (hardkodet Java 21) |
| **Action** | `gradle-cached/` | ✅ Aktiv – Parametrisert Java-versjon |
| **Action** | `gradle-cached-21/` | ⚠️ Duplikat – Hardkodet Java 21 |
| **Action** | `npm-cached/` | ✅ Aktiv – npm ci + cache |
| **Action** | `jar-to-docker/` | ✅ Aktiv – shadowJar → Docker |
| **Action** | `boot-jar-to-docker/` | ✅ Aktiv – bootJar → Docker |
| **Action** | `next-to-docker/` | ✅ Aktiv – Next.js → Docker |
| **Action** | `playwright-e2e/` | ✅ Aktiv – E2E-tester |

---

## Funn – Workflows

### 1. `jar-app.yaml` (Ktor)
- **Java-versjon default er 19** – dette er gammelt; Java 19 er end-of-life. Nye ktor-apper bør kjøre på 21+.
- Bruker `gradle-cached` action (som også defaulter til 19).
- CodeQL-analyse kjøres som eget jobb med riktige permissions.
- Bygger `shadowJar` – riktig for Ktor.

### 2. `boot-jar-app.yaml` vs `boot-jar-app-21.yaml`
- Nesten identiske workflows. Eneste forskjell er at `-21` hardkoder Java 21 og **ikke** har `java-version` input.
- `boot-jar-app.yaml` har `java-version` input med default `"19"`.
- `-21`-varianten bruker `gradle-cached-21` action (som også er et duplikat).
- **Konklusjon:** Disse to burde vært én workflow. `boot-jar-app.yaml` med oppdatert default (f.eks. `"21"`) ville dekket begge tilfeller.

### 3. `fss-boot-jar-app.yaml` og `fss-boot-jar-app-21.yaml`
- Kopier av boot-jar-app, men deployer til `dev-fss`/`prod-fss` i stedet for `dev-gcp`/`prod-gcp`.
- `fss-boot-jar-app.yaml` default Java 19, men bruker `gradle-cached` uten å sende java-version (!). Den bruker også `boot-jar-to-docker` uten java-version.
- Samme duplikatproblem som GCP-variantene.
- **Skal fases ut når oppfølgingsplanen skrus av.**

### 4. `next-app.yaml`
- Velstrukturert med separate build-per-environment-jobber.
- Bruker `npm-cached` action → `npm ci` med npm cache.
- Hardkodet `npm run lint`, `npm run test`, `npm run build`.
- **Problemstilling npm → pnpm:** Denne workflowen og alle composite actions under den er tett koblet til npm (`npm ci`, `npm run`, `package-lock.json` cache keys). Migrering til pnpm krever endringer i `npm-cached` action, `next-to-docker` action, og selve workflowen.
- Bruker `mikefarah/yq@v4.52.2` – pinnet til tag, bra, men ikke SHA-pinnet.
- Bruker `gacts/github-slug@v1` – kun major tag, bør SHA-pinnes.

### 5. `vite-mikrofrontend.yaml`
- Bruker Node 18 default – gammelt.
- Kjører `npx cypress run --component` – Cypress i stedet for Playwright.
- Bruker `nais/deploy/actions/cdn-upload/v2@master` – peker på `master`-branch, veldig upinnet.
- Bruker `nais/docker-build-push@v0` – major tag uten SHA.
- **Skal fases ut – ikke prioriter forbedringer her.**

### 6. `dependabot-automerge.yaml`
- ✅ Godt strukturert og gjennomtenkt.
- ✅ `dependabot/fetch-metadata` er allerede SHA-pinnet (`21025c705c08248db411dc16f3619e6b5f9ea21a`).
- ✅ Tydelig policy for patch/minor vs major.
- ✅ Bruker `gh pr merge --auto --squash` som respekterer branch protection.
- Eneste kommentar: Bra at denne erstatter det gamle label+merge-opplegget.

### 7. `label-dependabot-pr.yaml` og `merge-dependabot-pr.yaml`
- **Gamle og hacky.** `merge-dependabot-pr.yaml` inneholder et 118-linjers inline JavaScript-skript med GraphQL-kall og ferie-logikk (sommer, jul, nyttår).
- `label-dependabot-pr.yaml` bruker `dependabot/fetch-metadata@v2` – tag uten SHA.
- Disse to krever at det finnes et `automerge`-label i alle repoer, og at `build-and-deploy.yaml` finnes som workflow-filnavn.
- **Bør fjernes så snart alle apper bruker `dependabot-automerge.yaml`.**

### 8. `redis.yaml`
- Enkel deploy av redis-config.
- **Skal fases ut.**

---

## Funn – Composite Actions

### 1. `gradle-cached` vs `gradle-cached-21`
- **Duplikat.** `gradle-cached` aksepterer `java-version` som input (default `"19"`). `gradle-cached-21` er identisk, men hardkoder Java 21 og mangler `java-version`-input.
- `gradle-cached-21` er unødvendig – man kan bare bruke `gradle-cached` med `java-version: "21"`.
- **Begge har et subtilt problem:** Dependency-graph-steget sender `inputs.github_token`, men `github_token` er ikke definert som input i noen av dem. Det betyr at `ORG_GRADLE_PROJECT_githubPassword` alltid vil være tom i dette steget. Dette fungerer tilfeldigvis fordi dependency-graph ikke trenger autentisering for å generere grafen, men det er uansett en feil.

### 2. `npm-cached`
- **Feilaktig description:** Sier "Builds a Next.JS App, creates a docker image" – det stemmer ikke, den installerer bare npm dependencies.
- Setter `NPM_AUTH_TOKEN` som environment variable via `GITHUB_ENV` – dette er litt uelegant men funker.
- Cache-key inkluderer `package-lock.json` – må endres for pnpm (`pnpm-lock.yaml`).
- Kjører `npm ci` – må endres til `pnpm install --frozen-lockfile` for pnpm.
- **Viktig:** `actions/setup-node@v6` har innebygd støtte for `cache: pnpm`, men da må `pnpm` være installert først (typisk med `pnpm/action-setup`).

### 3. `jar-to-docker` (Ktor/shadowJar)
- Bruker `gradle-cached` med `dependency-graph: generate-and-submit`.
- Bygger `shadowJar` – riktig for Ktor.
- Bruker `nais/docker-build-push@v0` – kun major tag.

### 4. `boot-jar-to-docker` (Spring Boot)
- Identisk til `jar-to-docker` bortsett fra at den bygger `bootJar` i stedet for `shadowJar`.
- Samme TRIVY_JAVA_DB_REPOSITORY env.
- Disse to kunne potensielt slås sammen med en input for build-kommando, men forskjellen er liten nok til at separate actions er greit.

### 5. `next-to-docker`
- Avhenger av `npm-cached` – arver npm-avhengigheten.
- Kopierer env-filer fra `nais/envs/.env.$ENV` – tett koblet til prosjektstruktur.
- CDN-upload bruker `nais/deploy/actions/cdn-upload/v2@master` – peker på `master`, bør SHA-pinnes.
- Sender `identity_provider` og `project_id` inputs som **ikke finnes som definerte inputs** i denne action. Dette ser ut som en rest fra en eldre versjon av `cdn-upload`.

### 6. `playwright-e2e`
- ✅ Ren og velstrukturert.
- Gode defaults og konfigurerbare inputs.
- Laster opp rapport som artifact.

---

## Funn – Action-struktur og kompleksitet

### Er composite actions verdt indirektionen?

Repoet har 7 composite actions. Noen abstraherer reell kompleksitet, men flere wrapper bare 2-4 trivielle steg og skaper en indirektion som gjør det vanskelig å se hva som skjer, oppdage feil, og gjøre endringer (f.eks. pnpm-migrering).

| Action | Steg | Vurdering |
|--------|------|-----------|
| `playwright-e2e` | 3 | ✅ **Behold** – Selvstendig, konfigurerbar, tydelig ansvarsområde |
| `jar-to-docker` | 3 | ✅ **Behold** – Samler gradle + build + docker-push, nok kompleksitet |
| `boot-jar-to-docker` | 3 | ✅ **Behold** – Tilsvarende for Spring Boot |
| `gradle-cached` | 5 | ⚠️ **Vurder å inline** – Trivielt (checkout + setup-java + gradle-setup). Feilen med manglende `github_token`-input ble skjult av abstraksjonen |
| `gradle-cached-21` | 5 | ⛔ **Slett** – Duplikat av `gradle-cached` |
| `npm-cached` | 5 | ⚠️ **Vurder å inline** – Bare checkout + setup-node + npm ci. Skjuler caching-logikk man gjerne vil se, spesielt nå med pnpm-migrering |
| `next-to-docker` | 5 | ⚠️ **Grensetilfelle** – Nok steg til å rettferdiggjøre en action, men har ubrukte inputs og feil description. Brukes bare av `next-app.yaml` |

**Hovedargumenter for å inline de enkleste:**
- Man ser hva som faktisk skjer uten å hoppe mellom filer
- Feil som manglende inputs og feil `type:`-parametere blir synlige
- Endringer (som npm → pnpm) kan gjøres direkte i workflowen uten å koordinere action + workflow + konsumenter

**Merk:** Selv `jar-to-docker` og `boot-jar-to-docker` bruker `gradle-cached` internt. Hvis `gradle-cached` inlines, bør stegene flyttes inn i disse to docker-actionene i stedet.

### `type:`-parameter i composite action inputs

`npm-cached` og `next-to-docker` bruker `type:` på sine inputs. Dette er **kun gyldig i `workflow_call`-inputs**, ikke i composite actions – der er alle inputs implisitt strings. Parameteren ignoreres av GitHub Actions men gir warnings i IDE-er. Bør fjernes.

---

## Duplisering og teknisk gjeld

### Duplikater som bør konsolideres

1. **`gradle-cached` + `gradle-cached-21`** → Kan bli én action med parametrisert java-version (eksisterer allerede i `gradle-cached`). Oppdater default fra `"19"` til `"21"`.

2. **`boot-jar-app.yaml` + `boot-jar-app-21.yaml`** → Kan bli én workflow. `boot-jar-app.yaml` har allerede `java-version` input, bare oppdater default.

3. **`fss-boot-jar-app.yaml` + `fss-boot-jar-app-21.yaml`** → Skal fases ut, men er i praksis identiske med GCP-varianten bortsett fra cluster-navnet. Kunne vært løst med en `cluster`-input.

4. **`boot-jar-app.yaml` + `jar-app.yaml`** → Svært like. Forskjellen er `bootJar` vs `shadowJar` og ulike `*-to-docker`-actions. Vurder om disse kan slås sammen med en `build-type`-input, eller behold dem separate (de tjener tydelig ulike app-typer).

### Java-versjon default
- Alle workflows og actions defaulter til Java 19 (EOL). Bør oppdateres til **21** (nåværende LTS).

### Node.js-versjon
- `next-app.yaml` defaulter til `"20.x"` – dette er ok men vil snart gå EOL (april 2026). Vurder å oppdatere til 22 når appene er klare.
- `vite-mikrofrontend.yaml` defaulter til `"18"` – men fases ut.

---

## Sikkerhet

### SHA-pinning status

| Action | Nåværende referanse | Vurdering |
|--------|-------------------|-----------|
| `actions/checkout` | `@v6` | ⚠️ Bør SHA-pinnes |
| `actions/setup-java` | `@v5` | ⚠️ Bør SHA-pinnes |
| `actions/setup-node` | `@v6` | ⚠️ Bør SHA-pinnes |
| `actions/cache` | `@v5` | ⚠️ Bør SHA-pinnes |
| `actions/upload-artifact` | `@v4` | ⚠️ Bør SHA-pinnes |
| `github/codeql-action/*` | `@v4` | ⚠️ Bør SHA-pinnes |
| `gradle/actions/*` | `@v5` | ⚠️ Bør SHA-pinnes |
| `nais/deploy/actions/deploy` | `@v2` | ⚠️ Bør SHA-pinnes |
| `nais/docker-build-push` | `@v0` | ⚠️ Bør SHA-pinnes |
| `nais/deploy/actions/cdn-upload/v2` | `@master` | 🔴 Høy risiko – branch-ref |
| `mikefarah/yq` | `@v4.52.2` | ⚠️ Tag, bør SHA-pinnes |
| `gacts/github-slug` | `@v1` | ⚠️ Bør SHA-pinnes |
| `dependabot/fetch-metadata` | SHA-pinnet ✅ | ✅ Bra (i automerge) |
| `dependabot/fetch-metadata` | `@v2` (i label-pr) | ⚠️ Men denne fases ut |
| `actions/github-script` | `@v8` | ⚠️ Men denne fases ut |

**Anbefaling:** Alle third-party actions bør SHA-pinnes med en kommentar som viser versjonsnummeret, f.eks.:
```yaml
uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
```

### Andre sikkerhetsfunn
- `npm-cached` action leaker `NPM_AUTH_TOKEN` via `GITHUB_ENV`. Selv om dette er `GITHUB_TOKEN` (begrenset scope), er det bedre praksis å bruke `.npmrc`-fil eller sette det direkte i step-env.
- `contents: write` permissions i build-jobber er bredere enn nødvendig. Build-jobber trenger typisk bare `contents: read`.

---

## Anbefalinger

### Prioritet 1 – Rydding (lav risiko)

1. **Fjern `label-dependabot-pr.yaml` og `merge-dependabot-pr.yaml`** når alle apper har gått over til `dependabot-automerge.yaml`. Koordiner med teamet for å verifisere at ingen apper fremdeles bruker de gamle workflowene.

2. **Fjern `redis.yaml`** når den ikke lenger er i bruk.

3. **Fjern `fss-boot-jar-app.yaml` og `fss-boot-jar-app-21.yaml`** når oppfølgingsplanen er skrudd av.

4. **Fjern `gradle-cached-21/`** etter at alle apper som bruker den er migrert til `gradle-cached` med `java-version: "21"`.

### Prioritet 2 – Konsolidering og action-opprydding (middels risiko)

5. **Slå sammen `boot-jar-app.yaml` og `boot-jar-app-21.yaml`** til én workflow med oppdatert default Java-versjon (21). Apper som bruker `-21`-varianten oppdateres til å bruke `boot-jar-app.yaml` med `java-version: "21"` (som blir ny default, så de trenger ikke sende den eksplisitt).

6. **Oppdater alle Java-defaults fra `"19"` til `"21"`** i `gradle-cached`, `jar-to-docker`, `boot-jar-to-docker`, `jar-app.yaml`, og `boot-jar-app.yaml`. Sjekk at ingen apper faktisk trenger Java 19 først.

7. **Fiks `gradle-cached` action** – legg til `github_token` som definert input, eller fjern referansen til `inputs.github_token` i dependency-graph-steget.

8. **Fiks `npm-cached` description** – den sier "Builds a Next.JS App, creates a docker image" men gjør bare npm install.

9. **Fiks `next-to-docker` action** – fjern referansene til `identity_provider` og `project_id` som sendes til `cdn-upload` men ikke er definert som inputs.

10. **Fjern `type:`-parameter** fra alle composite action inputs (`npm-cached`, `next-to-docker`) – ikke gyldig i composite actions.

11. **Vurder å inline `gradle-cached`** i `jar-to-docker` og `boot-jar-to-docker` (de eneste reelle konsumentene), og inline `npm-cached` i `next-to-docker` eller direkte i `next-app.yaml`. Dette fjerner et lag med indirektion og gjør pnpm-migreringen enklere.

### Prioritet 3 – Sikkerhet (viktig men krever koordinering)

12. **SHA-pinne alle third-party actions.** Start med de mest kritiske:
    - `nais/deploy/actions/cdn-upload/v2@master` → SHA-pin (denne peker på en branch!)
    - `nais/docker-build-push@v0` → SHA-pin
    - `actions/checkout`, `actions/setup-java`, `actions/setup-node` osv.
    
    Tips: Bruk [StepSecurity/secure-repo](https://github.com/step-security/secure-repo) eller [pin-github-action](https://github.com/mheap/pin-github-action) for å automatisere dette.

13. **Stram inn permissions.** Fjern `contents: write` der det ikke trengs (f.eks. build-jobber som bare trenger `read`).

### Prioritet 4 – npm → pnpm migrering

14. **Legg til en `package-manager` input** (med default `npm`) i `npm-cached` action, `next-to-docker` action, og `next-app.yaml` workflow. Da kan apper gradvis sende `package-manager: pnpm` uten at eksisterende apper påvirkes. Endringene inkluderer:
    - I `npm-cached`: Betinget bruk av `pnpm/action-setup`, `cache: pnpm`, `pnpm install --frozen-lockfile`, og cache basert på `pnpm-lock.yaml`.
    - I `next-to-docker`: Bruk riktig `pnpm run build` / `npm run build` basert på input.
    - I `next-app.yaml`: Videresend `package-manager`-input til actions.

    Hvis `npm-cached` og/eller `next-to-docker` er inlinet (jf. punkt 11), gjøres endringene direkte i workflowen i stedet.

### Prioritet 5 – Langsiktige forbedringer

15. **Vurder å fjerne `vite-mikrofrontend.yaml`** etter at siste Vite-app er migrert eller faset ut.

16. **Vurder å konsolidere `jar-app.yaml` og `boot-jar-app.yaml`** med en `build-command` input (shadowJar vs bootJar). Kun hvis teamet synes det gir mening – separate workflows er også ok for tydelighet.

17. **Oppdater README.md** til å reflektere nåværende tilstand, inkludert utfasingsinfo og ny `dependabot-automerge` workflow-dokumentasjon (delvis allerede gjort).

18. **Legg til dependabot-config for `playwright-e2e`** action i `.github/dependabot.yml` – den mangler i dag.
---

## Utfasingsplan

### Fase 1 – Kan gjøres nå
| Handling | Avhengighet |
|----------|-------------|
| Kommuniser til teamet at `label-dependabot-pr` og `merge-dependabot-pr` er deprecated | Ingen |
| Verifiser at ingen apper bruker `redis.yaml` | Sjekk i repoene |
| Oppdater Java-default til 21 | Sjekk at alle apper kjører 21 |

### Fase 2 – Når apper er migrert
| Handling | Avhengighet |
|----------|-------------|
| Slett `label-dependabot-pr.yaml` og `merge-dependabot-pr.yaml` | Alle apper bruker `dependabot-automerge.yaml` |
| Slett `redis.yaml` | Ingen apper bruker den |
| Slett `gradle-cached-21/` | Alle apper bruker `gradle-cached` med java-version input |
| Slett `boot-jar-app-21.yaml` | Alle apper bruker `boot-jar-app.yaml` |

### Fase 3 – Når oppfølgingsplanen er av
| Handling | Avhengighet |
|----------|-------------|
| Slett `fss-boot-jar-app.yaml` og `fss-boot-jar-app-21.yaml` | Oppfølgingsplanen er skrudd av |

### Fase 4 – Når Vite-apper er faset ut
| Handling | Avhengighet |
|----------|-------------|
| Slett `vite-mikrofrontend.yaml` | Ingen Vite-apper igjen |

---

## Migrasjonsrisiko og bakoverkompatibilitet

### Lav risiko (bakoverkompatibelt)
- SHA-pinning av actions – ingen funksjonell endring.
- Fiks av feil description i `npm-cached`.
- Legge til `github_token` input i `gradle-cached`.
- Legge til Playwright i dependabot-config.

### Middels risiko (krever koordinert utrulling)
- **Endre Java-default fra 19 til 21:** Alle apper som ikke eksplisitt setter java-version vil få ny versjon. Sjekk at alle apper faktisk bygger med Java 21 først.
- **Slå sammen boot-jar-app workflows:** Apper som bruker `-21`-varianten må oppdatere sin workflow-referanse.
- **Slette gradle-cached-21:** Apper som bruker den direkte må oppdateres først.

### Høy risiko (gjør gradvis)
- **npm → pnpm migrering:** Bør gjøres med en ny input (package-manager) med default `npm`, slik at eksisterende apper ikke påvirkes. Test med én app først før bredere utrulling.
- **Fjerne gamle dependabot-workflows:** Verifiser at absolutt alle apper har migrert først, ellers stopper auto-merge.

---

*Dette dokumentet er en analyse uten kodeendringer. Diskuter funnene i teamet og prioriter basert på kapasitet og risikovilje.*
