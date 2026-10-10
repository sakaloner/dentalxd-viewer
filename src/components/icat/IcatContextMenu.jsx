import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { ICAT_FILTERS } from './IcatMenuBar'

// Windows-style right-click menu, faithful to i-CAT Vision's context menu
// (see docs/ICAT_CLONE.md). Items that map to a real action in our viewer run
// it; items that only exist in the full remote i-CAT Vision are shown (for
// fidelity) but flagged `muted` and explain themselves via a toast on click.
function Item({ label, checked, muted, onClick }) {
  return (
    <button className={`icat-ctx-item${checked ? ' checked' : ''}${muted ? ' muted' : ''}`} onClick={onClick}>
      <span>{label}</span>
    </button>
  )
}

export default function IcatContextMenu({
  pos, onClose,
  activeTool, onTool,
  filterPreset, onFilter,
  onBorrar, onResetWL, onSaveJPEG, onInfo,
}) {
  const ref = useRef(null)
  const [xy, setXy] = useState(pos)

  // Keep the menu on-screen if it would overflow the right/bottom edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { innerWidth, innerHeight } = window
    const r = el.getBoundingClientRect()
    setXy({
      x: Math.min(pos.x, innerWidth - r.width - 6),
      y: Math.min(pos.y, innerHeight - r.height - 6),
    })
  }, [pos])

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('contextmenu', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('contextmenu', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const run = (fn) => () => { fn(); onClose() }
  const parity = (msg) => run(() => onInfo(msg))

  return (
    <div className="icat-ctx" ref={ref} style={{ left: xy.x, top: xy.y }} onContextMenu={e => e.preventDefault()}>
      <Item label="Estadísticas HU" muted onClick={parity('La lectura de HU aparece en la esquina de cada corte al mover el cursor.')} />
      <Item label="Distancia" checked={activeTool === 'length'} onClick={run(() => onTool('length'))} />
      <Item label="Línea" checked={activeTool === 'line'} onClick={run(() => onTool('line'))} />
      <Item label="Explorar" checked={activeTool === 'explore'} onClick={run(() => onTool('explore'))} />
      <div className="icat-ctx-sub">
        <button className="icat-ctx-item">
          <span>Ajustar filtro</span><span className="mi-arrow">▸</span>
        </button>
        <div className="icat-ctx-sub-panel">
          {ICAT_FILTERS.map(f => (
            <button key={f.id} className={`icat-ctx-item${filterPreset === f.id ? ' checked' : ''}`} onClick={run(() => onFilter(f.id))}>
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="icat-ctx-sep" />
      <Item label="Restablecer ventana/nivel" onClick={run(onResetWL)} />
      <Item label="Restablecer todas las ventanas" onClick={run(onResetWL)} />
      <Item label="Método panorámico" muted onClick={parity('El trazado de arco se ajusta arrastrando los puntos de la spline en la vista Panorámica.')} />
      <div className="icat-ctx-sep" />
      <Item label="Borrar mediciones" onClick={run(onBorrar)} />
      <Item label="Guardar workup" muted onClick={parity('Los «workups» se guardan en el i-CAT Vision completo (máquina remota).')} />
      <Item label="Cargar otro workup" muted onClick={parity('«Cargar workup» está en el i-CAT Vision completo.')} />
      <Item label="Guardar como JPEG" onClick={run(onSaveJPEG)} />
      <Item label="Abrir carpeta de salida" muted onClick={parity('La carpeta de salida está en la máquina remota.')} />
    </div>
  )
}
