import { useNavigate } from 'react-router-dom'
import { CASES } from '../../data/cases'

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Preview screen's left column, mirroring i-CAT Vision's "Study List" (Window 1)
// + "Study Information" (Window 7). The list shows every case (clickable to
// load, like i-CAT's Window 1); the info block shows the loaded case's metadata.
export default function StudyPanel({ caseData, visibleCases }) {
  const navigate = useNavigate()
  const cases = visibleCases || CASES

  const info = [
    ['ID de paciente', caseData.patientId],
    ['Fecha de nacimiento', fmtDate(caseData.dob)],
    ['Fecha del estudio', fmtDate(caseData.studyDate)],
    ['Número de cortes', caseData.sliceCount],
    ['Campo de visión (FOV)', caseData.fov],
    ['Equipo', caseData.machine],
    ['Estudio', caseData.study],
  ]

  return (
    <div className="icat-studypanel">
      <div className="icat-sp-titlebar">Lista de estudios</div>
      <div className="icat-studylist">
        <table className="icat-sl-table">
          <thead>
            <tr><th>Paciente</th><th>ID</th><th>Fecha</th></tr>
          </thead>
          <tbody>
            {cases.map(c => (
              <tr
                key={c.id}
                className={`icat-sl-row${c.id === caseData.id ? ' active' : ''}`}
                onClick={() => c.id !== caseData.id && navigate(`/viewer/${c.id}`)}
                title={c.study}
              >
                <td>{c.patientName}</td>
                <td className="icat-sl-id">{c.patientId}</td>
                <td>{fmtDate(c.studyDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="icat-studyinfo">
        <div className="icat-sp-titlebar">Información del estudio</div>
        <div className="icat-si-body">
          <div className="icat-si-row"><span className="k">Paciente</span><span className="v">{caseData.patientName}</span></div>
          {info.map(([k, v]) => (
            <div className="icat-si-row" key={k}><span className="k">{k}</span><span className="v">{v || '—'}</span></div>
          ))}
          <div className="icat-si-acq">Sistema de adquisición: {caseData.institution || 'CBCT'}</div>
        </div>
      </div>
    </div>
  )
}
