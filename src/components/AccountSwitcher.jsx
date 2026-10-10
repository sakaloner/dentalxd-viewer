import { useAuth } from '../contexts/AuthContext'

// Demo-only convenience: swap between the fixed demo accounts (admin/doctor/
// patient) without logging out and retyping credentials. See AuthContext.
export default function AccountSwitcher() {
  const { user, demoAccounts, switchDemoUser } = useAuth()

  return (
    <select
      className="account-switcher"
      value={user.email}
      onChange={(e) => switchDemoUser(e.target.value)}
      title="Cambiar cuenta demo"
    >
      {Object.entries(demoAccounts).map(([email, acc]) => (
        <option key={email} value={email}>{acc.role} — {acc.name}</option>
      ))}
    </select>
  )
}
