// Calls the Claude API directly from the extension (not Claude for Chrome --
// a different product). Requires the anthropic-dangerous-direct-browser-access
// header since Anthropic's API blocks browser-origin calls by default; this
// is safe here because it's our own extension using a key the admin entered
// themselves, not an arbitrary webpage.
const MODEL = 'claude-sonnet-5'

export async function analyzeChart({ apiKey, auditType, checklistItems, sections, patient }) {
  const sectionsText = sections
    .map((s) => `--- ${s.label} ---\n${s.text.slice(0, 6000)}`)
    .join('\n\n')

  const itemsText = checklistItems
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((i) => `- ${i.item_key}: ${i.title} -- ${i.guidance_text} (valid statuses: ${i.status_options.join('|')})`)
    .join('\n')

  const tool = {
    name: 'submit_audit_findings',
    description: 'Report the audit findings for every checklist item.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_key: { type: 'string' },
              status: { type: 'string' },
              finding: { type: 'string', description: 'Short, specific finding citing what was actually found' },
            },
            required: ['item_key', 'status', 'finding'],
          },
        },
      },
      required: ['items'],
    },
  }

  const prompt = `You are a hospice documentation auditor for Expert Hospice, a physician-led ACHC-accredited hospice in Maricopa County, Arizona.

Below is the extracted, visible text of a Consolo/WellSky patient record for ${patient.full_name} (MRN ${patient.mrn || 'unknown'}), captured section by section by an automated navigation agent (not a human) -- read it exactly as you would a chart, and be skeptical of anything that looks like navigation chrome, menus, or unrelated boilerplate rather than real clinical content.

${sectionsText}

## WHAT TO AUDIT (audit_type: ${auditType})
Evaluate each item below using EXACTLY one of its listed status values, and call submit_audit_findings with one entry per item_key -- every item_key below must appear exactly once in your response.

${itemsText}

If a section's content looks like navigation failed (e.g. "[navigation failed...]") or is clearly not the right content, mark that item "unable_to_verify" (or "n_a" if that's a valid option for it) rather than guessing.`

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'submit_audit_findings' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error(body?.error?.message || `Claude API request failed (${resp.status})`)
  }

  const data = await resp.json()
  const toolUse = data.content.find((b) => b.type === 'tool_use')
  if (!toolUse) throw new Error('Claude did not return structured findings (no tool_use block)')
  return toolUse.input.items
}
