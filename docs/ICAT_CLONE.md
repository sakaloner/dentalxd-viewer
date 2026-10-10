# DentalXD — i-CAT Vision skin ("copy the views")

Goal: make the DentalXD web viewer **look and navigate like i-CAT Vision**, the
free CBCT viewer the referring clinician already knows by heart.
This is a **reskin + renavigation over the existing Cornerstone panels**, not new
imaging code — every clinical capability (linked crosshair, MPR, live panoramic,
cross-sections, 3D, measurement, W/L, arch tracing) already exists (see
`VIEWER_PLAN.md`). We are wrapping them in i-CAT's chrome and mental model.

Reference: the UMN i-CAT Vision training manual (`IcatManual.pdf`, rendered pages
in the scratchpad). **IP note:** inspiration only — panel structure, menu layout,
naming, interaction conventions. Do not pixel-copy their glyphs, and never
redistribute the manual.

## What i-CAT Vision looks like (from the manual screenshots)

- **Pure-black UI.** Every "window" has a thin grey title bar with centered light
  text ("Study List", "Panoramic View", "Volume of Interest", "Study
  Information", "Sagittal", "Coronal", "Axial").
- **Top menu bar:** `File  Tools  Screen  Help` — thin, classic, dark.
- **Screens** (switch via the `Screen` menu, or **double-click a window** to drill
  in):
  - **Preview** (main): Study List (Window 1) + File Type (Window 2) + Panoramic
    (Window 3, wide) + Study Information (Window 7) + Sagittal (4) + Coronal (5) +
    Axial-with-arch (6).
  - **Panoramic** (double-click W3): big panoramic + yellow oblique/horizontal/
    vertical ladders + a strip of tooth cross-sections at the bottom.
  - **MPR** (double-click W5): axial / coronal / sagittal + the Line tool → the
    4th window.
  - **TMJ / ATM** (double-click W6): sagittal with blue level lines + axial with
    condyle-axis lines + axially-corrected coronal views.
  - **3D**: volume render.
- **Right-click context menu** (the real tool surface): HU Statistics, Distance,
  Set Filter ▸ (Normal / Sharpen Mild / Hard / Sharp / Very sharp), Reset
  Window/Level, Reset All Window/Levels, Select Panoramic Method, Save This
  Workup, Load Different Workup, Save as JPEG, Open Output Folder, Remove Data
  Outside of Center Scanfield, Reset Volume Rotation.
- Colored anatomical overlays: green/red arch curves, blue focal-trough dots,
  blue condyle-axis lines, yellow ladders.

## View mapping (i-CAT screen → our layout)

| i-CAT screen (Spanish) | our `layout` | status |
|---|---|---|
| **Vista previa** (Preview) | `preview` | **new** — Study List + Panorámica + Info + Sagital/Coronal/Axial |
| **Panorámica** (Panoramic) | `panoramic` | existing room, reused |
| **MPR** | `explorer` (2×2 MPR+3D) | existing room, renamed |
| **ATM** (TMJ) | `tmj` | **new** layout — Sagital + Axial + Coronal focus |
| **3D** | `patient3d` | **new** layout — big centered 3D (= plan's Room 3 "Patient") |
| **Implante** | `implant` | our value-add beyond i-CAT — kept |
| **Diente** | `diente` | our value-add — kept |

All screens share one viewer state (crosshair, arch, W/L) — switching only
re-arranges panels, same contract as the existing rooms.

## Build status

Done in the `icat-skin` branch:
- `src/components/icat/icat.css` — black i-CAT theme, scoped under `.icat-skin`;
  per-window title bars, menu bar, context menu styling.
- `src/components/icat/IcatMenuBar.jsx` — `Archivo · Herramientas · Pantalla ·
  Ayuda`. **Pantalla** switches screens; **Herramientas** sets the active tool;
  Archivo/Ayuda are informational (point to the full remote i-CAT Vision).
- `src/components/icat/IcatContextMenu.jsx` — Windows-style right-click menu wired
  to the real tools (Distancia→Medir, Restablecer W/L, Guardar como JPEG→canvas
  export, Ajustar filtro presets, Guardar workup→informational, Línea, Explorar).
  **Restablecer ventana/nivel and Guardar como JPEG were only informational
  toasts until 2026-08-23** despite this doc's claim — `resetWLSignal` (mirrors
  the existing `clearSignal`/`cropResetSignal` pattern) now actually resets
  each MPR viewport's `voiRange` to what Cornerstone set right after load
  (captured in `defaultVOIRef`, `CornerstoneViewer.jsx`) without touching
  pan/zoom/rotation; `onSaveJPEG` (`Viewer.jsx`) flattens every visible canvas
  in `.viewer-main` (Cornerstone viewports + ruler/crosshair/ladder overlays)
  onto one offscreen canvas at their on-screen positions and downloads it as a
  JPEG. Both menu-bar and context-menu entries call the same handlers.
- `src/components/icat/StudyPanel.jsx` — the Preview screen's left column: Study
  List (all cases, clickable) + Información del Estudio.
- `CornerstoneViewer.jsx` — `LAYOUT_PANELS` gains `preview` / `tmj` / `patient3d`;
  per-panel i-CAT title bars in skin mode.
- `Viewer.jsx` — hosts the menu bar + context menu + Preview left column; `icat`
  skin flag (on by default on this branch, toggle in the Ayuda menu).
- **"Línea" tool** (context menu / Herramientas → Línea): left-drag on any
  Axial/Sagital/Coronal panel draws a line; the Explorador room's 4th panel
  (`vol3d` slot, no 3D in that room per i-CAT) shows the volume reformatted
  along it — `renderLineSlice`/`scalarsToImageData` in `archMath.js`, depth
  axis = whichever axis is perpendicular to the source view. Working, kept.
- **"Explorar" tool** (context menu / Herramientas → Explorar): left-drag draws
  a circle; on release the shared 3D viewport is cropped to that region
  (reuses `isolateToothAt`, generalized to an arbitrary radius) and revealed
  in the same 4th panel (`panel4Content` state toggles which of Línea/Explorar
  is showing). Working, kept.
- **Implante room rebuilt to i-CAT's real quadrant layout** (no 3D panel):
  top row Panorámica (2/3 width, centered) + Axial (1/3); bottom row one big
  center cross-section (1/3) + a uniform 4×2 grid of neighboring cross-sections
  (2/3). Replaced the earlier middle-row-large-panel + full-width-strip layout.
  `implantTopSplit`/`implantPanoWidth`/`implantCrossWidth` in `Viewer.jsx`,
  `.cross-large-panel`/`.cross-strip` in `LivePanoramic.css`. Working, kept.
- **Double-click on the traced arch curve** (Axial, away from existing
  handles) inserts a new draggable control point there — local refinement
  beyond `autoFitArch`'s fixed point set. Working, kept.

- **Panoramic "ladder" controls** — oblique ladder (bottom-right corner, both
  rooms) drags focal-trough/slab thickness; horizontal ladder (top edge,
  Implante only) drags position along the arch (`drawLadders`/`ladderHit`/
  `startLadderDrag` in `LivePanoramic.jsx`). **User feedback (2026-08-07):
  "those things are pretty horrible."** — the shape was the problem: they were
  a single tick-marked line, not an actual ladder. **Redesigned 2026-08-23**
  against real screenshots (the iCATVision Quick Reference manual, re-sourced
  from Internet Archive — see `IcatManual.pdf` pages 3-4 in scratchpad, not
  committed per the IP note above): `drawLadderRungs` now draws the real
  two-rail ladder shape (two parallel rails + cross-rungs, not one line with
  perpendicular ticks), and both handles are solid blue dots (`LADDER_HANDLE_COLOR`)
  matching the manual's convention instead of yellow/black. Hit-testing/drag
  logic untouched — same centerline, so nothing about *what* they control
  changed, only how they're drawn. Re-check with the user before extending.
  The **vertical ladder** (i-CAT: drag to shift between maxillary/mandibular
  arch, i.e. the z-band position — see manual page 4, "Vertical Tool Bar")
  is still not built — it didn't map cleanly onto our existing "Profundidad"
  (buccal-lingual roll) control; now that the other two ladders have the
  right shape, this is unblocked whenever it's wanted.
- **Custom i-CAT-style slice position + slab thickness strips** on the MPR
  panels (`drawStrip` in `CornerstoneViewer.jsx`, replaced the old same-axis
  `.slice-slider-vert`) — right/bottom edge-docked pair per panel, blue
  position handle + yellow slab segment, real `setSlabThickness`/
  `setBlendMode` MIP. **Parked per user feedback (2026-08-07) — "not content
  with this."** Left in place (functional, not reverted) but flagged as
  needing rework, not a reference for how the panoramic ladders above should
  look either.
- Related: the axial focal-trough **band-width ribbon** (translucent overlay
  showing the current slab straddling the arch curve, `drawArch` in
  `LivePanoramic.jsx`) was added alongside the ladders and hasn't had
  separate negative feedback, but re-check it if/when the ladders are redone
  since it's driven by the same `slabMm` value via the oblique ladder.

## Deferred (next steps, noted so they're not forgotten)

- Real **Set Filter** DSP (sharpen kernels). Currently a CSS-filter approximation
  (contrast/sharpen look) on the viewport canvas — visually plausible for a demo,
  not a true unsharp mask.
- **TMJ condyle-axis** interaction (align blue lines to each condyle → corrected
  coronals). The `tmj` layout arranges the right panels; the condyle-axis math is
  not built.
- **Save/Load Workup** persistence (i-CAT stores workups in `LoadStatus/Workup00N`
  inside each study). Menu items present, wired to an informational note.
- Panoramic **vertical ladder** — see "not satisfactory" note above; blocked on
  the oblique/horizontal ones getting a design pass first, and on deciding how
  it should relate to (or replace) the existing "Profundidad" control.
- **Nerve canal tracing** — explicitly deferred per user request (2026-08-07).
  `docs/VIEWER_PLAN.md` already specifies manual point-and-click tracing only,
  no auto-detection; nothing built yet either way.

## User feedback (2026-08-23, round 2) — real i-CAT vs. ours, by screen

- **Preview screen is too "live."** i-CAT's Preview windows are inert
  thumbnails: no ladder on the panoramic, no side-action chrome. **Fixed
  2026-08-23**: `LivePanoramic` gained a `thumbnail` prop (`Viewer.jsx` passes
  `thumbnail={view === 'preview'}`), which suppresses the ladder canvas
  (`drawLadders`/`ladderHit`) and the panoramic's own `viewport-side` rail
  (depth slider + reset/fullscreen/close buttons) when true. `ControlPanel`
  (the Vistas/Tools/Annotation/3D Rendering sidebar) is now hidden entirely on
  `view === 'preview'` (`Viewer.jsx`). The MPR panels' `viewport-side-slider`
  (slice counter) and reset (⟲) button are hidden for `layout === 'preview'`
  too, but the fullscreen (⤢) toggle stays — that one was added earlier per an
  explicit client request (double-click-a-window convention), separate from
  this round of feedback. Pan/zoom/scroll interactivity on the Preview
  sagittal/coronal panels was *not* touched — the user later clarified the
  "bones read clearer" perception was about window/level brightness, not
  panel interactivity (see the bone-window entry below), so that part of the
  original ask no longer applies.
  **Gotcha hit while building this**: `drawLadders` is a `useCallback(fn, [])`
  — empty deps, by design, since it's memoized once and reads live state via
  `crossRef.current` (see the existing comment on the `mode` field there)
  rather than closing over props directly, exactly so it can't go stale
  across renders. Gating it on the bare `thumbnail` prop directly broke that:
  the closure permanently captured `thumbnail` from LivePanoramic's *first*
  mount (always `true`, since `view` starts at `'preview'`), so switching to
  Implante/Panorámica later never re-drew the ladder even though the prop
  itself was correctly `false` by then. Fixed by threading `thumbnail`
  through the same `crossRef` pattern used for `mode`/`crossPos`/etc., and
  reading `crossRef.current.thumbnail` inside `drawLadders` instead of the
  prop. `ladderHit` (a plain per-render function, not `useCallback`) didn't
  have this problem and reads the prop directly.
- **MPR slice/thickness control needs the real ladder shape**, not the
  `drawStrip` green/red line pair. Spec from user: two-rail ladder (reuse
  `drawLadderRungs`'s visual pattern from the panoramic ladders) — center
  handle = slice position, bottom = slab thickness, top = MIP/radiography
  toggle (blend mode). Confirms/extends the existing "not content with this"
  parked note above.
- **Implant vertical (yellow) ladder reads as doing nothing** — confirmed as
  a real gap, not just needing more feedback. `zShiftMm` only feeds
  `renderCrossAll`'s crop-band center (`LivePanoramic.jsx`), and that band is
  60mm tall against a ±15mm shift range, so the visible change is minor; it
  never touches the Axial viewport panel at all (zero references to
  `zShiftMm` outside `LivePanoramic.jsx`). i-CAT moves both the axial slice
  and the cross-sections together. Needs: wire the shift into the Implante
  layout's Axial panel slice index, and make the cross-section band respond
  more visibly.
- **Implant cross-section grid needs a "fewer tiles" control** — currently a
  hardcoded 4×2 grid with no count state anywhere; `implantCrossWidth` only
  splits panel space, not tile count.
- General rendering sharpness/3D look ("way more nitid" / "doesn't look very
  3D") — user later clarified this is two separate asks, both addressed
  2026-08-23 without a side-by-side pass (per user: "no side to side
  comparison, let's just think how to put more high definition"):
  - **Bone brightness** ("icat bone looks very bright") was a windowing gap:
    `CornerstoneViewer.jsx` never set an explicit default Window/Level, just
    captured whatever Cornerstone's auto-VOI computed right after load
    (`defaultVOIRef`, used for "Restablecer W/L" too) — generic, not
    bone-tuned. Now biases that auto-computed range toward its upper 45%
    (`lower = auto.lower + span*0.55`) before capturing it as the baseline,
    which reads as saturated/bright bone against darker soft tissue. Chose a
    relative bias over a fixed absolute HU window because CBCT scanners
    aren't consistently HU-calibrated like medical CT, so a fixed window
    right for one dataset can be wrong for another.
  - **Definition/sharpness**: the real 3×3 sharpen kernel (`icat-f-mild`,
    `Viewer.jsx`'s `FILTER_CSS`) existed but defaulted to off (`filterPreset:
    'none'`). Now defaults to `'mild'`.
    **Gotcha**: a per-case reset `useEffect` (`Viewer.jsx`, keyed off
    `caseId`, resets ~10 pieces of state including `filterPreset` on every
    case mount) was hardcoded back to `'none'` — missed on the first pass
    since it's a separate line from the `useState` default; both had to
    change together or the reset effect silently stomps the new default
    immediately after mount. Worth remembering for any future default-value
    change in this file: check that `useEffect` for a matching reset line.
