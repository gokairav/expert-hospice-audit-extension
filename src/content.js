// Runs directly inside the Consolo page (injected automatically once it's
// loaded, per manifest.json's content_scripts match on *.consoloservices.com).
// It does NOT handle login -- it assumes you're already logged into the tab
// it's running in. It only searches for a patient, clicks through the same
// sidebar sections the manual prompts already use, and reports back the
// visible text after each step.
//
// Same caveat as before: I've never seen this page's real markup, so the
// selectors below are a best-effort starting point built from validated
// section labels, not a guarantee. Expect to tune findClickableByText()
// and the search-box guess in findSearchBox() against your real instance.

const NAV_STEPS = {
  admission: [
    ['Referral Info', 'Personal Information'],
    ['Referral Info', 'Admission Notes'],
    ['Clinical Charting'],
    ['Medication Info'],
    ['Certification / Care Plans', 'Certifications'],
    ['Certification / Care Plans', 'Care Plan Problems'],
    ['Certification / Care Plans', 'Clinical Indicators'],
    ['Scheduler'],
  ],
  recert: [
    ['Certification / Care Plans', 'Certifications'],
    ['Referral Info', 'Personal Information'],
    ['Clinical Charting'],
    ['Medication Info'],
    ['Certification / Care Plans', 'Certifications'],
    ['Certification / Care Plans'],
    ['Certification / Care Plans', 'Care Plan Problems'],
    ['Certification / Care Plans', 'Clinical Indicators'],
    ['Scheduler'],
  ],
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Finds the smallest visible, clickable-looking element containing the
// given text -- a rough equivalent of Playwright's getByText().click().
function findClickableByText(text) {
  const needle = text.trim().toLowerCase()
  const candidates = [...document.querySelectorAll('a, button, [role="button"], li, span, div')]
  let best = null
  for (const el of candidates) {
    const own = (el.textContent || '').trim().toLowerCase()
    if (!own.includes(needle)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue // hidden
    if (!best || own.length < best.textContent.trim().length) best = el
  }
  return best
}

function findSearchBox() {
  return document.querySelector(
    'input[placeholder*="search" i], input[aria-label*="search" i], input[type="search"]'
  )
}

async function searchAndSelectPatient(patient) {
  const box = findSearchBox()
  if (!box) {
    throw new Error(
      'No patient search box found with the guessed selectors. Open devtools on this page, ' +
      'find the real search input, and tell Claude its placeholder/aria-label/id so content.js ' +
      'can be updated -- this is expected to need one round of tuning.'
    )
  }
  box.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(box, patient.mrn || patient.full_name)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(300)
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  await sleep(1500)

  const result = findClickableByText(patient.full_name)
  if (!result) {
    throw new Error(`No search result found for "${patient.full_name}" -- check the name matches Consolo exactly.`)
  }
  result.click()
  await sleep(2000)
}

async function navigateAndExtract(auditType) {
  const steps = NAV_STEPS[auditType]
  const sections = []
  for (const path of steps) {
    try {
      for (const label of path) {
        const el = findClickableByText(label)
        if (!el) throw new Error(`Could not find sidebar item "${label}"`)
        el.click()
        await sleep(1200)
      }
      sections.push({ label: path.join(' > '), text: document.body.innerText })
    } catch (err) {
      sections.push({ label: path.join(' > '), text: `[navigation failed: ${err.message}]` })
    }
  }
  return sections
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'attabot-run-patient') return false

  ;(async () => {
    try {
      await searchAndSelectPatient(message.patient)
      const sections = await navigateAndExtract(message.auditType)
      sendResponse({ ok: true, sections })
    } catch (err) {
      sendResponse({ ok: false, error: err.message })
    }
  })()

  return true // keep the message channel open for the async response
})
