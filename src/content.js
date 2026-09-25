// Runs directly inside the Consolo page. Explicitly (re-)injected by
// sidepanel.js via chrome.scripting.executeScript before EVERY single
// interaction (not just once per patient) -- real evidence confirmed that
// clicking a patient search result, or a sidebar item like "Personal
// Information", can trigger a genuine full-page browser navigation (a real
// <a href> anchor, not an in-SPA route change). When that happens, this
// script's entire execution context is destroyed practically instantly --
// faster than a synchronous sendResponse() call can complete -- so there is
// NO reliable way for a click that might navigate to ever confirm it
// happened. Fighting that is pointless; the design here works around it:
//
//   - attabot-click-label: fire off a click, best-effort. It MAY respond
//     (if nothing navigated), or the whole page may vanish before it can.
//   - attabot-read-page: never clicks anything, so it always has a script
//     to respond from, regardless of what happened before it. This is the
//     only step sidepanel.js actually trusts to tell it what's on screen.
//
// It does NOT handle login -- it assumes you're already logged into the tab
// it's running in.
//
// Wrapped in an IIFE (no top-level const/let) so re-injecting this same
// file into the same page multiple times never throws a "already declared"
// error, and the old listener is explicitly removed before adding a new
// one so repeated injections never leave two listeners racing to answer
// the same message.
;(function () {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // Polls `check` until it returns a truthy value or `timeout` elapses.
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
  // an Angular Material autocomplete, whose dropdown results are
  // <mat-option> custom elements, not the a/button/li tags a plain HTML
  // dropdown would use.
  function findClickableByText(text, { requireVisible = true } = {}) {
    const needle = text.trim().toLowerCase()
    const candidates = [
      ...document.querySelectorAll('a, button, [role="button"], [role="option"], mat-option, li, span, div'),
    ]
    let best = null
    for (const el of candidates) {
      const own = (el.textContent || '').trim().toLowerCase()
      if (!own.includes(needle)) continue
      if (requireVisible) {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue // hidden
      }
      if (!best || own.length < best.textContent.trim().length) best = el
    }
    return best
  }

  // Some dropdown menus only open on a real mouse hover/press sequence and
  // ignore a bare synthetic .click() -- dispatches a fuller
  // mouseover/mouseenter/mousedown/mouseup/click sequence to cover both
  // click-toggled and JS hover-triggered menus. Prefers the nearest real
  // link/button ancestor over whatever exact element the text match landed
  // on, in case the toggle's actual click listener is bound higher up.
  function fireFullClick(el) {
    const target = el.closest('a, button, [role="button"]') || el
    const opts = { bubbles: true, cancelable: true, view: window }
    target.dispatchEvent(new MouseEvent('mouseover', opts))
    target.dispatchEvent(new MouseEvent('mouseenter', opts))
    target.dispatchEvent(new MouseEvent('mousedown', opts))
    target.dispatchEvent(new MouseEvent('mouseup', opts))
    target.click()
  }

  // Polls document.body.innerText until it stops changing between two
  // consecutive reads (or times out) -- Consolo's Angular components take
  // real, variable time to fetch and render content after a click, so
  // reading immediately captures stale/empty state.
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

  // Main (top nav) -> Classic Dashboard (a dropdown item, confirmed via
  // screenshot to sometimes be CSS-hidden until real hover, which no
  // synthetic event can fake -- found with requireVisible: false and
  // clicked directly instead) -> Quick Filter -> matching result card.
  // The final click is the one most likely to navigate; nothing after it
  // can be trusted to run, so this function does not try to confirm it.
  // Confirmed via real DOM: another Angular Material (AngularJS
  // md-autocomplete) combobox, placeholder/aria-label "Search for
  // Patients". Its id="input-N" is auto-generated (same pattern as every
  // other Angular Material input in this app), so matched on the stable
  // placeholder text instead.
  function findPatientSearchBox() {
    return (
      document.querySelector('input[placeholder="Search for Patients" i]') ||
      document.querySelector('input[aria-label="Search for Patients" i]')
    )
  }

  // Confirmed via screenshot + real DOM: the "Patient" button (top-right,
  // present on every page -- chart pages, dashboards, everywhere) opens a
  // panel with its own "Search for Patients" combobox, patient-agnostic
  // regardless of which patient's chart is currently open. This replaced
  // two earlier attempts: "Main" -> "Classic Dashboard" only ever reloaded
  // whichever patient was last active rather than reaching a real list, and
  // "Patients" -> "Search" reached a real list but isn't the intended flow.
  async function searchPatient(patient) {
    const patientButton = await waitFor(() => findClickableByText('Patient'), { timeout: 5000, interval: 250 })
    if (!patientButton) throw new Error('Could not find the "Patient" button.')
    fireFullClick(patientButton)

    const box = await waitFor(() => findPatientSearchBox(), { timeout: 6000, interval: 300 })
    if (!box) {
      const snippet = document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200)
      throw new Error(
        'Could not find the "Search for Patients" box after clicking the Patient button. ' +
        `Landed on: title="${document.title}" url="${location.href}" visible text starts: "${snippet}"`
      )
    }
    box.focus()
    // The filter matches substrings against the full patient record, but a
    // "Last, First" query is narrower than it needs to be -- just the last
    // name is the more reliable filter term.
    const searchTerm = patient.full_name.includes(',') ? patient.full_name.split(',')[0].trim() : patient.full_name
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(box, searchTerm)
    // This box also has its own ng-keydown handler (alongside ng-model),
    // which may be what actually triggers Consolo's search rather than the
    // 'input' event alone -- dispatching a keydown/keyup around it mimics a
    // real keystroke more closely, in case a bare 'input' event isn't
    // enough on this particular combobox.
    const lastChar = searchTerm.slice(-1)
    box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: lastChar }))
    box.dispatchEvent(new Event('input', { bubbles: true }))
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: lastChar }))
    await sleep(1000) // confirmed manually: results can take "a sec" to render

    const result = await waitFor(() => findClickableByText(patient.full_name), { timeout: 10000, interval: 300 })
    if (!result) {
      throw new Error(
        `No matching patient row found for "${patient.full_name}" (filtered by "${searchTerm}") after waiting 10s ` +
        '-- check the name matches Consolo exactly.'
      )
    }
    result.click()
  }

  // Finds and clicks ANY single labelled element -- a top-level sidebar
  // accordion parent, a submenu item, whatever. Used one label at a time by
  // sidepanel.js's own orchestration loop (NAV_STEPS lives there now, not
  // here), since any of these clicks might also navigate and this script
  // has no way to know in advance which ones will.
  async function clickLabel(label) {
    const el = await waitFor(() => findClickableByText(label), { timeout: 5000, interval: 250 })
    if (!el) throw new Error(`Could not find "${label}" on the current page.`)
    el.click()
  }

  // The only action that NEVER clicks anything -- always has a live script
  // to respond from, regardless of what happened before it, which is what
  // makes it the one sidepanel.js can actually trust.
  async function readPage() {
    await sleep(300)
    const text = await waitForStableInnerText()
    return { text, url: location.href, title: document.title }
  }

  if (window.__attabotListener) {
    try {
      chrome.runtime.onMessage.removeListener(window.__attabotListener)
    } catch (err) {
      // ignore -- old listener's context may already be dead
    }
  }

  const listener = (message, _sender, sendResponse) => {
    if (message.type === 'attabot-ping') {
      sendResponse({ ok: true, url: location.href, title: document.title })
      return false
    }

    if (message.type === 'attabot-search-patient') {
      ;(async () => {
        try {
          await searchPatient(message.patient)
          sendResponse({ ok: true })
        } catch (err) {
          sendResponse({ ok: false, error: err.message })
        }
      })()
      return true
    }

    if (message.type === 'attabot-click-label') {
      ;(async () => {
        try {
          await clickLabel(message.label)
          sendResponse({ ok: true })
        } catch (err) {
          sendResponse({ ok: false, error: err.message })
        }
      })()
      return true
    }

    if (message.type === 'attabot-read-page') {
      ;(async () => {
        try {
          const result = await readPage()
          sendResponse({ ok: true, ...result })
        } catch (err) {
          sendResponse({ ok: false, error: err.message })
        }
      })()
      return true
    }

    return false
  }

  window.__attabotListener = listener
  chrome.runtime.onMessage.addListener(listener)
})()
