# T-021: derive `ENDED` from JRC's class names instead of hand-keeping it
**Goal:** Close the structural gap that let class 7 go missing from `PRESENT_AT_START`, on its
sibling constant `ENDED` — its membership is currently correct but nothing enforces it.

**Background:** The PR #14 review (merged as ebc70e7) found `seasonal to permanent` (7) absent from
`PRESENT_AT_START`. The cause was structural, not a typo: the constant was a hand-kept list of
class codes and the test that should have caught it iterated the same literal tuple, so the
constant and its check were one hand-kept list wearing two hats. The fix derived the expected
membership from JRC's own naming in `GSW_TRANSITION_CLASSES`.

`ENDED = frozenset({3, 6, 9, 10})` has the identical structure and the identical exposure: every
test that touches it (`test_only_ended_classes_close`, `test_persisting_classes_stay_open_ended`,
`test_declining_water_is_loss_but_has_not_ended`) hand-lists codes.

The derivable rule: a class ended iff its JRC name starts with `lost ` or `ephemeral `. Verified
against `GSW_TRANSITION_CLASSES` before writing anything — it yields exactly {3, 6, 9, 10} and
correctly excludes `permanent to seasonal` (8), which is a `loss` but explicitly not an ending and
must keep `valid_to: None`.

**Files in scope:** `pipeline/trace_pipeline/domains/water.py`, `pipeline/tests/test_water.py`

**Do NOT touch:** Any class's actual membership in any constant. `MASK_ON_MANAGED_LAND`. Any
emitted data or feature values. Anything outside `pipeline/`. This is a test/guard change only —
if the derivation had not reproduced {3, 6, 9, 10} exactly, the instruction was to stop and report
rather than adjust the constant to fit.

**Acceptance criteria:**
- [ ] A test derives `ENDED`'s expected membership from `GSW_TRANSITION_CLASSES` names, not a
      literal code list, and fails if a class is added or moved to the wrong side
- [ ] That test pins class 8's exclusion as the case the rule must get right
- [ ] `ENDED`'s comment states the derivation rule and that a test enforces it, matching
      `PRESENT_AT_START`'s treatment
- [ ] `ENDED` still equals `frozenset({3, 6, 9, 10})` — membership unchanged
- [ ] No change to emitted features

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** claude
