# Trace · 描痕
### A proposal for an interactive map of Taiwan's long-term change

*Draft proposal — design and build*

---

## 1. Vision

Trace is an interactive web map that turns Taiwan's historical maps and satellite imagery into **dated, comparable features** — so people don't just look at the past, they can measure what changed, watch it move, and ask why.

The mission, in one line: **see what changed, how much, and why.**

Taiwan already has an excellent historical-map overlay (Academia Sinica's 台灣百年歷史地圖). But those tools present *pixels* — scanned map images stacked on top of each other — and leave the seeing to the viewer's eye. You can't perceive a change unless you already know what to look for. Trace's core move is to extract each subject (a forest boundary, a coastline, a pond) into geometry with a date, so change becomes computable: a number, an animation, and a story.

The one sentence that separates Trace from what exists: **Sinica gives you the layers; Trace gives you the join.**

---

## 2. Problem and opportunity

Existing change tools have three gaps:

- **Legibility.** They show raw layers; the user must do the comparison manually.
- **No synthesis.** Climate, coast, forest, and transport live in separate silos; nobody joins them.
- **Dated experience.** The tooling is desktop-bound and unfriendly to a casual or mobile audience.

The opportunity is a **change-legibility engine**: extract features, quantify the delta, animate it over time, and — the real moat — correlate one domain against another (e.g. urbanization against forest loss). That cross-layer join is the thing nobody has built.

---

# Part A — Design proposal

## A1. Product principles

1. **Change made legible at a glance.** The default output is not a raw layer but an answer: what changed, by how much.
2. **Every pixel becomes a sentence.** Selecting a feature yields a plain-language readout — *"this pond: permanent in 1990, gone by 2008, −3.2 ha."*
3. **Extent in colour, loss in red.** A domain's colour signals where it *is*; change is a separate visual channel (see A3).
4. **General and modular.** Domains are interchangeable modules on one shared spine. Adding "coast" or "urban" is a new module, not a redesign.
5. **Story-first onboarding.** A curated narrative teaches people how to read the map before they explore freely.

## A2. Brand and visual identity

**Name — Trace (描痕).** Chosen because it is a three-way pun that describes the product: you *trace* a boundary to extract it (the mechanic); change leaves a *trace* (the residue); the app lets you *trace* Taiwan through time. The Chinese wordmark 描痕 pairs with the tagline 描出島嶼的改變 ("trace out the island's change"). Availability should be checked before adoption.

**Colour system.** Two layers of meaning:

- *Domain identity (extent):* Water = blue, Forest = green. Reserved hues for future domains — Coast (teal/sand), Urban (magenta/grey), Climate (orange/red heat), Transport (violet).
- *Change signal (universal, cross-domain):* Loss = warm red/amber; Gain = the domain colour returning; Stable = muted. This is the single rule that keeps the map readable at any number of domains — *domain colour = what's there; red = what's gone.*

**Typography.** Bilingual by default: a clean Latin sans paired with Noto Sans TC, data-forward and quiet.

**Map style.** A muted, near-monochrome basemap so data layers dominate; a dark variant for stories and presentations. This is not just taste: default basemaps (OSM, Google) already paint water blue and vegetation green, which would *collide* with Trace's semantic use of those exact hues. The basemap must therefore suppress its own water and green fills and dim its labels, leaving blue and green free to mean "water domain" and "forest domain." This requirement is what dictates a restylable *vector* basemap over a fixed raster one (see B2.1).

**Tone.** Quietly serious and documentary — the subject is a changing island, not a dashboard demo.

## A3. Core interactions

- **Time slider with animation.** A play control sweeps the timeline; water occurrence and forest loss animate year by year.
- **Swipe / spyglass compare.** Then-versus-now at any location, the interaction people already understand.
- **Layer toggles.** Water and Forest at launch; extensible.
- **Feature readout.** Tap a feature for its quantified life story.
- **Cross-analysis panel.** Intersect two domains to reveal a relationship (v1: "forest that became water"; see B).
- **Story mode.** Guided narratives; the first is the Taoyuan ponds walkthrough, which doubles as the tutorial.

## A4. Information architecture

Keep it to three surfaces:

- **Explore** — free roam with layers, slider, and cross-analysis.
- **Stories** — curated narratives (Taoyuan ponds first).
- **About / Data** — sources, methods, and honest limitations.

## A5. Accessibility and trust

- Colourblind-safe ramps; loss is never signalled by colour alone (pair with pattern or icon).
- Source attribution on every layer, always visible.
- Uncertainty is shown, not hidden — confidence and resolution limits are surfaced rather than smoothed over.
- A visible "how to read this / what it can't tell you" note per layer (e.g. tree-cover loss is not the same as deforestation).

---

# Part B — Build proposal

## B1. Architecture overview

A single linear spine: **sources → extraction → unified feature store → analysis → serving → frontend.** Everything above the feature store is ingestion; everything below it is presentation. The store is the product; the rest is standard web-mapping plumbing.

The design turns on two decisions: the **extraction fork** (two pipelines, not one) and the **unified feature store** (the join). (See the accompanying architecture diagram, `trace_architecture.svg`.)

## B2. Technology stack

- **Frontend:** MapLibre GL JS (no Google Maps fees) + deck.gl for GPU-heavy layers; TypeScript with React or Svelte.
- **Vector tiles:** PMTiles — a single file on object storage, no tile server.
- **Raster tiles:** Cloud-Optimized GeoTIFF (COG) served via titiler.
- **Feature store:** PostGIS with a spatiotemporal schema.
- **Extraction:** Google Earth Engine (Python API / geemap) for the imagery pipeline.
- **Analysis:** a thin API (e.g. FastAPI) for cross-layer joins — or, in v1, pre-computed JSON.
- **Basemap (default):** self-hosted Protomaps PMTiles — a single Taiwan-extract file on object storage, no API key, restyled to a muted theme (see B2.1).
- **Basemap (fallback / prototyping):** OpenFreeMap — free, hosted, no API key, MapLibre-native.
- **Basemap (optional Taiwan-native layer):** NLSC 臺灣通用電子地圖 WMTS.
- **Historic basemaps:** proxied from Academia Sinica WMTS.
- **Hosting:** Cloudflare Pages/R2 (or S3). The live site is effectively static; running cost is cents.

### B2.1 Basemap strategy

A basemap is a *style* pointing at a *tile source*; the real decision is not "OpenStreetMap or Mapbox" but *who serves the OSM-derived tiles, and whether we host or rent them.*

- **Default — self-hosted Protomaps (PMTiles).** The whole background becomes one static Taiwan-extract file on the same object storage already used for data layers — no tile server, no database, no API keys, cost in single-digit dollars or zero. Its CC0 MapLibre styles are editable, so the water and green fills can be stripped to satisfy the colour-clash requirement (A2). One consistent technology for basemap *and* data.
- **Fallback — OpenFreeMap.** Free, hosted, no API key, MapLibre-native; ideal for Phase 0. Same OSM-vector family as Protomaps, so migrating to self-host later is trivial. Caveat: a free community endpoint with no SLA.
- **Optional Taiwan-native layer — NLSC 臺灣通用電子地圖.** Free WMTS, no application required, endpoint `https://wmts.nlsc.gov.tw/wmts`. Best Chinese place-name labelling and authoritative local detail. Offered as a user-toggled layer rather than the default, because it is raster (not restylable) and would clash with the semantic palette.
- **Rejected — Mapbox and raw OSM demo tiles.** Mapbox means proprietary lock-in, API keys, and per-request pricing that fights the near-serverless architecture (MapLibre was forked from Mapbox GL JS precisely to avoid this). The public `tile.openstreetmap.org` tiles are prohibited for production use by OSM's tile policy and are prototyping-only.

**Attribution.** Any OSM-derived basemap must display "© OpenStreetMap contributors" (ODbL); NLSC and the JRC/Hansen data layers carry their own required credits. A single persistent credits line concatenates whatever is active.

## B3. Data sources

**Launch (v1):**

- **Water — JRC Global Surface Water** (Pekel et al., 2016). Assets `JRC/GSW1_4/YearlyHistory` (per-year water class, 1984–2021) and `JRC/GSW1_4/GlobalSurfaceWater` (occurrence, transition, change). 30 m, Landsat-derived. Attribution: *Source: EC JRC/Google*. Note a 2022–2024 update (v1.5) exists on JRC's own site; confirm Earth Engine availability.
- **Forest — Hansen Global Forest Change v1.13**. Asset `UMD/hansen/global_forest_change_2025_v1_13`, coverage 2000–2025, 30 m. Bands: `treecover2000` (baseline), `lossyear` (2001–2025), `gain` (2000–2012). Licence CC-BY-4.0; credit Hansen et al.

**Roadmap:** Academia Sinica historic map WMTS (via the map-reader pipeline); then coast, urban/land-use, climate, transport, hazards. NLSC's 國土利用現況調查 (national land-use survey), free via the same NLSC WMTS used for the optional basemap, is a ready data source for the future urban/land-use domain — not merely a background layer.

## B4. Feature schema (the general spine)

Every feature, regardless of domain, is stored as:

```
feature {
  id
  geometry            # polygon / line / point
  domain              # water | forest | coast | urban | ...
  subtype             # pond | reservoir | river | coast (optional)
  valid_from          # date the state begins
  valid_to            # date the state ends (null = current)
  change_type         # gain | loss | stable
  metric              # { area_ha, length_m, ... }
  source              # dataset + version
  method              # e.g. "JRC GSW YearlyHistory" / segmentation model id
  confidence          # 0–1
}
```

Rendering colour is a pure function of `domain` (extent hue) and `change_type` (loss → red). Adding a domain is a new `domain` value plus a hue — no schema change, no re-architecture.

## B5. Extraction pipeline (v1 recipe)

The whole v1 backend is a batch job, run offline, with **no custom machine learning**:

1. In Earth Engine, clip JRC `YearlyHistory` + `GlobalSurfaceWater` and Hansen v1.13 to a Taiwan bounding box.
2. Water: export each year's water class and the transition band. Forest: export `treecover2000` (threshold ~30 % = forest) and `lossyear`.
3. Export rasters as COGs for the time-lapse; vectorize the notable features (ponds, loss patches) into PMTiles for crisp outlines and area figures.
4. Publish both to object storage.

## B6. Build phases

- **Phase 0 — Data spike (1–2 weeks).** Clip both datasets to Taiwan, generate static tiles, prove they render on a MapLibre canvas. De-risks everything downstream.
- **Phase 1 — v1 MVP (a few weeks).** Two layers (Water, Forest), time slider + animation, swipe compare, feature readout, and the Taoyuan ponds story. Ship a public, shareable demo.
- **Phase 2 — The join.** Cross-analysis ("forest that became water"), the proper PostGIS feature store, and polish.
- **Phase 3 — Third domain (urban / land-use).** Unlocks the rich correlations (pond loss × urban growth) that make cross-analysis the headline feature.
- **Phase 4 — Historic depth.** Stand up the map-reader pipeline (segmentation + human-in-the-loop) to extend the timeline before 1972, and add coast, climate, and transport modules.

## B7. Cost and operations

There is no always-on GPU or heavy backend in v1. Extraction is batch; results are baked into PMTiles and COGs on object storage; the frontend reads them directly. Earth Engine is free for research, education, and nonprofit use. A side project can carry this indefinitely at near-zero cost.

## B8. Risks and mitigations

- **Resolution vs small ponds.** At 30 m, the smallest 埤塘 may be missed. *Mitigation:* add Sentinel-2 (10 m) MNDWI or NLSC aerial for hero stories only, not island-wide.
- **"Loss" semantics.** Hansen loss includes plantation harvest, fire, and typhoon damage. *Mitigation:* label it "tree-cover loss," never "deforestation."
- **Timeline misalignment.** Water is 1984–2021 (in Earth Engine); forest is 2000–2025. *Mitigation:* the slider shows per-layer availability rather than forcing a shared range.
- **Historic-map extraction is hard.** Heterogeneous legends, fonts, and paper folds. *Mitigation:* defer to Phase 4; use human-in-the-loop and bootstrap from Sinica's existing vectorization.
- **Scope creep.** *Mitigation:* domains are modules; ship the Water + Forest pair before adding anything.
- **Licensing / attribution.** *Mitigation:* carry required credits per source (EC JRC/Google; Hansen CC-BY; Sinica terms).

## B9. Success criteria for v1

- A shareable Taoyuan ponds story that a non-expert immediately understands.
- Island-wide water and forest change, browsable and animatable, 1984/2000 → present.
- At least one working cross-analysis ("forest that became water").
- Hosting cost that stays in single-digit dollars per month.

---

## Appendix — key references

- Water: `JRC/GSW1_4/YearlyHistory`, `JRC/GSW1_4/GlobalSurfaceWater` — Pekel et al., *Nature* 540 (2016).
- Forest: `UMD/hansen/global_forest_change_2025_v1_13` — Hansen et al., *Science* 342 (2013).
- Historic maps: Academia Sinica 台灣百年歷史地圖 (WMTS tile services).
- Extraction reference: MapReader (Alan Turing Institute) for historic-map feature extraction.
- Serving: PMTiles, titiler, COG.
- Basemap: Protomaps (open PMTiles basemaps, CC0 styles); OpenFreeMap (free hosted OSM vector tiles); NLSC 國土測繪圖資服務雲 WMTS (`https://wmts.nlsc.gov.tw/wmts`, 臺灣通用電子地圖 + 國土利用現況調查).
