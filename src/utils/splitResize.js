// Shared math for resizable N-panel rows/columns: a row of n boxes is
// described by (n-1) cumulative boundary fractions (0..1). Dragging boundary
// i is clamped between its neighbors (with a minimum gap), so it only ever
// affects the two boxes on either side of it — the same principle as a
// standard tiling-pane splitter, generalized past the 2-box case.

export function dragBoundary(boundaries, i, frac, minGap = 0.06) {
  const lo = (i === 0 ? 0 : boundaries[i - 1]) + minGap
  const hi = (i === boundaries.length - 1 ? 1 : boundaries[i + 1]) - minGap
  const next = boundaries.slice()
  next[i] = Math.min(hi, Math.max(lo, frac))
  return next
}
