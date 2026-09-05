# T-008: Move off end-of-life Node, and clear the esbuild advisory
**Goal:** Get the web toolchain onto a supported runtime. These two problems share one fix, which
is why they are one ticket.

**Files in scope:** `web/package.json`, `web/package-lock.json`, `.github/workflows/ci.yml`,
`.nvmrc` (new), `CLAUDE.md` (commands table)

**Do NOT touch:** application source under `web/src/`, `pipeline/`.

## Why

**1. Node 20 is end-of-life.** Security support ended 2026-04-30; the machine this repo was
scaffolded on runs v20.15.0. Node 22 has security support to 2027-04-30, Node 24 to 2028-04-30.
A new project should not start on an unsupported runtime.

**2. `npm audit` reports a moderate esbuild advisory** (GHSA-67mh-4wv8-2f99) reached through
Vite 5. Scope is the dev server only — any website you visit while `npm run dev` is running can
send it requests and read the responses. Not a production risk for a static site, but a real one
for whoever is developing.

The fix is the same action: **Vite 7+ requires Node `^20.19.0 || >=22.12.0`.** Upgrading Node
unblocks the Vite upgrade, which drops the vulnerable esbuild. Doing them separately does not
work — that is why this was not fixed during T-000.

Secondary: `@mapbox/jsonlint-lines-primitives` (via `maplibre-gl`) declares `engines.node >= 22`,
so `npm install` currently prints an EBADENGINE warning on every run.

## Steps

1. `brew install node@22` (or 24). Note this is a **global** change — `Veil`, `tutor_pet`, and
   `pocket_pilot` share the same `node` on PATH. Check they still build, or scope the version
   per-project with `.nvmrc` and a version manager.
2. Add `.nvmrc` and an `engines` field to `web/package.json`.
3. Bump Vite to ^7 and `@vitejs/plugin-react` to match. Regenerate the lockfile.
4. Bump `node-version` in `.github/workflows/ci.yml` to match `.nvmrc`.

## Acceptance criteria
- [x] `npm install` completes with no EBADENGINE warning.
- [x] `npm audit` reports zero moderate-or-higher vulnerabilities.
- [x] `npm run typecheck`, `npm run build`, and `npm run dev` all pass on the new Node.
- [x] CI's Node version and `.nvmrc` agree — a drift here means CI stops testing what runs locally.
- [x] The other three side projects still build, or the version is scoped per-project.

**Verify:** `cd web && npm ci && npm audit && npm run build`
**Owner:** claude
