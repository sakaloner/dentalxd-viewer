import { useEffect, useRef, useState, useCallback } from 'react'
import {
  init as csInit,
  RenderingEngine,
  Enums,
  volumeLoader,
  imageLoader,
  metaData,
  setVolumesForViewports,
  cache,
  cornerstoneStreamingImageVolumeLoader,
  utilities as csUtils,
  eventTarget,
} from '@cornerstonejs/core'
import {
  init as csToolsInit,
  addTool,
  ToolGroupManager,
  Enums as ToolEnums,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  TrackballRotateTool,
  LengthTool,
  CrosshairsTool,
  VolumeCroppingTool,
  VolumeCroppingControlTool,
  annotation,
  utilities as csToolsUtils,
} from '@cornerstonejs/tools'
import { init as dicomImageLoaderInit } from '@cornerstonejs/dicom-image-loader'
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData'
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray'
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes'
import vtkWindowedSincPolyDataFilter from '@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter'
import vtkPolyDataNormals from '@kitware/vtk.js/Filters/Core/PolyDataNormals'
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper'
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor'
import { getImageIds } from '../data/cases'
import { getScalars, renderLineSlice, scalarsToImageData } from '../panoramic/archMath'
import { dragBoundary } from '../utils/splitResize'
import {
  decideNextQuality,
  getPersistedQuality,
  setPersistedQuality,
  setPersistedMeshFallback,
} from '../utils/quality3d'

const RENDERING_ENGINE_ID = 'dentalxd-engine'
let csInitialized = false

function initCornerstone() {
  if (csInitialized) return
  csInitialized = true
  // Don't call setUseCPURendering() here: in Cornerstone v4 it marks init as
  // already-done (csRenderInitialized = true), which makes the real csInit()
  // below silently no-op — norm16 texture detection never runs, so Int16 CT
  // volumes fall back to a lossy half-float texture path (visible banding on
  // high-HU voxels like bone/enamel) on every device, GPU or not. csInit()'s
  // own logic already only falls back to CPU rendering when there's no WebGL
  // context at all, so it doesn't need help forcing GPU on.
  csInit()
  csToolsInit()
  // DICOM decode is the volume-load bottleneck — with 1 worker every slice
  // decodes serially. Scale with the machine's cores, capped at 4: the client
  // diagnostics log shows plenty of low-RAM visitor machines, and each decode
  // worker carries its own WASM heap.
  const cores = navigator.hardwareConcurrency || 2
  dicomImageLoaderInit({ maxWebWorkers: Math.min(Math.max(1, cores - 1), 4) })
  volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstoneStreamingImageVolumeLoader,
  )
  // Register tools globally — required before any tool group can use them
  addTool(WindowLevelTool)
  addTool(PanTool)
  addTool(ZoomTool)
  addTool(StackScrollTool)
  addTool(TrackballRotateTool)
  addTool(LengthTool)
  addTool(CrosshairsTool)
  addTool(VolumeCroppingTool)
  addTool(VolumeCroppingControlTool)
}

const { ViewportType, OrientationAxis } = Enums
const TOOL_GROUP_3D_ID = 'vol3d-group'
const { MouseBindings } = ToolEnums

// Crosshairs: one colored reference line per plane. Dragging a line in any
// viewport reslices the other two through that point; the handles let you
// rotate for oblique cuts. Each plane's lines are drawn in its own color so
// you can tell axial/sagittal/coronal apart across the three views.
// Matches real i-CAT Vision's plane color coding (per the iCATVision Quick
// Reference manual: "The Coronal, Axial, and Sagittal Planes are color coded
// ... as Red, Green, and Blue" — Axial=red, Sagittal=green, Coronal=blue).
const CROSSHAIR_COLORS = {
  axial:    'rgb(232, 90, 79)',   // red   — Axial (Z)
  sagittal: 'rgb(90, 200, 120)',  // green — Sagittal (X)
  coronal:  'rgb(70, 130, 240)',  // blue  — Coronal (Y)
}
const VIEWPORT_AXIS = { axial: 'Z', sagittal: 'X', coronal: 'Y' }
// Standard radiological patient-orientation letters at the four edges of each
// standard (non-oblique) MPR plane. Hardcoded for the default orthogonal
// views — if the crosshair rotate handles tilt a plane these stay approximate.
const ORIENTATION_LABELS = {
  axial:    { top: 'A', bottom: 'P', left: 'R', right: 'L' },
  sagittal: { top: 'S', bottom: 'I', left: 'A', right: 'P' },
  coronal:  { top: 'S', bottom: 'I', left: 'R', right: 'L' },
}
// Each 2D viewport shows the OTHER two planes' reference lines crossing
// through it (never its own): a vertical line marks a constant-X plane
// (sagittal), a horizontal line marks a constant-Y (coronal) or constant-Z
// (axial) plane depending on which view you're in. Used to tick/color the
// crosshair lines with the color of the plane they actually belong to.
const AXIS_LINE_SOURCE = {
  axial:    { x: 'sagittal', y: 'coronal' },
  sagittal: { x: 'coronal',  y: 'axial' },
  coronal:  { x: 'sagittal', y: 'axial' },
}
// vol.spacing index for each axis's own slice-step direction — matches the
// vol.dimensions convention already used elsewhere: [x=sagittal, y=coronal, z=axial].
const AXIS_SPACING_INDEX = { sagittal: 0, coronal: 1, axial: 2 }
const SLICE_STRIP_SIZE = 14 // px — width of the vertical strip / height of the horizontal one
// For a given axis, which {vpId, edge} strips show/control its position —
// the inverse of AXIS_LINE_SOURCE (each axis's line appears in the other two
// viewports, so it's controlled by exactly 2 strips across the grid).
function stripsControllingAxis(axisId) {
  const out = []
  for (const vpId of ['axial', 'sagittal', 'coronal']) {
    if (AXIS_LINE_SOURCE[vpId].x === axisId) out.push({ vpId, edge: 'v' })
    if (AXIS_LINE_SOURCE[vpId].y === axisId) out.push({ vpId, edge: 'h' })
  }
  return out
}
const getReferenceLineColor = (viewportId) => CROSSHAIR_COLORS[viewportId] || 'rgb(200,200,200)'
const getReferenceLineControllable = () => true
const getReferenceLineDraggableRotatable = () => true
// Cornerstone's own slab-thickness handles (native CrosshairsTool feature,
// default `true`) are tiny, clustered at the crosshair center, and only
// render within ~6px of the cursor — not discoverable, and not the
// edge-docked always-visible i-CAT look. Left off in favor of the custom
// drawStrip/.slice-strip-v/.slice-strip-h controls, which call the same
// underlying viewport.setSlabThickness()/setBlendMode() directly.
const getReferenceLineSlabThicknessControlsOn = () => false

// Crop-boundary lines in the MPR views are orange — one uniform color, so they
// can't be confused with the red/yellow/green crosshair reference lines.
const getCropLineColor = () => 'rgb(255, 150, 50)'

// Downsample factor for the 3D volume only. The MPR views load every slice
// (step=1) for full definition; the 3D render doesn't need that density and
// thinning it keeps rotation smooth on machines without GPU acceleration.
// step=3 (every 3rd slice) is a good balance for software WebGL on a laptop.
const STEP_3D = 3

// i-CAT's Preview screen ("Vista previa") shows Sagittal/Coronal as thick MIP
// slabs — solid-looking "pictures" (iCATVision manual: Ceph's mid-sagittal
// slice is 15mm thick; Preview's Volume-of-Interest panels read the same way
// in real screenshots) — not the thin, single-voxel browsable slices the MPR
// room uses. Axial keeps its thin slice + arch overlay; only Sagittal/Coronal
// go thick. The horizontal position strip on both still drags the shared
// Axial slice (AXIS_LINE_SOURCE routes both their h-edges to 'axial'), so
// that's the one thing that still moves them.
const PREVIEW_SLAB_MM = 20

// UID for the extracted bone-surface mesh actor added to the 3D viewport in
// "Superficie" mode (marching cubes on the 3D volume, see buildBoneMesh).
const MESH_ACTOR_UID = 'bone-surface-mesh'

// Adaptive ray-casting quality ("downsample-on-drag", plan step 6): while the
// camera is moving the volume is sampled coarsely so rotation stays fluid even
// on weak/no GPU acceleration; when interaction stops, one fine-sampled render
// restores full crispness. Multipliers scale the mapper's default sample
// distance (mean voxel spacing / 2) via viewport.setSampleDistanceMultiplier.
// The *interactive* multiplier isn't a fixed constant — see quality3d.js:
// it's measured and learned per device (a fixed value is either too coarse,
// permanently blocky, on a capable GPU, or not coarse enough to stay smooth
// on a weak one). SAMPLE_MULT_INTERACTIVE_DEFAULT is only the safe starting
// point for a device with no learned value yet.
const SAMPLE_MULT_IDLE = 0.75             // finer than default → crisper still image
const SAMPLE_MULT_INTERACTIVE_DEFAULT = 4 // starting guess before any device learning
const SAMPLE_IDLE_DELAY_MS = 250
const QUALITY_ADAPT_EVERY_N_FRAMES = 12   // ~200-400ms of drag between adaptation ticks

// Shape the 3D volume rendering so bone and soft tissue read as solid surfaces
// instead of a porous/hollow shell:
//  - a steep opacity ramp reaches near-opaque just above the density threshold,
//  - a short scalar-opacity unit distance makes opacity accumulate faster along
//    each ray (thin/noisy trabecular bone fills in instead of showing through),
//  - gradient opacity is disabled so edge-weighting doesn't eat away noisy voxels,
//  - the CT-Bone preset's red→gold color ramp is replaced with a neutral matte
//    ivory (the plan calls the gold look "melted cheese" — grey/bone-white
//    reads as medical), lit softly with low specular so it doesn't shine.
function applyBoneLook(viewport3d, threshold) {
  const actors = viewport3d.getActors()
  if (!actors || actors.length === 0) return
  const volEntry = actors.find(a => a.uid !== MESH_ACTOR_UID)
  if (!volEntry) return
  const prop = volEntry.actor.getProperty()

  const ofun = prop.getScalarOpacity(0)
  ofun.removeAllPoints()
  ofun.addPoint(threshold - 1, 0)
  ofun.addPoint(threshold, 0.5)
  ofun.addPoint(threshold + 120, 0.9)
  ofun.addPoint(3071, 1.0)

  const cfun = prop.getRGBTransferFunction(0)
  cfun.removeAllPoints()
  cfun.addRGBPoint(threshold, 0.55, 0.53, 0.50)       // recessed bone — warm grey
  cfun.addRGBPoint(threshold + 300, 0.86, 0.84, 0.80) // cortical bone — ivory
  cfun.addRGBPoint(1800, 0.95, 0.94, 0.91)            // enamel — near-white
  cfun.addRGBPoint(3071, 1.0, 1.0, 1.0)

  prop.setScalarOpacityUnitDistance(0, 0.6)
  prop.setUseGradientOpacity(0, false)
  prop.setInterpolationTypeToLinear()
  prop.setShade(true)
  prop.setAmbient(0.3)
  prop.setDiffuse(0.8)
  prop.setSpecular(0.08)
  prop.setSpecularPower(8)

  viewport3d.render()
}

// Full-volume scalar array, v4-safe: StreamingImageVolume.getScalarData()
// throws ("No scalar data available") — voxels live per-image in a
// VoxelManager. Use the cached archMath getScalars() once the volume is fully
// loaded; while still streaming, getCompleteScalarDataArray() allocates a
// fresh (huge — the whole volume) array on every call, so it's deliberately
// NOT put in that shared cache (which never invalidates a partial snapshot).
// But this is also the hot path for the mousemove HU cursor readout, which
// fires dozens of times a second — calling the uncached assembly on every
// single mousemove event was blocking the main thread long enough to trigger
// Chrome's "page unresponsive" freeze while a scan was still streaming. A
// short TTL re-uses the last snapshot across a burst of mousemoves instead of
// rebuilding the whole array each time; short enough that the HU readout
// still tracks new frames arriving within a few hundred ms.
const PARTIAL_SCALARS_TTL_MS = 300
let partialScalarsCache = { vol: null, data: null, ts: 0 }
function readVolumeScalars(vol) {
  if (!vol) return null
  if (vol.loadStatus?.loaded) return getScalars(vol)
  const now = performance.now()
  if (partialScalarsCache.vol === vol && now - partialScalarsCache.ts < PARTIAL_SCALARS_TTL_MS) {
    return partialScalarsCache.data
  }
  try {
    const data = vol.voxelManager?.getCompleteScalarDataArray?.() ?? null
    partialScalarsCache = { vol, data, ts: now }
    return data
  } catch {
    return null
  }
}

// engine.resize() is a silent no-op if a render is already in flight
// (RenderingEngine._animationFrameSet) when it's called — cornerstone drops
// the whole resize request with no error, no retry. That leaves a viewport's
// internal render resolution stuck at its pre-resize size while its on-screen
// canvas box has already moved on, which reads as a viewport gone flat black
// after a panel-resize drag (the vtk offscreen->onscreen blit samples outside
// the stale render target). Since the app renders constantly in the
// background (ruler redraws, camera events), landing a resize exactly when no
// frame is pending isn't reliable — so verify it actually took by comparing
// each vtk-driven viewport's canvas backing-store size to its CSS box, and
// retry across a few animation frames until it matches (or we give up).
function resizeEngineUntilSettled(engine, maxAttempts = 8) {
  if (!engine) return
  const dpr = window.devicePixelRatio || 1
  const attempt = (n) => {
    engine.resize(true, true)
    engine.render()
    requestAnimationFrame(() => {
      const settled = engine.getViewports().every((vp) => {
        const canvas = vp.canvas
        if (!canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return true
        const wantW = Math.round(canvas.clientWidth * dpr)
        const wantH = Math.round(canvas.clientHeight * dpr)
        return canvas.width === wantW && canvas.height === wantH
      })
      if (!settled && n < maxAttempts) attempt(n + 1)
    })
  }
  attempt(0)
}

// Which cornerstone panels each layout "room" shows (see docs/VIEWER_PLAN.md).
// The panoramic / cross-section tiles of the non-explorer rooms are rendered
// by LivePanoramic on top of this grid — here we only arrange/hide the four
// cornerstone viewports (they stay mounted so no volume reload on switch).
const LAYOUT_PANELS = {
  explorer:  ['axial', 'sagittal', 'coronal', 'vol3d'],
  panoramic: ['axial', 'coronal', 'vol3d'],
  implant:   ['axial'],
  diente:    ['vol3d'],
  // i-CAT Vision screens (docs/ICAT_CLONE.md):
  preview:   ['sagittal', 'coronal', 'axial'], // Panorámica docks on top (LivePanoramic); Sagittal/Coronal render as thick MIP slabs, see PREVIEW_SLAB_MM
  tmj:       ['sagittal', 'axial', 'coronal'], // ATM: condyle sagittal + axial + coronal
  patient3d: ['vol3d'],                        // 3D full-screen ("Patient" room)
}

// "Aislar diente" (Room 3 "Patient" from the plan, single-tooth flavor): crop
// the 3D render down to a small box around the shared crosshair so only one
// tooth (plus a little surrounding bone) is left rendering, then re-center
// the orbit pivot on it. Half-extents in mm — roughly a tooth's mesiodistal/
// buccolingual width plus a little margin (x/y), and crown+root height (z).
const TOOTH_HALF_EXTENTS = { x: 9, y: 9, z: 13 }

export default function CornerstoneViewer({ caseData, activeTool, threshold3d, clearSignal, cropResetSignal, isolateToothSignal, resetWLSignal, mesh3d, setMesh3d, layout = 'explorer' }) {
  const axialRef   = useRef(null)
  const sagRef     = useRef(null)
  const corRef     = useRef(null)
  const vol3dRef   = useRef(null)
  const lineCanvasRef = useRef(null) // i-CAT "Línea" reformat panel canvas (replaces 3D in explorer/MPR room)
  const gridRef    = useRef(null) // .viewer-grid element, for drag-resize divider math

  const [loading, setLoading] = useState(true)
  const [loading3d, setLoading3d] = useState(true)
  const [progress3d, setProgress3d] = useState(0)
  const [focusedIdx, setFocusedIdx] = useState(null)
  const [closedIdx, setClosedIdx] = useState(() => new Set()) // panels hidden via the side-strip close button, or dragged-collapsed
  const [colFrac, setColFrac] = useState(0.5) // left-column width fraction of the 2x2 grid, drag-resizable
  // Row split is independent per column (nested split, not a single "+" shared
  // across both columns) — resizing Axial's height no longer drags Sagittal's
  // height along with it. See renderPanel/onLeftRowDividerDown/onRightRowDividerDown.
  const [leftRowFrac, setLeftRowFrac] = useState(0.5)  // Axial/Coronal column
  const [rightRowFrac, setRightRowFrac] = useState(0.5) // Sagittal/3D column
  // Panorámica room's Axial/Coronal/3D row — independently resizable too
  // (2 boundaries splitting 3 boxes, see utils/splitResize.js).
  const [panoRowBounds, setPanoRowBounds] = useState([1 / 3, 2 / 3])
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [totalSlices, setTotalSlices] = useState({ axial: 0, sagittal: 0, coronal: 0 })
  const [currentSlices, setCurrentSlices] = useState({ axial: 0, sagittal: 0, coronal: 0 })
  // Explorer/MPR room's 4th panel content: null (unused, shows the hint), 'line'
  // (Línea reformat canvas on top) or 'explore' (Línea canvas hidden, revealing
  // the real 3D viewport underneath, cropped to the Explorar circle).
  const [panel4Content, setPanel4Content] = useState(null)

  const engineRef       = useRef(null)
  const toolGroupRef    = useRef(null)
  const toolGroup3dRef  = useRef(null)
  const volumeIdRef     = useRef(null)
  const volume3dIdRef   = useRef(null)
  const threshold3dRef  = useRef(threshold3d)
  const cancelRef       = useRef(false)
  const defaultVOIRef   = useRef({}) // { axial, sagittal, coronal } voiRange captured right after load, for "Restablecer ventana/nivel"
  const crosshairDotRef   = useRef(null)  // the DOM dot overlaid on the 3D panel
  const crosshairWorldRef = useRef(null)  // current crosshair center in world coords
  const crosshairListenerRef = useRef(null) // CROSSHAIR_TOOL_CENTER_CHANGED handler
  const camera3dListenerRef  = useRef(null) // CAMERA_MODIFIED handler on the 3D element
  const meshActorRef      = useRef(null)  // vtkActor of the extracted bone surface
  const meshThresholdRef  = useRef(null)  // density level the current mesh was built at
  const meshCompleteRef   = useRef(false) // whether the current mesh was cut from a fully-streamed volume
  const sampleQualityRef  = useRef({ coarse: false, timer: null }) // adaptive 3D sample distance state
  const pointer3dListenerRef = useRef(null) // pointerdown handler on the 3D element, for cleanup
  const mesh3dRef         = useRef(mesh3d) // latest mesh-mode flag for async/threshold code
  const setMesh3dRef      = useRef(setMesh3d) // latest setter, for the async adaptive-quality loop
  // Learned/measured interactive sample-distance quality (quality3d.js) — see
  // startQualityLoop/stopQualityLoop. Seeded from this device's persisted
  // value if it's learned one before, else the same safe default as before.
  const interactiveMultRef = useRef(getPersistedQuality() ?? SAMPLE_MULT_INTERACTIVE_DEFAULT)
  const qualityStateRef    = useRef({ badStreak: 0, goodStreak: 0 })
  const frameTimesRef      = useRef([]) // rolling window of requestAnimationFrame deltas while dragging
  const qualityRafIdRef    = useRef(null)
  const meshRebuildTimerRef = useRef(null) // debounce for re-extracting on Densidad change
  const totalSlicesRef  = useRef({ axial: 0, sagittal: 0, coronal: 0 })
  const currentSlicesRef = useRef({ axial: 0, sagittal: 0, coronal: 0 })
  const userScrolledRef = useRef(false) // true once the user manually changes any slice — blocks the one-time arch-center snap below
  const activeToolRef = useRef(activeTool) // latest activeTool, for the line-draw pointer handlers set up once per volume load
  const layoutRef = useRef(layout) // latest layout prop — drawRuler is called from listeners set up once per volume load (see setup()'s useCallback deps), so it can't read the `layout` prop directly without seeing a stale value frozen at mount (always 'preview')
  const lineRef = useRef(null) // finalized "Línea" reformat: { vpId, p0: [i,j,k], p1: [i,j,k] } in IJK space
  const lineDragRef = useRef(null) // in-progress drag: { vpId, p0, p1 } (p1 unset until the first pointermove)
  const lineListenersRef = useRef({}) // per-viewport pointerdown handler for the line tool, for cleanup
  const exploreDragRef = useRef(null) // in-progress "Explorar" circle drag: { vpId, centerCanvas, centerWorld, curCanvas }
  const exploreListenersRef = useRef({}) // per-viewport pointerdown handler for the explore tool, for cleanup
  // i-CAT-style slice position + slab thickness strips (drawStrip): per-vpId
  // { v: canvasEl, h: canvasEl } and per-vpId { v: onDown, h: onDown } for cleanup.
  const stripCanvasRef = useRef({ axial: {}, sagittal: {}, coronal: {} })
  const stripListenersRef = useRef({ axial: {}, sagittal: {}, coronal: {} })
  const stripDragRef = useRef(null) // in-progress strip drag: { vpId, edge, targetVpId, mode: 'position'|'slab' }
  const rulerCanvasRef  = useRef({ axial: null, sagittal: null, coronal: null })
  const rulerListenersRef = useRef({}) // per-viewport CAMERA_MODIFIED handlers, for cleanup
  const rulerResizeObserverRef = useRef(null) // catches viewport-element box changes (focus toggle, panel resize)
  const cursorReadoutRef = useRef({ axial: null, sagittal: null, coronal: null }) // DOM span per viewport, updated imperatively
  const cursorListenersRef = useRef({}) // per-viewport {onMove, onLeave}, for cleanup

  const setup = useCallback(async () => {
    cancelRef.current = false
    try {
      console.log('[CS] init start')
      initCornerstone()

      // Mirror the MPR crosshair center onto the 3D viewport as a locator dot.
      // Rather than a sphere in the scene (which the opaque bone volume occludes —
      // and for implant planning the point is usually *inside* bone), we project
      // the crosshair's world point to the 3D canvas with worldToCanvas and place
      // an HTML dot there. That keeps it always visible on top of the render.
      // It re-projects on two triggers: the crosshair moving (world point
      // changes) and the 3D camera moving (rotate/zoom/pan changes the
      // projection), so it stays glued to the anatomy as you spin the head.
      crosshairWorldRef.current = null
      userScrolledRef.current = false
      lineRef.current = null
      lineDragRef.current = null
      exploreDragRef.current = null
      stripDragRef.current = null
      setPanel4Content(null)
      // The engine (and its 3D actors) is rebuilt per case, so drop any mesh
      // extracted for the previous case.
      meshActorRef.current = null
      meshThresholdRef.current = null
      meshCompleteRef.current = false
      const positionCrosshairDot = () => {
        const dot = crosshairDotRef.current
        if (!dot) return
        const world = crosshairWorldRef.current
        const viewport3d = engineRef.current?.getViewport('vol3d')
        if (!world || !viewport3d) { dot.style.display = 'none'; return }
        const canvasPt = viewport3d.worldToCanvas(world)
        if (!canvasPt || !Number.isFinite(canvasPt[0]) || !Number.isFinite(canvasPt[1])) {
          dot.style.display = 'none'
          return
        }
        dot.style.left = `${canvasPt[0]}px`
        dot.style.top = `${canvasPt[1]}px`
        dot.style.display = 'block'
      }

      // (Re)wire the crosshair-center listener on the global tools eventTarget.
      if (crosshairListenerRef.current) {
        eventTarget.removeEventListener(
          ToolEnums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
          crosshairListenerRef.current,
        )
      }
      const onCrosshairMove = (evt) => {
        const center = evt.detail?.toolCenter
        if (!center) return
        crosshairWorldRef.current = center
        positionCrosshairDot()
        drawAllRulers()
        drawAllStrips()
      }
      crosshairListenerRef.current = onCrosshairMove
      eventTarget.addEventListener(
        ToolEnums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
        onCrosshairMove,
      )

      // Adaptive 3D quality: drop the volume ray-caster to a coarse sample
      // distance the moment the user starts rotating/zooming, then restore a
      // fine one (single crisp re-render) shortly after the camera goes quiet.
      // setSampleDistanceMultiplier recomputes from voxel spacing each call
      // (absolute, not compounding) and re-renders internally. Skipped in mesh
      // mode — polygons are already cheap and the volume actor is hidden.
      //
      // How coarse "coarse" should be isn't a fixed constant: while dragging,
      // a parallel requestAnimationFrame loop measures actual frame time and
      // hands it to quality3d.js's decideNextQuality, which nudges
      // interactiveMultRef up (still laggy) or down (comfortable headroom) —
      // see startQualityLoop/stopQualityLoop below. This is what lets a
      // capable GPU end up sharper than the old fixed 4x, and a genuinely
      // weak device end up coarser (or fall back to mesh mode) instead of
      // staying stuck at a multiplier that still isn't enough.
      clearTimeout(sampleQualityRef.current.timer)
      sampleQualityRef.current = { coarse: false, appliedMult: null, timer: null }
      const setSampleQuality3d = (coarse) => {
        const target = coarse ? interactiveMultRef.current : SAMPLE_MULT_IDLE
        // Skip redundant calls (every CAMERA_MODIFIED event during a drag hits
        // this) but still re-apply if the adaptive loop nudged the interactive
        // multiplier mid-drag — that's a real target change, not a repeat.
        if (sampleQualityRef.current.coarse === coarse && sampleQualityRef.current.appliedMult === target) return
        const viewport3d = engineRef.current?.getViewport('vol3d')
        if (!viewport3d?.setSampleDistanceMultiplier) return
        sampleQualityRef.current.coarse = coarse
        sampleQualityRef.current.appliedMult = target
        viewport3d.setSampleDistanceMultiplier(target)
      }
      let qualityLastTs = null
      const qualityLoopTick = (ts) => {
        if (qualityLastTs != null) {
          frameTimesRef.current.push(ts - qualityLastTs)
          if (frameTimesRef.current.length >= QUALITY_ADAPT_EVERY_N_FRAMES) {
            const avgFrameMs =
              frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length
            frameTimesRef.current = []
            const next = decideNextQuality({
              avgFrameMs,
              mult: interactiveMultRef.current,
              badStreak: qualityStateRef.current.badStreak,
              goodStreak: qualityStateRef.current.goodStreak,
            })
            qualityStateRef.current = { badStreak: next.badStreak, goodStreak: next.goodStreak }
            if (next.mult !== interactiveMultRef.current) {
              interactiveMultRef.current = next.mult
              setPersistedQuality(next.mult)
              if (sampleQualityRef.current.coarse) setSampleQuality3d(true)
            }
            if (next.fallbackToMesh && !mesh3dRef.current) {
              console.log('[CS] 3D: sustained low frame rate at max quality reduction — falling back to mesh mode')
              setPersistedMeshFallback(true)
              setMesh3dRef.current?.(true)
              qualityRafIdRef.current = null
              return // stop the loop; mesh mode doesn't need sample-distance adaptation
            }
          }
        }
        qualityLastTs = ts
        qualityRafIdRef.current = requestAnimationFrame(qualityLoopTick)
      }
      const startQualityLoop = () => {
        if (qualityRafIdRef.current != null) return
        qualityLastTs = null
        frameTimesRef.current = []
        qualityRafIdRef.current = requestAnimationFrame(qualityLoopTick)
      }
      const stopQualityLoop = () => {
        if (qualityRafIdRef.current != null) cancelAnimationFrame(qualityRafIdRef.current)
        qualityRafIdRef.current = null
        frameTimesRef.current = []
      }
      const onInteraction3d = () => {
        if (mesh3dRef.current) return
        setSampleQuality3d(true)
        startQualityLoop()
        clearTimeout(sampleQualityRef.current.timer)
        sampleQualityRef.current.timer = setTimeout(() => {
          setSampleQuality3d(false)
          stopQualityLoop()
        }, SAMPLE_IDLE_DELAY_MS)
      }

      // Re-project the dot whenever the 3D camera changes (rotate/zoom/pan).
      if (camera3dListenerRef.current && vol3dRef.current) {
        vol3dRef.current.removeEventListener(
          Enums.Events.CAMERA_MODIFIED,
          camera3dListenerRef.current,
        )
      }
      const onCamera3dModified = () => {
        positionCrosshairDot()
        onInteraction3d()
      }
      camera3dListenerRef.current = onCamera3dModified
      vol3dRef.current?.addEventListener(Enums.Events.CAMERA_MODIFIED, onCamera3dModified)

      // Coarsen preemptively on pointerdown so even the first drag frame is fast.
      if (pointer3dListenerRef.current && vol3dRef.current) {
        vol3dRef.current.removeEventListener('pointerdown', pointer3dListenerRef.current)
      }
      pointer3dListenerRef.current = onInteraction3d
      vol3dRef.current?.addEventListener('pointerdown', onInteraction3d)

      if (engineRef.current) {
        // Destroy tool groups before the engine: engine.destroy() fires an
        // ELEMENT_DISABLED event per viewport, and if the tool groups are
        // still attached, CrosshairsTool's listener tries to redraw using
        // that viewport's camera — which throws, because engine.destroy()
        // has already nulled its context pool by that point.
        ToolGroupManager.destroyToolGroup('mpr-group')
        ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID)
        engineRef.current.destroy()
        engineRef.current = null
      }

      const volumeId = `cornerstoneStreamingImageVolume:${caseData.id}`
      volumeIdRef.current = volumeId

      if (cache.getVolume(volumeId)) cache.removeVolumeLoadObject(volumeId)

      const imageIds = getImageIds(caseData)
      console.log('[CS] imageIds[0]:', imageIds[0], 'count:', imageIds.length)

      // Verify first file is reachable before committing to full load
      const testUrl = imageIds[0].replace('wadouri:', '')
      const res = await fetch(testUrl, { method: 'HEAD' })
      if (cancelRef.current) return
      console.log('[CS] HEAD first slice:', res.status)

      const engine = new RenderingEngine(RENDERING_ENGINE_ID)
      console.log('[CS] engine created')
      engineRef.current = engine

      engine.setViewports([
        {
          viewportId: 'axial',
          type: ViewportType.ORTHOGRAPHIC,
          element: axialRef.current,
          defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] },
        },
        {
          viewportId: 'sagittal',
          type: ViewportType.ORTHOGRAPHIC,
          element: sagRef.current,
          defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: [0, 0, 0] },
        },
        {
          viewportId: 'coronal',
          type: ViewportType.ORTHOGRAPHIC,
          element: corRef.current,
          defaultOptions: { orientation: OrientationAxis.CORONAL, background: [0, 0, 0] },
        },
        {
          viewportId: 'vol3d',
          type: ViewportType.VOLUME_3D,
          element: vol3dRef.current,
          defaultOptions: { background: [0, 0, 0] },
        },
      ])

      // Tool group for MPR viewports
      ToolGroupManager.destroyToolGroup('mpr-group')
      const tg = ToolGroupManager.createToolGroup('mpr-group')
      toolGroupRef.current = tg
      tg.addTool(WindowLevelTool.toolName)
      tg.addTool(PanTool.toolName)
      tg.addTool(ZoomTool.toolName)
      tg.addTool(StackScrollTool.toolName)
      tg.addTool(LengthTool.toolName)
      tg.addTool(CrosshairsTool.toolName, {
        getReferenceLineColor,
        getReferenceLineControllable,
        getReferenceLineDraggableRotatable,
        getReferenceLineSlabThicknessControlsOn,
        // Bigger than Cornerstone's 3px default — the slab-thickness handles
        // are meant to read as grabbable i-CAT-style boxes, not thin ticks.
        handleRadius: 7,
      })
      // Crop boundary lines (min/max per axis) drawn on the MPR views, synced
      // both ways with the 3D crop box. Only activated while in "Recortar" mode.
      tg.addTool(VolumeCroppingControlTool.toolName, {
        getReferenceLineColor: getCropLineColor,
        viewportIndicators: true,
      })
      tg.addViewport('axial',   RENDERING_ENGINE_ID)
      tg.addViewport('sagittal', RENDERING_ENGINE_ID)
      tg.addViewport('coronal',  RENDERING_ENGINE_ID)
      // Crosshairs are the default left-drag: linked navigation is the headline.
      tg.setToolActive(CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
      tg.setToolActive(PanTool.toolName,         { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
      tg.setToolActive(ZoomTool.toolName,        { bindings: [{ mouseButton: MouseBindings.Secondary }] })
      // Two-finger touch only. NB: the mouse-event matcher (getActiveToolForMouseEvent)
      // ignores numTouchPoints and matches purely on mouseButton, so a Primary binding here
      // would silently hijack every left-click drag — stealing it from LengthTool. Bind touch only.
      tg.setToolActive(StackScrollTool.toolName, { bindings: [{ numTouchPoints: 2 }] })

      // Tool group for 3D viewport.
      // VolumeCroppingTool replaces TrackballRotateTool: dragging empty space
      // rotates the head exactly like the trackball did, dragging a handle
      // sphere moves a crop plane, and Shift+drag rotates the crop planes for
      // oblique cuts. Handles/planes start hidden — "Recortar" mode shows them.
      ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID)
      const tg3d = ToolGroupManager.createToolGroup(TOOL_GROUP_3D_ID)
      toolGroup3dRef.current = tg3d
      tg3d.addTool(VolumeCroppingTool.toolName, {
        showHandles: false,
        showClippingPlanes: false,
        showCornerSpheres: true,
        sphereRadius: 7,
        initialCropFactor: 0.08,
      })
      tg3d.addTool(PanTool.toolName)
      tg3d.addTool(ZoomTool.toolName)
      tg3d.addViewport('vol3d', RENDERING_ENGINE_ID)
      tg3d.setToolActive(VolumeCroppingTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
      tg3d.setToolActive(PanTool.toolName,             { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
      tg3d.setToolActive(ZoomTool.toolName,            { bindings: [{ mouseButton: MouseBindings.Secondary }] })

      // Pre-load slice 0 and the middle slice — the volume builder
      // (calculateSpacingBetweenImageIds) requires metadata for both.
      console.log('[CS] preloading slice 0 and middle slice...')
      const middleIdx = Math.floor(imageIds.length / 2)
      try {
        const [img0] = await Promise.all([
          imageLoader.loadAndCacheImage(imageIds[0]),
          imageLoader.loadAndCacheImage(imageIds[middleIdx]),
        ])
        if (cancelRef.current) return
        console.log('[CS] slices preloaded — rows:', img0.rows, 'cols:', img0.columns)
      } catch (e) {
        console.error('[CS] preload FAILED:', e)
        throw new Error(`Image loader failed: ${e.message}`, { cause: e })
      }

      // If the DICOM files lack spatial tags (ImagePositionPatient / ImageOrientationPatient),
      // inject synthetic axial geometry so the volume builder doesn't throw.
      const plane0 = metaData.get('imagePlaneModule', imageIds[0])
      const hasPosition = Array.isArray(plane0?.imagePositionPatient) && plane0.imagePositionPatient.length === 3
      if (!hasPosition) {
        console.warn('[CS] No ImagePositionPatient — injecting synthetic spatial metadata')
        const spacing = plane0?.columnPixelSpacing ?? plane0?.rowPixelSpacing ?? 0.5
        const frameUID = `synthetic-${caseData.id}`
        const imageIdSet = new Set(imageIds)
        metaData.addProvider((type, imageId) => {
          if (!imageIdSet.has(imageId)) return undefined
          const idx = imageIds.indexOf(imageId)
          if (type === 'imagePlaneModule') {
            return {
              imageOrientationPatient: [1, 0, 0, 0, 1, 0],
              imagePositionPatient: [0, 0, -idx * spacing],
              pixelSpacing: [spacing, spacing],
              rowPixelSpacing: spacing,
              columnPixelSpacing: spacing,
              sliceThickness: spacing,
              frameOfReferenceUID: frameUID,
            }
          }
          if (type === 'frameOfReferenceModule') return { frameOfReferenceUID: frameUID }
        }, 10000)
      }

      console.log('[CS] createAndCacheVolume start')
      const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
      if (cancelRef.current) return
      console.log('[CS] volume created')

      // Associate MPR viewports BEFORE loading so re-renders fire as frames arrive
      console.log('[CS] setVolumesForViewports (MPR)')
      await setVolumesForViewports(engine, [{ volumeId }], ['axial', 'sagittal', 'coronal'])
      console.log('[CS] MPR viewports set')

      // Slice tracking setup (no scroll yet — wait for data)
      const vol = cache.getVolume(volumeId)
      const [sx, sy, sz] = vol.dimensions // x=sagittal, y=coronal, z=axial
      const totals = { axial: sz, sagittal: sx, coronal: sy }
      totalSlicesRef.current = totals
      setTotalSlices(totals)

      // Wheel handling:
      //  - plain wheel → zoom (standard image-viewer convention)
      //  - ctrl+wheel  → scroll slices, slider stays in sync
      // The 3D panel only zooms (no slices to scroll).
      const vpElems = {
        axial: axialRef.current, sagittal: sagRef.current,
        coronal: corRef.current, vol3d: vol3dRef.current,
      }

      // mm rulers: redraw on any camera change (pan/zoom/scroll/crosshair drag)
      // for that specific viewport, AND whenever its box actually resizes
      // (panel focus toggle, control-panel drag-resize — camera events alone
      // would miss those).
      rulerResizeObserverRef.current?.disconnect()
      const rulerRO = new ResizeObserver(entries => {
        for (const entry of entries) {
          const vpId = entry.target === axialRef.current ? 'axial'
            : entry.target === sagRef.current ? 'sagittal'
            : entry.target === corRef.current ? 'coronal' : null
          if (vpId) { drawRuler(vpId); drawStrip(vpId) }
          else if (entry.target === vol3dRef.current) renderLinePanel()
        }
      })
      for (const vpId of ['axial', 'sagittal', 'coronal']) rulerRO.observe(vpElems[vpId])
      if (vol3dRef.current) rulerRO.observe(vol3dRef.current)
      rulerResizeObserverRef.current = rulerRO

      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        const el = vpElems[vpId]
        const prevHandler = rulerListenersRef.current[vpId]
        if (prevHandler) el.removeEventListener(Enums.Events.CAMERA_MODIFIED, prevHandler)
        const handler = () => drawRuler(vpId)
        rulerListenersRef.current[vpId] = handler
        el.addEventListener(Enums.Events.CAMERA_MODIFIED, handler)
      }

      // Cursor readout: world position + density (HU) under the mouse, updated
      // imperatively (no React state) so it stays cheap on every mousemove.
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        const el = vpElems[vpId]
        const prevListeners = cursorListenersRef.current[vpId]
        if (prevListeners) {
          el.removeEventListener('mousemove', prevListeners.onMove)
          el.removeEventListener('mouseleave', prevListeners.onLeave)
        }
        const onMove = (e) => {
          const viewport = engineRef.current?.getViewport(vpId)
          const readoutEl = cursorReadoutRef.current[vpId]
          if (!viewport || !readoutEl) return
          const rect = el.getBoundingClientRect()
          let world
          try { world = viewport.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top]) } catch { return }
          if (!world) return
          const hu = worldToVoxelHU(world)
          const pos = `${world[0].toFixed(1)}, ${world[1].toFixed(1)}, ${world[2].toFixed(1)} mm`
          readoutEl.textContent = hu != null ? `${pos} · ${Math.round(hu)} HU` : pos
        }
        const onLeave = () => {
          const readoutEl = cursorReadoutRef.current[vpId]
          if (readoutEl) readoutEl.textContent = ''
        }
        cursorListenersRef.current[vpId] = { onMove, onLeave }
        el.addEventListener('mousemove', onMove)
        el.addEventListener('mouseleave', onLeave)
      }

      // "Línea" reformat tool (i-CAT context menu → Línea): left-drag on
      // Axial/Sagital/Coronal defines a line in that view's plane; the 4th
      // panel shows the volume reformatted along it (renderLinePanel).
      // Cornerstone has no Primary-button tool bound while activeTool ===
      // 'line' (see the tool-activation effect below), so this owns the left
      // button outright on the 3 MPR panels for the duration of the drag.
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        const el = vpElems[vpId]
        const prevLine = lineListenersRef.current[vpId]
        if (prevLine) el.removeEventListener('pointerdown', prevLine.onDown)
        const onDown = (e) => {
          if (activeToolRef.current !== 'line' || e.button !== 0) return
          const viewport = engineRef.current?.getViewport(vpId)
          const vol = volumeIdRef.current ? cache.getVolume(volumeIdRef.current) : null
          if (!viewport || !vol) return
          e.preventDefault()
          e.stopPropagation()
          const rect = el.getBoundingClientRect()
          const toIJK = (clientX, clientY) => {
            try {
              const world = viewport.canvasToWorld([clientX - rect.left, clientY - rect.top])
              return world ? [...vol.imageData.worldToIndex(world)] : null
            } catch { return null }
          }
          const p0 = toIJK(e.clientX, e.clientY)
          if (!p0) return
          lineDragRef.current = { vpId, p0 }
          const onMove = (ev) => {
            const p1 = toIJK(ev.clientX, ev.clientY)
            if (!p1) return
            lineDragRef.current = { vpId, p0, p1 }
            drawRuler(vpId)
            renderLinePanel()
          }
          const onUp = (ev) => {
            const p1 = toIJK(ev.clientX, ev.clientY) || lineDragRef.current?.p1
            lineDragRef.current = null
            if (p1) {
              lineRef.current = { vpId, p0, p1 }
              setPanel4Content('line')
            }
            drawRuler(vpId)
            renderLinePanel()
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
        }
        lineListenersRef.current[vpId] = { onDown }
        el.addEventListener('pointerdown', onDown)
      }

      // "Explorar" tool (i-CAT context menu → Explorar): left-drag on
      // Axial/Sagital/Coronal draws a circle (center = drag start, radius =
      // drag distance); on release the shared 3D viewport is cropped to a
      // box of that radius around the center (reusing isolateToothAt, same
      // machinery as "Aislar diente") and the 4th panel reveals it — see
      // panel4Content, which hides the Línea canvas overlay while 'explore'.
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        const el = vpElems[vpId]
        const prevExplore = exploreListenersRef.current[vpId]
        if (prevExplore) el.removeEventListener('pointerdown', prevExplore.onDown)
        const onDown = (e) => {
          if (activeToolRef.current !== 'explore' || e.button !== 0) return
          const viewport = engineRef.current?.getViewport(vpId)
          if (!viewport) return
          e.preventDefault()
          e.stopPropagation()
          const rect = el.getBoundingClientRect()
          const canvasPos = (clientX, clientY) => [clientX - rect.left, clientY - rect.top]
          const centerCanvas = canvasPos(e.clientX, e.clientY)
          let centerWorld
          try { centerWorld = viewport.canvasToWorld(centerCanvas) } catch { return }
          if (!centerWorld) return
          exploreDragRef.current = { vpId, centerCanvas, centerWorld, curCanvas: centerCanvas }
          const onMove = (ev) => {
            exploreDragRef.current = { ...exploreDragRef.current, curCanvas: canvasPos(ev.clientX, ev.clientY) }
            drawRuler(vpId)
          }
          const onUp = (ev) => {
            const drag = exploreDragRef.current
            exploreDragRef.current = null
            drawRuler(vpId)
            if (drag) {
              const curCanvas = canvasPos(ev.clientX, ev.clientY)
              let curWorld
              try { curWorld = viewport.canvasToWorld(curCanvas) } catch { curWorld = null }
              const r = curWorld ? Math.hypot(
                curWorld[0] - drag.centerWorld[0],
                curWorld[1] - drag.centerWorld[1],
                curWorld[2] - drag.centerWorld[2],
              ) : 0
              if (r > 1) {
                isolateToothAt(drag.centerWorld, { x: r, y: r, z: r })
                setPanel4Content('explore')
              }
            }
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
        }
        exploreListenersRef.current[vpId] = { onDown }
        el.addEventListener('pointerdown', onDown)
      }

      // i-CAT-style slice position + slab thickness strips (drawStrip): always
      // interactive, regardless of activeTool — matches the old same-axis
      // slider it replaces, which also worked outside any particular tool mode.
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        for (const edge of ['v', 'h']) {
          const canvas = stripCanvasRef.current[vpId]?.[edge]
          if (!canvas) continue
          const prev = stripListenersRef.current[vpId]?.[edge]
          if (prev) canvas.removeEventListener('pointerdown', prev)
          const onDown = (e) => {
            if (e.button !== 0) return
            const src = AXIS_LINE_SOURCE[vpId]
            const targetVpId = edge === 'v' ? src.x : src.y
            const targetViewport = engineRef.current?.getViewport(targetVpId)
            const vol = volumeIdRef.current ? cache.getVolume(volumeIdRef.current) : null
            const total = totalSlicesRef.current[targetVpId]
            if (!targetViewport || !vol || !total) return
            e.preventDefault()
            e.stopPropagation()
            const rect = canvas.getBoundingClientRect()
            const coordOf = (clientX, clientY) => (edge === 'v' ? clientY - rect.top : clientX - rect.left)
            const length = edge === 'v' ? rect.height : rect.width
            const spacing = vol.spacing?.[AXIS_SPACING_INDEX[targetVpId]] || 0.3
            const startFrac = total > 1 ? currentSlicesRef.current[targetVpId] / (total - 1) : 0
            const startPos = startFrac * length
            // Click at/before the handle moves it; click past it (in or beyond
            // the yellow slab region) adjusts thickness from that same anchor.
            const mode = coordOf(e.clientX, e.clientY) <= startPos + 6 ? 'position' : 'slab'

            const applyPosition = (coord) => {
              const f = Math.max(0, Math.min(1, coord / length))
              const next = Math.round(f * (total - 1))
              if (next === currentSlicesRef.current[targetVpId]) return
              userScrolledRef.current = true
              csUtils.scroll(targetViewport, {
                volumeId: volumeIdRef.current,
                delta: next - currentSlicesRef.current[targetVpId],
                loop: false,
              })
              currentSlicesRef.current = { ...currentSlicesRef.current, [targetVpId]: next }
              setCurrentSlices({ ...currentSlicesRef.current })
              drawRuler(targetVpId)
              redrawStripsFor(targetVpId)
            }
            const applySlab = (coord) => {
              const deltaPx = Math.max(0, coord - startPos)
              const mm = Math.max(0.05, (deltaPx / length) * total * spacing)
              const blendMode = mm <= 0.5 ? Enums.BlendModes.COMPOSITE : Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
              targetViewport.setBlendMode(blendMode)
              targetViewport.setSlabThickness(mm)
              targetViewport.render()
              redrawStripsFor(targetVpId)
            }
            const apply = mode === 'position' ? applyPosition : applySlab
            apply(coordOf(e.clientX, e.clientY))

            const onMove = (ev) => apply(coordOf(ev.clientX, ev.clientY))
            const onUp = () => {
              stripDragRef.current = null
              window.removeEventListener('pointermove', onMove)
              window.removeEventListener('pointerup', onUp)
            }
            stripDragRef.current = { vpId, edge, targetVpId, mode }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
          }
          canvas.addEventListener('pointerdown', onDown)
          if (!stripListenersRef.current[vpId]) stripListenersRef.current[vpId] = {}
          stripListenersRef.current[vpId][edge] = onDown
        }
      }

      for (const [vpId, el] of Object.entries(vpElems)) {
        el.addEventListener('wheel', (e) => {
          e.preventDefault()
          const viewport = engineRef.current?.getViewport(vpId)
          if (!viewport) return

          if (!e.ctrlKey || vpId === 'vol3d') {
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
            const z = viewport.getZoom?.() ?? 1
            viewport.setZoom?.(z * factor)
            viewport.render()
            return
          }

          const dir = e.deltaY > 0 ? 1 : -1
          const total = totalSlicesRef.current[vpId]
          const next = Math.max(0, Math.min(total - 1, currentSlicesRef.current[vpId] + dir))
          if (next === currentSlicesRef.current[vpId]) return
          userScrolledRef.current = true
          csUtils.scroll(viewport, { volumeId, delta: next - currentSlicesRef.current[vpId], loop: false })
          currentSlicesRef.current = { ...currentSlicesRef.current, [vpId]: next }
          setCurrentSlices({ ...currentSlicesRef.current })
          drawRuler(vpId)
          redrawStripsFor(vpId) // this axis's position shows in the OTHER two panels' strips, not its own
        }, { passive: false })
      }

      // Load 3D on its OWN downsampled volume so the full-res MPR volume
      // stays sharp while the 3D render stays smooth. Only actually kicked
      // off once MPR has been revealed (see mprRevealed below) — starting it
      // earlier had the 3D decode/GPU work fighting the MPR volume for the
      // same decode-worker pool and GPU memory while MPR was still streaming,
      // which is what made the whole page crash/hang on weaker machines.
      const load3d = async () => {
        try {
          if (cancelRef.current) return
          const imageIds3d = getImageIds(caseData, STEP_3D)
          const volume3dId = `cornerstoneStreamingImageVolume:${caseData.id}-3d`
          volume3dIdRef.current = volume3dId
          if (cache.getVolume(volume3dId)) cache.removeVolumeLoadObject(volume3dId)

          const vol3d = await volumeLoader.createAndCacheVolume(volume3dId, { imageIds: imageIds3d })
          if (cancelRef.current) return
          await setVolumesForViewports(engine, [{ volumeId: volume3dId }], ['vol3d'])
          if (cancelRef.current) return

          const viewport3d = engine.getViewport('vol3d')
          viewport3d.setProperties({ preset: 'CT-Bone' })
          viewport3d.setSampleDistanceMultiplier?.(SAMPLE_MULT_IDLE)
          // Stream the (mostly already-cached) 3D slices, then apply the solid look.
          setProgress3d(0)
          vol3d.load(({ framesLoaded, numFrames } = {}) => {
            if (cancelRef.current) return
            if (numFrames) setProgress3d(Math.round((framesLoaded / numFrames) * 100))
            applyBoneLook(viewport3d, threshold3dRef.current)
            // Volume finished streaming: if the surface mesh was cut from a
            // partial volume (mesh mode selected before/while loading), re-cut
            // it now from complete data so no anatomy is missing.
            if (framesLoaded === numFrames && mesh3dRef.current && !meshCompleteRef.current) {
              if (buildBoneMesh(threshold3dRef.current)) viewport3d.render()
            }
          })
          applyBoneLook(viewport3d, threshold3dRef.current)

          // Seed the locator dot at the current crosshair center (already set
          // once the MPR planes rendered); fall back to the 3D camera focal
          // point if the crosshairs haven't centered yet. Then project it.
          const chTool = toolGroupRef.current?.getToolInstance(CrosshairsTool.toolName)
          const c = chTool?.toolCenter
          crosshairWorldRef.current = (Array.isArray(c) && (c[0] || c[1] || c[2]))
            ? c
            : viewport3d.getCamera().focalPoint
          positionCrosshairDot()

          setLoading3d(false)
          viewport3d.render()
          console.log('[CS] 3D ready')
        } catch (err) {
          console.error('[CS] 3D load failed:', err)
          setLoading3d(false)
        }
      }

      // Stream images — re-render MPR on every frame, reveal at 50% so middle slice has data
      let mprRevealed = false
      console.log('[CS] volume.load() start')
      volume.load(({ framesLoaded, numFrames }) => {
        if (cancelRef.current) return
        const pct = Math.round((framesLoaded / numFrames) * 100)
        setProgress(pct)
        engineRef.current?.renderViewports(['axial', 'sagittal', 'coronal'])

        if (!mprRevealed && framesLoaded >= Math.ceil(numFrames / 2)) {
          mprRevealed = true
          // setVolumesForViewports already called resetCamera() internally,
          // which centers every MPR viewport on its middle slice by default.
          // The geometric middle is frequently nowhere near the teeth — a
          // wide-FOV CBCT extends further into the sinuses/orbits above and
          // the spine/TMJ below (and back) than it does past the lips, so
          // "the middle" shows the base of the skull on axial and the
          // sinuses/nasal cavity on coronal, not the arch.
          //
          // The density-based auto-fit (autoFitArch, still used for the arch
          // curve and the live panoramic) was tried here too, gated behind
          // the volume finishing its full streamed load, but that never
          // reliably fired — confirmed across multiple fixes to both the
          // fit itself and the load-completion check, it just never took
          // effect. Hardcoded fractions of the volume's own dimensions
          // instead (client-specified default, 2026-08-28): no dependency on
          // density data or load-completion timing, so it can't silently
          // fail to apply — axial a quarter of the way up from the bottom
          // (z=0 is inferior — see fix_slice_z_direction.py), coronal a
          // third of the way from the front toward the back (y=0 is
          // anterior/front). Sagittal stays at the geometric left-right
          // center — heads are roughly symmetric there.
          const midSlices = {
            axial:    Math.round(sz * 0.25),
            sagittal: Math.floor(sx / 2),
            coronal:  Math.round(sy / 3),
          }
          currentSlicesRef.current = midSlices
          setCurrentSlices(midSlices)
          // Per-viewport csUtils.scroll() was silently having no visible
          // effect here — CrosshairsTool owns a separate toolCenter (world
          // XYZ) that drives all 3 cameras, and re-derives/reapplies it from
          // its own internal state once every attached viewport is ready
          // (see CrosshairsTool.js's _computeToolCenter), which happens
          // around this same point in the load and stomps a plain per-
          // viewport scroll right back to the geometric center. Go through
          // the tool's own public setToolCenter(worldXYZ) instead — it moves
          // every viewport's camera itself and updates its internal state,
          // so nothing overrides it afterward.
          const chTool = toolGroupRef.current?.getToolInstance(CrosshairsTool.toolName)
          if (chTool) {
            const world = vol.imageData.indexToWorld([midSlices.sagittal, midSlices.coronal, midSlices.axial])
            chTool.setToolCenter(world)
          }
          engineRef.current?.renderViewports(['axial', 'sagittal', 'coronal'])
          // Cornerstone's auto-VOI spans the volume's whole dynamic range,
          // which reads flat/grey — every i-CAT screenshot shows bone bright
          // and saturated instead. Bias the auto-computed window toward its
          // upper half (dense/bone voxels) rather than hardcoding an absolute
          // HU window, since CBCT scanners aren't consistently HU-calibrated
          // the way medical CT is — a fixed absolute window that looks right
          // on one dataset can be wrong on another, but "brighten the top
          // half of whatever range this scan actually has" holds regardless.
          // This becomes the baseline i-CAT's "Restablecer ventana/nivel"
          // returns to, not Cornerstone's raw auto-VOI.
          for (const vpId of ['axial', 'sagittal', 'coronal']) {
            const vp = engineRef.current?.getViewport(vpId)
            const auto = vp?.getProperties()?.voiRange
            if (!auto) continue
            const span = auto.upper - auto.lower
            const boneVOI = { lower: auto.lower + span * 0.15, upper: auto.upper }
            vp.setProperties({ voiRange: boneVOI })
            defaultVOIRef.current[vpId] = { ...boneVOI }
          }
          engineRef.current?.renderViewports(['axial', 'sagittal', 'coronal'])
          setLoading(false) // reveals the slice slider + ruler; ResizeObserver redraws rulers at the current box size
          console.log('[CS] MPR revealed at 50% — starting 3D load')
          load3d()
        }
      })
      console.log('[CS] MPR loading — 3D queued until MPR reveal')
    } catch (err) {
      console.error('Cornerstone setup error:', err)
      setError(err.message || 'Error al cargar el volumen.')
      setLoading(false)
    }
  }, [caseData])

  useEffect(() => {
    setup()
    return () => {
      cancelRef.current = true
      if (crosshairListenerRef.current) {
        eventTarget.removeEventListener(
          ToolEnums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
          crosshairListenerRef.current,
        )
        crosshairListenerRef.current = null
      }
      if (camera3dListenerRef.current && vol3dRef.current) {
        vol3dRef.current.removeEventListener(
          Enums.Events.CAMERA_MODIFIED,
          camera3dListenerRef.current,
        )
        camera3dListenerRef.current = null
      }
      crosshairWorldRef.current = null
      clearTimeout(meshRebuildTimerRef.current)
      clearTimeout(sampleQualityRef.current.timer)
      sampleQualityRef.current = { coarse: false, appliedMult: null, timer: null }
      if (qualityRafIdRef.current != null) {
        cancelAnimationFrame(qualityRafIdRef.current)
        qualityRafIdRef.current = null
      }
      frameTimesRef.current = []
      if (pointer3dListenerRef.current && vol3dRef.current) {
        vol3dRef.current.removeEventListener('pointerdown', pointer3dListenerRef.current)
        pointer3dListenerRef.current = null
      }
      meshActorRef.current = null
      meshThresholdRef.current = null
      meshCompleteRef.current = false
      const rulerEls = { axial: axialRef.current, sagittal: sagRef.current, coronal: corRef.current }
      for (const [vpId, handler] of Object.entries(rulerListenersRef.current)) {
        rulerEls[vpId]?.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler)
      }
      rulerListenersRef.current = {}
      rulerResizeObserverRef.current?.disconnect()
      rulerResizeObserverRef.current = null
      for (const [vpId, listeners] of Object.entries(cursorListenersRef.current)) {
        rulerEls[vpId]?.removeEventListener('mousemove', listeners.onMove)
        rulerEls[vpId]?.removeEventListener('mouseleave', listeners.onLeave)
      }
      cursorListenersRef.current = {}
      for (const [vpId, listeners] of Object.entries(lineListenersRef.current)) {
        rulerEls[vpId]?.removeEventListener('pointerdown', listeners.onDown)
      }
      lineListenersRef.current = {}
      for (const [vpId, listeners] of Object.entries(exploreListenersRef.current)) {
        rulerEls[vpId]?.removeEventListener('pointerdown', listeners.onDown)
      }
      exploreListenersRef.current = {}
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        for (const edge of ['v', 'h']) {
          const canvas = stripCanvasRef.current[vpId]?.[edge]
          const handler = stripListenersRef.current[vpId]?.[edge]
          if (canvas && handler) canvas.removeEventListener('pointerdown', handler)
        }
      }
      stripListenersRef.current = { axial: {}, sagittal: {}, coronal: {} }
      // Destroy tool groups before the engine — see the matching comment in
      // setup()'s defensive pre-cleanup above; same ordering bug applies here.
      ToolGroupManager.destroyToolGroup('mpr-group')
      ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID)
      if (engineRef.current) {
        engineRef.current.destroy()
        engineRef.current = null
      }
      if (volume3dIdRef.current && cache.getVolume(volume3dIdRef.current)) {
        cache.removeVolumeLoadObject(volume3dIdRef.current)
      }
    }
  }, [setup])

  // Switch active tool on MPR viewports when prop changes
  useEffect(() => {
    activeToolRef.current = activeTool
    // Cancel any in-progress "Línea"/"Explorar" drag if the tool changes out from under it.
    if (activeTool !== 'line' && lineDragRef.current) lineDragRef.current = null
    if (activeTool !== 'explore' && exploreDragRef.current) exploreDragRef.current = null
    const tg = toolGroupRef.current
    if (!tg) return

    // Deactivate everything first. Crosshairs goes Passive (not Disabled) so its
    // reference lines stay visible while you W/L, pan, zoom or measure.
    ;[WindowLevelTool, PanTool, ZoomTool, LengthTool, CrosshairsTool].forEach(T =>
      tg.setToolPassive(T.toolName)
    )

    // Crop mode ("Recortar"): orange crop lines on the MPR views + handle
    // spheres on the 3D crop box. Leaving crop mode disables the control tool
    // (its lines disappear) and hides the 3D handles, but the crop itself
    // stays applied so you can measure/navigate the cropped volume.
    const cropTool = toolGroup3dRef.current?.getToolInstance(VolumeCroppingTool.toolName)
    if (activeTool === 'crop') {
      tg.setToolActive(VolumeCroppingControlTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
      tg.setToolActive(PanTool.toolName,  { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
      tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] })
      cropTool?.setClippingPlanesVisible(true)
      return
    }
    tg.setToolDisabled(VolumeCroppingControlTool.toolName)
    if (cropTool?.getClippingPlanesVisible()) cropTool.setHandlesVisible(false)

    if (activeTool === 'crosshair') {
      // Left-drag moves the crosshair (reslices the other planes); keep pan/zoom.
      tg.setToolActive(CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
      tg.setToolActive(PanTool.toolName,  { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
      tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] })
    } else if (activeTool === 'length') {
      // Length gets left-click; no other mouse bindings so they don't interfere
      tg.setToolActive(LengthTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
    } else {
      // Normal mode: selected tool on left-click, pan on middle, zoom on right
      const toolMap = {
        wl:   WindowLevelTool.toolName,
        pan:  PanTool.toolName,
        zoom: ZoomTool.toolName,
      }
      const toolName = toolMap[activeTool]
      if (toolName) {
        tg.setToolActive(toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
      }
      tg.setToolActive(PanTool.toolName,  { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
      tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] })
    }
  }, [activeTool])

  // Update 3D threshold — re-applies the solid bone/tissue look at the new
  // density cutoff (voxels below the threshold stay transparent).
  useEffect(() => {
    threshold3dRef.current = threshold3d
    const viewport3d = engineRef.current?.getViewport('vol3d')
    if (!viewport3d) return
    // Keep the volume look in sync so it's correct if the user toggles back.
    applyBoneLook(viewport3d, threshold3d)
    // In surface mode the slider re-cuts the iso-surface. Marching cubes is too
    // heavy to run on every slider tick, so debounce to the last value.
    if (mesh3dRef.current) {
      clearTimeout(meshRebuildTimerRef.current)
      meshRebuildTimerRef.current = setTimeout(() => {
        if (buildBoneMesh(threshold3dRef.current)) {
          engineRef.current?.getViewport('vol3d')?.render()
        }
      }, 300)
    }
  }, [threshold3d])

  // Toggle the 3D viewport between volume render and bone-surface mesh.
  // Re-runs when the 3D volume finishes loading (loading3d → false) so a
  // pre-selected surface mode is applied as soon as the data is ready.
  useEffect(() => {
    mesh3dRef.current = mesh3d
    setMesh3dRef.current = setMesh3d
    if (loading3d) return
    applyMeshMode(mesh3d)
  }, [mesh3d, setMesh3d, loading3d])

  // "Quitar recorte": reset the crop box to its default bounds and remove the
  // clipping planes so the full head renders again. cropResetSignal starts at 0
  // (skip) and increments on each click.
  useEffect(() => {
    if (!cropResetSignal) return
    const cropTool = toolGroup3dRef.current?.getToolInstance(VolumeCroppingTool.toolName)
    if (!cropTool) return
    cropTool._onNewVolume()                  // rebuild box at default bounds
    cropTool.setClippingPlanesVisible(false) // un-crop + hide handles
  }, [cropResetSignal])

  // "Aislar diente": crop to a small box around the current crosshair position
  // and re-center the 3D pivot there. isolateToothSignal starts at 0 (skip) and
  // increments on each click of the "Diente" view button, so re-clicking it
  // re-isolates around wherever the crosshair has since moved to.
  useEffect(() => {
    if (!isolateToothSignal) return
    isolateToothAt(crosshairWorldRef.current)
  }, [isolateToothSignal])

  // i-CAT's "Restablecer ventana/nivel" / "Restablecer todas las ventanas":
  // put each MPR viewport's window/level back to what it was right after the
  // volume loaded (captured in defaultVOIRef above) — brightness/contrast
  // only, camera pan/zoom/rotation are left alone. resetWLSignal starts at 0
  // (skip) and increments on each menu click.
  useEffect(() => {
    if (!resetWLSignal) return
    for (const vpId of ['axial', 'sagittal', 'coronal']) {
      const voiRange = defaultVOIRef.current[vpId]
      const vp = engineRef.current?.getViewport(vpId)
      if (voiRange && vp) vp.setProperties({ voiRange })
    }
    engineRef.current?.renderViewports(['axial', 'sagittal', 'coronal'])
  }, [resetWLSignal])

  // Preview screen: Sagittal/Coronal go thick-MIP, Axial stays thin (see
  // PREVIEW_SLAB_MM). Reset to thin/COMPOSITE on any other layout so the MPR
  // room's Sagittal/Coronal aren't left in MIP mode from a prior visit here.
  useEffect(() => {
    for (const vpId of ['sagittal', 'coronal']) {
      const vp = engineRef.current?.getViewport(vpId)
      if (!vp) continue
      if (layout === 'preview') {
        vp.setBlendMode(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND)
        vp.setSlabThickness(PREVIEW_SLAB_MM)
      } else {
        vp.setBlendMode(Enums.BlendModes.COMPOSITE)
        vp.setSlabThickness(0.05)
      }
      vp.render()
    }
  }, [layout, loading])

  // The Línea panel repaints on Axial/Sagital/Coronal camera changes and box
  // resizes (wired in setup()), but not on switching *into* explorer — the
  // canvas was display:none (0×0) the whole time it was hidden, so paint it
  // once it actually has a size.
  useEffect(() => {
    if (layout === 'explorer') renderLinePanel()
  }, [layout])

  // Clear all measurements when the toolbar "Borrar" button is pressed.
  // clearSignal starts at 0 (skip) and increments on each click.
  useEffect(() => {
    if (!clearSignal) return
    // Remove only measurement annotations — leave the crosshairs intact.
    const all = annotation.state.getAllAnnotations()
    for (const a of all) {
      if (a.metadata?.toolName === LengthTool.toolName) {
        annotation.state.removeAnnotation(a.annotationUID)
      }
    }
    // Re-render the annotation layer so the erased lines disappear immediately.
    csToolsUtils.triggerAnnotationRenderForViewportIds(['axial', 'sagittal', 'coronal'])
    // "Borrar mediciones" also clears the Línea reformat — it's a drawn
    // annotation in the same sense, just rendered into the 4th panel instead
    // of as a Cornerstone annotation.
    if (lineRef.current) {
      const sourceVp = lineRef.current.vpId
      lineRef.current = null
      setPanel4Content(prev => (prev === 'line' ? null : prev))
      drawRuler(sourceVp)
      renderLinePanel()
    }
  }, [clearSignal])

  // Extract an opaque bone surface from the 3D volume with marching cubes and
  // put it in the 3D viewport as a lit mesh. This is the fast, clean 3D for
  // GPU-less machines: a polygon surface renders far cheaper than volume
  // ray-casting and reads as solid instead of porous. `threshold` is the same
  // density value the Densidad slider feeds the volume look, reused here as the
  // iso-surface level. Runs on the (downsampled) 3D volume, in that volume's
  // exact world frame so it lines up with the MPR crosshair. Returns success.
  function buildBoneMesh(threshold) {
    const viewport3d = engineRef.current?.getViewport('vol3d')
    const vol = volume3dIdRef.current ? cache.getVolume(volume3dIdRef.current) : null
    if (!viewport3d || !vol) return false
    const scalars = readVolumeScalars(vol)
    if (!scalars || !scalars.length) return false

    try {
      // Rebuild a plain vtkImageData carrying the volume's scalars in its exact
      // world geometry (origin/spacing/direction) — the marching-cubes output
      // then shares the patient coordinate frame of the MPR views.
      const image = vtkImageData.newInstance()
      image.setDimensions(vol.dimensions)
      image.setSpacing(vol.spacing)
      image.setOrigin(vol.origin)
      image.setDirection(vol.direction)
      image.getPointData().setScalars(
        vtkDataArray.newInstance({ name: 'scalars', numberOfComponents: 1, values: scalars }),
      )

      const mc = vtkImageMarchingCubes.newInstance({
        contourValue: threshold,
        computeNormals: false,
        mergePoints: true,
      })
      mc.setInputData(image)
      // The 3D volume is downsampled, so raw marching cubes is blocky. Smooth
      // the surface, then recompute point normals for clean, non-faceted shading.
      const smooth = vtkWindowedSincPolyDataFilter.newInstance({
        numberOfIterations: 20,
        passBand: 0.02,
        boundarySmoothing: true,
        featureEdgeSmoothing: false,
        nonManifoldSmoothing: false,
      })
      smooth.setInputConnection(mc.getOutputPort())
      const normals = vtkPolyDataNormals.newInstance({
        computePointNormals: true,
        computeCellNormals: false,
      })
      normals.setInputConnection(smooth.getOutputPort())

      const mapper = vtkMapper.newInstance({ scalarVisibility: false })
      mapper.setInputConnection(normals.getOutputPort())

      // Reuse the existing actor when re-extracting (threshold change) so we
      // don't churn the renderer's actor list; otherwise create and register it.
      let actor = meshActorRef.current
      if (!actor) {
        actor = vtkActor.newInstance()
        viewport3d.addActor({ uid: MESH_ACTOR_UID, actor })
        meshActorRef.current = actor
      }
      actor.setMapper(mapper)
      const prop = actor.getProperty()
      prop.setColor(0.92, 0.90, 0.86)  // matte bone-white (plan step 6: grey/white, not gold)
      prop.setAmbient(0.28)
      prop.setDiffuse(0.85)
      prop.setSpecular(0.08)
      prop.setSpecularPower(10)
      meshThresholdRef.current = threshold
      meshCompleteRef.current = vol.loadStatus?.loaded === true
      return true
    } catch (e) {
      console.error('[CS] bone mesh extraction failed:', e)
      return false
    }
  }

  // Switch the 3D viewport between the volume render and the bone-surface mesh.
  // Both actors live in the same viewport; we just flip visibility (building the
  // mesh lazily on first entry, or when the threshold changed since last build).
  function applyMeshMode(on) {
    const viewport3d = engineRef.current?.getViewport('vol3d')
    if (!viewport3d) return
    if (on) {
      if (!meshActorRef.current || meshThresholdRef.current !== threshold3dRef.current) {
        if (!buildBoneMesh(threshold3dRef.current)) return
      }
    }
    viewport3d.getActors().forEach(({ uid, actor }) => {
      const isMesh = uid === MESH_ACTOR_UID
      actor.setVisibility(on ? isMesh : !isMesh)
    })
    viewport3d.render()
  }

  // Crop the 3D volume down to a small box around `worldPoint` (the shared
  // crosshair center) and re-center the orbit pivot there — "here's your
  // tooth" for Room 3 / the "Diente" view. Reuses VolumeCroppingTool (the same
  // tool behind "Recortar"), but drives its clipping planes directly instead
  // of via sphere-dragging, since it has no public "set box to these bounds"
  // API. This pokes underscore-prefixed internals (same as the existing
  // cropResetSignal effect's `_onNewVolume()` call above) — fragile against a
  // @cornerstonejs/tools upgrade, but there's no supported alternative today.
  function isolateToothAt(worldPoint, halfExtents = TOOTH_HALF_EXTENTS) {
    const viewport3d = engineRef.current?.getViewport('vol3d')
    const cropTool = toolGroup3dRef.current?.getToolInstance(VolumeCroppingTool.toolName)
    if (!viewport3d || !cropTool || !worldPoint) return false

    // Make sure the tool has run its one-time setup (direction vectors, default
    // box) at least once — it normally already has, from onSetToolActive when
    // the 3D viewport was first added.
    if (!cropTool.sphereStates?.length) cropTool._onNewVolume()
    const dirs = cropTool.volumeDirectionVectors
    if (!dirs) return false
    const { xDir, yDir, zDir } = dirs
    const { x: hx, y: hy, z: hz } = halfExtents

    const along = (dir, mm) => [
      worldPoint[0] + dir[0] * mm,
      worldPoint[1] + dir[1] * mm,
      worldPoint[2] + dir[2] * mm,
    ]
    const flip = (dir) => [-dir[0], -dir[1], -dir[2]]

    // Same shape/order (XMIN, XMAX, YMIN, YMAX, ZMIN, ZMAX) as the tool builds
    // for its own default box in _initialize3DViewports.
    const planes = [
      { origin: along(xDir, -hx), normal: [...xDir] },
      { origin: along(xDir, hx),  normal: flip(xDir) },
      { origin: along(yDir, -hy), normal: [...yDir] },
      { origin: along(yDir, hy),  normal: flip(yDir) },
      { origin: along(zDir, -hz), normal: [...zDir] },
      { origin: along(zDir, hz),  normal: flip(zDir) },
    ]

    // Same path the 2D crop-line control tool uses to push a new box into this
    // tool: sets originalClippingPlanes, repositions all handle spheres to
    // match (so "Recortar" stays consistent if opened afterward), applies to
    // the mapper, and notifies the MPR crop-line overlay. Does NOT set
    // configuration.showClippingPlanes, so that's done explicitly first —
    // otherwise the next camera-modified event (the very next orbit) would
    // strip the clipping planes back off again.
    cropTool.configuration.showClippingPlanes = true
    cropTool._onControlToolChange({
      detail: { seriesInstanceUID: cropTool.seriesInstanceUID, clippingPlanes: planes },
    })
    cropTool.setHandlesVisible(false) // isolate is a clean show-and-tell view, no crop handles

    // Re-center the pivot on the tooth (keep the current viewing angle and
    // distance — dolly-in has no visual effect here, see below) and zoom in
    // so the isolated box fills the frame.
    const camera = viewport3d.getCamera()
    const toOld = [
      camera.position[0] - camera.focalPoint[0],
      camera.position[1] - camera.focalPoint[1],
      camera.position[2] - camera.focalPoint[2],
    ]
    const oldDist = Math.hypot(...toOld) || 1
    const dir = [toOld[0] / oldDist, toOld[1] / oldDist, toOld[2] / oldDist]
    const position = [
      worldPoint[0] + dir[0] * oldDist,
      worldPoint[1] + dir[1] * oldDist,
      worldPoint[2] + dir[2] * oldDist,
    ]
    // The 3D viewport camera is orthographic (parallelProjection), where
    // apparent size is set by parallelScale (world-space half-height of the
    // view), not by camera-to-focal-point distance — moving the camera closer
    // (as this used to do) has zero visual effect. Size parallelScale to the
    // tooth box's bounding-sphere radius (safe from any orbit angle) plus a
    // little margin, same way the on-screen zoom buttons drive setZoom.
    const parallelScale = Math.hypot(hx, hy, hz) * 1.1
    viewport3d.setCamera({ ...camera, focalPoint: [...worldPoint], position, parallelScale })
    viewport3d.render()
    return true
  }

  // Passive mm ruler along the left + bottom edge of a 2D viewport, ticked
  // relative to that corner (not absolute DICOM position — this is a scale
  // reference, like a ruler laid on the image, not a coordinate readout).
  // Scale is derived by unprojecting two short canvas-space vectors back to
  // world space, so it stays correct across zoom/pan/orientation without
  // needing pixel-spacing bookkeeping per plane.
  function drawRuler(vpId) {
    const viewport = engineRef.current?.getViewport(vpId)
    const container = { axial: axialRef, sagittal: sagRef, coronal: corRef }[vpId]?.current
    const canvas = rulerCanvasRef.current[vpId]
    if (!viewport || !container || !canvas) return
    const vol = volumeIdRef.current ? cache.getVolume(volumeIdRef.current) : null

    const w = Math.round(container.clientWidth)
    const h = Math.round(container.clientHeight)
    if (w === 0 || h === 0) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // "Vista previa" (i-CAT's first screen) is meant as an at-a-glance
    // overview, not a measuring surface — per client feedback the mm border
    // ticks + hash marks + "Scale x.xx" readout read as cluttered there. Skip
    // straight to the (already-cleared) canvas; the plain per-plane crosshair
    // line itself is CrosshairsTool's own SVG annotation, untouched by this.
    // Reads layoutRef, not the `layout` prop — drawRuler is called from
    // CAMERA_MODIFIED/wheel/pointer listeners set up once per volume load
    // (setup()'s useCallback is memoized on [caseData] only), so the prop
    // would be frozen at whatever `layout` was when the case first mounted
    // (always 'preview') for every call routed through those listeners.
    if (layoutRef.current === 'preview') return

    let p0, p1, p2
    try {
      p0 = viewport.canvasToWorld([0, 0])
      p1 = viewport.canvasToWorld([100, 0])
      p2 = viewport.canvasToWorld([0, 100])
    } catch {
      return
    }
    const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    const mmPerPxX = dist3(p0, p1) / 100
    const mmPerPxY = dist3(p0, p2) / 100
    if (!Number.isFinite(mmPerPxX) || !Number.isFinite(mmPerPxY) || mmPerPxX <= 0 || mmPerPxY <= 0) return

    // Pick a "nice" mm step that lands ticks roughly `target` px apart.
    const niceStep = (mmPerPx, target) => {
      const rawMm = target * mmPerPx
      const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200]
      return steps.find(s => s >= rawMm) || 200
    }
    // Major (labeled) ticks stay ~45px apart, same as before. Fine ticks
    // subdivide each major step evenly — preferring true mm resolution (10
    // subdivisions), falling back to coarser splits so ticks never render
    // closer than ~4px apart. Using an integer subdivision count (rather
    // than an independently "nice" fine step) guarantees fine ticks land
    // exactly on major ticks with no floating-point drift.
    const fineSplit = (majorStep, mmPerPx) => {
      const n = [10, 5, 2, 1].find(n => (majorStep / n) / mmPerPx >= 4) || 1
      return { fineStep: majorStep / n, subdivisions: n }
    }
    const majorStepX = niceStep(mmPerPxX, 45)
    const majorStepY = niceStep(mmPerPxY, 45)
    const { fineStep: stepX, subdivisions: subdivX } = fineSplit(majorStepX, mmPerPxX)
    const { fineStep: stepY, subdivisions: subdivY } = fineSplit(majorStepY, mmPerPxY)

    const color = CROSSHAIR_COLORS[vpId] || 'rgb(200,200,200)'
    // color is 'rgb(r,g,b)' — build matching rgba() strings for the two opacities we need.
    const rgbBody = color.slice(4, -1)
    const tickColor = `rgba(${rgbBody},0.75)`
    const textColor = `rgba(${rgbBody},1)`

    ctx.font = '600 11px Inter, system-ui, sans-serif'

    // Ruler border: major/minor ticks on all 4 edges, in the viewport's own
    // plane color, so every view reads as "framed" by its own colored ruler
    // (red=axial, green=sagittal, blue=coronal). Numbers are only drawn on
    // the bottom/left edges to avoid cluttering the image; top/right stay
    // tick-only so the frame still reads as a full ruler border.
    const drawTicksX = (edgeY, tickSign, withLabels) => {
      for (let i = 0; ; i++) {
        const mm = i * stepX
        const x = mm / mmPerPxX
        if (x > w) break
        const major = i % subdivX === 0
        const tickLen = major ? 12 : 4
        ctx.strokeStyle = tickColor
        ctx.lineWidth = major ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(x + 0.5, edgeY)
        ctx.lineTo(x + 0.5, edgeY + tickSign * tickLen)
        ctx.stroke()
        if (withLabels && mm > 0 && major) {
          ctx.fillStyle = textColor
          ctx.fillText(String(Math.round(mm)), x + 3, edgeY + tickSign * 15)
        }
      }
    }
    const drawTicksY = (edgeX, tickSign, withLabels) => {
      for (let i = 0; ; i++) {
        const mm = i * stepY
        const y = h - mm / mmPerPxY
        if (y < 0) break
        const major = i % subdivY === 0
        const tickLen = major ? 12 : 4
        ctx.strokeStyle = tickColor
        ctx.lineWidth = major ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(edgeX, y + 0.5)
        ctx.lineTo(edgeX + tickSign * tickLen, y + 0.5)
        ctx.stroke()
        // y > 40 keeps the topmost label clear of the axis label + Scale
        // readout stacked in the corner above the ruler.
        if (withLabels && mm > 0 && major && y > 40) {
          ctx.fillStyle = textColor
          ctx.fillText(String(Math.round(mm)), edgeX + tickSign * 15, y + 4)
        }
      }
    }
    drawTicksX(h, -1, true)   // bottom edge, ticks pointing up, labeled
    drawTicksX(0, 1, false)   // top edge, ticks pointing down
    drawTicksY(0, 1, true)    // left edge, ticks pointing right, labeled
    drawTicksY(w, -1, false)  // right edge, ticks pointing left

    // Scale readout — current zoom factor, top-left under the axis label —
    // colored to match this viewport's own plane, same as the ruler border.
    const zoom = viewport.getZoom?.()
    if (Number.isFinite(zoom)) {
      ctx.font = '600 10px Inter, system-ui, sans-serif'
      ctx.fillStyle = `rgba(${rgbBody},0.9)`
      ctx.fillText(`Scale ${zoom.toFixed(2)}`, 10, 34)
    }

    // Ruler ticks ON the crosshair lines themselves — same major(cm)/minor(mm)
    // cadence as the border, drawn as small hash marks crossing each line, in
    // the color of the plane that line actually belongs to (see AXIS_LINE_SOURCE).
    // No numbers/markers here, just ticks, so the crosshair reads as a ruler
    // without cluttering the image with position readouts.
    const world = crosshairWorldRef.current
    if (world) {
      let canvasPt
      try { canvasPt = viewport.worldToCanvas(world) } catch { canvasPt = null }
      if (canvasPt && Number.isFinite(canvasPt[0]) && Number.isFinite(canvasPt[1])) {
        const [cx, cy] = canvasPt
        const src = AXIS_LINE_SOURCE[vpId]
        const xLineColor = CROSSHAIR_COLORS[src.x] || color
        const yLineColor = CROSSHAIR_COLORS[src.y] || color

        // Vertical line (at x = cx): hash marks spaced along Y, same grid as the left/right ruler.
        // Skip the tick right at the crossing point — the two lines already mark it.
        if (cx >= 0 && cx <= w) {
          ctx.strokeStyle = xLineColor
          for (let i = 0; ; i++) {
            const mm = i * stepY
            const y = h - mm / mmPerPxY
            if (y < 0) break
            if (Math.abs(y - cy) < 6) continue
            const major = i % subdivY === 0
            const halfLen = major ? 4 : 2.5
            ctx.lineWidth = major ? 1.25 : 1
            ctx.beginPath()
            ctx.moveTo(cx - halfLen, y + 0.5)
            ctx.lineTo(cx + halfLen, y + 0.5)
            ctx.stroke()
          }
        }
        // Horizontal line (at y = cy): hash marks spaced along X, same grid as the top/bottom ruler.
        if (cy >= 0 && cy <= h) {
          ctx.strokeStyle = yLineColor
          for (let i = 0; ; i++) {
            const mm = i * stepX
            const x = mm / mmPerPxX
            if (x > w) break
            if (Math.abs(x - cx) < 6) continue
            const major = i % subdivX === 0
            const halfLen = major ? 4 : 2.5
            ctx.lineWidth = major ? 1.25 : 1
            ctx.beginPath()
            ctx.moveTo(x + 0.5, cy - halfLen)
            ctx.lineTo(x + 0.5, cy + halfLen)
            ctx.stroke()
          }
        }
      }
    }

    // "Línea" reformat tool: draw the traced (or in-progress) line in i-CAT's
    // amber, so its position is visible on the source panel while dragging
    // and after — the actual reformatted output lives in the 4th panel
    // (see renderLinePanel).
    const dragging = lineDragRef.current?.vpId === vpId ? lineDragRef.current : null
    const activeLine = dragging || (lineRef.current?.vpId === vpId ? lineRef.current : null)
    if (activeLine?.p1 && vol) {
      let c0, c1
      try {
        c0 = viewport.worldToCanvas(vol.imageData.indexToWorld(activeLine.p0))
        c1 = viewport.worldToCanvas(vol.imageData.indexToWorld(activeLine.p1))
      } catch { c0 = c1 = null }
      if (c0 && c1) {
        ctx.strokeStyle = 'rgba(255,170,40,0.9)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(c0[0], c0[1])
        ctx.lineTo(c1[0], c1[1])
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,170,40,0.9)'
        for (const c of [c0, c1]) {
          ctx.beginPath()
          ctx.arc(c[0], c[1], 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    // "Explorar" tool: draw the in-progress circle in the same amber while
    // dragging — no persisted shape once released, the result is the cropped
    // 3D render revealed in the 4th panel (see isolateToothAt/panel4Content).
    const exploring = exploreDragRef.current?.vpId === vpId ? exploreDragRef.current : null
    if (exploring) {
      const [ecx, ecy] = exploring.centerCanvas
      const [emx, emy] = exploring.curCanvas
      const er = Math.hypot(emx - ecx, emy - ecy)
      ctx.strokeStyle = 'rgba(255,170,40,0.9)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(ecx, ecy, er, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,170,40,0.9)'
      ctx.beginPath()
      ctx.arc(ecx, ecy, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // i-CAT "Línea" tool: reformatted plane along the user-drawn line (context
  // menu → Línea, then left-drag on Axial/Sagital/Coronal) — the depth axis
  // is that source view's own through-plane axis, so drawing on Axial sweeps
  // Z, Sagital sweeps X, Coronal sweeps Y (renderLineSlice in archMath.js).
  // Draws into the 4th panel's canvas; only meaningful in the explorer/MPR
  // room. Flips the output vertically so the higher-index end of the depth
  // axis sits on top — matches the Sagittal/Coronal "S at top" convention
  // for an Axial-sourced line; arbitrary but consistent for the other two.
  function renderLinePanel() {
    const canvas = lineCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    const active = lineDragRef.current?.p1 ? lineDragRef.current : lineRef.current
    const vol = volumeIdRef.current ? cache.getVolume(volumeIdRef.current) : null
    if (!active?.p1 || !vol) return

    const depthAxis = { axial: 'z', sagittal: 'x', coronal: 'y' }[active.vpId]
    const field = renderLineSlice(vol, active.p0, active.p1, depthAxis)
    if (!field || field.w < 2 || field.h < 2) return
    const img = scalarsToImageData(field)
    const off = document.createElement('canvas')
    off.width = field.w
    off.height = field.h
    off.getContext('2d').putImageData(img, 0, 0)

    const aspect = field.w / field.h
    let dw = w, dh = w / aspect
    if (dh > h) { dh = h; dw = h * aspect }
    const dx = (w - dw) / 2, dy = (h - dh) / 2
    ctx.save()
    ctx.translate(dx, dy + dh)
    ctx.scale(1, -1)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(off, 0, 0, dw, dh)
    ctx.restore()
  }

  function drawAllRulers() {
    ;['axial', 'sagittal', 'coronal'].forEach(drawRuler)
  }

  // i-CAT-style slice position + slab thickness strip. One viewport's two
  // strips (right edge = vertical, bottom edge = horizontal) each control a
  // DIFFERENT other axis — see AXIS_LINE_SOURCE/stripsControllingAxis. The
  // axis-colored segment is a position handle (drag = same as dragging that
  // axis's crosshair line); the yellow segment is slab thickness (drag its
  // far end — down for vertical, right for horizontal — to widen into a MIP).
  function drawOneStrip(vpId, edge, targetVpId) {
    const canvas = stripCanvasRef.current[vpId]?.[edge]
    const container = { axial: axialRef, sagittal: sagRef, coronal: corRef }[vpId]?.current
    if (!canvas || !container) return
    const cw = edge === 'v' ? SLICE_STRIP_SIZE : Math.round(container.clientWidth)
    const ch = edge === 'v' ? Math.round(container.clientHeight) : SLICE_STRIP_SIZE
    if (!cw || !ch) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
    }
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    const targetViewport = engineRef.current?.getViewport(targetVpId)
    const total = totalSlicesRef.current[targetVpId]
    if (!targetViewport || !total) return
    const current = currentSlicesRef.current[targetVpId]
    const length = edge === 'v' ? ch : cw
    const color = CROSSHAIR_COLORS[targetVpId] || 'rgb(200,200,200)'
    const frac = total > 1 ? current / (total - 1) : 0
    const pos = frac * length // 0 = slice 0, length = last slice, for both edges

    // Background track, faint.
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(0, 0, cw, ch)

    // Slab thickness — yellow, grows from the handle toward +length (down/right).
    const vol = volumeIdRef.current ? cache.getVolume(volumeIdRef.current) : null
    let slabPx = 0, slabMm = 0
    try {
      slabMm = targetViewport.getSlabThickness?.() || 0
      const spacing = vol?.spacing?.[AXIS_SPACING_INDEX[targetVpId]] || 0.3
      if (slabMm > 0.5) slabPx = (slabMm / spacing) * (length / total)
    } catch { /* viewport not ready yet */ }
    if (slabPx > 1) {
      ctx.fillStyle = 'rgba(255, 205, 40, 0.85)'
      const barThick = edge === 'v' ? cw * 0.7 : ch * 0.7
      const barOff = edge === 'v' ? (cw - barThick) / 2 : (ch - barThick) / 2
      if (edge === 'v') ctx.fillRect(barOff, pos, barThick, Math.min(slabPx, length - pos))
      else ctx.fillRect(pos, barOff, Math.min(slabPx, length - pos), barThick)
    }

    // Position handle.
    ctx.fillStyle = color
    const handleThick = edge === 'v' ? cw : ch
    const handleLen = 5
    if (edge === 'v') ctx.fillRect(0, Math.max(0, Math.min(length - handleLen, pos - handleLen / 2)), handleThick, handleLen)
    else ctx.fillRect(Math.max(0, Math.min(length - handleLen, pos - handleLen / 2)), 0, handleLen, handleThick)

    // Thickness readout, only once a slab is actually set (avoids clutter at rest).
    if (slabMm > 0.5) {
      ctx.save()
      ctx.font = '600 9px Inter, system-ui, sans-serif'
      ctx.fillStyle = 'rgba(255, 205, 40, 0.95)'
      const label = `${slabMm.toFixed(1)}mm`
      if (edge === 'v') {
        ctx.translate(cw - 2, Math.min(length - 4, pos + slabPx + 10))
        ctx.rotate(Math.PI / 2)
        ctx.fillText(label, 0, 0)
      } else {
        ctx.fillText(label, Math.min(length - 28, pos + slabPx + 4), ch - 3)
      }
      ctx.restore()
    }
  }

  function drawStrip(vpId) {
    const src = AXIS_LINE_SOURCE[vpId]
    drawOneStrip(vpId, 'v', src.x)
    drawOneStrip(vpId, 'h', src.y)
  }

  function drawAllStrips() {
    ;['axial', 'sagittal', 'coronal'].forEach(drawStrip)
  }

  // Repaint just the strips that show/control a given axis's position (its
  // line appears in the OTHER two viewports, not its own) — cheaper than
  // redrawing all three panels' strips on every slice change.
  function redrawStripsFor(axisId) {
    const vpIds = new Set(stripsControllingAxis(axisId).map(s => s.vpId))
    vpIds.forEach(drawStrip)
  }

  // Nearest-voxel density lookup at a world point, for the cursor readout.
  // Assumes an axis-aligned volume (true for our loader) — approximate, not
  // diagnostic-grade, but a nice-to-have HU probe under the cursor.
  function worldToVoxelHU(world) {
    const vol = volumeIdRef.current ? cache.getVolume(volumeIdRef.current) : null
    if (!vol) return null
    const [ox, oy, oz] = vol.origin
    const [sx, sy, sz] = vol.spacing
    const [dx, dy, dz] = vol.dimensions
    const i = Math.round((world[0] - ox) / sx)
    const j = Math.round((world[1] - oy) / sy)
    const k = Math.round((world[2] - oz) / sz)
    if (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz) return null
    const scalars = readVolumeScalars(vol)
    if (!scalars) return null
    return scalars[i + j * dx + k * dx * dy]
  }

  // Focus mode: enlarge one panel to fill the grid. Simple on/off — no
  // in-between "bigger" state, just fullscreen.
  function toggleFocus(i) {
    setFocusedIdx(prev => (prev === i ? null : i))
  }

  // Close hides a panel entirely so the grid reflows around the rest; a chip
  // in the bottom-left corner brings it back. Always keep at least one open.
  function closePanel(i) {
    setClosedIdx(prev => {
      if (prev.has(i) || 4 - prev.size <= 1) return prev
      const next = new Set(prev)
      next.add(i)
      return next
    })
    setFocusedIdx(prev => (prev === i ? null : prev))
  }
  function reopenPanel(i) {
    setClosedIdx(prev => {
      if (!prev.has(i)) return prev
      const next = new Set(prev)
      next.delete(i)
      return next
    })
    setColFrac(0.5)
    setLeftRowFrac(0.5)
    setRightRowFrac(0.5)
  }

  // Drag-resize the 2x2 grid. Item order is Axial(0) Sagittal(1) / Coronal(2)
  // 3D(3): the left column is [0,2], the right column is [1,3]. The column
  // divider is a single shared full-height boundary (colFrac) — width really
  // is a whole-column concern. The row split is NOT shared: each column gets
  // its own independent divider (leftRowFrac/rightRowFrac), so resizing
  // Axial's height only ever affects Coronal, never Sagittal/3D on the other
  // side. Dragging a divider all the way to an edge collapses the panel(s) it
  // carries — same as clicking their close button — and a small pull-tab
  // strip stays put so you can drag it back out.
  function onColDividerDown(e) {
    e.preventDefault()
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const onMove = (ev) => {
      const frac = (ev.clientX - rect.left) / rect.width
      setColFrac(Math.min(0.9, Math.max(0.1, frac)))
    }
    const onUp = (ev) => {
      const frac = (ev.clientX - rect.left) / rect.width
      if (frac < 0.06) { closePanel(0); closePanel(2); setColFrac(0.5) }
      else if (frac > 0.94) { closePanel(1); closePanel(3); setColFrac(0.5) }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Shared by both column row-dividers: `col` picks which panel indices /
  // setter this divider carries ([topIdx, bottomIdx], setFrac).
  function onRowDividerDown(e, [topIdx, bottomIdx], setFrac) {
    e.preventDefault()
    const rect = e.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    const onMove = (ev) => {
      const frac = (ev.clientY - rect.top) / rect.height
      setFrac(Math.min(0.9, Math.max(0.1, frac)))
    }
    const onUp = (ev) => {
      const frac = (ev.clientY - rect.top) / rect.height
      if (frac < 0.06) { closePanel(topIdx); setFrac(0.5) }
      else if (frac > 0.94) { closePanel(bottomIdx); setFrac(0.5) }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Panorámica room's Axial/Coronal/3D row — no collapse-to-edge here (this
  // room has no per-panel close button), just clamped resizing.
  function onPanoRowDividerDown(e, k) {
    e.preventDefault()
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const onMove = (ev) => {
      const frac = (ev.clientX - rect.left) / rect.width
      setPanoRowBounds(b => dragBoundary(b, k, frac))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Cornerstone must re-measure its canvases after any layout change (focus,
  // resize, or close all reflow the grid), so resize + re-render once the
  // DOM has settled. Also keeps layoutRef in sync immediately (not just after
  // the timeout) — see its declaration for why drawRuler needs the ref.
  useEffect(() => {
    layoutRef.current = layout
    const id = setTimeout(() => {
      resizeEngineUntilSettled(engineRef.current)
      drawAllRulers()
      drawAllStrips()
    }, 60)
    return () => clearTimeout(id)
  }, [focusedIdx, closedIdx, colFrac, leftRowFrac, rightRowFrac, panoRowBounds, layout])

  // The effect above only catches layout changes driven by this component's
  // own state. The grid's outer box can also change from outside (the
  // Panorámica/Implante room's pano-split divider, dragged in Viewer.jsx) —
  // that doesn't touch any state here, so watch the grid element itself.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    let id
    const ro = new ResizeObserver(() => {
      clearTimeout(id)
      id = setTimeout(() => {
        resizeEngineUntilSettled(engineRef.current)
        drawAllRulers()
      }, 60)
    })
    ro.observe(el)
    return () => { clearTimeout(id); ro.disconnect() }
  }, [focusedIdx, closedIdx, layout])

  // Reset — pan/zoom/scroll all set it, so the side-strip ⟲ button is the one
  // manual control that stays; pinch / ctrl+wheel already cover zooming in.
  function resetViewport(vpId) {
    const viewport = engineRef.current?.getViewport(vpId)
    if (!viewport) return
    viewport.resetCamera?.({ resetPan: true, resetZoom: true })
    viewport.render()
  }

  const MPR_VIEWPORTS = [
    { label: 'Axial',    ref: axialRef, vpId: 'axial',    slider: true },
    { label: 'Sagital',  ref: sagRef,   vpId: 'sagittal', slider: true },
    { label: 'Coronal',  ref: corRef,   vpId: 'coronal',  slider: true },
    { label: '3D',       ref: vol3dRef, vpId: 'vol3d',    slider: false },
  ]

  // Focus / close / drag-resize belong to the explorer 2x2 only; the other
  // rooms have a fixed panel set (LAYOUT_PANELS) laid out as one equal row —
  // their overall placement inside .viewer-main comes from the
  // .viewer-main.layout-* CSS in App.css.
  const inExplorer = layout === 'explorer'
  // Panorámica room's Axial/Coronal/3D row is independently resizable (see
  // panoRowBounds below) instead of the flat equal-share grid the other
  // fixed-panel rooms (Implante, Diente — both single-panel) still use.
  const isPanoRoom = !inExplorer && layout === 'panoramic'
  const visibleCount = 4 - closedIdx.size
  // All 4 panels visible and unfocused: nested independent split (one shared
  // full-height column boundary, plus an independent row split per column).
  const useNestedSplit = inExplorer && focusedIdx === null && visibleCount === 4

  const pct = (frac) => `${frac * 100}%`

  // Every room/mode is expressed as a percentage inset for each of the 4
  // panels, all as DIRECT children of one stable .viewer-grid (see the
  // single render tree below) — never as differently-shaped conditional JSX
  // trees. Cornerstone attaches its WebGL canvas to each panel's
  // .viewport-element div once and keeps a direct reference to that DOM
  // node; if the panel ever gets unmounted (e.g. because switching rooms
  // used to swap between structurally different parent wrappers), the
  // canvas is orphaned — detached from the visible tree — and the panel
  // reads as permanently black, un-recoverable by any later resize() call.
  // That was the actual bug behind "boxes go black when I resize/switch
  // views": the old code branched between three differently-nested JSX
  // trees (nested flex columns / flat resizable row / plain CSS grid) whose
  // panels only shared a `key`, not a parent — React can't reuse a DOM node
  // across a change of parent, so it unmounted+remounted on every switch.
  function panelInset(i) {
    if (!inExplorer && !isPanoRoom) {
      // Implante / Diente / Preview: fixed panel list, equal-share row.
      // Preview also supports the focus/fullscreen toggle (i-CAT's
      // double-click-a-window convention) since it's an overview room —
      // Implante/Diente don't use it, so this is a no-op there (focusedIdx
      // never gets set from a room with no expand button).
      if (layout === 'preview' && focusedIdx !== null) {
        return i === focusedIdx
          ? { top: 0, right: 0, bottom: 0, left: 0 }
          : { top: 0, right: 0, bottom: 0, left: 0 } // hidden, inset irrelevant
      }
      const order = LAYOUT_PANELS[layout].map(vpId => MPR_VIEWPORTS.findIndex(v => v.vpId === vpId))
      const n = order.length
      const pos = order.indexOf(i)
      if (pos === -1) return { top: 0, right: 0, bottom: 0, left: 0 }
      return { top: 0, bottom: 0, left: pct(pos / n), right: pct(1 - (pos + 1) / n) }
    }
    if (isPanoRoom) {
      // Axial(0) / Coronal(2) / 3D(3) row, split by panoRowBounds; Sagittal(1) hidden.
      const order = [0, 2, 3]
      const edges = [0, ...panoRowBounds, 1]
      const pos = order.indexOf(i)
      if (pos === -1) return { top: 0, right: 0, bottom: 0, left: 0 }
      return { top: 0, bottom: 0, left: pct(edges[pos]), right: pct(1 - edges[pos + 1]) }
    }
    // Explorer room from here on.
    if (focusedIdx !== null) {
      return i === focusedIdx
        ? { top: 0, right: 0, bottom: 0, left: 0 }
        : { top: 0, right: 0, bottom: 0, left: 0 } // hidden, inset is irrelevant
    }
    if (visibleCount === 4) {
      // Nested split: left column [0,2] at colFrac, right column [1,3] at
      // (1-colFrac); each column independently split by its own row frac.
      if (i === 0) return { left: 0, right: pct(1 - colFrac), top: 0, bottom: pct(1 - leftRowFrac) }
      if (i === 2) return { left: 0, right: pct(1 - colFrac), top: pct(leftRowFrac), bottom: 0 }
      if (i === 1) return { left: pct(colFrac), right: 0, top: 0, bottom: pct(1 - rightRowFrac) }
      return { left: pct(colFrac), right: 0, top: pct(rightRowFrac), bottom: 0 } // i === 3
    }
    // Some panels closed: equal-share row of the remaining ones, original order.
    const order = [0, 1, 2, 3].filter(idx => !closedIdx.has(idx))
    const n = order.length
    const pos = order.indexOf(i)
    if (pos === -1) return { top: 0, right: 0, bottom: 0, left: 0 }
    return { top: 0, bottom: 0, left: pct(pos / n), right: pct(1 - (pos + 1) / n) }
  }

  function renderPanel(i, panelStyle) {
    const { label, ref, vpId, slider } = MPR_VIEWPORTS[i]
    const ready = (i < 3 && !loading) || (i === 3 && !loading3d)
    const expandTitle = focusedIdx === i ? 'Restaurar' : 'Pantalla completa'
    const expandIcon = focusedIdx === i ? '⤡' : '⤢'
    const previewFocused = layout === 'preview' && focusedIdx !== null
    const hidden = inExplorer
      ? (focusedIdx !== null && focusedIdx !== i) || closedIdx.has(i)
      : previewFocused
        ? focusedIdx !== i
        : !LAYOUT_PANELS[layout]?.includes(vpId)
    return (
          <div
            key={label}
            className={`viewport-panel${hidden ? ' hidden' : ''}`}
            style={{ position: 'absolute', ...panelStyle }}
          >
            {/* Frame is the positioned ancestor for every overlay (labels, rulers,
                orientation letters, cursor readout) so they all size against the
                actual image box instead of the whole panel. The slice slider and
                expand/close controls live outside it, in .viewport-side, so
                they never sit on top of the ruler. */}
            <div className="viewport-frame">
              <span
                className="viewport-label"
                style={vpId !== 'vol3d' ? { color: CROSSHAIR_COLORS[vpId] } : undefined}
              >
                {vpId === 'vol3d' && layout === 'explorer' ? (panel4Content === 'explore' ? 'Explorar' : 'Línea') : label}{vpId !== 'vol3d' && ` (${VIEWPORT_AXIS[vpId]})`}
              </span>
              {vpId !== 'vol3d' && (
                <span className="cursor-readout" ref={el => { cursorReadoutRef.current[vpId] = el }} />
              )}
              {vpId !== 'vol3d' && ORIENTATION_LABELS[vpId] && (
                <>
                  <span className="viewport-orient orient-top">{ORIENTATION_LABELS[vpId].top}</span>
                  <span className="viewport-orient orient-bottom">{ORIENTATION_LABELS[vpId].bottom}</span>
                  <span className="viewport-orient orient-left">{ORIENTATION_LABELS[vpId].left}</span>
                  <span className="viewport-orient orient-right">{ORIENTATION_LABELS[vpId].right}</span>
                </>
              )}
              <div
                ref={ref}
                className="viewport-element"
                onContextMenu={e => e.preventDefault()}
              />
              {/* i-CAT's MPR screen has no 3D panel — its 4th window is either
                  the "Línea" reformat or, once "Explorar" has been used, the
                  real 3D viewport cropped to the circled region (this overlay
                  hides to reveal it — see panel4Content/isolateToothAt). Sits
                  on top of the still-mounted 3D viewport element (untouched,
                  kept live for the other rooms) rather than unmounting/
                  remounting it per layout. */}
              {vpId === 'vol3d' && layout === 'explorer' && panel4Content !== 'explore' && (
                <div className="line-panel-overlay">
                  <canvas ref={lineCanvasRef} className="line-panel-canvas" />
                  {!panel4Content && (
                    <p className="line-panel-hint">
                      Clic derecho → Línea o Explorar, luego arrastre sobre Axial, Sagital o Coronal
                    </p>
                  )}
                </div>
              )}
              {vpId !== 'vol3d' && (
                <canvas
                  ref={el => { rulerCanvasRef.current[vpId] = el }}
                  className="viewport-ruler"
                />
              )}
              {/* i-CAT-style slice position + slab thickness strips (drawStrip) —
                  right edge controls AXIS_LINE_SOURCE[vpId].x, bottom edge
                  controls .y. Always interactive, not gated behind activeTool. */}
              {vpId !== 'vol3d' && (
                <>
                  <canvas
                    ref={el => { stripCanvasRef.current[vpId].v = el }}
                    className="slice-strip-v"
                  />
                  <canvas
                    ref={el => { stripCanvasRef.current[vpId].h = el }}
                    className="slice-strip-h"
                  />
                </>
              )}
              {vpId === 'vol3d' && (
                <div ref={crosshairDotRef} className="crosshair-3d-dot" />
              )}
              {/* Unobtrusive stream-progress badge: the 3D reveals progressively
                  (no blocking overlay), this shows how much data is in so far.
                  Inline-styled on purpose — App.css belongs to the layout work. */}
              {vpId === 'vol3d' && !loading3d && progress3d < 100 && (
                <span
                  style={{
                    position: 'absolute', right: 8, bottom: 8, zIndex: 5,
                    font: '600 11px Inter, system-ui, sans-serif',
                    color: 'rgba(200,200,200,0.75)', pointerEvents: 'none',
                  }}
                >
                  3D {progress3d}%
                </span>
              )}
              {loading && i < 3 && (
                <div className="viewer-loading">
                  <div className="spinner" />
                  <p>Cargando volumen… {progress}%</p>
                  <div className="progress-bar-wrap">
                    <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}
              {i === 3 && loading3d && (
                <div className="viewer-loading">
                  <div className="spinner" />
                  <p>Cargando 3D… {progress3d}%</p>
                  <div className="progress-bar-wrap">
                    <div className="progress-bar-fill" style={{ width: `${progress3d}%` }} />
                  </div>
                </div>
              )}
              {error && i === 0 && (
                <div className="viewer-loading">
                  <p style={{ color: 'var(--danger)' }}>⚠ {error}</p>
                </div>
              )}
            </div>
            {/* Side strip: outside the ruler entirely, so it doubles as a visual
                divider between neighboring viewports. Slice counter up top,
                expand/close pinned to the bottom. Slice *navigation* itself
                now lives on the crosshair reference lines (i-CAT style: drag
                a line's center to reslice the plane it belongs to, drag its
                small handles to widen the slab into a MIP) instead of a
                same-axis slider here — see getReferenceLineSlabThicknessControlsOn. */}
            <div className="viewport-side">
              {/* Preview is i-CAT's inert study-list thumbnail row — no slice
                  counter, no reset button, only the fullscreen (double-click)
                  affordance survives from the per-panel chrome below. */}
              {layout !== 'preview' && slider && !loading && totalSlices[vpId] > 0 ? (
                <div className="viewport-side-slider">
                  <span className="slice-counter-vert">{currentSlices[vpId] + 1}/{totalSlices[vpId]}</span>
                </div>
              ) : <div className="viewport-side-slider" />}
              {ready && (
                <div className="viewport-side-actions">
                  {/* Focus/close reflow the 2x2 — in the fixed rooms only ⟲ stays,
                      except Preview, which also gets fullscreen (i-CAT's
                      double-click-a-window convention, and per client request). */}
                  {(inExplorer || layout === 'preview') && (
                    <button className="viewport-side-btn" onClick={() => toggleFocus(i)} title={expandTitle}>
                      {expandIcon}
                    </button>
                  )}
                  {layout !== 'preview' && (
                    <button className="viewport-side-btn" onClick={() => resetViewport(vpId)} title="Restablecer vista">
                      ⟲
                    </button>
                  )}
                  {inExplorer && (
                    <button
                      className="viewport-side-btn"
                      onClick={() => closePanel(i)}
                      title="Cerrar panel"
                      disabled={visibleCount <= 1}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
    )
  }

  return (
    <>
      {/* All 4 panels are ALWAYS direct children of this one stable grid,
          in the same key order, regardless of room/mode — only their inset
          (panelInset) and visibility (hidden, inside renderPanel) change.
          This is load-bearing: see the comment above panelInset(). */}
      <div className="viewer-grid" ref={gridRef}>
        {MPR_VIEWPORTS.map((_, i) => renderPanel(i, panelInset(i)))}
        {useNestedSplit && (
          <>
            <div
              className="grid-divider grid-divider-h"
              style={{ left: 0, right: pct(1 - colFrac), top: `${leftRowFrac * 100}%` }}
              onPointerDown={e => onRowDividerDown(e, [0, 2], setLeftRowFrac)}
            />
            <div
              className="grid-divider grid-divider-v"
              style={{ left: `${colFrac * 100}%` }}
              onPointerDown={onColDividerDown}
            />
            <div
              className="grid-divider grid-divider-h"
              style={{ left: `${colFrac * 100}%`, right: 0, top: `${rightRowFrac * 100}%` }}
              onPointerDown={e => onRowDividerDown(e, [1, 3], setRightRowFrac)}
            />
          </>
        )}
        {isPanoRoom && panoRowBounds.map((b, k) => (
          <div
            key={`pano-row-div-${k}`}
            className="grid-divider grid-divider-v"
            style={{ left: `${b * 100}%` }}
            onPointerDown={e => onPanoRowDividerDown(e, k)}
          />
        ))}
      </div>
      {inExplorer && closedIdx.size > 0 && (
        <div className="closed-panels-tray">
          {MPR_VIEWPORTS.map(({ label }, i) => closedIdx.has(i) && (
            <button key={label} className="closed-panel-chip" onClick={() => reopenPanel(i)}>
              + {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
