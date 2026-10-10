import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'

// i-CAT Vision's screens, in its own order. `layout` is the value we feed to
// Viewer.jsx's `view` state (which drives CornerstoneViewer's LAYOUT_PANELS).
// Panorámica / ATM / 3D are hidden from the menu (client request, 2026-08-28
// — half-built, not ready to show) but their layouts/components are untouched
// and still reachable in code; just re-add the entries here to bring them back.
export const ICAT_SCREENS = [
  { layout: 'preview',   label: 'Vista previa',  hint: 'Panorámica + Sagital · Coronal · Axial' },
  { layout: 'explorer',  label: 'MPR',           hint: 'Axial · Sagital · Coronal · 3D' },
  { layout: 'implant',   label: 'Implante',      hint: 'Corte transversal + panorámica' },
]

// Tools that map to real actions in CornerstoneViewer (activeTool prop).
const ICAT_TOOLS = [
  { id: 'crosshair', label: 'Cruz / navegación' },
  { id: 'wl',        label: 'Ventana / Nivel (W/L)' },
  { id: 'pan',       label: 'Desplazar (Pan)' },
  { id: 'zoom',      label: 'Zoom' },
  { id: 'length',    label: 'Distancia (medir)' },
  { id: 'line',      label: 'Línea (reformatear)' },
  { id: 'explore',   label: 'Explorar (recorte 3D)' },
  { id: 'crop',      label: 'Recortar' },
]

export const ICAT_FILTERS = [
  { id: 'none',   label: 'Normal' },
  { id: 'mild',   label: 'Suave' },
  { id: 'hard',   label: 'Medio' },
  { id: 'sharp',  label: 'Fuerte' },
  { id: 'vsharp', label: 'Muy fuerte' },
]

function Menu({ label, open, onOpen, children }) {
  return (
    <div className={`icat-menu${open ? ' open' : ''}`}>
      <button onClick={() => onOpen(open ? null : label)}>{label}</button>
      {open && <div className="icat-menu-dropdown">{children}</div>}
    </div>
  )
}

function Item({ label, hint, checked, muted, arrow, onClick }) {
  return (
    <button className={`icat-menu-item${checked ? ' checked' : ''}${muted ? ' muted' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {hint && <span className="mi-hint">{hint}</span>}
      {arrow && <span className="mi-arrow">▸</span>}
    </button>
  )
}

export default function IcatMenuBar({
  screen, onScreen,
  activeTool, onTool,
  mesh3d, onToggleMesh, onIsolateTooth,
  filterPreset, onFilter,
  onSaveJPEG, onInfo,
  patientName, meta, launchUrl,
}) {
  const [openMenu, setOpenMenu] = useState(null)
  const barRef = useRef(null)

  // Click outside / Escape closes any open menu.
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e) => { if (barRef.current && !barRef.current.contains(e.target)) setOpenMenu(null) }
    const onKey = (e) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [openMenu])

  const close = () => setOpenMenu(null)
  const pick = (fn) => () => { fn(); close() }

  return (
    <div className="icat-menubar" ref={barRef}>
      <Menu label="Archivo" open={openMenu === 'Archivo'} onOpen={setOpenMenu}>
        <div className="icat-menu-heading">Estudio</div>
        <Item label="Abrir lista de estudios…" onClick={pick(() => onScreen('preview'))} />
        <Item label="Guardar como JPEG" onClick={pick(onSaveJPEG)} />
        <Item label="Abrir carpeta de salida" muted onClick={pick(() => onInfo('La carpeta de salida está en la máquina remota con el i-CAT Vision completo.'))} />
        <div className="icat-menu-sep" />
        <Item label="Salir al archivo de casos" onClick={close} />
      </Menu>

      <Menu label="Herramientas" open={openMenu === 'Herramientas'} onOpen={setOpenMenu}>
        <div className="icat-menu-heading">Herramientas</div>
        {ICAT_TOOLS.map(t => (
          <Item key={t.id} label={t.label} checked={activeTool === t.id} onClick={pick(() => onTool(t.id))} />
        ))}
        <div className="icat-menu-sep" />
        <div className="icat-menu-heading">Filtro (nitidez)</div>
        {ICAT_FILTERS.map(f => (
          <Item key={f.id} label={f.label} checked={filterPreset === f.id} onClick={pick(() => onFilter(f.id))} />
        ))}
        <div className="icat-menu-sep" />
        <div className="icat-menu-heading">3D</div>
        <Item label="Superficie ósea (malla)" checked={mesh3d} onClick={pick(onToggleMesh)} />
        <Item label="Aislar diente" onClick={pick(onIsolateTooth)} />
        <div className="icat-menu-sep" />
        <Item label="Guardar workup" muted onClick={pick(() => onInfo('Los «workups» (trazados de arco, estado de pantalla) se guardan en el i-CAT Vision completo.'))} />
        <Item label="Estadísticas HU" muted onClick={pick(() => onInfo('La lectura de HU aparece en la esquina de cada corte al mover el cursor.'))} />
      </Menu>

      <Menu label="Pantalla" open={openMenu === 'Pantalla'} onOpen={setOpenMenu}>
        {ICAT_SCREENS.map(s => (
          <Item key={s.layout} label={s.label} hint={s.hint} checked={screen === s.layout} onClick={pick(() => onScreen(s.layout))} />
        ))}
      </Menu>

      <Menu label="Ayuda" open={openMenu === 'Ayuda'} onOpen={setOpenMenu}>
        <Item label="Acerca de este visor" onClick={pick(() => onInfo('DentalXD — visor CBCT web de código abierto, inspirado en la navegación de visores clínicos de escritorio.'))} />
        {launchUrl && <Item label="Abrir visor remoto ↗" onClick={pick(() => window.open(launchUrl, '_blank', 'noopener'))} />}
      </Menu>

      <div className="icat-menubar-spacer" />
      {patientName && (
        <div className="icat-menubar-patient">
          <b>{patientName}</b>{meta && <><span className="sep">·</span><span>{meta}</span></>}
        </div>
      )}
      <div className="icat-menubar-actions">
        <Link to="/cases" className="icat-back">← Casos</Link>
        {launchUrl && <a href={launchUrl} target="_blank" rel="noopener noreferrer" className="icat-launch">Ver en visor remoto ↗</a>}
      </div>
    </div>
  )
}
