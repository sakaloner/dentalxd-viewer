import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { CASES } from '../data/cases'
import { useAuth } from '../contexts/AuthContext'
import CornerstoneViewer from '../components/CornerstoneViewer'
import ControlPanel from '../components/ControlPanel'
import LivePanoramic from '../components/LivePanoramic'
import IcatMenuBar from '../components/icat/IcatMenuBar'
import IcatContextMenu from '../components/icat/IcatContextMenu'
import StudyPanel from '../components/icat/StudyPanel'
import { getPersistedMeshFallback } from '../utils/quality3d'
import '../components/icat/icat.css'

// Optional: URL of a remote full-featured viewer. Unset = the launch links are hidden.
const LAUNCH_URL = import.meta.env.VITE_REMOTE_VIEWER_URL || ''

// i-CAT "Set Filter" presets → CSS filter referencing the SVG sharpen kernels
// defined once below (real 3×3 convolution, not a contrast fake).
const FILTER_CSS = {
  none: 'none',
  mild: 'url(#icat-f-mild)',
  hard: 'url(#icat-f-hard)',
  sharp: 'url(#icat-f-sharp)',
  vsharp: 'url(#icat-f-vsharp)',
}

// Rooms that dock the live panoramic wide across the top of .viewer-main.
const PANO_LAYOUTS = new Set(['panoramic', 'implant', 'preview'])

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function Viewer() {
  const { caseId } = useParams()
  const { user } = useAuth()
  const caseData = CASES.find(c => c.id === caseId)
  const [activeTool, setActiveTool] = useState('crosshair')
  const [threshold3d, setThreshold3d] = useState(200)
  const [clearSignal, setClearSignal] = useState(0)
  const [cropResetSignal, setCropResetSignal] = useState(0)
  const [isolateToothSignal, setIsolateToothSignal] = useState(0)
  const [resetWLSignal, setResetWLSignal] = useState(0)
  // Layout "room" (docs/VIEWER_PLAN.md + docs/ICAT_CLONE.md). i-CAT screens
  // (Vista previa / Panorámica / MPR / ATM / 3D) map onto these values.
  // Switching only rearranges panels — the volume, tools and crosshair are shared.
  const [view, setView] = useState('preview')
  const [mesh3d, setMesh3d] = useState(() => getPersistedMeshFallback())

  // ── i-CAT skin state ──────────────────────────────────────────────────
  const icat = true // this branch ships the i-CAT Vision look on by default
  // Set Filter presets — default to 'mild' rather than 'none': the real 3×3
  // sharpen kernel (icat-f-mild) was built but never turned on, so every
  // panel shipped visibly softer than i-CAT's out of the box.
  const [filterPreset, setFilterPreset] = useState('mild')
  const [ctxMenu, setCtxMenu] = useState(null)             // {x,y} right-click menu
  const [toast, setToast] = useState(null)                 // i-CAT-parity info notes
  const toastTimer = useRef(null)

  const showInfo = (msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4600)
  }
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  // Right-click → i-CAT context menu. Cornerstone attaches its own native
  // contextmenu handler on each viewport canvas (for right-drag zoom) that
  // stops the event before it bubbles to React, so we intercept in the CAPTURE
  // phase on .viewer-main — this also disables right-drag zoom, matching i-CAT
  // where right-click is the tool menu.
  useEffect(() => {
    if (!icat) return
    const el = mainRef.current
    if (!el) return
    const onCtx = (e) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    el.addEventListener('contextmenu', onCtx, true)
    return () => el.removeEventListener('contextmenu', onCtx, true)
  }, [icat])

  // Room-level split fractions (see App.css/LivePanoramic.css `--pano-split`
  // etc.) — CornerstoneViewer's grid and LivePanoramic's docked panels are
  // siblings positioned from these, so they're the one shared source of truth.
  const mainRef = useRef(null)
  const [panoramicSplit, setPanoramicSplit] = useState(0.55)   // pano height, Panorámica/Preview — 0.7 was too tall (client feedback, 2026-08-28), dialed back down close to the original 0.52; drag range still caps at 0.75, see the divider below
  // Implante room, i-CAT quadrant layout: top row Panorámica + Axial, bottom
  // row big center cross-section + neighbor-tile grid.
  const [implantTopSplit, setImplantTopSplit] = useState(0.4)       // top row height
  const [implantPanoWidth, setImplantPanoWidth] = useState(2 / 3)   // Panorámica's share of the top row (Axial gets the rest)
  const [implantCrossWidth, setImplantCrossWidth] = useState(1 / 3) // big cross-section's share of the bottom row (grid gets the rest)

  // CornerstoneViewer/LivePanoramic remount per case (key derived from caseId
  // — kept distinct between the two siblings, see fix below) with default
  // tools, so the toolbar state must reset too or it would show a stale
  // active tool.
  useEffect(() => {
    setActiveTool('crosshair')
    setCropResetSignal(0)
    setIsolateToothSignal(0)
    setResetWLSignal(0)
    setView('preview')
    setMesh3d(getPersistedMeshFallback())
    setFilterPreset('mild')
    setCtxMenu(null)
    setPanoramicSplit(0.55)
    setImplantTopSplit(0.4)
    setImplantPanoWidth(2 / 3)
    setImplantCrossWidth(1 / 3)
  }, [caseId])

  function onSplitDown(e, axis, setFrac, [min, max]) {
    e.preventDefault()
    const rect = mainRef.current?.getBoundingClientRect()
    if (!rect) return
    const onMove = (ev) => {
      const frac = axis === 'y' ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width
      setFrac(Math.min(max, Math.max(min, frac)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!caseData) {
    return (
      <div style={{ padding: 40, color: 'var(--danger)' }}>
        Caso no encontrado. <Link to="/cases">← Volver</Link>
      </div>
    )
  }

  const visibleCases = user?.role === 'patient'
    ? CASES.filter(c => c.patientId === user.patientId)
    : CASES

  const isPano = PANO_LAYOUTS.has(view)
  const showStudyPanel = icat && view === 'preview'
  const meta = `${formatDate(caseData.studyDate)} · ${caseData.machine} · FOV ${caseData.fov}`

  const onIsolateTooth = () => { setView('diente'); setIsolateToothSignal(n => n + 1) }
  const onBorrar = () => setClearSignal(n => n + 1)
  const onResetWL = () => setResetWLSignal(n => n + 1)

  // i-CAT's "Guardar como JPEG": flatten every visible canvas in the current
  // room (Cornerstone viewports + their ruler/crosshair/ladder overlays) into
  // one image, positioned the same way they're laid out on screen, and
  // download it — a real snapshot of the current view, not just the imaging
  // panels' pixel data in isolation.
  const onSaveJPEG = () => {
    const container = mainRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(rect.width * dpr))
    out.height = Math.max(1, Math.round(rect.height * dpr))
    const ctx = out.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, out.width, out.height)
    const canvases = Array.from(container.querySelectorAll('canvas'))
    for (const c of canvases) {
      const r = c.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (c.closest('[style*="display: none"], [style*="display:none"]')) continue
      try {
        ctx.drawImage(c, (r.left - rect.left) * dpr, (r.top - rect.top) * dpr, r.width * dpr, r.height * dpr)
      } catch { /* skip a canvas that failed to composite rather than aborting the whole export */ }
    }
    out.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dentalxd-${caseData.patientId}-${view}-${Date.now()}.jpg`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    }, 'image/jpeg', 0.92)
  }

  return (
    <div
      className={`viewer-page${icat ? ' icat-skin' : ''}`}
      style={{ '--icat-filter': FILTER_CSS[filterPreset] || 'none' }}
    >
      {/* Real 3×3 sharpen kernels for the i-CAT "Set Filter" presets. Kernels
          sum to 1 so brightness is preserved; applied via CSS filter on the
          image canvases (.icat-skin .viewport-element). */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <filter id="icat-f-mild"><feConvolveMatrix order="3" preserveAlpha="true" edgeMode="duplicate" kernelMatrix="0 -0.2 0  -0.2 1.8 -0.2  0 -0.2 0" /></filter>
          <filter id="icat-f-hard"><feConvolveMatrix order="3" preserveAlpha="true" edgeMode="duplicate" kernelMatrix="0 -0.4 0  -0.4 2.6 -0.4  0 -0.4 0" /></filter>
          <filter id="icat-f-sharp"><feConvolveMatrix order="3" preserveAlpha="true" edgeMode="duplicate" kernelMatrix="-0.15 -0.35 -0.15  -0.35 3.0 -0.35  -0.15 -0.35 -0.15" /></filter>
          <filter id="icat-f-vsharp"><feConvolveMatrix order="3" preserveAlpha="true" edgeMode="duplicate" kernelMatrix="-0.3 -0.6 -0.3  -0.6 4.6 -0.6  -0.3 -0.6 -0.3" /></filter>
        </defs>
      </svg>

      {icat ? (
        <IcatMenuBar
          screen={view}
          onScreen={setView}
          activeTool={activeTool}
          onTool={setActiveTool}
          mesh3d={mesh3d}
          onToggleMesh={() => setMesh3d(v => !v)}
          onIsolateTooth={onIsolateTooth}
          filterPreset={filterPreset}
          onFilter={setFilterPreset}
          onSaveJPEG={onSaveJPEG}
          onInfo={showInfo}
          patientName={caseData.patientName}
          meta={meta}
          launchUrl={LAUNCH_URL}
        />
      ) : (
        <div className="viewer-toolbar">
          <Link to="/cases" className="btn-back">← Casos</Link>
          <span className="vt-title">{caseData.patientName}</span>
          <span className="vt-meta">· {meta}</span>
          <div className="spacer" />
          {LAUNCH_URL && (
            <a href={LAUNCH_URL} target="_blank" rel="noopener noreferrer" className="btn-remote">
              Ver en visor remoto ↗
            </a>
          )}
        </div>
      )}

      <div className="viewer-stage">
        {showStudyPanel && <StudyPanel caseData={caseData} visibleCases={visibleCases} />}
        <div
          className={`viewer-main layout-${view}`}
          ref={mainRef}
          style={{
            '--pano-split': `${(view === 'implant' ? implantTopSplit : panoramicSplit) * 100}%`,
            '--implant-pano-w': `${implantPanoWidth * 100}%`,
            '--implant-cross-w': `${implantCrossWidth * 100}%`,
          }}
        >
          <CornerstoneViewer key={`cs-${caseId}`} caseData={caseData} activeTool={activeTool} threshold3d={threshold3d} clearSignal={clearSignal} cropResetSignal={cropResetSignal} isolateToothSignal={isolateToothSignal} resetWLSignal={resetWLSignal} mesh3d={mesh3d} setMesh3d={setMesh3d} layout={view} />
          {isPano && (
            <LivePanoramic key={`pano-${caseId}`} caseData={caseData} mode={view === 'implant' ? 'implant' : 'panoramic'} thumbnail={view === 'preview'} onClose={() => setView('preview')} />
          )}
          {(view === 'panoramic' || view === 'preview') && (
            <div
              className="pano-divider"
              style={{ top: `${panoramicSplit * 100}%` }}
              onPointerDown={e => onSplitDown(e, 'y', setPanoramicSplit, [0.2, 0.75])}
            />
          )}
          {view === 'implant' && (
            <>
              {/* Top row (Panorámica + Axial) vs bottom row (big cross-section + grid). */}
              <div
                className="pano-divider"
                style={{ top: `${implantTopSplit * 100}%` }}
                onPointerDown={e => onSplitDown(e, 'y', setImplantTopSplit, [0.25, 0.65])}
              />
              {/* Panorámica ↔ Axial, confined to the top row. */}
              <div
                className="pano-divider pano-divider-v"
                style={{ left: `${implantPanoWidth * 100}%`, top: 0, bottom: `${(1 - implantTopSplit) * 100}%` }}
                onPointerDown={e => onSplitDown(e, 'x', setImplantPanoWidth, [0.4, 0.85])}
              />
              {/* Big cross-section ↔ neighbor-tile grid, confined to the bottom row. */}
              <div
                className="pano-divider pano-divider-v"
                style={{ left: `${implantCrossWidth * 100}%`, top: `${implantTopSplit * 100}%`, bottom: 0 }}
                onPointerDown={e => onSplitDown(e, 'x', setImplantCrossWidth, [0.2, 0.6])}
              />
            </>
          )}
        </div>
        {/* i-CAT's Vista previa is an inert study-list screen — no tool rail.
            MPR/Implante also hide it now (client request, 2026-08-28) — the
            right-click context menu (IcatContextMenu.jsx) covers tool
            switching there instead, closer to real i-CAT's workflow. */}
        {view !== 'preview' && view !== 'explorer' && view !== 'implant' && <ControlPanel
          view={view}
          setView={setView}
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          onBorrar={onBorrar}
          onQuitarRecorte={() => { setCropResetSignal(n => n + 1); setActiveTool('crosshair') }}
          onAislarDiente={onIsolateTooth}
          threshold3d={threshold3d}
          setThreshold3d={setThreshold3d}
          mesh3d={mesh3d}
          setMesh3d={setMesh3d}
        />}
      </div>

      {icat && ctxMenu && (
        <IcatContextMenu
          pos={ctxMenu}
          onClose={() => setCtxMenu(null)}
          activeTool={activeTool}
          onTool={setActiveTool}
          filterPreset={filterPreset}
          onFilter={setFilterPreset}
          onBorrar={onBorrar}
          onResetWL={onResetWL}
          onSaveJPEG={onSaveJPEG}
          onInfo={showInfo}
        />
      )}
      {icat && toast && <div className="icat-toast">{toast}</div>}
    </div>
  )
}
