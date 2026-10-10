// Self-calibrating quality for the 3D volume viewport (CornerstoneViewer.jsx).
// Static per-device tiers (guessing from GPU renderer strings) can't cover
// every machine; instead the caller measures actual frame time while the
// user is interacting and this module decides what to do about it — coarsen
// the ray-cast sample distance when frames are slow, sharpen it back up when
// there's headroom, and fall back to the cheap mesh-surface render mode when
// even the coarsest volume rendering can't keep a device smooth. The learned
// multiplier and fallback flag persist across sessions per browser/device.

export const MIN_MULT = 0.75 // matches the existing idle (settled) sharpness
export const MAX_MULT = 6
const COARSEN_FACTOR = 1.6
const REFINE_FACTOR = 1 / 1.15
const BAD_FRAME_MS = 40   // sub-25fps
const GOOD_FRAME_MS = 20  // 50fps+
const STREAK_TO_ACT = 2       // consecutive bad/good ticks before adjusting the multiplier
const STREAK_TO_FALLBACK = 3  // consecutive bad ticks at MAX_MULT before giving up on volume rendering

// Pure decision step: given the latest measured average frame time and the
// controller's current state, returns the next state. No DOM/timer/GPU
// access here so it can be exercised with synthetic inputs.
export function decideNextQuality({ avgFrameMs, mult, badStreak, goodStreak }) {
  if (avgFrameMs > BAD_FRAME_MS) {
    const nextBadStreak = badStreak + 1
    if (nextBadStreak < STREAK_TO_ACT) {
      return { mult, badStreak: nextBadStreak, goodStreak: 0, fallbackToMesh: false }
    }
    const nextMult = Math.min(MAX_MULT, mult * COARSEN_FACTOR)
    const pinnedAtMax = nextMult === MAX_MULT && mult === MAX_MULT
    const fallbackToMesh = pinnedAtMax && nextBadStreak >= STREAK_TO_FALLBACK
    return { mult: nextMult, badStreak: nextBadStreak, goodStreak: 0, fallbackToMesh }
  }
  if (avgFrameMs < GOOD_FRAME_MS) {
    const nextGoodStreak = goodStreak + 1
    if (nextGoodStreak < STREAK_TO_ACT) {
      return { mult, badStreak: 0, goodStreak: nextGoodStreak, fallbackToMesh: false }
    }
    const nextMult = Math.max(MIN_MULT, mult * REFINE_FACTOR)
    return { mult: nextMult, badStreak: 0, goodStreak: nextGoodStreak, fallbackToMesh: false }
  }
  return { mult, badStreak: 0, goodStreak: 0, fallbackToMesh: false }
}

const QUALITY_KEY = 'dentalxd_3d_quality'
const MESH_FALLBACK_KEY = 'dentalxd_3d_mesh_fallback'

export function getPersistedQuality() {
  const raw = Number(localStorage.getItem(QUALITY_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : null
}

export function setPersistedQuality(mult) {
  localStorage.setItem(QUALITY_KEY, String(mult))
}

export function getPersistedMeshFallback() {
  return localStorage.getItem(MESH_FALLBACK_KEY) === '1'
}

export function setPersistedMeshFallback(on) {
  localStorage.setItem(MESH_FALLBACK_KEY, on ? '1' : '0')
}
