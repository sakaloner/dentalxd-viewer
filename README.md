# DentalXD Viewer

A browser-based **CBCT (cone-beam CT) viewer for dentistry**. It streams DICOM studies into the browser and
gives dentists the views they actually use: linked MPR planes, a live panoramic reconstruction, cross-sections
along the dental arch, and GPU-adaptive 3D rendering. No desktop software and no CDs.

Built for a dental radiology center that was delivering studies to referring dentists on discs with a Windows-only
viewer. The goal was "open a link, see the scan."

> **Status:** working prototype used with real studies. Auth is demo-only (see [Security notes](#security-notes)).
> The UI is in Spanish.

## What it does

- **MPR + 3D** — axial / sagittal / coronal viewports with linked crosshairs (drag to reslice, rotate for oblique
  cuts), colored mm rulers, W/L, pan, zoom, measurements and a live HU readout.
- **Live panoramic** — a curved-MPR panoramic is reconstructed *in the browser* from the already-loaded volume.
  The dental arch is auto-traced and the spline can be dragged; depth and slab thickness are adjustable.
- **Implant room** — panoramic plus a strip of cross-sections perpendicular to the arch, the core view for
  bone width/height planning.
- **Adaptive 3D** — volume rendering whose quality self-calibrates to the device from measured frame times, with
  an automatic fall-back to a marching-cubes bone surface on machines without a GPU.
- **Case list + roles** — doctor / patient / admin views over a list of studies.

## Stack

React 19 · Vite · React Router · [Cornerstone3D](https://www.cornerstonejs.org/) v4 (core, tools, DICOM image
loader) · no backend (static files + DICOM served over HTTP).

## Run it

```bash
npm install
npm run dev          # http://localhost:5173/dentalxd/
```

The app is mounted under `/dentalxd/` (`vite.config.js` `base`, and the router `basename` in `src/App.jsx`).

### Provide a study

No scan data ships with the repo. Add DICOM slices as one file per slice:

```
public/dicom/<dicomDir>/slice_0000.dcm
public/dicom/<dicomDir>/slice_0001.dcm
...
```

then describe the study in `src/data/cases.js` (`dicomDir`, `sliceCount`, …). Multi-frame DICOM must be split into
per-slice files first. Any CBCT series works.

### Optional

Copy `.env.example` to `.env` to enable a link to a separate remote viewer (`VITE_REMOTE_VIEWER_URL`). When it is
unset, the link is hidden.

### Deploy

It's a static site: `npm run build` and serve `dist/` with any web server. Cornerstone's web workers need
`SharedArrayBuffer`, so send these headers (nginx example):

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

## Demo accounts

| Email | Password | Role |
|---|---|---|
| `doctor@clinic.com` | `doctor123` | doctor |
| `patient@clinic.com` | `patient123` | patient |
| `admin@clinic.com` | `admin123` | admin |

## Security notes

Authentication here is a **front-end demo only**: a hardcoded in-memory user list and a `localStorage` session.
It protects nothing. A real deployment needs server-side auth and access control in front of the DICOM files,
since medical images are personal health data.

## Engineering notes

How it works, and a few of the harder bugs (a Cornerstone init-order bug that silently degraded 3D quality on
every GPU, a vendor export that built volumes upside down, why programmatic crosshair moves must go through
`CrosshairsTool.setToolCenter()`): see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

MIT, see [LICENSE](LICENSE).

## Disclaimer

Not a medical device and not for diagnostic use. Not affiliated with or endorsed by any imaging-software vendor;
product names mentioned in the docs are used only to describe interaction conventions.
