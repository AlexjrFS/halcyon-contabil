// Halcyon-contabil web app. No build step: plain modules served by the same server as the API.
// Text from the API (supplier notes included) is only ever added with textContent, never as HTML.

const $ = (selector, root = document) => root.querySelector(selector)

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') el.className = value
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid)
  return el
}

const usd = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const usdMajor = (amount) => usd(Math.round(amount * 100))
const date = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text)

const store = { ledger: null, state: null, proposals: [], card: null, tab: 'overview', chargeResult: null }
const chat = { messages: [], busy: false }

// ---------- API ----------
let token = ''
try { token = sessionStorage.getItem('halcyon_token') || '' } catch {}

function askToken() {
  const dialog = $('#gate')
  return new Promise((resolve) => {
    $('#gate-form').onsubmit = () => {
      token = $('#gate-input').value.trim()
      try { sessionStorage.setItem('halcyon_token', token) } catch {}
      resolve()
    }
    if (!dialog.open) dialog.showModal()
  })
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    await askToken()
    return api(path, options)
  }
  return res
}

async function json(path, options) {
  const res = await api(path, options)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.message || `${res.status} ${res.statusText}`)
  return body
}

let toastTimer
function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), 4500)
}

// ---------- Data ----------
async function refresh() {
  const [ledger, state, proposals] = await Promise.all([json('/ledger'), json('/state'), json('/proposals')])
  store.ledger = ledger
  store.state = state
  store.proposals = proposals
  store.card = state.cards.framewise ? await json('/cards/framewise').catch(() => null) : null
  render()
}

async function refreshProposals() {
  store.proposals = await json('/proposals')
  renderPending()
}

// ---------- Rendering ----------
const TABS = [
  ['overview', 'Overview'],
  ['payables', 'Payables'],
  ['reconcile', 'Reconciliation'],
  ['collections', 'Collections'],
  ['card', 'Card'],
]

function render() {
  renderTabs()
  renderPanel()
  renderPending()
}

function renderTabs() {
  const t = store.ledger?.totals
  const badge = { payables: t?.flaggedBills, reconcile: t?.unmatchedPayments, collections: t?.remindersToSend }
  $('#tabs').replaceChildren(
    ...TABS.map(([id, label]) =>
      h('button', { class: 'tab', role: 'tab', 'aria-selected': String(store.tab === id), onclick: () => { store.tab = id; render() } }, label, badge[id] ? h('span', { class: 'count' }, badge[id]) : null),
    ),
  )
}

function renderPanel() {
  const panel = $('#panel')
  if (!store.ledger) return panel.replaceChildren(h('p', { class: 'empty' }, 'Loading…'))
  const view = { overview, payables, reconcile, collections, card }[store.tab]
  panel.replaceChildren(view())
}

function overview() {
  const t = store.ledger.totals
  const kpi = (value, label, tab, kind = '') => h('button', { class: `kpi ${kind}`, type: 'button', onclick: () => { store.tab = tab; render() } }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label))
  const invoiceReceived = store.state.invoices.includes('framewise-2026-12')
  return h('div', {},
    h('h2', {}, 'Lumen Studio at a glance'),
    h('p', { class: 'lead' }, 'A five-person design studio. The agent reads the books, finds what is off and proposes the next step. You approve every action.'),
    h('div', { class: 'kpis' },
      kpi(usd(t.unpaidPayables), 'Unpaid supplier invoices', 'payables'),
      kpi(String(t.flaggedBills), 'Invoices flagged by code', 'payables', t.flaggedBills ? 'bad' : ''),
      kpi(String(t.unmatchedPayments), 'Payments with no invoice', 'reconcile', t.unmatchedPayments ? 'warn' : ''),
      kpi(usd(t.overdueReceivables), 'Overdue from clients', 'collections', t.overdueReceivables ? 'bad' : ''),
      kpi(String(t.remindersToSend), 'Reminders ready to draft', 'collections'),
    ),
    h('div', { class: 'section' },
      h('h3', {}, 'Try a scenario'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => ask('Review this month\'s payables and tell me what looks wrong.') }, 'Review payables'),
        h('button', { class: 'btn', type: 'button', onclick: () => ask('Reconcile our payments against the invoices.') }, 'Reconcile payments'),
        h('button', { class: 'btn', type: 'button', onclick: () => ask('Which clients are late? Draft reminders for them.') }, 'Chase late clients'),
        h('button', { class: 'btn', type: 'button', disabled: invoiceReceived, onclick: receivePriceIncrease }, invoiceReceived ? 'Price-increase invoice received' : 'Receive Framewise price-increase invoice'),
      ),
    ),
    h('div', { class: 'section' },
      h('h3', {}, 'How it works'),
      h('ul', { class: 'sub' },
        h('li', {}, 'Flags, matches and reminder wording are computed by code. The model only explains them.'),
        h('li', {}, 'Every action is a proposal with a fingerprint. Approving it runs exactly what you read, or nothing.'),
        h('li', {}, 'Supplier notes are untrusted text. Instructions inside them are shown to you, never followed.'),
      ),
    ),
  )
}

const SEVERITY = { high: 'bad', medium: 'warn', low: '' }
const DUE = { settled: ['Settled', 'ok'], overdue: ['Overdue', 'bad'], due_soon: ['Due soon', 'warn'], upcoming: ['Upcoming', ''] }
const PAYMENT = { paid: ['Paid', 'ok'], unpaid: ['Not paid', ''], duplicate_payment: ['Paid twice', 'bad'], amount_mismatch: ['Wrong amount', 'warn'] }
const FLAG_LABEL = {
  duplicate_invoice: 'Duplicate invoice', amount_spike: 'Unusual amount', new_vendor: 'New vendor', payment_details_changed: 'Bank details changed',
  instructions_in_note: 'Instructions in note', foreign_currency: 'Foreign currency', needs_second_approval: 'Second approver',
}

function payables() {
  const rows = store.ledger.payables
  return h('div', {},
    h('h2', {}, 'Supplier invoices'),
    h('p', { class: 'lead' }, 'Flags come from fixed rules (duplicates, amount spikes, new vendors, changed bank details). They are not the model\'s opinion.'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Invoice', 'Amount', 'Due', 'Payment', 'Flags'].map((c, i) => h('th', { class: i === 1 ? 'num' : '' }, c)))),
      h('tbody', {}, rows.map((p) => {
        const [dueLabel, dueKind] = DUE[p.due]
        const [payLabel, payKind] = PAYMENT[p.payment.status]
        // A first invoice from a vendor is only worth a note while it is still unpaid
        const flags = p.flags.filter((f) => f.severity !== 'low' || p.payment.status === 'unpaid')
        const off = p.payment.status === 'duplicate_payment' || p.payment.status === 'amount_mismatch'
        return h('tr', { class: flags.some((f) => f.severity !== 'low') ? 'flagged' : '' },
          h('td', {}, h('div', {}, p.bill.vendor), h('div', { class: 'sub' }, `${p.bill.invoiceNumber} · ${p.bill.description}`)),
          h('td', { class: 'num' }, usd(p.bill.amount)),
          h('td', {}, h('div', {}, date(p.bill.dueDate)), pill(p.due === 'overdue' ? `${p.daysOverdue} days overdue` : dueLabel, dueKind)),
          h('td', {}, pill(payLabel, payKind), off ? h('div', { class: 'sub' }, `${p.payment.difference > 0 ? '+' : '-'}${usd(Math.abs(p.payment.difference))}`) : null),
          h('td', {},
            flags.length
              ? h('div', { class: 'flags' },
                  flags.map((f) => h('div', { class: 'flag' }, pill(FLAG_LABEL[f.code] || f.code, SEVERITY[f.severity]), ' ', h('span', { class: 'sub' }, f.detail))),
                  p.bill.note ? h('div', { class: 'note' }, h('b', {}, 'Supplier note (untrusted)'), p.bill.note) : null,
                  h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: () => ask(`Explain the flags on the ${p.bill.vendor} invoice ${p.bill.invoiceNumber} and what I should do.`) }, 'Ask the agent')),
                )
              : h('span', { class: 'sub' }, '—')),
        )
      })),
    )),
  )
}

function reconcile() {
  const rows = store.ledger.payables
  const exceptions = rows.filter((p) => p.payment.status === 'duplicate_payment' || p.payment.status === 'amount_mismatch')
  const unpaid = rows.filter((p) => p.payment.status === 'unpaid')
  const paid = rows.filter((p) => p.payment.status === 'paid').length
  const empty = (text) => h('p', { class: 'empty' }, text)
  const item = (title, detail, tag) => h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', {}, title), h('div', { class: 'sub' }, detail)), tag)
  return h('div', {},
    h('h2', {}, 'Bank and card statement vs. invoices'),
    h('p', { class: 'lead' }, `${paid} invoices matched exactly. The rest need a person.`),
    h('div', { class: 'section' }, h('h3', {}, 'Paid twice or the wrong amount'),
      exceptions.length
        ? h('div', { class: 'list' }, exceptions.map((p) => item(`${p.bill.vendor} · ${p.bill.invoiceNumber}`, `Invoice ${usd(p.bill.amount)}, paid ${usd(p.payment.paid)} (${p.payment.difference > 0 ? '+' : '-'}${usd(Math.abs(p.payment.difference))})`, pill(...PAYMENT[p.payment.status]))))
        : empty('Nothing here.')),
    h('div', { class: 'section' }, h('h3', {}, 'Payments with no invoice'),
      store.ledger.unmatchedLines.length
        ? h('div', { class: 'list' }, store.ledger.unmatchedLines.map((l) => item(`${l.vendor} · ${usd(l.amount)}`, `${date(l.date)} · ${l.source} · ${l.description}`, pill('No invoice', 'warn'))))
        : empty('Nothing here.')),
    h('div', { class: 'section' }, h('h3', {}, 'Invoices not paid yet'),
      unpaid.length
        ? h('div', { class: 'list' }, unpaid.map((p) => item(`${p.bill.vendor} · ${p.bill.invoiceNumber}`, `${usd(p.bill.amount)} · due ${date(p.bill.dueDate)}`, pill(...DUE[p.due]))))
        : empty('Everything is paid.')),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => ask('Reconcile our payments against the invoices.') }, 'Ask the agent to summarise')),
  )
}

const STAGE = { paid: ['Paid', 'ok'], not_due: ['Not due', ''], due_soon: ['Due soon', 'info'], friendly: ['Friendly reminder', 'warn'], firm: ['Firm reminder', 'bad'], final: ['Final notice', 'bad'] }
const WHY = { recently_reminded: 'Reminded in the last 7 days', already_paid: 'Already paid', not_overdue: 'Not overdue' }

function collections() {
  const sent = store.ledger.reminders
  return h('div', {},
    h('h2', {}, 'Invoices owed to Lumen Studio'),
    h('p', { class: 'lead' }, 'The collection stage follows days overdue. The wording is fixed by the stage; you read the exact email before it is sent.'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Client', 'Amount', 'Due', 'Stage', ''].map((c, i) => h('th', { class: i === 1 ? 'num' : '' }, c)))),
      h('tbody', {}, store.ledger.receivables.map((r) => h('tr', {},
        h('td', {}, h('div', {}, r.receivable.client), h('div', { class: 'sub' }, `${r.receivable.invoiceNumber} · ${r.receivable.description}`)),
        h('td', { class: 'num' }, usd(r.receivable.amount)),
        h('td', {}, h('div', {}, date(r.receivable.dueDate)), r.daysOverdue ? h('div', { class: 'sub' }, `${r.daysOverdue} days overdue`) : null),
        h('td', {}, pill(...STAGE[r.stage]), r.lastReminder ? h('div', { class: 'sub' }, `Last reminder ${date(r.lastReminder.date)}`) : null),
        h('td', {}, r.eligible
          ? h('button', { class: 'btn small primary', type: 'button', onclick: () => ask(`Draft a payment reminder for ${r.receivable.client}, invoice ${r.receivable.invoiceNumber} (id ${r.receivable.id}).`) }, 'Draft reminder')
          : h('span', { class: 'sub' }, WHY[r.reason] || '—')),
      ))),
    )),
    h('div', { class: 'section' }, h('h3', {}, 'Reminders sent'),
      sent.length
        ? h('div', { class: 'list' }, sent.map((m) => h('div', { class: 'item' },
            h('div', { class: 'main' }, h('div', {}, m.subject), h('div', { class: 'sub' }, `To ${m.to} · ${date(m.date)} · demo outbox, nothing is emailed`)),
            pill(...STAGE[m.stage]),
          )))
        : h('p', { class: 'empty' }, 'None yet.')),
  )
}

function card() {
  const c = store.card
  if (!c) {
    return h('div', {},
      h('h2', {}, 'Virtual card'),
      h('p', { class: 'lead' }, 'No card yet. The agent compares the annual and monthly Framewise plans against the cash reserve and proposes a card with exact limits.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => ask('Should we buy the Framewise annual plan? Propose a card if it fits.') }, 'Ask about Framewise')),
    )
  }
  const controls = c.card.authorization_controls
  const result = store.chargeResult
  const charge = (kind, label) => h('button', { class: 'btn small', type: 'button', onclick: () => simulateCharge(kind) }, label)
  return h('div', {},
    h('h2', {}, 'Framewise virtual card'),
    h('p', { class: 'lead' }, 'The card is the last line of defence: it declines anything outside the approved terms, whatever the model or a supplier note says.'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Status'), h('dd', {}, pill(c.card.card_status, c.card.card_status === 'ACTIVE' ? 'ok' : 'bad')),
      h('dt', {}, 'Plan'), h('dd', {}, c.plan),
      h('dt', {}, 'Currency'), h('dd', {}, (controls?.allowed_currencies || []).join(', ') || '—'),
      h('dt', {}, 'Merchant category'), h('dd', {}, (controls?.allowed_merchant_categories || []).join(', ') || '—'),
      h('dt', {}, 'Limits'), h('dd', {}, c.limits.limits.map((l) => `${usdMajor(l.amount)} ${l.interval.toLowerCase().replace('_', ' ')} (${usdMajor(l.remaining)} left)`).join(' · ')),
    ),
    h('div', { class: 'section' }, h('h3', {}, 'Simulate a charge from the vendor'),
      h('div', { class: 'row' }, charge('monthly', 'Monthly price'), charge('annual', 'Annual price'), charge('other_currency', 'In euros'), charge('other_category', 'Restaurant category')),
      result ? h('p', { class: 'sub', style: 'margin-top:8px' }, pill(result.result.process_result, result.result.process_result === 'APPROVED' ? 'ok' : 'bad'), ` ${result.charge.display}${result.result.failure_reason ? ` · ${result.result.failure_reason}` : ''}`) : null),
    h('div', { class: 'section' }, h('h3', {}, 'Transactions'),
      c.transactions.length
        ? h('div', { class: 'list' }, c.transactions.map((t) => h('div', { class: 'item' },
            h('div', { class: 'main' }, h('div', {}, `${usdMajor(Math.abs(t.transaction_amount))} ${t.transaction_currency}`), h('div', { class: 'sub' }, `${t.merchant?.name || 'Merchant'}${t.failure_reason ? ` · ${t.failure_reason}` : ''}`)),
            pill(t.status, t.status === 'FAILED' ? 'bad' : 'ok'),
          )))
        : h('p', { class: 'empty' }, 'No transactions yet.')),
  )
}

// ---------- Approvals ----------
const KIND = { issue_card: 'Issue a virtual card', update_card: 'Update the card\'s controls', freeze_card: 'Freeze the card', send_reminder: 'Send a payment reminder' }

function proposalCard(p) {
  const a = p.action
  const rows = []
  if (a.terms) {
    rows.push(['Vendor', `${a.terms.vendor} · ${a.terms.product}`], ['Plan', a.terms.plan], ['Charge', p.display?.charge || usd(a.terms.amount)], ['Currency', a.terms.currency], ['Merchant category', a.terms.merchantCategoryCode])
    if (a.terms.revisitOn) rows.push(['Revisit annual on', date(a.terms.revisitOn)])
  }
  if (a.kind === 'freeze_card') rows.push(['Reason', a.reason])
  if (a.kind === 'send_reminder') rows.push(['To', a.to], ['Subject', a.subject])
  const pending = p.status === 'pending'
  const statusKind = { executed: 'ok', rejected: '', failed: 'bad', stale: 'warn', expired: 'warn' }[p.status] || 'info'
  const act = async (verb) => {
    try {
      const body = verb === 'approve' ? JSON.stringify({ fingerprint: p.fingerprint }) : undefined
      const done = await json(`/proposals/${p.id}/${verb}`, { method: 'POST', body })
      toast(verb === 'reject' ? 'Rejected. Nothing was done.' : done.status === 'executed' ? 'Approved and done.' : done.status === 'stale' ? 'Not done: the books changed after you read this. Ask the agent again.' : `Status: ${done.status}`)
    } catch (error) {
      toast(error.message)
    }
    await refresh()
  }
  return h('div', { class: `pcard ${pending ? '' : 'done'}` },
    h('h3', {}, KIND[a.kind] || a.kind, pending ? null : pill(p.status, statusKind)),
    h('dl', { class: 'kv', style: 'margin-top:8px' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    a.kind === 'send_reminder' ? h('pre', { class: 'mail' }, a.body) : null,
    p.error ? h('div', { class: 'err' }, `${p.error.code}: ${p.error.message}`) : null,
    pending ? h('div', { class: 'row' }, h('button', { class: 'btn good', type: 'button', onclick: () => act('approve') }, 'Approve'), h('button', { class: 'btn', type: 'button', onclick: () => act('reject') }, 'Reject')) : null,
    h('div', { class: 'meta' }, `Fingerprint ${p.fingerprint.slice(0, 16)}… · what you read is exactly what runs`),
  )
}

function renderPending() {
  const pendingList = store.proposals.filter((p) => p.status === 'pending')
  const recent = store.proposals.filter((p) => p.status !== 'pending').slice(0, 2)
  $('#pending').replaceChildren(
    ...[pendingList.length ? h('h3', { class: 'sub' }, 'Waiting for your approval') : null, ...pendingList.map(proposalCard), ...recent.map(proposalCard)].filter(Boolean),
  )
}

// ---------- Chat ----------
const CHIPS = [
  'Review this month\'s payables and tell me what looks wrong.',
  'Reconcile our payments against the invoices.',
  'Which clients are late? Draft reminders for them.',
  'What does the Quickfix invoice note say, and should I trust it?',
  'Should we buy the Framewise annual plan?',
]

// **bold**, `code`, and "- " lists; everything else is plain text
function rich(text) {
  const inline = (line) => {
    const out = []
    for (const part of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push(h('strong', {}, part.slice(2, -2)))
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push(h('code', {}, part.slice(1, -1)))
      else if (part) out.push(part)
    }
    return out
  }
  const blocks = []
  let list = null
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!list) blocks.push((list = h('ul')))
      list.append(h('li', {}, inline(bullet[1])))
    } else {
      list = null
      if (line.trim()) blocks.push(h('p', {}, inline(line)))
    }
  }
  return blocks
}

function bubble(role) {
  const body = h('div', { class: 'body' })
  const tools = h('div', { class: 'tools' })
  const el = h('div', { class: `msg ${role}` }, role === 'bot' ? tools : null, body)
  $('#log').append(el)
  $('#log').scrollTop = $('#log').scrollHeight
  return { el, body, tools }
}

function setBusy(busy) {
  chat.busy = busy
  $('#send').disabled = busy
  for (const chip of document.querySelectorAll('.chip')) chip.disabled = busy
}

async function ask(text) {
  if (chat.busy) return toast('The agent is still answering.')
  $('#input').value = ''
  await send(text)
}

async function send(text) {
  chat.messages.push({ role: 'user', text })
  bubble('user').body.textContent = text
  const view = bubble('bot')
  view.body.append(h('p', { class: 'sub' }, 'Thinking…'))
  setBusy(true)
  let answer = ''
  try {
    // The API wants the history to start with a user message
    let history = chat.messages.slice(-20)
    while (history.length && history[0].role !== 'user') history = history.slice(1)
    const res = await api('/chat', { method: 'POST', body: JSON.stringify({ messages: history }) })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.message || `${res.status} ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const handle = async (line) => {
      if (!line.trim()) return
      const event = JSON.parse(line)
      if (event.type === 'text') {
        answer += event.text
        view.body.replaceChildren(...rich(answer))
      } else if (event.type === 'tool') {
        view.tools.append(pill(event.name.replaceAll('_', ' '), 'info'))
      } else if (event.type === 'proposal') {
        await refreshProposals()
        toast('The agent proposed an action. Read it and approve or reject.')
      } else if (event.type === 'error') {
        view.el.classList.add('err')
        view.body.append(h('p', {}, event.message))
      }
      $('#log').scrollTop = $('#log').scrollHeight
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) await handle(line)
    }
    await handle(buffer)
    if (answer) chat.messages.push({ role: 'assistant', text: answer })
    if (!answer && !view.el.classList.contains('err')) view.body.replaceChildren(h('p', { class: 'sub' }, 'No answer. Try again.'))
  } catch (error) {
    view.el.classList.add('err')
    view.body.replaceChildren(h('p', {}, error.message))
  } finally {
    setBusy(false)
    await refreshProposals().catch(() => {})
  }
}

// ---------- Actions ----------
async function receivePriceIncrease() {
  try {
    const result = await json('/invoices/framewise-2026-12/receive', { method: 'POST' })
    toast(result.kind === 'updated' ? 'Invoice received: Framewise raised its price. The card still has the old limits.' : `Invoice: ${result.kind}`)
    await refresh()
    if (result.kind === 'updated') ask('A new Framewise invoice arrived. Read it and tell me what changed. Propose what is needed.')
  } catch (error) {
    toast(error.message)
  }
}

async function simulateCharge(kind) {
  try {
    store.chargeResult = await json('/charges', { method: 'POST', body: JSON.stringify({ offer_id: 'framewise', kind }) })
    await refresh()
  } catch (error) {
    toast(error.message)
  }
}

$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset the demo? Proposals, the card, received invoices and sent reminders are cleared.')) return
  try {
    await json('/demo/reset', { method: 'POST' })
    chat.messages = []
    store.chargeResult = null
    $('#log').replaceChildren()
    toast('Demo reset.')
    await refresh()
  } catch (error) {
    toast(error.message)
  }
})

$('#form').addEventListener('submit', (event) => {
  event.preventDefault()
  const text = $('#input').value.trim()
  if (text) ask(text)
})
$('#input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    $('#form').requestSubmit()
  }
})

$('#chips').replaceChildren(...CHIPS.map((text) => h('button', { class: 'chip', type: 'button', onclick: () => ask(text) }, text)))

refresh().catch((error) => {
  $('#panel').replaceChildren(h('p', { class: 'empty' }, `Could not load the books: ${error.message}`))
})
