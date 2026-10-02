'use strict'

const state = { bot: {}, automation: {}, market: { candidates: [], items: [] }, logs: [], lan: null, totals: { totalProfit: 0 }, deviceUrl: 'https://login.live.com/oauth20_remoteconnect.srf', deviceCode: '', dismissedDeviceCode: '', accountLinkMode: 'add', accountLinkPending: false, accountConfirmTimer: null, itemPage: 0, itemQuery: '', graphMode: 'profit', anonymous: localStorage.getItem('ff-anonymous-mode') !== 'off', privateFiles: {}, privateParsed: {}, privateErrors: {}, revealedFiles: {}, savedProfiles: [], proxyPool: { records: [], instances: [] }, proxyCountryFilters: {}, statsStructureSignature: '', instancesRenderSignature: '', trackerGraphSignature: '', hubSelectedId: '', hubStates: {}, hubBusy: false, hubAction: '', hubPendingActivityMode: '', hubStatusRequest: null, hubStatusRequestSequence: 0, hubStatusRequestIds: {}, hubInstancesSignature: '', hubNotice: null }

const el = id => document.getElementById(id)
const pageIsActive = page => el(`page-${page}`)?.classList.contains('active') === true
function renderWebCredentials(webpage = {}) { el('webUsername').value = webpage.username || 'xyz'; el('webPassword').value = webpage.password || '' }
const accountNameOnly = value => {
  const original = String(value || 'Unknown').trim()
  if (original === 'Not connected' || original === 'Unknown') return original
  const withoutPrompt = original.replace(/\s*(?:·\s*)?click to\b.*$/i, '').trim()
  const withoutRanks = withoutPrompt.replace(/^(?:\[[^\]]+\]\s*)+/, '').trim()
  return withoutRanks.match(/[A-Za-z0-9_]{1,16}/)?.[0] || withoutRanks || 'Unknown'
}
const privateIgn = value => {
  const name = accountNameOnly(value || 'Not connected')
  return state.anonymous && name !== 'Not connected' ? `${name[0]}####` : name
}
function renderIgn(node, value) {
  const name = accountNameOnly(value || 'Not connected')
  node.replaceChildren()
  if (!state.anonymous || name === 'Not connected') { node.textContent = name; return }
  const first = document.createElement('span'); first.textContent = name[0]
  const hidden = document.createElement('span'); hidden.className = 'anonymous-mask'; hidden.textContent = '####'
  node.append(first, hidden)
}
const formatCoins = value => {
  const amount = Number(value) || 0
  if (Math.abs(amount) >= 1e9) return `${(amount / 1e9).toFixed(2)}B`
  if (Math.abs(amount) >= 1e6) return `${(amount / 1e6).toFixed(2)}M`
  if (Math.abs(amount) >= 1e3) return `${(amount / 1e3).toFixed(1)}K`
  return amount.toFixed(0)
}
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const formatBytes = value => {
  const bytes = Number(value) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
const formatDuration = value => {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return 'n/a'
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes.toFixed(0)}m`
  return `${(minutes / 60).toFixed(1)}h`
}
const formatClock = seconds => {
  if (!Number.isFinite(Number(seconds))) return '—'
  const total = Math.max(0, Math.floor(Number(seconds))); const hours = Math.floor(total / 3600); const minutes = Math.floor(total % 3600 / 60); const secs = total % 60
  return `${String(hours).padStart(2, '0')}H ${String(minutes).padStart(2, '0')}M ${String(secs).padStart(2, '0')}S`
}
const formatOrderAge = milliseconds => {
  // Order age is intentionally displayed in whole minutes. Seconds made the
  // cards flicker constantly and implied precision Hypixel does not provide.
  const minutes = Math.max(0, Math.floor((Number(milliseconds) || 0) / 60000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}
function updateOrderAges() {
  document.querySelectorAll('[data-order-placed-at]').forEach(node => {
    const placedAt = Number(node.dataset.orderPlacedAt)
    node.textContent = placedAt > 0 ? formatOrderAge(Date.now() - placedAt) : 'Tracking now'
  })
}
const cookieSeconds = bot => {
  const remaining = Number(bot?.cookieRemainingSeconds)
  const updatedAt = Date.parse(bot?.cookieUpdatedAt || '')
  if (!Number.isFinite(remaining) || !Number.isFinite(updatedAt)) return null
  return Math.max(0, remaining - (Date.now() - updatedAt) / 1000)
}
const formatCookie = seconds => {
  if (!Number.isFinite(Number(seconds))) return 'Open SkyBlock Menu'
  const total = Math.max(0, Math.floor(Number(seconds)))
  if (!total) return 'Expired'
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total % 86400 / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  return days ? `${days}D ${hours}H ${minutes}M` : `${hours}H ${minutes}M`
}

async function run(action) {
  try { return await action() } catch (error) { addLog({ at: new Date().toISOString(), level: 'error', message: error.message }); throw error }
}

let ffDialogPending = null
function finishFFDialog(value) {
  if (!ffDialogPending) return
  const { resolve } = ffDialogPending
  ffDialogPending = null
  if (el('ffDialog').open) el('ffDialog').close()
  resolve(value)
}
function showFFDialog({ title, message, confirmLabel = 'Confirm', eyebrow = 'XYZ FLIPPER', danger = false, input = false, value = '', placeholder = '' }) {
  if (ffDialogPending) finishFFDialog(null)
  const dialog = el('ffDialog')
  el('ffDialogEyebrow').textContent = eyebrow
  el('ffDialogTitle').textContent = title
  el('ffDialogMessage').textContent = message
  const field = el('ffDialogInput')
  field.classList.toggle('hidden', !input)
  field.value = input ? value : ''
  field.placeholder = placeholder
  const confirmButton = el('ffDialogConfirm')
  confirmButton.textContent = confirmLabel
  confirmButton.className = `button ${danger ? 'danger' : 'primary'}`
  dialog.showModal()
  if (input) setTimeout(() => { field.focus(); field.select() }, 0)
  return new Promise(resolve => { ffDialogPending = { resolve, input } })
}
const ffConfirm = (title, message, options = {}) => showFFDialog({ title, message, ...options })
const ffPrompt = (title, message, value = '', options = {}) => showFFDialog({ title, message, value, input: true, confirmLabel: 'Save', ...options })
el('ffDialogForm').onsubmit = event => {
  event.preventDefault()
  finishFFDialog(ffDialogPending?.input ? el('ffDialogInput').value.trim() : true)
}
el('ffDialogCancel').onclick = () => finishFFDialog(ffDialogPending?.input ? null : false)
el('ffDialog').addEventListener('cancel', event => { event.preventDefault(); finishFFDialog(ffDialogPending?.input ? null : false) })

function renderBot(bot) {
  state.bot = bot
  if (bot.pendingDeviceCode) adoptDeviceCode(bot.pendingDeviceCode)
  const connected = bot.status === 'connected'
  const connecting = ['connecting', 'authenticated'].includes(bot.status)
  const pill = el('connectionPill')
  pill.className = `pill ${connected ? 'connected' : connecting ? 'connecting' : ''}`
  pill.lastChild.textContent = bot.status?.toUpperCase() || 'DISCONNECTED'
  renderAccountLinkButton(false)
  el('clearOrdersInventory').disabled = !connected
  el('ffPurse').textContent = bot.purse !== null && bot.purse !== undefined && Number.isFinite(Number(bot.purse)) ? `${formatCoins(bot.purse)} coins` : '—'
  el('ffCookie').textContent = formatCookie(cookieSeconds(bot))
  const notice = el('accountNotice')
  notice.classList.toggle('hidden', !bot.accountConnected && !bot.lastError)
  notice.classList.toggle('error', Boolean(bot.lastError))
  notice.textContent = bot.lastError || (connected
    ? `Account connected: ${privateIgn(bot.username)}. Server connection is ready.`
    : bot.accountConnected
      ? `Account connected: ${privateIgn(bot.username)}. Connecting to the server...`
      : '')
  const accountsSignature = JSON.stringify([state.anonymous, bot.status, bot.activeAccountId, (bot.accounts || []).map(account => [account.id, account.username])])
  if (accountsSignature !== state.botAccountsSignature) {
    state.botAccountsSignature = accountsSignature
    renderAccounts(bot)
  }
  const ordersSignature = JSON.stringify([state.anonymous, bot.username, bot.location, (bot.orders || []).map(order => [order.id, order.type, order.itemName, order.count, order.filledCount, order.totalCount, order.placedAt, order.details])])
  if (ordersSignature !== state.botOrdersSignature) {
    state.botOrdersSignature = ordersSignature
    renderOrders(bot)
  }
}

function renderAccountLinkButton(locked = false) {
  const button = el('addAccount')
  button.classList.toggle('link-ready', state.accountLinkMode === 'link')
  button.classList.toggle('confirmed', state.accountLinkMode === 'confirmed')
  if (state.accountLinkMode === 'link') {
    button.textContent = 'Click to open Microsoft Link'
    button.disabled = false
  } else if (state.accountLinkMode === 'waiting') {
    button.textContent = 'Preparing Microsoft Link...'
    button.disabled = true
  } else if (state.accountLinkMode === 'confirmed') {
    button.textContent = '✓ Confirmed'
    button.disabled = true
  } else {
    button.textContent = '+ Add Microsoft Account'
    button.disabled = locked
  }
}

function finishAccountLink() {
  state.accountLinkPending = false
  state.dismissedDeviceCode = ''
  state.accountLinkMode = 'confirmed'
  if (el('deviceDialog').open) el('deviceDialog').close()
  if (state.accountConfirmTimer) clearTimeout(state.accountConfirmTimer)
  state.accountConfirmTimer = setTimeout(() => {
    state.accountLinkMode = 'add'
    state.accountConfirmTimer = null
    renderAccountLinkButton(false)
  }, 3000)
  renderAccountLinkButton(false)
}

function showDeviceCode() {
  const dialog = el('deviceDialog')
  el('deviceMessage').textContent = 'Open Microsoft Link and enter this one-time code. The running FF account will stay connected.'
  el('openMicrosoft').textContent = state.deviceUrl
  el('deviceCode').textContent = state.deviceCode || '--------'
  if (!dialog.open) dialog.showModal()
}

function deviceLoginUrl(payload = {}) {
  const code = String(payload.userCode || '').trim().toUpperCase()
  const fallback = new URL('https://login.live.com/oauth20_remoteconnect.srf')
  try {
    const direct = new URL(payload.directUri || fallback.toString())
    const allowed = ['login.live.com', 'www.microsoft.com', 'microsoft.com']
    if (!allowed.includes(direct.hostname) || direct.protocol !== 'https:') throw new Error('Unsupported Microsoft URL')
    direct.searchParams.set('otc', code)
    return direct.toString()
  } catch {
    fallback.searchParams.set('otc', code)
    return fallback.toString()
  }
}

function renderAccounts(bot = {}) {
  const box = el('accountManager')
  box.replaceChildren()
  const accounts = bot.accounts || []
  if (!accounts.length) {
    const selected = state.instances?.instances?.find(instance => instance.id === state.instances?.selectedId)
    const elsewhere = (state.instances?.instances || []).reduce((total, instance) => total + (instance.id === selected?.id ? 0 : Math.max(0, Number(instance.linkedAccounts) || 0)), 0)
    const empty = document.createElement('p'); empty.className = 'muted small'
    empty.textContent = elsewhere > 0
      ? `No saved accounts for ${selected?.name || 'this instance'}. ${elsewhere} linked account(s) remain on other instances; use the INSTANCE picker to view them.`
      : 'No saved accounts for this instance. Add an account to open Microsoft Link.'
    box.append(empty); return
  }
  const locked = ['connecting', 'authenticated', 'connected'].includes(bot.status)
  accounts.forEach(account => {
    const chip = document.createElement('div'); chip.className = `account-chip ${account.id === bot.activeAccountId ? 'active' : ''}`
    const select = document.createElement('button'); select.type = 'button'; renderIgn(select, account.username || 'Unnamed account'); select.disabled = locked
    select.title = 'Select this account'; select.onclick = () => run(() => window.ff.bot.selectAccount(account.id)).then(renderBot)
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-account'; remove.textContent = '×'; remove.disabled = locked
    remove.title = 'Remove this account'; remove.onclick = async () => {
      if (await ffConfirm('Remove account?', `Remove ${account.username || 'this account'} from this FF instance?`, { confirmLabel: 'Remove', danger: true })) {
        run(() => window.ff.bot.removeAccount(account.id)).then(renderBot)
      }
    }
    chip.append(select, remove); box.append(chip)
  })
}

function renderOrders(bot = {}) {
  const orders = bot.orders || []
  const location = bot.location || {}
  const badge = el('locationBadge')
  badge.className = `badge ${location.known ? location.onIsland ? 'ok' : 'warning' : ''}`
  badge.textContent = location.onIsland
    ? 'YOUR ISLAND'
    : location.known
      ? 'RETURNING TO YOUR ISLAND'
      : 'WAITING FOR YOUR ISLAND'
  for (const type of ['buy', 'sell']) {
    const list = el(type === 'buy' ? 'buyOrderList' : 'sellOrderList')
    const matching = orders.filter(order => order.type === type)
    el(type === 'buy' ? 'buyOrderCount' : 'sellOrderCount').textContent = matching.length
    list.replaceChildren()
    if (!matching.length) {
      const empty = document.createElement('p'); empty.className = 'muted small'; empty.textContent = `No synchronized ${type === 'buy' ? 'buy orders' : 'sell offers'}.`; list.append(empty); continue
    }
    matching.forEach(order => {
      const card = document.createElement('article'); card.className = `order-card ${type}`
      const details = (order.details || []).join(' ')
      const worth = details.match(/worth\s+([\d,.]+\s*[KMGBT]?)\s*coins/i)?.[1]
      const amount = details.match(/(?:order|offer) amount\s*:\s*([\d,]+)x/i)?.[1] || (order.count ? String(order.count) : '—')
      const unitPrice = details.match(/price per unit\s*:\s*([\d,.]+\s*[KMGBT]?)\s*coins/i)?.[1] || '—'
      const owner = details.match(/\bby\s*:\s*([^·]+)/i)?.[1]?.trim() || bot.username || 'Unknown'
      const worthValue = document.createElement('strong'); worthValue.className = 'order-worth'; worthValue.textContent = worth ? `${worth} coins` : '—'
      const worthLabel = document.createElement('span'); worthLabel.className = 'order-worth-label'; worthLabel.textContent = 'ORDER WORTH'
      const progressValue = document.createElement('strong'); progressValue.className = 'order-fill-progress'; progressValue.textContent = `${Number(order.filledCount) || 0} / ${Number(order.totalCount) || Number(amount.replaceAll(',', '')) || 0}`
      const progressLabel = document.createElement('span'); progressLabel.className = 'order-progress-label'; progressLabel.textContent = type === 'buy' ? 'ITEMS FILLED' : 'ITEMS SOLD'
      const worthBox = document.createElement('div'); worthBox.className = 'order-worth-box'; worthBox.append(worthValue, worthLabel, progressValue, progressLabel)
      if (type === 'sell') {
        const totalCoins = Math.max(0, Number(order.totalWorthCoins) || 0)
        const collectedCoins = Math.min(totalCoins || Infinity, Math.max(0, Number(order.collectedCoins) || 0))
        const coinProgress = document.createElement('span'); coinProgress.className = 'order-coin-progress'; coinProgress.textContent = `${formatCoins(collectedCoins)} / ${formatCoins(totalCoins)}`
        const coinProgressLabel = document.createElement('span'); coinProgressLabel.className = 'order-progress-label'; coinProgressLabel.textContent = 'COINS COLLECTED'
        worthBox.append(coinProgress, coinProgressLabel)
      } else {
        // Keep buy and sell cards exactly the same height and vertical rhythm.
        const coinProgress = document.createElement('span'); coinProgress.className = 'order-coin-progress placeholder'; coinProgress.textContent = '0 / 0'
        const coinProgressLabel = document.createElement('span'); coinProgressLabel.className = 'order-progress-label placeholder'; coinProgressLabel.textContent = 'COINS COLLECTED'
        worthBox.append(coinProgress, coinProgressLabel)
      }
      const ageValue = document.createElement('span'); ageValue.className = 'order-age'; ageValue.dataset.orderPlacedAt = String(Number(order.placedAt) || 0)
      const ageLabel = document.createElement('span'); ageLabel.className = 'order-progress-label'; ageLabel.textContent = 'ORDER AGE'
      worthBox.append(ageValue, ageLabel)
      const title = document.createElement('strong'); title.className = 'order-item'; title.textContent = order.itemName
      const detail = document.createElement('small'); detail.textContent = order.details?.join(' · ') || `${order.count || 0} item(s)`
      detail.className = 'order-detail'; detail.textContent = `${amount}x · ${unitPrice} coins / unit`
      const ign = document.createElement('span'); ign.className = 'order-owner'; renderIgn(ign, owner)
      const actions = document.createElement('div'); actions.className = 'order-card-actions'
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button ghost cancel'; cancel.textContent = 'CANCEL ORDER'; cancel.disabled = bot.status !== 'connected'
      cancel.onclick = async () => {
        if (!await ffConfirm('Cancel Bazaar order?', `Cancel ${type === 'buy' ? 'Buy Order' : 'Sell Offer'} for ${order.itemName}?`, { confirmLabel: 'Cancel Order', danger: true })) return
        cancel.disabled = true; cancel.textContent = 'CANCELLING...'
        try {
          await run(() => window.ff.bot.orderAction(order.id, 'cancel'))
          addLog({ at: new Date().toISOString(), level: 'warning', message: `Cancellation started: ${type === 'buy' ? 'Buy Order' : 'Sell Offer'} · ${order.itemName}` })
        } catch { cancel.disabled = false; cancel.textContent = 'CANCEL ORDER' }
      }
      actions.append(cancel); card.append(worthBox, title, detail, ign, actions); list.append(card)
    })
  }
  updateOrderAges()
}

function renderScanner() {
  const running = Boolean(state.market.running)
  el('scannerState').textContent = running ? 'RUNNING' : 'STOPPED'
  el('scannerState').classList.toggle('running', running)
  el('candidateCount').textContent = String(state.market.candidates?.length || 0)
  el('scannerUpdated').textContent = state.market.updatedAt ? `Updated ${time(state.market.updatedAt)}` : 'No market snapshot'
  const best = state.market.candidates?.[0]
  el('bestRate').textContent = `Best: ${formatCoins(best?.coinsPerHour || 0)} coins/h`
}

function renderMarket(market, { force = false } = {}) {
  state.market = { ...state.market, ...market }
  renderScanner()
  if (!force && !pageIsActive('market')) return
  if (state.market.items) renderItems(state.market, { force: true })
  el('marketTimestamp').textContent = market.updatedAt
    ? `${market.productCount} products · API ${new Date(market.apiUpdatedAt || market.updatedAt).toLocaleString()}`
    : 'Not scanned'
  const rows = el('marketRows'); rows.replaceChildren()
  const candidates = market.candidates || []
  if (!candidates.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 13; cell.className = 'empty-cell'; cell.textContent = 'No candidates match the current config and filter.'; row.append(cell); rows.append(row); return
  }
  candidates.slice(0, 100).forEach((item, index) => {
    const row = document.createElement('tr')
    const values = [
      index + 1,
      item.displayName || item.itemId,
      item.source,
      formatCoins(item.buyOffer),
      formatCoins(item.sellOffer),
      formatCoins(item.taxPerUnit),
      formatCoins(item.profitPerUnit),
      `${item.profitPercentage.toFixed(2)}%`,
      item.quantity,
      formatDuration(item.estimatedCycleMinutes),
      `${formatCoins(item.buyDepthTop5)} / ${formatCoins(item.sellDepthTop5)}`,
      `${item.buyPressure.toFixed(0)}%`,
      formatCoins(item.coinsPerHour)
    ]
    values.forEach((value, column) => { const cell = document.createElement('td'); if (column === 2) { const tag = document.createElement('span'); tag.className = `source ${item.source}`; tag.textContent = value; cell.append(tag) } else cell.textContent = value; row.append(cell) })
    rows.append(row)
  })
}

function renderItems(catalog = state.market, { force = false } = {}) {
  state.market = { ...state.market, ...catalog }
  if (!force && !pageIsActive('market')) return
  const query = state.itemQuery.toLowerCase()
  const allItems = state.market.items || []
  const filtered = query
    ? allItems.filter(item => `${item.name} ${item.id} ${item.category} ${item.tier}`.toLowerCase().includes(query))
    : allItems
  const pageSize = 100
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  state.itemPage = Math.min(state.itemPage, pages - 1)
  const visible = filtered.slice(state.itemPage * pageSize, (state.itemPage + 1) * pageSize)
  el('itemCatalogSummary').textContent = `${allItems.length} Bazaar-tradable items · ${filtered.length} matching`
  el('itemsPage').textContent = `Page ${state.itemPage + 1} of ${pages}`
  el('itemsPrevious').disabled = state.itemPage <= 0
  el('itemsNext').disabled = state.itemPage >= pages - 1
  const rows = el('itemRows')
  rows.replaceChildren()
  if (!visible.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 6
    cell.className = 'empty-cell'
    cell.textContent = allItems.length ? 'No items match the search.' : 'Could not load the item catalog.'
    row.append(cell)
    rows.append(row)
    return
  }
  visible.forEach((item, index) => {
    const row = document.createElement('tr')
    const values = [state.itemPage * pageSize + index + 1, item.name, item.id, item.category || '—', item.tier || '—', item.npcSellPrice ? formatCoins(item.npcSellPrice) : '—']
    values.forEach(value => {
      const cell = document.createElement('td')
      cell.textContent = value
      row.append(cell)
    })
    rows.append(row)
  })
}

function renderCollector(collector = {}) {
  state.collector = collector
}

function renderDynamic(strategy) {
  state.dynamic = strategy
  const summary = strategy.summary
  el('dynamicState').textContent = 'PREVIEW READY'
  el('dynamicState').classList.add('ok')
  el('dynamicSummary').textContent = `${summary.selectedItems} selected · ${summary.blacklistedItems} blacklisted · max spend ${formatCoins(summary.maxSpendPerOrder)} · projected ${formatCoins(summary.projectedCoinsPerHour)} coins/h`
  const top = el('dynamicTop'); top.replaceChildren()
  strategy.topItems.slice(0, 12).forEach(item => {
    const badge = document.createElement('span')
    badge.className = 'dynamic-item'
    badge.textContent = `${item.itemId} · Vol ${formatCoins(item.flow)}/h · ${formatCoins(item.coinsPerHour)} coins/h · ${item.roi.toFixed(1)}%`
    top.append(badge)
  })
  el('configEditor').value = `${JSON.stringify(strategy.config, null, 2)}\n`
  el('filterEditor').value = `${JSON.stringify(strategy.filter, null, 2)}\n`
  el('applyDynamic').disabled = false
}

function linearPath(points) {
  if (!points.length) return ''
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
}

function compactProfitHistory(rawHistory = []) {
  const valid = rawHistory.filter(point => Number.isFinite(Number(point?.at)) && Number.isFinite(Number(point?.profit)))
  return valid.filter((point, index) => index === 0 || Number(point.profit) !== Number(valid[index - 1].profit))
}

function compactLimitHistory(rawHistory = []) {
  const valid = rawHistory.filter(point => Number.isFinite(Number(point?.at)))
  return valid.filter((point, index) => {
    if (index === 0) return true
    const previous = valid[index - 1]
    return ['buy', 'sell', 'total'].some(key => Number(point[key]) !== Number(previous[key]))
  })
}

function renderProfitTrend(rawHistory = []) {
  const changes = compactProfitHistory(rawHistory)
  const latest = changes.at(-1)
  const previous = changes.at(-2)
  const delta = latest && previous ? Number(latest.profit) - Number(previous.profit) : 0
  const live = state.bot.status === 'connected'
  const trend = el('graphTrend')
  trend.className = `graph-trend ${delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'}`
  const direction = delta > 0 ? '↑' : delta < 0 ? '↓' : '→'
  const change = delta === 0 ? 'NO REALIZED CHANGE' : `${delta > 0 ? '+' : '−'}${formatCoins(Math.abs(delta))} LAST CHANGE`
  trend.textContent = `${live ? 'LIVE' : 'PAUSED'} · ${direction} ${change}`
}

function renderTrackerGraph(tracker = {}, mode = 'profit') {
  const isProfit = mode === 'profit'
  const svg = el(isProfit ? 'trackerChart' : 'limitTrackerChart'); svg.replaceChildren()
  const rawHistory = Array.isArray(isProfit ? tracker.profitHistory : tracker.history) ? (isProfit ? tracker.profitHistory : tracker.history) : []
  // Both graphs are event-based. Idle/disconnected wall-clock gaps do not
  // extend the line: it pauses at the last real change and resumes on the
  // next flip.
  const history = isProfit ? compactProfitHistory(rawHistory) : compactLimitHistory(rawHistory)
  const ns = 'http://www.w3.org/2000/svg'; const width = 1000; const height = 330; const left = 70; const right = 18; const top = 18; const bottom = 35
  const series = isProfit ? [{ key: 'profit', label: 'Final profit', color: '#36dc91' }] : [{ key: 'buy', label: 'Buy limit', color: '#36dc91' }, { key: 'sell', label: 'Sell limit', color: '#ffc14e' }, { key: 'total', label: 'Total', color: '#b36cff' }]
  const legend = el(isProfit ? 'trackerLegend' : 'limitTrackerLegend'); legend.replaceChildren()
  series.forEach(item => { const tag = document.createElement('span'); tag.style.setProperty('--series', item.color); tag.textContent = item.label; legend.append(tag) })
  if (!history.length) {
    const empty = document.createElementNS(ns, 'text'); empty.setAttribute('x', '500'); empty.setAttribute('y', '165'); empty.setAttribute('text-anchor', 'middle'); empty.setAttribute('class', 'chart-empty'); empty.textContent = 'The graph will appear after the first Bazaar action.'; svg.append(empty)
    return
  }
  const minTime = Number(history[0].at); const maxTime = Math.max(minTime + 1, Number(history.at(-1).at))
  const values = history.flatMap(point => series.map(item => Number(point[item.key]) || 0))
  const minValue = isProfit ? Math.min(0, ...values) : 0
  let maxValue = Math.max(0, ...values)
  if (maxValue <= minValue) maxValue = minValue + 1
  const span = maxValue - minValue
  for (let line = 0; line <= 4; line += 1) {
    const y = top + (height - top - bottom) * line / 4
    const grid = document.createElementNS(ns, 'line'); grid.setAttribute('x1', left); grid.setAttribute('x2', width - right); grid.setAttribute('y1', y); grid.setAttribute('y2', y); grid.setAttribute('class', 'chart-grid'); svg.append(grid)
    const label = document.createElementNS(ns, 'text'); label.setAttribute('x', left - 10); label.setAttribute('y', y + 4); label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'chart-axis-label'); label.textContent = formatCoins(maxValue - span * line / 4); svg.append(label)
  }
  series.forEach(item => {
    const points = history.map((point, index) => ({
      x: left + index / Math.max(1, history.length - 1) * (width - left - right),
      y: top + (maxValue - (Number(point[item.key]) || 0)) / span * (height - top - bottom)
    }))
    if (isProfit && points.length > 1) {
      const area = document.createElementNS(ns, 'path')
      area.setAttribute('d', `${linearPath(points)} L ${points.at(-1).x} ${height - bottom} L ${points[0].x} ${height - bottom} Z`)
      area.setAttribute('class', 'chart-area chart-profit-area')
      area.setAttribute('fill', item.color)
      svg.append(area)
    }
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', linearPath(points)); path.setAttribute('class', 'chart-line'); path.setAttribute('stroke', item.color); path.style.color = item.color; svg.append(path)
    const last = points.at(-1); const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', last.x); dot.setAttribute('cy', last.y); dot.setAttribute('r', '5'); dot.setAttribute('fill', '#0d1118'); dot.setAttribute('stroke', item.color); dot.setAttribute('stroke-width', '3'); svg.append(dot)
  })
  if (history.length > 1) {
    const startLabel = document.createElementNS(ns, 'text'); startLabel.setAttribute('x', left); startLabel.setAttribute('y', height - 8); startLabel.setAttribute('class', 'chart-axis-label'); startLabel.textContent = time(new Date(minTime).toISOString()); svg.append(startLabel)
    const endLabel = document.createElementNS(ns, 'text'); endLabel.setAttribute('x', width - right); endLabel.setAttribute('y', height - 8); endLabel.setAttribute('text-anchor', 'end'); endLabel.setAttribute('class', 'chart-axis-label'); endLabel.textContent = time(new Date(maxTime).toISOString()); svg.append(endLabel)
  }
}

function renderGraphMode() {
  const profit = state.graphMode === 'profit'
  el('profitGraphView').classList.toggle('hidden', !profit)
  el('limitGraphView').classList.toggle('hidden', profit)
  el('trackerEyebrow').textContent = profit ? 'CUMULATIVE PROFIT' : 'CUMULATIVE ORDER LIMITS'
  el('trackerChartTitle').textContent = profit ? 'Final Profit Curve' : 'Buy, Sell & Total'
  el('graphCounter').textContent = `GRAPH ${profit ? 1 : 2} OF 2`
  el('graphTrend').classList.toggle('hidden', !profit)
  renderGraphMetrics(state.automation?.tracker || {})
}

function renderGraphMetrics(tracker = {}) {
  const profit = Number(tracker.profit) || 0
  const profitPerHour = Number(tracker.profitPerHour) || 0
  const used = Number(tracker.dailyLimitUsed) || 0
  const money = coins => `$${(coins / 1_000_000 * 0.025).toFixed(2)}`
  const nextReset = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)
  const limitReset = formatClock((nextReset - Date.now()) / 1000)
  const metrics = state.graphMode === 'profit'
    ? [['EARNED COINS', formatCoins(profit)], ['COINS / HOUR', formatCoins(profitPerHour)], ['EARNED USD', money(profit)], ['USD / HOUR', money(profitPerHour)]]
    : [['BUY LIMIT', formatCoins(tracker.buyOfferValue || 0)], ['SELL LIMIT', formatCoins(tracker.sellOfferValue || 0)], ['TOTAL LIMIT', formatCoins(used)], ['ESTIMATED TIME TO 15B', tracker.estimatedSecondsToLimit === null || tracker.estimatedSecondsToLimit === undefined ? '—' : formatClock(tracker.estimatedSecondsToLimit)], ['LIMIT RESET', limitReset]]
  el('graphMetrics').classList.toggle('limit-metrics', state.graphMode === 'limit')
  el('graphMetrics').replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement('div'); const caption = document.createElement('span'); const amount = document.createElement('strong')
    caption.textContent = label; amount.textContent = value; card.append(caption, amount); return card
  }))
}

function trackerGraphSignature(tracker = {}) {
  const history = Array.isArray(tracker.history) ? tracker.history : []
  const profitHistory = Array.isArray(tracker.profitHistory) ? tracker.profitHistory : []
  const lastLimit = history.at(-1) || {}
  const lastProfit = profitHistory.at(-1) || {}
  return `${history.length}:${lastLimit.at || 0}:${lastLimit.total || 0}|${profitHistory.length}:${lastProfit.at || 0}:${lastProfit.profit || 0}`
}

function renderTracker(tracker = {}, { forceGraphs = false } = {}) {
  const profit = Number(tracker.profit) || 0; const used = Number(tracker.dailyLimitUsed) || 0
  renderIgn(el('ffUsername'), state.bot.username || tracker.account || 'Not connected')
  el('ffPurse').textContent = tracker.purse === null || tracker.purse === undefined ? '—' : `${formatCoins(tracker.purse)} coins`
  el('ffProfit').textContent = `${profit >= 0 ? '+' : ''}${formatCoins(profit)}`; el('ffProfitHour').textContent = `${formatCoins(tracker.profitPerHour || 0)}/h`; el('ffRunning').textContent = formatClock(tracker.uptimeSeconds || tracker.runningSeconds || 0)
  el('sideBuyLimit').textContent = formatCoins(tracker.buyOfferValue || 0)
  el('sideSellLimit').textContent = formatCoins(tracker.sellOfferValue || 0)
  el('sideTotalLimit').textContent = formatCoins(used)
  el('limitEta').textContent = tracker.estimatedSecondsToLimit === null || tracker.estimatedSecondsToLimit === undefined ? '—' : formatClock(tracker.estimatedSecondsToLimit)
  const now = new Date(); const nextReset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); el('limitReset').textContent = formatClock((nextReset - Date.now()) / 1000)
  const graphSignature = trackerGraphSignature(tracker)
  if (pageIsActive('dashboard') && (forceGraphs || graphSignature !== state.trackerGraphSignature)) {
    renderProfitTrend(Array.isArray(tracker.profitHistory) ? tracker.profitHistory : [])
    renderTrackerGraph(tracker, 'profit')
    renderTrackerGraph(tracker, 'limit')
    renderGraphMode()
    state.trackerGraphSignature = graphSignature
  } else if (pageIsActive('dashboard')) renderGraphMetrics(tracker)
}

function renderProxy(proxy = {}) {
  const active = proxy.enabled === true
  el('ffProxy').textContent = active ? 'ACTIVE' : 'OFF'
  el('ffProxy').style.color = active ? 'var(--green)' : 'var(--muted)'
  el('ffProxyCountry').textContent = active ? `Country: ${proxy.country || 'Unknown'}${proxy.ip ? ` · ${proxy.ip}${proxy.port ? `:${proxy.port}` : ''}` : ''}` : 'Direct connection'
}

function renderAutomation(automation = {}, { forceFeed = false, forceGraphs = false } = {}) {
  const previousTracker = state.automation.tracker || {}
  state.automation = {
    ...state.automation,
    ...automation,
    tracker: automation.tracker ? { ...previousTracker, ...automation.tracker } : previousTracker
  }
  if (automation.tracker) state.trackerReceivedAt = Date.now()
  const current = state.automation
  const target = current.target?.displayName || current.target?.itemName || 'None'
  const status = current.status || 'WAITING'
  const phase = current.phase || 'idle'
  const stash = state.automation.stash || {}
  const stashWarning = el('stashWarning')
  const stashCount = Number.isFinite(Number(stash.itemCount)) && Number(stash.itemCount) > 0
    ? `${Math.floor(Number(stash.itemCount))} item${Number(stash.itemCount) === 1 ? '' : 's'} detected. `
    : ''
  stashWarning.classList.toggle('hidden', stash.blocked !== true)
  el('stashWarningText').textContent = `${stashCount}Run /pickupstash item when convenient. Trading continues normally; this warning stays until Hypixel confirms the stash is empty.`
  el('actionsStatus').textContent = status
  el('actionsPhase').textContent = phase
  el('actionsTarget').textContent = target
  el('actionsLastAt').textContent = current.lastActionAt ? time(current.lastActionAt) : '—'
  const badge = el('actionsAutoBadge')
  badge.textContent = current.enabled ? 'AUTO ENABLED' : 'AUTO DISABLED'
  badge.classList.toggle('ok', Boolean(current.enabled))
  const counts = current.counts || {}
  if (automation.tracker || forceGraphs) renderTracker(current.tracker || {}, { forceGraphs })
  el('countBuyOrders').textContent = counts.buyOrders || 0
  el('countSellOffers').textContent = counts.sellOffers || 0
  el('countClaimedItems').textContent = counts.claimedItems || 0
  el('countClaimedCoins').textContent = counts.claimedCoins || 0
  el('countRelists').textContent = counts.cancelled || 0
  el('countRecoveries').textContent = counts.recoveries || 0
  if (!forceFeed && !pageIsActive('actions')) return
  const feed = el('automationFeed')
  feed.replaceChildren()
  const activity = current.activity || []
  if (!activity.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No automatic actions yet.'; feed.append(empty); return
  }
  activity.forEach(entry => {
    const row = document.createElement('div'); row.className = 'automation-entry'
    const stamp = document.createElement('time'); stamp.textContent = time(entry.at)
    const kind = document.createElement('b'); kind.className = entry.kind; kind.textContent = entry.kind
    const message = document.createElement('span'); message.textContent = entry.message
    const item = document.createElement('small'); item.textContent = entry.target || ''
    row.append(stamp, kind, message, item); feed.append(row)
  })
}

function activityLogRow(entry) {
  const row = document.createElement('div'); row.className = 'activity-row'
  const stamp = document.createElement('time'); stamp.textContent = time(entry.at)
  const levelName = String(entry.level || 'info')
  const level = document.createElement('b'); level.className = levelName; level.textContent = levelName.toUpperCase()
  const message = document.createElement('span'); message.textContent = entry.message
  if (entry.level === 'chat' && entry.ansi) { message.textContent = entry.ansi.replace(/\x1b\[[0-9;]*m/g, ''); message.className = 'minecraft-chat' }
  row.append(stamp, level, message)
  return row
}

function renderActivityFeed() {
  const feed = el('activityFeed')
  if (!feed || !pageIsActive('dashboard')) return
  const recent = state.logs.slice(-30).reverse()
  feed.replaceChildren(...(recent.length ? recent.map(activityLogRow) : [Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No events yet.' })]))
  const logOutput = el('logOutput')
  if (logOutput) {
    logOutput.textContent = state.logs.map(item => `${time(item.at)}  ${String(item.level || 'info').toUpperCase().padEnd(7)}  ${item.message}`).join('\n') || 'No events yet.'
    logOutput.scrollTop = logOutput.scrollHeight
  }
}

function addLogs(entries = []) {
  state.logs.push(...entries)
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500)
  renderActivityFeed()
}

function addLog(entry) { addLogs([entry]) }

function showFileMessage(message, error = false) { const box = el('fileMessage'); box.textContent = message; box.classList.remove('hidden'); box.classList.toggle('error', error) }
function renderProxy(config = {}) {
  if (!Object.hasOwn(config, 'proxy')) {
    const active = config.enabled === true
    el('ffProxy').textContent = active ? 'ACTIVE' : 'OFF'
    el('ffProxy').style.color = active ? 'var(--green)' : 'var(--muted)'
    el('ffProxyCountry').textContent = active ? `Country: ${config.country || 'Unknown'}${config.ip ? ` · ${config.ip}${config.port ? `:${config.port}` : ''}` : ''}` : 'Direct connection'
    return
  }
  const proxy = config.proxy || {}; el('proxyEnabled').value = String(Boolean(proxy.enabled)); el('proxyType').value = proxy.type || 'socks5'; el('proxyHost').value = proxy.ip || proxy.host || ''; el('proxyPort').value = Number(proxy.port) || 1080; el('proxyCountry').value = proxy.country || ''; el('proxyUsername').value = proxy.username || ''; el('proxyPassword').value = proxy.password || ''
}
function editorContent(file) {
  if (file.kind !== 'config') return file.content
  const visible = structuredClone(file.parsed || {})
  // Runtime-only and unsupported web/key fields stay internal. The editor is
  // intentionally the compact FF profile the user manages per account.
  for (const key of ['key', 'webhook', 'detailedWebhooks', 'friendlyKeys', 'automation', 'sessionBreakdown', 'collector', 'discord', 'scanner', 'taxPercent', 'accountLabel']) delete visible[key]
  return `${JSON.stringify(visible, null, 2)}\n`
}
function loadFile(file) {
  state.privateFiles[file.kind] = editorContent(file)
  state.privateParsed[file.kind] = file.parsed
  state.privateErrors[file.kind] = file.errors
  const editor = el(`${file.kind}Editor`)
  editor.value = state.revealedFiles[file.kind] ? file.content : 'Sensitive file hidden. Select Reveal editor to view or edit this JSON.'
  editor.classList.toggle('sensitive-hidden', !state.revealedFiles[file.kind])
  const badge = el(`${file.kind}State`); badge.textContent = file.errors.length ? `${file.errors.length} ERRORS` : 'VALID'; badge.classList.toggle('ok', !file.errors.length)
  if (file.kind === 'config') {
    renderProxy(file.parsed)
    const trader = file.parsed?.automation?.autoTrader || {}
    if (Number.isFinite(Number(trader.strategyPurse))) el('dynamicPurse').value = String(Number(trader.strategyPurse))
    if (Number.isFinite(Number(trader.strategyLookbackHours))) el('dynamicLookback').value = String(Number(trader.strategyLookbackHours))
  }
}
function toggleRevealFile(kind) {
  state.revealedFiles[kind] = !state.revealedFiles[kind]
  const button = document.querySelector(`[data-reveal="${kind}"]`)
  if (button) button.textContent = state.revealedFiles[kind] ? 'Hide editor' : 'Reveal editor'
  loadFile({ kind, content: state.privateFiles[kind] || '', parsed: state.privateParsed[kind] || {}, errors: state.privateErrors[kind] || [] })
}

async function saveFile(kind) {
  try { const file = await window.ff.files.save(kind, el(`${kind}Editor`).value); loadFile(file); showFileMessage(`${kind}.json saved. Previous version was backed up.`) } catch (error) { showFileMessage(error.message, true) }
}
async function importFile(kind) { try { const result = await window.ff.files.import(kind); if (!result.canceled) { loadFile(result.file); showFileMessage(`${kind}.json imported and validated.`) } } catch (error) { showFileMessage(error.message, true) } }
async function restoreFile(kind) { if (!await ffConfirm('Restore previous file?', `Restore the previous ${kind}.json?`, { confirmLabel: 'Restore', danger: true })) return; try { const file = await window.ff.files.restore(kind); loadFile(file); showFileMessage(`Previous ${kind}.json restored.`) } catch (error) { showFileMessage(error.message, true) } }
async function saveProxy() {
  try {
    const config = JSON.parse(el('configEditor').value)
    config.proxy = { enabled: el('proxyEnabled').value === 'true', ip: el('proxyHost').value.trim(), port: Number(el('proxyPort').value), country: el('proxyCountry').value.trim(), username: el('proxyUsername').value, password: el('proxyPassword').value }
    const file = await window.ff.files.save('config', `${JSON.stringify(config, null, 2)}\n`); loadFile(file); showFileMessage('Proxy settings saved in config.json.')
  } catch (error) { showFileMessage(`Proxy settings: ${error.message}`, true) }
}

function hubVectorText(value) {
  const point = Array.isArray(value)
    ? { x: value[0], y: value[1], z: value[2] }
    : (value && typeof value === 'object' ? value : {})
  const values = ['x', 'y', 'z'].map(axis => Number(point[axis]))
  if (!values.every(Number.isFinite)) return '—'
  return values.map((number, index) => `${['X', 'Y', 'Z'][index]} ${number.toFixed(1)}`).join(' · ')
}

function hubRouteValues(hub = {}) {
  const route = hub.route && typeof hub.route === 'object' ? hub.route : {}
  const current = Math.max(0, Number(route.current ?? route.index ?? hub.currentWaypoint ?? hub.routeIndex) || 0)
  const total = Math.max(0, Number(route.total ?? hub.totalWaypoints ?? hub.routeLength) || 0)
  const explicit = Number(route.progress ?? hub.progress)
  const progress = Number.isFinite(explicit)
    ? Math.max(0, Math.min(1, explicit > 1 ? explicit / 100 : explicit))
    : total > 0 ? Math.max(0, Math.min(1, current / total)) : 0
  return { current, total, progress }
}

const HUB_ACTIVITY_DESCRIPTIONS = Object.freeze({
  'ultra-low': 'Very rare short walks: normally rests for 5–10 minutes between movement sessions; minimal background Bazaar checks.',
  low: 'Mostly idle: short walks separated by long, varied breaks; rare background Bazaar checks.',
  medium: 'Balanced walking periods, natural idle breaks, and occasional background Bazaar checks.',
  high: 'Longer walking periods with shorter breaks and more frequent background Bazaar checks.',
  'no-bazaar': 'Varied walking and idle periods without background /bz commands or Bazaar NPC interactions.'
})
const HUB_HUMANIZER_DESCRIPTIONS = Object.freeze({
  1: 'Classic movement and camera timing from the previous humanizer.',
  2: 'Continuous pathfinder steering, fluid camera tracking, and effect-aware jumping without competing movement inputs.'
})

function rememberHubState(payload, fallbackInstanceId = state.hubSelectedId, { render = true } = {}) {
  if (!payload || typeof payload !== 'object') return null
  if (Array.isArray(payload.instances)) {
    payload.instances.forEach(item => rememberHubState(item?.hub || item, item?.instanceId || item?.id, { render: false }))
    if (render && pageIsActive('roaming')) renderHubState()
    return null
  }
  const nested = payload.hub && typeof payload.hub === 'object'
    ? payload.hub
    : payload.state && typeof payload.state === 'object' ? payload.state : null
  const next = nested ? { ...payload, ...nested } : payload
  const instanceId = String(next.instanceId || next.id || fallbackInstanceId || '')
  if (!instanceId) return null
  const previous = state.hubStates[instanceId] || {}
  const hasPosition = Object.prototype.hasOwnProperty.call(next, 'position')
  const hasGoal = Object.prototype.hasOwnProperty.call(next, 'goal')
  state.hubStates[instanceId] = {
    ...previous,
    ...next,
    instanceId,
    position: hasPosition
      ? next.position === null ? null : Array.isArray(next.position) ? [...next.position] : { ...(previous.position || {}), ...next.position }
      : previous.position,
    goal: hasGoal
      ? next.goal === null ? null : Array.isArray(next.goal) ? [...next.goal] : { ...(previous.goal || {}), ...next.goal }
      : previous.goal,
    route: next.route ? { ...(previous.route || {}), ...next.route } : previous.route
  }
  if (render && pageIsActive('roaming')) renderHubState()
  return state.hubStates[instanceId]
}

function selectedHubInstance() {
  return (state.instances?.instances || []).find(instance => instance.id === state.hubSelectedId) || null
}

function renderHubInstances(data = state.instances) {
  const picker = el('hubInstancePicker')
  if (!picker) return
  const instances = Array.isArray(data?.instances) ? data.instances : []
  let hasHubSnapshots = false
  for (const instance of instances) {
    if (!instance?.hub || typeof instance.hub !== 'object') continue
    hasHubSnapshots = true
    rememberHubState(instance.hub, instance.id, { render: false })
  }
  const signature = instances.map(instance => `${instance.id}:${instance.name}:${instance.running === true}`).join('|')
  const selectedExists = instances.some(instance => instance.id === state.hubSelectedId)
  if (!selectedExists) {
    const preferred = instances.find(instance => instance.id === data?.selectedId) || instances[0]
    state.hubSelectedId = preferred?.id || ''
  }
  if (signature !== state.hubInstancesSignature) {
    state.hubInstancesSignature = signature
    picker.replaceChildren()
    if (!instances.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'No instances configured'
      picker.append(option)
    } else {
      picker.append(...instances.map(instance => {
        const option = document.createElement('option')
        option.value = instance.id
        option.textContent = `${instance.name}${instance.running === true ? ' · Connected' : ' · Disconnected'}`
        return option
      }))
    }
  }
  picker.value = state.hubSelectedId
  if (pageIsActive('roaming')) renderHubState()
}

function renderHubState() {
  if (!el('hubRoamingStatus')) return
  const instance = selectedHubInstance()
  const hub = state.hubStates[state.hubSelectedId] || {}
  const enabled = hub.enabled === true || hub.running === true
  const modeActive = enabled || hub.modeActive === true
  const paused = enabled && hub.paused === true
  const connected = typeof instance?.running === 'boolean' ? instance.running : hub.connected === true
  const loading = state.hubStatusRequest?.instanceId === state.hubSelectedId
  const route = hubRouteValues(hub)
  const location = typeof hub.location === 'object' ? hub.location.name : hub.location
  const status = String(hub.status || (enabled ? paused ? 'PAUSED' : 'ROAMING' : connected ? 'READY' : 'OFFLINE')).toUpperCase()
  const error = String(hub.error || hub.lastError || '')
  const updatedAt = hub.updatedAt || hub.observedAt || hub.at
  const busy = state.hubBusy
  const action = state.hubAction
  // Trading and randomized idle periods also set `paused`, but only an
  // explicit user pause turns this control into Resume.
  const userPaused = hub.userPaused === true
  const pauseLabel = userPaused ? 'Resume' : 'Pause'

  el('hubInstanceName').textContent = instance?.name || 'No instance selected'
  el('hubPathState').textContent = status
  el('hubLocation').textContent = String(location || instance?.stats?.location || 'Unknown')
  el('hubCoordinates').textContent = hubVectorText(hub.position || hub.coordinates)
  el('hubGoal').textContent = hubVectorText(hub.goal || hub.target)
  el('hubRouteProgress').textContent = `${route.current} / ${route.total}`
  const progressPercent = Number((route.progress * 100).toFixed(1))
  el('hubProgressBar').style.width = `${progressPercent}%`
  const progressTrack = el('hubProgressTrack')
  progressTrack.setAttribute('aria-valuenow', String(progressPercent))
  progressTrack.setAttribute('aria-valuetext', route.total > 0 ? `Waypoint ${route.current} of ${route.total}` : 'No active route')
  el('hubLastUpdate').textContent = updatedAt && Number.isFinite(Date.parse(updatedAt)) ? time(updatedAt) : '—'

  const confirmedActivityMode = HUB_ACTIVITY_DESCRIPTIONS[hub.activityMode] ? hub.activityMode : 'medium'
  const activityMode = HUB_ACTIVITY_DESCRIPTIONS[state.hubPendingActivityMode] ? state.hubPendingActivityMode : confirmedActivityMode
  const activityLabel = hub.activityLabel || (confirmedActivityMode === 'ultra-low' ? 'Ultra Low Activity' : confirmedActivityMode === 'low' ? 'Low Activity' : confirmedActivityMode === 'high' ? 'High Activity' : confirmedActivityMode === 'no-bazaar' ? 'No Bazaar' : 'Medium Activity')
  el('hubActivityMode').value = activityMode
  el('hubActivityMode').disabled = busy || loading || !instance
  el('hubActivityDescription').textContent = HUB_ACTIVITY_DESCRIPTIONS[activityMode]
  el('hubActivityConfirmation').textContent = `${state.hubPendingActivityMode ? 'APPLYING' : 'APPLIED'} TO ${String(instance?.name || 'THIS INSTANCE').toUpperCase()}: ${String(state.hubPendingActivityMode ? activityMode : activityLabel).replaceAll('-', ' ').toUpperCase()}`
  el('hubActivityConfirmation').className = `hub-activity-confirmation ${state.hubPendingActivityMode ? 'pending' : 'confirmed'}`
  el('hubAppliedActivityMode').textContent = String(activityLabel).toUpperCase()
  const humanizerVersion = Number(hub.humanizerVersion) === 1 ? 1 : 2
  el('hubHumanizerVersion').value = String(humanizerVersion)
  el('hubHumanizerVersion').disabled = busy || loading || !instance
  el('hubHumanizerDescription').textContent = HUB_HUMANIZER_DESCRIPTIONS[humanizerVersion]

  const godPotion = hub.godPotion && typeof hub.godPotion === 'object' ? hub.godPotion : {}
  const godPotionActive = godPotion.godPotionActive === true
  const godPotionNode = el('hubGodPotion')
  godPotionNode.textContent = godPotionActive ? 'ACTIVE' : 'NOT DETECTED'
  godPotionNode.className = godPotionActive ? 'active' : 'inactive'
  el('hubMovementEffects').textContent = `Speed ${Math.max(0, Number(godPotion.speedLevel) || 0)} · Jump ${Math.max(0, Number(godPotion.jumpBoostLevel) || 0)} · ${Math.max(0, Number(godPotion.activeEffectCount) || 0)} effects`

  const statusBadge = el('hubRoamingStatus')
  statusBadge.className = `badge ${loading ? 'warning' : enabled && !paused ? 'ok' : connected ? 'warning' : ''}`
  statusBadge.textContent = loading ? 'REFRESHING' : status
  const connectionBadge = el('hubConnectionStatus')
  connectionBadge.className = `badge ${connected ? 'ok' : ''}`
  connectionBadge.textContent = connected ? 'CONNECTED' : 'DISCONNECTED'

  el('page-roaming').setAttribute('aria-busy', String(busy || loading))
  el('hubInstancePicker').disabled = busy
  el('hubTeleport').disabled = busy || loading || !connected || !instance || enabled
  el('hubTeleport').textContent = action === 'teleport' ? 'Teleporting…' : 'Teleport /hub'
  el('hubStart').disabled = busy || loading || !connected || enabled
  el('hubStart').textContent = action === 'start' ? 'Starting…' : 'Start Roaming'
  el('hubPauseResume').disabled = busy || loading || !connected || !enabled
  el('hubPauseResume').textContent = action === 'pause' ? 'Pausing…' : action === 'resume' ? 'Resuming…' : pauseLabel
  el('hubStop').disabled = busy || !modeActive
  el('hubStop').textContent = action === 'stop' ? 'Stopping…' : 'Stop'
  el('hubExportDiagnostics').disabled = busy || !instance
  el('hubExportDiagnostics').textContent = action === 'exportDiagnostics' ? 'Exporting…' : 'Export Hub Diagnostics'

  const notice = el('hubRoamingNotice')
  notice.className = 'hub-roaming-notice muted'
  if (busy) {
    const descriptions = { teleport: 'Requesting /hub', start: 'Starting Hub Roaming', pause: 'Pausing Hub Roaming', resume: 'Resuming Hub Roaming', stop: 'Stopping Hub Roaming', setActivityMode: 'Changing the activity mode', setHumanizerVersion: 'Changing the humanizer version', exportDiagnostics: 'Exporting Hub diagnostics' }
    notice.textContent = `${descriptions[action] || 'Applying the requested Hub action'} for ${instance?.name || 'the selected instance'}…`
  }
  else if (loading) notice.textContent = `Refreshing Hub Roaming status for ${instance?.name || 'the selected instance'}…`
  else if (state.hubNotice) {
    if (state.hubNotice.kind) notice.classList.add(state.hubNotice.kind)
    notice.textContent = state.hubNotice.text
  }
  else if (!instance) notice.textContent = 'Add an instance before using Hub Roaming.'
  else if (!connected) notice.textContent = 'Start this instance before teleporting or enabling Hub Roaming.'
  else if (status === 'TRADING') { notice.classList.add('warning'); notice.textContent = 'Movement is temporarily paused while Bazaar trading has priority.' }
  else if (status === 'RESUMING SOON') { notice.classList.add('warning'); notice.textContent = 'Bazaar trading finished. Movement will resume after a short safety delay.' }
  else if (status === 'IDLING') { notice.classList.add('warning'); notice.textContent = 'Taking a randomized idle break; walking will resume automatically.' }
  else if (status === 'CLOSING MENU') { notice.classList.add('warning'); notice.textContent = 'Closing the completed Bazaar menu before movement resumes.' }
  else if (status === 'WAITING FOR HUB' || status === 'TELEPORTING') { notice.classList.add('warning'); notice.textContent = 'Waiting for the server to confirm a supported Hub location before movement starts.' }
  else if (paused) { notice.classList.add('warning'); notice.textContent = 'Hub Roaming is paused by the user.' }
  else if (enabled) { notice.classList.add('ok'); notice.textContent = 'Hub Roaming is active for this instance.' }
  else notice.textContent = 'This instance has its own independent Hub Roaming engine and activity schedule.'

  const errorNode = el('hubRoamingError')
  errorNode.textContent = error
  errorNode.classList.toggle('hidden', !error)
}

async function refreshHubStatus() {
  const instanceId = state.hubSelectedId
  if (!instanceId || !window.ff.hub?.status) return renderHubState()
  const requestId = ++state.hubStatusRequestSequence
  state.hubStatusRequest = { instanceId, requestId }
  const requestIds = state.hubStatusRequestIds || (state.hubStatusRequestIds = {})
  requestIds[instanceId] = requestId
  rememberHubState({ instanceId, error: '', lastError: '' })
  try {
    const result = await window.ff.hub.status(instanceId)
    if (requestIds[instanceId] === requestId) rememberHubState(result, instanceId)
  } catch (error) {
    if (requestIds[instanceId] === requestId) rememberHubState({ instanceId, error: error?.message || String(error) }, instanceId)
  }
  finally {
    if (state.hubStatusRequest?.requestId === requestId) state.hubStatusRequest = null
    if (pageIsActive('roaming')) renderHubState()
  }
}

async function runHubAction(method, ...args) {
  const instanceId = state.hubSelectedId
  const api = window.ff.hub?.[method]
  if (!instanceId || typeof api !== 'function' || state.hubBusy) return
  state.hubBusy = true
  state.hubAction = method
  state.hubNotice = null
  rememberHubState({ instanceId, error: '', lastError: '' })
  renderHubState()
  try {
    const result = await api(instanceId, ...args)
    if (method === 'exportDiagnostics') {
      state.hubNotice = {
        kind: result?.canceled ? '' : 'ok',
        text: result?.canceled ? 'Diagnostics export cancelled.' : `Hub diagnostics exported${result?.path ? `: ${result.path}` : '.'}`
      }
    } else {
      rememberHubState(result || { instanceId }, instanceId)
      if (method === 'setActivityMode') {
        const label = result?.activityLabel || result?.activityMode || args[0]
        state.hubNotice = { kind: 'ok', text: `Activity mode confirmed for ${selectedHubInstance()?.name || instanceId}: ${label}.` }
      }
    }
  } catch (error) {
    rememberHubState({ instanceId, error: error?.message || String(error) }, instanceId)
  } finally {
    if (method === 'setActivityMode') state.hubPendingActivityMode = ''
    state.hubBusy = false
    state.hubAction = ''
    renderHubState()
  }
}

document.querySelectorAll('.tab').forEach(button => button.onclick = () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === button))
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === `page-${button.dataset.page}`))
  const page = button.dataset.page
  if (page === 'dashboard') {
    renderActivityFeed()
    renderTracker(state.automation.tracker || {}, { forceGraphs: true })
  } else if (page === 'stats') renderStats(state.instances, { force: true })
  else if (page === 'roaming') { renderHubInstances(state.instances); refreshHubStatus() }
  else if (page === 'actions') renderAutomation(state.automation, { forceFeed: true })
  else if (page === 'market') renderMarket(state.market, { force: true })
  else if (page === 'files') {
    renderProxyPool(state.proxyPool)
    renderInstanceEditor()
  }
})
el('hubInstancePicker').onchange = event => {
  state.hubSelectedId = String(event.target.value || '')
  state.hubNotice = null
  renderHubState()
  refreshHubStatus()
}
el('hubTeleport').onclick = () => runHubAction('teleport')
el('hubStart').onclick = () => runHubAction('start')
el('hubPauseResume').onclick = () => {
  const hub = state.hubStates[state.hubSelectedId] || {}
  return runHubAction(hub.userPaused === true ? 'resume' : 'pause')
}
el('hubStop').onclick = () => runHubAction('stop')
el('hubActivityMode').onchange = event => {
  const activityMode = String(event.target.value || 'medium')
  // The selector may show the pending choice, but the confirmation label is
  // updated only from the authoritative per-instance engine response.
  state.hubPendingActivityMode = activityMode
  renderHubState()
  return runHubAction('setActivityMode', activityMode)
}
el('hubHumanizerVersion').onchange = event => {
  const humanizerVersion = Number(event.target.value) === 1 ? 1 : 2
  rememberHubState({ instanceId: state.hubSelectedId, humanizerVersion }, state.hubSelectedId)
  renderHubState()
  return runHubAction('setHumanizerVersion', humanizerVersion)
}
el('hubExportDiagnostics').onclick = () => runHubAction('exportDiagnostics')
el('copyWebUsername').onclick = () => navigator.clipboard.writeText(el('webUsername').value).catch(() => {})
el('copyWebPassword').onclick = () => navigator.clipboard.writeText(el('webPassword').value).catch(() => {})
el('saveWebCredentials').onclick = async () => {
  const status = el('webCredentialsStatus')
  status.classList.remove('error'); status.textContent = 'Saving...'
  try {
    const webpage = await window.ff.webpage.save(el('webUsername').value, el('webPassword').value)
    renderWebCredentials(webpage); state.webpage = webpage; status.textContent = 'Credentials saved for every instance.'
  } catch (error) { status.classList.add('error'); status.textContent = error.message }
}
document.querySelectorAll('[data-save]').forEach(button => button.onclick = () => saveFile(button.dataset.save))
document.querySelectorAll('[data-import]').forEach(button => button.onclick = () => importFile(button.dataset.import))
document.querySelectorAll('[data-restore]').forEach(button => button.onclick = () => restoreFile(button.dataset.restore))
document.querySelectorAll('[data-reveal]').forEach(button => button.onclick = () => toggleRevealFile(button.dataset.reveal))

el('addAccount').onclick = async () => {
  if (state.accountLinkMode === 'link') {
    state.dismissedDeviceCode = ''
    showDeviceCode()
    if (state.deviceCode) navigator.clipboard.writeText(state.deviceCode).catch(() => {})
    return window.ff.openMicrosoft(state.deviceUrl)
  }
  if (state.accountLinkMode === 'confirmed' || state.accountLinkMode === 'waiting') return
  state.dismissedDeviceCode = ''
  state.accountLinkPending = true
  state.accountLinkMode = 'waiting'
  const notice = el('accountNotice')
  notice.classList.remove('hidden', 'error')
  notice.textContent = 'Preparing secure Microsoft account linking...'
  renderAccountLinkButton(false)
  try {
    const linkedBot = await run(() => window.ff.bot.addAccount())
    finishAccountLink()
    renderBot(linkedBot)
  } catch (error) {
    state.accountLinkPending = false
    state.accountLinkMode = 'add'
    if (el('deviceDialog').open) el('deviceDialog').close()
    notice.classList.remove('hidden')
    notice.classList.add('error')
    notice.textContent = `Account could not be added: ${error.message}`
    renderAccountLinkButton(false)
  }
}
el('marketScanNow').onclick = () => run(() => window.ff.scanner.scan()).then(renderMarket)
el('marketExportLog').onclick = () => run(() => window.ff.scanner.exportLog()).then(result => {
  if (!result.canceled) addLog({ at: new Date().toISOString(), level: 'success', message: `Market Scanner log exported${result.path ? `: ${result.path}` : '.'}` })
})
el('itemSearch').oninput = event => { state.itemQuery = event.target.value.trim(); state.itemPage = 0; renderItems() }
el('itemsPrevious').onclick = () => { state.itemPage = Math.max(0, state.itemPage - 1); renderItems() }
el('itemsNext').onclick = () => { state.itemPage += 1; renderItems() }
el('openDataFolder').onclick = () => window.ff.openDataFolder()
el('killTheFih').onclick = async () => {
  if (!await ffConfirm('Kill XYZ FLIPPER?', 'Azalea, scanner, automation, and all background timers will stop.', { confirmLabel: 'Kill XYZ', danger: true })) return
  const button = el('killTheFih'); button.disabled = true; button.textContent = 'KILLING...'
  window.ff.killApp().catch(() => {})
}
el('clearOrdersInventory').onclick = async () => {
  if (!await ffConfirm('Clear orders and inventory?', 'Filled orders will be claimed, open orders will be cancelled, and Bazaar inventory will be sold instantly.', { confirmLabel: 'Start Clearing', danger: true })) return
  const button = el('clearOrdersInventory'); button.disabled = true; button.textContent = 'CLEARING...'
  try {
    await run(() => window.ff.bot.clearOrdersInventory())
    addLog({ at: new Date().toISOString(), level: 'warning', message: 'Clear Orders / Inventory started.' })
  } finally {
    setTimeout(() => { button.textContent = 'Clear Orders / Inventory'; button.disabled = state.bot.status !== 'connected' }, 2500)
  }
}
el('anonymousMode').onclick = () => {
  state.anonymous = !state.anonymous
  localStorage.setItem('ff-anonymous-mode', state.anonymous ? 'on' : 'off')
  el('anonymousMode').textContent = `ANONYMOUS MODE: ${state.anonymous ? 'ON' : 'OFF'}`
  el('anonymousMode').classList.toggle('off', !state.anonymous)
  renderBot(state.bot)
  renderInstances(state.instances)
}
el('anonymousMode').textContent = `ANONYMOUS MODE: ${state.anonymous ? 'ON' : 'OFF'}`
el('anonymousMode').classList.toggle('off', !state.anonymous)
let graphAnimationTimer = null
function swapGraph(direction = 'right') {
  const stage = el('trackerStage')
  state.graphMode = state.graphMode === 'profit' ? 'limit' : 'profit'
  stage.classList.remove('slide-from-left', 'slide-from-right')
  renderGraphMode()
  void stage.offsetWidth
  stage.classList.add(direction === 'left' ? 'slide-from-left' : 'slide-from-right')
  if (graphAnimationTimer) clearTimeout(graphAnimationTimer)
  graphAnimationTimer = setTimeout(() => stage.classList.remove('slide-from-left', 'slide-from-right'), 620)
}
el('previousGraph').onclick = () => swapGraph('left')
el('nextGraph').onclick = () => swapGraph('right')
let graphPointerStart = null
el('trackerStage').addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return
  graphPointerStart = { x: event.clientX, y: event.clientY }
  el('trackerStage').setPointerCapture?.(event.pointerId)
})
el('trackerStage').addEventListener('pointerup', event => {
  if (!graphPointerStart) return
  const distance = event.clientX - graphPointerStart.x
  graphPointerStart = null
  if (Math.abs(distance) >= 45) swapGraph(distance > 0 ? 'left' : 'right')
})
let lastGraphWheelAt = 0
el('trackerStage').addEventListener('wheel', event => {
  if (Math.abs(event.deltaX) < 8 && Math.abs(event.deltaY) < 24) return
  event.preventDefault()
  if (Date.now() - lastGraphWheelAt < 500) return
  lastGraphWheelAt = Date.now()
  swapGraph(event.deltaX < 0 && Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'left' : 'right')
}, { passive: false })
el('trackerStage').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  swapGraph(event.key === 'ArrowLeft' ? 'left' : 'right')
})
el('saveProxy').onclick = saveProxy
function proxyCountryLabel(country) {
  const value = String(country || 'Unknown')
  if (value === 'Unknown') return value
  if (value.length !== 2) return value
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(value.toUpperCase()) || value.toUpperCase() } catch { return value.toUpperCase() }
}
function renderProxyPool(pool = {}, { force = false } = {}) {
  state.proxyPool = { records: Array.isArray(pool.records) ? pool.records : [], instances: Array.isArray(pool.instances) ? pool.instances : [] }
  if (!force && !pageIsActive('files')) return
  const records = state.proxyPool.records
  el('proxyPoolCount').textContent = `${records.length} ${records.length === 1 ? 'PROXY' : 'PROXIES'}`
  const countrySummary = el('proxyPoolCountries'); countrySummary.replaceChildren()
  const countryCounts = new Map()
  for (const record of records) countryCounts.set(record.country || 'Unknown', (countryCounts.get(record.country || 'Unknown') || 0) + 1)
  for (const [country, count] of [...countryCounts].sort((a, b) => proxyCountryLabel(a[0]).localeCompare(proxyCountryLabel(b[0])))) {
    const chip = document.createElement('span'); chip.className = 'proxy-country-chip'; chip.textContent = `${proxyCountryLabel(country)} · ${count}`; countrySummary.append(chip)
  }
  const host = el('proxyPoolInstances'); host.replaceChildren()
  if (!state.proxyPool.instances.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Add an XYZ instance before assigning proxies.'; host.append(empty); return
  }
  const countries = [...new Set(records.map(record => record.country || 'Unknown'))].sort((a, b) => proxyCountryLabel(a).localeCompare(proxyCountryLabel(b)))
  for (const instance of state.proxyPool.instances) {
    const card = document.createElement('div'); card.className = 'proxy-assignment'
    const heading = document.createElement('div'); heading.className = 'proxy-assignment-head'
    const title = document.createElement('strong'); title.textContent = instance.name
    const headActions = document.createElement('div'); headActions.className = 'proxy-assignment-head-actions'
    const runtime = document.createElement('span'); runtime.textContent = instance.running ? 'RUNNING · RESTART ON APPLY' : 'STOPPED'
    const remove = document.createElement('button'); remove.className = 'button danger proxy-assignment-remove'; remove.type = 'button'; remove.textContent = 'Remove Selected'; remove.disabled = !records.length
    headActions.append(runtime, remove); heading.append(title, headActions)
    const countryLabel = document.createElement('label'); countryLabel.textContent = 'Country'
    const countrySelect = document.createElement('select'); countrySelect.setAttribute('aria-label', `${instance.name} proxy country`)
    const allCountry = document.createElement('option'); allCountry.value = ''; allCountry.textContent = 'All countries'; countrySelect.append(allCountry)
    for (const country of countries) { const option = document.createElement('option'); option.value = country; option.textContent = proxyCountryLabel(country); countrySelect.append(option) }
    const assigned = records.find(record => record.id === instance.assignedProxyId)
    countrySelect.value = state.proxyCountryFilters[instance.id] ?? assigned?.country ?? ''
    countryLabel.append(countrySelect)
    const proxyLabel = document.createElement('label'); proxyLabel.textContent = 'SOCKS5 proxy'
    const proxySelect = document.createElement('select'); proxySelect.setAttribute('aria-label', `${instance.name} proxy endpoint`)
    const fillProxyOptions = () => {
      const previous = proxySelect.value || instance.assignedProxyId
      const available = records.filter(record => !countrySelect.value || record.country === countrySelect.value)
      proxySelect.replaceChildren()
      if (!available.length) { const option = document.createElement('option'); option.value = ''; option.textContent = records.length ? 'No proxies in this country' : 'Import a proxy list first'; proxySelect.append(option) }
      for (const record of available) { const option = document.createElement('option'); option.value = record.id; option.textContent = `${record.ip}:${record.port} · ${record.usernameHint}`; proxySelect.append(option) }
      if (available.some(record => record.id === previous)) proxySelect.value = previous
    }
    countrySelect.onchange = () => { state.proxyCountryFilters[instance.id] = countrySelect.value; fillProxyOptions() }
    fillProxyOptions(); proxyLabel.append(proxySelect)
    remove.onclick = async () => {
      const selected = records.find(record => record.id === proxySelect.value)
      if (!selected) return
      if (!await ffConfirm('Remove proxy from imported list?', `${selected.ip}:${selected.port} will be removed from Proxy Pool. Existing instance configs using it will stay unchanged.`, { confirmLabel: 'Remove Proxy', danger: true })) return
      try {
        const result = await run(() => window.ff.proxyPool.remove(selected.id))
        renderProxyPool(result); el('proxyPoolStatus').classList.remove('error'); el('proxyPoolStatus').textContent = 'Proxy removed from the imported list. Existing assignments were preserved.'
      } catch (error) { el('proxyPoolStatus').classList.add('error'); el('proxyPoolStatus').textContent = error.message }
    }
    const apply = document.createElement('button'); apply.className = 'button primary'; apply.type = 'button'; apply.textContent = instance.running ? 'Apply & Restart' : 'Apply Proxy'; apply.disabled = !records.length
    apply.onclick = async () => {
      if (!proxySelect.value) return
      const original = apply.textContent; apply.disabled = true; apply.textContent = instance.running ? 'Restarting…' : 'Applying…'
      try {
        const result = await run(() => window.ff.proxyPool.assign(instance.id, proxySelect.value, instance.running))
        renderProxyPool(result)
        if (result.file && instance.id === state.instances.selectedId) {
          state.instanceFiles.config = result.file; state.privateFiles.config = result.file.content; state.privateParsed.config = result.file.parsed; renderInstanceEditor(); renderProxy(result.file.parsed)
        }
        el('proxyPoolStatus').classList.remove('error'); el('proxyPoolStatus').textContent = `${instance.name}: proxy applied${result.restarted ? ' and instance restarted' : ''}.`
        await refreshInstanceControls()
      } catch (error) { el('proxyPoolStatus').classList.add('error'); el('proxyPoolStatus').textContent = error.message; apply.disabled = false; apply.textContent = original }
    }
    const current = document.createElement('div'); current.className = 'proxy-current'; current.textContent = instance.current?.enabled
      ? `Current: ${proxyCountryLabel(instance.current.country)} · ${instance.current.ip}:${instance.current.port}${instance.assignedProxyId ? ' · IN POOL' : ' · MANUAL CONFIG'}`
      : 'Current: proxy disabled'
    card.append(heading, countryLabel, proxyLabel, apply, current); host.append(card)
  }
}
el('proxyPoolImport').onclick = async () => {
  const file = el('proxyPoolFile').files?.[0]
  const status = el('proxyPoolStatus')
  if (!file) { status.classList.add('error'); status.textContent = 'Choose a Webshare TXT, CSV or JSON file first.'; return }
  const button = el('proxyPoolImport'); button.disabled = true; button.textContent = 'Importing…'
  try {
    const content = await file.text()
    const result = await run(() => window.ff.proxyPool.import(content, { filename: file.name, country: el('proxyPoolCountry').value.trim() }))
    renderProxyPool(result)
    const imported = result.importResult || {}
    status.classList.remove('error'); status.textContent = `Imported ${imported.added || 0} new, updated ${imported.updated || 0}${imported.invalid ? `, skipped ${imported.invalid} invalid row(s)` : ''}.`
    el('proxyPoolFile').value = ''
  } catch (error) { status.classList.add('error'); status.textContent = error.message }
  finally { button.disabled = false; button.textContent = 'Import Webshare List' }
}
el('proxyPoolClear').onclick = async () => {
  if (!state.proxyPool.records.length) { el('proxyPoolStatus').textContent = 'Proxy Pool is already empty.'; return }
  if (!await ffConfirm('Clear imported proxy list?', `Remove all ${state.proxyPool.records.length} imported proxies? Current instance proxy configs will remain active until you assign another proxy.`, { confirmLabel: 'Clear List', danger: true })) return
  try {
    const result = await run(() => window.ff.proxyPool.clear())
    renderProxyPool(result); el('proxyPoolStatus').classList.remove('error'); el('proxyPoolStatus').textContent = `Removed ${result.removed || 0} proxies. Existing instance assignments were preserved.`
  } catch (error) { el('proxyPoolStatus').classList.add('error'); el('proxyPoolStatus').textContent = error.message }
}
el('proxyPoolAutoAssign').onclick = async () => {
  const status = el('proxyPoolStatus')
  if (!state.proxyPool.records.length) { status.classList.add('error'); status.textContent = 'Import a proxy list first.'; return }
  const preferences = Object.fromEntries(state.proxyPool.instances.map(instance => [instance.id, state.proxyCountryFilters[instance.id] || '']))
  if (!await ffConfirm('Auto-assign unique proxies?', 'Each instance will receive a different imported proxy. The selected country on each instance card is respected. Running instances will not be interrupted; restart them afterward to use the new endpoint.', { confirmLabel: 'Auto-Assign' })) return
  const button = el('proxyPoolAutoAssign'); button.disabled = true; button.textContent = 'Assigning…'
  try {
    const result = await run(() => window.ff.proxyPool.autoAssign(preferences))
    renderProxyPool(result)
    status.classList.remove('error'); status.textContent = `Assigned unique proxies to ${(result.assigned || []).length} instance(s)${result.skipped?.length ? `. Skipped: ${result.skipped.join('; ')}` : ''}${result.restartRequired?.length ? `. Restart required: ${result.restartRequired.join(', ')}` : ''}.`
    if (state.instances.selectedId) await selectInstance(state.instances.selectedId)
  } catch (error) { status.classList.add('error'); status.textContent = error.message }
  finally { button.disabled = false; button.textContent = 'Auto-Assign Unique' }
}
function renderSavedProfiles(profiles = []) {
  state.savedProfiles = Array.isArray(profiles) ? profiles : []
  const select = el('savedProfileList')
  const previous = select.value
  select.replaceChildren()
  if (!state.savedProfiles.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'No saved profiles'
    select.append(option)
  } else {
    for (const profile of state.savedProfiles) {
      const option = document.createElement('option')
      option.value = profile.id
      const source = profile.builtIn ? ' · BUILT-IN' : (profile.sourceInstance ? ` · ${profile.sourceInstance}` : '')
      option.textContent = `${profile.name || profile.id}${source}`
      select.append(option)
    }
    select.value = state.savedProfiles.some(profile => profile.id === previous) ? previous : state.savedProfiles[0].id
  }
  const available = state.savedProfiles.length > 0
  el('applySavedProfile').disabled = !available
  el('applySavedProfileAll').disabled = !available
  el('deleteSavedProfile').disabled = !available || state.savedProfiles.find(profile => profile.id === select.value)?.builtIn === true
  el('savedProfileCount').textContent = `${state.savedProfiles.length} SAVED`
  el('savedProfileStatus').textContent = available
    ? 'Profiles are stored locally. Applying one replaces filter.json and changes only profit, price, orders, volume, purse and selectiveBuys; every other setting is preserved.'
    : 'No saved profiles yet. Enter a name and save the current config + filter pair.'
}

async function saveCurrentProfile() {
  const name = el('savedProfileName').value.trim()
  const targetInstanceId = state.instances.selectedId
  if (!name) { el('savedProfileStatus').textContent = 'Enter a profile name before saving.'; return }
  const duplicate = state.savedProfiles.some(profile => profile.id === name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
  if (duplicate && !await ffConfirm('Replace saved profile?', `A profile named “${name}” already exists. Replace it with the selected instance’s current config and filter?`, { confirmLabel: 'Replace', danger: true })) return
  run(() => window.ff.preset.saveCurrentProfile(name, targetInstanceId)).then(result => {
    el('savedProfileName').value = ''
    renderSavedProfiles(result.profiles)
    el('savedProfileList').value = result.profile.id
    el('savedProfileStatus').textContent = `Saved “${result.profile.name}” from ${result.profile.sourceInstance}.`
    addLog({ at: new Date().toISOString(), level: 'success', message: `Saved config + filter profile “${result.profile.name}”.` })
  })
}

async function applySavedProfile(scope) {
  const id = el('savedProfileList').value
  const targetInstanceId = state.instances.selectedId
  const profile = state.savedProfiles.find(item => item.id === id)
  if (!profile) return
  const all = scope === 'all'
  const message = all
    ? `Apply “${profile.name}” to all instances? Only profit, price, orders, volume, purse and selectiveBuys will change; filter.json will be replaced. Every other setting stays untouched.`
    : `Apply “${profile.name}” to the selected instance? Only profit, price, orders, volume, purse and selectiveBuys will change; filter.json will be replaced.`
  if (!await ffConfirm(all ? 'Apply trading rules to all?' : 'Apply saved profile?', message, { confirmLabel: all ? 'Apply to All' : 'Apply', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyProfile(id, scope, targetInstanceId)).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    renderSavedProfiles(result.profiles)
    el('savedProfileList').value = id
    el('savedProfileStatus').textContent = `Applied “${profile.name}” to ${result.applied.length} instance(s).`
  })
}

async function deleteSavedProfile() {
  const id = el('savedProfileList').value
  const profile = state.savedProfiles.find(item => item.id === id)
  if (!profile || !await ffConfirm('Delete saved profile?', `Delete “${profile.name}”? This does not change any currently applied config or filter.`, { confirmLabel: 'Delete', danger: true })) return
  run(() => window.ff.preset.deleteProfile(id)).then(profiles => {
    renderSavedProfiles(profiles)
    addLog({ at: new Date().toISOString(), level: 'info', message: `Deleted saved profile “${profile.name}”.` })
  })
}
el('saveCurrentProfile').onclick = saveCurrentProfile
el('applySavedProfile').onclick = () => applySavedProfile('current')
el('applySavedProfileAll').onclick = () => applySavedProfile('all')
el('deleteSavedProfile').onclick = deleteSavedProfile
el('savedProfileList').onchange = () => { el('deleteSavedProfile').disabled = state.savedProfiles.find(profile => profile.id === el('savedProfileList').value)?.builtIn === true }
el('loadFilterExample').onclick = () => { el('filterEditor').value = `${el('filterExample').textContent.trim()}\n`; showFileMessage('Filter example loaded into the editor. Review it, then click Save Filter.') }
el('replaceConfigFilter').onclick = () => {
  ffConfirm('Replace config and filter?', 'Replace the current config.json and filter.json with the new profile defaults? Both current files will be backed up.', { confirmLabel: 'Replace Files', danger: true }).then(confirmed => {
    if (!confirmed) return
    run(() => window.ff.files.resetDefaults()).then(result => { loadFile(result.config); loadFile(result.filter); showFileMessage('New profile config and clean filter applied. Existing files were backed up.') })
  })
}
el('generateDynamic').onclick = () => run(() => window.ff.dynamic.generate({ purse: Number(el('dynamicPurse').value), lookbackHours: Number(el('dynamicLookback').value) })).then(renderDynamic)
el('applyDynamic').onclick = () => run(() => window.ff.dynamic.apply()).then(result => {
  loadFile(result.config); loadFile(result.filter)
  el('dynamicState').textContent = 'APPLIED'
  showFileMessage('Dynamic config.json and filter.json applied. Previous files were backed up.')
})
el('applySimplePreset').onclick = async () => {
  if (!await ffConfirm('Apply Simple Preset?', 'Apply the readable trading sections and replace filter.json? Every other config setting will be preserved and backups will be created.', { confirmLabel: 'Apply Preset', danger: true })) return
  run(() => window.ff.preset.applySimple()).then(result => {
    loadFile(result.config); loadFile(result.filter); showFileMessage('Simple trading sections and ITEM_ID filter applied. Every other config setting was preserved; previous files were backed up.')
  })
}
el('applyUltraProfitPreset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V2 portfolio?', 'FF-1, FF-2 and FF-3 will receive separate non-overlapping configs and filters. Proxy, webpage credentials, server and Microsoft accounts are preserved. Existing files are backed up.', { confirmLabel: 'Apply V2 Portfolio', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfit()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V2 portfolio applied live to ${result.applied.length} instance(s). Each instance now has its own market allocation; connection and login settings were preserved.`)
  })
}
el('applyUltraProfitV3Preset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V3 portfolio?', 'V3 uses separate non-overlapping item pools, six buy slots and larger capital allocation. Proxy, webpage credentials, server and Microsoft accounts are preserved.', { confirmLabel: 'Apply V3 Portfolio', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfitV3()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V3 portfolio applied live to ${result.applied.length} instance(s). Each instance has a separate aggressive market allocation; connection and login settings were preserved.`)
  })
}
el('applyUltraProfitV4Preset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V4 Fast Turnover?', 'V4 uses smaller, faster lots across separate markets. It preserves proxies and the manipulation filter.', { confirmLabel: 'Apply V4 Fast Turnover', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfitV4()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V4 Fast Turnover applied live to ${result.applied.length} instance(s). Each instance retains a separate high-turnover market allocation.`)
  })
}
el('applyUltraProfitV5Preset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V5 High Ticket?', 'V5 uses non-overlapping pools and skips low-value micro-flips so each GUI workflow targets a meaningful net return. It preserves proxies and safety filters.', { confirmLabel: 'Apply V5 High Ticket', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfitV5()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V5 High Ticket applied live to ${result.applied.length} instance(s). Each instance now targets separate, higher-value opportunities.`)
  })
}
el('applyUltraProfitV6Preset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V6 to five instances?', 'V6 uses the exact aggressive trading values requested, real relist-after-1 behavior and five exclusive markets derived from the newest log. It changes only profit, price, orders, volume, purse and selectiveBuys, replaces each filter.json, and preserves every other setting including proxies.', { confirmLabel: 'Apply V6 Portfolio', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfitV6()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V6 applied live to ${result.applied.length} instance(s). Five exclusive market allocations are active; all non-trading settings were preserved.`)
  })
}
el('applyUltraProfitV7Preset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V7 to five instances?', 'V7 is based on the supplied 40-hour log and market history. It uses five exclusive 12-item pools, relist-after-1, no low-value relist floor, a strict 7 buy / 7 sell composition and preserves proxies plus every non-trading setting.', { confirmLabel: 'Apply V7 Portfolio', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfitV7()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V7 applied live to ${result.applied.length} instance(s). The five non-overlapping telemetry pools are active; proxies and all non-trading settings were preserved.`)
  })
}
el('applyUltraProfitV8Preset').onclick = async () => {
  if (!await ffConfirm('Apply Ultra Profit V8 to five accounts?', 'V8 uses five exclusive telemetry-pruned pools, relist-after-5 and a 2M anti-churn floor while keeping timed stale-order recovery. It preserves proxies, accounts and every non-trading setting.', { confirmLabel: 'Apply V8 Portfolio', danger: true })) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceAutosaveContent = ''
  run(() => window.ff.preset.applyUltraProfitV8()).then(result => {
    state.instanceFiles = { config: result.config, filter: result.filter }
    loadFile(result.config); loadFile(result.filter)
    renderInstances(result.instances)
    renderInstanceEditor()
    showFileMessage(`Ultra Profit V8 applied live to ${result.applied.length} instance(s). Five non-overlapping eight-item pools and telemetry-backed anti-churn rules are active; proxies and non-trading settings were preserved.`)
  })
}
el('downloadLogFile').onclick = () => run(() => window.ff.logs.download()).then(result => {
  if (!result.canceled) addLog({ at: new Date().toISOString(), level: 'success', message: `All FF logs downloaded${result.path ? `: ${result.path}` : '.'}` })
})
el('deviceCode').onclick = () => navigator.clipboard.writeText(el('deviceCode').textContent)
el('openMicrosoft').onclick = () => window.ff.openMicrosoft(state.deviceUrl)
el('closeDeviceDialog').onclick = () => {
  state.dismissedDeviceCode = state.deviceCode
  el('deviceDialog').close()
}
async function runAllInstanceAction(buttonId, action, busyLabel) {
  const button = el(buttonId); const original = button.textContent
  button.disabled = true; button.textContent = busyLabel
  try {
    const result = await run(action)
    renderInstances(await window.ff.instances.list())
    return result
  } finally {
    button.disabled = false; button.textContent = original
  }
}

function renderTotalProfit(totals = {}) {
  state.totals = { ...state.totals, ...totals }
  const profit = Number(state.totals.totalProfit) || 0
  el('allInstancesProfit').textContent = `${profit >= 0 ? '+' : ''}${formatCoins(profit)}`
  const reconnectState = el('allAccountsReconnectState')
  const selectedInstance = state.instances?.instances?.find(instance => instance.id === state.instances.selectedId)
  const reconnectActive = selectedInstance?.autoReconnect === true
  reconnectState.textContent = reconnectActive ? 'ON · 15/30/45/60S' : 'OFF'
  reconnectState.classList.toggle('active', reconnectActive)
  const reconnectButton = el('instanceControlReconnect')
  if (reconnectButton) {
    reconnectButton.textContent = `Auto Reconnect: ${reconnectActive ? 'ON' : 'OFF'}`
    reconnectButton.classList.toggle('active', reconnectActive)
  }
  const roamingButton = el('instanceControlHubRoaming')
  const roamingActive = selectedInstance?.hubRoamingEnabled === true
  if (roamingButton) {
    roamingButton.textContent = `Hub Roaming: ${roamingActive ? 'ON' : 'OFF'}`
    roamingButton.classList.toggle('active', roamingActive)
  }
  const startButton = el('instanceControlStart')
  if (startButton) {
    startButton.textContent = selectedInstance?.banRateQueued === true ? 'Start Queued' : 'Start'
    startButton.classList.toggle('active', selectedInstance?.banRateQueued === true)
  }
  const safety = state.totals.fleetSafety || {}
  const banRateSafety = state.totals.banRateSafety || {}
  const safetyNotice = el('fleetSafetyNotice')
  const ignoreBanRateButton = el('ignoreBanRate')
  if (safetyNotice) {
    const active = safety.active === true || banRateSafety.active === true || banRateSafety.ignored === true
    safetyNotice.classList.toggle('hidden', !active)
    safetyNotice.textContent = safety.active === true
      ? `BAN SAFETY STOP · ${safety.sourceInstanceName || 'INSTANCE'} · ${safety.detectedAt || 'unknown time'} · ${safety.durationText || 'duration unknown'}. Manual Start unlocks; nothing restarts automatically.`
      : banRateSafety.active === true
        ? `GLOBAL BAN RATE STOP · ${Number(banRateSafety.rate || 0).toFixed(0)} BANS/MIN · AUTO RESUME ${banRateSafety.resumeAt || 'AFTER SAFETY DELAY'}.`
        : banRateSafety.ignored === true
          ? `BAN RATE IGNORED UNTIL APP RESTART · ${Number(banRateSafety.lastRate || 0).toFixed(0)} BANS/MIN · LOCAL ACCOUNT BAN PROTECTION REMAINS ON.`
        : ''
  }
  if (ignoreBanRateButton) ignoreBanRateButton.classList.toggle('hidden', banRateSafety.active !== true || banRateSafety.ignored === true)
}
const ignoreBanRateButton = el('ignoreBanRate')
if (ignoreBanRateButton) ignoreBanRateButton.onclick = async () => {
  if (!await ffConfirm('Ignore global ban rate?', 'External ban-rate stops will be ignored until XYZ FLIPPER is restarted. Previously running instances will resume. Real ban messages from your own accounts will still stop the fleet.', { confirmLabel: 'Ignore Ban Rate', danger: true })) return
  renderTotalProfit(await runAllInstanceAction('ignoreBanRate', () => window.ff.instances.ignoreBanRate(), 'Ignoring...'))
}
const startAllButton = el('startAllInstances')
if (startAllButton) startAllButton.onclick = async () => renderTotalProfit(await runAllInstanceAction('startAllInstances', () => window.ff.instances.startAll(), 'Starting...'))
const closeAllButton = el('closeAllInstances')
if (closeAllButton) closeAllButton.onclick = async () => {
  if (!await ffConfirm('Stop all accounts?', 'All connected and connecting Minecraft sessions will stop, and automatic reconnect will be disabled.', { confirmLabel: 'Stop All Accounts', danger: true })) return
  renderTotalProfit(await runAllInstanceAction('closeAllInstances', () => window.ff.instances.closeAll(), 'Stopping...'))
}
const restartAllButton = el('restartAllInstances')
if (restartAllButton) restartAllButton.onclick = async () => {
  if (!await ffConfirm('Restart every FF instance?', 'All linked instances will disconnect and reconnect after two seconds.', { confirmLabel: 'Restart All' })) return
  await runAllInstanceAction('restartAllInstances', () => window.ff.instances.restartAll(), 'Restarting...')
}
el('resetTrackerInformation').onclick = async () => {
  if (!await ffConfirm('Reset profit and uptime?', 'This resets the selected FF account’s profit history and connected uptime. Daily Bazaar Limit totals and active order costs stay intact.', { confirmLabel: 'Reset Information', danger: true })) return
  const tracker = await run(() => window.ff.tracker.resetInformation())
  state.automation.tracker = tracker
  state.trackerReceivedAt = Date.now()
  renderTracker(tracker)
}

state.instanceFile = 'config'; state.instanceRevealed = true; state.instanceFiles = {}; state.instances = { instances: [], selectedId: '' }; state.instanceLogs = []; state.instanceAutosaveTimer = null; state.instanceAutosaveContent = ''
function statsView(instance) {
  const stats = instance.stats || {}
  const status = ['ACTIVE', 'IDLE', 'DISCONNECTED'].includes(stats.status) ? stats.status : 'DISCONNECTED'
  let coinsPerHour = Number(stats.coinsPerHour) || 0
  const uptime = Number(stats.uptimeSeconds) || 0
  const observedAt = Number(stats.observedAt) || Date.now()
  if (stats.uptimeActive && uptime > 0) {
    const liveUptime = uptime + Math.max(0, Date.now() - observedAt) / 1000
    coinsPerHour = (Number(stats.profit) || 0) / liveUptime * 3600
  }
  const stashCount = Number.isFinite(Number(stats.stashItemCount)) && Number(stats.stashItemCount) > 0
    ? ` · ${Math.floor(Number(stats.stashItemCount))} ITEM${Number(stats.stashItemCount) === 1 ? '' : 'S'}`
    : ''
  return {
    status,
    stashBlocked: stats.stashBlocked === true,
    stashText: `⚠ CLEAR ITEM STASH${stashCount} · TRADING CONTINUES · /pickupstash item`,
    values: {
      coins: `${formatCoins(coinsPerHour)}/h`,
      total: formatCoins(stats.totalLimit || 0),
      rate: `${formatCoins(stats.limitPerHour || 0)}/h`,
      eta: stats.estimatedSecondsToLimit === null || stats.estimatedSecondsToLimit === undefined ? '—' : formatClock(stats.estimatedSecondsToLimit)
    }
  }
}

function patchStatsCard(card, instance) {
  const view = statsView(instance)
  card.className = `stats-card status-${view.status.toLowerCase()}`
  card.querySelector('[data-stats-name]').textContent = instance.name
  const badge = card.querySelector('[data-stats-status]')
  badge.className = `stats-status ${view.status.toLowerCase()}`
  badge.textContent = view.status
  const stash = card.querySelector('[data-stats-stash]')
  stash.textContent = view.stashText
  stash.classList.toggle('hidden', !view.stashBlocked)
  for (const [key, value] of Object.entries(view.values)) card.querySelector(`[data-stat="${key}"]`).textContent = value
}

function createStatsCard(instance) {
  const card = document.createElement('article')
  card.dataset.statsInstance = instance.id
  const heading = document.createElement('div'); heading.className = 'stats-card-heading'
  const name = document.createElement('h2'); name.dataset.statsName = ''
  const badge = document.createElement('span'); badge.dataset.statsStatus = ''
  heading.append(name, badge)
  const stashWarning = document.createElement('div'); stashWarning.className = 'stats-stash-warning'; stashWarning.dataset.statsStash = ''
  const metrics = document.createElement('div'); metrics.className = 'stats-card-metrics'
  for (const [key, label] of [['coins', 'COINS / H'], ['total', 'TOTAL LIMIT'], ['rate', 'LIMIT / H'], ['eta', 'EST. TO 15B']]) {
    const metric = document.createElement('div'); const caption = document.createElement('span'); const strong = document.createElement('strong')
    caption.textContent = label; strong.dataset.stat = key; metric.append(caption, strong); metrics.append(metric)
  }
  card.append(heading, stashWarning, metrics)
  patchStatsCard(card, instance)
  return card
}

function renderStats(data = state.instances, { force = false } = {}) {
  const instances = Array.isArray(data?.instances) ? data.instances : []
  const count = el('statsInstanceCount')
  const grid = el('statsGrid')
  if (!count || !grid) return
  count.textContent = `${instances.length} INSTANCE${instances.length === 1 ? '' : 'S'}`
  if (!force && !pageIsActive('stats')) return
  if (!instances.length) {
    if (state.statsStructureSignature === '__empty__' && grid.querySelector('.muted')) return
    state.statsStructureSignature = '__empty__'
    grid.replaceChildren()
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No FF instances configured.'; grid.append(empty)
    return
  }
  const structureSignature = instances.map(instance => instance.id).join('|')
  if (structureSignature === state.statsStructureSignature && grid.children.length === instances.length) {
    for (const instance of instances) {
      const card = [...grid.children].find(node => node.dataset?.statsInstance === instance.id)
      if (card) patchStatsCard(card, instance)
    }
    return
  }
  const scrollTop = grid.scrollTop
  state.statsStructureSignature = structureSignature
  grid.replaceChildren()
  grid.append(...instances.map(createStatsCard))
  grid.scrollTop = scrollTop
}
function scrollStats(direction) {
  const grid = el('statsGrid')
  const card = grid?.querySelector('.stats-card')
  if (!grid || !card) return
  const gap = Number.parseFloat(getComputedStyle(grid).rowGap || getComputedStyle(grid).gap) || 18
  grid.scrollBy({ top: direction * (card.getBoundingClientRect().height + gap), behavior: 'smooth' })
}
el('statsPrevious').onclick = () => scrollStats(-1)
el('statsNext').onclick = () => scrollStats(1)
function renderInstances(data, { force = false } = {}) {
  state.instances = data
  renderStats(data)
  renderHubInstances(data)
  if (state.proxyPool?.records) {
    const existing = new Map((state.proxyPool.instances || []).map(instance => [instance.id, instance]))
    state.proxyPool.instances = data.instances.map(instance => ({
      ...(existing.get(instance.id) || { assignedProxyId: '', current: { enabled: false, ip: '', port: 0, country: 'Unknown' } }),
      id: instance.id,
      name: instance.name,
      running: instance.running === true
    }))
  }
  const renderSignature = data.instances.map(instance => `${instance.id}:${instance.name}:${instance.id === data.selectedId}:${instance.running === true}:${instance.autoReconnect === true}:${instance.hubRoamingEnabled === true}:${Number(instance.linkedAccounts) || 0}`).join('|')
  if (!force && renderSignature === state.instancesRenderSignature) {
    renderTotalProfit(state.totals)
    return
  }
  state.instancesRenderSignature = renderSignature
  const list = el('instanceList'); list.replaceChildren()
  const pickerMenu = el('instancePickerMenu'); pickerMenu.replaceChildren()
  const accountMenu = el('accountInstanceMenu'); accountMenu.replaceChildren()
  const selected = data.instances.find(instance => instance.id === data.selectedId)
  renderAccounts(state.bot || {})
  el('ffAccountLabel').textContent = selected?.name || 'FF-1'
  el('accountInstanceName').textContent = selected?.name || 'FF-1'
  el('instancePickerText').textContent = selected?.name || 'FF-1'
  el('accountInstancePickerText').textContent = selected?.name || 'FF-1'
  data.instances.forEach(instance => {
    const pickerOption = document.createElement('button')
    pickerOption.type = 'button'
    pickerOption.role = 'option'
    pickerOption.ariaSelected = String(instance.id === data.selectedId)
    pickerOption.className = instance.id === data.selectedId ? 'active' : ''
    pickerOption.textContent = instance.name
    pickerOption.onclick = () => {
      closeInstancePickerMenu()
      if (instance.id !== data.selectedId) selectInstance(instance.id)
    }
    pickerMenu.append(pickerOption)
    const accountOption = document.createElement('button')
    accountOption.type = 'button'
    accountOption.role = 'option'
    accountOption.ariaSelected = String(instance.id === data.selectedId)
    accountOption.className = instance.id === data.selectedId ? 'active' : ''
    const linkedAccounts = Math.max(0, Number(instance.linkedAccounts) || 0)
    accountOption.textContent = `${instance.name} · ${linkedAccounts} account${linkedAccounts === 1 ? '' : 's'}`
    accountOption.onclick = () => {
      closeAccountInstanceMenu()
      if (instance.id !== data.selectedId) selectInstance(instance.id)
    }
    accountMenu.append(accountOption)
    const card = document.createElement('div'); card.className = `instance-card ${instance.id === data.selectedId ? 'active' : ''}`
    card.role = 'button'
    card.tabIndex = 0
    card.ariaPressed = String(instance.id === data.selectedId)
    card.onclick = () => {
      if (instance.id !== state.instances.selectedId) selectInstance(instance.id)
    }
    card.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      card.click()
    }
    const name = document.createElement('b'); name.textContent = instance.name
    const stopCardClick = event => event.stopPropagation()
    const start = document.createElement('button'); start.className = 'button secondary'; start.textContent = 'Start'; start.onclick = async event => { stopCardClick(event); await window.ff.instances.start(instance.id); await selectInstance(instance.id) }
    const stop = document.createElement('button'); stop.className = 'button ghost'; stop.textContent = 'Stop'; stop.onclick = async event => { stopCardClick(event); await window.ff.instances.stop(instance.id); await selectInstance(instance.id) }
    const rename = document.createElement('button'); rename.className = 'button ghost'; rename.textContent = 'Rename'; rename.onclick = async event => {
      stopCardClick(event)
      const next = await ffPrompt('Rename FF instance', 'Choose the name shown for this local process.', instance.name, { confirmLabel: 'Rename' })
      if (next) { await window.ff.instances.rename(instance.id, next); renderInstances(await window.ff.instances.list()) }
    }
    const remove = document.createElement('button'); remove.className = 'button danger'; remove.textContent = 'Remove'; remove.onclick = async event => {
      stopCardClick(event)
      if (await ffConfirm('Remove FF instance?', `Remove ${instance.name}? The instance must be stopped first.`, { confirmLabel: 'Remove', danger: true })) {
        await window.ff.instances.remove(instance.id)
        renderInstances(await window.ff.instances.list())
        await selectInstance((await window.ff.instances.list()).selectedId)
      }
    }
    const actions = document.createElement('div'); actions.className = 'instance-card-actions'
    actions.append(start, stop)
    card.append(name, actions, rename, remove); list.append(card)
  })
  if (state.proxyPool?.records && pageIsActive('files')) renderProxyPool(state.proxyPool)
  renderTotalProfit(state.totals)
}
async function refreshInstanceControls(result) {
  if (result?.instances) renderInstances(result)
  else renderInstances(await window.ff.instances.list())
  if (result?.totals) renderTotalProfit(result.totals)
}
async function controlSelectedInstance(action) {
  const id = state.instances.selectedId
  if (!id) return
  const button = action === 'start' ? el('instanceControlStart') : el('instanceControlStop')
  const original = button.textContent
  button.disabled = true
  button.textContent = action === 'start' ? 'Starting…' : 'Stopping…'
  try {
    await window.ff.instances[action](id)
    await refreshInstanceControls()
  } finally {
    button.disabled = false
    button.textContent = original
  }
}
el('instanceControlStart').onclick = () => controlSelectedInstance('start')
el('instanceControlStop').onclick = () => controlSelectedInstance('stop')
el('instanceControlReconnect').onclick = async () => {
  const id = state.instances.selectedId
  const instance = state.instances.instances.find(item => item.id === id)
  if (!instance) return
  const button = el('instanceControlReconnect')
  button.disabled = true
  try {
    const result = await run(() => window.ff.instances.setAutoReconnect(id, instance.autoReconnect !== true))
    await refreshInstanceControls(result)
  } finally {
    button.disabled = false
  }
}
el('instanceControlHubRoaming').onclick = async () => {
  const id = state.instances.selectedId
  const instance = state.instances.instances.find(item => item.id === id)
  if (!instance) return
  const button = el('instanceControlHubRoaming')
  button.disabled = true
  try {
    const result = await run(() => window.ff.instances.setHubRoaming(id, instance.hubRoamingEnabled !== true))
    await refreshInstanceControls(result)
  } finally {
    button.disabled = false
  }
}
function closeInstancePickerMenu() {
  el('instancePickerMenu').classList.add('hidden')
  el('instancePicker').setAttribute('aria-expanded', 'false')
}
function closeAccountInstanceMenu() {
  el('accountInstanceMenu').classList.add('hidden')
  el('accountInstancePicker').setAttribute('aria-expanded', 'false')
}
function renderInstanceEditor() {
  const file = state.instanceFiles[state.instanceFile]
  if (!file) return
  el('instanceTitle').textContent = `${state.instances.instances.find(item => item.id === state.instances.selectedId)?.name || 'FF-1'} · ${state.instanceFile}.json`
  const editor = el('instanceEditor')
  // A log event must not replace text while the user is still typing.
  if (document.activeElement !== editor || !state.instanceRevealed) editor.value = state.instanceRevealed ? editorContent(file) : 'Sensitive file hidden. Select Reveal editor to view or edit this JSON.'
  editor.classList.toggle('sensitive-hidden', !state.instanceRevealed)
  const selectedInstance = state.instances.instances.find(item => item.id === state.instances.selectedId)
  const running = state.bot ? state.bot.status === 'connected' : selectedInstance?.running === true
  document.querySelectorAll('[data-instance-file]').forEach(button => {
    const selected = button.dataset.instanceFile === state.instanceFile
    button.classList.toggle('selected', selected)
    button.classList.toggle('active', running)
    button.classList.toggle('inactive', !running)
    button.setAttribute('aria-pressed', String(selected))
    const status = button.querySelector('[data-instance-file-state]')
    if (status) status.textContent = running ? 'RUNNING' : 'STOPPED'
  })
  el('instanceLog').textContent = state.instanceLogs.filter(entry => entry.instanceId === state.instances.selectedId).slice(-100).map(entry => `${time(entry.at)}  ${entry.message}`).join('\n') || 'No recent activity for this instance.'
}

async function selectInstance(id) {
  const result = await window.ff.instances.select(id)
  renderInstances(result); state.instanceFiles = result.snapshot.files; state.instanceLogs = (result.snapshot.logs || []).slice(-1000); state.instanceRevealed = false; state.instanceAutosaveContent = ''
  state.logs = []
  addLogs(state.instanceLogs)
  state.botAccountsSignature = ''
  state.botOrdersSignature = ''
  renderInstanceEditor(); renderBot(result.snapshot.bot); renderAutomation(result.snapshot.automation || {}); renderProxy(result.snapshot.proxy || {})
}

el('instanceAdd').onclick = async () => { const name = await ffPrompt('Add FF instance', 'Enter a name, or leave it blank to use the next FF-# name.', '', { confirmLabel: 'Add Instance', placeholder: 'FF-2' }); if (name === null) return; await window.ff.instances.add(name); await selectInstance((await window.ff.instances.list()).selectedId) }
el('instancePicker').onclick = event => {
  event.stopPropagation()
  const menu = el('instancePickerMenu')
  const opening = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !opening)
  el('instancePicker').setAttribute('aria-expanded', String(opening))
}
el('accountInstancePicker').onclick = event => {
  event.stopPropagation()
  const menu = el('accountInstanceMenu')
  const opening = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !opening)
  el('accountInstancePicker').setAttribute('aria-expanded', String(opening))
}
document.addEventListener('click', event => {
  if (!event.target.closest('.account-instance-picker-label')) closeAccountInstanceMenu()
  if (!event.target.closest('.instance-picker-label')) closeInstancePickerMenu()
})
document.querySelectorAll('[data-instance-file]').forEach(button => button.onclick = () => {
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  state.instanceAutosaveTimer = null
  state.instanceFile = button.dataset.instanceFile
  state.instanceRevealed = true
  state.instanceAutosaveContent = ''
  el('instanceAutoSave').textContent = 'Autosave enabled'
  el('instanceAutoSave').classList.remove('warning')
  renderInstanceEditor()
})
el('instanceReveal').onclick = () => { state.instanceRevealed = !state.instanceRevealed; el('instanceReveal').textContent = state.instanceRevealed ? 'Hide editor' : 'Reveal editor'; renderInstanceEditor() }
async function saveInstanceEditor({ automatic = false } = {}) {
  const button = el('instanceSave')
  const editor = el('instanceEditor')
  const content = editor.value
  const instanceId = state.instances.selectedId
  if (!state.instanceRevealed) return false
  try { JSON.parse(content) } catch (error) {
    el('instanceStatus').textContent = 'INVALID JSON'
    el('instanceStatus').className = 'badge warning'
    el('instanceAutoSave').textContent = 'Waiting for valid JSON'
    el('instanceAutoSave').classList.add('warning')
    if (!automatic) addLog({ at: new Date().toISOString(), level: 'error', message: error.message })
    return false
  }
  const saveKey = `${instanceId}:${state.instanceFile}:${content}`
  if (automatic && saveKey === state.instanceAutosaveContent) return true
  if (!automatic) {
    button.disabled = true
    button.textContent = 'Applying...'
  } else {
    el('instanceStatus').textContent = 'AUTOSAVING'
    el('instanceStatus').className = 'badge'
    el('instanceAutoSave').textContent = 'Autosaving valid JSON…'
    el('instanceAutoSave').classList.remove('warning')
  }
  try {
    const file = await window.ff.files.save(state.instanceFile, content, { automatic })
    if (instanceId !== state.instances.selectedId) return false
    state.instanceFiles[state.instanceFile] = file
    state.instanceAutosaveContent = saveKey
    el('instanceStatus').textContent = file.appliedLive ? (automatic ? 'AUTO-APPLIED' : 'APPLIED LIVE') : (automatic ? 'AUTO-SAVED' : 'SAVED')
    el('instanceStatus').className = 'badge ok'
    el('instanceAutoSave').textContent = automatic ? 'Auto-saved — live settings refreshed' : 'Saved manually — live settings refreshed'
    el('instanceAutoSave').classList.remove('warning')
    if (automatic) return true
    button.textContent = file.appliedLive ? 'Saved & Applied' : 'Saved'
    setTimeout(() => {
      el('instanceStatus').textContent = 'LOADED'
      button.textContent = 'Save now'
      button.disabled = false
    }, 1800)
    return true
  } catch (error) {
    el('instanceStatus').textContent = 'INVALID'
    el('instanceStatus').className = 'badge warning'
    el('instanceAutoSave').textContent = automatic ? 'Autosave failed — edit is not applied' : 'Save failed'
    el('instanceAutoSave').classList.add('warning')
    if (!automatic) {
      button.textContent = 'Save now'
      button.disabled = false
      addLog({ at: new Date().toISOString(), level: 'error', message: error.message })
    }
    return false
  }
}
el('instanceSave').onclick = () => saveInstanceEditor()
el('instanceEditor').addEventListener('input', () => {
  if (!state.instanceRevealed) return
  if (state.instanceAutosaveTimer) clearTimeout(state.instanceAutosaveTimer)
  el('instanceAutoSave').textContent = 'Change detected — autosave pending'
  el('instanceAutoSave').classList.remove('warning')
  state.instanceAutosaveTimer = setTimeout(() => {
    state.instanceAutosaveTimer = null
    saveInstanceEditor({ automatic: true })
  }, 550)
})
el('instanceReset').onclick = async () => { if (!await ffConfirm('Reset instance config?', 'Reset this instance to the blank base config and filter?', { confirmLabel: 'Reset to Base', danger: true })) return; const result = await window.ff.files.resetDefaults(); state.instanceFiles = result; renderInstanceEditor() }

let pendingBotState = null
let botRenderFrame = null
window.ff.onBotState(bot => {
  pendingBotState = bot
  if (botRenderFrame) return
  botRenderFrame = requestAnimationFrame(() => {
    botRenderFrame = null
    const latest = pendingBotState
    pendingBotState = null
    renderBot(latest)
    if (pageIsActive('files')) renderInstanceEditor()
  })
})
window.ff.onMarket(renderMarket)
window.ff.onCollector(renderCollector)
let pendingAutomationState = null
let automationRenderFrame = null
window.ff.onAutomation(automation => {
  pendingAutomationState = {
    ...(pendingAutomationState || {}),
    ...automation,
    tracker: automation.tracker
      ? { ...(pendingAutomationState?.tracker || {}), ...automation.tracker }
      : pendingAutomationState?.tracker
  }
  if (automationRenderFrame) return
  automationRenderFrame = requestAnimationFrame(() => {
    automationRenderFrame = null
    const latest = pendingAutomationState
    pendingAutomationState = null
    renderAutomation(latest)
  })
})
const pendingLogEntries = []
let logRenderFrame = null
window.ff.onLog(entry => {
  if (entry.instanceId !== state.instances.selectedId) return
  pendingLogEntries.push(entry)
  if (logRenderFrame) return
  logRenderFrame = requestAnimationFrame(() => {
    logRenderFrame = null
    const entries = pendingLogEntries.splice(0)
    state.instanceLogs.push(...entries)
    if (state.instanceLogs.length > 1000) state.instanceLogs.splice(0, state.instanceLogs.length - 1000)
    addLogs(entries)
    if (pageIsActive('files')) renderInstanceEditor()
  })
})
function adoptDeviceCode(code) {
  if (code?.instanceId && code.instanceId !== state.instances?.selectedId) return
  const nextCode = String(code.userCode || '').toUpperCase()
  if (!nextCode || nextCode === state.dismissedDeviceCode) return
  state.deviceCode = nextCode
  state.deviceUrl = deviceLoginUrl(code)
  state.accountLinkPending = true
  state.accountLinkMode = 'link'
  showDeviceCode()
  renderAccountLinkButton(false)
}
window.ff.onDeviceCode(adoptDeviceCode)
window.ff.onInstancesSummary(totals => {
  renderTotalProfit(totals)
  if (totals?.instancesRuntime) renderInstances(totals.instancesRuntime)
})
if (typeof window.ff.onHubState === 'function') window.ff.onHubState(payload => rememberHubState(payload))
window.ff.onWindow(() => {})
window.ff.onChat(() => {})

window.ff.snapshot().then(snapshot => {
  if (snapshot.version) el('appVersion').textContent = `Version ${snapshot.version}`
  state.lan = snapshot.lan
  state.instanceFiles = snapshot.files
  state.instanceLogs = (snapshot.logs || []).slice(-1000)
  renderTotalProfit(snapshot.totals)
  renderBot(snapshot.bot)
  renderMarket(snapshot.scanner)
  renderCollector(snapshot.collector)
  renderAutomation(snapshot.automation, { forceGraphs: true })
  renderProxy(snapshot.proxy || {})
  renderWebCredentials(snapshot.webpage || {})
  loadFile(snapshot.files.config); loadFile(snapshot.files.filter)
  renderSavedProfiles(snapshot.savedProfiles || [])
  renderProxyPool(snapshot.proxyPool || {})
  renderInstances(snapshot.instances)
  if (snapshot.hub) rememberHubState(snapshot.hub)
  addLogs(snapshot.logs || [])
  window.ff.scanner.items().then(renderItems).catch(error => addLog({ at: new Date().toISOString(), level: 'error', message: error.message }))
}).catch(error => addLog({ at: new Date().toISOString(), level: 'error', message: error.message }))

setInterval(() => {
  const tracker = state.automation.tracker || {}; const elapsed = state.trackerReceivedAt ? (Date.now() - state.trackerReceivedAt) / 1000 : 0
  const uptime = Number(tracker.uptimeSeconds ?? tracker.runningSeconds) || 0
  el('ffRunning').textContent = formatClock(uptime + (tracker.uptimeActive && state.bot.status === 'connected' ? elapsed : 0))
  el('ffCookie').textContent = formatCookie(cookieSeconds(state.bot))
  updateOrderAges()
  renderStats(state.instances)
  const now = new Date(); const nextReset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); el('limitReset').textContent = formatClock((nextReset - Date.now()) / 1000)
}, 1000)
