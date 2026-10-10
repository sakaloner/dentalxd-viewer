# 3D rendering — quality & load-time pass (2026-07-14)

Scope of this pass: `src/components/CornerstoneViewer.jsx`, specifically the
`vol3d` viewport and the DICOM-load path feeding it. No layout/CSS/other
component changes (that was a parallel effort — see the "Vistas" section of
`docs/VIEWER_PLAN.md` for the room-switcher work landed in the same commit).

## What changed

1. **Matte bone-white material, not gold** (`applyBoneLook()`). Replaced the
   stock CT-Bone color transfer (red→gold ramp) with a warm-grey → ivory →
   near-white ramp, low specular (0.08) and modest ambient/diffuse. This is
   plan step 6 ("3D cleanup: matte grey material") — the old gold look read as
   "melted cheese" per the product spec; the new one reads as medical/CT.
   Applied to both the volume-render path and the Superficie mesh material.

2. **Adaptive ray-cast sample distance ("downsample-on-drag")**. The 3D
   viewport now runs a coarse `setSampleDistanceMultiplier` (4x) the instant
   the camera starts moving (rotate/zoom/pan, plus a pre-emptive bump on
   `pointerdown` so even the first drag frame is fast), and snaps back to a
   fine multiplier (0.75x — crisper than Cornerstone's default) 250ms after
   it goes quiet. This is the standard trick for keeping volume ray-casting
   fluid on software/no-GPU WebGL: full resolution only when the picture is
   actually being looked at, not while it's spinning past.

3. **Scaled DICOM decode workers.** `maxWebWorkers` was hardcoded to `1`
   (serializes every slice decode). Now scales with `navigator.hardwareConcurrency`,
   capped at 4 (the client-diagnostics log shows plenty of low-RAM visitor
   machines, and each decode worker carries its own WASM heap, so we didn't
   go higher). This is a load-time fix — speeds up decoding for both the MPR
   volume and the downsampled 3D volume, since they share the same loader.

4. **Fixed v4 scalar-data access for the bone mesh path.** `buildBoneMesh()`
   was calling `vol.getScalarData()` which throws on Cornerstone v4 streaming
   volumes ("No scalar data available" — voxels live per-image in a
   VoxelManager, see the `cornerstone-v4-scalar-data` memory / `archMath.js`
   `getScalars()`). Replaced with a shared `readVolumeScalars()` helper that
   reuses the cached `getScalars()` once the volume finishes streaming, and
   falls back to an uncached `getCompleteScalarDataArray()` snapshot while
   still loading (so the shared cache never freezes a partial volume).

5. **Mesh completeness tracking.** If "Superficie" mode is toggled before the
   3D volume finishes streaming, the mesh now gets silently rebuilt from the
   complete data once loading finishes (`meshCompleteRef` + a check in the
   `vol3d.load()` progress callback), instead of staying frozen at whatever
   partial slice count was in when it was first cut.

6. **3D load progress.** `vol3d.load()`'s progress callback now updates a
   `progress3d` percentage, shown in the existing "Cargando 3D…" overlay and
   as a small non-blocking "3D NN%" badge in the corner once the MPR views
   are already interactive (3D loads lazily/progressively, so this replaces
   silent waiting with a number).

## What did NOT change

`applyMeshMode`'s visibility-toggle logic, the crop tool wiring, the
crosshair-dot projection, the ruler drawing, and everything outside the 3D
viewport were left untouched. The mesh-actor lookup in `applyBoneLook` was
made defensive (`actors.find(a => a.uid !== MESH_ACTOR_UID)` instead of
`actors[0]`) since two actors can now coexist in the viewport.

## Testing notes (important gotcha for next time)

Headless **Chromium** (via CDP, `--headless=new --enable-unsafe-swiftshader`)
reproducibly stalls the MPR volume load at a low, fixed percentage (0%, 6%)
and never completes — **on both this branch and a clean checkout of the prior
commit** (verified with a throwaway `git worktree` on the pre-existing HEAD).
So this is a pre-existing headless-Chromium/SwiftShader software-WebGL
limitation in this sandbox, not a regression from these changes.
**Headless Firefox** (via WebDriver BiDi) loaded the same case end-to-end
correctly — full MPR load, 3D streamed, bone-white render visible — in ~25s,
confirming the changes work. If you need to smoke-test the viewer headless
again, prefer Firefox/BiDi over Chromium/CDP in this environment.

## Verification performed

- `npm run build` — passes.
- `npx eslint src/components/CornerstoneViewer.jsx` — 2 pre-existing errors
  (both present on HEAD before this change, confirmed via a throwaway
  worktree diff), no new ones introduced.
- End-to-end headless-Firefox run of case1: MPR loads, 3D streams and
  renders with the new matte material, "Superficie" mesh mode builds
  correctly, screenshot confirms the visual change.

## Ideas not implemented (left for later, not urgent)

- Progressive mesh LOD (coarse marching-cubes pass first, refine after) —
  currently mesh extraction is one-shot at whatever downsample the 3D volume
  loaded at.
- `STEP_3D`'s fixed 3x slice decimation is still static per case, not
  per-device — see the follow-up pass below, which covers the same "device
  can't handle it" population via the mesh-mode fallback instead.

## Follow-up pass (2026-07-16): init-order bug + adaptive quality

The "GPU-tier detection" idea above turned out unnecessary once the actual
root cause was found: `CornerstoneViewer.jsx`'s `initCornerstone()` called
`setUseCPURendering(false)` *before* `csInit()`, and in Cornerstone v4 that
call sets `csRenderInitialized = true` as a side effect — so the real
`csInit()` was a silent no-op on every device, including capable GPUs. The
main casualty was `canUseNorm16Texture` never being detected, sending Int16
CT volumes through vtk.js's lossy half-float texture fallback (visible
banding on high-HU voxels) regardless of hardware. Fix: don't call
`setUseCPURendering()` at all — `csInit()`'s own logic already only falls
back to CPU rendering when there's no WebGL context at all.

Separately, `SAMPLE_MULT_INTERACTIVE` (now `SAMPLE_MULT_INTERACTIVE_DEFAULT`,
only used as the very first session's starting guess) is no longer a fixed
constant applied to every device. `src/utils/quality3d.js` adds a measured,
closed-loop controller: a `requestAnimationFrame` loop running only while
the user is dragging the 3D view feeds the actual average frame time to
`decideNextQuality()`, which coarsens the sample-distance multiplier when
frames are slow, sharpens it when there's comfortable headroom, and signals
a fallback to mesh mode if even the coarsest multiplier can't sustain a
reasonable frame rate for a sustained stretch. The learned multiplier and
the mesh-fallback decision both persist to `localStorage` per device/browser
(`Viewer.jsx` seeds `mesh3d`'s initial state and per-case reset from the
persisted flag), so a device only has to struggle through the discovery
process once. See the "3D rendering performance" section of `viewer/CLAUDE.md`
for the user-facing summary.
