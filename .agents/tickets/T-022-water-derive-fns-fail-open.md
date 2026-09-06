# T-022: `derive_valid_to` / `derive_valid_from` fail open on off-roster transition codes
**Goal:** Make the two date-derivation functions raise `UnknownTransitionClass` for a transition
code outside JRC's documented 1-10, as `derive_change_type` already does.

**Background:** Found by review of T-021 ([#15](https://github.com/j-hop8/Trace/pull/15)), which
hardened `ENDED`'s membership but left membership as the sole gate on the function consuming it.

`derive_valid_to` is `if transition_code not in ENDED: return None`, so an unknown code is silently
treated as "has not ended". `derive_valid_from` likewise falls through to
`max(measured_first_year, range_first)`. Verified by direct call:

    derive_valid_to(11, 2015, 2021)   -> None      (silent)
    derive_valid_from(11, 1990, 1984) -> 1990      (silent)
    derive_change_type(11)            -> raises UnknownTransitionClass

This contradicts the module's own stated principle, in `UnknownTransitionClass`'s docstring:
"Raised rather than defaulted. Asset versions drift — that is this pipeline's standing gotcha —
and a class this module has never seen must be looked at, not silently painted a colour."

**Why it does not bite today, and why that is fragile:** `build_feature` is saved purely by
keyword-argument evaluation order. Python evaluates the call's kwargs left to right, so
`valid_from=` and `valid_to=` are computed first and silently accept the bad code; the raise only
happens when `change_type=` is reached third. Reordering those kwargs — a formatting-grade edit —
or calling either function from anywhere else silently emits an unknown class as open-ended water.
Nothing in the file records that the ordering is load-bearing.

**Files in scope:** `pipeline/trace_pipeline/domains/water.py`, `pipeline/tests/test_water.py`

**Do NOT touch:** Any constant's membership. `MASK_ON_MANAGED_LAND`. The change-type mapping.
Behaviour for the ten documented classes must be byte-identical — this adds a raise on input that
is currently undefined, nothing else.

**Acceptance criteria:**
- [ ] `derive_valid_to` and `derive_valid_from` raise `UnknownTransitionClass` for a code absent
      from `GSW_TRANSITION_CLASSES`, with the same message shape `derive_change_type` uses
- [ ] Tests cover the raise for both, so `build_feature`'s safety no longer rests on kwarg order
- [ ] All ten documented classes return exactly what they return today
- [ ] Consider whether the shared guard belongs in one place all three functions call

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** claude | codex
