// Builds the exact Claude-for-Chrome prompt for an audit, from the live
// checklist_items fetched from Supabase (so a rubric edit in the dashboard's
// Admin page shows up here automatically, no extension update needed).

const NAV_STEPS = {
  admission: [
    'Click "Referral Info" to expand -> click "Personal Information" -> read content',
    'Stay in "Referral Info" -> click "Admission Notes" -> read content',
    'Click "Clinical Charting" to expand -> read smoking status, Hospice Aide Manager, and physician orders',
    'Click "Medication Info" to expand -> read allergies and medication list including entry dates',
    'Click "Certification / Care Plans" to expand -> click "Certifications" -> find the Verbal Certification section and completion date',
    'Stay in "Certification / Care Plans" -> look for the Care Plan Problems list',
    'Stay in "Certification / Care Plans" -> click "Clinical Indicators" -> read the LCD worksheet narrative',
    'Click "Scheduler" or look for the admission assessment visit and its date',
  ],
  recert: [
    'Click "Certification / Care Plans" -> "Certifications" -> determine the benefit period being certified (number, start/end dates) and the date this recert was signed',
    'Click "Referral Info" -> "Personal Information" -> confirm race, marital status, Disaster Acuity are current',
    'Click "Clinical Charting" -> read smoking status, Hospice Aide Manager plan, and continuation/renewal orders',
    'Click "Medication Info" -> read allergies and current medications, check for a reconciliation entry near the recert date',
    'Stay in "Certification / Care Plans" -> find the written certification narrative and signature date',
    'Stay in "Certification / Care Plans" -> if this is benefit period 3 or later, find the Face-to-Face Encounter note/attestation: visit date, who performed it, narrative',
    'Stay in "Certification / Care Plans" -> review Care Plan Problems for updates since the last period, not just presence',
    'Stay in "Certification / Care Plans" -> click "Clinical Indicators" -> read the LCD worksheet narrative for THIS period',
    'Click "Scheduler" or IDT notes -> find the most recent IDT review date',
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
