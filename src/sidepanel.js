import { signIn, signOut, getCurrentUser, getAccessToken, rest, callFunction } from './lib/supabase.js'
import { buildPrompt } from './lib/promptBuilder.js'
import { parseReport } from './lib/parser.js'

const $ = (id) => document.getElementById(id)

let currentUser = null
let checklistItemsCache = {} // audit_type -> items[]
let currentChecklistItems = []
let currentPatients = []
let parsedReport = null

async function init() {
  currentUser = await getCurrentUser()
  const token = await getAccessToken().catch(() => null)
  if (currentUser && token) {
    showApp()
  } else {
    showLogin()
  }
  wireTabs()
  wireLogin()
  wireNewAudit()
  wireHistory()
  wireActions()
}

function showLogin() {
  $('loginView').classList.remove('hidden')
  $('appView').classList.add('hidden')
  $('userBar').classList.add('hidden')
}

async function showApp() {
  $('loginView').classList.add('hidden')
  $('appView').classList.remove('hidden')
  $('userBar').classList.remove('hidden')
  $('userEmail').textContent = currentUser?.email ?? ''
  await loadPatients()
  await loadChecklist('admission')
  await loadHistory()
  await loadActions()
}

function wireTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'))
      document.querySelectorAll('.tabpanel').forEach((p) => p.classList.add('hidden'))
      btn.classList.add('active')
      $(btn.dataset.tab).classList.remove('hidden')
    })
  })
}

function wireLogin() {
  $('loginBtn').addEventListener('click', async () => {
    $('loginError').textContent = ''
    try {
      const { user } = await signIn($('loginEmail').value.trim(), $('loginPassword').value)
      currentUser = user
      await showApp()
    } catch (err) {
      $('loginError').textContent = err.message
    }
  })
  $('signOutBtn').addEventListener('click', async () => {
    await signOut()
    currentUser = null
    showLogin()
  })
}

async function loadPatients(selectId = null) {
  currentPatients = await rest.select(
    'patients',
    'select=id,full_name,mrn,admission_date,current_bp_number,current_bp_end&status=eq.active&order=full_name.asc'
  )
  const sel = $('patientSelect')
  const previousValue = selectId ?? sel.value

  // Always start with a real placeholder -- a <select> silently defaults to
  // its first real option otherwise, so a reload (e.g. after adding a new
  // patient) would quietly re-select whichever patient sorts first instead
  // of leaving the field empty or keeping what you had chosen.
  sel.innerHTML =
    '<option value="">-- Select a patient --</option>' +
    currentPatients.map((p) => `<option value="${p.id}">${p.full_name} (MRN ${p.mrn})</option>`).join('')

  if (previousValue && currentPatients.some((p) => p.id === previousValue)) {
    sel.value = previousValue
  } else {
    sel.value = ''
  }
}

async function loadChecklist(auditType) {
  if (checklistItemsCache[auditType]) {
    currentChecklistItems = checklistItemsCache[auditType]
    return
  }
  const versions = await rest.select(
    'checklist_versions',
    `select=id&audit_type=eq.${auditType}&is_active=eq.true&order=effective_date.desc&limit=1`
  )
  if (!versions.length) throw new Error(`No active checklist for ${auditType}`)
  const items = await rest.select(
    'checklist_items',
    `select=*&checklist_version_id=eq.${versions[0].id}&order=sort_order.asc`
  )
  checklistItemsCache[auditType] = items
  currentChecklistItems = items
}

function wireNewAudit() {
  $('newPatientBtn').addEventListener('click', () => {
    $('newPatientForm').classList.toggle('hidden')
  })

  $('savePatientBtn').addEventListener('click', async () => {
    const row = {
      full_name: $('npName').value.trim(),
      mrn: $('npMrn').value.trim(),
      primary_diagnosis: $('npDx').value.trim() || null,
      admission_date: $('npAdmit').value || null,
      current_bp_number: $('npBpNum').value ? Number($('npBpNum').value) : null,
      current_bp_end: $('npBpEnd').value || null,
    }
    if (!row.full_name || !row.mrn) {
      alert('Full name and MRN are required')
      return
    }
    $('newPatientError').textContent = ''
    try {
      const [created] = await rest.insert('patients', [row])
      $('newPatientForm').classList.add('hidden')
      await loadPatients(created?.id)
    } catch (err) {
      $('newPatientError').textContent = err.message.includes('duplicate key')
        ? `A patient with MRN ${row.mrn} already exists -- search the dropdown above instead of adding a duplicate.`
        : err.message
    }
  })

  $('auditType').addEventListener('change', async (e) => {
    const isRecert = e.target.value === 'recert'
    $('bpNumWrap').classList.toggle('hidden', !isRecert)
    await loadChecklist(e.target.value)
  })

  $('copyPromptBtn').addEventListener('click', async () => {
    const patientId = $('patientSelect').value
    if (!patientId) {
      alert('Pick a patient from the dropdown first -- nothing was copied.')
      return
    }
    const auditType = $('auditType').value
    await loadChecklist(auditType)
    const patient = currentPatients.find((p) => p.id === patientId)
    if (!patient) {
      alert('That patient no longer matches the loaded list -- refresh and pick again before copying.')
      return
    }
    const prompt = buildPrompt(auditType, currentChecklistItems, patient)
    await navigator.clipboard.writeText(prompt)
    $('copyPromptBtn').textContent = `Copied for ${patient.full_name}! Paste into Claude for Chrome...`
    setTimeout(() => {
      $('copyPromptBtn').textContent = '1. Copy audit prompt to clipboard'
    }, 2500)
  })

  $('parseBtn').addEventListener('click', () => {
    $('parseError').textContent = ''
    try {
      parsedReport = parseReport($('reportText').value)
      renderReview()
    } catch (err) {
      $('parseError').textContent = err.message
      $('reviewArea').classList.add('hidden')
    }
  })

  $('submitBtn').addEventListener('click', submitAudit)
}

function computeLocalPreview(items) {
  let score = 100
  let failCount = 0
  let flagCount = 0
  let criticalFail = false
  for (const submitted of items) {
    const ci = currentChecklistItems.find((c) => c.item_key === submitted.item_key)
    if (!ci) continue
    if (submitted.status === 'fail') {
      score -= ci.fail_weight
      failCount += 1
      if (ci.is_critical_trigger) criticalFail = true
    } else if (submitted.status === 'flag') {
      score -= ci.flag_weight
      flagCount += 1
    }
  }
  score = Math.max(0, score)
  let risk = 'LOW'
  if (criticalFail) risk = 'CRITICAL'
  else if (failCount >= 2) risk = 'HIGH'
  else if (failCount === 1 || flagCount >= 2) risk = 'MEDIUM'
  return { score, risk }
}

function renderReview() {
  $('reviewArea').classList.remove('hidden')
  const merged = currentChecklistItems
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((ci) => {
      const found = parsedReport.items.find((i) => i.item_key === ci.item_key)
      return { ci, status: found?.status ?? '', finding: found?.finding ?? '' }
    })

  const { score, risk } = computeLocalPreview(merged.map((m) => ({ item_key: m.ci.item_key, status: m.status })))
  $('scorePreview').innerHTML =
    `<strong>Preview score: ${score}/100</strong> &nbsp; <span class="risk-${risk}">Risk: ${risk}</span>` +
    `<p class="hint">This is a client-side estimate. The console recomputes the authoritative score/risk on submit.</p>`

  $('findingsList').innerHTML = merged
    .map(
      (m, idx) => `
      <div class="finding-row" data-idx="${idx}" data-key="${m.ci.item_key}">
        <strong>${m.ci.title}</strong>
        <select class="statusSelect">
          <option value="">-- select --</option>
          ${m.ci.status_options.map((s) => `<option value="${s}" ${s === m.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <textarea class="findingText" rows="2">${m.finding}</textarea>
      </div>`
    )
    .join('')
}

async function submitAudit() {
  $('submitStatus').textContent = ''
  const rows = [...document.querySelectorAll('#findingsList .finding-row')]
  const items = rows.map((row) => ({
    item_key: row.dataset.key,
    status: row.querySelector('.statusSelect').value,
    finding: row.querySelector('.findingText').value,
  }))
  if (items.some((i) => !i.status)) {
    $('submitStatus').textContent = 'Every item needs a status before submitting.'
    $('submitStatus').className = 'error'
    return
  }

  const patientId = $('patientSelect').value
  const auditType = $('auditType').value
  const bpNum = $('bpNum').value ? Number($('bpNum').value) : null

  if (!patientId) {
    $('submitStatus').className = 'error'
    $('submitStatus').textContent = 'No patient selected -- pick one from the dropdown before submitting.'
    return
  }

  try {
    $('submitBtn').disabled = true
    const result = await callFunction('submit-audit', {
      patient_id: patientId,
      audit_type: auditType,
      benefit_period_number: bpNum,
      raw_report_text: $('reportText').value,
      items,
    })
    $('submitStatus').className = ''
    $('submitStatus').textContent = `Submitted. Score ${result.audit.score}/100, risk ${result.audit.risk_level}. Now pending reviewer confirmation in the dashboard.`
    $('reportText').value = ''
    $('reviewArea').classList.add('hidden')
    await loadHistory()
  } catch (err) {
    $('submitStatus').className = 'error'
    $('submitStatus').textContent = err.message
  } finally {
    $('submitBtn').disabled = false
  }
}

function wireHistory() {
  $('refreshHistoryBtn').addEventListener('click', loadHistory)
}

async function loadHistory() {
  const audits = await rest.select(
    'audits',
    'select=id,audit_type,score,risk_level,status,created_at,patients(full_name,mrn)&order=created_at.desc&limit=25'
  )
  $('historyList').innerHTML = audits
    .map(
      (a) => `
      <div class="list-item">
        <strong>${a.patients?.full_name ?? 'Unknown'}</strong> (MRN ${a.patients?.mrn ?? '-'})<br/>
        ${a.audit_type} -- score ${a.score ?? '-'} -- <span class="risk-${a.risk_level}">${a.risk_level ?? '-'}</span><br/>
        status: ${a.status} -- ${new Date(a.created_at).toLocaleDateString()}
      </div>`
    )
    .join('') || '<p class="hint">No audits yet.</p>'
}

function wireActions() {
  $('refreshActionsBtn').addEventListener('click', loadActions)
}

async function loadActions() {
  const user = await getCurrentUser()
  const actions = await rest.select(
    'corrective_actions',
    `select=id,description,due_date,status&owner_user_id=eq.${user?.id ?? ''}&status=neq.done&order=due_date.asc`
  )
  $('actionsList').innerHTML = actions
    .map(
      (a) => `
      <div class="list-item" data-id="${a.id}">
        ${a.description}<br/>
        due ${a.due_date ?? '-'} -- ${a.status}
        <button class="markDoneBtn linklike" data-id="${a.id}">Mark done</button>
      </div>`
    )
    .join('') || '<p class="hint">Nothing assigned to you right now.</p>'

  document.querySelectorAll('.markDoneBtn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await rest.update('corrective_actions', `id=eq.${btn.dataset.id}`, {
        status: 'done',
        closed_at: new Date().toISOString(),
        closed_by: user?.id ?? null,
      })
      await loadActions()
    })
  })
}

init()
