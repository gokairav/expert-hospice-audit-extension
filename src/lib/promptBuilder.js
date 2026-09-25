// Builds the exact Claude-for-Chrome prompt for an audit, from the live
// checklist_items fetched from Supabase (so a rubric edit in the dashboard's
// Admin page shows up here automatically, no extension update needed).

// Confirmed against the real app (not guesses): the left sidebar
// (Referral Info, Clinical Charting, Medication Info, Certification / Care
// Plans, etc.) only shows up on the patient's own "General Patient
// Details" home page. Clicking into "Certifications", "Care Plan
// Problems", or "Problems & Diagnoses" navigates AWAY from that sidebar
// entirely to a separate page -- you have to click the patient's name in
// the breadcrumb (or "Patient Home") to get back to the sidebar before the
// next section. There is no item literally called "Scheduler" or "Clinical
// Indicators" in this app -- "Problems & Diagnoses" is the closest real
// match for the old "Clinical Indicators / LCD worksheet" language.
// "Clinical Charting" and "Medication Info" are themselves menus, not
// single content pages -- use "Smoking Status" / "Hospice Aide Manager"
// and "Medication Record" respectively.
const NAV_STEPS = {
  admission: [
    'Click "Referral Info" to expand -> click "Personal Information" -> read content',
    'Stay in "Referral Info" -> click "Admission Notes" -> read content',
    'Click "Clinical Charting" to expand -> click "Smoking Status" -> read',
    'Back on the patient home page, click "Clinical Charting" -> click "Hospice Aide Manager" -> read for initial aide tasks',
    'Back on the patient home page, click "Medication Info" to expand -> click "Medication Record" -> read allergies and the medication list including entry dates',
    'Back on the patient home page, click "Certification / Care Plans" to expand -> click "Certifications" -> find the Verbal Certification section and completion date',
    'Return to the patient home page (click their name in the breadcrumb) -> click "Certification / Care Plans" -> click "Care Plan Problems" -> read the list',
    'Return to the patient home page -> click "Certification / Care Plans" -> click "Problems & Diagnoses" -> read for a patient-specific narrative and comorbidities (this is what "LCD worksheet" below refers to)',
    'Look for the admission assessment visit and its date, wherever it appears (Clinical Charting or a visit/scheduling section)',
  ],
  recert: [
    'Click "Certification / Care Plans" to expand -> click "Certifications" -> determine the benefit period being certified (number, start/end dates) and the date this recert was signed',
    'Return to the patient home page (click their name in the breadcrumb) -> click "Referral Info" -> "Personal Information" -> confirm race, marital status, Disaster Acuity are current',
    'Return to the patient home page -> click "Clinical Charting" -> click "Smoking Status" -> read',
    'Back on the patient home page, click "Clinical Charting" -> click "Hospice Aide Manager" -> read for plan updates',
    'Return to the patient home page -> click "Medication Info" -> click "Medication Record" -> read allergies and current medications, check for a reconciliation entry near the recert date',
    'On the "Certifications" page (step 1), also look for the written certification narrative, signature date, and -- if this is benefit period 3 or later -- the Face-to-Face Encounter note/attestation (visit date, who performed it, narrative)',
    'Return to the patient home page -> click "Certification / Care Plans" -> click "Care Plan Problems" -> review for updates since the last period, not just presence',
    'Return to the patient home page -> click "Certification / Care Plans" -> click "Problems & Diagnoses" -> read for a patient-specific narrative and comorbidities for THIS period (this is what "LCD worksheet" below refers to)',
    'Look for the most recent IDT (interdisciplinary team) review date, wherever it appears (often near Care Plan Problems or in clinical notes)',
  ],
}

export function buildPrompt(auditType, checklistItems, patient) {
  const steps = NAV_STEPS[auditType]
  const patientLine = patient
    ? `Patient in view: ${patient.full_name} (MRN ${patient.mrn}).`
    : 'Confirm the patient name and MRN from the record.'

  const itemLines = checklistItems
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item, i) => `${i + 1}. ${item.title.toUpperCase()} -- ${item.guidance_text}`)
    .join('\n\n')

  const schema = JSON.stringify(
    {
      patient: { name: 'string', mrn: 'string', admission_date: 'YYYY-MM-DD or null' },
      audit_type: auditType,
      benefit_period_number: auditType === 'recert' ? 'number or null' : null,
      items: checklistItems
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => ({
          item_key: item.item_key,
          status: item.status_options.join('|'),
          finding: 'short specific finding text',
        })),
    },
    null,
    2
  )

  return `You are a hospice documentation auditor for Expert Hospice, a physician-led ACHC-accredited hospice in Maricopa County, Arizona.

A Consolo/WellSky patient record is open in this browser tab. ${patientLine}

## HOW TO NAVIGATE CONSOLO
Wait for content to fully render before reading. Navigate in this order:
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## WHAT TO AUDIT
Evaluate these items, using EXACTLY the status values listed for each:

${itemLines}

## OUTPUT FORMAT
First, write a normal human-readable audit report (summary, item-by-item findings, score, risk level, priority actions) exactly as you would for a QA review.

Then, as the VERY LAST thing in your response, output a fenced code block containing ONLY valid JSON matching this exact schema (no comments, no trailing text after it):

\`\`\`json
${schema}
\`\`\`

Use the item_key values exactly as given above. This JSON block is parsed by software, so it must be syntactically valid JSON and nothing else inside the fence.`
}

// Same audit, but for a whole list of patients in one continuous session --
// meant to be pasted into Claude for Chrome once, then left to work through
// the list unattended. Each patient's report+JSON is clearly delimited so
// you can copy just one patient's block at a time into this extension's
// New Audit tab (pick the patient + audit type there, paste that one
// block, review, submit) -- the extension's own parsing/scoring/submission
// is unchanged, this only replaces the "generate one prompt per patient by
// hand" step.
export function buildBatchPrompt(auditType, checklistItems, patients) {
  const steps = NAV_STEPS[auditType]

  const itemLines = checklistItems
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item, i) => `${i + 1}. ${item.title.toUpperCase()} -- ${item.guidance_text}`)
    .join('\n\n')

  const schema = JSON.stringify(
    {
      patient: { name: 'string', mrn: 'string', admission_date: 'YYYY-MM-DD or null' },
      audit_type: auditType,
      benefit_period_number: auditType === 'recert' ? 'number or null' : null,
      items: checklistItems
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => ({
          item_key: item.item_key,
          status: item.status_options.join('|'),
          finding: 'short specific finding text',
        })),
    },
    null,
    2
  )

  const patientList = patients
    .map((p, i) => `${i + 1}. ${p.full_name}${p.mrn ? ` (MRN ${p.mrn})` : ''}`)
    .join('\n')

  return `You are a hospice documentation auditor for Expert Hospice, a physician-led ACHC-accredited hospice in Maricopa County, Arizona.

You have a Consolo/WellSky browser tab open, already logged in. You're going to audit MULTIPLE patients in this one session, one after another, without stopping to ask me anything in between -- just work through the whole list and keep going.

## PATIENTS TO AUDIT (${auditType})
${patientList}

## HOW TO FIND EACH PATIENT
Click the "Patient" button in the top-right corner of the page. A "Search for Patients" box will appear -- type the patient's last name, wait a moment for a matching result to appear below the box, then click it. This works from anywhere, regardless of which patient's chart is currently open.

## HOW TO NAVIGATE EACH PATIENT'S CHART
Wait for content to fully render before reading anything -- Consolo can take a few seconds to load a section. Navigate in this order:
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## WHAT TO AUDIT (same checklist for every patient)
Evaluate these items, using EXACTLY the status values listed for each:

${itemLines}

## OUTPUT FORMAT -- FOR EACH PATIENT, IN ORDER
Before each patient's report, print this exact line on its own:
=== BEGIN PATIENT: <full name> (MRN <mrn or "unknown">) ===

Then write a normal human-readable audit report for that patient (summary, item-by-item findings, score, risk level, priority actions), exactly as you would for a QA review.

Then output a fenced code block containing ONLY valid JSON matching this exact schema (no comments, no trailing text inside the fence):

\`\`\`json
${schema}
\`\`\`

Then print this exact line on its own:
=== END PATIENT ===

Then move on to the next patient in the list and repeat, until every patient above has been audited. Use the item_key values exactly as given above in every patient's JSON block -- it's parsed by software, so it must be syntactically valid JSON and nothing else inside the fence.`
}
