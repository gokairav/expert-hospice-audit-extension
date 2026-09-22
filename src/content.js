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
    // Confirmed against the real per-patient sidebar (all accordion
    // sections with an expand arrow -- click the parent, then the exposed
    // submenu item): Referral Info, Clinical Charting, Provider Charting,
    // Medication Info, Diagnostics and Devices, Administration Info,
    // Certification / Care Plans, Change in Care Info, Documents, Clinical
    // Summaries, Volunteer Info. There is no "Scheduler" in this sidebar --
    // it was removed since clicking a same-named element elsewhere on the
    // page could navigate away from the patient's chart entirely.
    //
    // Certification / Care Plans' real submenu (confirmed via screenshot)
    // is: Certifications, Bereavement Care Plans, Care Plan Problems, View
    // Current Care Plans, Upcoming Interventions, Problems & Diagnoses,
    // Procedures, DME Orders, Plan of Care, Care Programs -- there's no
    // item literally called "Clinical Indicators". That step exists to
    // capture the lcd_worksheet checklist item ("Clinical Indicators / LCD
    // worksheet ... patient-specific narrative AND comorbidities"), so
    // "Problems & Diagnoses" is the closest real match. If lcd_worksheet
    // findings keep coming back unable_to_verify, that narrative may
    // actually live inside "Certifications" itself instead.
    admission: [
      ['Referral Info', 'Personal Information'],
      ['Referral Info', 'Admission Notes'],
      ['Clinical Charting'],
      ['Medication Info'],
      ['Certification / Care Plans', 'Certifications'],
      ['Certification / Care Plans', 'Care Plan Problems'],
      ['Certification / Care Plans', 'Problems & Diagnoses'],
    ],
    // Previously revisited "Certifications" twice and clicked the bare
    // "Certification / Care Plans" parent alone (leftover from before the
    // real sidebar was confirmed) -- simplified to the same clean,
    // one-click-per-section pattern as admission, which is the version
    // that's actually been proven to work end-to-end. The bare-parent
    // click in particular is a likely cause of a "message channel closed"
    // failure if it landed somewhere unexpected.
    recert: [
      ['Certification / Care Plans', 'Certifications'],
      ['Referral Info', 'Personal Information'],
      ['Clinical Charting'],
      ['Medication Info'],
      ['Certification / Care Plans', 'Care Plan Problems'],
      ['Certification / Care Plans', 'Problems & Diagnoses'],
    ],
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // Polls `check` until it returns a truthy value or `timeout` elapses.
  // A fixed sleep-then-check-once (the previous approach) is a race against
  // however long Consolo's real backend takes to answer a search/render a
  // submenu -- the same patient succeeding on one run and failing "no
  // result found" on the next, with no code change in between, is the
  // signature of exactly that race. Polling removes the guesswork: it
  // resolves the moment the element actually appears, and only gives up
  // after a generous ceiling.
  function waitFor(check, { timeout = 6000, interval = 250 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = () => {
        const result = check()
        if (result) {
          resolve(result)
          return
        }
        if (Date.now() - start >= timeout) {
          resolve(null)
          return
        }
        setTimeout(tick, interval)
      }
      tick()
    })
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

    const result = await waitFor(() => findClickableByText(patient.full_name), { timeout: 7000, interval: 300 })
    if (!result) {
      throw new Error(
        `No search result found for "${patient.full_name}" after waiting 7s -- check the name matches Consolo exactly.`
      )
    }
    result.click()
    await sleep(2000)
  }

  // Fire-and-forget progress ping back to the side panel so a long
  // multi-section walk doesn't look frozen -- no listener being there to
  // hear it (side panel closed, etc.) is fine, so any error is swallowed.
  function reportProgress(label, index, total) {
    try {
      chrome.runtime.sendMessage({ type: 'attabot-progress', label, index, total }, () => {
        void chrome.runtime.lastError // read to silence "Unchecked runtime.lastError"
      })
    } catch (err) {
      // ignore
    }
  }

  async function navigateAndExtract(auditType) {
    const steps = NAV_STEPS[auditType]
    const sections = []
    for (let i = 0; i < steps.length; i++) {
      const path = steps[i]
      reportProgress(path.join(' > '), i + 1, steps.length)
      try {
        for (const label of path) {
          const el = await waitFor(() => findClickableByText(label), { timeout: 5000, interval: 250 })
          if (!el) throw new Error(`Could not find sidebar item "${label}" after waiting 5s`)
          el.click()
          await sleep(1000)
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
    // Lightweight liveness check -- sidepanel.js pings right after injecting
    // this script and retries injection if nothing answers, instead of
    // silently sending the real (slow) run message into the void.
    if (message.type === 'attabot-ping') {
      sendResponse({ ok: true, url: location.href, title: document.title })
      return false
    }

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
