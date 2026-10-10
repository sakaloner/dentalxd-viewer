import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Home from './pages/Home'
import CaseList from './pages/CaseList'
import Viewer from './pages/Viewer'
import { reportDeviceDiagnostics } from './utils/deviceDiagnostics'
import './App.css'

export default function App() {
  useEffect(() => {
    reportDeviceDiagnostics()
  }, [])

  return (
    <AuthProvider>
      <BrowserRouter basename="/dentalxd">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/home" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/cases" element={<ProtectedRoute><CaseList /></ProtectedRoute>} />
          <Route path="/viewer/:caseId" element={<ProtectedRoute><Viewer /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
