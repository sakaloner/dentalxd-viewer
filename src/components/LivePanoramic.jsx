import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { getRenderingEngine, cache, Enums } from '@cornerstonejs/core'
import { ToolGroupManager, CrosshairsTool } from '@cornerstonejs/tools'
import { autoFitArch, defaultArch, sampleCurve, renderPanoramic, renderCrossSection, panoToImageData } from '../panoramic/archMath'
import './LivePanoramic.css'

// Live panoramic (curved MPR), computed in the browser from the loaded MPR
// volume — the in-app version of make_panoramic.py. The arch is drawn on the
// Axial panel as a spline with draggable control points; dragging re-renders
// the panoramic in real time (downsampled while dragging, full-res on
// release). "Profundidad" rolls the whole arch buccal↔lingual (mouse wheel on
// the panoramic does the same), "Grosor" is the slab thickness.
//
// Deliberately self-contained: it reaches the engine/volume through the
// cornerstone singletons (getRenderingEngine / cache) instead of props, so it
// needs no changes inside CornerstoneViewer.
const ENGINE_ID = 'dentalxd-engine'
const MPR_TOOLGROUP_ID = 'mpr-group' // must match CornerstoneViewer.jsx's ToolGroupManager.createToolGroup id
const HANDLE_R = 7      // drawn handle radius (px)
const HIT_R = 16        // grab radius (px)

// Cross-section family (implant view): cuts perpendicular to the arch.
// Cyan so they can't be confused with the amber arch or the MPR plane colors.
const CROSS_COLOR = 'rgb(53, 208, 255)'
// i-CAT's implant screen has no single "large" cut — just a uniform grid of
// cross-sections (see docs/ICAT_CLONE.md screenshot), alongside the one big
// center cut in its own panel (.cross-large-panel). 8 tiles, 4x2.
const CROSS_OFFSETS = [-3, -2, -1, 0, 1, 2, 3, 4] // tile offsets in units of crossStepMm
const CROSS_GRID_COLS = 4 // 8 tiles / 2 rows -> 4 + 4

// i-CAT-style "ladder" controls on the panoramic image itself (see the real
// manual: oblique ladder = focal-trough/slab thickness, horizontal ladder =
// position along the arch). Purely visual — hit-testing/dragging lives on
// panoCanvasRef, same as the crop handles (see onPanoCanvasPointerDown).
const LADDER_COLOR = 'rgb(255, 200, 60)'
// Real i-CAT's ladder handles are solid blue dots (same convention the manual
// uses for every draggable circle — condyle maps, arch points) — distinct
// from the yellow/tan rails so they read as "the part you grab."
const LADDER_HANDLE_COLOR = 'rgb(43, 120, 230)'
const LADDER_RAIL_HW = 5    // px — half-distance between the ladder's two rails
const SLAB_MIN_MM = 4, SLAB_MAX_MM = 30
const OBLIQUE_LADDER_LEN = 110   // px
const OBLIQUE_LADDER_MARGIN = 34 // px from the bottom-right corner
const OBLIQUE_LADDER_RUNGS = 9
const H_LADDER_MARGIN = 44  // px from the left/right edges
const H_LADDER_Y = 16       // px from the top edge
const H_LADDER_RUNGS = 14
// i-CAT's vertical ladder (manual p.4, "Vertical Tool Bar"): far-right edge,
// shifts the cross-section band up/down (maxillary <-> mandibular). Implant
// mode only, same as the horizontal ladder — there's no cross-section band
// to shift in the plain panoramic room.
const V_LADDER_X_MARGIN = 14 // px from the right edge
const V_LADDER_MARGIN = 20   // px from the top/bottom edges
const V_LADDER_RUNGS = 10
const Z_SHIFT_MIN_MM = -15, Z_SHIFT_MAX_MM = 15
const CROSS_WIDTH_MM = 34               // buccal↔lingual extent of each cut
// Default panoramic z-crop, seeded from the auto-detected tooth row (arch.z):
// asymmetric because the volume isn't symmetric around it — more room above
// (sinus floor, condyles) than below (mandible border, IAN canal). Draggable
// afterward (see zCrop state / crop-handle overlay below). Taller box (see
// panoramicSplit in Viewer.jsx) doesn't show more on its own — the "contain"
// fit just scales the same reconstructed height up/down to fill it — so the
// actual z-crop has to grow too to show more bone/sinus (client request,
// 2026-08-28; was 40/30).
const Z_CROP_UP_MM = 55
const Z_CROP_DOWN_MM = 35
const Z_CROP_MIN_GAP_MM = 15 // minimum distance kept between the two handles

function defaultZCrop(vol, archZ) {
  const nz = vol.dimensions[2]
  const zMm = vol.spacing?.[2] || 0.3
  const up = Z_CROP_UP_MM / zMm
  const down = Z_CROP_DOWN_MM / zMm
  // Don't spend the whole "up" budget on sinus when the scan is cropped close
  // under the occlusal plane. A CBCT FOV positioned high (i-CAT 16x12 studies
  // routinely stop ~20 mm below the maxillary crowns) has far less volume below
  // the tooth row than the 30 mm we'd like, and rendering the full 40 mm above
  // it anyway pushes the jaw into the bottom sliver of the panel with sinus and
  // orbit filling the rest — the "wrong part of the skull" symptom. Cap the
  // upward reach at what's actually available below, so the tooth row keeps its
  // share of the frame on tight FOVs and nothing changes on roomy ones.
  const below = Math.min(down, archZ)
  return {
    lo: Math.max(0, Math.round(archZ - below)),
    hi: Math.min(nz, Math.round(archZ + Math.max(up * 0.5, Math.min(up, below * 1.6)))),
  }
}

// Same asymmetric reasoning as defaultZCrop (more room above the tooth row —
// sinus/nasal floor — than below — mandible border), reused as the implant
// cross-sections' rest band: a naive band centered on arch.z with equal
// up/down half-heights either pins against the mandible-side edge for the
// whole ladder range (frozen — nowhere to slide down to) or, if shrunk to
// fit, reads as a zoomed-in crop compared to the tuned panoramic crop.
function crossBandRest(vol, archZ) {
  const crop = defaultZCrop(vol, archZ)
  return { center: (crop.lo + crop.hi) / 2, half: (crop.hi - crop.lo) / 2 }
}

// Ladder geometry — canvas-local pixel coords, shared between drawing and
// hit-testing/dragging (onPanoCanvasPointerDown) so they can never drift
// apart. w/h are the panoramic canvas element's displayed size.
function obliqueLadderGeom(w, h) {
  const pStart = [w - OBLIQUE_LADDER_MARGIN, h - OBLIQUE_LADDER_MARGIN] // low end, bottom-right
  const dir = [-Math.SQRT1_2, -Math.SQRT1_2] // up-left, unit vector
  const pEnd = [pStart[0] + dir[0] * OBLIQUE_LADDER_LEN, pStart[1] + dir[1] * OBLIQUE_LADDER_LEN]
  return { pStart, pEnd, dir }
}
function hLadderGeom(w) {
  return { x0: H_LADDER_MARGIN, x1: w - H_LADDER_MARGIN, y: H_LADDER_Y }
}
function vLadderGeom(w, h) {
  return { x: w - V_LADDER_X_MARGIN, y0: V_LADDER_MARGIN, y1: h - V_LADDER_MARGIN }
}
function lerp2(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}
// Project point p onto segment p0->p1, clamped to [0,1] of the segment.
function projectOnSegment(p, p0, p1) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
  const len2 = dx * dx + dy * dy || 1
  const t = ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / len2
  return Math.max(0, Math.min(1, t))
}
// A real two-rail ladder (per the i-CAT manual reference), not a single
// tick-marked line: two parallel rails offset from the p0->p1 centerline,
// joined by cross-rungs at each step — the shape the "ladder" name actually
// describes. p0/p1 stay the hit-testing centerline (ladderHit/startLadderDrag
// aim at the midline, unaffected by the rail offset).
function drawLadderRungs(ctx, p0, p1, n) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len
  const nx = -uy, ny = ux
  ctx.strokeStyle = LADDER_COLOR
  ctx.lineWidth = 1.5
  const hw = LADDER_RAIL_HW
  for (const sign of [1, -1]) {
    ctx.beginPath()
    ctx.moveTo(p0[0] + nx * hw * sign, p0[1] + ny * hw * sign)
    ctx.lineTo(p1[0] + nx * hw * sign, p1[1] + ny * hw * sign)
    ctx.stroke()
  }
  for (let i = 0; i <= n; i++) {
    const p = lerp2(p0, p1, i / n)
    ctx.beginPath()
    ctx.moveTo(p[0] - nx * hw, p[1] - ny * hw)
    ctx.lineTo(p[0] + nx * hw, p[1] + ny * hw)
    ctx.stroke()
  }
}

// mode: 'panoramic' docks the pano wide on top of the grid;
//       'implant' adds the large cross-section + 5-tile strip (Room 2).
// thumbnail: true on i-CAT's Vista previa — the panoramic there is an inert
// reference image (no ladders, no drag), same as the real i-CAT preview.
export default function LivePanoramic({ caseData, mode = 'panoramic', thumbnail = false, onClose }) {
  const [status, setStatus] = useState('waiting') // waiting | fitting | ready
  // renderPanoramic averages `steps` samples spread evenly across the slab —
  // a thicker slab means each sample is farther apart along the curve normal,
  // smearing anatomy that isn't exactly on the traced arch (most teeth,
  // basically) and reading as soft/low-definition. 18mm was overcautious
  // margin for an imprecise curve fit; now that autoFitArch degrades more
  // reliably (metal-mouth percentile walk-down, see archMath.js), 10mm stays
  // inside the tooth row on a well-fit arch while cutting the averaging blur
  // noticeably. Still adjustable via "Grosor" (4-30mm) if a case needs more.
  const [slabMm, setSlabMm] = useState(10)
  const [depthMm, setDepthMm] = useState(0)
  const [axialEl, setAxialEl] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [panoZoom, setPanoZoom] = useState(1) // CSS-transform zoom — ctrl+wheel to change it, ⟲ in the side strip to reset
  const [crossPos, setCrossPos] = useState(0.5)     // center cut, as fraction along the arch
  const [crossStepMm, setCrossStepMm] = useState(2) // spacing between neighboring tiles
  // i-CAT's vertical ladder: shifts the z-height of the tooth band the cross
  // sections are cut around (maxillary <-> mandibular), independent of the
  // arch trace itself and of "Profundidad" (which rolls buccal<->lingual).
  const [zShiftMm, setZShiftMm] = useState(0)

  const archRef = useRef(null)          // { points: [[i,j],..], z }
  // Panoramic z-crop (index space): { lo, hi }, seeded from the detected
  // tooth row on fit/refit, draggable afterward via the crop-handle overlay.
  // A plain ref (not state) — same reasoning as archRef: only read
  // imperatively by renderPano/drawCropHandles, never by JSX.
  const zCropRef = useRef(null)
  const panoCanvasRef = useRef(null)
  const cropHandlesRef = useRef(null)   // crop-handle overlay canvas
  const cropDragRef = useRef(null)      // 'lo' | 'hi' | null while dragging
  const ladderRef = useRef(null)        // i-CAT ladder overlay canvas (oblique = slab, horizontal = position, vertical = z-shift)
  const ladderDragRef = useRef(null)    // 'oblique' | 'horizontal' | 'vertical' | null while dragging a ladder
  const panoMarkerRef = useRef(null)    // cut-position lines overlaid on the pano (implant)
  const crossLargeRef = useRef(null)    // large center cross-section canvas, bottom-left (implant)
  const crossTileRefs = useRef([])      // the neighbor cross-section grid canvases, bottom-right (implant)
  const crossDimsRef = useRef(new Map()) // canvas -> { widthMm, heightMm } for refit on resize
  const overlayRef = useRef(null)       // arch canvas portaled into the axial panel
  const dragRef = useRef(null)          // index of the control point being dragged
  const rafRef = useRef(0)
  const paramsRef = useRef({ slabMm, depthMm })
  const crossRef = useRef({ mode, crossPos, crossStepMm, zShiftMm, thumbnail }) // latest cross state for imperative draws
  const aspectRef = useRef(2.2)
  const physMmRef = useRef({ widthMm: 0, heightMm: 0 }) // real-world size of the current pano bitmap
  useEffect(() => { paramsRef.current = { slabMm, depthMm } }, [slabMm, depthMm])
  useEffect(() => { crossRef.current = { mode, crossPos, crossStepMm, zShiftMm, thumbnail } }, [mode, crossPos, crossStepMm, zShiftMm, thumbnail])

  const volumeId = `cornerstoneStreamingImageVolume:${caseData.id}`
  const getVol = useCallback(() => cache.getVolume(volumeId), [volumeId])
  const getAxial = () => {
    try { return getRenderingEngine(ENGINE_ID)?.getViewport('axial') } catch { return null }
  }

  // Move the Axial MPR viewport's actual slice through CrosshairsTool's own
  // toolCenter — a direct viewport.scroll()/camera set gets silently undone
  // the next time the tool resyncs cameras from its internal toolCenter (see
  // CLAUDE.md, "Default MPR position stuck at geometric center…"). Only the
  // z index moves; i/j come from the tool's current center so this doesn't
  // also drag the sagittal/coronal crosshair position around.
  const moveAxialToZIndex = useCallback((vol, zIndex) => {
    const tg = ToolGroupManager.getToolGroup(MPR_TOOLGROUP_ID)
    const chTool = tg?.getToolInstance(CrosshairsTool.toolName)
    if (!chTool) return
    const [i, j] = vol.imageData.worldToIndex(chTool.toolCenter)
    chTool.setToolCenter(vol.imageData.indexToWorld([i, j, zIndex]))
  }, [])

  // Fit the canvas inside its wrap at the true mm aspect (contain). Sized in
  // JS because CSS aspect-ratio + max-width/height fought the canvas's own
  // attribute ratio and overflowed small windows.
  const fitCanvas = useCallback(() => {
    const canvas = panoCanvasRef.current
    const wrap = canvas?.closest('.live-pano-canvas-wrap')
    if (!canvas || !wrap) return
    const cs = getComputedStyle(wrap)
    const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    const a = aspectRef.current
    let w = availW, h = w / a
    if (h > availH) { h = availH; w = h * a }
    canvas.style.setProperty('width', `${Math.max(50, w)}px`)
    canvas.style.setProperty('height', `${Math.max(30, h)}px`)
  }, [])

  // Fit a cross-section canvas inside its wrap at its true mm aspect
  // (contain), same reasoning as fitCanvas for the pano.
  const fitCrossCanvas = useCallback((canvas, widthMm, heightMm) => {
    const wrap = canvas?.parentElement
    if (!wrap || !widthMm || !heightMm) return
    const cs = getComputedStyle(wrap)
    const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    const a = widthMm / heightMm
    let w = availW, h = w / a
    if (h > availH) { h = availH; w = h * a }
    canvas.style.setProperty('width', `${Math.max(20, w)}px`)
    canvas.style.setProperty('height', `${Math.max(20, h)}px`)
  }, [])

  // Draggable z-crop handles over the pano — two horizontal lines (top =
  // zCrop.hi, bottom = zCrop.lo; row 0 of the rendered image is the highest
  // z, per panoToImageData's teeth-up flip) with the excluded bands dimmed.
  // At rest the displayed range *is* the crop (handles sit right at the
  // canvas edges); while a handle is being dragged (cropDragRef.current)
  // renderPano temporarily shows the full volume height instead, so there's
  // headroom above/below to drag into — same fast-while-dragging pattern as
  // the arch control points and the slab/depth sliders.
  const CROP_LINE_COLOR = 'rgb(255, 150, 50)' // matches CornerstoneViewer's crop-line convention
  const drawCropHandles = useCallback(() => {
    const canvas = cropHandlesRef.current
    const dispEl = panoCanvasRef.current
    if (!canvas || !dispEl) return
    const w = dispEl.clientWidth, h = dispEl.clientHeight
    if (!w || !h) return
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
    const crop = zCropRef.current
    const { zLo, zHi } = physMmRef.current
    if (!crop || zHi == null || zHi === zLo) return
    const yFor = (z) => h * (1 - (z - zLo) / (zHi - zLo))
    const yTop = Math.max(0, Math.min(h, yFor(crop.hi)))
    const yBot = Math.max(0, Math.min(h, yFor(crop.lo)))
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, w, yTop)
    ctx.fillRect(0, yBot, w, h - yBot)
    ctx.strokeStyle = CROP_LINE_COLOR
    ctx.lineWidth = 2
    for (const y of [yTop, yBot]) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
  }, [])

  // i-CAT ladders: oblique (bottom-right corner) = slab thickness, drawn in
  // both modes; horizontal (top edge) = position along the arch, implant
  // mode only — mirrors the real i-CAT Vision panoramic screen (see chat).
  // Reads paramsRef/crossRef, not slabMm/crossPos state directly, so this
  // stays correct regardless of when its memoized identity was last created.
  const drawLadders = useCallback(() => {
    const canvas = ladderRef.current
    const dispEl = panoCanvasRef.current
    if (!canvas || !dispEl) return
    const w = dispEl.clientWidth, h = dispEl.clientHeight
    if (!w || !h) return
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
    if (crossRef.current.thumbnail) return // Vista previa: reference image only, no ladders

    // Oblique ladder — slab thickness. Handle is a solid blue dot (i-CAT
    // convention — every draggable circle in the real app is blue, not
    // yellow like the rails it rides on).
    const { pStart, pEnd } = obliqueLadderGeom(w, h)
    drawLadderRungs(ctx, pStart, pEnd, OBLIQUE_LADDER_RUNGS)
    const slab = paramsRef.current.slabMm
    const tSlab = Math.max(0, Math.min(1, (slab - SLAB_MIN_MM) / (SLAB_MAX_MM - SLAB_MIN_MM)))
    const hOblique = lerp2(pStart, pEnd, tSlab)
    ctx.beginPath()
    ctx.arc(hOblique[0], hOblique[1], HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = LADDER_HANDLE_COLOR
    ctx.fill()
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.fillStyle = LADDER_COLOR
    ctx.textAlign = 'right'
    ctx.fillText(`${slab.toFixed(0)} mm`, pStart[0] + 4, pStart[1] + 16)
    ctx.textAlign = 'left'

    // Horizontal ladder — position along the arch, implant mode only. Same
    // solid-blue-dot handle as the oblique one (real i-CAT uses one handle
    // style throughout, not an open/closed distinction per ladder).
    if (crossRef.current.mode === 'implant') {
      const { x0, x1, y } = hLadderGeom(w)
      drawLadderRungs(ctx, [x0, y], [x1, y], H_LADDER_RUNGS)
      const hx = x0 + (x1 - x0) * crossRef.current.crossPos
      ctx.beginPath()
      ctx.arc(hx, y, HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = LADDER_HANDLE_COLOR
      ctx.fill()
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 1
      ctx.stroke()

      // Vertical ladder — cross-section band height (maxillary <-> mandibular),
      // far-right edge. Same rail/handle style as the other two.
      const { x: vx, y0: vy0, y1: vy1 } = vLadderGeom(w, h)
      drawLadderRungs(ctx, [vx, vy0], [vx, vy1], V_LADDER_RUNGS)
      const tShift = (crossRef.current.zShiftMm - Z_SHIFT_MIN_MM) / (Z_SHIFT_MAX_MM - Z_SHIFT_MIN_MM)
      const vy = vy0 + (vy1 - vy0) * tShift
      ctx.beginPath()
      ctx.arc(vx, vy, HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = LADDER_HANDLE_COLOR
      ctx.fill()
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }, [])

  const cropHandleHit = (clientY) => {
    const rect = panoCanvasRef.current?.getBoundingClientRect()
    const crop = zCropRef.current
    const { zLo, zHi } = physMmRef.current
    if (!rect || !crop || zHi == null || zHi === zLo) return null
    const h = rect.height
    const yFor = (z) => h * (1 - (z - zLo) / (zHi - zLo))
    const y = clientY - rect.top
    if (Math.abs(y - yFor(crop.hi)) <= 10) return 'hi'
    if (Math.abs(y - yFor(crop.lo)) <= 10) return 'lo'
    return null
  }

  // Vertical cut-position lines over the pano (implant mode): solid cyan for
  // the center cut, faint for the ±tiles. The pano's x axis and the cut
  // positions share the same arch parametrization, so x = fraction * width.
  const drawPanoMarkers = useCallback(() => {
    const canvas = panoMarkerRef.current
    const dispEl = panoCanvasRef.current
    if (!canvas || !dispEl) return
    const w = dispEl.clientWidth, h = dispEl.clientHeight
    if (!w || !h) return
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
    const { mode: m, crossPos: pos, crossStepMm: stepMm } = crossRef.current
    const { widthMm } = physMmRef.current
    if (m !== 'implant' || !widthMm) return
    const stepFrac = stepMm / widthMm
    for (const k of CROSS_OFFSETS) {
      const f = pos + k * stepFrac
      if (f < 0 || f > 1) continue
      const x = f * w
      ctx.strokeStyle = k === 0 ? 'rgba(53,208,255,0.95)' : 'rgba(53,208,255,0.4)'
      ctx.lineWidth = k === 0 ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
  }, [])

  // Render the large cross-section + the 5-tile strip (implant mode). Cheap
  // enough to run at full res on every position change or arch drag: each cut
  // is ~120×200 bilinear samples.
  const renderCrossAll = useCallback(() => {
    const { mode: m, crossPos: pos, crossStepMm: stepMm, zShiftMm: shift } = crossRef.current
    if (m !== 'implant') return
    const vol = getVol()
    const arch = archRef.current
    if (!vol || !arch) return
    const curve = sampleCurve(arch.points, 520)
    if (!curve) return
    const pxMm = vol.spacing?.[0] || 0.3
    const zMm = vol.spacing?.[2] || 0.3
    const nz = vol.dimensions[2]
    // Crop the cuts to the same tuned asymmetric band the panoramic itself
    // uses (crossBandRest, built on defaultZCrop) — plenty of room above the
    // tooth row (sinus/nasal floor), little below (mandible border) — then
    // slide that band up/down with the ladder. Clamp the *center*, not each
    // edge independently: an independent-edge clamp lets the near edge pin
    // at a scan boundary while the far edge keeps tracking the shift, which
    // changes the crop's height instead of its position (reads as zoom, not
    // pan — found 2026-08-28). Shift is subtracted, not added: dragging the
    // ladder down should reveal lower (mandible-ward) structures, i.e. a
    // smaller z index, matching the "up = superior" convention the rendered
    // image and the axial view both already use.
    const { center: restCenter, half: bandHalf } = crossBandRest(vol, arch.z)
    const centerZ = Math.min(nz - bandHalf, Math.max(bandHalf, restCenter - shift / zMm))
    const zMin = centerZ - bandHalf
    const zMax = centerZ + bandHalf
    const heightMm = (zMax - zMin) * zMm
    const arcMm = curve.arcLenPx * pxMm
    const stepFrac = arcMm > 0 ? stepMm / arcMm : 0
    const { depthMm: depth } = paramsRef.current

    const paint = (canvas, f, widthMm) => {
      if (!canvas) return
      const cs = renderCrossSection(vol, curve, f, { widthMm, depthMm: depth, zMin, zMax })
      if (!cs) return
      const img = panoToImageData(cs)
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d').putImageData(img, 0, 0)
      crossDimsRef.current.set(canvas, { widthMm, heightMm })
      fitCrossCanvas(canvas, widthMm, heightMm)
    }
    paint(crossLargeRef.current, pos, CROSS_WIDTH_MM + 8)
    CROSS_OFFSETS.forEach((k, idx) => {
      paint(crossTileRefs.current[idx], Math.max(0, Math.min(1, pos + k * stepFrac)), CROSS_WIDTH_MM)
    })
    drawPanoMarkers()
  }, [getVol, fitCrossCanvas, drawPanoMarkers])

  // Recenter the strip on a neighbor tile (click on a ±tile).
  const nudgeCross = useCallback((k) => {
    const vol = getVol()
    const arch = archRef.current
    if (!vol || !arch) return
    const curve = sampleCurve(arch.points, 520)
    if (!curve) return
    const arcMm = curve.arcLenPx * (vol.spacing?.[0] || 0.3)
    if (!arcMm) return
    setCrossPos(p => Math.max(0, Math.min(1, p + (k * crossRef.current.crossStepMm) / arcMm)))
  }, [getVol])

  // ── panoramic rendering ────────────────────────────────────────────────
  const renderPano = useCallback((fast = false) => {
    const vol = getVol()
    const arch = archRef.current
    const canvas = panoCanvasRef.current
    if (!vol || !arch || !canvas) return
    const curve = sampleCurve(arch.points, 520)
    if (!curve) return
    const q = fast
      ? { sStride: 2, zStride: 2, steps: 3 }
      : { sStride: 1, zStride: 1, steps: 11 }
    const nz = vol.dimensions[2]
    const crop = zCropRef.current
    // While a crop handle is being dragged, render the full height instead
    // of the (possibly much smaller) current crop, so there's headroom to
    // drag into — committed back to the real crop on release (schedulePano
    // callers below / cropHandlesRef pointer handlers).
    const { zMin, zMax } = cropDragRef.current
      ? { zMin: 0, zMax: nz }
      : { zMin: crop?.lo ?? 0, zMax: crop?.hi ?? nz }
    const pano = renderPanoramic(vol, curve, { ...paramsRef.current, ...q, zMin, zMax })
    if (!pano) return
    const img = panoToImageData(pano)
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d').putImageData(img, 0, 0)
    // keep the on-screen mm aspect regardless of sampling density
    const pxMm = vol.spacing?.[0] || 0.3
    const zMm = vol.spacing?.[2] || 0.3
    const widthMm = curve.arcLenPx * pxMm
    const heightMm = (zMax - zMin) * zMm
    aspectRef.current = widthMm / heightMm
    physMmRef.current = { widthMm, heightMm, zLo: zMin, zHi: zMax }
    fitCanvas()
    drawCropHandles()
    drawLadders()
  }, [getVol, fitCanvas, drawCropHandles, drawLadders])

  const schedulePano = useCallback((fast) => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      renderPano(fast)
      renderCrossAll() // no-op outside implant mode
    })
  }, [renderPano, renderCrossAll])

  // ── arch overlay drawing on the axial viewport ─────────────────────────
  const drawArch = useCallback(() => {
    const canvas = overlayRef.current
    const viewport = getAxial()
    const vol = getVol()
    const arch = archRef.current
    if (!canvas || !viewport || !vol || !arch) return
    const el = canvas.parentElement
    const w = el.clientWidth, h = el.clientHeight
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr
    }
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const toCanvas = ([i, j]) => {
      const world = vol.imageData.indexToWorld([i, j, arch.z])
      return viewport.worldToCanvas(world)
    }
    const curve = sampleCurve(arch.points, 200)
    if (!curve) return

    // Focal-trough band width — i-CAT's oblique ladder controls this same
    // number (the panoramic's slab thickness) but never shows it on Axial;
    // painting it as a translucent ribbon straddling the arch makes "how
    // much buccal-lingual tissue am I averaging into one panoramic pixel"
    // visible instead of just a number on a slider. Drawn under the arch
    // line/handles so those stay crisp on top. paramsRef (not slabMm state
    // directly) so this stays correct even if drawArch's memoized identity
    // doesn't change — see the sync effect below.
    const pxMm = vol.spacing?.[0] || 0.3
    const halfSlabPx = (paramsRef.current.slabMm / 2) / pxMm
    ctx.beginPath()
    for (let s = 0; s < curve.xs.length; s++) {
      const p = toCanvas([curve.xs[s] + halfSlabPx * curve.nxs[s], curve.ys[s] + halfSlabPx * curve.nys[s]])
      if (s === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1])
    }
    for (let s = curve.xs.length - 1; s >= 0; s--) {
      const p = toCanvas([curve.xs[s] - halfSlabPx * curve.nxs[s], curve.ys[s] - halfSlabPx * curve.nys[s]])
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = 'rgba(120, 180, 255, 0.14)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(120, 180, 255, 0.5)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.strokeStyle = 'rgba(255, 170, 40, 0.95)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let s = 0; s < curve.xs.length; s += 2) {
      const p = toCanvas([curve.xs[s], curve.ys[s]])
      if (s === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1])
    }
    ctx.stroke()
    for (const pt of arch.points) {
      const p = toCanvas(pt)
      ctx.beginPath()
      ctx.arc(p[0], p[1], HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 170, 40, 0.9)'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Implant mode: mark the cut positions on the arch — a perpendicular cyan
    // line per cut (solid = center, faint = the ±tiles), matching the pano
    // markers and the strip labels.
    const { mode: m, crossPos: pos, crossStepMm: stepMm } = crossRef.current
    if (m === 'implant') {
      const pxMm = vol.spacing?.[0] || 0.3
      const arcMm = curve.arcLenPx * pxMm
      if (!arcMm) return
      const halfPx = (CROSS_WIDTH_MM / 2) / pxMm
      const S = curve.xs.length
      for (const k of CROSS_OFFSETS) {
        const f = pos + k * (stepMm / arcMm)
        if (f < 0 || f > 1) continue
        const s = Math.round(f * (S - 1))
        const p1 = toCanvas([curve.xs[s] - halfPx * curve.nxs[s], curve.ys[s] - halfPx * curve.nys[s]])
        const p2 = toCanvas([curve.xs[s] + halfPx * curve.nxs[s], curve.ys[s] + halfPx * curve.nys[s]])
        ctx.strokeStyle = k === 0 ? 'rgba(53,208,255,0.95)' : 'rgba(53,208,255,0.4)'
        ctx.lineWidth = k === 0 ? 2 : 1.25
        ctx.beginPath()
        ctx.moveTo(p1[0], p1[1])
        ctx.lineTo(p2[0], p2[1])
        ctx.stroke()
      }
    }
  }, [getVol])

  // ── wait for the volume, then auto-fit the arch ────────────────────────
  useEffect(() => {
    let stop = false
    const tick = () => {
      if (stop) return
      const vol = getVol()
      const loaded = vol && (vol.loadStatus ? vol.loadStatus.loaded : true)
      const viewport = getAxial()
      if (!loaded || !viewport) { setTimeout(tick, 500); return }
      setAxialEl(viewport.element)
      setStatus('fitting')
      // let the "Calculando arco…" paint before the heavy scan
      setTimeout(() => {
        if (stop) return
        let arch = null
        try { arch = autoFitArch(vol) } catch (e) { console.error('[pano] auto-fit failed:', e) }
        archRef.current = arch || defaultArch(vol)
        zCropRef.current = defaultZCrop(vol, archRef.current.z)
        if (!arch) console.warn('[pano] arch auto-fit failed — using the generic fallback arch')
        setStatus('ready')
      }, 30)
    }
    tick()
    return () => { stop = true; cancelAnimationFrame(rafRef.current) }
  }, [getVol])

  // first full render + arch draw once ready; re-fit the canvas on resize
  useEffect(() => {
    if (status !== 'ready') return
    renderPano(false)
    drawArch()
    const wrap = panoCanvasRef.current?.closest('.live-pano-canvas-wrap')
    if (!wrap) return
    const ro = new ResizeObserver(() => { fitCanvas(); drawPanoMarkers(); drawCropHandles(); drawLadders() })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [status, renderPano, drawArch, fitCanvas, drawPanoMarkers, drawCropHandles, drawLadders])

  // re-render when slab / depth change (slider drags are cheap enough at full res)
  useEffect(() => {
    if (status !== 'ready') return
    schedulePano(false)
    drawArch() // slab width also redraws the band ribbon on Axial
  }, [slabMm, depthMm, status, schedulePano, drawArch])

  // Cross-sections follow position / spacing / mode / vertical shift; the
  // axial overlay redraws too so its cut lines track the strip.
  useEffect(() => {
    if (status !== 'ready' || mode !== 'implant') return
    renderCrossAll()
    drawArch()
    drawLadders()
  }, [status, mode, crossPos, crossStepMm, zShiftMm, renderCrossAll, drawArch, drawLadders])

  // Vertical ladder also drives the Axial viewport itself, not just the cuts'
  // z-band above — scrubbing it should feel like moving up/down through the
  // jaw. Kept separate from the effect above (not keyed on crossPos/
  // crossStepMm) so dragging the *other* ladders doesn't yank the axial
  // slice back to its zShiftMm target on every position/step change. Same
  // restCenter anchor and sign as renderCrossAll's centerZ, so the axial
  // slice and the cross-section band always move together.
  useEffect(() => {
    if (status !== 'ready' || mode !== 'implant') return
    const vol = getVol()
    const arch = archRef.current
    if (!vol || !arch) return
    const zMm = vol.spacing?.[2] || 0.3
    const { center: restCenter } = crossBandRest(vol, arch.z)
    moveAxialToZIndex(vol, restCenter - zShiftMm / zMm)
  }, [status, mode, zShiftMm, getVol, moveAxialToZIndex])

  // Leaving implant mode: clear the cut lines from the axial overlay and drop
  // dims of the now-unmounted cross canvases. The component stays mounted
  // across panoramic↔implant switches (same key), so fullscreen — which only
  // the panoramic room offers — must not leak into the implant layout either.
  useEffect(() => {
    if (mode !== 'implant') return
    setFullscreen(false)
    return () => {
      for (const canvas of [...crossDimsRef.current.keys()]) {
        if (!canvas.isConnected) crossDimsRef.current.delete(canvas)
      }
    }
  }, [mode])
  useEffect(() => {
    if (status !== 'ready' || mode === 'implant') return
    drawArch()
    drawLadders() // clears the horizontal ladder, which is implant-only
  }, [mode, status, drawArch, drawLadders])

  // Refit the cross canvases (styles only, no resampling) when their panels
  // resize — control-panel drag, window resize, etc.
  useEffect(() => {
    if (status !== 'ready' || mode !== 'implant') return
    const els = [
      crossLargeRef.current?.parentElement,
      ...crossTileRefs.current.map(c => c?.parentElement),
    ].filter(Boolean)
    if (!els.length) return
    const ro = new ResizeObserver(() => {
      for (const [canvas, dims] of crossDimsRef.current) {
        if (canvas.isConnected) fitCrossCanvas(canvas, dims.widthMm, dims.heightMm)
      }
    })
    els.forEach(el => ro.observe(el))
    return () => ro.disconnect()
  }, [status, mode, fitCrossCanvas])

  // ── axial listeners: redraw arch on camera change, drag control points ──
  useEffect(() => {
    if (!axialEl || status !== 'ready') return
    if (getComputedStyle(axialEl).position === 'static') axialEl.style.setProperty('position', 'relative')

    const onCamera = () => drawArch()
    axialEl.addEventListener(Enums.Events.CAMERA_MODIFIED, onCamera)
    const ro = new ResizeObserver(() => drawArch())
    ro.observe(axialEl)

    const canvasPos = (e) => {
      const rect = overlayRef.current.getBoundingClientRect()
      return [e.clientX - rect.left, e.clientY - rect.top]
    }
    const onMove = (e) => {
      const idx = dragRef.current
      const viewport = getAxial()
      const vol = getVol()
      if (idx == null || !viewport || !vol || !archRef.current) return
      const world = viewport.canvasToWorld(canvasPos(e))
      const ijk = vol.imageData.worldToIndex(world)
      archRef.current.points[idx] = [ijk[0], ijk[1]]
      drawArch()
      schedulePano(true)
    }
    const onUp = () => {
      if (dragRef.current == null) return
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      schedulePano(false)
    }
    // capture-phase so a grab near a handle wins over the crosshairs tool;
    // clicks elsewhere on the axial panel pass through untouched.
    const onDown = (e) => {
      const viewport = getAxial()
      const vol = getVol()
      const arch = archRef.current
      if (!viewport || !vol || !arch || !overlayRef.current) return
      const pos = canvasPos(e)
      for (let k = 0; k < arch.points.length; k++) {
        const world = vol.imageData.indexToWorld([...arch.points[k], arch.z])
        const p = viewport.worldToCanvas(world)
        if (Math.hypot(p[0] - pos[0], p[1] - pos[1]) <= HIT_R) {
          e.stopImmediatePropagation()
          e.preventDefault()
          dragRef.current = k
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          return
        }
      }
    }
    axialEl.addEventListener('pointerdown', onDown, { capture: true })

    // Double-click near the traced curve (not on an existing handle) inserts
    // a new draggable control point there — lets you add resolution wherever
    // the auto-fit arch needs finer local correction, instead of only being
    // able to nudge the fixed set of points from autoFitArch.
    const onDblClick = (e) => {
      const viewport = getAxial()
      const vol = getVol()
      const arch = archRef.current
      if (!viewport || !vol || !arch || !overlayRef.current) return
      const pos = canvasPos(e)
      for (const pt of arch.points) {
        const world = vol.imageData.indexToWorld([...pt, arch.z])
        const p = viewport.worldToCanvas(world)
        if (Math.hypot(p[0] - pos[0], p[1] - pos[1]) <= HIT_R) return // on a handle, not the bare curve
      }
      const curve = sampleCurve(arch.points, 200)
      if (!curve) return
      let bestS = 0, bestD = Infinity
      for (let s = 0; s < curve.xs.length; s++) {
        const world = vol.imageData.indexToWorld([curve.xs[s], curve.ys[s], arch.z])
        const p = viewport.worldToCanvas(world)
        const d = Math.hypot(p[0] - pos[0], p[1] - pos[1])
        if (d < bestD) { bestD = d; bestS = s }
      }
      if (bestD > 25) return // not close enough to the visible line
      const n = arch.points.length
      const insertAt = Math.max(1, Math.min(n - 1, Math.round((bestS / (curve.xs.length - 1)) * (n - 1))))
      const clickWorld = viewport.canvasToWorld(pos)
      const ijk = vol.imageData.worldToIndex(clickWorld)
      arch.points.splice(insertAt, 0, [ijk[0], ijk[1]])
      drawArch()
      schedulePano(false)
    }
    axialEl.addEventListener('dblclick', onDblClick)

    return () => {
      axialEl.removeEventListener(Enums.Events.CAMERA_MODIFIED, onCamera)
      axialEl.removeEventListener('pointerdown', onDown, { capture: true })
      axialEl.removeEventListener('dblclick', onDblClick)
      ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [axialEl, status, drawArch, schedulePano, getVol])

  const refit = () => {
    const vol = getVol()
    if (!vol) return
    setStatus('fitting')
    setTimeout(() => {
      let arch = null
      try { arch = autoFitArch(vol) } catch (e) { console.error('[pano] auto-fit failed:', e) }
      archRef.current = arch || defaultArch(vol)
      zCropRef.current = defaultZCrop(vol, archRef.current.z)
      setStatus('ready')
      renderPano(false)
      drawArch()
    }, 30)
  }

  // Implant mode: click (or drag) on the pano moves the cut position there.
  const panoPosFromEvent = (e) => {
    const rect = panoCanvasRef.current?.getBoundingClientRect()
    if (!rect || !rect.width) return null
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }
  const onPanoPointerDown = (e) => {
    if (crossRef.current.mode !== 'implant') return
    e.preventDefault()
    const set = (ev) => {
      const f = panoPosFromEvent(ev)
      if (f != null) setCrossPos(f)
    }
    set(e)
    const onMove = (ev) => set(ev)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Drag a z-crop handle (top = 'hi', bottom = 'lo'). Works in both rooms —
  // checked ahead of the implant-only click-to-navigate above.
  const startCropDrag = (e, which) => {
    e.preventDefault()
    e.stopPropagation()
    const vol = getVol()
    const nz = vol?.dimensions?.[2] ?? 0
    const zMm = vol?.spacing?.[2] || 0.3
    const minGapPx = Z_CROP_MIN_GAP_MM / zMm
    cropDragRef.current = which
    schedulePano(true) // switch to the full-height render so there's room to drag
    const move = (ev) => {
      const rect = panoCanvasRef.current?.getBoundingClientRect()
      if (!rect || !rect.height) return
      const frac = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
      const z = Math.round((1 - frac) * nz) // full range shown while dragging, teeth-up flip
      const crop = zCropRef.current
      if (!crop) return
      if (which === 'hi') crop.hi = Math.max(crop.lo + minGapPx, Math.min(nz, z))
      else crop.lo = Math.min(crop.hi - minGapPx, Math.max(0, z))
      drawCropHandles()
      schedulePano(true)
    }
    const up = () => {
      cropDragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      schedulePano(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Ladder hit-test: which ladder's handle (if any) is near (clientX,clientY).
  // Checked ahead of the z-crop handles / implant click-to-navigate below.
  const ladderHit = (clientX, clientY) => {
    if (thumbnail) return null // Vista previa: nothing to grab, no ladders drawn
    const rect = panoCanvasRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return null
    const p = [clientX - rect.left, clientY - rect.top]
    const { pStart, pEnd } = obliqueLadderGeom(rect.width, rect.height)
    const obliquePt = lerp2(pStart, pEnd, projectOnSegment(p, pStart, pEnd))
    if (Math.hypot(p[0] - obliquePt[0], p[1] - obliquePt[1]) <= HIT_R) return 'oblique'
    if (crossRef.current.mode === 'implant') {
      const { x0, x1, y } = hLadderGeom(rect.width)
      const hPt = [x0 + (x1 - x0) * projectOnSegment(p, [x0, y], [x1, y]), y]
      if (Math.hypot(p[0] - hPt[0], p[1] - hPt[1]) <= HIT_R) return 'horizontal'
      const { x: vx, y0: vy0, y1: vy1 } = vLadderGeom(rect.width, rect.height)
      const vPt = [vx, vy0 + (vy1 - vy0) * projectOnSegment(p, [vx, vy0], [vx, vy1])]
      if (Math.hypot(p[0] - vPt[0], p[1] - vPt[1]) <= HIT_R) return 'vertical'
    }
    return null
  }

  const startLadderDrag = (e, which) => {
    e.preventDefault()
    e.stopPropagation()
    ladderDragRef.current = which
    const move = (ev) => {
      const rect = panoCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const p = [ev.clientX - rect.left, ev.clientY - rect.top]
      if (which === 'oblique') {
        const { pStart, pEnd } = obliqueLadderGeom(rect.width, rect.height)
        const t = projectOnSegment(p, pStart, pEnd)
        setSlabMm(Math.round(SLAB_MIN_MM + t * (SLAB_MAX_MM - SLAB_MIN_MM)))
      } else if (which === 'vertical') {
        const { x: vx, y0: vy0, y1: vy1 } = vLadderGeom(rect.width, rect.height)
        const t = projectOnSegment(p, [vx, vy0], [vx, vy1])
        setZShiftMm(Math.round(Z_SHIFT_MIN_MM + t * (Z_SHIFT_MAX_MM - Z_SHIFT_MIN_MM)))
      } else {
        const { x0, x1, y } = hLadderGeom(rect.width)
        setCrossPos(projectOnSegment(p, [x0, y], [x1, y]))
      }
    }
    move(e)
    const up = () => {
      ladderDragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onPanoCanvasPointerDown = (e) => {
    const ladder = ladderHit(e.clientX, e.clientY)
    if (ladder) { startLadderDrag(e, ladder); return }
    const hit = cropHandleHit(e.clientY)
    if (hit) { startCropDrag(e, hit); return }
    onPanoPointerDown(e)
  }
  const onPanoCanvasPointerMove = (e) => {
    if (cropDragRef.current || ladderDragRef.current) return
    const canvas = panoCanvasRef.current
    if (!canvas) return
    canvas.style.cursor = ladderHit(e.clientX, e.clientY)
      ? 'pointer'
      : (cropHandleHit(e.clientY) ? 'row-resize' : '')
  }

  // Same convention as the MPR panels: ctrl+wheel (or trackpad pinch) zooms,
  // plain wheel drives the panel's own scroll axis — here that's depth.
  const onWheel = (e) => {
    e.preventDefault()
    if (e.ctrlKey) {
      setPanoZoom(z => Math.min(5, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
      return
    }
    setDepthMm(d => Math.max(-12, Math.min(12, d + (e.deltaY > 0 ? 1 : -1))))
  }

  const fmtOffset = (k) => {
    const v = k * crossStepMm
    const s = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(1)
    return k === 0 ? '0' : `${k > 0 ? '+' : '−'}${s}`
  }

  return (
    <>
      <div className={`live-pano dock-${mode}${fullscreen ? ' fullscreen' : ''}`}>
        <div className="live-pano-main">
          <span className="viewport-label" style={{ color: 'rgb(255,170,40)' }}>Panorámica (en vivo)</span>
          {status !== 'ready' ? (
            <div className="live-pano-status">
              <div className="spinner" />
              <p>{status === 'waiting' ? 'Esperando el volumen…' : 'Calculando el arco dental…'}</p>
            </div>
          ) : (
            <>
              <div className="live-pano-canvas-wrap">
                <div className="live-pano-canvas-box" style={{ transform: `scale(${panoZoom})` }}>
                  <canvas
                    ref={panoCanvasRef}
                    className="live-pano-canvas"
                    onWheel={onWheel}
                    onPointerDown={onPanoCanvasPointerDown}
                    onPointerMove={onPanoCanvasPointerMove}
                  />
                  <canvas ref={cropHandlesRef} className="live-pano-crop-handles" />
                  {mode === 'implant' && <canvas ref={panoMarkerRef} className="live-pano-markers" />}
                  <canvas ref={ladderRef} className="live-pano-ladders" />
                </div>
              </div>
              <div className="live-pano-controls">
                <button className="tool-btn" onClick={refit} title="Volver a detectar el arco automáticamente">
                  Reajustar arco
                </button>
                <span className="live-pano-hint">
                  {mode === 'implant'
                    ? 'Escalera diagonal = grosor · escalera horizontal = posición · clic en la panorámica también mueve la posición · doble clic en la curva (Axial) agrega un punto'
                    : 'Escalera diagonal = grosor · arrastra los puntos naranjas en Axial (doble clic en la curva agrega un punto) · rueda o el control lateral = profundidad'}
                </span>
              </div>
            </>
          )}
        </div>
        {/* Vista previa: plain reference thumbnail, i-CAT-style — no depth
            slider, no reset/fullscreen/close chrome. */}
        {!thumbnail && (
          <div className="viewport-side">
            {status === 'ready' ? (
              <div className="viewport-side-slider">
                <input
                  type="range"
                  className="slice-slider vertical"
                  orient="vertical"
                  min={-12}
                  max={12}
                  step={1}
                  value={depthMm}
                  onChange={e => setDepthMm(Number(e.target.value))}
                />
                <span className="slice-counter-vert">{depthMm > 0 ? '+' : ''}{depthMm}</span>
              </div>
            ) : <div className="viewport-side-slider" />}
            <div className="viewport-side-actions">
              {mode === 'panoramic' && (
                <button
                  className="viewport-side-btn"
                  onClick={() => setFullscreen(f => !f)}
                  title={fullscreen ? 'Restaurar' : 'Pantalla completa'}
                >
                  {fullscreen ? '⤡' : '⤢'}
                </button>
              )}
              <button className="viewport-side-btn" onClick={() => setPanoZoom(1)} title="Restablecer vista">⟲</button>
              <button className="viewport-side-btn" onClick={onClose} title="Volver al Explorador">✕</button>
            </div>
          </div>
        )}
      </div>

      {mode === 'implant' && (
        <div className="cross-large-panel">
          <span className="viewport-label" style={{ color: CROSS_COLOR }}>Corte transversal</span>
          {status !== 'ready' ? (
            <div className="live-pano-status">
              <div className="spinner" />
              <p>Esperando el arco…</p>
            </div>
          ) : (
            <>
              <div className="cross-canvas-wrap">
                <canvas ref={crossLargeRef} className="cross-canvas" />
              </div>
              <div className="cross-controls">
                <label>
                  Paso {crossStepMm} mm
                  <input type="range" min={1} max={5} step={0.5} value={crossStepMm}
                    onChange={e => setCrossStepMm(Number(e.target.value))} />
                </label>
                <span className="live-pano-hint">La escalera horizontal en la panorámica mueve la posición</span>
              </div>
            </>
          )}
        </div>
      )}
      {mode === 'implant' && (
        <div className="cross-strip" style={{ gridTemplateColumns: `repeat(${CROSS_GRID_COLS}, 1fr)` }}>
          {CROSS_OFFSETS.map((k, idx) => (
            <div
              key={k}
              className={`cross-tile${k === 0 ? ' center' : ''}`}
              onClick={() => status === 'ready' && k !== 0 && nudgeCross(k)}
              title={k === 0 ? 'Corte central' : 'Centrar aquí'}
            >
              <span className="cross-tile-label">{fmtOffset(k)} mm</span>
              <div className="cross-canvas-wrap">
                <canvas
                  ref={el => { crossTileRefs.current[idx] = el }}
                  className="cross-canvas"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {axialEl && status === 'ready' &&
        createPortal(<canvas ref={overlayRef} className="arch-overlay-canvas" />, axialEl)}
    </>
  )
}
