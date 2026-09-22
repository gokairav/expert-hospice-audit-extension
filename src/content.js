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

  // Consolo has (at least) two separate patient-search UIs, and the modern
  // Angular Material autocomplete inside a patient's own chart isn't
  // reliably present on every page -- that's the real cause of the
  // intermittent "no search box found" failures. "Main" (top nav, present
  // on every page including chart pages) is a reliable way to always land
  // back on the legacy "Your Assigned Patients" dashboard first, which has
  // its own always-the-same Quick Filter box (confirmed from the real DOM:
  // AngularJS, id="quickFilter", placeholder/aria-label "Quick Filter").
  // Typing there live-filters to a clickable result card per match.
  function findQuickFilterBox() {
    return (
      document.querySelector('#quickFilter') ||
      document.querySelector('input[placeholder="Quick Filter" i]') ||
      document.querySelector('input[aria-label="Quick Filter" i]')
    )
  }

  async function searchAndSelectPatient(patient) {
    // "Main" is a dropdown trigger, not a direct link -- confirmed via
    // screenshot: clicking it reveals Classic Dashboard / Alerts Dashboard /
    // Tasks Dashboard / Tracker, and Quick Filter only lives on Classic
    // Dashboard. The original single click on "Main" left Quick Filter
    // never appearing because that second click was missing.
    const mainLink = await waitFor(() => findClickableByText('Main'), { timeout: 5000, interval: 250 })
    if (!mainLink) throw new Error('Could not find the "Main" nav link to get to the patient dashboard.')
    mainLink.click()

    const classicDashboardLink = await waitFor(() => findClickableByText('Classic Dashboard'), {
      timeout: 3000,
      interval: 200,
    })
    if (classicDashboardLink) classicDashboardLink.click()
    // If it's not found, "Main" may have navigated directly this time (page
    // state can vary) -- fall through and let the Quick Filter wait below
    // decide whether we actually ended up in the right place.

    const box = await waitFor(() => findQuickFilterBox(), { timeout: 6000, interval: 300 })
    if (!box) {
      throw new Error(
        'Could not find the Quick Filter box on the Main dashboard after clicking "Main" -- the page structure ' +
        'may have changed.'
      )
    }
    box.focus()
    // The filter matches substrings against the full patient record, but a
    // "Last, First" query is narrower than it needs to be -- just the last
    // name (confirmed working manually) is the more reliable filter term.
    const searchTerm = patient.full_name.includes(',') ? patient.full_name.split(',')[0].trim() : patient.full_name
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(box, searchTerm)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(400) // the filter's own ng-change debounce is 300ms

    const result = await waitFor(() => findClickableByText(patient.full_name), { timeout: 7000, interval: 300 })
    if (!result) {
      throw new Error(
        `No matching patient card found for "${patient.full_name}" (filtered by "${searchTerm}") after waiting 7s ` +
        '-- check the name matches Consolo exactly.'
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

  // Polls document.body.innerText until it stops changing between two
  // consecutive reads (or times out) -- a real submission confirmed the
  // problem this fixes: every extracted section came back as only
  // navigation labels/demographic chrome with no actual clinical content,
  // because a fixed sleep(1000) was reading the page before Consolo's
  // Angular components finished fetching and rendering the real detail
  // data. Waiting for the text to settle adapts to real network/render
  // latency instead of guessing a delay.
  async function waitForStableInnerText({ timeout = 6000, interval = 400, stableRounds = 2 } = {}) {
    let last = null
    let stableCount = 0
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const current = document.body.innerText
      if (current === last) {
        stableCount++
        if (stableCount >= stableRounds) return current
      } else {
        stableCount = 0
      }
      last = current
      await sleep(interval)
    }
    return document.body.innerText
  }

  async function navigateAndExtract(auditType) {
    const steps = NAV_STEPS[auditType]
    const sections = []
    for (let i = 0; i < steps.length; i++) {
      const path = steps[i]
      reportProgress(path.join(' > '), i + 1, steps.length)
      try {
        let text = null
        for (let j = 0; j < path.length; j++) {
          const label = path[j]
          const el = await waitFor(() => findClickableByText(label), { timeout: 5000, interval: 250 })
          if (!el) throw new Error(`Could not find sidebar item "${label}" after waiting 5s`)
          el.click()
          if (j < path.length - 1) {
            // Not the final click in this path -- just an accordion parent
            // expanding to reveal the submenu item, which is CSS-fast.
            await sleep(500)
          } else {
            // The click that actually loads the content we want -- wait for
            // the page to finish changing before reading it.
            text = await waitForStableInnerText()
          }
        }
        sections.push({ label: path.join(' > '), text: text ?? document.body.innerText })
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
