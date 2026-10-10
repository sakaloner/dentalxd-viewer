// Synthetic demo records: no real patients. Put your own DICOM slices under
// public/dicom/<dicomDir>/slice_0000.dcm … slice_NNNN.dcm (see README) and set
// `sliceCount` to match.
export const CASES = [
  {
    id: 'case1',
    patientId: 'DXD-001',
    patientName: 'Demo, Paciente Uno',
    dob: '1970-01-01',
    studyDate: '2024-01-15',
    machine: 'Demo CBCT scanner',
    fov: '16 × 12 cm',
    sliceCount: 325,
    dicomDir: 'demo_case_1',
    study: 'Full arch',
    referring: 'Dr. Demo',
    institution: 'Demo Clinic',
    status: 'reviewed',
  },
  {
    id: 'case2',
    patientId: 'DXD-002',
    patientName: 'Demo, Paciente Dos',
    dob: '1980-01-01',
    studyDate: '2024-02-20',
    machine: 'Demo CBCT scanner',
    fov: '17 × 11 cm',
    sliceCount: 400,
    dicomDir: 'demo_case_2',
    study: 'Implant planning — upper arch',
    referring: 'Dr. Demo',
    institution: 'Demo Clinic',
    status: 'new',
  },
];

// URL of the precomputed panoramic reconstruction for a case, or null.
// Co-located with the case DICOM: /dicom/<dir>/panoramic.png
export function getPanoramicUrl(caseData) {
  if (!caseData.hasPanoramic) return null;
  const base = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/dicom/${caseData.dicomDir}/panoramic.png`;
}

export function getImageIds(caseData, step = 1) {
  const base = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
  return Array.from({ length: caseData.sliceCount }, (_, i) => i)
    .filter(i => i % step === 0)
    .map(i => {
      const pad = String(i).padStart(4, '0');
      return `wadouri:${base}/dicom/${caseData.dicomDir}/slice_${pad}.dcm`;
    });
}
