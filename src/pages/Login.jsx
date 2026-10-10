import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Login() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) navigate('/home', { replace: true })
  }, [user, navigate])

  if (user) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    await new Promise(r => setTimeout(r, 300)) // simulate network
    const result = login(email.trim(), password)
    setLoading(false)
    if (result.ok) {
      navigate('/home')
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="logo-mark">🦷</div>
          <h1>DentalXD</h1>
          <p>Plataforma de Imágenes Diagnósticas</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Correo electrónico</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="usted@clinica.com"
              autoComplete="email"
              required
            />
          </div>
          <div className="form-group">
            <label>Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? 'Iniciando sesión…' : 'Iniciar sesión'}
          </button>
        </form>

        <div className="login-hints">
          <p>Cuentas de demostración:</p>
          <p><code>doctor@clinic.com</code> / <code>doctor123</code></p>
          <p><code>patient@clinic.com</code> / <code>patient123</code></p>
          <p><code>admin@clinic.com</code> / <code>admin123</code></p>
        </div>
      </div>
    </div>
  )
}
