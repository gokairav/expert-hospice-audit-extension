// Runs directly inside the Consolo page. Unlike a manifest-declared content
// script (which only auto-injects on a fresh page load), this file is
// explicitly (re-)injected by sidepanel.js via chrome.scripting.executeScript
// right before messaging each patient -- that way it's always present and
// bound to the CURRENT extension context, regardless of whether the Consolo
// tab was already open before the extension loaded, or the extension itself
// got reloaded mid-session (both of which otherwise cause "receiving end
// does not exist" / "message channel closed" errors).
//
// It does NOT handle login -- it assumes you're already logged into the tab
// it's running in. It only searches for a patient, clicks through the same
// sidebar sections the manual prompts already use, and reports back the
// visible text after each step.
//
// Everything is wrapped in an IIFE (no top-level const/let) so re-injecting
// this same file into the same page multiple times never throws a
// "already declared" error, and the old listener is explicitly removed
// before adding a new one so repeated injections never leave two listeners
// racing to answer the same message.
//
// Same caveat as before: I've never seen this page's real markup, so the
// selectors below are a best-effort starting point built from validated
// section labels, not a guarantee. Expect to tune findClickableByText()
// and the search-box guess in findSearchBox() against your real instance.
;(function () {
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
  // Includes mat-option/[role="option"] because Consolo's patient search is
  // an Angular Material autocomplete (confirmed from the real DOM), whose
  // dropdown results are <mat-option> custom elements, not the a/button/li
  // tags a plain HTML dropdown would use.
  function findClickableByText(text) {
    const needle = text.trim().toLowerCase()
    const candidates = [
      ...document.querySelectorAll('a, button, [role="button"], [role="option"], mat-option, li, span, div'),
    ]
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

  // Consolo's patient search is an Angular Material autocomplete
  // (matInput + matAutocomplete trigger) -- confirmed from the real DOM,
  // which has no placeholder or aria-label, and its id="mat-input-N" is
  // Angular's auto-incrementing counter (not stable across pages/reloads),
  // so match on the stable class/role combo instead.
  function findSearchBox() {
    return (
      document.querySelector('input.mat-mdc-autocomplete-trigger[role="combobox"]') ||
      document.querySelector('input[matinput].mat-mdc-autocomplete-trigger') ||
      document.querySelector('input[placeholder*="search" i], input[aria-label*="search" i], input[type="search"]')
    )
  }

  // The search box shows a typeahead dropdown of matching names underneath
  // it as you type/after Enter -- findClickableByText() on the full name is
  // the right approach for that (it's just an element containing the text
  // somewhere below the box), so no separate "results panel" selector is
  // needed here.
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
    await sleep(900) // let the Material autocomplete's CDK overlay render/animate in

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

  if (window.__attabotListener) {
    try {
      chrome.runtime.onMessage.removeListener(window.__attabotListener)
    } catch (err) {
      // ignore -- old listener's context may already be dead
    }
  }

  const listener = (message, _sender, sendResponse) => {
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
  }

  window.__attabotListener = listener
  chrome.runtime.onMessage.addListener(listener)
})()
