# DentalXD — Viewer Layout & Build Plan

Spec for the agent building the viewer. This describes **what to build and in what order**, plus the reasoning behind each decision so you can make good calls on the details. Geometry/math is intentionally left to you — this is the product spec, not the algorithm.

Stack context: Orthanc + OHIF, cornerstone3D / vtk.js, React frontend at `localhost:5173/dentalxd`.

---

## Core concept: three "rooms", one shared state

The viewer is not a single fixed grid. It has **three layouts ("rooms") the user switches between with a top toolbar**: `Reading · Implant · Patient`. Each room is a different arrangement of viewports serving a different job. Default users are a mix of technical and non-technical, so the rule throughout: **simple default, power one click away.**

All three rooms read from **one shared viewer state** (current scan, crosshair position, arch curve, window/level, placed implants, traced nerve). Switching rooms only changes layout, never the underlying data or the crosshair position.

---

## The spine: linked crosshair (build/verify this FIRST)

Every panel shows the same point in the patient's anatomy. Clicking or dragging the crosshair in **any** panel moves it in **all** panels simultaneously. This is the single most important thing in the app — if it's rock-solid the viewer feels professional; if panels lag or drift out of sync, nothing else matters.

- One source of truth for the crosshair's 3D position in patient/world coordinates.
- Every viewport projects that world point into its own plane.
- Interaction in any viewport updates the shared world point, which re-renders the others.
- Must stay smooth (target 60fps feel) while dragging.

Do not proceed to the rooms until this is bulletproof on the existing axial/sagittal/coronal panels.

---

## The dependency chain (this dictates build order)

The features unlock each other in a fixed sequence. Building out of order will block you:

```
Arch curve  →  Cross-sections  →  Panoramic (comes free)  →  Implant placement  →  Nerve trace + distance readout
```

1. **Arch curve** — the user traces the U-shape of the dental arch on the axial view (a spline with draggable control points, like Blue Sky's yellow arch). Nothing dental works until this exists, because the arch is what defines where cross-sections are cut.
2. **Cross-sections** — thin slices cut *perpendicular* to the arch curve. This is the core clinical view (bone width/height at a given point). Depends entirely on the arch.
3. **Panoramic** — the volume "unrolled" flat along the arch curve. This is essentially free once the arch exists; it's the same curve sampled *along* instead of *across*.
4. **Implant placement** — drop a sized cylinder into the cross-section + panoramic, position it, read its dimensions.
5. **Nerve trace + distance** — see the Nerve section below. This is what turns the app from a *viewer* into a *planning tool*.

---

## Room 1 — "Reading" (default, opens first)

A 4-panel grid, but with **dental-appropriate panels**, not the generic radiologist grid. This single swap is what makes DentalXD read as a *dental* tool instead of a generic DICOM viewer.

```
┌───────────────────────┬───────────────────────┐
│  PANORAMIC (wide)     │  CROSS-SECTION        │
│  jaw unrolled flat    │  bagel-slice at       │
│                       │  crosshair            │
├───────────────────────┼───────────────────────┤
│  AXIAL                │  3D                   │
│  (trace/move arch     │  orientation +        │
│   here)               │  patient wow          │
└───────────────────────┴───────────────────────┘
```

- Panoramic top-left (wide-ish), cross-section top-right, axial bottom-left, 3D bottom-right.
- Axial is where the arch is traced and where the user moves the crosshair along the jaw.
- 3D here is for orientation only — keep it **neutral**: matte grey/bone-white material, **not** the current gold/tan (gold reads as "melted cheese"; grey reads as "medical").
- Before the arch is traced, the panoramic and cross-section panels can show a "trace the arch to enable" prompt, or fall back to sagittal/coronal.

---

## Room 2 — "Implant" (one click)

The decision-making room. **No 3D here** — when placing a screw the user looks at slices and the panoramic; 3D just wastes space.

```
┌───────────────┬───────────────────────────────┐
│  CROSS-SECTION│   ADJACENT SLICES (strip)      │
│  STRIP        │   ┌─────────────────────────┐  │
│  ┌─┐ ┌─┐ ┌─┐  │   │  LARGE CROSS-SECTION    │  │
│  │ │ │●│ │ │  │   │  (the implant site)     │  │
│  └─┘ └─┘ └─┘  │   │  place screw here       │  │
│  -1mm 0 +1mm  │   └─────────────────────────┘  │
├───────────────┴───────────────────────────────┤
│  PANORAMIC (context) + AXIAL (where on arch)   │
└────────────────────────────────────────────────┘
```

- **One large cross-section** in the middle — where the implant gets placed.
- **A strip of 3 adjacent cross-sections** (e.g. slightly in front / at site / slightly behind). Bone shape changes fast along the jaw, so seeing neighbors at a glance prevents a "looked fine on one slice, was actually too narrow" mistake. (Client wants the 3-slice strip — keep it.)
- **Panoramic** for context (where am I along the jaw).
- **Axial** to move the site along the arch.
- Implant = a sized cylinder the user drops and positions, with its dimensions shown (length × diameter).

---

## Room 3 — "Patient" (one click)

Show-and-tell. Turn the screen to the patient and say "here's your tooth."

```
┌────────────────────────────────────────────────┐
│                                                │
│                                                │
│              3D  (big, centered)               │
│          large friendly controls               │
│          fullscreen-friendly                    │
│                                                │
│                                                │
└────────────────────────────────────────────────┘
```

- **3D big and centered.** Slices hidden or tiny.
- Big, obvious rotate/zoom controls (the non-technical dentist lives here).
- Fullscreen toggle.
- This is the **only** room where investing in nicer 3D rendering pays off later (transfer-function / volume rendering). Not a priority now — neutral matte material is enough to start.

---

## Rotation performance (the "3D feels heavy" fix)

Current 3D is slow because it surface-extracts a large mesh in the browser on every interaction. Standard fix:

- **Downsample while dragging, restore full quality on release.** Drop the sample rate / mesh resolution during active rotation, snap back to full detail when the mouse goes up. This alone makes even a big volume feel buttery, without changing render quality of the final image.

## 3D appearance (cheap quality win)

- Change the material from gold/tan to **matte grey or bone-white.** Same underlying surface extraction, reads dramatically more "clinical." Do this before any deeper rendering work.

---

## Nerve tracing (what makes it a *planning* tool, not a viewer)

Why it matters: the inferior alveolar nerve runs through a canal in the **lower jaw (mandible)**. Drilling into it causes permanent numb lip/chin — the #1 malpractice fear in implant dentistry. On a cross-section the canal is a small dark circle the screw must avoid.

**Build the manual version. Do NOT build auto-detection.**

- **Manual trace:** user clicks a few points along the visible dark canal on the **panoramic** view. You interpolate a line through those points.
- **Show it on slices:** that line appears as a marked dot on each cross-section it passes through.
- **Distance readout:** when an implant is placed, show the **distance from the screw tip (and body) to the nerve line.** This number is the whole point — it's what makes planning *safe*.

Auto-detecting the canal in 3D is hard and not essential — a human tracing it is fine and reliable. Skip it.

**Priority note:** nerve tracing is urgent for **lower-jaw (mandible)** implants. For **upper-jaw (maxilla)** the relevant risk is the sinus (a large, obvious dark space), not a hidden nerve — so the distance-to-nerve feature matters less there. Confirm with the client which jaw their dentists work on most to decide how early to build this.

---

## Recommended build sequence (summary)

1. Bulletproof the **linked crosshair** on existing panels.
2. **Arch-curve tracing** on the axial view (draggable spline).
3. **Cross-section** viewport (perpendicular slices along the arch).
4. **Panoramic** viewport (free from the arch).
5. Reassemble panels into **Room 1 (Reading)** with the dental grid.
6. **3D cleanup:** matte grey material + downsample-on-drag.
7. **Room 3 (Patient):** big 3D + friendly controls.
8. **Implant placement** (sized cylinder).
9. **Room 2 (Implant):** large cross-section + 3-slice strip + panoramic + axial.
10. **Manual nerve trace + distance-to-nerve readout.**

Rooms 1 and 3 can ship before implant/nerve work — they make the viewer usable and dental-feeling. Rooms 2 + nerve are the "planning tool" tier and depend on the arch/cross-section foundation being solid.

---

## Open questions to confirm with the client

- Which jaw do their dentists mostly place implants in — **mandible** (nerve tracing urgent) or **maxilla** (sinus, less urgent)? Decides how early step 10 matters.
- Do they need to plan **multiple implants per case** at once? If yes, the 3-slice strip may later grow into "slabs at several named tooth positions" (the Blue Sky 15/19/23mm pattern).
- Is a saved **report/export** (screenshots + measurements + implant list) needed for referrals? Not in this spec yet; likely a later room.
