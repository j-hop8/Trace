# T-032: two-level toggles — cover | change → stable / gain / loss, with the baseline on the tag
**Goal:** Present each domain's states as `cover` and `change → stable / gain / loss`, every chip
carrying its swatch, and every group stating on screen what its colours are compared against — so
a reader can tell what deep blue and light blue *mean* without opening the caveat.

**Context:** The data side of the two-level taxonomy is done: both domains carry `cover` with its
own validity (T-029, T-030), change accumulates from the year it applies (T-031), and the map
draws cover for exactly its years (T-024). The toggles have not caught up. `LayerToggles.tsx`
lists a domain's states as one flat row of chips, and the only statement of what a colour is
measured against is an English `title` tooltip — invisible on touch, invisible in a screenshot.
That was the second half of the original ask: "currently UI can't notify if deep blue means what
or light blue means what."

**Files in scope:** `web/src/components/LayerToggles.tsx`, `web/src/components/FeatureReadout.tsx`,
`web/src/domains/manifest.ts` (+ new `manifest.test.ts`), `web/src/store/useTraceStore.ts` and
`useTraceStore.test.ts`, `web/src/domains/layerSpec.test.ts` (water fixture gains `cover`, as
T-024 deferred), `web/src/domains/colors.ts` (one doc comment), `CLAUDE.md` (colour section).

**Do NOT touch:** `web/src/domains/layerSpec.ts`; `styleFor`'s ramp values; `pipeline/**`;
`schema/**`; the basemap.

## Component tree

```
LayerToggles (iterates manifest.domains — unchanged)
└ <li> per domain
  ├ domain pill (existing: hue dot, label.zh, range, 載入中 / no-data badges)
  └ when active && selectableTypes(domain).length > 0:
    ├ KindGroup "cover"   only if selectableTypesByKind(domain).cover.length > 0
    │   ├ heading: 範圍 · {year}年的範圍          (en gloss: what was there in {year})
    │   └ chips: [Swatch(styleFor(hue, t))][TYPE_LABELS[t].zh]
    └ KindGroup "change"  only if …change.length > 0
        ├ heading: 變化 · 自{start}年起累計       (en gloss: cumulative since {start})
        └ chips for stable / gain / loss
```

- **The heading is visible text**, small and slate, not a tooltip: the baseline has to be on
  screen, and on a phone there is no hover. It is also a button — pressing it toggles every chip
  in its group (`toggleKind`), with the same "last state off switches the domain off" rule.
- `{year}` is `renderedYear` (the drawn year, as the badge uses); `{start}` is
  `domain.temporal.start`. **No domain literal anywhere** — both glosses are functions of the
  manifest entry.
- **Past the range** (T-031's observation): when `!coversYear(domain, year)`, the cover heading
  says `此年無紀錄` ("no record this year") instead of naming a year the layer cannot show; the
  change heading is unchanged, because change *does* still draw — as of the record's last year —
  and the "no data" badge is already on the pill. Decision: cover off, change on, both labelled
  honestly; no change to the cohort model.
- Strings, keyed by kind and by type:
  ```ts
  KIND_LABELS: Record<Kind, { zh; en; gloss(ctx: {year; start; inRange}) => {zh; en} }>
  TYPE_LABELS: Record<ChangeType, { zh; en; gloss: {zh; en} }>
    cover  範圍 / cover   該年存在的範圍        what existed that year
    stable 穩定 / stable  整段紀錄都在          there throughout the record
    gain   增加 / gain    紀錄期間出現          appeared during the record
    loss   減少 / loss    紀錄期間消失或減少    gone or reduced during the record
  ```
  Chip `title` / `aria-label`: `{label.zh}：{kind.zh}・{type.zh} — {kind gloss en}; {type gloss en}`.

## Store

`toggleKind(id, kind)`: the kind's types all on → all off; otherwise all on. Shares the tail of
`toggleChangeType` (domain off when nothing is left, orphaned readout dropped, year re-clamped)
by factoring it into one helper, so the two cannot diverge.

## manifest.ts

`selectableTypesByKind(entry): Record<Kind, ChangeType[]>` from `selectableTypes` + `KIND_OF`;
order follows `CHANGE_TYPE_ORDER`. A domain without cover yields an empty cover group.

## FeatureReadout.tsx

- `areaIsMeaningful` → `KIND_OF[props.change_type] === 'change'`; the explanatory note becomes
  kind-generic ("cover shapes are cut by the extraction grid").
- `sentence`: cover open → "there from {from} to the end of the record"; cover closed →
  "there {from}–{to−1}, gone by {to}" (a single year: "there in {from}, gone by {to}"); loss →
  "lost in {from}"; gain → "appeared in {from}"; stable → "there throughout, from {from}". The
  old "lost between {from} and {to}" branch is dead: change never closes now.

## Tests

- `manifest.test.ts` (new): `selectableTypesByKind` — both kinds present; cover absent; ordering;
  `changeTypes` absent → both empty.
- `useTraceStore.test.ts`: `toggleKind` all-on→all-off→all-on; switching the last kind off
  switches the domain off; the other kind is untouched.
- `layerSpec.test.ts`: water fixture gains `cover` (9 roles); a change-only fixture keeps the
  "no cover layers for a domain that has no cover" case honest.

**Acceptance criteria:**
- [x] At most two groups per domain, each only when the tileset holds a state of that kind,
      iterated via `selectableTypesByKind`; no domain id in any component.
- [x] Each group's heading is visible text naming its baseline — the drawn year for cover,
      `temporal.start` for change — and updates live with the slider; outside the range, cover's
      says there is no record.
- [x] Every chip's swatch is `styleFor(hue, type)`; every chip's `title` states kind and baseline.
- [x] Pressing a heading toggles its whole group; un-checking the last state still switches the
      domain off.
- [x] `FeatureReadout` withholds area for cover only, and describes a closed cover feature with
      its last present year and its end year.
- [x] `CLAUDE.md`'s colour section names the two kinds.
- [x] Verified live: headings read `1984年的範圍` / `自1984年起累計` for water and update with the
      slider; unchecking all three change chips leaves cover drawn.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check && npm run build`
**Owner:** claude
