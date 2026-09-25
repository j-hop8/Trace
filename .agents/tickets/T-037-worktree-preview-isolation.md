# T-037: a worktree's dev server serves the main checkout, so UI tickets verify the wrong code
**Goal:** Make it possible to exercise a `codex/*` (or `claude/*`) worktree in a browser, so a web
ticket's manual acceptance criteria can be checked against the branch rather than against `main`.

**Cause:** `.claude/launch.json` starts the dev server with `npm run dev --prefix web`, and the
preview harness launches it from the *session's project root* — the main checkout — not from the
active worktree. `--prefix web` therefore resolves to `<repo>/web` every time, whatever worktree
the agent believes it is working in. Vite's root is the main checkout, so the browser is served
`main`'s source while the reviewer reads the branch's diff.

Measured during T-035's review: with the worktree at `70ff5b5` (7 occurrences of `map._removed`
in `useDomainLayers.ts`), `curl localhost:5173/src/map/useDomainLayers.ts` returned a module with
**0** occurrences, and the vite process was
`/Users/jimmy/SideProject/Trace/web/node_modules/.bin/vite`. Editing the worktree's
`MapCanvas.tsx` produced no `[vite] hot updated` line at all, because nothing was watching it.

**Not the symlinked deps.** The first diagnosis blamed npm's `--prefix` resolving through the
`web/node_modules` symlink that `codex-delegate` creates (see [[T-039]]). That was wrong:
replacing the symlink with a real `npm ci` inside the worktree changed nothing. The launch cwd is
the whole cause. Worth recording, because the symlink explanation is the plausible one and will
be reached for again.

**Consequence.** T-035 fixed a dev-only Fast Refresh crash whose single acceptance criterion was a
manual HMR check. It could only be verified by detaching the *main* checkout at the branch head
(`git checkout --detach <sha>`), running the preview there, and restoring afterwards — which
leaves the human's working tree on a detached HEAD for the duration and cannot be done at all if
that tree is dirty. Any future web ticket delegated to Codex has the same problem.

**Files in scope:** `.claude/launch.json`; `CLAUDE.md` (a Gotchas entry stating which tree the
preview serves and how to verify a branch); optionally a small script under `web/scripts/` if a
launch entry alone cannot express "start in the directory this config lives in". Plus this
ticket file.

**Do NOT touch:** `web/src/**` — this is tooling, not app code; `pipeline/**`; any ticket in
`.agents/tickets/done/`.

**Acceptance criteria:**
- [ ] With a worktree checked out at a branch that differs from `main` in a `web/src` file,
      starting the preview and fetching that module over HTTP returns the **branch's** source.
- [ ] Editing a file in that worktree logs `[vite] hot updated: <path>` in the browser console.
- [ ] `CLAUDE.md` states plainly which tree the preview serves, so a reviewer who cannot fix it
      still knows not to trust a browser check run from a worktree.
- [ ] If the harness genuinely cannot launch from the worktree, the ticket is closed by
      *documenting* the detach-and-restore procedure instead — with the dirty-tree caveat stated.
- [ ] Ticket file moved to `.agents/tickets/done/`.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check`, plus the browser
check above (fetch a changed module from the worktree's preview and confirm it is the branch's).
**Owner:** claude
