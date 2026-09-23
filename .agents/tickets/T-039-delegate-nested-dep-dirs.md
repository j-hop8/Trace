# T-039: `codex-delegate` only links deps at the repo root, so Trace worktrees get none
**Goal:** Make the delegation helper link (or install) dependencies wherever a repo actually keeps
them, and tell Codex which paths it must not touch — so a delegated ticket's Verify command can
run at all.

**⚠️ Scope is outside this repository.** The file is `~/.local/bin/codex-delegate`, global
tooling shared by every repo on this machine. It cannot be changed by a Trace PR and `/ship` does
not apply. This ticket exists as the record of the defect and its fix; closing it means editing
the script locally and moving the file to `done/` in a normal Trace commit.

**Cause:** `link_deps()` checks only two fixed paths at the repo root:

```sh
for d in node_modules .venv; do
  if [[ -d $REPO/$d && ! -e $wt/$d ]]; then ln -s "$REPO/$d" "$wt/$d"; LINKED+=("$d"); fi
done
```

Trace keeps its dependencies at `web/node_modules` and `pipeline/.venv`, so neither test fires.
Nothing is linked, `LINKED` stays empty, and `$DEPS_NOTE` — the sentence that tells Codex not to
touch the shared directories — is appended to the prompt as an empty string.

**Consequence.** Codex lands in a worktree with no dependencies and a Verify command
(`cd web && npm run typecheck && npm test && npm run format:check`) that cannot run, in a sandbox
with no network to install them. During T-035 this was papered over by linking
`web/node_modules` by hand before the run; nothing in the flow would have caught it otherwise,
and the failure mode is a Codex run that burns quota and reports a blocker.

**Suggested shape:** discover dependency directories rather than hardcoding root paths — e.g.
link every `node_modules` beside a `package.json` and every `.venv` beside a `pyproject.toml`, to
a bounded depth — and keep populating `LINKED` so `$DEPS_NOTE` names them.

**A linked directory is shared, not copied.** Codex reinstalling or pruning through the symlink
would mutate the human's main checkout. `$DEPS_NOTE` is the only thing standing between Codex and
that, which is why an empty note is worse than no link at all. Consider linking read-only, or
installing into the worktree instead.

**Related:** a linked `node_modules` is also not ignored by Trace's `.gitignore` ([[T-038]]), and
linking is *not* why a worktree's dev server serves the wrong tree ([[T-037]]).

**Files in scope:** `~/.local/bin/codex-delegate` (`link_deps`, and the `DEPS_NOTE` assembly);
this ticket file.

**Do NOT touch:** `~/.codex/*.toml` profiles; `~/.claude/skills/**`; anything inside this repo
other than moving this ticket to `done/`.

**Acceptance criteria:**
- [ ] Running `codex-delegate` on Trace links `web/node_modules` and, when present,
      `pipeline/.venv` into the worktree without manual help.
- [ ] `$DEPS_NOTE` names every linked path, so Codex's prompt says which directories are shared.
- [ ] A repo that does keep deps at the root still works unchanged.
- [ ] A dry run on Trace ends with a worktree where `cd web && npm test` passes immediately.
- [ ] Ticket file moved to `.agents/tickets/done/`.

**Verify:** from a clean Trace checkout, `codex-delegate --local <a throwaway ticket>` produces a
worktree in which `cd web && npm run typecheck && npm test && npm run format:check` passes with no
manual dependency setup.
**Owner:** claude
