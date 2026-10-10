import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// StrictMode omitted — double-mount breaks Cornerstone3D rendering engine
createRoot(document.getElementById('root')).render(<App />)
