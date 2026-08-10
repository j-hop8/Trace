# T-004: Water domain — JRC Global Surface Water extraction
**Goal:** Turn JRC GSW into dated water-body features for Taiwan, with a graceful fallback when
the newer source is unreachable.

**Files in scope:**
- `pipeline/trace_pipeline/domains/water.py` (new)
- `pipeline/tests/test_water.py` (new)

**Do NOT touch:** `config.py` asset ids, `schema/`, `web/`, `domains/forest.py`.

**The version probe — do this first.** `config.GSW_V15_YEARLY` is a *project-hosted* asset, not a
catalog one, so read access is not guaranteed:
- Reachable → merge with `config.GSW_V14_YEARLY` on band `waterClass`, range 1984–2024.
- Not reachable → v1.4 alone, range 1984–2021.

Either way `temporal_range()` returns what was *actually* obtained, and the manifest carries it to
the slider. Do not hardcode 2024 and hope. Log which path was taken.

**Recipe:**
1. Build the yearly `waterClass` collection over `config.TAIWAN_BBOX`.
2. Per pixel, derive `first_water_year` and `last_water_year` from years where
   `waterClass >= WATER_CLASS_SEASONAL`.
3. Join the `transition` band from `config.GSW_MAPPING_LAYERS` as `subtype`.
4. Vectorize, drop below `config.MIN_PATCH_HA`, emit B4 features.
5. `change_type`: "loss" where water stopped before the last observed year, "stable" where it
   persists to the end, "gain" where it began after the first.

**Acceptance criteria:**
- [ ] `WaterDomain` subclasses `Domain`, is `@register`ed.
- [ ] `valid_from` = first water year, `valid_to` = last water year, or `null` if still water in
      the final observed year.
- [ ] `caveat` names the 30 m floor and that small 埤塘 may be missed.
- [ ] A test proves the v1.5-unavailable path yields `temporal_range() == (1984, 2021)` and does
      not raise.
- [ ] Report the polygon count and which GSW version was used.
- [ ] Sanity check the result against a known case: Taoyuan's 埤塘 ponds (~121.216, 24.993) should
      show pond loss over the period, not an empty result.

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** claude
