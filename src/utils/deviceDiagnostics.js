// Reports GPU/rendering diagnostics (no IP, no name/email) so we can debug
// the "software WebGL fallback" perf issue across different machines.
// See viewer/CLAUDE.md "3D rendering performance".

import { getShouldUseCPURendering, isCornerstoneInitialized } from '@cornerstonejs/core'

function detectSoftwareRenderer(renderer) {
  if (!renderer) return null
  return /swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer)
}

function getWebglInfo() {
  const canvas = document.createElement('canvas')
  const gl2 = canvas.getContext('webgl2')
  const gl = gl2 || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')

  if (!gl) {
    return { webglRenderer: null, webglVendor: null, webgl2Supported: false, hardwareAccelerated: false }
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER)
  const vendor = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR)
  const isSoftware = detectSoftwareRenderer(renderer)

  return {
    webglRenderer: renderer ?? null,
    webglVendor: vendor ?? null,
    webgl2Supported: !!gl2,
    hardwareAccelerated: isSoftware === null ? null : !isSoftware,
  }
}

export function reportDeviceDiagnostics() {
  try {
    // Only meaningful once CornerstoneViewer has called initCornerstone() —
    // this beacon fires on app mount, which on most navigations happens
    // before that (see CornerstoneViewer.jsx). Report null rather than a
    // pre-init default so the field is honest about what it captured.
    const csReady = isCornerstoneInitialized()
    const payload = {
      ...getWebglInfo(),
      cornerstoneUsesCPURendering: csReady ? getShouldUseCPURendering() : null,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
      page: window.location.pathname,
      timestamp: new Date().toISOString(),
    }

    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    const url = `${base}/api/log`
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })

    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob)
    } else {
      fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {})
    }
  } catch {
    // diagnostics must never break the app
  }
}
