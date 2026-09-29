# T-039: `codex-delegate` only links deps at the repo root, so Trace worktrees get none
**Goal:** Make the delegation helper link (or install) dependencies wherever a repo actually keeps
them, and tell Codex which paths it must not touch — so a delegated ticket's Verify command can
run at all, and so that when it runs it **tests the worktree's code rather than the main
checkout's**.

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

**A linked `pipeline/.venv` tests the wrong code — found delegating T-045 (2026-09-27).**
Linking the venv is not enough, and done naively it is worse than no venv: the Verify command
passes against code that is not the ticket's.

- `pipeline/.venv` holds an *editable install of the main checkout*.
  `__editable___trace_pipeline_0_1_0_finder.py` maps `trace_pipeline` to
  `/Users/jimmy/SideProject/Trace/pipeline/trace_pipeline`, whichever directory the venv is
  reached from.
- Plain `pytest` starts with `sys.path[0]` set to the venv's `bin/`, so the worktree's own
  `pipeline/` is not on the path and `import trace_pipeline` falls through to the editable
  finder, which loads the **main checkout's** code. Measured in the T-045 worktree: a bare import
  resolved to `…/Trace/pipeline/trace_pipeline`; `python -m pytest` run from the worktree's
  `pipeline/` resolved to `…/.worktrees/T-045/pipeline/trace_pipeline`.
- The failure is silent. Codex's tests import unchanged code, pass, and the ticket's change is
  never exercised.
- **`PYTHONPATH` fixes it for every invocation**, plain `pytest` included. setuptools *appends*
  its editable finder to `sys.meta_path`, after the normal path search, so an entry on
  `PYTHONPATH` wins. Verified: with `PYTHONPATH` pointing at a copy of the package, the copy was
  imported and the editable mapping was ignored.
- A second quiet skip: `tippecanoe`, `tippecanoe-decode` and `pmtiles` live in
  `/opt/homebrew/bin`, which a non-interactive shell may not have on `PATH`. The archive-building
  tests `skipif` without them, so Verify goes green having built nothing.

T-045 was delegated by hand around both. The venv was symlinked, the ticket's Verify became
`cd pipeline && PATH="/opt/homebrew/bin:$PATH" .venv/bin/python -m pytest -rs`, and an
Environment section told Codex why. That works for one ticket, but it depends on every future
ticket author remembering it.

**Suggested shape for the venv:** when the helper links a `.venv`, also run Codex with
`PYTHONPATH` set to the directory holding the linked package (for Trace, `$wt/pipeline`), and
put `/opt/homebrew/bin` on its `PATH` when it exists. Before handing over, check that the
worktree's venv imports the package from inside the worktree (`python -c 'import trace_pipeline;
print(trace_pipeline.__file__)'` run from outside it) and refuse to start Codex if it does not.
Say all of this in `$DEPS_NOTE`.

**Cleanup is safe, as measured:** `gh pr merge --delete-branch` removed the T-045 worktree
directory itself, symlink included, and the main checkout's venv survived intact (342 tests
passed on `main` after). `git worktree remove` then reports "not a working tree", which is
harmless.

**Related:** a linked `node_modules` is also not ignored by Trace's `.gitignore` ([[T-038]]), and
linking is *not* why a worktree's dev server serves the wrong tree ([[T-037]]). T-037's trap is
this one's twin: there the *preview* resolved to the main checkout, here the *tests* do. Both
pass while checking the wrong code. The manual steps in the `/delegate` skill have the same gap,
but `~/.claude/skills/**` is outside this ticket; fix it there separately once the helper is
right.

**Files in scope:** `~/.local/bin/codex-delegate` (`link_deps`, and the `DEPS_NOTE` assembly);
this ticket file.

**Do NOT touch:** `~/.codex/*.toml` profiles; `~/.claude/skills/**`; anything inside this repo
other than moving this ticket to `done/`.

**Acceptance criteria:**
- [x] Running `codex-delegate` on Trace links `web/node_modules` and, when present,
      `pipeline/.venv` into the worktree without manual help.
- [x] `$DEPS_NOTE` names every linked path, so Codex's prompt says which directories are shared.
- [x] A repo that does keep deps at the root still works unchanged.
- [x] A dry run on Trace ends with a worktree where `cd web && npm test` passes immediately.
- [x] In that worktree, under the environment Codex is given, **plain** `pytest` imports
      `trace_pipeline` from the worktree, not the main checkout. Check it by printing
      `trace_pipeline.__file__`, not by a green run.
- [x] The helper refuses to start Codex when that import check fails.
- [x] Under the same environment, `pytest -rs` in `pipeline/` skips nothing that needs
      tippecanoe or pmtiles.
- [x] Ticket file moved to `.agents/tickets/done/`.

**Verify:** from a clean Trace checkout, `codex-delegate --local <a throwaway ticket>` produces a
worktree in which `cd web && npm run typecheck && npm test && npm run format:check` passes with no
manual dependency setup, and in which `cd pipeline && pytest -rs` passes with every
tippecanoe-dependent test run and `trace_pipeline.__file__` pointing inside the worktree.
**Owner:** claude

**Done (2026-09-28), in `~/.local/bin/codex-delegate`:**
- `dep_dirs` finds every `package.json`, `pyproject.toml`, `setup.py` and `requirements.txt`
  directory, from the root down to three levels. The root is always included. `link_deps` links
  each `node_modules`/`.venv` found there. A link that already exists and points at the main
  checkout is counted too, so a `--fix` round's `$DEPS_NOTE` is no longer empty (a second bug the
  old code had).
- A linked `.venv` puts that worktree's source dir (or its `src/`) first on `PYTHONPATH`, and
  `/opt/homebrew/bin` and `/usr/local/bin` are prepended to `PATH` when missing. Codex runs under
  `env "${CENV[@]}"`, an array rather than word-split, because the real PATH holds an
  `Application Support` entry that word-splitting broke.
- `check_python` resolves each top-level package with `importlib.util.find_spec` under that
  environment, from `/`, and dies before Codex if any resolves outside the worktree.
- `--prepare` stops after setup and the checks, and prints Codex's environment. It exists so
  this ticket's Verify could run without spending Codex quota.

**Verified** with `--prepare` in place of `--local`; everything up to Codex is the same code:
- Trace (`T-999`, throwaway): linked `pipeline/.venv` and `web/node_modules`, and both packages
  resolve inside the worktree. A pytest plugin probing *plain* `pytest` printed the main
  checkout's `trace_pipeline` without the helper's env, and the worktree's with it: 339 passed,
  and the only skips need `data/`, with no tippecanoe skips. `web`: typecheck, 142 tests and
  format:check pass.
- Refusal (`T-998`, a patched copy pointing `PYTHONPATH` at the main checkout): it named both
  packages, printed "not starting it", and exited 1.
- A root-deps scratch repo: `node_modules` and `.venv` link at the root, fresh and on reuse.

**Still open, outside this ticket's scope:** the manual steps in the `/delegate` skill
(`~/.claude/skills/delegate/SKILL.md`) still describe hand-linking only `node_modules`, and say
nothing about `PYTHONPATH`.
