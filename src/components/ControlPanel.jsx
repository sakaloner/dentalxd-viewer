import { useState, useRef, useCallback } from 'react'

const DEFAULT_WIDTH = 172 // fits the Vistas buttons (icon + full label) without truncation
const MIN_WIDTH = 120
const MAX_WIDTH = 420

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="cp-section">
      <button className="cp-section-header" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span className="cp-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="cp-section-body">{children}</div>}
    </div>
  )
}

// The three viewer layouts ("rooms" in docs/VIEWER_PLAN.md). Icons are tiny
// schematics of each tile arrangement so the buttons read at a glance even
// at the panel's narrow default width.
const VIEW_LAYOUTS = [
  { id: 'explorer',  label: 'Explorador', hint: 'Axial · Sagital · Coronal · 3D' },
  { id: 'panoramic', label: 'Panorámica', hint: 'Panorámica + Axial · Coronal · 3D' },
  { id: 'implant',   label: 'Implante',   hint: 'Panorámica + cortes transversales' },
  { id: 'diente',    label: 'Diente',     hint: 'Aísla el diente en la cruz — vista 3D única' },
]

function ViewIcon({ type }) {
  const r = { rx: 1, fill: 'currentColor' }
  if (type === 'explorer') {
    return (
      <svg viewBox="0 0 28 20" className="view-icon" aria-hidden="true">
        <rect x="1" y="1" width="12.4" height="8.6" {...r} />
        <rect x="14.6" y="1" width="12.4" height="8.6" {...r} />
        <rect x="1" y="10.4" width="12.4" height="8.6" {...r} />
        <rect x="14.6" y="10.4" width="12.4" height="8.6" {...r} />
      </svg>
    )
  }
  if (type === 'panoramic') {
    return (
      <svg viewBox="0 0 28 20" className="view-icon" aria-hidden="true">
        <rect x="1" y="1" width="26" height="9.2" {...r} />
        <rect x="1" y="11.4" width="8.1" height="7.6" {...r} />
        <rect x="10.1" y="11.4" width="8" height="7.6" {...r} />
        <rect x="19.1" y="11.4" width="7.9" height="7.6" {...r} />
      </svg>
    )
  }
  if (type === 'implant') {
    return (
      <svg viewBox="0 0 28 20" className="view-icon" aria-hidden="true">
        <rect x="1" y="1" width="26" height="6" {...r} />
        <rect x="1" y="8.2" width="12.4" height="6.6" {...r} />
        <rect x="14.6" y="8.2" width="12.4" height="6.6" {...r} />
        {[0, 1, 2, 3, 4].map(i => (
          <rect key={i} x={1 + i * 5.3} y="16" width="4.7" height="3" {...r} />
        ))}
      </svg>
    )
  }
  // diente: one big single pane with a small tooth glyph — a single isolated
  // 3D view, distinct from the multi-tile icons above.
  return (
    <svg viewBox="0 0 28 20" className="view-icon" aria-hidden="true">
      <rect x="1" y="1" width="26" height="18" {...r} fillOpacity="0.35" />
      <path
        d="M14 5.5c-2.3 0-3.7 1.4-3.7 3.4 0 1.7.6 3 1.1 4.4.4 1 .7 2 1.2 2 .6 0 .7-1.6 1.4-1.6s.8 1.6 1.4 1.6c.5 0 .8-1 1.2-2 .5-1.4 1.1-2.7 1.1-4.4 0-2-1.4-3.4-3.7-3.4Z"
        fill="currentColor"
      />
    </svg>
  )
}

const MODE_TOOLS = [
  { id: 'crosshair', label: 'Cruz' },
  { id: 'wl',        label: 'W/L' },
  { id: 'pan',       label: 'Pan' },
  { id: 'zoom',      label: 'Zoom' },
  { id: 'crop',      label: 'Recortar' },
]

// Right-side collapsible panel, Romexis-style: Tools / Annotation / 3D
// Rendering. Holds only controls that already have real functionality behind
// them — no Adjust (W/L numeric) or preset-dropdown sections, since those
// don't exist yet in CornerstoneViewer.
export default function ControlPanel({
  view, setView,
  activeTool, setActiveTool,
  onBorrar, onQuitarRecorte, onAislarDiente,
  threshold3d, setThreshold3d,
  mesh3d, setMesh3d,
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragRef = useRef(null) // { startX, startWidth }

  // Dragging the left edge resizes the panel — moving left (negative deltaX)
  // grows it, since the panel is docked to the right.
  const onHandlePointerDown = useCallback((e) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startWidth: width }
    const onMove = (ev) => {
      const { startX, startWidth } = dragRef.current
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [width])

  return (
    <div className="control-panel" style={{ width }}>
      <div className="cp-resize-handle" onPointerDown={onHandlePointerDown} title="Arrastrar para redimensionar" />
      <Section title="Vistas">
        <div className="cp-view-list">
          {VIEW_LAYOUTS.map(v => (
            <button
              key={v.id}
              className={`view-btn${view === v.id ? ' active' : ''}`}
              // "Diente" always re-isolates around the current crosshair on
              // click, even if already the active view — that's how you pick
              // a different tooth (move the crosshair in Explorador, then
              // click Diente again).
              onClick={() => v.id === 'diente' ? onAislarDiente() : setView(v.id)}
              title={v.hint}
            >
              <ViewIcon type={v.id} />
              <span className="view-btn-label">{v.label}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Tools">
        <div className="cp-btn-grid">
          {MODE_TOOLS.map(t => (
            <button
              key={t.id}
              className={`tool-btn${activeTool === t.id ? ' active' : ''}`}
              onClick={() => setActiveTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {activeTool === 'crop' && (
          <button className="tool-btn cp-subaction" onClick={onQuitarRecorte}>
            Quitar recorte
          </button>
        )}
      </Section>

      <Section title="Annotation">
        <div className="cp-btn-grid">
          <button
            className={`tool-btn${activeTool === 'length' ? ' active' : ''}`}
            onClick={() => setActiveTool('length')}
          >
            Medir
          </button>
          <button className="tool-btn" onClick={onBorrar} title="Borrar todas las mediciones">
            Borrar
          </button>
        </div>
      </Section>

      <Section title="3D Rendering">
        <div className="cp-threshold">
          <span className="cp-threshold-label">Densidad</span>
          <div className="threshold-label">
            <input
              type="range"
              className="threshold-slider"
              min={-1000}
              max={2000}
              step={10}
              value={threshold3d}
              onChange={e => setThreshold3d(Number(e.target.value))}
            />
            <span className="threshold-value">{threshold3d}</span>
          </div>
        </div>
        <button
          className={`tool-btn${mesh3d ? ' active' : ''}`}
          onClick={() => setMesh3d(v => !v)}
          title="Ver el 3D como superficie ósea (malla) — más nítido y fluido sin GPU"
        >
          Superficie
        </button>
      </Section>
    </div>
  )
}
