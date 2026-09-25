// Extracts the audit findings JSON from a pasted Claude-for-Chrome report
// and validates its shape before it's ever shown or submitted.

// Chat UIs commonly render a fenced code block as a formatted box rather
// than literal text -- copying the response can silently drop the
// ```json / ``` fence markers even though the JSON content itself came
// through fine, which showed up as real user friction ("No ```json block
// found" even though the JSON was clearly right there). This scans for
// every balanced {...} object in the text (bracket-depth counting, so
// nested braces don't confuse it) and tries each one, so a missing fence
// no longer blocks parsing.
function findBalancedJsonObjects(text) {
  const candidates = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1))
          break
        }
      }
    }
  }
  return candidates
}

function isValidFindings(parsed) {
  return (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray(parsed.items) &&
    parsed.items.length > 0 &&
    parsed.items.every((item) => item && item.item_key && item.status)
  )
}

export function parseReport(rawText) {
  // Preferred path: an actual ```json fence, if it survived the copy.
  const fenced = [...rawText.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (fenced.length > 0) {
    const jsonText = fenced[fenced.length - 1][1].trim()
    let parsed
    try {
      parsed = JSON.parse(jsonText)
    } catch (err) {
      throw new Error(`The JSON block did not parse: ${err.message}`)
    }
    if (!isValidFindings(parsed)) {
      throw new Error(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed.items)
          ? 'Parsed JSON has no "items" array'
          : 'An item in the JSON is missing item_key or status'
      )
    }
    return parsed
  }

  // Fallback: no fence markers found (likely dropped by copying from a
  // rendered code block) -- find every balanced {...} object in the pasted
  // text and use the LAST one that's valid findings JSON.
  const candidates = findBalancedJsonObjects(rawText)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i])
      if (isValidFindings(parsed)) return parsed
    } catch (err) {
      // not valid JSON, or not our shape -- try the next candidate
    }
  }

  throw new Error(
    'Could not find the audit findings JSON in the pasted text. Make sure the full report -- including the ' +
    'final JSON block with an "items" array -- was copied.'
  )
}
