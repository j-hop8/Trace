# T-026: caveats are plain prose — readers saw the asterisks in `*ended*`
**Goal:** Make "a caveat is plain prose, not markup" an enforced contract across every domain,
and fix the one caveat that already broke it.

**Context:** `WaterDomain.caveat` shipped the phrase "Water the source says *ended* is kept
there". `web/src/components/Attribution.tsx` renders the caveat as `{entry.caveat}` — a text
node, deliberately: the string comes from the pipeline, and interpreting it as markup would mean
either a Markdown parser or `dangerouslySetInnerHTML` for the sake of one emphasised word. So the
asterisks reached the page as literal characters.

The emphasis was the right instinct — the sentence is hard to parse without it — but the fix is
prose that does not need emphasis ("says has ended"), not markup in a field nothing parses. And
since nothing on the pipeline side currently stops the next caveat from doing the same, the
contract is enforced where it can be: a parametrized test over `domains.all_ids()` asserting no
`*`, `` ` `` or `](` in any caveat.

**Origin:** discovered while working T-025 and initially committed on that branch (`e7630d4`,
`808470e`). Codex's review of PR #16 flagged `test_domains.py` as outside T-025's file scope;
pre-review had said the same. Carved out here so T-025 stays inside its ticket. The guard cannot
land without the prose fix — it fails on `main` as long as `*ended*` is there — so both travel
together.

**Files in scope:** `pipeline/trace_pipeline/domains/water.py` (the one caveat sentence),
`pipeline/tests/test_domains.py` (the guard).

**Do NOT touch:** `web/src/components/Attribution.tsx` — rendering as a text node is the
correct decision and the reason this contract exists. `schema/**`. Any other domain's caveat:
if the guard fails on one, that is a finding for its own ticket, not a drive-by edit here.

**Acceptance criteria:**
- [ ] No caveat from any domain in `domains.all_ids()` contains `*`, `` ` `` or `](`.
- [ ] The water caveat reads "says has ended" and the rendered string is otherwise unchanged.
- [ ] The guard is parametrized over every domain, so adding a domain adds a case.
- [ ] The `gsw_v15_reachable` probe is stubbed in the test — it must not touch the network.

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** claude
