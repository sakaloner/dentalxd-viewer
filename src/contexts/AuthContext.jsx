import { createContext, useContext, useState } from 'react';

const USERS = {
  'doctor@clinic.com': {
    password: 'doctor123',
    name: 'Dr. Demo',
    role: 'doctor',
    patientId: null,
  },
  'patient@clinic.com': {
    password: 'patient123',
    name: 'Demo, Paciente Uno',
    role: 'patient',
    patientId: 'DXD-001',
  },
  'admin@clinic.com': {
    password: 'admin123',
    name: 'Demo Admin',
    role: 'admin',
    patientId: null,
  },
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('dentalxd_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  function login(email, password) {
    const record = USERS[email.toLowerCase()];
    if (!record || record.password !== password) {
      return { ok: false, error: 'Correo o contraseña incorrectos.' };
    }
    const u = { email, name: record.name, role: record.role, patientId: record.patientId };
    setUser(u);
    localStorage.setItem('dentalxd_user', JSON.stringify(u));
    return { ok: true };
  }

  // Demo-account switcher: no password prompt since these are the same
  // fixed, publicly-shown demo credentials already printed on the login
  // screen — this is a convenience for demoing, not a real auth boundary.
  function switchDemoUser(email) {
    const record = USERS[email.toLowerCase()];
    if (!record) return { ok: false, error: 'Cuenta demo desconocida.' };
    const u = { email, name: record.name, role: record.role, patientId: record.patientId };
    setUser(u);
    localStorage.setItem('dentalxd_user', JSON.stringify(u));
    return { ok: true };
  }

  function logout() {
    setUser(null);
    localStorage.removeItem('dentalxd_user');
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, switchDemoUser, demoAccounts: USERS }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
