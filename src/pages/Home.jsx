import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import AccountSwitcher from '../components/AccountSwitcher'

export default function Home() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const canSeeDoctorView = user.role !== 'patient'

  // Patients only ever have one destination — skip the chooser entirely.
  useEffect(() => {
    if (!canSeeDoctorView) navigate('/cases', { replace: true })
  }, [canSeeDoctorView, navigate])

  if (!canSeeDoctorView) return null

  return (
    <div style={{ minHeight: '100vh' }}>
      <header className="app-header">
        <span className="logo">DentalXD</span>
        <div className="spacer" />
        <span className="user-name">{user.name}</span>
        <span className={`user-role role-${user.role}`}>{user.role}</span>
        <AccountSwitcher />
        <button className="btn-logout" onClick={logout}>Cerrar sesión</button>
      </header>

      <main className="home-page">
        <h2>¿Qué vista desea abrir?</h2>
        <p className="subtitle">Elija el visor según el tipo de consulta</p>

        <div className="vista-grid">
          {import.meta.env.VITE_REMOTE_VIEWER_URL && (
          <a
            className="vista-card vista-card-doctor"
            href={import.meta.env.VITE_REMOTE_VIEWER_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="vista-card-icon">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
                <path d="M7 10h2l1.5 3 2-5 1.5 4h3" />
              </svg>
            </span>
            <span className="vista-card-label">Vista Doctor</span>
            <span className="vista-card-desc">Visor profesional i-CAT Vision — diagnóstico completo</span>
            <span className="vista-card-cta">Abrir i-CAT Vision ↗</span>
          </a>
          )}

          <div className="vista-card vista-card-patient" onClick={() => navigate('/cases')}>
            <span className="vista-card-icon">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </span>
            <span className="vista-card-label">Vista Paciente</span>
            <span className="vista-card-desc">Archivo de estudios DentalXD — visor en línea</span>
            <span className="vista-card-cta">Abrir estudios →</span>
          </div>
        </div>
      </main>
    </div>
  )
}
