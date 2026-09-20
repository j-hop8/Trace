# T-034: first render — cover first, change in the background, on more than one worker
**Goal:** Put something on screen sooner at the opening view: draw each domain's cover as soon as
it is parsed and bring its change states in behind it, and stop parsing every tile on a single
worker.

**Symptom:** After T-033 the opening view draws at ~19 s on the dev Mac: sources go on at 1.7 s,
nothing is on screen until both domains' tiles have parsed, all together, at 18.9 s / 19.3 s.

**Measured (opening view, both domains, one worker, this 2-core Mac; a reload of the live map
with only the named layers visible, which re-parses from the decoded tile and so isolates parse
cost from fetch):**

| role | forest | water |
|---|---|---|
| cover fill | 5.6 s | 6.1 s |
| cover outline | 5.2 s | 5.4 s |
| all change roles together | 1.8 s | 1.6 s |

Two facts follow. Cover is ~¾ of the work, not the light layer: every cover role is a pass over
~1 M sub-pixel patches per z7 tileset, and the fill costs as much as the outline, so it is
per-feature overhead (property and geometry decode, feature index), not tessellation. And
MapLibre parses on **one worker by default** (`worker_pool.ts`: `workerCount = 1` except Safari),
so an 8-core machine waits exactly as long as this one.

**Mechanism:**

1. `maplibregl.setWorkerCount(n)` before the map is constructed. Tiles are dispatched round-robin
   over the pool, so the ~12 tiles a domain needs at the opening view parse in parallel.
2. Each domain becomes **one source per kind** on the same archive — `trace-forest-cover`,
   `trace-forest-change` — added in stages: the cover source with its layers first, the change
   source once the cover source reports loaded. Not one source with the change layers added
   later: MapLibre has no incremental parse, so `addLayer` (or a visibility flip) on a live
   source re-runs every visible layer over every loaded tile, which re-parses cover — the
   expensive ¾ — a second time and pushes completion from ~17 s to ~28 s. A second source
   parses only the layers it carries. The worker keeps the decoded tile for reloads either way.
3. The `pmtiles://` protocol handler gets a small byte cache keyed by tile URL, so the second
   source is served the bytes the first one fetched instead of downloading the tile again.
   Entries are dropped once every source on the archive has read them, with an LRU cap as the
   backstop. The buffer is transferred to the worker, so the cache hands out a copy.
4. The store tracks loading **per kind** (`loadingKinds`), not per domain: the pill's `載入中`
   badge means nothing of the domain is on screen; a kind heading's badge means that kind is
   still parsing while the other is already drawn. A map that quietly showed cover as if it were
   the whole picture would break the honesty rule the badge exists for.

Draw order is unchanged: a stage's layers are inserted directly after the domain's own last
layer, so each domain stays contiguous and change stays on top of cover.

**Files in scope:**
- `web/src/map/MapCanvas.tsx`: worker count, set before construction.
- `web/src/map/usePmtilesProtocol.ts`: the byte cache around `protocol.tile`.
- `web/src/domains/layerSpec.ts`: `sourceId(domainId, kind)`, `stagesFor` (one `{kind, sourceId,
  source, layers}` per kind the domain holds, in kind order), `sourceIdsFor`; `layersFor` becomes
  the flat union for the tests.
- `web/src/domains/manifest.ts`: `kindsOf(entry)` — the kinds a domain holds, in order; the one
  list the stages and the badges both walk.
- `web/src/map/useDomainLayers.ts`: staged add, per-source `everLoaded`, per-kind loading report,
  teardown of every stage.
- `web/src/store/useTraceStore.ts`: `loadingDomains` → `loadingKinds`.
- `web/src/components/LayerToggles.tsx`: the kind heading's badge.
- `web/src/domains/layerSpec.test.ts`, `layerSpec.tiles.test.ts`, `manifest.test.ts`,
  `store/useTraceStore.test.ts`: follow the API; a test for the stage order and one for the
  protocol cache.
- `CLAUDE.md`: one sentence under rule 2 — one *archive* per domain, read by one source per kind.

**Do NOT touch:** `pipeline/**`, `data/**` — the island view's feature count is the real
remaining cost and is a pipeline question with honesty implications (aggregate, thin, or drop
the cover outline below the split); it is not folded in here. `colors.ts`; the commit loop in
`useDomainLayers.ts` (`pump`, settle) beyond listing every stage's source; the year model.

**Measured after (opening view, both domains, dev Mac, two workers; times from the moment the
cover sources go on, since when the render loop starts depends on the pane being visible):**

| | before (T-033) | after, best clean run | after, throttled run |
|---|---|---|---|
| first cover tiles on screen | 17.2 s (nothing before then) | ~5 s, tile by tile | ~10 s |
| forest cover complete | 17.2 s | 8.5 s | 14.3 s |
| water cover complete | 17.2 s | 12.1 s | 11.7 s |
| everything, `idle` | 18.8 s | 14.8 s | 17.1 s |

Each change stage parses in 2.3–2.7 s once its cover is up. Zero range requests to either archive
after the change sources go on — the second source is served from the shared bytes. The badge
sequence in the DOM: both pills `載入中` → pills clear and both `變化` headings badge as cover
lands → each heading clears as its change source loads.

The worker count could not be A/B'd cleanly here: the machine sat at load average ~11 on two
cores and throttled from 17 s to 43 s for the same configuration over the hour. In paired runs
two workers were never slower than one; the gain is for machines with idle cores, which this one
never had. MapLibre's default of one is the same on every non-Safari machine.

**Acceptance criteria:**
- [x] Cover is on screen before the change layers have been parsed, and the change layers arrive
      without cover flickering or being re-parsed.
- [x] The second source of a domain does not re-download a tile the first one fetched.
- [x] Opening view, dev Mac: cover drawn earlier than the ~19 s baseline, everything drawn no
      later than it — numbers above.
- [x] Domain toggles, state chips, the year pump, hit-testing and teardown work with both sources.
- [x] The kind heading shows `載入中` while its kind is still parsing and the pill does not.
- [x] `layerSpec.test.ts` / `layerSpec.tiles.test.ts` unchanged in what they assert.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check`
**Owner:** claude
