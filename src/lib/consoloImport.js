// Minimal RFC4180-ish CSV parser -- handles quoted fields, including commas
// and escaped "" quotes inside them, which Consolo's export uses throughout
// (e.g. "Maricopa, AZ", "Krishnan, Sendhil", diagnosis descriptions with
// commas). Good enough for this one import use case; not a general-purpose
// CSV library. Kept in sync with the same file in the dashboard repo --
// these are separate codebases with no shared package, so this is a
// deliberate duplicate, not drift.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

function toIsoDate(raw) {
  const m = (raw || '').trim().match(US_DATE_RE)
  if (!m) return null
  const [, mo, day, yr] = m
  return `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`
}

// Maps a parsed Consolo "Active Patient Summary" export (one row per
// patient) to the fields this app's `patients` table tracks. Looks columns
// up BY NAME, not position, so it keeps working if Consolo reorders or adds
// columns to the export -- only the exact header text matters.
export function mapConsoloRows(rows) {
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.trim())
  const idx = (name) => header.indexOf(name)

  const iName = idx('Patient Name')
  const iMrn = idx('M.R.N.')
  const iAdmit = idx('Admission Date')
  const iDischarge = idx('Discharge Date')
  const iDx = idx('Diagnosis')
  const iBp = idx('Benefit Period')

  if (iName === -1 || iMrn === -1) {
    throw new Error(
      'This doesn\'t look like a Consolo Active Patient Summary export -- missing a "Patient Name" or "M.R.N." column.'
    )
  }

  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const bpRaw = iBp !== -1 ? (r[iBp] ?? '').trim() : ''
      const dischargeDate = iDischarge !== -1 ? (r[iDischarge] ?? '').trim() : ''
      return {
        full_name: (r[iName] ?? '').trim(),
        mrn: (r[iMrn] ?? '').trim(),
        primary_diagnosis: iDx !== -1 ? (r[iDx] ?? '').trim() || null : null,
        admission_date: iAdmit !== -1 ? toIsoDate(r[iAdmit]) : null,
        current_bp_number: /^\d+$/.test(bpRaw) ? Number(bpRaw) : null,
        // Export has no explicit active/discharged flag -- a populated
        // Discharge Date is the signal Consolo itself uses for that.
        status: dischargeDate ? 'discharged' : 'active',
      }
    })
    .filter((p) => p.full_name && p.mrn)
}
