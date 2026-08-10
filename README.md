# Trace · 描痕

**描出島嶼的改變** — trace out the island's change.

An interactive map that turns Taiwan's historical maps and satellite imagery into **dated,
comparable features** — so change becomes computable: a number, an animation, and a story.

> Academia Sinica's 台灣百年歷史地圖 gives you the layers. Trace gives you the join.

Existing tools present *pixels* — scanned maps stacked on each other — and leave the seeing to
the viewer's eye. Trace extracts each subject (a forest boundary, a coastline, a pond) into
geometry with a date, so you can ask **what changed, how much, and why.**

## Status

Phase 0 — data spike. Proving the extraction → tile → render loop with two domains.

| Domain | Source | Coverage | Resolution |
|---|---|---|---|
| Water | JRC Global Surface Water | 1984– | 30 m |
| Forest | Hansen Global Forest Change v1.13 | 2000–2025 | 30 m |

## Layout

```
docs/       proposal + architecture diagram
schema/     the feature contract — one source of truth for pipeline and web
pipeline/   Python · Earth Engine extraction → PMTiles
web/        React + Vite + MapLibre GL
data/       generated tiles (gitignored)
```

The system runs on one spine: **sources → extraction → feature store → analysis → serving →
frontend.** Domains are interchangeable modules on that spine — adding one is a pipeline module
plus a manifest entry, not a redesign. See [docs/Trace_proposal.md](docs/Trace_proposal.md).

## Data attribution

- Water — *Source: EC JRC/Google.* Pekel et al., "High-resolution mapping of global surface
  water and its long-term changes," *Nature* 540 (2016).
- Forest — Hansen et al., *Science* 342 (2013). CC-BY-4.0.
- Basemap — © OpenStreetMap contributors (ODbL), via Protomaps.

Tree-cover loss is **not** deforestation: Hansen loss includes plantation harvest, fire, and
typhoon damage. Trace labels it accordingly.

## Licence

Code: MIT. Data layers carry their upstream licences and required credits, listed above and
surfaced in the app's persistent attribution line.
