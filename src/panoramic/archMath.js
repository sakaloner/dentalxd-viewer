// Live panoramic (curved MPR) math — JS port of make_panoramic.py.
// Works in the volume's index (IJK) space; callers convert to world coords
// via volume.imageData.indexToWorld / worldToIndex.

// Approximate percentile by sorting a strided sample of the array.
function percentileSampled(arr, frac, maxSamples = 400000) {
  const stride = Math.max(1, Math.floor(arr.length / maxSamples))
  const n = Math.floor(arr.length / stride)
  const vals = new Float32Array(n)
  for (let i = 0; i < n; i++) vals[i] = arr[i * stride]
  vals.sort()
  return vals[Math.min(n - 1, Math.floor(frac * (n - 1)))]
}

// v4 streaming volumes keep voxels per-image; getScalarData() THROWS on them.
// getCompleteScalarDataArray() assembles the full volume — cache it, since it
// allocates a fresh (huge) array on every call and we sample on every drag.
const scalarCache = new WeakMap()
export function getScalars(vol) {
  if (scalarCache.has(vol)) return scalarCache.get(vol)
  let data
  try { data = vol.voxelManager?.getCompleteScalarDataArray?.() ?? null } catch { data = null }
  if (!data) {
    try { data = vol.getScalarData?.() ?? vol.voxelManager?.getScalarData?.() ?? null } catch { data = null }
  }
  if (data && data.length) scalarCache.set(vol, data)
  return data
}

// Auto-trace the dental arch: densest z-band (enamel) → axial MIP →
// parabola fit → N control points in index space. Returns
// { points: [[i,j],...], z: bandCenterSlice } or null if the fit fails.
export function autoFitArch(vol, nCtrl = 7) {
  const scalars = getScalars(vol)
  if (!scalars || !scalars.length) return null
  const [nx, ny, nz] = vol.dimensions
  const sliceLen = nx * ny

  const hi = percentileSampled(scalars, 0.997)

  // per-z count of very dense voxels (subsampled), smoothed, peak = teeth
  const perZ = new Float32Array(nz)
  for (let z = 0; z < nz; z++) {
    const base = z * sliceLen
    let c = 0
    for (let i = 0; i < sliceLen; i += 3) if (scalars[base + i] > hi) c++
    perZ[z] = c
  }
  let zpk = 0, best = -1
  for (let z = 0; z < nz; z++) {
    let s = 0, n = 0
    for (let k = -2; k <= 2; k++) { const zz = z + k; if (zz >= 0 && zz < nz) { s += perZ[zz]; n++ } }
    if (s / n > best) { best = s / n; zpk = z }
  }
  const spacingZ = vol.spacing?.[2] || 0.3
  const half = Math.min(60, Math.max(10, Math.round(13.5 / spacingZ)))
  const zlo = Math.max(0, zpk - half), zhi = Math.min(nz, zpk + half)

  // axial MIP of the tooth band
  const mip = new Float32Array(sliceLen)
  for (let z = zlo; z < zhi; z++) {
    const base = z * sliceLen
    for (let i = 0; i < sliceLen; i++) { const v = scalars[base + i]; if (v > mip[i]) mip[i] = v }
  }

  // threshold at the 97th percentile of nonzero MIP values
  let nnz = 0
  for (let i = 0; i < sliceLen; i++) if (mip[i] > 0) nnz++
  if (nnz < 100) return null
  const nzv = new Float32Array(nnz)
  for (let i = 0, k = 0; i < sliceLen; i++) if (mip[i] > 0) nzv[k++] = mip[i]
  nzv.sort()
  const maxV = nzv[nnz - 1]

  // Least-squares parabola j = a*i^2 + b*i + c over the dense footprint,
  // fit robustly: an initial pass over every dense pixel, then one
  // outlier-rejection refit (drop points whose residual is far from the
  // median — e.g. a metal filling/implant streak, or a contralateral
  // condyle, that isn't actually part of the arch — and solve again on the
  // survivors) so a single off-arch dense cluster can't skew the whole curve.
  //
  // The threshold can't be a fixed percentile. A metal-heavy mouth (amalgams,
  // crowns, posts) pegs those voxels at the detector ceiling, and a MIP across
  // the whole tooth band smears them over enough of the slice that the 97th
  // percentile IS the ceiling — no pixel can then exceed it, the footprint
  // comes back empty, and this function returns null. The caller treats that
  // as "no arch found" and silently falls back to defaultArch()'s generic U at
  // the middle of the volume, which on a dental CBCT sits up in the sinuses:
  // the panoramic is then reconstructed through the mid-face instead of the
  // jaw. Walk the percentile down until the dense footprint is usable, and
  // skip any level that lands on the ceiling.
  const Is = [], Js = []
  for (const frac of [0.97, 0.95, 0.92, 0.88, 0.82, 0.75, 0.6]) {
    const t = nzv[Math.floor(frac * (nnz - 1))]
    if (t >= maxV) continue
    Is.length = 0; Js.length = 0
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (mip[j * nx + i] > t) { Is.push(i); Js.push(j) }
      }
    }
    if (Is.length >= 200) break
  }
  if (Is.length < 50) return null

  const fitParabola = (idx) => {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0
    for (const p of idx) {
      const i = Is[p], j = Js[p], i2 = i * i
      s0++; s1 += i; s2 += i2; s3 += i2 * i; s4 += i2 * i2
      t0 += j; t1 += i * j; t2 += i2 * j
    }
    // solve 3x3 normal equations [s4 s3 s2; s3 s2 s1; s2 s1 s0] [a b c] = [t2 t1 t0]
    const m = [[s4, s3, s2, t2], [s3, s2, s1, t1], [s2, s1, s0, t0]]
    for (let col = 0; col < 3; col++) {
      let piv = col
      for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
      ;[m[col], m[piv]] = [m[piv], m[col]]
      if (Math.abs(m[col][col]) < 1e-9) return null
      for (let r = 0; r < 3; r++) {
        if (r === col) continue
        const f = m[r][col] / m[col][col]
        for (let cc = col; cc < 4; cc++) m[r][cc] -= f * m[col][cc]
      }
    }
    return { a: m[0][3] / m[0][0], b: m[1][3] / m[1][1], c: m[2][3] / m[2][2] }
  }
  const percentileOf = (sorted, frac) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(frac * (sorted.length - 1))))]

  let idx = Is.map((_, k) => k)
  let fit = fitParabola(idx)
  if (!fit) return null

  const residuals = idx.map(p => {
    const i = Is[p]
    return Math.abs(Js[p] - (fit.a * i * i + fit.b * i + fit.c))
  })
  const sortedRes = [...residuals].sort((x, y) => x - y)
  const median = percentileOf(sortedRes, 0.5)
  const mad = percentileOf([...residuals].map(r => Math.abs(r - median)).sort((x, y) => x - y), 0.5) || 1
  const cutoff = median + 3 * 1.4826 * mad // 1.4826 scales MAD to a normal-equivalent std
  const inliers = idx.filter((_, k) => residuals[k] <= cutoff)
  if (inliers.length >= 50) {
    const refit = fitParabola(inliers)
    if (refit) { fit = refit; idx = inliers }
  }

  // Percentile-trimmed footprint bounds (1st/99th of the surviving inliers)
  // instead of raw min/max — one stray dense voxel shouldn't stretch the
  // control-point spread all the way out to it.
  const sortedI = idx.map(p => Is[p]).sort((x, y) => x - y)
  if (sortedI.length < 50) return null
  const imin = percentileOf(sortedI, 0.01), imax = percentileOf(sortedI, 0.99)
  if (imax - imin < nx * 0.15) return null

  // The dense-footprint bounds above only cover enamel (teeth), so the curve
  // stops at the last molar. Real i-CAT panoramics curve further back into
  // the ramus/bone, which is far less dense and never passes the enamel
  // threshold above — extend past imin/imax so the endpoints reach back
  // toward the bone, no new density data needed. Continuing the fitted
  // quadratic itself out there is unstable — a parabola's curvature
  // compounds fast outside the domain it was fit on, so a small coefficient
  // error becomes a wild, asymmetric swing at the tips (confirmed visually —
  // one endpoint shot off into open space). Extend along the tangent line at
  // each boundary instead: same starting direction, no compounding curvature.
  const { a, b, c } = fit
  const jAt = (i) => a * i * i + b * i + c
  const slopeAt = (i) => 2 * a * i + b
  const archJ = (i) => {
    if (i < imin) return jAt(imin) + slopeAt(imin) * (i - imin)
    if (i > imax) return jAt(imax) + slopeAt(imax) * (i - imax)
    return jAt(i)
  }
  const span = imax - imin
  const margin = span * 0.15
  const iminExt = Math.max(0, imin - margin)
  const imaxExt = Math.min(nx - 1, imax + margin)

  const points = []
  for (let k = 0; k < nCtrl; k++) {
    const i = iminExt + (k / (nCtrl - 1)) * (imaxExt - iminExt)
    points.push([i, archJ(i)])
  }
  // Average position over the actual tooth-density inliers (not the
  // geometric volume center, not the extended bone-reaching tips above) —
  // used as the default Coronal (midJ) / Sagittal (midI) position: "middle
  // of the dentition" and the true dental midline, rather than assuming the
  // patient was centered in the scanner's FOV.
  const midJ = idx.reduce((s, p) => s + Js[p], 0) / idx.length
  const midI = idx.reduce((s, p) => s + Is[p], 0) / idx.length

  // zpk (single densest z-slice, whole-volume search) is not reliable enough
  // to hand out as "the" tooth z — on at least one real case it landed near
  // the cranial vault, far above any teeth, while the wider ±half MIP window
  // built around it still happened to catch enough tooth density for the
  // arch fit (and midJ/midI, both i/j-plane) to come out fine regardless.
  // zCentroid ties the z estimate to the SAME trusted (i,j) inlier points
  // instead: at each inlier's (i,j), find the z within the MIP band that
  // actually produced its peak value, then average those — anchored to real
  // tooth locations rather than a separate, independently-computed peak.
  let zSum = 0, zCount = 0
  for (const p of idx) {
    const i = Math.round(Is[p]), j = Math.round(Js[p])
    if (i < 0 || i >= nx || j < 0 || j >= ny) continue
    let bestZ = zpk, bestV = -Infinity
    for (let z = zlo; z < zhi; z++) {
      const v = scalars[z * sliceLen + j * nx + i]
      if (v > bestV) { bestV = v; bestZ = z }
    }
    zSum += bestZ; zCount++
  }
  const zCentroid = zCount ? Math.round(zSum / zCount) : zpk

  return { points, z: zCentroid, midJ, midI }
}

// Fallback when auto-fit fails: a generic U centered in the slice.
export function defaultArch(vol, nCtrl = 7) {
  const [nx, ny, nz] = vol.dimensions
  const points = []
  for (let k = 0; k < nCtrl; k++) {
    const t = k / (nCtrl - 1)
    const i = nx * (0.25 + 0.5 * t)
    const u = (t - 0.5) * 2
    points.push([i, ny * (0.55 - 0.25 * (1 - u * u))])
  }
  return { points, z: Math.floor(nz / 2) }
}

// Centripetal Catmull-Rom through the control points → dense samples with
// unit normals: { xs, ys, nxs, nys, arcLenPx }.
export function sampleCurve(ctrl, nSamples = 500) {
  const P = ctrl
  const n = P.length
  if (n < 2) return null
  const pts = []
  const get = (i) => P[Math.max(0, Math.min(n - 1, i))]
  const perSeg = Math.max(2, Math.ceil(nSamples / (n - 1)))
  for (let seg = 0; seg < n - 1; seg++) {
    const p0 = get(seg - 1), p1 = get(seg), p2 = get(seg + 1), p3 = get(seg + 2)
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t
      pts.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  pts.push([P[n - 1][0], P[n - 1][1]])

  const S = pts.length
  const xs = new Float32Array(S), ys = new Float32Array(S)
  const nxs = new Float32Array(S), nys = new Float32Array(S)
  let arcLenPx = 0
  for (let s = 0; s < S; s++) {
    xs[s] = pts[s][0]; ys[s] = pts[s][1]
    const a = pts[Math.max(0, s - 1)], bp = pts[Math.min(S - 1, s + 1)]
    let tx = bp[0] - a[0], ty = bp[1] - a[1]
    const L = Math.hypot(tx, ty) || 1
    nxs[s] = -ty / L; nys[s] = tx / L
    if (s > 0) arcLenPx += Math.hypot(pts[s][0] - pts[s - 1][0], pts[s][1] - pts[s - 1][1])
  }
  return { xs, ys, nxs, nys, arcLenPx }
}

// Curved reformation: for each curve sample, average a slab across the
// buccal-lingual normal, one output row per z slice (bilinear in-plane).
// quality: { sStride, zStride, steps }. zMin/zMax (slice indices, default =
// full volume) crop the output to a z band — same convention as
// renderCrossSection — so the skull above/below the tooth row can be left
// out of the render entirely. Returns { data, w, h } (row 0 = z = zMin).
export function renderPanoramic(vol, curve, {
  slabMm = 18, depthMm = 0, sStride = 1, zStride = 1, steps = 9, zMin = 0, zMax = null,
} = {}) {
  const scalars = getScalars(vol)
  if (!scalars) return null
  const [nx, ny, nz] = vol.dimensions
  const sliceLen = nx * ny
  const pxMm = vol.spacing?.[0] || 0.3
  const slabPx = slabMm / pxMm
  const depthPx = depthMm / pxMm

  const z0 = Math.max(0, Math.floor(zMin))
  const z1 = Math.min(nz, Math.ceil(zMax ?? nz))

  const S = Math.floor(curve.xs.length / sStride)
  const H = Math.ceil((z1 - z0) / zStride)
  const out = new Float32Array(S * H)
  if (H <= 0) return { data: out, w: S, h: 0 }

  for (let si = 0; si < S; si++) {
    const s = si * sStride
    const cx = curve.xs[s] + depthPx * curve.nxs[s]
    const cy = curve.ys[s] + depthPx * curve.nys[s]
    for (let o = 0; o < steps; o++) {
      const off = steps === 1 ? 0 : (o / (steps - 1) - 0.5) * slabPx
      const x = cx + off * curve.nxs[s]
      const y = cy + off * curve.nys[s]
      if (x < 0 || y < 0 || x >= nx - 1 || y >= ny - 1) continue
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const fx = x - x0, fy = y - y0
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy, w11 = fx * fy
      const i00 = y0 * nx + x0
      for (let zi = 0; zi < H; zi++) {
        const base = (z0 + zi * zStride) * sliceLen + i00
        out[zi * S + si] +=
          scalars[base] * w00 + scalars[base + 1] * w10 +
          scalars[base + nx] * w01 + scalars[base + nx + 1] * w11
      }
    }
  }
  const inv = 1 / steps
  for (let i = 0; i < out.length; i++) out[i] *= inv
  return { data: out, w: S, h: H }
}

// Cross-section perpendicular to the arch at fraction sFrac (0..1 of the
// curve samples): horizontal axis = buccal↔lingual along the local normal,
// vertical = z (one row per slice, like renderPanoramic — row 0 = z low, so
// panoToImageData flips it teeth-up). zMin/zMax (slice indices) crop the
// output to the tooth band; widthMm is the total buccal-lingual extent.
// Returns { data, w, h } or null.
export function renderCrossSection(vol, curve, sFrac, {
  widthMm = 30, depthMm = 0, zMin = 0, zMax = Infinity,
} = {}) {
  const scalars = getScalars(vol)
  if (!scalars || !curve) return null
  const [nx, ny, nz] = vol.dimensions
  const sliceLen = nx * ny
  const pxMm = vol.spacing?.[0] || 0.3
  const S = curve.xs.length
  const s = Math.max(0, Math.min(S - 1, Math.round(sFrac * (S - 1))))
  const halfPx = (widthMm / pxMm) / 2
  const depthPx = depthMm / pxMm
  const cx = curve.xs[s] + depthPx * curve.nxs[s]
  const cy = curve.ys[s] + depthPx * curve.nys[s]

  const z0 = Math.max(0, Math.floor(zMin))
  const z1 = Math.min(nz, Math.ceil(zMax))
  const W = Math.max(2, Math.round(2 * halfPx))
  const H = z1 - z0
  if (H <= 0) return null
  const out = new Float32Array(W * H)

  for (let ui = 0; ui < W; ui++) {
    const off = ui - halfPx
    const x = cx + off * curve.nxs[s]
    const y = cy + off * curve.nys[s]
    if (x < 0 || y < 0 || x >= nx - 1 || y >= ny - 1) continue
    const x0 = Math.floor(x), y0 = Math.floor(y)
    const fx = x - x0, fy = y - y0
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy, w11 = fx * fy
    const i00 = y0 * nx + x0
    for (let zi = 0; zi < H; zi++) {
      const base = (z0 + zi) * sliceLen + i00
      out[zi * W + ui] =
        scalars[base] * w00 + scalars[base + 1] * w10 +
        scalars[base + nx] * w01 + scalars[base + nx + 1] * w11
    }
  }
  return { data: out, w: W, h: H }
}

// Window the float panoramic to 8-bit grayscale ImageData, teeth-up
// (row 0 = highest z), with gamma 0.8 like the Python script.
export function panoToImageData(pano, gamma = 0.8) {
  const { data, w, h } = pano
  const lo = percentileSampled(data, 0.01)
  const hi = percentileSampled(data, 0.995)
  const range = hi - lo || 1
  const img = new ImageData(w, h)
  const px = img.data
  const lut = new Uint8ClampedArray(1024)
  for (let i = 0; i < 1024; i++) lut[i] = Math.pow(i / 1023, gamma) * 255
  for (let row = 0; row < h; row++) {
    const src = (h - 1 - row) * w
    let dst = row * w * 4
    for (let col = 0; col < w; col++, dst += 4) {
      let t = (data[src + col] - lo) / range
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const g = lut[(t * 1023) | 0]
      px[dst] = g; px[dst + 1] = g; px[dst + 2] = g; px[dst + 3] = 255
    }
  }
  return img
}

// Trilinear sample at continuous IJK coords; 0 outside the volume bounds
// (same convention as the bilinear samplers above — reject rather than clamp).
function sampleTrilinear(scalars, nx, ny, nz, x, y, z) {
  if (x < 0 || y < 0 || z < 0 || x >= nx - 1 || y >= ny - 1 || z >= nz - 1) return 0
  const sliceLen = nx * ny
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
  const fx = x - x0, fy = y - y0, fz = z - z0
  const i000 = z0 * sliceLen + y0 * nx + x0
  const i100 = i000 + 1
  const i010 = i000 + nx
  const i110 = i010 + 1
  const i001 = i000 + sliceLen
  const i101 = i001 + 1
  const i011 = i001 + nx
  const i111 = i011 + 1
  const c00 = scalars[i000] * (1 - fx) + scalars[i100] * fx
  const c10 = scalars[i010] * (1 - fx) + scalars[i110] * fx
  const c01 = scalars[i001] * (1 - fx) + scalars[i101] * fx
  const c11 = scalars[i011] * (1 - fx) + scalars[i111] * fx
  const c0 = c00 * (1 - fy) + c10 * fy
  const c1 = c01 * (1 - fy) + c11 * fy
  return c0 * (1 - fz) + c1 * fz
}

// i-CAT "Line" tool: oblique reformat along a line traced on one of the three
// orthogonal MPR views. p0/p1 are IJK-space endpoints (index coords, from
// e.g. vol.imageData.worldToIndex) of the drawn line; depthAxis is that
// view's own through-plane axis — 'z' for a line drawn on Axial, 'x' for
// Sagittal, 'y' for Coronal. The output plane contains the line and sweeps
// the FULL extent of the volume along depthAxis (row/col 0 = index 0 on that
// axis): horizontal = arc length along the line, vertical = depthAxis. This
// is the same "draw a line, get a reformatted slice" tool i-CAT Vision has —
// not derived from the arch, works from any two points on any of the 3 views.
// Returns { data, w, h } or null.
export function renderLineSlice(vol, p0, p1, depthAxis) {
  const scalars = getScalars(vol)
  if (!scalars) return null
  const [nx, ny, nz] = vol.dimensions
  const dims = { x: nx, y: ny, z: nz }
  const axisIdx = { x: 0, y: 1, z: 2 }[depthAxis]
  const H = dims[depthAxis]

  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2]
  const lineLen = Math.hypot(dx, dy, dz)
  const W = Math.round(lineLen)
  if (W < 2 || H < 2) return null
  const out = new Float32Array(W * H)

  const pos = [p0[0], p0[1], p0[2]]
  for (let ui = 0; ui < W; ui++) {
    const t = ui / (W - 1)
    pos[0] = p0[0] + t * dx
    pos[1] = p0[1] + t * dy
    pos[2] = p0[2] + t * dz
    for (let vi = 0; vi < H; vi++) {
      pos[axisIdx] = vi
      out[vi * W + ui] = sampleTrilinear(scalars, nx, ny, nz, pos[0], pos[1], pos[2])
    }
  }
  return { data: out, w: W, h: H }
}

// Generic float-field → 8-bit grayscale ImageData window (percentile stretch
// + gamma), no orientation flip — unlike panoToImageData this isn't
// specialized to the panoramic's teeth-up convention. Row 0 stays row 0.
export function scalarsToImageData(field, gamma = 0.9) {
  const { data, w, h } = field
  const lo = percentileSampled(data, 0.01)
  const hi = percentileSampled(data, 0.995)
  const range = hi - lo || 1
  const img = new ImageData(w, h)
  const px = img.data
  const lut = new Uint8ClampedArray(1024)
  for (let i = 0; i < 1024; i++) lut[i] = Math.pow(i / 1023, gamma) * 255
  for (let row = 0; row < h; row++) {
    let src = row * w
    let dst = row * w * 4
    for (let col = 0; col < w; col++, dst += 4, src++) {
      let t = (data[src] - lo) / range
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const g = lut[(t * 1023) | 0]
      px[dst] = g; px[dst + 1] = g; px[dst + 2] = g; px[dst + 3] = 255
    }
  }
  return img
}
