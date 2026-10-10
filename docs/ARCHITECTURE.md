# Architecture & engineering notes

## Layout

| Path | Role |
|---|---|
| `src/components/CornerstoneViewer.jsx` | Cornerstone init, volume loading, 4-viewport MPR + 3D layout, rulers, crosshairs, slice scrolling. The big one. |
| `src/components/LivePanoramic.jsx`, `src/panoramic/archMath.js` | In-browser curved-MPR panoramic, arch auto-fit, cross-section rendering. |
| `src/components/ControlPanel.jsx` | Right-hand tool panel (views, tools, annotation, 3D rendering). |
| `src/components/icat/` | Navigation chrome: menu bar, per-window title bars, context menu, study panel. Chrome only; the imaging code is untouched. |
| `src/utils/quality3d.js` | Adaptive 3D quality controller. |
| `src/utils/deviceDiagnostics.js` | Optional one-shot WebGL/hardware report (no personal data) sent via `sendBeacon`. |
| `src/pages/` | `Login`, `Home`, `CaseList`, `Viewer`. |
| `src/data/cases.js` | Case list and `getImageIds()` (DICOM slice URLs). |
| `src/contexts/AuthContext.jsx` | Demo-only auth. |

Other docs: [`VIEWER_PLAN.md`](VIEWER_PLAN.md) (product spec and build order), [`PANORAMIC_TODO.md`](PANORAMIC_TODO.md),
[`3D_RENDERING_NOTES.md`](3D_RENDERING_NOTES.md), [`ICAT_CLONE.md`](ICAT_CLONE.md) (the navigation-skin notes).

## Rooms (layouts)

The control panel's "Vistas" section switches between three rooms over the same four mounted viewports (no
volume reload on switch):

- **Explorador** — 2×2 MPR + 3D grid.
- **Panorámica** — panoramic across the top, axial / coronal / 3D underneath.
- **Implante** — panoramic + axial on top; a large center cross-section with a 4×2 grid of neighbouring
  cross-sections below. Position along the arch is set by clicking the panoramic; slab thickness (focal trough)
  by an oblique control in its corner. Cuts are cropped to a ~60 mm band around the detected tooth row.

## Panoramic reconstruction

`autoFitArch()` traces a starting arch spline on the axial MIP of the tooth band: it finds the densest z-band,
thresholds the MIP, fits a curve, and the user can drag its control points. The panoramic is a slab-averaged
curved-MPR sampled along that arch, rendered downsampled while dragging and full-resolution on release.

## 3D performance

- **Decoupled 3D volume**: the 3D viewport uses its own downsampled volume (every 3rd slice) so MPR stays sharp
  while rotation stays smooth. Slices are mostly already cached from the MPR load.
- **Adaptive sample distance**: coarse while the camera moves, fine ~250 ms after it stops. The coarse multiplier
  is learned per device from measured frame times (`decideNextQuality()`), persisted in `localStorage`.
- **Mesh fallback**: if a device is still too slow at the coarsest setting for a sustained stretch, the viewer
  flips to a marching-cubes bone surface and remembers that choice.
- **Bone look**: steep opacity ramp, short scalar-opacity unit distance, gradient opacity off, warm-grey → ivory
  color ramp, low specular, so bone reads solid rather than porous.
- **Decode workers** scale with `navigator.hardwareConcurrency` (capped at 4).

## Bugs worth remembering

**`setUseCPURendering(false)` before `csInit()` silently disabled init.** In Cornerstone v4 that call sets
`csRenderInitialized = true` as a side effect, so the real init became a no-op on every device. In particular,
`canUseNorm16Texture` was never detected, so Int16 CT volumes went through vtk.js's lossy half-float texture
fallback (visible banding on high-HU voxels) regardless of GPU. Fix: don't call it; `csInit()` already falls
back to CPU rendering only when there is no WebGL context.

**Upside-down volumes from multi-frame exports.** Some scanner multi-frame exports carry no per-frame geometry —
only one corner position — so the direction frames advance in is a vendor convention. Assuming
`z = z0 + i * spacing` mirrored every volume: S/I labels inverted and the panoramic flip pointed the wrong way.
The slice splitter now counts z *down* from the last frame, and a one-shot repair script (with a marker file so it
can't be applied twice) fixes studies already split.

**Arch auto-fit failed on metal-heavy mouths.** It thresholded the tooth-band MIP at a fixed 97th percentile
with a strict `>`. Amalgams and crowns peg the detector ceiling, so that percentile *was* the ceiling and nothing
passed; the fallback generic U then sat in the sinuses. It now walks the percentile down (0.97 → 0.6), skipping
levels that land on the ceiling, and warns instead of failing silently.

**MPR kept opening at the geometric center, no matter what target was computed.** `CrosshairsTool` owns its own
`toolCenter` and re-syncs every viewport's camera from it once all viewports attach, silently undoing per-viewport
`scroll()` calls. Fix: move the crosshair only through `CrosshairsTool.setToolCenter(worldPoint)`.

**Double-jump on first reveal.** `setVolumesForViewports` already centers each fresh viewport on its middle
slice; the reveal step then scrolled *relative* by `mid` again and overshot to an empty edge slice. Fix: don't
scroll, only sync the slice state used by the slider.

**Teardown race on case switch.** `engine.destroy()` fires an element-disabled event per viewport; with tool
groups still attached, `CrosshairsTool` tried to redraw on a nulled context pool. Fix: destroy tool groups first,
then the engine.

**Missing spatial metadata.** Some datasets lack `ImagePositionPatient` / `ImageOrientationPatient`. The volume
builder's spacing calculation reads metadata for the first *and* middle image; both are pre-loaded and a
synthetic high-priority metadata provider fills the gap when position is missing.

## Conventions

- Plane colors are consistent everywhere they appear (rulers, crosshair ticks, labels): **red = axial,
  green = sagittal, blue = coronal**.
- Wheel zooms; Ctrl+wheel scrolls slices (trackpad pinch carries `ctrlKey`, so use the slider to slice).
- DICOM URLs must include the Vite base path: `import.meta.env.BASE_URL`.
