# Team eSyfo workflows

- Reusable workflows ligger i `.github/workflows/`, composite actions i
  `actions/`. `README.md` og `docs/` beskriver kontraktene for caller-repoene;
  endringer i inputs, secrets, outputs og jobbnavn kan kreve endringer der.
- Nye Next.js-oppsett bruker `next-app-v2.yaml` med pnpm. `next-app.yaml` og
  npm-actionene vedlikeholdes for eksisterende brukere.
- Next.js merge queue skal bygge og teste, men ikke publisere CDN-/Docker-
  artefakter eller deploye. Behold sperrene for både `merge_group` og push til
  `refs/heads/gh-readonly-queue/`, samt actionens `publish-artifacts`-input.
- Kontroller køkontrakten med
  `ruby .github/scripts/validate-next-app-queue-policy.rb`.
