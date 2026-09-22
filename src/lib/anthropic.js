// Calls the Claude API directly from the extension (not Claude for Chrome --
// a different product). Requires the anthropic-dangerous-direct-browser-access
// header since Anthropic's API blocks browser-origin calls by default; this
// is safe here because it's our own extension using a key the admin entered
// themselves, not an arbitrary webpage.
const MODEL = 'claude-sonnet-5'

function buildTool(checklistItems) {
  // Different items allow different status sets (e.g. some allow "flag",
  // some only pass/fail/unable_to_verify), which a flat JSON Schema can't
  // express per-item -- constraining `status` to the UNION of every valid
  // value at least stops Claude from inventing a status that's not valid
  // anywhere. The per-item validation below (validateItems) is what catches
  // a status that's valid for some OTHER item but not this one.
  const allStatuses = [...new Set(checklistItems.flatMap((i) => i.status_options))]
  return {
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
              status: { type: 'string', enum: allStatuses },
              finding: { type: 'string', description: 'Short, specific finding citing what was actually found' },
            },
            required: ['item_key', 'status', 'finding'],
          },
        },
      },
      required: ['items'],
    },
  }
}

function buildPrompt({ auditType, checklistItems, sections, patient }) {
  const sectionsText = sections
    .map((s) => `--- ${s.label} ---\n${s.text.slice(0, 6000)}`)
    .join('\n\n')

  const itemsText = checklistItems
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((i) => `- ${i.item_key}: ${i.title} -- ${i.guidance_text} (valid statuses: ${i.status_options.join('|')})`)
    .join('\n')

  return `You are a hospice documentation auditor for Expert Hospice, a physician-led ACHC-accredited hospice in Maricopa County, Arizona.

Below is the extracted, visible text of a Consolo/WellSky patient record for ${patient.full_name} (MRN ${patient.mrn || 'unknown'}), captured section by section by an automated navigation agent (not a human) -- read it exactly as you would a chart, and be skeptical of anything that looks like navigation chrome, menus, or unrelated boilerplate rather than real clinical content.

${sectionsText}

## WHAT TO AUDIT (audit_type: ${auditType})
Evaluate each item below using EXACTLY one of its listed status values -- each item has its OWN allowed set, and using a status from a different item's list (e.g. "flag" for an item whose valid statuses are only pass/fail/unable_to_verify) is invalid. Call submit_audit_findings with one entry per item_key -- every item_key below must appear exactly once in your response.

${itemsText}

If a section's content looks like navigation failed (e.g. "[navigation failed...]") or is clearly not the right content, mark that item "unable_to_verify" (or "n_a" if that's a valid option for it) rather than guessing.`
}

// Returns a list of {item_key, status, validStatuses} for any item whose
// reported status isn't actually in THAT item's own status_options -- the
// tool schema's enum only constrains against the union of every item's
// valid values, so a status valid for a different item still slips through.
function validateItems(items, checklistItems) {
  const byKey = new Map(checklistItems.map((i) => [i.item_key, i]))
  const problems = []
  for (const entry of items) {
    const ci = byKey.get(entry.item_key)
    if (!ci) continue
    if (!ci.status_options.includes(entry.status)) {
      problems.push({ item_key: entry.item_key, status: entry.status, validStatuses: ci.status_options })
    }
  }
  return problems
}

async function callClaude(apiKey, body) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}))
    throw new Error(errBody?.error?.message || `Claude API request failed (${resp.status})`)
  }
  return resp.json()
}

export async function analyzeChart({ apiKey, auditType, checklistItems, sections, patient }) {
  const tool = buildTool(checklistItems)
  const prompt = buildPrompt({ auditType, checklistItems, sections, patient })
  const baseRequest = {
    model: MODEL,
    max_tokens: 4096,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'submit_audit_findings' },
  }

  const messages = [{ role: 'user', content: prompt }]
  const first = await callClaude(apiKey, { ...baseRequest, messages })
  const firstToolUse = first.content.find((b) => b.type === 'tool_use')
  if (!firstToolUse) throw new Error('Claude did not return structured findings (no tool_use block)')

  let problems = validateItems(firstToolUse.input.items, checklistItems)
  if (!problems.length) return firstToolUse.input.items

  // One corrective round-trip: tell Claude exactly which item_keys it got
  // wrong and what their real valid statuses are, and have it resubmit the
  // full set rather than failing the whole patient over one bad status.
  const correction = problems
    .map((p) => `- ${p.item_key}: you used "${p.status}", but the only valid statuses for this item are ${p.validStatuses.join('|')}`)
    .join('\n')
  const retryMessages = [
    ...messages,
    { role: 'assistant', content: first.content },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: firstToolUse.id,
          is_error: true,
          content: `Some statuses were invalid for their item:\n${correction}\n\nCall submit_audit_findings again with the full corrected set of items (all item_keys, not just the fixed ones).`,
        },
      ],
    },
  ]
  const second = await callClaude(apiKey, { ...baseRequest, messages: retryMessages })
  const secondToolUse = second.content.find((b) => b.type === 'tool_use')
  if (!secondToolUse) throw new Error('Claude did not return structured findings on retry (no tool_use block)')

  problems = validateItems(secondToolUse.input.items, checklistItems)
  if (problems.length) {
    const detail = problems.map((p) => `${p.item_key}="${p.status}" (valid: ${p.validStatuses.join('|')})`).join(', ')
    throw new Error(`Claude returned invalid statuses even after correction: ${detail}`)
  }
  return secondToolUse.input.items
}
