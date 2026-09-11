// Extracts the trailing ```json fenced block from a pasted Claude-for-Chrome
// report and validates its shape before it's ever shown or submitted.
export function parseReport(rawText) {
  const matches = [...rawText.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (matches.length === 0) {
    throw new Error(
      'No ```json block found at the end of the pasted text. Make sure the full report -- including the final JSON block -- was copied.'
    )
  }
  const jsonText = matches[matches.length - 1][1].trim()

  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(`The JSON block did not parse: ${err.message}`)
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('Parsed JSON is not an object')
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('Parsed JSON has no "items" array')
  }
  for (const item of parsed.items) {
    if (!item.item_key || !item.status) {
      throw new Error(`An item is missing item_key or status: ${JSON.stringify(item)}`)
    }
  }

  return parsed
}
