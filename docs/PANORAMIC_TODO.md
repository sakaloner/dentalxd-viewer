# Live Panoramic — feature roadmap / TODO

Status: the live panoramic shipped (2026-07-14) — `src/components/LivePanoramic.jsx` +
`src/panoramic/archMath.js`. Auto-fit arch (occlusal band → MIP → parabola), draggable
control points on Axial, real-time curved-MPR re-render (downsampled on drag, full-res on
release), Grosor (slab) + Profundidad (buccal↔lingual roll) sliders, mm ruler, fullscreen.

This file is the agreed next-steps list, in priority order. Items 1–5 are small; item 6
starts the VIEWER_PLAN.md dependency chain (cross-sections).

## 1. Click-to-navigate on the pano  ← do first
Clicking a spot on the panoramic moves the shared crosshair: pano (col, row) → arch sample
s (world x,y) + z row → world point → set CrosshairsTool center. Makes the pano a live
navigation surface like every other panel (the plan's "one shared state" spine) and lays
the groundwork for cross-sections (picking the site along the jaw).

## 2. Z-crop to the tooth band
Sample only `zpk ± margin` instead of all slices (autoFitArch already finds `zpk`).
Asymmetric margins: ~40 mm up (keep sinus floor + condyle region), ~30 mm down (mandible
border / IAN canal). Wins: teeth fill the canvas, percentile windowing stops being diluted
by air/soft tissue, ~30 % fewer rows per render. Don't over-crop — clinicians expect
condyles in a pano; if anyone complains, add draggable top/bottom bounds (Romexis does).

## 3. Focal trough envelope on Axial
Draw two thinner dashed curves at ±Grosor/2 (shifted by Profundidad) around the solid
center arch — the standard "focal trough" visual. Makes both sliders legible and shows at
a glance whether a tooth sits inside the sampled band. ~15 lines in `drawArch` (curve
normals already computed). Handles stay on the center line only; envelope is display-only.

## 4. Persist the arch per case
localStorage keyed by case id: control points + z. Currently the arch re-fits on every
open, discarding manual adjustments. (See also "Persistence" below.)

## 5. R/L orientation labels on the pano
Match the radiology convention the MPR orientation letters use. Correctness feature, cheap.

## 6. Cross-section viewport (VIEWER_PLAN.md step 3)
Thin slices perpendicular to the arch at the crosshair's arch position — the core clinical
view (bone width/height). Unlocked by the arch; unlocks Room 1 grid, implant placement,
nerve distance readout. After this, the pano graduates from overlay to a Room 1 panel.

## Also worth doing (unordered)
- **Export pano as PNG** — for reports/referrals; then retire `make_panoramic.py` and the
  precomputed `/dicom/<dir>/panoramic.png` asset convention (one source of truth).
- **W/L on the pano** — auto percentile windowing breaks down on metal-heavy cases.
- **Romexis-style depth scroll packaging** — thin slab while scrolling + slice-counter
  feel; today Grosor 18 mm makes 1 mm Profundidad steps imperceptible (drop Grosor to
  ~5 mm and it already behaves like Romexis).

## Architectural gap to decide early: persistence
Arch, implants, nerve traces, measurements are all planning artifacts, but the app is
static files + nginx with no backend. localStorage covers demos; real users expect their
plan on another machine. Every feature above writes into this — decide before implant/nerve
work starts.

## Constraints / honesty notes
- Pano measurements: only along-arch and vertical distances are true; oblique distances are
  distorted by the unrolling. Restrict or label if measuring is ever added.
- Nerve tracing (plan step 10) happens ON the panoramic — keep the canvas overlay approach
  annotation-friendly.
- Still skipping (per plan): auto nerve detection, 3D curved-pano surface, wow-list items.

## Known issue (not pano)
Axial viewport renders near-black on case1 despite healthy volume data (coronal/sagittal
fine, pano samples the same volume correctly). Likely W/L state; predates/outside the pano
feature — flagged for the UI agent.
