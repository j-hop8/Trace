# T-038: `node_modules/` does not ignore a *symlinked* node_modules, so a worktree shows it untracked
**Goal:** Make the dependency directories ignored whether they are real directories or symlinks,
so an agent working in a `.worktrees/` checkout cannot commit one by accident.

**Cause:** `.gitignore:19` is `node_modules/`. A trailing slash makes the pattern match
**directories only**. `codex-delegate` links deps into a worktree rather than installing them
(`ln -s $REPO/web/node_modules ...`), and git sees a symlink as a *file*, so the pattern does not
apply: `git status` in the worktree reports `?? web/node_modules` and `git check-ignore -v
web/node_modules` exits 1 with no matching rule.

Observed during T-035's delegation. It was worked around locally by appending `web/node_modules`
to `.git/info/exclude`, which is per-clone, invisible to anyone else, and had to be remembered and
removed by hand afterwards — exactly the kind of state that outlives the person who set it.

**Why it matters:** a committed `web/node_modules` symlink points at an absolute path on one
machine. It would break every other checkout and CI, and it is the sort of thing that sails
through review because the diff is one line.

**Check `.venv` too:** the same `link_deps` step links `pipeline/.venv`, and `.gitignore` should
be audited for any other directory-only pattern covering a path that gets linked.

**Files in scope:** `.gitignore` only.

**Do NOT touch:** `.git/info/exclude` (local state, not the fix); `web/**`; `pipeline/**`;
`.claude/launch.json` — the preview problem is [[T-037]], a separate ticket.

**Acceptance criteria:**
- [ ] `git check-ignore -v web/node_modules` matches a rule when the path is a **symlink**, not
      only when it is a directory.
- [ ] The same holds for `pipeline/.venv`, and any other linked dependency path the audit finds.
- [ ] A worktree with linked deps reports a clean `git status --porcelain`.
- [ ] Real directories are still ignored — `npm ci` in `web/` leaves the tree clean.
- [ ] Ticket file moved to `.agents/tickets/done/`.

**Verify:**
```
p=web/node_modules; mv "$p" /tmp/nm-t038 && ln -s /tmp/nm-t038 "$p" \
  && git check-ignore -v "$p" && git status --porcelain \
  ; rm -f "$p" && mv /tmp/nm-t038 "$p"
```
must print a matching `.gitignore` rule and an empty status, and leave `web/node_modules` a real
directory again.
**Owner:** codex
