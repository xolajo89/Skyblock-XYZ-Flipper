'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { sortMetric } = require('./market-scanner')

// Orders that survive this long are refreshed even when Hypixel does not
// expose a trustworthy orders/items-ahead marker. This is intentionally an
// internal invariant rather than an editable strategy setting.
const STALE_ORDER_RELIST_MS = 10 * 60 * 1000
const STALE_SELL_ORDER_RELIST_MS = 20 * 60 * 1000
// Market-driven repositioning is intentionally less aggressive than the
// initial placement cooldown. A single active competitor must not make the
// same item consume every Manage Orders cycle.
// A cooldown belongs to one concrete Bazaar row, not every order for the same
// item. Two minutes is still longer than the 90-second settle age while letting
// an aggressively configured relistAfter=1 recover queue position promptly.
const MARKET_RELIST_COOLDOWN_MS = 2 * 60 * 1000
const SELL_OFFER_RESERVATION_MS = 2 * 60 * 1000
const SELL_OFFER_OBSERVATION_GRACE_MS = 30 * 1000
const SELL_CONSOLIDATION_COOLDOWN_MS = 10 * 60 * 1000
const SELL_CONSOLIDATION_TIMEOUT_MS = 15 * 60 * 1000
const INACTIVITY_RESTART_MS = 10 * 60 * 1000
const CLAIM_BACKOFF_MS = 2 * 60 * 1000
const MAX_BAZAAR_ORDER_SLOTS = 14
const MUTATION_BLOCK_MS = 24 * 60 * 60 * 1000
const INVENTORY_CAPACITY_SAMPLE_MS = 30 * 1000
const PLAYER_INVENTORY_SLOT_COUNT = 36
const PARTIAL_BUY_BATCH_MIN_ITEMS = 4
const PARTIAL_BUY_BATCH_RATIO = 0.25
const PARTIAL_BUY_BATCH_MAX_WAIT_MS = 5 * 60 * 1000
// A failed Manage Orders open while Hub Roaming is active must yield a real
// movement window. Retrying one second later kept the player frozen in a
// near-continuous Bazaar loop and the third retry restarted the whole
// instance. Back off progressively instead; a healthy Manage read resets the
// streak immediately.
const HUB_MANAGE_FAILURE_BACKOFF_MIN_MS = 45 * 1000
const HUB_MANAGE_FAILURE_BACKOFF_MAX_MS = 2 * 60 * 1000
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const itemKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const stackSizeForItem = item => {
  const explicit = number(item?.maxStackSize ?? item?.max_stack_size ?? item?.stackSize)
  if ([1, 16, 64].includes(explicit)) return explicit
  const id = String(item?.apiItemId || item?.itemId || item?.material || item?.kind || '').toUpperCase()
  const category = String(item?.category || '').toUpperCase()
  const name = itemKey(item?.displayName || item?.itemName || item?.name)
  if (id.startsWith('ENCHANTMENT_') || id.includes('ENCHANTEDBOOK') || id.includes('ENCHANTED_BOOK') || category.includes('ENCHANT') || name.includes('enchanted book')) return 1
  if (/(?:^|_)ENDER_PEARL$/.test(id) || name === 'ender pearl' || name === 'ender pearls') return 16
  if (/(?:^|_)(?:SNOWBALL|EGG)$/.test(id)) return 16
  if (/(?:SWORD|PICKAXE|SHOVEL|_AXE|_HOE|HELMET|CHESTPLATE|LEGGINGS|BOOTS|BOW|FISHING_ROD|POTION|BUCKET)$/.test(id)) return 1
  return 64
}
const coinValue = value => {
  const match = String(value || '').replaceAll(',', '').trim().match(/^([\d.]+)\s*([KMGBT])?$/i)
  if (!match) return 0
  return number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(match[2] || '').toUpperCase()] || 1)
}

class BazaarAutomation extends EventEmitter {
  constructor(bot, readSettings, log, trackerFile = '', chatFile = '') {
    super()
    this.bot = bot
    this.readSettings = readSettings
    this.log = log
    this.market = { candidates: [] }
    this.marketReceivedAt = 0
    this.timer = null
    this.postManualSyncTimer = null
    this.manageOrdersRecheckTimer = null
    this.orderDetailRecheckTimer = null
    this.pendingClickTimer = null
    this.pendingClickIntent = ''
    this.pendingClickResult = null
    this.actionGeneration = 0
    this.phaseStartedAt = Date.now()
    this.phaseRetryCount = 0
    this.manageOpenRetries = 0
    this.lastDiagnosticAt = 0
    this.lastScreenSignature = ''
    this.lastScreenHandledAt = 0
    this.lastDiagnosticSignature = ''
    // Bot state events also carry routine screen/order updates. Remember the
    // connection edge so those updates cannot continually postpone a due
    // Manage Orders synchronization.
    this.lastBotStatus = bot.state?.status || ''
    this.lastIslandReady = null
    this.uptimeAccountKey = ''
    this.connectedSinceAt = 0
    this.uptimeClockStartedAt = null
    this.lastUptimeSaveAt = 0
    this.searchRequestId = 0
    this.nextSyncAt = 0
    // Hub Roaming owns the route-specific Bazaar NPC coordinates. It may
    // register a per-instance opener here so an account whose remote /bz is
    // ignored can recover through the physical NPC without sharing state with
    // another instance.
    this.hubBazaarOpener = null
    // Some accounts accept chat normally while Hypixel silently ignores /bz.
    // Once observed, keep that decision per instance instead of alternating a
    // failed command and a physical NPC recovery on every Manage cycle.
    this.manageOpenMethod = ''
    // A live bridge can still get stuck in a GUI loop while emitting routine
    // diagnostics.  Track only server-confirmed Bazaar work, so one stalled
    // instance can recover without restarting its healthy neighbours.
    this.lastConfirmedBazaarActionAt = Date.now()
    // Routine Manage Orders reads and cancel/repost churn are not economic
    // progress.  Keep a separate clock so a live-but-stuck instance can still
    // trigger the requested ten-minute self-restart.
    this.lastProductiveBazaarActionAt = Date.now()
    this.lastHealthyManageSyncAt = Date.now()
    this.watchdogWorkPending = false
    this.actionableIdleSinceAt = 0
    this.lastInactivityRestartAt = 0
    this.inactivityRestartPending = false
    this.inventoryClaimRecoveryPending = false
    // Keep Hypixel's authoritative Item Stash warning visible until the server
    // confirms that it is empty. This is informational only: trading continues
    // and XYZ never sends /pickupstash automatically.
    this.stashBlocked = false
    this.stashItemCount = 0
    this.stashCountConfirmed = false
    this.stashRefundPendingUntil = 0
    // Preserve an idle Manage Orders screen so the next check can refresh it
    // through Go Back -> Manage Orders instead of typing /bz again.
    this.manageRefreshSlot = null
    this.manualControlUntil = 0
    this.failedBuyTargets = new Map()
    // Runtime state must be attached to an individual Bazaar row. Hypixel can
    // legitimately show several Sell Offers for the same item; item-keyed
    // clocks made a fresh sibling reset the age/progress/cooldown of all of
    // them. The registry reconciles rows between Manage Orders snapshots.
    this.liveOrderRegistry = new Map()
    this.activeLiveOrderIds = new Set()
    this.liveOrderSequence = 0
    this.pendingOrderPlacements = []
    this.orderPlacedAt = new Map()
    this.orderFillProgress = new Map()
    this.lastMarketRelistAt = new Map()
    this.lastRelistAuditAt = 0
    this.lastRelistAuditSignature = ''
    this.buyReservations = new Map()
    this.recentOrderSightings = new Map()
    this.lastOrderPlacementAt = 0
    this.manageFailureStreak = 0
    this.hubNpcFallbackPending = false
    this.manageReconnectPending = false
    this.serverOrderCapUntil = 0
    this.confirmationRetries = 0
    this.confirmationRetryTimer = null
    this.confirmationRetrySlot = null
    this.sellPanelRetries = 0
    this.sellSearchRetries = 0
    this.buySearchRetries = 0
    this.chatSubmissionAcknowledged = ''
    this.waitingForPurse = false
    this.lastPurseWaitLogAt = 0
    this.lastMarketWaitLogAt = 0
    this.nextCookieProbeAt = 0
    this.cookieProbeTimer = null
    this.cookiePurchaseAttempts = 0
    this.cookiePurchaseCooldownUntil = 0
    this.cookieConsumptionAttempts = 0
    this.cookieVerificationPending = false
    this.cookieBeforePurchaseSeconds = null
    this.cookieConsumeTimer = null
    this.cookieStateAccountKey = this.accountKey(bot.state)
    this.cookieAccountStates = new Map()
    this.activationCookieProbePending = false
    this.nextRestAt = 0
    this.restUntil = 0
    this.filledOrderRefreshPending = false
    this.pendingFilledBuys = new Map()
    this.pendingFilledSells = new Map()
    this.pendingFillSequence = 0
    // A successful coin claim can leave its old Claim Coins lore visible for
    // several Manage Orders refreshes.  Keep a short per-account suppression
    // so the stale card cannot monopolize the GUI until a new fill event
    // explicitly re-arms it.
    this.recentlyClaimedSellCards = new Map()
    // Claim All Coins can acknowledge several cards after the first chat line
    // has already returned the automation to idle. Preserve the exact rows
    // from the click so those later acknowledgements never fall back to an
    // item-wide suppression that also hides an unrelated same-item sibling.
    this.claimAllSellBatch = null
    // A malformed or unavailable order-detail card must never pin an entire
    // instance in the same claim phase. The offer stays untouched and is
    // retried later, while unrelated orders keep trading.
    this.claimBackoffs = new Map()
    this.pendingCancel = null
    this.recentBuySelections = new Map()
    this.pendingSells = new Map()
    // A crowded book can contain several small Sell Offer rows for one item.
    // Consolidation is deliberately a single, explicit transaction: cancel
    // every sibling one at a time, trust only Hypixel's refunded-item chat
    // acknowledgements, then create one replacement from the combined loose
    // inventory. Keeping this state separate from ordinary relisting prevents
    // a cancel/repost loop and makes unrelated items impossible to touch.
    this.sellConsolidation = null
    this.sellConsolidationSequence = 0
    this.sellConsolidationCooldowns = new Map()
    this.lastSellConsolidationCapacityWarningAt = 0
    this.pendingSellRecoveryAccounts = new Map()
    this.sellOfferReservations = new Map()
    this.missingInventorySuppressions = new Map()
    this.pendingBuyRelists = new Map()
    this.pendingPartialBuyCancels = new Map()
    this.claimedBuyFillCounts = new Map()
    this.buyClaimAttempts = new Map()
    // A newly visible partial fill is not claimed one item at a time. Keep the
    // first observation for the current unclaimed batch so a slowly filling
    // order is drained after a bounded wait without fragmenting every Sell
    // Offer slot into 1x/2x lots.
    this.partialBuyBatches = new Map()
    this.recentClaimMessages = new Map()
    this.startupClearedAccounts = new Set()
    this.startupClearAccount = ''
    this.startupClearTimer = null
    this.startupClearWaitingForIsland = false
    this.startupClearStarted = false
    this.inventoryCapacitySnapshot = null
    this.trackerFile = trackerFile
    this.chatFile = chatFile
    this.profitRepairAccounts = new Set()
    this.diagnosticsFile = trackerFile ? path.join(path.dirname(trackerFile), 'ff-trader-diagnostics.jsonl') : ''
    this.tracker = this.loadTracker()
    this.state = {
      enabled: false,
      status: 'WAITING',
      phase: 'idle',
      target: null,
      lastAction: 'Waiting for connection and market data.',
      lastActionAt: null,
      counts: { buyOrders: 0, sellOffers: 0, claimedItems: 0, claimedCoins: 0, cancelled: 0, recoveries: 0 },
      activity: [],
      tracker: this.trackerSnapshot()
    }
    bot.on('state', snapshot => this.onBotState(snapshot))
    bot.on('window', screen => this.onWindow(screen))
    bot.on('chat', message => this.onChat(message.text || ''))
    bot.on('hotbar-item-ready', item => this.onHotbarItemReady(item))
    bot.on('hotbar-item-error', error => this.onHotbarItemError(error))
    bot.on('manual-order-action-complete', () => {
      if (this.startupClearAccount) {
        this.startupClearedAccounts.add(this.startupClearAccount)
        this.activity('success', 'clearOnStart finished; the account is ready for automatic trading.', null)
        this.startupClearAccount = ''
        this.startupClearWaitingForIsland = false
        this.startupClearStarted = false
      }
      // Clearing can completely change both free slots and partial stacks.
      // Force the next normal Manage Orders read to take a fresh snapshot.
      this.inventoryCapacitySnapshot = null
      this.manualControlUntil = 0
      this.finishCycle()
      this.activity('success', 'Manual Clear Orders / Inventory finished; automatic trading resumed.', null)
      this.diagnostic('manual-clear-complete')
      this.schedulePostManualSync()
    })
    bot.on('claim-inventory-recovery-complete', result => {
      this.inventoryClaimRecoveryPending = false
      this.inventoryCapacitySnapshot = null
      const target = result?.target
      if (target?.itemName) this.buyClaimAttempts.delete(this.orderTimestampKey('buy', target.itemName))
      if (result?.success === false) {
        // If the inventory contains only non-Bazaar items there is nothing FF
        // can sell safely. Stop retrying Claim Items (and spamming Hypixel)
        // until the operator frees a slot or uses the manual Clear action.
        this.manualControlUntil = Date.now() + 5 * 60 * 1000
        this.setPhase('idle', 'WAITING FOR INVENTORY SPACE', null)
        this.nextSyncAt = this.manualControlUntil
        this.activity('error', result?.message || 'Automatic inventory recovery could not free a slot; clear one inventory slot manually.', target || null)
        return
      }
      this.manualControlUntil = 0
      this.finishCycle()
      this.activity('success', result?.message || 'Bazaar inventory was sold to free claim space; retrying the completed buy order.', target || null)
      this.schedulePostManualSync()
    })
  }

  options() { return this.readSettings().config.automation.autoTrader || {} }
  stashStatus() {
    const countLabel = this.stashCountConfirmed && this.stashItemCount > 0
      ? `${this.stashItemCount} ITEM${this.stashItemCount === 1 ? '' : 'S'}`
      : 'COUNT UNKNOWN'
    return `STASH WARNING · ${countLabel} · CLEAR MANUALLY · TRADING CONTINUES`
  }
  diagnostic(reason) {
    const record = {
      at: new Date().toISOString(), reason, enabled: Boolean(this.options().enabled), botStatus: this.bot.state.status,
      phase: this.state.phase, status: this.state.status, candidates: this.market.candidates?.length || 0,
      orders: this.bot.state.orders?.length || 0, manualPauseMs: Math.max(0, this.manualControlUntil - Date.now()),
      nextSyncMs: Math.max(0, this.nextSyncAt - Date.now()), timerRunning: Boolean(this.timer)
    }
    if (this.diagnosticsFile) {
      try { fs.appendFileSync(this.diagnosticsFile, `${JSON.stringify(record)}\n`, 'utf8') } catch {}
    }
    this.log('debug', `[Auto Trader Diagnostics] ${reason}: enabled=${record.enabled}, bot=${record.botStatus}, phase=${record.phase}, candidates=${record.candidates}, orders=${record.orders}, manualPauseMs=${record.manualPauseMs}, nextSyncMs=${record.nextSyncMs}, timer=${record.timerRunning}.`)
  }
  diagnosticWindow(screen) {
    if (!this.diagnosticsFile || this.state.phase === 'idle') return
    const record = {
      at: new Date().toISOString(),
      reason: 'window',
      phase: this.state.phase,
      title: this.bot.cleanText(screen.title || ''),
      slots: (screen.slots || []).filter(slot => this.slotName(slot)).map(slot => ({
        slot: slot.slot,
        name: this.slotName(slot),
        lore: (slot.lore || []).map(line => this.bot.cleanText(line)).filter(Boolean)
      }))
    }
    try { fs.appendFileSync(this.diagnosticsFile, `${JSON.stringify(record)}\n`, 'utf8') } catch {}
  }
  schedulePostManualSync(delayMs = 750) {
    if (this.postManualSyncTimer) clearTimeout(this.postManualSyncTimer)
    this.postManualSyncTimer = setTimeout(() => {
      this.postManualSyncTimer = null
      this.diagnostic('post-manual-sync')
      if (this.running() && this.state.phase === 'idle') this.syncOrders()
    }, delayMs)
    this.postManualSyncTimer.unref?.()
  }
  snapshot() {
    const snapshot = JSON.parse(JSON.stringify(this.state))
    snapshot.stash = {
      blocked: this.stashBlocked === true,
      itemCount: this.stashCountConfirmed ? Math.max(0, Math.floor(number(this.stashItemCount))) : null,
      status: this.stashBlocked ? this.stashStatus() : ''
    }
    return snapshot
  }
  liveTrackerSnapshot() {
    const source = this.state.tracker || {}
    const tracker = { ...source }
    const history = Array.isArray(source.history) ? source.history : []
    const profitHistory = Array.isArray(source.profitHistory) ? source.profitHistory : []
    const lastHistory = history.at(-1) || {}
    const lastProfit = profitHistory.at(-1) || {}
    const signature = `${history.length}:${lastHistory.at || 0}:${lastHistory.total || 0}|${profitHistory.length}:${lastProfit.at || 0}:${lastProfit.profit || 0}`
    const now = Date.now()
    // Histories can contain 3,000+ points. Send them only when their tail
    // changes (or as an occasional refresh); ordinary GUI/status packets only
    // need the compact tracker metrics.
    if (signature !== this.lastLiveTrackerHistorySignature || now - number(this.lastLiveTrackerHistoryAt) >= 30000) {
      this.lastLiveTrackerHistorySignature = signature
      this.lastLiveTrackerHistoryAt = now
    } else {
      delete tracker.history
      delete tracker.profitHistory
    }
    return tracker
  }
  liveSnapshot({ includeTracker = false, includeActivity = false } = {}) {
    const snapshot = {
      enabled: this.state.enabled,
      status: this.state.status,
      phase: this.state.phase,
      target: this.state.target,
      lastAction: this.state.lastAction,
      lastActionAt: this.state.lastActionAt,
      counts: { ...(this.state.counts || {}) },
      stash: {
        blocked: this.stashBlocked === true,
        itemCount: this.stashCountConfirmed ? Math.max(0, Math.floor(number(this.stashItemCount))) : null,
        status: this.stashBlocked ? this.stashStatus() : ''
      }
    }
    if (includeTracker) snapshot.tracker = this.liveTrackerSnapshot()
    if (includeActivity) snapshot.activity = (this.state.activity || []).slice(0, 100)
    return snapshot
  }
  update(patch = {}) {
    Object.assign(this.state, patch)
    this.emit('state', this.liveSnapshot({ includeTracker: Object.hasOwn(patch, 'tracker') }))
  }
  periodKey(at = Date.now()) {
    // Hypixel's Bazaar period resets at 8 PM in New York. Using the named
    // timezone keeps that true through both EST and EDT.
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
    const value = type => local.find(part => part.type === type)?.value || ''
    if (Number(value('hour')) >= 20) return `${value('year')}-${value('month')}-${value('day')}`
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at - 24 * 60 * 60 * 1000))
  }
  loadTracker() {
    const empty = { periodKey: this.periodKey(), accounts: {} }
    if (!this.trackerFile) return empty
    try { return { ...empty, ...JSON.parse(fs.readFileSync(this.trackerFile, 'utf8')) } } catch { return empty }
  }
  trackerSnapshot() {
    const account = this.accountLimitTracker()
    const used = number(account.dailyLimitUsed)
    const allHistory = Array.isArray(account.history) ? account.history.slice(-2000) : []
    // The daily limit chart begins at the latest 8 PM reset. Profit keeps its
    // complete lifetime history and is never zeroed by a daily rollover.
    const limitStartedAt = Math.max(0, number(account.limitPeriodStartedAt))
    const history = limitStartedAt ? allHistory.filter(point => number(point.at) >= limitStartedAt) : allHistory
    const profitResetAt = Math.max(0, number(account.profitResetAt))
    const profitHistory = profitResetAt ? allHistory.filter(point => number(point.at) >= profitResetAt) : allHistory
    const first = history.find(point => number(point.total) > 0) || history[0]
    const last = history.at(-1)
    const hours = first && last ? Math.max(0, (number(last.at) - number(first.at)) / 3600000) : 0
    const limitRatePerHour = hours > 0 ? Math.max(0, (number(last.total) - number(first.total)) / hours) : 0
    const accountKey = this.accountKey()
    const uptimeActive = Boolean(this.connectedSinceAt && this.uptimeAccountKey === accountKey && this.bot.state.status === 'connected')
    const uptimeSeconds = Math.max(0, number(account.uptimeSeconds) + (uptimeActive ? this.currentUptimeSegmentSeconds() : 0))
    return {
      periodKey: this.tracker.periodKey, resetTimezone: 'America/New_York', resetHour: 20,
      profit: number(account.profit), acquisitionCost: number(account.acquisitionCost), realizedRevenue: number(account.realizedRevenue), realizedTrades: number(account.realizedTrades),
      manualAdjustment: number(account.manualAdjustment), taxAndFees: number(account.taxAndFees),
      purse: this.bot.state.purse !== null && this.bot.state.purse !== undefined && Number.isFinite(Number(this.bot.state.purse)) ? Number(this.bot.state.purse) : null,
      purseUpdatedAt: this.bot.state.purseUpdatedAt || '',
      dailyLimitUsed: used, dailyLimitMax: 15000000000, dailyLimitRemaining: Math.max(0, 15000000000 - used), dailyLimitPercent: Math.min(100, used / 15000000000 * 100),
      buyOfferValue: number(account.buyOfferValue), sellOfferValue: number(account.sellOfferValue), account: account.label,
      history, profitHistory, profitResetAt, uptimeSeconds, uptimeActive, runningSeconds: uptimeSeconds, profitPerHour: uptimeSeconds > 0 ? number(account.profit) / uptimeSeconds * 3600 : 0,
      limitRatePerHour, estimatedSecondsToLimit: limitRatePerHour > 0 ? Math.max(0, 15000000000 - used) / limitRatePerHour * 3600 : null
    }
  }
  accountLimitTracker() {
    if (!this.tracker.accounts || typeof this.tracker.accounts !== 'object') this.tracker.accounts = {}
    const key = String(this.bot.state.activeAccountId || this.bot.state.username || 'default')
    const label = String(this.bot.state.username || this.bot.state.activeAccountId || 'Current account')
    const existing = this.tracker.accounts[key]
    if (existing && !Number.isFinite(Number(existing.uptimeSeconds))) {
      existing.uptimeSeconds = Math.max(0, (Date.now() - number(existing.startedAt, Date.now())) / 1000)
    }
    if (!existing) this.tracker.accounts[key] = {
      periodKey: this.periodKey(), label, startedAt: Date.now(), profit: 0, acquisitionCost: 0, realizedRevenue: 0, realizedTrades: 0,
      manualAdjustment: 0, taxAndFees: 0, adjustments: [], blockedBuyItems: {},
      uptimeSeconds: 0, dailyLimitUsed: 0, buyOfferValue: 0, sellOfferValue: 0, inventory: {}, looseInventory: {}, sellPlans: {}, limitPeriodStartedAt: Date.now(), history: [{ at: Date.now(), profit: 0, buy: 0, sell: 0, total: 0 }]
    }
    else {
      if (label) existing.label = label
      if (existing.periodKey !== this.periodKey()) {
        // A daily reset is deliberately limited to the Buy, Sell, and Total
        // counters. Lifetime profit, uptime, purse, cookie state, inventory,
        // and the profit graph must survive both 8 PM and app restarts.
        existing.periodKey = this.periodKey()
        existing.dailyLimitUsed = 0
        existing.buyOfferValue = 0
        existing.sellOfferValue = 0
        existing.limitPeriodStartedAt = Date.now()
        if (!Array.isArray(existing.history)) existing.history = []
        existing.history.push({ at: Date.now(), profit: number(existing.profit), buy: 0, sell: 0, total: 0 })
      }
    }
    const account = this.tracker.accounts[key]
    account.startedAt = number(account.startedAt, Date.now())
    for (const field of ['profit', 'acquisitionCost', 'realizedRevenue', 'realizedTrades', 'manualAdjustment', 'taxAndFees', 'uptimeSeconds', 'dailyLimitUsed', 'buyOfferValue', 'sellOfferValue']) account[field] = number(account[field])
    if (!Array.isArray(account.adjustments)) account.adjustments = []
    if (!account.blockedBuyItems || typeof account.blockedBuyItems !== 'object') account.blockedBuyItems = {}
    if (!account.inventory || typeof account.inventory !== 'object') account.inventory = {}
    if (!account.looseInventory || typeof account.looseInventory !== 'object') account.looseInventory = {}
    if (!account.sellPlans || typeof account.sellPlans !== 'object') account.sellPlans = {}
    if (!Array.isArray(account.history)) account.history = []
    account.limitPeriodStartedAt = number(account.limitPeriodStartedAt, account.startedAt)
    if (!account.history.length) account.history.push({ at: Date.now(), profit: account.profit, buy: account.buyOfferValue, sell: account.sellOfferValue, total: account.dailyLimitUsed })
    return account
  }
  saveTracker() {
    if (this.trackerFile) {
      try { fs.writeFileSync(this.trackerFile, `${JSON.stringify(this.tracker, null, 2)}\n`, 'utf8') } catch (error) { this.log('error', `Could not save FF profit/limit tracker: ${error.message}`) }
    }
    this.state.tracker = this.trackerSnapshot()
  }
  ensureTrackerPeriod() {
    const key = this.periodKey()
    if (this.tracker.periodKey === key) return false
    this.tracker.periodKey = key
    this.saveTracker()
    return true
  }
  trackOffer(type, total) {
    this.ensureTrackerPeriod()
    const amount = Math.max(0, coinValue(total))
    const account = this.accountLimitTracker()
    account.dailyLimitUsed += amount
    account[type === 'buy' ? 'buyOfferValue' : 'sellOfferValue'] += amount
    this.appendTrackerPoint(account)
    this.saveTracker()
  }
  addAcquisition(itemName, quantity, cost) {
    this.ensureTrackerPeriod()
    const key = String(itemName || '').trim().toLowerCase()
    if (!key) return
    const account = this.accountLimitTracker()
    const lot = account.inventory[key] || { itemName, quantity: 0, cost: 0 }
    const acquired = Math.max(0, number(quantity))
    lot.quantity += acquired; lot.cost += Math.max(0, coinValue(cost)); account.inventory[key] = lot
    const loose = account.looseInventory[key] || { itemName, quantity: 0 }
    loose.quantity += acquired
    account.looseInventory[key] = loose
    this.saveTracker()
  }
  adjustLooseInventory(itemName, quantityDelta) {
    const account = this.accountLimitTracker()
    const key = String(itemName || '').trim().toLowerCase()
    if (!key) return false
    const current = account.looseInventory[key] || { itemName, quantity: 0 }
    current.quantity = Math.max(0, number(current.quantity) + number(quantityDelta))
    if (current.quantity <= 0.000001) delete account.looseInventory[key]
    else account.looseInventory[key] = current
    this.saveTracker()
    return true
  }
  discardMissingAcquisition(itemName, quantity) {
    const account = this.accountLimitTracker()
    const key = String(itemName || '').trim().toLowerCase()
    const lot = account.inventory?.[key]
    if (!lot || number(lot.quantity) <= 0) return false
    const removed = Math.min(number(lot.quantity), Math.max(1, number(quantity, lot.quantity)))
    const removedCost = number(lot.cost) * removed / number(lot.quantity)
    lot.quantity -= removed
    lot.cost -= removedCost
    if (lot.quantity <= 0.000001) delete account.inventory[key]
    this.saveTracker()
    this.log('warning', `[Profit Tracker] Removed ${Math.round(removed)}x ${itemName} (${Math.round(removedCost).toLocaleString('en-US')} cost basis) after two independent Bazaar inventory checks confirmed it is no longer present.`)
    return true
  }
  trackSellPlan(itemName, quantity, total) {
    const account = this.accountLimitTracker(); const key = String(itemName || '').trim().toLowerCase()
    if (key) account.sellPlans[key] = { quantity: Math.max(0, number(quantity)), total: Math.max(0, coinValue(total)) }
    this.saveTracker()
  }
  realizeSale(itemName, revenue, quantity = 0) {
    this.ensureTrackerPeriod()
    const account = this.accountLimitTracker()
    const key = String(itemName || '').trim().toLowerCase(); const lot = account.inventory[key]
    if (!lot || lot.quantity <= 0) return null
    const received = Math.max(0, coinValue(revenue)); const plan = account.sellPlans[key]
    const inferred = plan?.total > 0 ? plan.quantity * Math.min(1, received / plan.total) : lot.quantity
    const sold = number(quantity) > 0 ? Math.min(number(quantity), lot.quantity) : Math.min(inferred, lot.quantity)
    const cost = lot.cost * sold / lot.quantity
    const expectedGross = plan?.quantity > 0 ? plan.total * sold / plan.quantity : received
    lot.quantity -= sold; lot.cost -= cost
    if (lot.quantity <= 0.000001) delete account.inventory[key]
    // `looseInventory` tracks only physical, not-yet-offered items. The
    // authoritative Sell Offer Setup acknowledgement already removes offered
    // stock from it, so a later sale must never consume a newer loose lot of
    // the same item a second time.
    if (plan) { plan.quantity = Math.max(0, plan.quantity - sold); plan.total = Math.max(0, plan.total - received); if (plan.quantity <= 0.000001 || plan.total <= 0.01) delete account.sellPlans[key] }
    const profit = received - cost
    account.realizedRevenue += received; account.acquisitionCost += cost; account.profit += profit; account.realizedTrades += 1
    account.taxAndFees += Math.max(0, expectedGross - received)
    this.appendTrackerPoint(account)
    this.saveTracker(); return profit
  }
  parseCompletedSale(text) {
    const detailed = String(text || '').match(/Claimed(?: Amount:)?\s*([\d,.]+\s*[KMGBT]?)\s+coins\s+from\s+selling\s+([\d,]+)x\s+(.+?)\s+at\s+[\d,.]+\s+each[!.]?$/i)
    if (detailed) return { revenue: detailed[1], quantity: Number(detailed[2].replaceAll(',', '')), itemName: detailed[3].trim() }
    const plain = String(text || '').match(/Claimed(?: Amount:)?\s*([\d,.]+\s*[KMGBT]?)\s+coins(?:\s+from\s+selling\s+([\d,]+)x\s+(.+?))?[!.]?$/i)
    if (!plain) return null
    return {
      revenue: plain[1],
      quantity: plain[2] ? Number(plain[2].replaceAll(',', '')) : this.state.target?.quantity || 0,
      itemName: plain[3]?.trim() || this.state.target?.itemName || this.state.target?.displayName || ''
    }
  }
  repairMissedProfitFromChat() {
    if (!this.chatFile || !fs.existsSync(this.chatFile)) return 0
    const account = this.accountLimitTracker()
    const cursor = Date.parse(account.chatProfitReconciledThrough || '') || 0
    let latest = cursor
    let repaired = 0
    let rows
    try {
      rows = fs.readFileSync(this.chatFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
    } catch (error) {
      this.log('warning', `[Profit Tracker] Could not inspect the instance chat history: ${error.message}`)
      return 0
    }
    for (const row of rows) {
      const at = Date.parse(row.at || '') || 0
      if (!at || at <= cursor || this.periodKey(at) !== this.tracker.periodKey) continue
      latest = Math.max(latest, at)
      const text = this.bot.cleanText(row.text || '')
      const completed = this.parseCompletedSale(text)
      const instant = text.match(/\[Bazaar\]\s+Sold\s+([\d,]+)x\s+(.+?)\s+for\s+([\d,.]+\s*[KMGBT]?)\s+coins[!.]?$/i)
      const profit = completed
        ? this.realizeSale(completed.itemName, completed.revenue, completed.quantity)
        : instant
          ? this.realizeSale(instant[2].trim(), instant[3], Number(instant[1].replaceAll(',', '')))
          : null
      if (profit !== null) repaired += 1
    }
    if (latest > cursor) {
      account.chatProfitReconciledThrough = new Date(latest).toISOString()
      this.saveTracker()
    }
    if (repaired) this.activity('success', `Recovered profit from ${repaired} completed Bazaar sale${repaired === 1 ? '' : 's'} in the instance chat history.`, null)
    return repaired
  }
  adjustProfit(amount, note = 'Manual dashboard correction') {
    const adjustment = number(amount, NaN)
    if (!Number.isFinite(adjustment) || adjustment === 0) throw new Error('Profit adjustment must be a non-zero number.')
    if (Math.abs(adjustment) > 1_000_000_000_000) throw new Error('Profit adjustment is too large.')
    this.ensureTrackerPeriod()
    const account = this.accountLimitTracker()
    account.manualAdjustment += adjustment
    account.profit += adjustment
    account.adjustments.push({ at: new Date().toISOString(), amount: adjustment, note: String(note || 'Manual dashboard correction').slice(0, 120) })
    if (account.adjustments.length > 100) account.adjustments.splice(0, account.adjustments.length - 100)
    this.appendTrackerPoint(account)
    this.saveTracker()
    this.activity('info', `Profit adjusted ${adjustment >= 0 ? '+' : ''}${Math.round(adjustment).toLocaleString('en-US')} coins.`, null)
    return this.trackerSnapshot()
  }
  beginUptime(snapshot = this.bot.state) {
    if (this.connectedSinceAt) return
    const key = this.accountKey(snapshot)
    this.accountLimitTracker()
    this.uptimeAccountKey = key
    this.connectedSinceAt = Date.now()
    this.uptimeClockStartedAt = process.hrtime.bigint()
    this.lastUptimeSaveAt = this.connectedSinceAt
    this.saveTracker()
  }
  currentUptimeSegmentSeconds() {
    if (!this.uptimeClockStartedAt) return 0
    return Math.max(0, Number(process.hrtime.bigint() - this.uptimeClockStartedAt) / 1e9)
  }
  flushUptime(keepRunning = true) {
    if (!this.connectedSinceAt || !this.uptimeAccountKey) return false
    const now = Date.now()
    const account = this.tracker.accounts?.[this.uptimeAccountKey]
    if (account) account.uptimeSeconds = number(account.uptimeSeconds) + this.currentUptimeSegmentSeconds()
    this.connectedSinceAt = keepRunning ? now : 0
    this.uptimeClockStartedAt = keepRunning ? process.hrtime.bigint() : null
    if (!keepRunning) this.uptimeAccountKey = ''
    this.lastUptimeSaveAt = now
    this.saveTracker()
    return true
  }
  resetInformation() {
    const active = Boolean(this.connectedSinceAt && this.uptimeAccountKey === this.accountKey() && this.bot.state.status === 'connected')
    const account = this.accountLimitTracker()
    account.profit = 0
    account.acquisitionCost = 0
    account.realizedRevenue = 0
    account.realizedTrades = 0
    account.manualAdjustment = 0
    account.taxAndFees = 0
    account.adjustments = []
    account.uptimeSeconds = 0
    account.startedAt = Date.now()
    account.profitResetAt = Date.now()
    if (active) {
      this.connectedSinceAt = Date.now()
      this.uptimeClockStartedAt = process.hrtime.bigint()
      this.lastUptimeSaveAt = this.connectedSinceAt
    }
    this.appendTrackerPoint(account)
    this.saveTracker()
    this.activity('warning', 'Profit and uptime information reset manually. Daily Bazaar Limit totals were kept.', null)
    return this.trackerSnapshot()
  }
  appendTrackerPoint(account = this.accountLimitTracker()) {
    if (!Array.isArray(account.history)) account.history = []
    account.history.push({ at: Date.now(), profit: number(account.profit), buy: number(account.buyOfferValue), sell: number(account.sellOfferValue), total: number(account.dailyLimitUsed) })
    if (account.history.length > 2000) account.history.splice(0, account.history.length - 2000)
  }
  activity(kind, message, target = this.state.target) {
    const entry = { at: new Date().toISOString(), kind, message, target: target?.displayName || target?.itemName || '' }
    this.state.activity.unshift(entry)
    if (this.state.activity.length > 250) this.state.activity.length = 250
    this.state.lastAction = message
    this.state.lastActionAt = entry.at
    this.log(kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : kind === 'success' ? 'success' : 'info', `[Auto Trader] ${message}`)
    this.emit('state', this.liveSnapshot({ includeActivity: true }))
  }
  setPhase(phase, status, target = this.state.target) {
    const previousPhase = this.state.phase
    const previousTarget = itemKey(this.state.target?.itemName || this.state.target?.displayName)
    const nextTarget = itemKey(target?.itemName || target?.displayName)
    if (this.pendingClickTimer) clearTimeout(this.pendingClickTimer)
    this.pendingClickTimer = null
    this.pendingClickIntent = ''
    this.pendingClickResult = null
    this.actionGeneration += 1
    this.phaseStartedAt = Date.now()
    if (phase !== previousPhase || previousTarget !== nextTarget) this.phaseRetryCount = 0
    if (!/^opening-(?:buy|sell)$/.test(phase)) this.bot.cancelBazaarSearch?.()
    if (phase !== 'reading-manage' && this.manageOrdersRecheckTimer) {
      clearTimeout(this.manageOrdersRecheckTimer)
      this.manageOrdersRecheckTimer = null
    }
    if (!/^(?:awaiting-claim-(?:buy|sell)|cancel-options|awaiting-cancel)$/.test(phase) && this.orderDetailRecheckTimer) {
      clearTimeout(this.orderDetailRecheckTimer)
      this.orderDetailRecheckTimer = null
    }
    this.update({ phase, status, target: target ? { ...target } : null })
  }
  randomDelay() {
    const config = this.readSettings().config.automation
    const min = Math.max(0, number(config.clickDelayMinMs, 350))
    const max = Math.max(min, number(config.clickDelayMaxMs, 850))
    return min + Math.floor(Math.random() * (max - min + 1))
  }
  signature(screen) {
    return `${screen.title}|${(screen.slots || []).map(slot => {
      const lore = (slot.lore || []).map(line => this.bot.cleanText(line)).join('~')
      return `${slot.slot}:${this.bot.cleanText(slot.name)}:${number(slot.count)}:${lore}`
    }).join('|')}`
  }
  orderTimestampKey(type, name) { return `${this.accountKey()}:${type}:${itemKey(name)}` }
  orderRuntimeKey(order, fallbackType = '', fallbackName = '') {
    if (order && typeof order === 'object') {
      const liveId = order.liveOrderId || order.runtimeOrderId
      if (liveId) return `${this.accountKey()}:live:${liveId}`
    }
    return this.orderTimestampKey(order?.type || fallbackType, order?.itemName || fallbackName)
  }
  orderStateValue(map, order, fallback = undefined) {
    const runtimeKey = this.orderRuntimeKey(order)
    if (map.has(runtimeKey)) return map.get(runtimeKey)
    // Compatibility for orders first observed after an upgrade and for saved
    // pre-V7/test state. It is read-only: new Setup events never write this
    // semantic key, so one new sibling cannot reset the others again.
    const legacyKey = this.orderTimestampKey(order?.type, order?.itemName)
    return map.has(legacyKey) ? map.get(legacyKey) : fallback
  }
  retireLiveOrder(target) {
    const liveId = target?.liveOrderId || target?.runtimeOrderId
    if (!liveId) return false
    const runtimeKey = `${this.accountKey()}:live:${liveId}`
    this.activeLiveOrderIds.delete(liveId)
    this.liveOrderRegistry.delete(liveId)
    this.orderPlacedAt.delete(runtimeKey)
    this.orderFillProgress.delete(runtimeKey)
    this.lastMarketRelistAt.delete(runtimeKey)
    this.claimBackoffs.delete(runtimeKey)
    this.pendingFilledBuys.delete(runtimeKey)
    this.pendingFilledSells.delete(runtimeKey)
    this.recentlyClaimedSellCards.delete(runtimeKey)
    this.buyClaimAttempts.delete(runtimeKey)
    this.partialBuyBatches.delete(runtimeKey)
    this.claimedBuyFillCounts.delete(runtimeKey)
    return true
  }
  rememberPlacement(type, itemName, quantity, totalCoins, at = Date.now(), target = this.state.target) {
    const entry = {
      type, itemName: String(itemName || '').trim(), itemKey: itemKey(itemName),
      quantity: Math.max(0, Math.floor(number(quantity))),
      totalCoins: Math.max(0, number(totalCoins)), at,
      relistReason: target?.relistReason || '', replacedLiveOrderId: target?.liveOrderId || ''
    }
    this.pendingOrderPlacements.push(entry)
    if (this.pendingOrderPlacements.length > 50) this.pendingOrderPlacements.splice(0, this.pendingOrderPlacements.length - 50)
    return entry
  }
  reconcileLiveOrders(parsedOrders = [], observedAt = Date.now()) {
    const account = this.accountKey()
    this.pendingOrderPlacements = this.pendingOrderPlacements
      .filter(entry => observedAt - number(entry.at) < 3 * 60 * 1000)
    const previous = [...this.activeLiveOrderIds]
      .map(id => this.liveOrderRegistry.get(id))
      .filter(entry => entry?.account === account)
    const identityKey = order => {
      const type = String(order?.type || '')
      const key = order?.itemKey || itemKey(order?.itemName)
      const total = Math.max(0, number(order?.totalCount || order?.count))
      const price = Math.max(0, number(order?.unitPrice ?? order?.unitPriceCoins))
      return `${type}:${key}:${total}:${price}`
    }
    const previousIdentityCounts = new Map()
    const nextIdentityCounts = new Map()
    for (const order of previous) {
      const key = identityKey(order)
      previousIdentityCounts.set(key, number(previousIdentityCounts.get(key)) + 1)
    }
    for (const order of parsedOrders) {
      const key = identityKey(order)
      nextIdentityCounts.set(key, number(nextIdentityCounts.get(key)) + 1)
    }
    // If indistinguishable siblings shrink, the GUI gives us no evidence
    // whether the remaining slot is the old row or a later row compacted into
    // its place. Reusing either identity can transfer a claimed card's age,
    // cooldown or suppression to the survivor. Reset the ambiguous survivors
    // instead; an exact action tombstone still preserves all unambiguous rows.
    const ambiguousShrinkingIdentities = new Set([...previousIdentityCounts]
      .filter(([key, count]) => count > 1
        && number(nextIdentityCounts.get(key)) > 0
        && number(nextIdentityCounts.get(key)) < count)
      .map(([key]) => key))
    const used = new Set()
    const nextActive = new Set()
    const reconciled = parsedOrders.map(order => {
      const key = itemKey(order.itemName)
      const total = Math.max(0, number(order.totalCount || order.count))
      const price = Math.max(0, number(order.unitPriceCoins))
      const filled = Math.max(0, number(order.filledCount), number(order.claimableItems))
      const candidates = previous.filter(entry => !used.has(entry.liveOrderId)
        && entry.type === order.type && entry.itemKey === key
        && !ambiguousShrinkingIdentities.has(identityKey(order)))
      let matched = candidates.map(entry => {
        let score = 0
        if (entry.totalCount === total) score += 400
        if (price > 0 && entry.unitPrice > 0) {
          const delta = Math.abs(price - entry.unitPrice) / Math.max(1, price, entry.unitPrice)
          if (delta < 1e-9) score += 400
          else if (delta < 0.001) score += 250
          else if (delta < 0.01) score += 100
        }
        if (filled >= entry.filledCount) score += 100
        if (Number(order.slot) === entry.slot) score += 75
        if (String(order.id || '') === entry.sourceId) score += 25
        return { entry, score }
      }).sort((a, b) => b.score - a.score)[0]?.entry || null

      let placement = null
      if (!matched) {
        let placementIndex = this.pendingOrderPlacements.findIndex(entry => entry.type === order.type
          && entry.itemKey === key && (!entry.quantity || !total || entry.quantity === total))
        if (placementIndex < 0) placementIndex = this.pendingOrderPlacements.findIndex(entry => entry.type === order.type && entry.itemKey === key)
        if (placementIndex >= 0) placement = this.pendingOrderPlacements.splice(placementIndex, 1)[0]
      }

      const liveOrderId = matched?.liveOrderId || `${account}:${++this.liveOrderSequence}`
      used.add(liveOrderId)
      nextActive.add(liveOrderId)
      const runtimeKey = `${account}:live:${liveOrderId}`
      const legacyPlacedAt = number(this.orderPlacedAt.get(this.orderTimestampKey(order.type, order.itemName)), 0)
      const placedAt = number(this.orderPlacedAt.get(runtimeKey), number(matched?.placedAt,
        number(placement?.at, legacyPlacedAt || number(order.placedAt, observedAt))))
      const liveOrder = { ...order, liveOrderId, runtimeOrderId: liveOrderId, placedAt }
      this.orderPlacedAt.set(runtimeKey, placedAt)
      if (placement?.relistReason) this.lastMarketRelistAt.set(runtimeKey, number(placement.at, observedAt))
      this.liveOrderRegistry.set(liveOrderId, {
        account, liveOrderId, type: order.type, itemKey: key, itemName: order.itemName,
        totalCount: total, unitPrice: price, filledCount: filled, slot: Number(order.slot),
        sourceId: String(order.id || ''), placedAt, seenAt: observedAt
      })
      return liveOrder
    })

    for (const oldId of this.activeLiveOrderIds) {
      if (nextActive.has(oldId)) continue
      const old = this.liveOrderRegistry.get(oldId)
      if (old?.account !== account) continue
      // The row disappeared from an authoritative Manage snapshot. Retire its
      // row-scoped runtime state so a later slot reuse cannot inherit it.
      this.retireLiveOrder({ liveOrderId: oldId })
    }
    this.activeLiveOrderIds = nextActive
    // A claim acknowledgement can arrive before the first row-scoped Manage
    // snapshot (for example immediately after startup). Convert that legacy
    // semantic suppression into exact current card keys as soon as the rows
    // become identifiable, then remove the item-wide fallback.
    const migratedSellSuppressions = new Set()
    for (const order of reconciled) {
      if (order.type !== 'sell') continue
      const semanticKey = this.orderTimestampKey('sell', order.itemName)
      const until = number(this.recentlyClaimedSellCards.get(semanticKey))
      if (until <= observedAt || migratedSellSuppressions.has(semanticKey)) continue
      const claimRows = reconciled.filter(candidate => candidate.type === 'sell'
        && itemKey(candidate.itemName) === itemKey(order.itemName)
        && (this.hasSellClaimSignal(candidate) || this.isStructurallyComplete(candidate)))
      for (const row of claimRows) {
        this.recentlyClaimedSellCards.set(this.claimBackoffKey('sell', row), until)
      }
      if (claimRows.length) {
        this.recentlyClaimedSellCards.delete(semanticKey)
        migratedSellSuppressions.add(semanticKey)
      }
    }
    return reconciled
  }
  orderDetailsText(order) { return (order?.details || []).map(line => this.bot.cleanText(line)).join(' ') }
  hasBuyClaimSignal(order) {
    return number(order?.claimableItems) > 0 || /claim\s*items?|items?\s+to\s+claim|click\s+to\s+claim/i.test(this.orderDetailsText(order))
  }
  hasSellClaimSignal(order) {
    return number(order?.claimableCoins) > 0 || /claim\s*coins?|coins?\s+to\s+claim|click\s+to\s+claim/i.test(this.orderDetailsText(order))
  }
  isStructurallyComplete(order) {
    const total = Math.max(0, number(order?.totalCount || order?.count))
    return order?.complete === true || (total > 0 && number(order?.filledCount) >= total)
  }
  pendingFilledMap(type) { return type === 'sell' ? this.pendingFilledSells : this.pendingFilledBuys }
  pendingFilledEntry(type, order) {
    const pendingMap = this.pendingFilledMap(type)
    const runtime = pendingMap.get(this.orderRuntimeKey(order))
    if (runtime) return runtime
    return [...pendingMap.values()].find(entry => entry.account === this.accountKey()
      && !entry.liveOrderId && itemKey(entry.itemName) === itemKey(order?.itemName)) || null
  }
  claimBackoffKey(type, target) {
    return target && typeof target === 'object'
      ? this.orderRuntimeKey(target, type, target.itemName)
      : this.orderTimestampKey(type, target)
  }
  claimBackoffActive(type, target, now = Date.now()) {
    const key = this.claimBackoffKey(type, target)
    const legacyKey = target && typeof target === 'object'
      ? this.orderTimestampKey(type, target.itemName)
      : key
    const entryKey = this.claimBackoffs.has(key) ? key : legacyKey
    const entry = this.claimBackoffs.get(entryKey)
    if (!entry) return false
    if (number(entry.until) <= now) {
      // Keep the first failed attempt after its short retry delay. Previously
      // it was deleted here, so deferBrokenClaim() always saw attempt one and a
      // stale Claim Coins card could reopen every 15 seconds forever.
      if (number(entry.attempts) < 2) return false
      this.claimBackoffs.delete(entryKey)
      return false
    }
    return true
  }
  deferBrokenClaim(type, target, reason) {
    const itemName = target?.itemName || target?.displayName || ''
    if (!itemName) return false
    const key = this.claimBackoffKey(type, target)
    const previous = this.claimBackoffs.get(key)
    const attempts = Math.max(0, number(previous?.attempts)) + 1
    // Two local GUI timeouts are enough evidence that this card currently
    // cannot be acted on. Back off only that card; do not turn the whole
    // instance into an infinite 15-second recovery loop.
    if (attempts < 2) {
      this.claimBackoffs.set(key, { attempts, until: Date.now() + 1000 })
      return false
    }
    this.claimBackoffs.set(key, { attempts, until: Date.now() + CLAIM_BACKOFF_MS })
    this.setPhase('idle', 'SKIPPING STUCK CLAIM', null)
    this.nextSyncAt = Date.now() + 1000
    this.activity('warning', `${reason} ${itemName} will be retried in two minutes while this instance continues with its other orders.`, target)
    return true
  }
  rememberPendingFilled(type, itemName, quantity = 0, now = Date.now()) {
    const semanticKey = this.orderTimestampKey(type, itemName)
    const pendingMap = this.pendingFilledMap(type)
    const normalizedQuantity = Math.max(0, Math.floor(number(quantity)))
    const recentDuplicate = [...pendingMap.entries()].find(([, entry]) => entry.account === this.accountKey()
      && itemKey(entry.itemName) === itemKey(itemName)
      && normalizedQuantity <= Math.max(0, number(entry.quantity))
      && now - number(entry.lastEventAt, entry.at) < 3000)
    const existing = recentDuplicate?.[1] || pendingMap.get(semanticKey)
    const key = recentDuplicate?.[0] || (existing?.liveOrderId
      ? `${semanticKey}:event:${++this.pendingFillSequence}`
      : semanticKey)
    // The bridge can repeat the same fill chat while its Manage Orders
    // snapshot is still stale. Do not reset the bounded stale-snapshot escape
    // on a duplicate event, otherwise an order can freeze the whole trader
    // forever without ever reaching its safe card-level verification.
    const preserveRetryState = existing
      && existing.account === this.accountKey()
      && existing.confirmed !== true
      && normalizedQuantity <= Math.max(0, number(existing.quantity))
    pendingMap.set(key, {
      account: this.accountKey(), type, itemName: String(itemName || '').trim(),
      quantity: preserveRetryState ? Math.max(normalizedQuantity, number(existing.quantity)) : normalizedQuantity,
      at: preserveRetryState ? number(existing.at, now) : now,
      lastEventAt: now,
      missingObservations: preserveRetryState ? number(existing.missingObservations) : 0,
      staleObservations: preserveRetryState ? number(existing.staleObservations) : 0
    })
    if (type === 'sell') {
      // A fill chat line identifies an item but not a sibling row. Keep row
      // suppressions intact until the corresponding Manage row reports real
      // progress; the pending-filled record itself is enough to verify the
      // claim meanwhile. Only remove old pre-row-scoped compatibility state.
      this.recentlyClaimedSellCards.delete(semanticKey)
    }
    this.refreshPendingFilledFlag()
  }
  sellClaimCardSuppressed(target, now = Date.now()) {
    const key = this.claimBackoffKey('sell', target)
    const legacyKey = target && typeof target === 'object'
      ? this.orderTimestampKey('sell', target.itemName)
      : key
    const rowScoped = Boolean(target && typeof target === 'object'
      && (target.liveOrderId || target.runtimeOrderId))
    const suppressionKey = this.recentlyClaimedSellCards.has(key)
      ? key
      : !rowScoped && this.recentlyClaimedSellCards.has(legacyKey) ? legacyKey : key
    const until = number(this.recentlyClaimedSellCards.get(suppressionKey), 0)
    if (until <= now) {
      this.recentlyClaimedSellCards.delete(suppressionKey)
      return false
    }
    return true
  }
  suppressClaimedSellCard(target, now = Date.now()) {
    const itemName = target?.itemName || target?.displayName || (typeof target === 'string' ? target : '')
    if (!itemName) return
    const rowScopedTargets = target && typeof target === 'object'
      && (target.liveOrderId || target.runtimeOrderId)
      ? [target]
      : (this.bot.state.orders || []).filter(order => order.type === 'sell'
        && itemKey(order.itemName) === itemKey(itemName)
        && (order.liveOrderId || order.runtimeOrderId)
        && (this.hasSellClaimSignal(order) || this.isStructurallyComplete(order)))
    if (rowScopedTargets.length) {
      for (const row of rowScopedTargets) {
        this.recentlyClaimedSellCards.set(this.claimBackoffKey('sell', row), now + 15 * 60 * 1000)
      }
      return
    }
    // Compatibility for an old/no-row snapshot. Live row identities never
    // consult this semantic fallback, so it cannot suppress their siblings.
    this.recentlyClaimedSellCards.set(this.orderTimestampKey('sell', itemName), now + 15 * 60 * 1000)
  }
  clearPendingFilled(type, target) {
    const pendingMap = this.pendingFilledMap(type)
    if (target && typeof target === 'object' && target.liveOrderId) {
      pendingMap.delete(this.orderRuntimeKey(target))
      this.claimBackoffs.delete(this.claimBackoffKey(type, target))
    } else {
      const wanted = itemKey(target?.itemName || target)
      for (const [key, entry] of [...pendingMap]) {
        if (itemKey(entry?.itemName) === wanted || key === this.orderTimestampKey(type, target)) pendingMap.delete(key)
      }
      this.claimBackoffs.delete(this.claimBackoffKey(type, target))
    }
    this.refreshPendingFilledFlag()
  }
  refreshPendingFilledFlag() {
    const account = this.accountKey()
    this.filledOrderRefreshPending = [...this.pendingFilledBuys.values(), ...this.pendingFilledSells.values()]
      .some(entry => entry.account === account && entry.confirmed !== true && entry.batchDeferred !== true)
    return this.filledOrderRefreshPending
  }
  isManageOrdersScreen(screen) {
    const title = this.bot.cleanText(screen?.title || '')
    if (typeof this.bot.isStableOrdersScreen === 'function') return this.bot.isStableOrdersScreen(screen)
    const orders = this.bot.parseOrders(screen || { slots: [] })
    if (orders.length > 0) return true
    // Compatibility for test doubles and older bridges: a Bazaar-root control
    // under an order-list title is a slot/title transition, not Manage Orders.
    if (/(?:manage orders|bazaar orders)/i.test(title)) {
      const rootControl = this.bot.findSlot(screen, 'sell inventory now') || this.bot.findSlot(screen, 'manage orders')
      if (!rootControl) return true
    }
    return false
  }
  scheduleManageOrdersRecheck(delayMs = 350) {
    if (this.manageOrdersRecheckTimer) return
    this.manageOrdersRecheckTimer = setTimeout(() => {
      this.manageOrdersRecheckTimer = null
      if (!this.running() || this.state.phase !== 'reading-manage') return
      const current = this.bot.windowSnapshot?.()
      if (!current) return
      if (this.isManageOrdersScreen(current)) return this.readManageOrders(current)
      if (this.retryManageOrdersControl(current)) return
      // Some bridge/window combinations publish one complete Manage Orders
      // packet and then remain quiet. Keep a bounded local observation alive
      // so the controller's settled-packet fallback can confirm it; otherwise
      // this phase waits for the global watchdog despite already having the
      // final GUI in hand.
      if (/(?:manage orders|bazaar orders)/i.test(this.bot.cleanText(current?.title || ''))
        && this.state.phase === 'reading-manage') this.scheduleManageOrdersRecheck(delayMs)
    }, delayMs)
    this.manageOrdersRecheckTimer.unref?.()
  }
  retryManageOrdersControl(screen) {
    const manage = this.bot.findSlot(screen || { slots: [] }, 'manage orders')
    if (!manage) return false
    // Repeated inventory packets can arrive faster than the configured human
    // click delay. Replacing the pending click for every identical packet
    // starves the click indefinitely and eventually exhausts the local retry
    // counter even though no click was sent. Let the scheduled click execute;
    // the bounded recheck below will retry only after it has had a chance to.
    if (this.pendingClickTimer) {
      this.scheduleManageOrdersRecheck(1200)
      return true
    }
    if (this.manageOpenRetries >= 3) {
      this.recover('Manage Orders did not open after three local retries.')
      return true
    }
    this.manageOpenRetries += 1
    this.click(manage.slot, `Manage Orders was still visible; retrying locally (${this.manageOpenRetries}/3).`, 'reading-manage')
    this.scheduleManageOrdersRecheck(1200)
    return true
  }
  matchingOrderSlot(screen, type = '') {
    const target = itemKey(this.state.target?.itemName || this.state.target?.displayName)
    if (!target || !/(?:manage orders|bazaar orders)/i.test(this.bot.cleanText(screen?.title || ''))) return null
    const matches = this.bot.parseOrders(screen || { slots: [] }).filter(order =>
      itemKey(order.itemName) === target && (!type || order.type === type))
    if (!matches.length) return null
    const observedSlot = Number(this.state.target?.observedSlot)
    const exactSlot = Number.isInteger(observedSlot) ? matches.find(order => Number(order.slot) === observedSlot) : null
    if (exactSlot) return exactSlot
    const wantedTotal = Math.max(0, number(this.state.target?.orderQuantity))
    const wantedPrice = Math.max(0, number(this.state.target?.unitPriceCoins))
    return [...matches].sort((left, right) => {
      const score = order => (wantedTotal && Math.max(0, number(order.totalCount || order.count)) === wantedTotal ? 2 : 0)
        + (wantedPrice && Math.abs(number(order.unitPriceCoins) - wantedPrice) < 0.00001 ? 2 : 0)
      return score(right) - score(left)
    })[0] || null
  }
  scheduleOrderDetailRecheck(delayMs = 1200) {
    if (this.orderDetailRecheckTimer) return
    const generation = this.actionGeneration
    this.orderDetailRecheckTimer = setTimeout(() => {
      this.orderDetailRecheckTimer = null
      if (!this.running() || generation !== this.actionGeneration) return
      const current = this.bot.windowSnapshot?.()
      if (current) this.retryOrderDetailControl(current)
    }, delayMs)
    this.orderDetailRecheckTimer.unref?.()
  }
  retryOrderDetailControl(screen) {
    const phase = this.state.phase
    const claimType = phase === 'awaiting-claim-buy' ? 'buy' : phase === 'awaiting-claim-sell' ? 'sell' : ''
    if (claimType || phase === 'cancel-options') {
      const order = this.matchingOrderSlot(screen, claimType || this.state.target?.orderType || '')
      if (!order) return false
      if (this.phaseRetryCount >= 3) {
        this.recover(`The ${claimType ? 'claim' : 'cancel'} order card did not open after three local retries.`)
        return true
      }
      this.phaseRetryCount += 1
      this.click(order.slot, `The order card for ${this.state.target?.itemName || 'the order'} was still visible; reopening it locally (${this.phaseRetryCount}/3).`, phase)
      this.scheduleOrderDetailRecheck()
      return true
    }
    if (phase === 'awaiting-cancel') {
      const cancel = this.findCancelControl(screen)
      if (!cancel) return false
      if (this.phaseRetryCount >= 2) {
        this.recover('The order cancellation did not register after two local retries.')
        return true
      }
      this.phaseRetryCount += 1
      this.click(cancel.slot, `Cancellation did not register; retrying locally (${this.phaseRetryCount}/2).`, phase)
      this.scheduleOrderDetailRecheck()
      return true
    }
    return false
  }
  click(slot, message, phase = this.state.phase) {
    const target = this.state.target || {}
    const intent = [phase, Number(slot), itemKey(target.itemName || target.displayName), target.liveOrderId || target.runtimeOrderId || ''].join('|')
    // Window packets frequently repeat faster than the configured human click
    // delay. Replacing the same delayed click on every packet can postpone it
    // forever (most visibly on Claim Items, Cancel Order and confirmation
    // controls). Keep the first identical intent alive; a real workflow or
    // target change still cancels it through setPhase.
    if (this.pendingClickTimer && this.pendingClickIntent === intent && this.state.phase === phase) {
      return this.pendingClickResult
    }
    // A click consumes the cached Manage Orders screen. readManageOrders will
    // restore it only when the workflow safely parks there without acting.
    this.manageRefreshSlot = null
    const awaitingKind = phase.match(/^awaiting-(buy|sell)-confirmation$/)?.[1] || ''
    if (awaitingKind && this.state.phase !== phase) this.confirmationRetries = 0
    this.setPhase(phase, this.state.status)
    const generation = this.actionGeneration
    const delay = this.randomDelay()
    const result = { generation, delay }
    this.lastScreenHandledAt = Date.now()
    this.pendingClickIntent = intent
    this.pendingClickResult = result
    this.pendingClickTimer = setTimeout(() => {
      this.pendingClickTimer = null
      this.pendingClickIntent = ''
      this.pendingClickResult = null
      if (!this.running() || generation !== this.actionGeneration || this.state.phase !== phase) return
      try {
        this.bot.clickSlot(slot)
        this.activity('action', message)
        if (awaitingKind) this.scheduleConfirmationRetry(awaitingKind, slot)
      } catch (error) { this.fail(error) }
    }, delay)
    this.pendingClickTimer.unref?.()
    return result
  }
  clearConfirmationRetry() {
    if (this.confirmationRetryTimer) clearTimeout(this.confirmationRetryTimer)
    this.confirmationRetryTimer = null
    this.confirmationRetrySlot = null
  }
  scheduleConfirmationRetry(kind, slot) {
    this.clearConfirmationRetry()
    this.confirmationRetrySlot = Number(slot)
    this.confirmationRetryTimer = setTimeout(() => this.retryPendingConfirmation(), kind === 'sell' ? 3500 : 4500)
    this.confirmationRetryTimer.unref?.()
  }
  confirmationRetryLimit(kind) { return kind === 'sell' ? 1 : 3 }
  retryPendingConfirmation() {
    const kind = this.state.phase.match(/^awaiting-(buy|sell)-confirmation$/)?.[1] || ''
    const slot = this.confirmationRetrySlot
    this.confirmationRetryTimer = null
    if (!kind || !Number.isFinite(slot) || !this.running() || this.chatSubmissionAcknowledged === kind) return this.clearConfirmationRetry()
    const retryLimit = this.confirmationRetryLimit(kind)
    if (this.confirmationRetries >= retryLimit) {
      const target = this.state.target
      this.clearConfirmationRetry()
      this.activity('warning', `${kind === 'buy' ? 'Buy' : 'Sell'} submission for ${target?.itemName || 'the item'} produced no GUI or chat response after ${retryLimit + 1} clicks; reopening the ${kind} workflow now.`)
      return kind === 'buy' ? this.beginBuy(target, true) : this.beginSell(target, true)
    }
    this.confirmationRetries += 1
    try {
      this.bot.clickSlot(slot)
      this.activity('action', `${kind === 'buy' ? 'Buy' : 'Sell'} submission produced no response; retrying the same confirmation locally (${this.confirmationRetries}/${retryLimit}).`)
      this.scheduleConfirmationRetry(kind, slot)
    } catch (error) { this.fail(error) }
  }
  running() {
    return Boolean(
      this.options().enabled
      && this.bot.state.status === 'connected'
      && this.tradeLocationReady(this.bot.state)
    )
  }
  tradeLocationReady(snapshot = this.bot.state) {
    if (typeof this.bot.canTradeHere === 'function') return this.bot.canTradeHere(snapshot?.location)
    return snapshot?.location?.onIsland === true
  }
  tradingLocationLabel() { return this.bot.hubModeActive === true ? 'Hub' : 'Your Island' }
  startTimer() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref?.()
  }
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null }
  setMarket(market) {
    this.market = market || { candidates: [] }
    this.marketReceivedAt = Date.now()
    this.refreshEnabled()
    if (this.running() && this.state.phase === 'idle') this.nextSyncAt = Math.min(this.nextSyncAt || Infinity, Date.now() + 1000)
  }
  marketSnapshotFresh(now = Date.now()) {
    const explicit = Date.parse(this.market?.updatedAt || '')
    const observedAt = Number.isFinite(explicit) ? explicit : this.marketReceivedAt
    const refreshMs = Math.max(10, number(this.readSettings().config.scanner?.refreshSeconds, 15)) * 1000
    const apiUpdatedAt = Date.parse(this.market?.apiUpdatedAt || '')
    const localFresh = observedAt > 0 && observedAt <= now + 5000 && now - observedAt <= Math.max(60000, refreshMs * 4)
    const apiFresh = !Number.isFinite(apiUpdatedAt)
      || (apiUpdatedAt <= now + 5000 && now - apiUpdatedAt <= Math.max(90000, refreshMs * 6))
    return localFresh && apiFresh
  }
  refreshEnabled() {
    const enabled = Boolean(this.options().enabled)
    if (this.state.enabled !== enabled) this.update({ enabled, status: enabled ? 'WAITING' : 'DISABLED' })
    if (enabled) this.startTimer(); else this.stopTimer()
  }
  onBotState(snapshot) {
    const previousBotStatus = this.lastBotStatus
    const accountChanged = this.cookieStateAccountKey !== this.accountKey(snapshot)
    if (accountChanged) {
      this.stashBlocked = false
      this.stashItemCount = 0
      this.stashCountConfirmed = false
      this.stashRefundPendingUntil = 0
      this.pendingSells.clear()
      this.sellConsolidation = null
      this.sellConsolidationCooldowns.clear()
      this.lastSellConsolidationCapacityWarningAt = 0
      this.sellOfferReservations.clear()
      this.missingInventorySuppressions.clear()
      this.pendingBuyRelists.clear()
      this.pendingPartialBuyCancels.clear()
      this.pendingCancel = null
      this.claimBackoffs.clear()
      this.recentlyClaimedSellCards.clear()
      this.claimAllSellBatch = null
      this.failedBuyTargets.clear()
      this.buyClaimAttempts.clear()
      this.partialBuyBatches.clear()
      this.buyReservations.clear()
      this.recentOrderSightings.clear()
      this.waitingForPurse = false
      this.liveOrderRegistry.clear()
      this.activeLiveOrderIds.clear()
      this.pendingOrderPlacements = []
      this.manageFailureStreak = 0
      this.hubNpcFallbackPending = false
      this.manageReconnectPending = false
      this.manageOpenMethod = ''
      this.watchdogWorkPending = false
      this.actionableIdleSinceAt = 0
      if (this.state.phase !== 'idle') this.setPhase('idle', 'ACCOUNT CHANGED', null)
    }
    this.lastBotStatus = snapshot.status || ''
    if (snapshot.status === 'connected' && previousBotStatus !== 'connected') {
      // A reconnect is a completed inactivity-recovery attempt, not a Bazaar
      // action. Re-arm the watchdog from this fresh session so another stuck
      // session can be restarted ten minutes later instead of remaining
      // permanently blocked behind inactivityRestartPending.
      this.inactivityRestartPending = false
      this.lastConfirmedBazaarActionAt = Date.now()
      this.lastProductiveBazaarActionAt = Date.now()
      this.watchdogWorkPending = false
      this.actionableIdleSinceAt = 0
      this.manageFailureStreak = 0
      this.hubNpcFallbackPending = false
      this.manageReconnectPending = false
      this.inventoryCapacitySnapshot = null
    }
    if (snapshot.status === 'connected' && !this.connectedSinceAt) this.beginUptime(snapshot)
    else if (snapshot.status !== 'connected' && this.connectedSinceAt) this.flushUptime(false)
    this.refreshEnabled()
    if (snapshot.status === 'connected' && this.state.enabled) {
      if (!this.tradeLocationReady(snapshot)) {
        const hubMode = this.bot.hubModeActive === true
        const destination = hubMode ? 'Hub' : 'Your Island'
        if (this.lastIslandReady !== false) {
          this.activity('warning', `${destination} is not confirmed. Bazaar automation is paused while FF returns to the requested trading location.`, null)
        }
        this.lastIslandReady = false
        if (!hubMode) this.bot.ensureIslandRecovery?.('Your Island is not confirmed.')
        if (/sell/.test(this.state.phase) && this.state.target) {
          const key = itemKey(this.state.target.itemName || this.state.target.displayName)
          const existing = this.pendingSells.get(key)
          if (existing) this.pendingSells.set(key, { ...existing, inFlight: false, retryAfter: 0 })
          else this.queueSell(this.state.target)
        }
        this.clearConfirmationRetry()
        const waitingStatus = hubMode ? 'WAITING FOR HUB' : 'RETURNING TO YOUR ISLAND'
        if (this.state.phase !== 'idle') this.setPhase('idle', waitingStatus, null)
        else this.update({ status: waitingStatus })
        this.update({ tracker: this.trackerSnapshot() })
        return
      }
      if (this.lastIslandReady === false) {
        this.activity('success', `${this.tradingLocationLabel()} confirmed; Bazaar automation may resume.`, null)
        this.nextSyncAt = Date.now() + 3000
      }
      if (this.lastIslandReady !== true || previousBotStatus !== 'connected' || accountChanged) {
        this.scheduleActivationCookieProbe(snapshot)
      }
      this.lastIslandReady = true
      const account = this.accountKey(snapshot)
      if (!this.profitRepairAccounts.has(account)) {
        this.profitRepairAccounts.add(account)
        this.repairMissedProfitFromChat()
      }
      const startupClearQueued = this.queueStartupClear(snapshot)
      if (!startupClearQueued) {
        // Schedule the initial sync only on the actual connection transition.
        // Reapplying this delay on every connected-state update starves a due
        // filled-order refresh when screen/order packets arrive frequently.
        if (previousBotStatus !== 'connected' && this.state.phase === 'idle') this.nextSyncAt = Date.now() + 3000
        this.update({ status: this.market.candidates?.length ? 'RUNNING' : 'WAITING FOR MARKET' })
      }
    } else if (snapshot.status === 'disconnected') {
      // abortOrderAction() belongs to the controller and may not emit a
      // completion event when the bridge disappears mid-recovery. Never keep
      // the automation-side guard latched across a reconnect.
      this.inventoryClaimRecoveryPending = false
      this.inventoryCapacitySnapshot = null
      this.claimAllSellBatch = null
      this.manualControlUntil = 0
      this.lastIslandReady = null
      this.nextRestAt = 0
      this.restUntil = 0
      this.nextCookieProbeAt = 0
      this.activationCookieProbePending = false
      if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
      this.cookieProbeTimer = null
      if (this.startupClearTimer) clearTimeout(this.startupClearTimer)
      this.startupClearTimer = null
      if (this.startupClearAccount && !this.startupClearedAccounts.has(this.startupClearAccount)) {
        this.startupClearAccount = ''
        this.startupClearWaitingForIsland = false
        this.startupClearStarted = false
        this.manualControlUntil = 0
      }
      this.setPhase('idle', this.state.enabled ? 'WAITING FOR CONNECTION' : 'DISABLED', null)
    }
    this.update({ tracker: this.trackerSnapshot() })
  }
  accountKey(snapshot = this.bot.state) {
    return String(snapshot.activeAccountId || snapshot.username || this.bot.state.activeAccountId || this.bot.state.username || 'default')
  }
  switchCookieAccount(snapshot = this.bot.state) {
    const nextKey = this.accountKey(snapshot)
    if (nextKey === this.cookieStateAccountKey) return nextKey
    if (this.cookieStateAccountKey) {
      this.cookieAccountStates.set(this.cookieStateAccountKey, {
        attempts: this.cookiePurchaseAttempts,
        cooldownUntil: this.cookiePurchaseCooldownUntil
      })
    }
    const saved = this.cookieAccountStates.get(nextKey)
    this.cookieStateAccountKey = nextKey
    this.cookiePurchaseAttempts = Math.max(0, number(saved?.attempts))
    this.cookiePurchaseCooldownUntil = Math.max(0, number(saved?.cooldownUntil))
    return nextKey
  }
  scheduleActivationCookieProbe(snapshot = this.bot.state, delayMs = 1000) {
    const account = this.switchCookieAccount(snapshot)
    this.activationCookieProbePending = true
    this.nextCookieProbeAt = Date.now() + Math.max(0, number(delayMs, 1000))
    this.activity('info', `Booster Cookie check queued for ${snapshot.username || account} after account activation.`, null)
  }
  queueStartupClear(snapshot) {
    // Auto Trader preserves queue position and profitable sell offers after
    // restart. Destructive clearing remains available as a manual action.
    if (this.readSettings().config.clearOnStart !== true || this.options().enabled) return false
    const account = this.accountKey(snapshot)
    if (this.startupClearedAccounts.has(account)) return false
    if (this.startupClearAccount !== account) {
      if (this.startupClearTimer) clearTimeout(this.startupClearTimer)
      this.startupClearAccount = account
      this.startupClearWaitingForIsland = !this.tradeLocationReady(snapshot)
      this.startupClearStarted = false
      this.prepareManualOrderAction(120000, true)
      this.update({ status: 'CLEARING ON START' })
      this.activity('info', 'clearOnStart is enabled; waiting for SkyBlock before clearing orders and inventory.', null)
      // The bridge may still have its one-time /bz command queued after
      // /skyblock.  Give that command time to finish so it cannot interrupt
      // the clearing GUI halfway through an order cancellation.
      this.scheduleStartupClear(this.tradeLocationReady(snapshot) ? 6000 : 20000)
      return true
    }
    if (this.tradeLocationReady(snapshot) && this.startupClearWaitingForIsland && !this.startupClearStarted) {
      this.startupClearWaitingForIsland = false
      this.scheduleStartupClear(6000)
    }
    return true
  }
  scheduleStartupClear(delayMs) {
    if (this.startupClearTimer) clearTimeout(this.startupClearTimer)
    this.startupClearTimer = setTimeout(() => {
      this.startupClearTimer = null
      this.runStartupClear()
    }, Math.max(0, number(delayMs)))
    this.startupClearTimer.unref?.()
  }
  runStartupClear() {
    const account = this.startupClearAccount
    if (!account || this.startupClearStarted || this.bot.state.status !== 'connected') return
    if (this.readSettings().config.clearOnStart !== true) {
      this.startupClearAccount = ''
      this.manualControlUntil = 0
      this.finishCycle()
      return
    }
    this.startupClearStarted = true
    this.activity('warning', 'clearOnStart is clearing existing Bazaar orders and inventory before new buys begin.', null)
    try {
      Promise.resolve(this.bot.clearOrdersAndInventory()).catch(error => this.failStartupClear(error))
    } catch (error) { this.failStartupClear(error) }
  }
  failStartupClear(error) {
    this.activity('error', `clearOnStart could not begin: ${error.message || error}. It will retry after reconnect.`, null)
    this.startupClearAccount = ''
    this.startupClearWaitingForIsland = false
    this.startupClearStarted = false
    this.manualControlUntil = 0
    this.finishCycle()
  }
  tick() {
    this.refreshEnabled()
    if (this.ensureTrackerPeriod()) this.update({ tracker: this.trackerSnapshot() })
    if (!this.running()) return
    const now = Date.now()
    const cookieRemaining = this.currentCookieRemainingSeconds(now)
    if (cookieRemaining !== null && cookieRemaining <= 0) {
      const lastCheck = Date.parse(this.bot.state.cookieUpdatedAt || '')
      if (Number.isFinite(lastCheck) && now - lastCheck >= 60000) this.nextCookieProbeAt = Math.min(this.nextCookieProbeAt || Infinity, now)
    }
    if (now - this.lastUptimeSaveAt >= 30000) this.flushUptime(true)
    if (now - this.lastDiagnosticAt >= 30000) { this.lastDiagnosticAt = now; this.diagnostic('heartbeat') }
    if (this.handleDynamicRest(now)) return
    if (now < this.manualControlUntil) return
    if (this.restartInactiveInstance(now)) return
    // A newly started, restarted, or rotated account must refresh its own
    // Cookie duration before ordinary order synchronization can take over.
    if (this.state.phase === 'idle' && this.activationCookieProbePending && now >= this.nextCookieProbeAt) return this.probeBoosterCookie()
    if (this.state.phase === 'idle' && now >= this.nextSyncAt) return this.syncOrders()
    if (this.state.phase === 'idle' && now >= this.nextCookieProbeAt) return this.probeBoosterCookie()
    const configuredTimeout = Math.max(8, number(this.options().actionTimeoutSeconds, 15))
    // Order confirmations can arrive a few seconds after the GUI has already
    // closed.  Do not restart a successful sell workflow while its chat
    // acknowledgement is still in flight.
    const timeout = Math.max(/awaiting-(?:buy|sell)-confirmation/.test(this.state.phase) ? 30 : 0, configuredTimeout) * 1000
    if (this.state.phase !== 'idle' && now - this.phaseStartedAt > timeout) this.recover('Bazaar window did not advance in time.')
  }
  randomRangeMinutes(range, fallback) {
    const min = Math.max(0, number(range?.min, fallback))
    const max = Math.max(min, number(range?.max, min))
    return min + Math.random() * (max - min)
  }
  handleDynamicRest(now = Date.now()) {
    const settings = this.readSettings().config.dynamicRest
    if (!settings?.enabled) {
      this.nextRestAt = 0
      this.restUntil = 0
      return false
    }
    if (this.restUntil > now) {
      if (this.state.phase === 'idle' && this.state.status !== 'RESTING') this.update({ status: 'RESTING' })
      return true
    }
    if (this.restUntil) {
      this.restUntil = 0
      this.nextRestAt = now + this.randomRangeMinutes(settings.workMinutes, 120) * 60000
      this.activity('success', 'Dynamic rest finished; automatic trading resumed.', null)
    }
    if (!this.nextRestAt) this.nextRestAt = now + this.randomRangeMinutes(settings.workMinutes, 120) * 60000
    if (now < this.nextRestAt || this.state.phase !== 'idle') return false
    const breakMinutes = this.randomRangeMinutes(settings.breakMinutes, 15)
    this.restUntil = now + breakMinutes * 60000
    this.nextRestAt = 0
    this.update({ status: 'RESTING' })
    this.activity('info', `Dynamic rest started for ${Math.round(breakMinutes)} minutes.`, null)
    return true
  }
  requestHubSync(options = {}) {
    if (!this.running() || this.state.phase !== 'idle') return false
    if (Date.now() < this.manualControlUntil || this.bot.pendingOrderAction) return false
    this.syncOrders(options)
    return true
  }
  setHubBazaarOpener(opener) {
    this.hubBazaarOpener = typeof opener === 'function' ? opener : null
    return Boolean(this.hubBazaarOpener)
  }
  syncOrders(options = {}) {
    // Existing orders must always be synchronized and claimed, even when the
    // market scanner currently has no safe candidates.
    const explicitOpener = typeof options.openBazaar === 'function' ? options.openBazaar : null
    // /bz is always the primary Hub opener. A verified NPC interaction is a
    // one-shot recovery path only after this exact instance timed out. A
    // successful recovery clears manageFailureStreak, so the next cycle goes
    // straight back to /bz instead of sticking to the NPC.
    const recoveryOpener = !explicitOpener
      && this.bot.hubModeActive === true
      && this.hubNpcFallbackPending
      && typeof this.hubBazaarOpener === 'function'
      ? this.hubBazaarOpener
      : null
    const customOpener = explicitOpener || recoveryOpener
    if (recoveryOpener) this.hubNpcFallbackPending = false
    const sourceReason = String(options.reason || '').trim()
    const forceFreshManage = this.filledOrderRefreshPending
    this.manageOpenRetries = 0
    this.diagnostic('sync-orders-start')
    this.setPhase('opening-manage', 'SYNCING ORDERS', null)
    const goBackSlot = this.manageRefreshSlot
    this.manageRefreshSlot = null
    // Hub Roaming closes the completed Bazaar container before movement
    // resumes. A remembered Go Back slot then refers to a dead container and
    // caused hundreds of Manage Orders timeouts. Reuse is safe only for the
    // stationary island workflow where the window is intentionally retained.
    if (!forceFreshManage && this.bot.hubModeActive !== true && Number.isInteger(goBackSlot) && goBackSlot >= 0) {
      this.manageOpenMethod = 'refresh'
      this.activity('action', 'Refreshing Manage Orders through the open Bazaar window.', null)
      return this.click(goBackSlot, 'Returned to Bazaar; reopening Manage Orders.', 'opening-manage')
    }
    this.manageOpenMethod = explicitOpener || recoveryOpener ? 'npc' : 'remote'
    const recoveryReason = recoveryOpener ? 'physical Bazaar NPC fallback after remote /bz timeout' : ''
    this.activity('action', sourceReason || recoveryReason
      ? `Opening Bazaar to synchronize Manage Orders (${sourceReason || recoveryReason}).`
      : 'Opening Bazaar to synchronize Manage Orders.', null)
    const openManageRoot = async () => {
      try {
        const opened = await (customOpener ? customOpener() : this.bot.openBazaar())
        if (customOpener && opened === false && this.state.phase === 'opening-manage') {
          this.activity('warning', 'The nearby Bazaar NPC could not be verified; using /bz for this synchronization.', null)
          await this.bot.openBazaar()
        }
      } catch (error) {
        if (customOpener && this.state.phase === 'opening-manage') {
          this.activity('warning', `The nearby Bazaar NPC interaction failed (${error.message || error}); using /bz instead.`, null)
          try { await this.bot.openBazaar() } catch (fallbackError) { this.fail(fallbackError) }
        } else this.fail(error)
      }
    }
    openManageRoot()
  }
  probeBoosterCookie() {
    this.activationCookieProbePending = false
    this.nextCookieProbeAt = Date.now() + 30 * 60 * 1000
    this.setPhase('cookie-probe', 'CHECKING BOOSTER COOKIE', null)
    this.activity('info', 'Opening SkyBlock Menu briefly to refresh Booster Cookie duration.', null)
    try { this.bot.sendChat('/sbmenu') } catch (error) { return this.finishCookieProbe(error.message) }
    if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
    this.cookieProbeTimer = setTimeout(() => this.finishCookieProbe('SkyBlock Menu did not respond.'), 6000)
    this.cookieProbeTimer.unref?.()
  }
  preparePurchasedCookie() {
    this.cookieConsumptionAttempts += 1
    if (this.cookieConsumptionAttempts > 3) {
      this.cookieVerificationPending = false
      return this.failCookiePurchase('The purchased Cookie could not be moved to the hotbar and consumed after three attempts.')
    }
    this.setPhase('cookie-preparing', 'CONSUMING BOOSTER COOKIE', { itemName: 'Booster Cookie', quantity: 1 })
    this.activity('action', 'Booster Cookie purchased. Closing the current GUI and moving the Cookie to the hotbar before using it.', this.state.target)
    try { this.bot.prepareHotbarItem('Booster Cookie') } catch (error) { this.failCookiePurchase(error.message) }
  }
  onHotbarItemReady(item) {
    if (this.state.phase !== 'cookie-preparing' || !/booster cookie/i.test(String(item?.name || ''))) return
    this.setPhase('cookie-use', 'CONSUMING BOOSTER COOKIE', this.state.target)
    this.activity('success', `Booster Cookie is selected in hotbar slot ${Number(item.slot) + 1}; using it from the main hand.`, this.state.target)
    setTimeout(() => {
      if (this.state.phase !== 'cookie-use') return
      try { this.bot.useHeldItem() } catch (error) { this.failCookiePurchase(error.message) }
    }, 450)
  }
  onHotbarItemError(error) {
    if (this.state.phase !== 'cookie-preparing') return
    this.activity('warning', `Could not prepare the Booster Cookie: ${error?.message || 'item not found'}. Retrying.`, this.state.target)
    setTimeout(() => this.preparePurchasedCookie(), 1000)
  }
  scheduleCookieVerification() {
    if (this.cookieConsumeTimer) clearTimeout(this.cookieConsumeTimer)
    this.cookieVerificationPending = true
    this.setPhase('cookie-consumed-awaiting-check', 'VERIFYING BOOSTER COOKIE', null)
    this.cookieConsumeTimer = setTimeout(() => {
      this.cookieConsumeTimer = null
      if (!this.running()) return
      this.probeBoosterCookie()
    }, 2500)
    this.cookieConsumeTimer.unref?.()
  }
  finishCookieProbe(warning = '') {
    if (this.state.phase !== 'cookie-probe') return
    if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
    this.cookieProbeTimer = null
    if (warning) {
      this.nextCookieProbeAt = Date.now() + 60 * 1000
      this.activity('warning', `Booster Cookie check skipped: ${warning} FF will check again in one minute.`, null)
    }
    this.finishCycle()
  }
  currentCookieRemainingSeconds(now = Date.now()) {
    const remaining = Number(this.bot.state.cookieRemainingSeconds)
    const updatedAt = Date.parse(this.bot.state.cookieUpdatedAt || '')
    if (!Number.isFinite(remaining) || !Number.isFinite(updatedAt)) return null
    return Math.max(0, remaining - (now - updatedAt) / 1000)
  }
  cookiePurchaseThresholdSeconds() {
    return Math.max(0, number(this.readSettings().config.cookie?.purchaseThresholdHours, 0)) * 3600
  }
  shouldPurchaseBoosterCookie(remainingSeconds, now = Date.now()) {
    const threshold = this.cookiePurchaseThresholdSeconds()
    return threshold > 0 && Number.isFinite(Number(remainingSeconds)) &&
      Number(remainingSeconds) <= threshold && now >= this.cookiePurchaseCooldownUntil
  }
  beginCookiePurchase(recovery = false) {
    if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
    this.cookieProbeTimer = null
    this.cookiePurchaseAttempts = recovery ? this.cookiePurchaseAttempts + 1 : 0
    if (this.cookiePurchaseAttempts >= 3) {
      this.cookiePurchaseCooldownUntil = Date.now() + 15 * 60 * 1000
      this.nextCookieProbeAt = this.cookiePurchaseCooldownUntil
      this.activity('warning', 'Booster Cookie purchase could not complete after three attempts. FF will retry in 15 minutes.', null)
      return this.finishCycle()
    }
    const target = { itemName: 'Booster Cookie', displayName: 'Booster Cookie', quantity: 1 }
    this.setPhase('cookie-opening', 'BUYING BOOSTER COOKIE', target)
    this.activity('action', `Booster Cookie is at or below the configured ${this.readSettings().config.cookie.purchaseThresholdHours}-hour threshold; opening its Bazaar page.`, target)
    Promise.resolve(this.bot.openItemByName('Booster Cookie')).catch(error => this.failCookiePurchase(error.message))
  }
  failCookiePurchase(reason) {
    this.cookieVerificationPending = false
    this.cookiePurchaseCooldownUntil = Date.now() + 15 * 60 * 1000
    this.nextCookieProbeAt = this.cookiePurchaseCooldownUntil
    this.activity('warning', `Booster Cookie was not purchased: ${reason} FF will retry in 15 minutes.`, null)
    this.finishCycle()
  }
  advanceCookiePurchase(screen) {
    const phase = this.state.phase
    const title = this.bot.cleanText(screen.title || '').toLowerCase()
    const exactCookie = (screen.slots || []).find(slot => {
      const name = this.slotName(slot).toLowerCase()
      const lore = this.slotText(slot).toLowerCase()
      return name === 'booster cookie' && (/click to view|view details/.test(lore) || title.includes('booster cookie'))
    })
    const buyInstantly = this.findNamed(screen, [/buy instantly/], [/create buy order/, /cancel/, /sell/])
    if (phase === 'cookie-use') {
      const consume = this.findNamed(screen,
        [/^consume cookie$/, /consume booster cookie/, /adds\s+4\s+days/, /click to (?:consume|confirm)/],
        [/cancel/, /go back/])
      if (consume || /consume booster cookie/i.test(title)) {
        if (!consume) return
        this.click(consume.slot, 'Confirming Booster Cookie consumption.', 'cookie-consume-confirm')
        return setTimeout(() => {
          if (this.state.phase === 'cookie-consume-confirm') this.scheduleCookieVerification()
        }, 1200)
      }
      return
    }
    if (phase === 'cookie-opening') {
      if (buyInstantly) return this.click(buyInstantly.slot, 'Selected Buy Instantly for Booster Cookie.', 'cookie-amount')
      if (exactCookie) return this.click(exactCookie.slot, 'Opened the exact Booster Cookie Bazaar result.', 'cookie-product')
    }
    if (phase === 'cookie-product') {
      if (buyInstantly) return this.click(buyInstantly.slot, 'Selected Buy Instantly for Booster Cookie.', 'cookie-amount')
      if (exactCookie) return this.click(exactCookie.slot, 'Booster Cookie product page was delayed; retrying the visible result.', 'cookie-product')
    }
    if (phase === 'cookie-amount') {
      const one = this.findPreferredNamed(screen,
        [/buy only one/, /amount\s*:\s*1x/, /\b1x\b[\s\S]*click to proceed/],
        [/cancel/, /custom/, /sell/])
      const directConfirm = this.findNamed(screen,
        [/confirm instant buy/, /buy instantly[\s\S]*(?:confirm|proceed)/, /click to (?:confirm|purchase)/],
        [/cancel/, /create buy order/, /sell/])
      if (one) return this.click(one.slot, 'Selected one Booster Cookie.', 'cookie-confirm')
      if (directConfirm) return this.click(directConfirm.slot, 'Confirming the Booster Cookie instant purchase.', 'cookie-awaiting')
    }
    if (phase === 'cookie-confirm') {
      const confirm = this.findNamed(screen,
        [/confirm instant buy/, /buy instantly[\s\S]*(?:confirm|purchase|proceed)/, /click to (?:confirm|purchase)/],
        [/cancel/, /create buy order/, /sell/])
      if (confirm) return this.click(confirm.slot, 'Confirming the Booster Cookie instant purchase.', 'cookie-awaiting')
      if (buyInstantly) return this.click(buyInstantly.slot, 'Booster Cookie confirmation was delayed; continuing the instant purchase.', 'cookie-confirm')
    }
  }
  onWindow(screen) {
    if (!this.running()) return
    // The same inventory packet can require a different action after a phase
    // transition (for example open order -> claim/cancel). Include the phase in
    // deduplication so a valid follow-up is never suppressed for 3.5 seconds.
    const signature = `${this.state.phase}|${this.signature(screen)}`
    if (signature === this.lastScreenSignature && Date.now() - this.lastScreenHandledAt < 3500) return
    if (signature !== this.lastScreenSignature) this.diagnosticWindow(screen)
    this.lastScreenSignature = signature
    const phase = this.state.phase
    if (phase === 'cookie-probe') {
      const cookie = this.bot.parseBoosterCookie(screen)
      if (cookie || /skyblock menu/i.test(this.bot.cleanText(screen.title || ''))) {
        if (cookie) {
          this.activity('success', `Booster Cookie remaining: ${cookie.durationText}.`, null)
          if (this.cookieVerificationPending) {
            const threshold = this.cookiePurchaseThresholdSeconds()
            const before = Number(this.cookieBeforePurchaseSeconds)
            const increased = cookie.remainingSeconds > Math.max(threshold, Number.isFinite(before) ? before + 86400 : 0)
            if (increased) {
              this.cookieVerificationPending = false
              this.cookieConsumptionAttempts = 0
              this.cookiePurchaseAttempts = 0
              this.cookiePurchaseCooldownUntil = 0
              this.nextCookieProbeAt = Date.now() + 30 * 60 * 1000
              this.activity('success', `Booster Cookie consumed and verified. Active duration is now ${cookie.durationText}; automatic flipping resumed.`, null)
              return this.finishCookieProbe()
            }
            this.activity('warning', `Booster Cookie duration did not increase after consumption (${cookie.durationText}); retrying the held-item workflow.`, null)
            if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
            this.cookieProbeTimer = null
            return this.preparePurchasedCookie()
          }
          if (this.shouldPurchaseBoosterCookie(cookie.remainingSeconds)) return this.beginCookiePurchase()
          const untilThreshold = Math.max(0, cookie.remainingSeconds - this.cookiePurchaseThresholdSeconds())
          this.nextCookieProbeAt = Date.now() + Math.max(60 * 1000, Math.min(30 * 60 * 1000, untilThreshold * 1000))
        }
        else {
          this.activity('warning', 'SkyBlock Menu opened, but no Booster Cookie duration was present.', null)
          if (this.cookieVerificationPending) {
            if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
            this.cookieProbeTimer = null
            this.nextCookieProbeAt = Date.now() + 2000
            this.setPhase('idle', 'VERIFYING BOOSTER COOKIE', null)
            return
          }
        }
        return this.finishCookieProbe()
      }
      return
    }
    if (/^cookie-(?:opening|product|amount|confirm|awaiting|use|consume-confirm)$/.test(phase)) return this.advanceCookiePurchase(screen)
    const awaitingConfirmation = phase.match(/^awaiting-(buy|sell)-confirmation$/)?.[1]
    if (awaitingConfirmation) {
      // Once Hypixel announces that it is submitting/escrowing the order, the
      // chat stream is more authoritative than a stale confirmation inventory.
      // Wait for the final Setup message instead of clicking Submit again.
      if (this.chatSubmissionAcknowledged === awaitingConfirmation) return
      if (awaitingConfirmation === 'sell') {
        const title = this.bot.cleanText(screen.title || '').toLowerCase()
        const targetName = String(this.state.target?.itemName || this.state.target?.displayName || '').toLowerCase()
        const titleHasTarget = targetName && title.replaceAll('"', '').includes(targetName)
        const exactItem = titleHasTarget && (screen.slots || []).some(slot => this.slotName(slot).toLowerCase() === targetName)
        // The live diagnostics show that a missed Submit click usually sends
        // Hypixel back to the exact /bz result or product overview within one
        // inventory packet. That page is authoritative evidence that the
        // submission did not register. Re-enter through its visible control
        // immediately instead of clicking the now-stale confirmation slot.
        if (exactItem) {
          this.clearConfirmationRetry()
          this.confirmationRetries = 0
          this.chatSubmissionAcknowledged = ''
          this.setPhase('sell-confirm', this.state.status)
          return this.advanceSetup('sell', screen)
        }
      }
      const confirm = this.findConfirmationControl(screen, awaitingConfirmation)
      if (confirm) {
        const retryLimit = this.confirmationRetryLimit(awaitingConfirmation)
        if (this.confirmationRetries >= retryLimit) {
          this.activity('warning', `${awaitingConfirmation === 'buy' ? 'Buy' : 'Sell'} submission for ${this.state.target?.itemName || 'the item'} did not register after ${retryLimit + 1} clicks; reopening the ${awaitingConfirmation} workflow now.`)
          return awaitingConfirmation === 'buy' ? this.beginBuy(this.state.target, true) : this.beginSell(this.state.target, true)
        }
        this.confirmationRetries += 1
        return this.click(confirm.slot, `${awaitingConfirmation === 'buy' ? 'Buy' : 'Sell'} submission did not register; retrying confirmation for ${this.state.target?.itemName || 'the item'} (${this.confirmationRetries}/${retryLimit}).`, `awaiting-${awaitingConfirmation}-confirmation`)
      }
    }
    if (phase === 'opening-manage') {
      const manage = this.bot.findSlot(screen, 'manage orders')
      if (manage) {
        const scheduled = this.click(manage.slot, 'Opened Manage Orders.', 'reading-manage')
        this.scheduleManageOrdersRecheck(1200)
        return scheduled
      }
    }
    if (phase === 'reading-manage') {
      if (this.isManageOrdersScreen(screen)) return this.readManageOrders(screen)
      if (this.retryManageOrdersControl(screen)) return
      if (/(?:manage orders|bazaar orders)/i.test(this.bot.cleanText(screen?.title || ''))) {
        this.scheduleManageOrdersRecheck()
        return
      }
    }
    if (/^awaiting-claim-(?:buy|sell)$/.test(phase)) {
      const buyClaim = phase === 'awaiting-claim-buy'
      const claim = this.findNamed(screen,
        buyClaim ? [/claim items/, /claim order/, /click to claim/] : [/claim coins/, /claim order/, /click to claim/],
        [/cancel order/, /cancel offer/, /go back/])
      if (claim) return this.click(claim.slot, `Confirming ${buyClaim ? 'item' : 'coin'} claim for ${this.state.target?.itemName || 'the order'}.`, phase)
      if (this.retryOrderDetailControl(screen)) return
    }
    if (phase === 'sell-bazaar-return') {
      const target = this.state.target
      const visible = this.visibleBazaarItem(screen, target?.itemName)
      if (visible) return this.click(visible.slot, `Opened visible ${target.itemName} without another Bazaar search.`, 'sell-product')
      // Go Back can return to a category that does not contain the claimed
      // product. Fall back immediately instead of waiting for a timeout.
      if (/bazaar/i.test(this.bot.cleanText(screen.title || '')) || this.bot.findSlot(screen, 'manage orders')) return this.openSellByCommand(target)
    }
    if (/^(?:opening-buy|buy-(?:product|amount|price|confirm))$/.test(phase)) return this.advanceSetup('buy', screen)
    if (/^(?:opening-sell|sell-(?:product|price|confirm))$/.test(phase)) return this.advanceSetup('sell', screen)
    if (phase === 'cancel-options') {
      const cancel = this.findCancelControl(screen)
      if (cancel) {
        if (this.state.target?.orderType === 'sell') {
          const consolidation = this.matchingSellConsolidation(this.state.target)
          const capacity = this.sellRefundCapacity([this.state.target], Date.now(), consolidation)
          if (!capacity.safe) {
            if (Date.now() - this.lastSellConsolidationCapacityWarningAt >= 60000) {
              this.lastSellConsolidationCapacityWarningAt = Date.now()
              this.activity('warning', `Sell Offer cancellation for ${this.state.target.itemName} was stopped before the destructive click: ${capacity.reason}. FF will not send the refund to stash.`, this.state.target)
            }
            this.setPhase('idle', 'WAITING FOR SAFE SELL REFUND SPACE', null)
            this.nextSyncAt = Date.now() + 5000
            return
          }
        }
        this.pendingCancel = { account: this.accountKey(), target: this.state.target ? { ...this.state.target } : null, at: Date.now() }
        return this.click(cancel.slot, `Cancelling outbid ${this.state.target?.itemName || 'order'}.`, 'awaiting-cancel')
      }
      if (this.retryOrderDetailControl(screen)) return
    }
    if (phase === 'awaiting-cancel' && this.retryOrderDetailControl(screen)) return
  }
  readManageOrders(screen) {
    this.manageOpenRetries = 0
    this.phaseRetryCount = 0
    if (this.manageOrdersRecheckTimer) clearTimeout(this.manageOrdersRecheckTimer)
    this.manageOrdersRecheckTimer = null
    if (this.orderDetailRecheckTimer) clearTimeout(this.orderDetailRecheckTimer)
    this.orderDetailRecheckTimer = null
    this.sampleInventoryCapacity(screen)
    const rawOrders = this.bot.parseOrders(screen)
    const goBack = this.bot.findSlot(screen, 'go back')
    this.manageRefreshSlot = Number.isInteger(goBack?.slot) ? goBack.slot : null
    const config = this.readSettings().config
    const observedAt = Date.now()
    const parsedOrders = this.reconcileLiveOrders(rawOrders, observedAt)
    // Orders restored from Hypixel after a restart have no local placement
    // timestamp. Start their relist cooldown when first observed instead of
    // treating timestamp zero as an ancient order that may be cancelled now.
    const observedSellTotals = new Map()
    for (const order of parsedOrders) {
      const key = this.orderRuntimeKey(order)
      if (!this.orderPlacedAt.has(key)) this.orderPlacedAt.set(key, Number(order.placedAt) || observedAt)
      const filled = Math.max(0, number(order.filledCount), number(order.claimableItems))
      const previousProgress = this.orderStateValue(this.orderFillProgress, order)
      if (!previousProgress) this.orderFillProgress.set(key, { count: filled, at: filled > 0 ? observedAt : this.orderPlacedAt.get(key) })
      else if (filled > number(previousProgress.count)) {
        this.orderFillProgress.set(key, { count: filled, at: observedAt })
        if (order.type === 'sell') this.recentlyClaimedSellCards.delete(key)
        this.noteProductiveBazaarAction(observedAt)
      }
      // Any unsold exposure reserves the item. Rebuying an item while one of
      // its Sell Offers is still active is what produced dozens of fragmented
      // same-item rows and eventually displaced every Buy Order.
      if (order.type === 'buy' || order.type === 'sell') {
        this.recentOrderSightings.set(itemKey(order.itemName), observedAt)
        if (order.type === 'buy') this.buyReservations.delete(itemKey(order.itemName))
      }
      if (order.type === 'sell') {
        const sellKey = itemKey(order.itemName)
        const previous = observedSellTotals.get(sellKey)
        observedSellTotals.set(sellKey, {
          itemName: order.itemName,
          quantity: number(previous?.quantity) + Math.max(0, number(order.totalCount || order.count))
        })
      }
    }
    // One item may legitimately have more than one Sell Offer while loose
    // claimed inventory is being drained. Aggregate the whole screen before
    // updating the reservation instead of keeping only the last row.
    for (const observed of observedSellTotals.values()) {
      this.rememberSellOfferReservation(observed.itemName, observed.quantity, observedAt)
    }
    const orders = parsedOrders.map(order => ({ ...order, placedAt: number(this.orderPlacedAt.get(this.orderRuntimeKey(order)), observedAt) }))
    this.bot.update({ orders })
    // All rows in the active account's Manage Orders screen are actionable.
    // The former respectCoopOrders switch was unreliable because Hypixel often
    // omits owner lore, and it also starved valid orders on co-op profiles.
    const manageableOrders = orders
    // Use every parsed sell offer for inventory recovery, even when ownership
    // metadata filters it out of actionable orders. A mixed/ownerless lore
    // snapshot must not manufacture inventory that is already on sale.
    this.restorePendingSellsFromTracker(orders)
    this.lastHealthyManageSyncAt = observedAt
    this.manageFailureStreak = 0
    this.hubNpcFallbackPending = false
    this.manageReconnectPending = false
    if (orders.length >= MAX_BAZAAR_ORDER_SLOTS || observedAt >= this.serverOrderCapUntil) this.serverOrderCapUntil = 0
    this.inactivityRestartPending = false
    const stalePendingKeys = new Set()
    const claimBackoffPendingKeys = new Set()
    let forcedPendingOrder = null
    for (const type of ['buy', 'sell']) {
      const pendingMap = this.pendingFilledMap(type)
      for (const [key, pending] of [...pendingMap]) {
        if (pending.account !== this.accountKey()) continue
        const siblings = manageableOrders.filter(item => item.type === type && itemKey(item.itemName) === itemKey(pending.itemName))
        let order = pending.liveOrderId
          ? siblings.find(item => item.liveOrderId === pending.liveOrderId)
          : null
        if (!order && siblings.length) {
          const wantedQuantity = Math.max(0, number(pending.quantity))
          order = [...siblings].sort((left, right) => {
            const claimScore = candidate => ((type === 'buy' ? this.hasBuyClaimSignal(candidate) : this.hasSellClaimSignal(candidate)) ? 1 : 0)
              + (this.isStructurallyComplete(candidate) ? 2 : 0)
              + (wantedQuantity > 0 && Math.max(0, number(candidate.totalCount || candidate.count)) === wantedQuantity ? 4 : 0)
            const scoreDelta = claimScore(right) - claimScore(left)
            return scoreDelta || this.orderAgeMs(right, observedAt) - this.orderAgeMs(left, observedAt)
          })[0]
          if (order?.liveOrderId) {
            pending.liveOrderId = order.liveOrderId
            const runtimePendingKey = this.orderRuntimeKey(order)
            if (runtimePendingKey !== key) {
              pendingMap.delete(key)
              pendingMap.set(runtimePendingKey, pending)
            }
          }
        }
        if (!order) {
          pending.missingObservations = number(pending.missingObservations) + 1
          if (pending.missingObservations >= 3 || observedAt - pending.at >= 90000) pendingMap.delete(key)
          else pendingMap.set(key, pending)
          continue
        }
        const resolvedPendingKey = this.orderRuntimeKey(order)
        if (resolvedPendingKey !== key) pendingMap.delete(key)
        pending.missingObservations = 0
        const confirmed = type === 'buy'
          ? this.hasBuyClaimSignal(order) || this.isStructurallyComplete(order)
          : this.hasSellClaimSignal(order) || this.isStructurallyComplete(order)
        pending.confirmed = confirmed
        pending.batchDeferred = false
        pendingMap.set(resolvedPendingKey, pending)
        if (!confirmed) {
          if (type === 'buy') {
            const total = Math.max(1, number(order.totalCount || order.count, pending.quantity || 1))
            const pendingQuantity = Math.max(1, number(pending.quantity, 1))
            const pendingOrder = {
              ...order,
              totalCount: total,
              filledCount: Math.max(number(order.filledCount), pendingQuantity),
              claimableItems: Math.max(number(order.claimableItems), pendingQuantity)
            }
            if (pendingQuantity < total && !this.partialBuyBatchDue(pendingOrder, observedAt, number(pending.at, observedAt))) {
              // Keep the authoritative fill event for the two-minute escape,
              // but do not treat a deliberately batched 1x/2x fill as a stale
              // snapshot that needs one-second refreshes or forced card opens.
              pending.batchDeferred = true
              pendingMap.set(resolvedPendingKey, pending)
              continue
            }
          }
          pending.staleObservations = number(pending.staleObservations) + 1
          pendingMap.set(resolvedPendingKey, pending)
          // A fill chat is authoritative. Hypixel sometimes keeps emitting an
          // old 0/N order row for minutes afterwards; waiting for that row to
          // change freezes all other work. After bounded retries, reopen the
          // exact order card and let its Claim Items control decide safely.
          const claimBackoff = this.claimBackoffActive(type, order, observedAt)
          if (!forcedPendingOrder && !claimBackoff
            && (pending.staleObservations >= 3 || observedAt - pending.at >= 45000)) {
            forcedPendingOrder = { type, order, pending }
          } else if (!claimBackoff) {
            stalePendingKeys.add(resolvedPendingKey)
          } else {
            // Skip maintenance for the known-broken card itself, but do not
            // let its local retry cooldown freeze unrelated Bazaar work.
            claimBackoffPendingKeys.add(resolvedPendingKey)
          }
        }
      }
    }
    this.refreshPendingFilledFlag()
    if (forcedPendingOrder) {
      const { type, order, pending } = forcedPendingOrder
      const total = Math.max(1, number(order.totalCount || order.count, pending.quantity || 1))
      const target = {
        ...this.targetFromOrder(order),
        itemName: order.itemName,
        displayName: order.itemName,
        orderQuantity: total,
        // The chat confirmation is the only quantity trusted for this fallback;
        // the stale order card's cumulative Filled counter is intentionally
        // ignored so we cannot manufacture inventory.
        filledQuantity: Math.max(1, number(pending.quantity, 1)),
        quantity: 0,
        forcedPendingClaim: true
      }
      if (type === 'buy') this.rememberBuyClaimAttempt(order, observedAt)
      this.setWatchdogWorkPending(true, observedAt)
      const claimPhase = type === 'buy' ? 'awaiting-claim-buy' : 'awaiting-claim-sell'
      const claimLabel = type === 'buy' ? 'Claim Items' : 'Claim Coins'
      this.setPhase(claimPhase, 'VERIFYING FILLED ORDER', target)
      return this.click(order.slot, `Filled-order screen remained stale; reopening ${order.itemName} to verify its ${claimLabel} control.`, claimPhase)
    }
    const configuredMaxBuyOrders = Math.min(7, Math.max(1, number(config.orders.maxBuyOrders, 5)))
    // Sell capacity is independent from the configured buy target. A 7-sell
    // preference must not reserve seven real Bazaar slots forever and prevent
    // the remaining slots from holding profitable Buy Orders in escrow.
    // The server-wide order cap is still enforced wherever a new order is
    // actually created.
    const configuredMaxSellOffers = Math.min(MAX_BAZAAR_ORDER_SLOTS, Math.max(1, number(config.orders.maxAmountOfSellOffers, 7)))
    const liveSellOrders = manageableOrders.filter(order => order.type === 'sell')
    const liveBuyOrderCount = manageableOrders.filter(order => order.type === 'buy').length
    const pendingSellSlotsNeeded = [...this.pendingSells.entries()]
      .filter(([, target]) => !target._account || target._account === this.accountKey())
      // flushPendingSell creates a separate physical offer even when another
      // Sell Offer for the same item exists. Reserve that slot while the task
      // is cooling down too, or a new Buy Order can steal slot fourteen.
      .length
    const sellPipelineCount = liveSellOrders.length + pendingSellSlotsNeeded
    const effectiveOrderCount = observedAt < this.serverOrderCapUntil
      ? Math.max(MAX_BAZAAR_ORDER_SLOTS, manageableOrders.length)
      : manageableOrders.length
    const actionableOrders = manageableOrders.filter(order => {
      const key = this.orderRuntimeKey(order)
      return !stalePendingKeys.has(key) && !claimBackoffPendingKeys.has(key)
    })
    const sellRowsCrowdBuyTarget = liveBuyOrderCount < configuredMaxBuyOrders
      && effectiveOrderCount + (configuredMaxBuyOrders - liveBuyOrderCount) > MAX_BAZAAR_ORDER_SLOTS
    const consolidationGroups = new Map()
    if (liveSellOrders.length > configuredMaxSellOffers || sellRowsCrowdBuyTarget) {
      for (const order of actionableOrders) {
        if (order.type !== 'sell' || this.hasSellClaimSignal(order) || this.isStructurallyComplete(order)) continue
        const key = itemKey(order.itemName)
        const group = consolidationGroups.get(key) || []
        group.push(order)
        consolidationGroups.set(key, group)
      }
    }
    const consolidationCandidate = [...consolidationGroups.values()]
      .filter(group => group.length >= 2)
      .sort((left, right) => (right.length - left.length)
        || left[0].itemName.localeCompare(right[0].itemName))[0] || null
    const maintenanceBuyOrders = actionableOrders.filter(order => order.type === 'buy'
      && !this.hasBuyClaimSignal(order) && !this.isStructurallyComplete(order))
    const excessBuy = maintenanceBuyOrders.length > configuredMaxBuyOrders
      ? maintenanceBuyOrders[maintenanceBuyOrders.length - 1]
      : null
    const seenBuyItems = new Set()
    let duplicateBuy = null
    for (const order of maintenanceBuyOrders) {
      const key = itemKey(order.itemName)
      if (seenBuyItems.has(key) && !duplicateBuy) duplicateBuy = order
      seenBuyItems.add(key)
    }
    const isPartialBuy = order => number(order.filledCount) > 0
      && number(order.filledCount) < Math.max(1, number(order.totalCount || order.count))
    // An existing Sell Offer for the same item must not strand a completed or
    // partially filled Buy Order. Claimed inventory is placed as a second
    // offer when a slot is available; cancelling the first offer to merge the
    // quantities caused a production loop that starved every other order.
    const partialBuy = actionableOrders.find(order => order.type === 'buy' && isPartialBuy(order) && this.buyClaimDue(order, observedAt))
    const filledBuy = actionableOrders.find(order => order.type === 'buy' && !isPartialBuy(order) && this.buyClaimDue(order, observedAt)
      && (this.hasBuyClaimSignal(order) || this.isStructurallyComplete(order)))
    // The configured sell target controls ordinary steady-state composition,
    // but loose inventory is a safety obligation. Claiming a purchase is safe
    // whenever one of the 14 physical Bazaar slots can hold its Sell Offer,
    // even when the configured sell preference is already full.
    const claimCapacityAvailable = order => {
      const matchingSell = liveSellOrders.some(sell => itemKey(sell.itemName) === itemKey(order.itemName))
      if (matchingSell || sellPipelineCount >= configuredMaxSellOffers) return false
      // A completed Buy Order releases its own physical slot when claimed. A
      // partial claim leaves that Buy Order active and therefore needs a spare
      // 14th slot for the resulting Sell Offer.
      return this.isStructurallyComplete(order) || effectiveOrderCount < MAX_BAZAAR_ORDER_SLOTS
    }
    const filledSell = actionableOrders.find(order => {
      if (order.type !== 'sell' || this.claimBackoffActive('sell', order, observedAt)) return false
      // A completed sell card can remain in a delayed Manage Orders snapshot
      // after its coins were already collected.  The old structural-complete
      // fallback clicked that stale card forever, repeatedly timing out in
      // awaiting-claim-sell and starving the entire instance.  Claim an offer
      // only when the card itself exposes a claim control/amount, or when a
      // fresh Bazaar fill event still needs card-level verification.
      if (this.sellClaimCardSuppressed(order, observedAt)
        && !this.pendingFilledEntry('sell', order)) return false
      return this.hasSellClaimSignal(order)
        || (this.isStructurallyComplete(order)
          && this.pendingFilledEntry('sell', order))
    })
    const relistEnabled = this.options().relistOutbidOrders !== false
    // Existing inventory and realized proceeds take priority over spending more
    // purse. Once an order reaches FF's stale-order limit, compare both sides
    // together so repeated sell maintenance cannot starve an older buy forever.
    // Below the timed limit, ordinary market relists still prefer the sell side.
    const relistAssessments = new Map(actionableOrders.map(order => [
      order,
      this.relistAssessment(order, observedAt)
    ]))
    // A queued loose lot of the same item is a reason to merge it into the
    // replacement, not a reason to prohibit maintenance of every live sibling.
    const relistCandidates = relistEnabled
      ? actionableOrders.filter(order => relistAssessments.get(order)?.eligible)
      : []
    const displacedSell = relistCandidates
      .filter(order => order.type === 'sell')
      .sort((a, b) => this.compareRelistNeed(a, b))[0] || null
    const displacedBuy = relistCandidates
      .filter(order => order.type === 'buy')
      .sort((a, b) => this.compareRelistNeed(a, b))[0] || null
    const oldestTimedRelist = relistCandidates
      .filter(order => relistAssessments.get(order)?.timed)
      .sort((a, b) => this.compareRelistNeed(a, b))[0] || null
    const relistOrder = displaced => {
      this.setWatchdogWorkPending(true, observedAt)
      const ageMinutes = Math.floor(this.orderAgeMs(displaced) / 60000)
      const timedRelist = this.isTimedRelistDue(displaced)
      const assessment = relistAssessments.get(displaced) || this.relistAssessment(displaced)
      // Start the cooldown when the cancel/reprice workflow starts, not only
      // after a later Setup chat line. A stalled or rejected replacement used
      // to leave the old offer eligible on the very next Manage snapshot and
      // could burn the whole Bazaar limit by cancelling the same sell over and
      // over. The next valid relist remains available after the cooldown.
      this.lastMarketRelistAt.set(this.orderRuntimeKey(displaced), observedAt)
      const currentBuyCandidate = displaced.type === 'buy' && this.marketSnapshotFresh()
        ? (this.market.candidates || []).find(item => itemKey(item.displayName || item.itemId) === itemKey(displaced.itemName))
        : null
      const target = {
        ...this.targetFromOrder(displaced),
        orderType: displaced.type,
        relistReason: timedRelist ? 'age' : 'market',
        orderAgeMinutes: ageMinutes,
        relistAhead: assessment.ahead,
        relistThreshold: assessment.threshold,
        relistSource: assessment.source,
        cancelWithoutRelist: displaced.type === 'buy' && !currentBuyCandidate,
        mergePendingSell: displaced.type === 'sell' && this.pendingSells.has(itemKey(displaced.itemName))
      }
      this.setPhase('cancel-options', timedRelist ? 'REFRESHING STALE ORDER' : 'RELISTING', target)
      const description = displaced.type === 'buy' ? 'buy order' : 'sell offer'
      const message = target.cancelWithoutRelist
        ? `Opening stale buy order for ${displaced.itemName}; it will be cancelled without a replacement because the current scanner snapshot has no qualifying candidate.`
        : timedRelist
        ? `Opening ${ageMinutes}-minute-old ${description} for ${displaced.itemName}; FF's built-in 10-minute stale-order limit was reached.`
        : `Opening displaced ${description} for ${displaced.itemName}; ${assessment.reason}.`
      return this.click(displaced.slot, message, 'cancel-options')
    }
    if (filledSell) {
      this.setWatchdogWorkPending(true, observedAt)
      const target = this.targetFromOrder(filledSell)
      this.setPhase('awaiting-claim-sell', 'CLAIMING COINS', target)
      const claimAllCoins = this.bot.findSlot(screen, 'claim all coins')
      if (claimAllCoins) {
        const cards = actionableOrders
          .filter(order => order.type === 'sell'
            && (this.hasSellClaimSignal(order)
              || (this.isStructurallyComplete(order) && this.pendingFilledEntry('sell', order))))
          .map(order => this.targetFromOrder(order))
        if (!cards.some(card => card.liveOrderId === target.liveOrderId)) cards.push(target)
        this.claimAllSellBatch = { account: this.accountKey(), at: observedAt, cards }
        return this.click(claimAllCoins.slot, 'Claiming all available Sell Offer coins in one Bazaar action.', 'awaiting-claim-sell')
      }
      this.claimAllSellBatch = null
      return this.click(filledSell.slot, `Claiming coins for ${filledSell.itemName}.`, 'awaiting-claim-sell')
    }
    if (!this.sellConsolidation && consolidationCandidate) {
      this.startSellConsolidation(consolidationCandidate, observedAt)
    }
    if (this.sellConsolidation) {
      if (this.advanceSellConsolidation(orders, observedAt)) return
      // A claimable sibling or another bounded verification condition can
      // intentionally postpone the next consolidation step. Do not let the
      // ordinary pending-sell/relist paths create a competing same-item row.
      if (this.sellConsolidation) {
        this.setWatchdogWorkPending(true, observedAt)
        this.setPhase('idle', 'WAITING TO CONTINUE SELL CONSOLIDATION', null)
        this.nextSyncAt = observedAt + 5000
        return
      }
    }
    // Claimed inventory must be secured in a Sell Offer before another Buy
    // Order is claimed. New orders may remain safely in Bazaar escrow while
    // sell recovery and stale-order maintenance continue; only collecting more
    // physical items is blocked so the player inventory cannot fill up.
    const claimedInventoryPending = this.pendingSells.size > 0
    if (claimedInventoryPending) {
      const runnablePendingSell = this.hasRunnablePendingSell(orders, observedAt)
      this.setWatchdogWorkPending(runnablePendingSell, observedAt)
      if (runnablePendingSell && this.flushPendingSell(orders)) return
      const sellCount = orders.filter(order => order.type === 'sell').length
      const waitingOnExistingOffer = [...this.pendingSells.keys()].some(key =>
        orders.some(order => order.type === 'sell' && itemKey(order.itemName) === key))
      this.setPhase('idle', waitingOnExistingOffer ? 'WAITING FOR EXISTING SELL OFFER' : 'WAITING TO PLACE SELL OFFER', null)
      this.nextSyncAt = Date.now() + 5000
      this.activity('info', waitingOnExistingOffer
        ? 'Claimed items are waiting for the existing matching Sell Offer to finish; no other Buy Order will be claimed meanwhile.'
          : effectiveOrderCount >= MAX_BAZAAR_ORDER_SLOTS
          ? `Claimed items are waiting for a physical Bazaar slot (${orders.length}/${MAX_BAZAAR_ORDER_SLOTS} total orders; configured steady-state sell target ${configuredMaxSellOffers}). Completed Buy Orders remain safely unclaimed meanwhile.`
          : `Claimed items are queued for another Sell Offer retry (${sellCount} sell, ${orders.length}/${MAX_BAZAAR_ORDER_SLOTS} physical slots used; configured steady-state sell target ${configuredMaxSellOffers}). Existing orders may still be maintained, but completed Buy Orders remain safely unclaimed.`, null)
    }
    // Leave completed purchases safely in Bazaar escrow until there is room to
    // create their sell offer. Existing offers are never cancelled merely
    // because the configured limit was lowered.
    if (!claimedInventoryPending && filledBuy && claimCapacityAvailable(filledBuy)) {
      this.setWatchdogWorkPending(true, observedAt)
      const target = this.targetFromOrder(filledBuy)
      this.rememberBuyClaimAttempt(filledBuy, observedAt)
      this.setPhase('awaiting-claim-buy', 'CLAIMING ITEMS', target)
      return this.click(filledBuy.slot, `Claiming purchased ${filledBuy.itemName}.`, 'awaiting-claim-buy')
    }
    if (!claimedInventoryPending && partialBuy && claimCapacityAvailable(partialBuy)) {
      this.setWatchdogWorkPending(true, observedAt)
      const target = this.targetFromOrder(partialBuy)
      this.rememberBuyClaimAttempt(partialBuy, observedAt)
      this.setPhase('awaiting-claim-buy', 'CLAIMING PARTIAL ITEMS', target)
      return this.click(partialBuy.slot, `Claiming ${target.filledQuantity} partially filled ${partialBuy.itemName}; the remaining ${target.quantity} will be reassessed.`, 'awaiting-claim-buy')
    }
    if (this.flushPendingBuyRelist(orders)) return
    if (this.flushPartialBuyCancel(orders)) return
    // Market-displaced sell offers normally remain ahead of buy maintenance,
    // but an order past the hard stale limit competes across both sides. This
    // prevents a steady stream of sell reprices from starving an old buy.
    if (oldestTimedRelist) return relistOrder(oldestTimedRelist)
    if (displacedSell) return relistOrder(displacedSell)
    if (duplicateBuy) {
      this.setWatchdogWorkPending(true, observedAt)
      const target = { ...this.targetFromOrder(duplicateBuy), orderType: 'buy', suppressRelist: true }
      this.setPhase('cancel-options', 'REMOVING DUPLICATE BUY', target)
      return this.click(duplicateBuy.slot, `Opening duplicate buy order for ${duplicateBuy.itemName}; one matching order will be kept.`, 'cancel-options')
    }
    if (excessBuy) {
      this.setWatchdogWorkPending(true, observedAt)
      const target = { ...this.targetFromOrder(excessBuy), orderType: 'buy', suppressRelist: true }
      this.setPhase('cancel-options', 'ENFORCING BUY LIMIT', target)
      return this.click(excessBuy.slot, `Opening excess buy order for ${excessBuy.itemName}; the configured maximum is ${configuredMaxBuyOrders}.`, 'cancel-options')
    }
    if (displacedBuy) return relistOrder(displacedBuy)
    if (relistEnabled) this.reportRelistAudit(actionableOrders, relistAssessments, observedAt)
    if (stalePendingKeys.size) {
      this.setWatchdogWorkPending(true, observedAt)
      this.setPhase('idle', 'REFRESHING FILLED ORDER', null)
      this.nextSyncAt = Date.now() + 1000
      if (Date.now() - this.lastPurseWaitLogAt >= 10000) {
        this.lastPurseWaitLogAt = Date.now()
        this.activity('info', 'A filled-order chat event arrived before Manage Orders updated. Waiting for a fresh claimable snapshot instead of treating the stale 0/N row as active.', null)
      }
      return
    }
    // Purse can increase while other orders remain active. Re-evaluate it on
    // every fresh Manage Orders read instead of keeping a sticky waiting flag.
    this.waitingForPurse = false
    const buyCount = orders.filter(order => order.type === 'buy').length
    const maxBuyOrders = configuredMaxBuyOrders
    // Buy orders remain inside Bazaar escrow, so a full sell target is not an
    // inventory constraint. Claiming purchases still requires sell capacity.
    // Every loose claimed lot needs a physical Sell Offer slot. Reserve those
    // slots while a retry is cooling down; otherwise a new Buy Order can take
    // the 14th slot and strand inventory indefinitely.
    if (buyCount < maxBuyOrders
      && effectiveOrderCount + Math.max(0, pendingSellSlotsNeeded) < MAX_BAZAAR_ORDER_SLOTS) {
      const now = Date.now()
      if (!this.marketSnapshotFresh(now)) {
        if (claimedInventoryPending) {
          this.nextSyncAt = now + 5000
          return
        }
        this.setPhase('idle', 'WAITING FOR FRESH MARKET', null)
        this.setWatchdogWorkPending(false, observedAt)
        this.nextSyncAt = now + (this.bot.hubModeActive ? 45_000 : 15_000)
        if (now - this.lastMarketWaitLogAt >= 60000) {
          this.lastMarketWaitLogAt = now
          this.activity('info', 'Scanner data is stale; claims and sell recovery remain active, but no new Buy Order will be placed until a fresh market scan arrives.', null)
        }
        return
      }
      for (const [key, failure] of this.failedBuyTargets) if (failure.cooldownUntil && failure.cooldownUntil <= now) this.failedBuyTargets.delete(key)
      const purse = Number(this.bot.state.purse)
      const purseFreshAt = Date.parse(this.bot.state.purseUpdatedAt || '')
      // The bridge clears purse on every disconnect/account switch, so a
      // finite purse observed in this connection belongs to the active account.
      // Scoreboard rows are change-driven and may not be emitted again while
      // the number stays constant; a 60-second TTL therefore stalled healthy
      // instances indefinitely. Require an observed value, not periodic churn.
      if (!Number.isFinite(purse) || !Number.isFinite(purseFreshAt)) {
        if (claimedInventoryPending) {
          this.nextSyncAt = now + 5000
          return
        }
        this.setPhase('idle', 'WAITING FOR FRESH PURSE', null)
        this.setWatchdogWorkPending(false, observedAt)
        // Reopening Manage Orders cannot create a missing purse reading. In
        // Hub mode a five-second retry loop consumed almost the whole roaming
        // window, so leave room for movement while the scoreboard/TAB update
        // arrives. Fill and claim events still force their own urgent syncs.
        this.nextSyncAt = now + (this.bot.hubModeActive ? 45_000 : 15_000)
        if (now - this.lastPurseWaitLogAt >= 60000) {
          this.lastPurseWaitLogAt = now
          this.activity('info', 'Waiting for a fresh purse value before placing another Buy Order; claims and sells remain active.', null)
        }
        return
      }
      const spendable = Math.max(0, purse - Math.max(0, number(config.purse?.minPurse)))
      let candidate = this.fitCandidateToPurse(this.selectBuyCandidate(orders, now, spendable), config)
      if (candidate && candidate !== false) candidate = this.fitCandidateToInventory(candidate, orders)
      if (candidate) {
        this.setWatchdogWorkPending(true, observedAt)
        return this.beginBuy(candidate)
      }
      if (candidate === false || (spendable < 1 && (this.market.candidates || []).length)) {
        if (claimedInventoryPending) {
          this.nextSyncAt = now + 5000
          return
        }
        this.setWatchdogWorkPending(false, observedAt)
        return this.waitForExistingOrders()
      }
    }
    if (claimedInventoryPending) {
      this.setWatchdogWorkPending(this.hasRunnablePendingSell(orders, observedAt), observedAt)
      this.nextSyncAt = Date.now() + 5000
      return
    }
    this.setPhase('idle', 'MONITORING', null)
    this.setWatchdogWorkPending(false, observedAt)
    const routineSyncFloor = this.bot.hubModeActive ? 45 : 10
    this.nextSyncAt = Date.now() + Math.max(routineSyncFloor, number(this.options().manageOrdersIntervalSeconds, 30)) * 1000
    this.activity('info', `Orders synchronized: ${buyCount} buy, ${orders.length - buyCount} sell (configured sell limit ${configuredMaxSellOffers}).`, null)
  }
  fitCandidateToPurse(candidate, config = this.readSettings().config) {
    if (!candidate) return null
    if (this.bot.state.purse === null || this.bot.state.purse === undefined) return candidate
    const purse = Number(this.bot.state.purse)
    if (!Number.isFinite(purse)) return candidate
    const reserve = Math.max(0, number(config.purse?.minPurse, 0))
    const spendable = Math.max(0, purse - reserve)
    const unitPrice = Math.max(0, number(candidate.buyOffer))
    const maxQuantity = unitPrice > 0 ? Math.floor(spendable / unitPrice) : 0
    if (maxQuantity < 1) {
      this.waitingForPurse = true
      this.lastPurseWaitLogAt = Date.now()
      this.activity('info', `Purse reserve reached: ${Math.round(purse).toLocaleString('en-US')} coins available, ${Math.round(reserve).toLocaleString('en-US')} reserved. Waiting for completed orders before buying again.`, null)
      this.setPhase('idle', 'WAITING FOR MINIMUM PURSE', null)
      this.nextSyncAt = Date.now() + 10000
      return false
    }
    const quantity = Math.max(1, Math.min(Math.floor(number(candidate.quantity, 1)), maxQuantity))
    if (quantity === candidate.quantity) return candidate
    const adjusted = { ...candidate, quantity }
    adjusted.projectedOrderValue = unitPrice * quantity
    adjusted.projectedProfit = number(candidate.profitPerUnit) * quantity
    const cycleHours = number(candidate.sellVolumeHour) > 0 && number(candidate.buyVolumeHour) > 0
      ? quantity / number(candidate.sellVolumeHour) + quantity / number(candidate.buyVolumeHour)
      : Infinity
    adjusted.estimatedCycleMinutes = Number.isFinite(cycleHours) ? cycleHours * 60 : null
    adjusted.coinsPerHour = Number.isFinite(cycleHours) && cycleHours > 0 ? adjusted.projectedProfit / cycleHours : 0
    return adjusted
  }
  sampleInventoryCapacity(screen, now = Date.now()) {
    if (this.inventoryCapacitySnapshot && now - this.inventoryCapacitySnapshot.sampledAt < INVENTORY_CAPACITY_SAMPLE_MS) {
      return this.inventoryCapacitySnapshot
    }
    const slots = (screen?.slots || []).filter(slot => Number.isInteger(slot?.slot))
    if (!slots.length) return this.inventoryCapacitySnapshot
    const maxSlot = Math.max(...slots.map(slot => slot.slot))
    // Manage Orders has 36 container slots followed by the player's 36
    // inventory slots. Smaller screens and partial test snapshots do not
    // provide enough information for a safe capacity calculation.
    if (maxSlot < 71) return this.inventoryCapacitySnapshot
    const firstInventorySlot = maxSlot - PLAYER_INVENTORY_SLOT_COUNT + 1
    const inventory = slots.filter(slot => slot.slot >= firstInventorySlot && slot.slot <= maxSlot)
    const indices = new Set(inventory.map(slot => slot.slot))
    if (inventory.length !== PLAYER_INVENTORY_SLOT_COUNT || indices.size !== PLAYER_INVENTORY_SLOT_COUNT) return this.inventoryCapacitySnapshot
    const occupied = inventory.filter(slot => {
      const kind = String(slot.kind || '').toLowerCase()
      return number(slot.count) > 0 && kind !== 'air' && itemKey(this.slotName(slot)) !== 'air'
    })
    this.inventoryCapacitySnapshot = {
      sampledAt: now,
      freeSlots: PLAYER_INVENTORY_SLOT_COUNT - occupied.length,
      partialStacks: occupied.map(slot => ({
        key: itemKey(this.slotName(slot)),
        count: Math.max(0, number(slot.count)),
        stackSize: stackSizeForItem(slot)
      }))
    }
    return this.inventoryCapacitySnapshot
  }
  reservedInventorySlots(orders = []) {
    return orders.filter(order => order.type === 'buy').reduce((total, order) => {
      const target = this.targetFromOrder(order)
      // Reserve only inventory that can still arrive. Portions already claimed
      // are present in the physical inventory snapshot and must not be counted
      // a second time.
      const quantity = Math.max(0, number(target.quantity) + number(target.filledQuantity))
      return total + (quantity > 0 ? Math.ceil(quantity / stackSizeForItem(target)) : 0)
    }, 0)
  }
  fitCandidateToInventory(candidate, orders = []) {
    if (!candidate || !this.inventoryCapacitySnapshot) return candidate
    const stackSize = stackSizeForItem(candidate)
    const reservedSlots = this.reservedInventorySlots(orders)
    const freeSlots = Math.max(0, this.inventoryCapacitySnapshot.freeSlots - reservedSlots)
    const key = itemKey(candidate.displayName || candidate.itemName || candidate.itemId)
    const partialCapacity = this.inventoryCapacitySnapshot.partialStacks
      .filter(stack => stack.key === key)
      .reduce((total, stack) => total + Math.max(0, Math.min(stackSize, stack.stackSize) - stack.count), 0)
    const maxQuantity = freeSlots * stackSize + partialCapacity
    if (maxQuantity < 1) {
      this.activity('info', `Inventory capacity is reserved for active buy orders. Waiting for items to be claimed or sold before placing another buy.`, null)
      this.setPhase('idle', 'WAITING FOR INVENTORY SPACE', null)
      this.nextSyncAt = Date.now() + 10000
      return false
    }
    const quantity = Math.max(1, Math.min(Math.floor(number(candidate.quantity, 1)), maxQuantity))
    if (quantity === candidate.quantity) return candidate
    const adjusted = { ...candidate, quantity }
    adjusted.projectedOrderValue = number(candidate.buyOffer) * quantity
    adjusted.projectedProfit = number(candidate.profitPerUnit) * quantity
    const cycleHours = number(candidate.sellVolumeHour) > 0 && number(candidate.buyVolumeHour) > 0
      ? quantity / number(candidate.sellVolumeHour) + quantity / number(candidate.buyVolumeHour)
      : Infinity
    adjusted.estimatedCycleMinutes = Number.isFinite(cycleHours) ? cycleHours * 60 : null
    adjusted.coinsPerHour = Number.isFinite(cycleHours) && cycleHours > 0 ? adjusted.projectedProfit / cycleHours : 0
    this.activity('info', `Inventory-aware sizing capped ${candidate.displayName || candidate.itemName || candidate.itemId} at ${quantity} item(s) (${stackSize} per slot).`, candidate)
    return adjusted
  }
  sharedReservedItemKeys(now = Date.now()) {
    for (const [key, expiresAt] of this.buyReservations) if (expiresAt <= now) this.buyReservations.delete(key)
    const sightingTtl = Math.max(60, number(this.options().manageOrdersIntervalSeconds, 30) * 3) * 1000
    const items = new Set([
      ...this.pendingSells.keys(),
      ...this.pendingBuyRelists.keys(),
      ...this.pendingPartialBuyCancels.keys(),
      ...this.buyReservations.keys(),
      ...[...this.recentOrderSightings].filter(([, seenAt]) => now - seenAt < sightingTtl).map(([key]) => key)
    ])
    const target = itemKey(this.state.target?.itemName || this.state.target?.displayName)
    if (target) items.add(target)
    return items
  }
  selectBuyCandidate(orders = [], now = Date.now(), maxAffordableUnitPrice = Infinity) {
    for (const [key, expiresAt] of this.buyReservations) if (expiresAt <= now) this.buyReservations.delete(key)
    const sightingTtl = Math.max(60, number(this.options().manageOrdersIntervalSeconds, 30) * 3) * 1000
    const active = new Set([
      ...orders.map(order => itemKey(order.itemName)),
      ...this.pendingSells.keys(),
      ...this.pendingBuyRelists.keys(),
      ...this.buyReservations.keys(),
      ...[...this.recentOrderSightings].filter(([, seenAt]) => now - seenAt < sightingTtl).map(([key]) => key)
    ])
    const eligible = (this.market.candidates || []).filter(item => {
      const key = itemKey(item.displayName || item.itemId)
      return number(item.quantity) >= 1
        && number(item.buyOffer) <= maxAffordableUnitPrice
        && !active.has(key)
        && !(this.failedBuyTargets.get(key)?.cooldownUntil > now)
        && !(number(this.accountLimitTracker().blockedBuyItems?.[key]?.cooldownUntil) > now)
    })
    if (eligible.length <= 1) return eligible[0] || null

    // Avoid repeatedly choosing the same item when other safe candidates are
    // similarly profitable. A merely "fresh" but dramatically weaker item
    // must not displace the best coins/hour candidate for ten minutes.
    const cooldownMs = 10 * 60 * 1000
    const accountSeed = String(this.bot.state.activeAccountId || this.bot.state.username || 'default')
    const fresh = eligible.filter(item => now - number(this.recentBuySelections.get(`${accountSeed}:${(item.displayName || item.itemId).toLowerCase()}`), 0) >= cooldownMs)
    const sortBy = String(this.readSettings().config.orders?.sortBy || 'coinsPerHour')
    const metric = item => Math.max(0, number(sortMetric(item, sortBy), number(item.projectedProfit)))
    const bestEligibleMetric = Math.max(1, ...eligible.map(metric))
    const hasCompetitiveFreshAlternative = fresh.some(item => metric(item) >= bestEligibleMetric * 0.75)
    const available = hasCompetitiveFreshAlternative ? fresh : eligible
    const bestMetric = Math.max(1, ...available.map(metric))
    const competitive = available.filter(item => metric(item) >= bestMetric * 0.35).slice(0, 8)
    // Coins/hour is deliberately independent of lot quantity, which used to
    // let a one-item candidate beat a nearly full MaxSpend order even when both
    // had comparable earning rates. Prefer candidates that can deploy at least
    // 70% of the configured budget when it remains within 25% of the best
    // earning rate; retain the small lot when the larger alternative would
    // materially reduce profit/hour.
    const configuredMaxSpend = Math.max(1, number(this.readSettings().config.purse?.maxSpentPerOrder, 10000000))
    const orderValue = item => Math.max(0, number(item.projectedOrderValue, number(item.buyOffer) * number(item.quantity)))
    const capitalized = competitive.filter(item => orderValue(item) >= configuredMaxSpend * 0.70
      && metric(item) >= bestMetric * 0.75)
    const scoringPool = capitalized.length ? capitalized : competitive
    const bestVolume = Math.max(1, ...scoringPool.map(item => Math.min(number(item.buyVolumeHour), number(item.sellVolumeHour))))
    return scoringPool.map(item => {
      const quality = metric(item) / bestMetric
      const balancedVolume = Math.min(number(item.buyVolumeHour), number(item.sellVolumeHour))
      const liquidity = 0.85 + 0.15 * Math.min(1, balancedVolume / bestVolume)
      const depth = Math.min(number(item.buyDepthTop5), number(item.sellDepthTop5))
      const depthCoverage = 0.85 + 0.15 * Math.min(1, depth / Math.max(1, number(item.quantity)))
      const cycle = number(item.estimatedCycleMinutes, 120)
      const fillSpeed = 0.85 + 0.15 / (1 + Math.max(0, cycle) / 60)
      return { item, score: quality * liquidity * depthCoverage * fillSpeed }
    }).sort((a, b) => b.score - a.score)[0]?.item || available[0]
  }
  targetFromOrder(order) {
    const orderKey = itemKey(order.itemName)
    const candidate = this.market.candidates.find(item => itemKey(item.displayName || item.itemId) === orderKey)
      || this.market.orderBooks?.get(orderKey)
    const orderQuantity = Math.max(1, number(order.totalCount || order.count, 1))
    const explicitClaimQuantity = Math.max(0, number(order.claimableItems))
    const reportedFilledQuantity = Math.min(orderQuantity, Math.max(
      0,
      number(order.filledCount),
      explicitClaimQuantity,
      order.complete === true || (this.hasBuyClaimSignal(order) && number(order.filledCount) <= 0 && explicitClaimQuantity <= 0)
        ? orderQuantity
        : 0
    ))
    const alreadyClaimed = order.type === 'buy'
      ? Math.max(0, number(this.orderStateValue(this.claimedBuyFillCounts, order)))
      : 0
    const filledQuantity = Math.max(0, reportedFilledQuantity - alreadyClaimed)
    const quantity = Math.max(0, orderQuantity - reportedFilledQuantity)
    const fill = { filledQuantity, orderQuantity, quantity }
    const identity = {
      liveOrderId: order.liveOrderId || '', runtimeOrderId: order.runtimeOrderId || order.liveOrderId || '',
      sourceOrderId: order.id || '', observedSlot: Number(order.slot), unitPriceCoins: number(order.unitPriceCoins)
    }
    if (!candidate) return { ...fill, ...identity, itemName: order.itemName, displayName: order.itemName }
    return {
      ...candidate,
      ...fill,
      ...identity,
      itemName: order.itemName,
      projectedOrderValue: number(candidate.buyOffer) * quantity,
      projectedProfit: number(candidate.profitPerUnit) * quantity
    }
  }
  removeTrackedOrder(type, name, target = null) {
    const key = itemKey(name)
    const liveOrderId = target?.liveOrderId || target?.runtimeOrderId
    this.bot.update({ orders: (this.bot.state.orders || []).filter(order => liveOrderId
      ? order.liveOrderId !== liveOrderId
      : !(order.type === type && itemKey(order.itemName) === key)) })
    if (liveOrderId) this.retireLiveOrder({ liveOrderId })
  }
  queueSell(target) {
    const key = itemKey(target?.itemName || target?.displayName)
    const quantity = Math.max(1, Math.floor(number(target?.quantity, 1)))
    if (!key) return
    this.missingInventorySuppressions.delete(this.orderTimestampKey('sell', target?.itemName || target?.displayName))
    const existing = this.pendingSells.get(key)
    const account = this.accountKey()
    this.pendingSells.set(key, existing && existing._account === account
      ? { ...existing, ...target, quantity: existing.quantity + quantity, inFlight: Boolean(existing.inFlight), _restored: false }
      : { ...target, quantity, inFlight: false, _account: account, _restored: false })
  }
  sellConsolidationKey(itemName) {
    return `${this.accountKey()}:sell-consolidation:${itemKey(itemName)}`
  }
  matchingSellConsolidation(target = this.state.target) {
    const consolidation = this.sellConsolidation
    if (!consolidation || consolidation.account !== this.accountKey()) return null
    if (!target?.sellConsolidationId || target.sellConsolidationId !== consolidation.id) return null
    return itemKey(target.itemName || target.displayName) === consolidation.itemKey ? consolidation : null
  }
  sellRefundQuantity(order) {
    const explicitRemaining = number(order?.quantity, NaN)
    if (Number.isFinite(explicitRemaining) && number(order?.orderQuantity) > 0) {
      return Math.max(0, Math.floor(explicitRemaining))
    }
    const total = Math.max(0, Math.floor(number(order?.totalCount || order?.count || order?.orderQuantity)))
    const filled = Math.min(total, Math.max(0, Math.floor(number(order?.filledCount))))
    return Math.max(0, total - filled)
  }
  sellRefundCapacity(orders, now = Date.now(), consolidation = this.sellConsolidation) {
    const rows = Array.isArray(orders) ? orders.filter(Boolean) : []
    const itemName = rows[0]?.itemName || consolidation?.itemName || ''
    const key = itemKey(itemName)
    const required = rows.reduce((sum, order) => sum + this.sellRefundQuantity(order), 0)
    const snapshot = this.inventoryCapacitySnapshot
    if (!key || required < 1) return { safe: false, required, available: 0, reason: 'refund quantity is unknown' }
    if (!snapshot || now - number(snapshot.sampledAt) > INVENTORY_CAPACITY_SAMPLE_MS) {
      return { safe: false, required, available: 0, reason: 'a fresh full inventory snapshot is unavailable' }
    }
    const stackSize = stackSizeForItem({ ...rows[0], itemName, displayName: itemName })
    const partialCapacity = (snapshot.partialStacks || [])
      .filter(stack => stack.key === key)
      .reduce((sum, stack) => sum + Math.max(0, Math.min(stackSize, number(stack.stackSize, stackSize)) - number(stack.count)), 0)
    const rawAvailable = Math.max(0, number(snapshot.freeSlots)) * stackSize + partialCapacity
    // Cached Manage data can predate one or more already acknowledged sibling
    // refunds. Reserve only refunds newer than that snapshot; once a newer
    // complete inventory frame arrives, those items are already reflected in
    // its occupied/partial slots and must not be subtracted twice.
    const reserved = (consolidation?.refundReservations || [])
      .filter(refund => number(refund.at) > number(snapshot.sampledAt))
      .reduce((sum, refund) => sum + Math.max(0, number(refund.quantity)), 0)
    const available = Math.max(0, rawAvailable - reserved)
    return {
      safe: available >= required,
      required,
      available,
      reserved,
      stackSize,
      reason: available >= required
        ? 'inventory can contain the full refund'
        : `only ${Math.floor(available)} item spaces remain for a ${required}-item refund`
    }
  }
  startSellConsolidation(siblings, now = Date.now()) {
    if (this.sellConsolidation || !Array.isArray(siblings) || siblings.length < 2) return false
    const itemName = String(siblings[0]?.itemName || '').trim()
    const key = itemKey(itemName)
    if (!key || siblings.some(order => order.type !== 'sell' || itemKey(order.itemName) !== key)) return false
    const cooldownKey = this.sellConsolidationKey(itemName)
    const cooldownUntil = number(this.sellConsolidationCooldowns.get(cooldownKey))
    if (cooldownUntil > now) return false
    if (cooldownUntil) this.sellConsolidationCooldowns.delete(cooldownKey)
    const capacity = this.sellRefundCapacity(siblings, now, null)
    if (!capacity.safe) {
      if (now - this.lastSellConsolidationCapacityWarningAt >= 60000) {
        this.lastSellConsolidationCapacityWarningAt = now
        this.activity('warning', `Duplicate ${itemName} Sell Offers were left untouched: ${capacity.reason}. FF will not risk sending a cancellation refund to stash.`, null)
      }
      return false
    }
    const id = `${this.accountKey()}:${now}:${++this.sellConsolidationSequence}`
    this.sellConsolidation = {
      id,
      account: this.accountKey(),
      itemKey: key,
      itemName,
      startedAt: now,
      status: 'cancelling',
      initialRows: siblings.length,
      cancelledRows: 0,
      refundedQuantity: 0,
      repostAttempts: 0,
      repostStartedAt: 0,
      currentLiveOrderId: '',
      refundReservations: []
    }
    this.activity('warning', `Consolidating ${siblings.length} duplicate Sell Offers for ${itemName}; each row will be cancelled separately and one combined offer will be submitted after every refund is confirmed.`, null)
    return true
  }
  finishSellConsolidation(message, now = Date.now()) {
    const consolidation = this.sellConsolidation
    if (!consolidation) return false
    this.sellConsolidationCooldowns.set(
      this.sellConsolidationKey(consolidation.itemName),
      now + SELL_CONSOLIDATION_COOLDOWN_MS
    )
    this.sellConsolidation = null
    if (message) this.activity('success', message, null)
    return true
  }
  abortSellConsolidation(reason, now = Date.now()) {
    const consolidation = this.sellConsolidation
    if (!consolidation) return false
    this.sellConsolidationCooldowns.set(
      this.sellConsolidationKey(consolidation.itemName),
      now + SELL_CONSOLIDATION_COOLDOWN_MS
    )
    this.sellConsolidation = null
    this.activity('warning', `${reason} Duplicate-sell consolidation is paused for ten minutes; unrelated orders will continue normally.`, null)
    return true
  }
  advanceSellConsolidation(orders = this.bot.state.orders || [], now = Date.now()) {
    const consolidation = this.sellConsolidation
    if (!consolidation) return false
    if (consolidation.account !== this.accountKey()) {
      this.sellConsolidation = null
      return false
    }
    if (now - number(consolidation.startedAt) >= SELL_CONSOLIDATION_TIMEOUT_MS) {
      this.abortSellConsolidation(`Consolidation of ${consolidation.itemName} exceeded its bounded fifteen-minute workflow.`)
      return false
    }
    const siblings = orders.filter(order => order.type === 'sell'
      && itemKey(order.itemName) === consolidation.itemKey)

    // If the Setup acknowledgement was lost during a reconnect, a single row
    // appearing after the book was observed empty is authoritative evidence
    // that the combined replacement exists. Never cancel that row again.
    if (consolidation.status === 'reposting' && siblings.length === 1) {
      const observedQuantity = Math.max(0, Math.floor(number(siblings[0].totalCount || siblings[0].count)))
      if (observedQuantity > 0) this.adjustLooseInventory(consolidation.itemName, -observedQuantity)
      this.pendingSells.delete(consolidation.itemKey)
      this.finishSellConsolidation(`Observed the combined ${consolidation.itemName} Sell Offer after reconnect; consolidation finished without cancelling it again.`, now)
      return false
    }
    if (consolidation.status === 'reposting' && siblings.length > 1
      && now - number(consolidation.repostStartedAt, now) < SELL_OFFER_OBSERVATION_GRACE_MS) {
      this.setPhase('idle', 'VERIFYING CONSOLIDATED SELL OFFER', null)
      this.nextSyncAt = now + 5000
      return true
    }
    if (consolidation.status === 'reposting' && siblings.length > 1) {
      // More than one row persisted beyond the observation grace. Resume the
      // bounded cancel pass; the per-item cooldown is applied only after a
      // single replacement is confirmed.
      consolidation.status = 'cancelling'
    }

    if (siblings.length) {
      // Filled/claimable rows are handled before this method. Refuse to cancel
      // one here as a second safety net: proceeds must be claimed first.
      if (siblings.some(order => this.hasSellClaimSignal(order) || this.isStructurallyComplete(order))) return false
      const capacity = this.sellRefundCapacity(siblings, now, consolidation)
      if (!capacity.safe) {
        if (now - this.lastSellConsolidationCapacityWarningAt >= 60000) {
          this.lastSellConsolidationCapacityWarningAt = now
          this.activity('warning', `Paused ${consolidation.itemName} consolidation before the next cancellation: ${capacity.reason}. No sibling will be touched until a fresh Manage Orders inventory snapshot proves the complete refund fits.`, null)
        }
        this.setPhase('idle', 'WAITING FOR SAFE SELL REFUND SPACE', null)
        this.nextSyncAt = now + 5000
        return true
      }
      const order = [...siblings].sort((left, right) => {
        const ageDifference = this.orderAgeMs(right, now) - this.orderAgeMs(left, now)
        return ageDifference || Number(left.slot) - Number(right.slot)
      })[0]
      const target = {
        ...this.targetFromOrder(order),
        orderType: 'sell',
        suppressRelist: true,
        sellConsolidationId: consolidation.id
      }
      consolidation.status = 'cancelling'
      consolidation.currentLiveOrderId = order.liveOrderId || ''
      this.setWatchdogWorkPending(true, now)
      this.setPhase('cancel-options', 'CONSOLIDATING DUPLICATE SELLS', target)
      return this.click(order.slot, `Opening one duplicate ${consolidation.itemName} Sell Offer for safe consolidation.`, 'cancel-options')
    }

    let queued = this.pendingSells.get(consolidation.itemKey)
    if (!queued && consolidation.refundedQuantity > 0) {
      this.queueSell({
        itemName: consolidation.itemName,
        displayName: consolidation.itemName,
        quantity: consolidation.refundedQuantity,
        sellConsolidationId: consolidation.id
      })
      queued = this.pendingSells.get(consolidation.itemKey)
    }
    if (!queued || number(queued.quantity) < 1) {
      this.abortSellConsolidation(`Hypixel did not provide an authoritative refunded-item quantity for ${consolidation.itemName}; FF will not invent inventory.`)
      return false
    }
    if (number(queued.retryAfter) > now) {
      this.setPhase('idle', 'WAITING TO REPOST CONSOLIDATED SELL', null)
      this.nextSyncAt = Math.min(number(queued.retryAfter), now + 5000)
      return true
    }
    consolidation.status = 'reposting'
    consolidation.repostStartedAt = now
    consolidation.repostAttempts += 1
    const replacement = {
      ...queued,
      itemName: consolidation.itemName,
      displayName: consolidation.itemName,
      sellConsolidationId: consolidation.id,
      inFlight: true
    }
    this.pendingSells.set(consolidation.itemKey, replacement)
    this.activity('action', `All duplicate ${consolidation.itemName} rows are gone; submitting one combined Sell Offer for ${Math.floor(number(replacement.quantity)).toLocaleString('en-US')} authoritatively refunded item(s).`, replacement)
    this.beginSell(replacement)
    return true
  }
  rememberSellOfferReservation(itemName, quantity, now = Date.now(), mode = 'replace') {
    const amount = Math.max(0, Math.floor(number(quantity)))
    if (!itemKey(itemName) || amount < 1) return false
    const key = this.orderTimestampKey('sell', itemName)
    const existing = this.sellOfferReservations.get(key)
    if (mode === 'add') {
      this.sellOfferReservations.set(key, {
        itemName: String(itemName),
        quantity: Math.max(0, number(existing?.quantity)) + amount,
        seenAt: now,
        confirmedAt: now
      })
      return true
    }
    // A Manage packet received just after Setup can still contain only the old
    // offer rows. Do not let that stale packet erase the freshly confirmed
    // aggregate and recreate a phantom pending-sell queue.
    if (existing?.confirmedAt
      && now - number(existing.confirmedAt) < SELL_OFFER_OBSERVATION_GRACE_MS
      && amount < number(existing.quantity)) return true
    this.sellOfferReservations.set(key, {
      itemName: String(itemName), quantity: amount, seenAt: now, confirmedAt: 0
    })
    return true
  }
  clearSellOfferReservation(itemName) {
    this.sellOfferReservations.delete(this.orderTimestampKey('sell', itemName))
  }
  consumeSellOfferReservation(itemName, quantity, now = Date.now()) {
    const key = this.orderTimestampKey('sell', itemName)
    const reservation = this.sellOfferReservations.get(key)
    if (!reservation) return false
    const remaining = Math.max(0, Math.floor(number(reservation.quantity) - Math.max(0, number(quantity))))
    if (remaining < 1) this.sellOfferReservations.delete(key)
    else this.sellOfferReservations.set(key, { ...reservation, quantity: remaining, seenAt: now })
    return true
  }
  restorePendingSellsFromTracker(orders = []) {
    const accountKey = this.accountKey()
    const now = Date.now()
    if (now - number(this.pendingSellRecoveryAccounts.get(accountKey)) < 15000) return false
    this.pendingSellRecoveryAccounts.set(accountKey, now)
    const account = this.accountLimitTracker()
    const offered = new Map()
    for (const order of orders) {
      if (order.type !== 'sell') continue
      const key = itemKey(order.itemName)
      const amount = Math.max(0, number(order.totalCount || order.count))
      offered.set(key, number(offered.get(key)) + amount)
    }
    for (const [reservationKey, reservation] of [...this.sellOfferReservations]) {
      if (now - number(reservation.seenAt) > SELL_OFFER_RESERVATION_MS) {
        this.sellOfferReservations.delete(reservationKey)
        continue
      }
      const key = itemKey(reservation.itemName)
      offered.set(key, Math.max(number(offered.get(key)), number(reservation.quantity)))
    }
    let restored = 0
    // Cost basis (`inventory`) includes stock already committed to Sell Offers
    // and therefore cannot prove that an item is physically loose. V7 tracks
    // authoritative Claim/Setup/Cancel deltas separately and restores only
    // that loose inventory, eliminating sold-but-unclaimed phantom queues.
    for (const lot of Object.values(account.looseInventory || {})) {
      const key = itemKey(lot?.itemName)
      if (!key) continue
      const suppressionKey = this.orderTimestampKey('sell', lot.itemName)
      const suppressedUntil = number(this.missingInventorySuppressions.get(suppressionKey))
      if (suppressedUntil > now) continue
      if (suppressedUntil) this.missingInventorySuppressions.delete(suppressionKey)
      const unoffered = Math.max(0, Math.floor(number(lot.quantity)))
      const existing = this.pendingSells.get(key)
      if (unoffered < 1) {
        if (existing?._account === accountKey && existing._restored && !existing.inFlight) this.pendingSells.delete(key)
        continue
      }
      if (existing && existing._account === accountKey && !existing._restored) continue
      if (existing && existing._account === accountKey && number(existing.quantity) === unoffered) continue
      this.pendingSells.set(key, {
        ...(existing || {}),
        itemName: lot.itemName,
        displayName: lot.itemName,
        quantity: unoffered,
        inFlight: Boolean(existing?.inFlight),
        retryAfter: number(existing?.retryAfter),
        _account: accountKey,
        _restored: true
      })
      restored += 1
    }
    if (restored) this.activity('warning', `Recovered ${restored} claimed-but-unoffered item queue${restored === 1 ? '' : 's'} from the persistent profit tracker.`, null)
    return restored > 0
  }
  flushPendingSell(orders = this.bot.state.orders || []) {
    for (const [key, target] of this.pendingSells) {
      if (target._account && target._account !== this.accountKey()) continue
      // Pending claimed inventory may spill past the configured steady-state
      // sell preference. The physical 14-order cap is the only capacity limit:
      // leaving loose items in inventory is riskier than temporarily carrying
      // an extra Sell Offer.
      if (orders.length >= MAX_BAZAAR_ORDER_SLOTS) continue
      if (number(target.retryAfter) > Date.now()) continue
      const queued = { ...target, inFlight: true }
      this.pendingSells.set(key, queued)
      this.beginSell(queued)
      return true
    }
    return false
  }
  queueBuyRelist(target) {
    const key = itemKey(target?.itemName || target?.displayName)
    const quantity = Math.max(0, Math.floor(number(target?.quantity)))
    if (!key || quantity < 1) return false
    const existing = this.pendingBuyRelists.get(key)
    const replacementQuantity = Math.max(quantity, Math.floor(number(existing?.quantity)))
    this.pendingBuyRelists.set(key, {
      ...target,
      quantity: replacementQuantity,
      filledQuantity: 0,
      orderQuantity: replacementQuantity
    })
    return true
  }
  flushPendingBuyRelist(orders = this.bot.state.orders || []) {
    for (const [key, target] of this.pendingBuyRelists) {
      const matchingOrders = orders.filter(order => itemKey(order.itemName) === key)
      if (matchingOrders.some(order => order.type === 'buy')) {
        this.pendingBuyRelists.delete(key)
        continue
      }
      // Never overlap the replacement buy with the sell of its filled portion.
      if (matchingOrders.length || this.pendingSells.has(key)) continue
      this.beginBuy(target)
      return true
    }
    return false
  }
  hasRunnablePendingSell(orders = this.bot.state.orders || [], now = Date.now()) {
    if (orders.length >= MAX_BAZAAR_ORDER_SLOTS) return false
    for (const [key, target] of this.pendingSells) {
      if (target._account && target._account !== this.accountKey()) continue
      if (number(target.retryAfter) > now) continue
      return true
    }
    return false
  }
  noteConfirmedBazaarAction(productive = false, at = Date.now()) {
    this.lastConfirmedBazaarActionAt = at
    if (productive) this.lastProductiveBazaarActionAt = at
    this.inactivityRestartPending = false
  }
  noteProductiveBazaarAction(at = Date.now()) {
    this.noteConfirmedBazaarAction(true, at)
    if (this.watchdogWorkPending) this.actionableIdleSinceAt = at
  }
  setWatchdogWorkPending(pending, at = Date.now()) {
    const value = Boolean(pending)
    if (value && !this.watchdogWorkPending) this.actionableIdleSinceAt = at
    if (!value) this.actionableIdleSinceAt = 0
    this.watchdogWorkPending = value
  }
  restartInactiveInstance(now = Date.now()) {
    // Do not restart a healthy saturated queue merely because market fills are
    // slow. The timer starts only when there is work FF should be able to do:
    // a claim, pending sell, relist/cleanup, or a new candidate for a free slot.
    if (!this.watchdogWorkPending || !this.actionableIdleSinceAt) return false
    const actionableProgressAt = Math.max(this.lastProductiveBazaarActionAt, this.actionableIdleSinceAt)
    if (now - actionableProgressAt < INACTIVITY_RESTART_MS) return false
    // Phase timeout/recovery owns a stuck active workflow. Routine Manage reads,
    // cancels, and identical reposts deliberately do not suppress this watchdog.
    if (this.state.phase !== 'idle' || this.manualControlUntil > now) return false
    // A failed reconnect must never turn into the rapid reconnect loop that
    // affected earlier builds.  At most one recovery may be requested per
    // ten-minute quiet period, and only for this controller.
    if (this.inactivityRestartPending || now - this.lastInactivityRestartAt < INACTIVITY_RESTART_MS) return false
    if (typeof this.bot.reconnectCurrent !== 'function') return false
    this.inactivityRestartPending = true
    this.lastInactivityRestartAt = now
    this.clearConfirmationRetry()
    this.activity('warning', 'No productive Bazaar progress for 10 minutes. Restarting this instance only to resynchronize it.', null)
    try {
      const scheduled = this.bot.reconnectCurrent('No productive Bazaar progress for 10 minutes', 1000)
      if (scheduled === false) this.inactivityRestartPending = false
      return scheduled !== false
    } catch (error) {
      this.inactivityRestartPending = false
      this.activity('error', `The inactive-instance restart could not be scheduled: ${error.message || error}`, null)
      return false
    }
  }
  buyClaimKey(order) { return this.orderRuntimeKey(order, 'buy', order?.itemName) }
  buyClaimFill(order) {
    const total = Math.max(1, number(order?.totalCount || order?.count, 1))
    const filled = Math.max(0, number(order?.filledCount), number(order?.claimableItems))
    return Math.min(total, filled || (order?.complete === true || this.hasBuyClaimSignal(order) ? total : 0))
  }
  partialBuyBatchDue(order, now = Date.now(), authoritativeAt = 0) {
    const key = this.buyClaimKey(order)
    const total = Math.max(1, number(order?.totalCount || order?.count, 1))
    const filled = this.buyClaimFill(order)
    const claimed = Math.max(0, number(this.claimedBuyFillCounts.get(key)))
    const unclaimed = Math.max(0, filled - claimed)
    if (unclaimed < 1) {
      this.partialBuyBatches.delete(key)
      return false
    }
    const threshold = Math.max(PARTIAL_BUY_BATCH_MIN_ITEMS, Math.ceil(total * PARTIAL_BUY_BATCH_RATIO))
    const progressAt = number(authoritativeAt) > 0
      ? number(authoritativeAt)
      : number(this.orderFillProgress.get(key)?.at, now)
    const previous = this.partialBuyBatches.get(key)
    const sameBatch = previous && number(previous.claimed) === claimed && filled >= number(previous.filled)
    const batch = sameBatch
      ? { ...previous, filled }
      : { claimed, filled, firstSeenAt: Math.min(now, progressAt) }
    this.partialBuyBatches.set(key, batch)
    return unclaimed >= threshold || now - number(batch.firstSeenAt, now) >= PARTIAL_BUY_BATCH_MAX_WAIT_MS
  }
  buyClaimDue(order, now = Date.now()) {
    if (this.claimBackoffActive('buy', order, now)) return false
    const key = this.buyClaimKey(order)
    const fill = this.buyClaimFill(order)
    const claimed = Math.max(0, number(this.claimedBuyFillCounts.get(key)))
    const explicitClaim = this.hasBuyClaimSignal(order)
    if (!explicitClaim && fill <= claimed) return false
    const complete = this.isStructurallyComplete(order) || fill >= Math.max(1, number(order?.totalCount || order?.count, 1))
    if (!complete && !this.partialBuyBatchDue(order, now)) return false
    if (complete) this.partialBuyBatches.delete(key)
    const attempt = this.buyClaimAttempts.get(key)
    return !attempt || attempt.fill !== fill || now - attempt.at >= 60000
  }
  rememberBuyClaimAttempt(order, now = Date.now()) {
    this.buyClaimAttempts.set(this.buyClaimKey(order), { fill: this.buyClaimFill(order), at: now, target: this.targetFromOrder(order) })
  }
  partialBuyDecision(order) {
    const key = itemKey(order?.itemName)
    const candidate = this.market.candidates.find(item => itemKey(item.displayName || item.itemId) === key)
    if (!candidate) return this.marketSnapshotFresh()
      ? { cancel: true, reason: 'the item no longer passes the current profit/filter rules' }
      : { cancel: false, reason: 'current profit is unavailable from a fresh market snapshot, so the remainder will stay active' }
    const config = this.readSettings().config
    const minimum = number(config.profit?.min, 0)
    const maximum = number(config.profit?.max, Infinity)
    const minimumPercentage = number(config.profit?.minPercentage, 0)
    const profitPerUnit = number(candidate.profitPerUnit)
    const profitPercentage = number(candidate.profitPercentage)
    const profitable = profitPerUnit >= minimum && profitPerUnit <= maximum && profitPercentage >= minimumPercentage
    return profitable
      ? { cancel: false, reason: `remaining profit still qualifies (${Math.round(profitPerUnit).toLocaleString('en-US')} coins/item, ${profitPercentage.toFixed(2)}%)` }
      : { cancel: true, reason: `remaining profit no longer qualifies (${Math.round(profitPerUnit).toLocaleString('en-US')} coins/item, ${profitPercentage.toFixed(2)}%)` }
  }
  queuePartialBuyCancel(target) {
    const key = itemKey(target?.itemName || target?.displayName)
    if (key) this.pendingPartialBuyCancels.set(key, { ...target, orderType: 'buy', suppressRelist: true })
  }
  flushPartialBuyCancel(orders = this.bot.state.orders || []) {
    for (const [key] of this.pendingPartialBuyCancels) {
      const order = orders.find(item => item.type === 'buy' && itemKey(item.itemName) === key)
      if (!order) { this.pendingPartialBuyCancels.delete(key); continue }
      const target = { ...this.targetFromOrder(order), orderType: 'buy', suppressRelist: true }
      this.pendingPartialBuyCancels.delete(key)
      this.setPhase('cancel-options', 'CANCELLING UNPROFITABLE REMAINDER', target)
      return this.click(order.slot, `Opening the remaining buy order for ${order.itemName}; its current profit no longer qualifies.`, 'cancel-options')
    }
    return false
  }
  orderAgeMs(order, now = Date.now()) {
    const placedAt = number(this.orderStateValue(this.orderPlacedAt, order), number(order.placedAt, now))
    return Math.max(0, now - placedAt)
  }
  staleRelistMs(order) {
    return order?.type === 'sell' ? STALE_SELL_ORDER_RELIST_MS : STALE_ORDER_RELIST_MS
  }
  isTimedRelistDue(order, now = Date.now()) {
    return this.orderAgeMs(order, now) >= this.staleRelistMs(order)
  }
  relistAssessment(order, now = Date.now()) {
    const config = this.readSettings().config
    const settings = config.orders || {}
    const orderKey = itemKey(order.itemName)
    const marketFresh = this.marketSnapshotFresh(now)
    const qualifyingCandidate = marketFresh
      ? this.market.candidates.find(item => itemKey(item.displayName || item.itemId) === orderKey)
      : null
    const market = marketFresh ? (qualifyingCandidate || this.market.orderBooks?.get(orderKey)) : null
    const measure = String(settings.relistAfterType || 'orderAmount').toLowerCase() === 'itemamount' ? 'itemAmount' : 'orderAmount'
    const configuredThreshold = Math.max(0, number(market?.relistAfter, number(settings.relistAfter, 3)))
    // The configured threshold is authoritative. Ultra V6 deliberately uses
    // one confirmed order ahead for maximum turnover; age and per-order
    // cooldown guards below still prevent immediate cancel/recreate loops.
    const threshold = configuredThreshold
    const unit = measure === 'itemAmount' ? 'items' : 'orders'
    const age = this.orderAgeMs(order, now)
    const staleLimit = this.staleRelistMs(order)
    const timed = age >= staleLimit
    const result = {
      eligible: false,
      timed,
      overdue: Math.max(0, age - staleLimit),
      age,
      ahead: null,
      threshold,
      measure,
      source: 'none',
      pressure: 0,
      reason: 'competition could not be confirmed'
    }
    if (this.isStructurallyComplete(order)
      || (order.type === 'buy' ? this.hasBuyClaimSignal(order) : this.hasSellClaimSignal(order))) {
      result.reason = 'order is claimable or complete and must be collected before relist maintenance'
      result.source = 'claim state'
      return result
    }
    // This tracks a relist attempt (including a timed escape), rather than a
    // successful Setup. It must run before the timed-order branch below: a
    // replacement can briefly inherit an old visual timestamp, and otherwise
    // it would bypass the market cooldown and loop cancel -> setup forever.
    const marketRelistKey = this.orderRuntimeKey(order)
    const cooldownLeft = MARKET_RELIST_COOLDOWN_MS - (now - number(this.lastMarketRelistAt.get(marketRelistKey), 0))
    if (cooldownLeft > 0) {
      result.reason = `recently sent through a relist workflow (${Math.ceil(cooldownLeft / 1000)}s cooldown remaining)`
      return result
    }
    if (!threshold && !timed) {
      result.reason = 'market relisting is disabled (relistAfter is 0)'
      return result
    }
    if (timed && order.type === 'buy' && !marketFresh) {
      result.reason = 'buy relist is waiting for a fresh market snapshot'
      result.source = 'market freshness'
      return result
    }
    if (timed && order.type === 'buy' && marketFresh && !qualifyingCandidate) {
      result.eligible = true
      result.source = 'current filter'
      result.pressure = 3
      result.reason = 'the stale buy no longer has a qualifying scanner candidate'
      return result
    }
    const minAge = Math.max(0, number(this.options().relistMinAgeSeconds, 90)) * 1000
    if (age < minAge) {
      result.reason = `too new to relist (${Math.ceil((minAge - age) / 1000)}s remaining)`
      return result
    }
    const frontDetails = this.orderDetailsText(order)
    const frontLower = frontDetails.toLowerCase()
    const frontPrice = number(order.unitPriceCoins) || coinValue(frontDetails.match(/price per unit\s*:\s*([\d,.]+\s*[KMGBT]?)/i)?.[1])
    const explicitFront = /(?:^|\D)0\s+(?:orders?|items?)\s+ahead(?:\D|$)/i.test(frontDetails)
    const levels = order.type === 'buy' ? market?.buyCompetition : market?.sellCompetition
    const depthFront = frontPrice > 0 && Array.isArray(levels) && levels.length > 0
      && !levels.some(level => order.type === 'buy'
        ? number(level.price) > frontPrice + 0.00001
        : number(level.price) < frontPrice - 0.00001)
    const bestPrice = order.type === 'buy' ? number(market?.buyOffer) : number(market?.sellOffer)
    const bestPriceFront = frontPrice > 0 && bestPrice > 0 && (order.type === 'buy'
      ? bestPrice <= frontPrice + 0.00001
      : bestPrice >= frontPrice - 0.00001)
    const absoluteStallLimit = order.type === 'sell' ? 30 * 60 * 1000 : 20 * 60 * 1000
    const progress = this.orderStateValue(this.orderFillProgress, order)
    const progressAt = number(progress?.at, now - age)
    const stalledFillEscape = now - progressAt >= absoluteStallLimit
    if (timed && !stalledFillEscape && (explicitFront || depthFront || bestPriceFront)) {
      result.ahead = 0
      result.source = explicitFront ? 'order tooltip' : depthFront ? 'live Bazaar depth' : 'live best price'
      result.reason = `confirmed at the front from ${result.source}; age alone will not cancel a top-of-book order`
      return result
    }
    if (timed) {
      result.eligible = true
      result.source = 'age'
      result.pressure = 2 + (result.overdue / staleLimit)
      result.reason = stalledFillEscape
        ? `no fill progress for ${Math.round(absoluteStallLimit / 60000)} minutes; queue position is no longer productive`
        : `built-in ${Math.round(staleLimit / 60000)} minute stale-order limit reached`
      return result
    }
    // The 90-second row age above is the settle guard. A former global guard
    // postponed every relist whenever any unrelated order was placed; with a
    // busy book that condition could remain true forever.
    const details = (order.details || []).join(' ')
    const lower = details.toLowerCase()
    const price = number(order.unitPriceCoins) || coinValue(details.match(/price per unit\s*:\s*([\d,.]+\s*[KMGBT]?)/i)?.[1])
    const count = Math.max(1, number(order.totalCount, number(order.count, 1)))
    const worth = number(order.totalWorthCoins) || (price * count)
    const worthThreshold = Math.max(0, number(market?.relistWorthThreshold, number(settings.relistWorthThreshold, 0)))
    if (worthThreshold && worth && worth < worthThreshold) {
      result.reason = `worth ${Math.round(worth).toLocaleString('en-US')} is below the ${Math.round(worthThreshold).toLocaleString('en-US')} relist floor`
      return result
    }
    if (!threshold) {
      result.reason = 'market relisting is disabled (relistAfter is 0)'
      return result
    }
    const tooltipAhead = measure === 'itemAmount'
      ? Number(lower.match(/([\d,]+)\s*items?\s+ahead/)?.[1]?.replaceAll(',', ''))
      : Number(lower.match(/([\d,]+)\s*orders?\s+ahead/)?.[1]?.replaceAll(',', ''))
    if (Number.isFinite(tooltipAhead)) {
      result.ahead = Math.max(0, tooltipAhead)
      result.source = 'order tooltip'
    } else if (price > 0 && market) {
      const levels = order.type === 'buy' ? market.buyCompetition : market.sellCompetition
      if (Array.isArray(levels) && levels.length) {
        const better = levels.filter(level => order.type === 'buy'
          ? number(level.price) > price + 0.00001
          : number(level.price) < price - 0.00001)
        result.ahead = better.reduce((sum, level) => sum + (measure === 'itemAmount'
          ? Math.max(0, number(level.amount))
          : Math.max(1, number(level.orders))), 0)
        result.source = 'live Bazaar depth'
      } else {
        const bestPrice = order.type === 'buy' ? number(market.buyOffer) : number(market.sellOffer)
        if (bestPrice > 0) {
          const displaced = order.type === 'buy' ? bestPrice > price + 0.00001 : bestPrice < price - 0.00001
          result.ahead = displaced ? 1 : 0
          result.source = 'live best price'
        }
      }
    }
    if (result.ahead === null && /outbid|not (?:the )?top|not best|undercut|better offer/.test(lower)) {
      result.ahead = 1
      result.source = 'order status'
    }
    if (result.ahead === null) {
      result.reason = `could not confirm ${unit} ahead; keeping the order until live depth or the stale-order limit confirms a relist`
      return result
    }
    result.pressure = threshold > 0 ? result.ahead / threshold : 0
    result.eligible = result.ahead >= threshold
    result.reason = result.eligible
      ? `confirmed ${Math.round(result.ahead).toLocaleString('en-US')} ${unit} ahead from ${result.source} (threshold ${threshold})`
      : result.ahead === 0
        ? `confirmed at the front from ${result.source}: 0 ${unit} ahead (threshold ${threshold})`
        : `confirmed ${Math.round(result.ahead).toLocaleString('en-US')} ${unit} ahead from ${result.source}, below threshold ${threshold}`
    return result
  }
  relistNeed(order, now = Date.now()) {
    return this.relistAssessment(order, now)
  }
  compareRelistNeed(a, b, now = Date.now()) {
    const left = this.relistNeed(a, now)
    const right = this.relistNeed(b, now)
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
    if (left.timed !== right.timed) return left.timed ? -1 : 1
    if (left.timed && Math.abs(left.overdue - right.overdue) > 1000) return right.overdue - left.overdue
    if (left.timed && a.type !== b.type) return a.type === 'sell' ? -1 : 1
    if (left.pressure !== right.pressure) return right.pressure - left.pressure
    return right.age - left.age
  }
  legacyShouldRelistOrder(order) {
    const config = this.readSettings().config
    const settings = config.orders || {}
    const market = this.market.candidates.find(item => itemKey(item.displayName || item.itemId) === itemKey(order.itemName))
    const threshold = Math.max(0, number(market?.relistAfter, number(settings.relistAfter, 3)))
    const now = Date.now()
    const age = this.orderAgeMs(order, now)
    const timedRelist = this.isTimedRelistDue(order, now)
    if (!threshold && !timedRelist) return false
    const minAge = Math.max(0, number(this.options().relistMinAgeSeconds, 90)) * 1000
    // Every relist signal observes the same cooldown. Without this guard, one
    // competitor can force a fresh order into a cancel/recreate loop every few
    // seconds, spending more time in menus than filling.
    if (age < minAge) return false
    // After adding an order—especially the order that fills maxBuyOrders—let
    // the whole book settle before repositioning an older order. This avoids
    // place -> sync two seconds later -> cancel loops while preserving relists.
    const details = (order.details || []).join(' ')
    const lower = details.toLowerCase()
    const price = coinValue(details.match(/price per unit\s*:\s*([\d,.]+\s*[KMGBT]?)/i)?.[1])
    const worth = price * Math.max(1, number(order.count, 1))
    // Time is an independent escape hatch for orders that Hypixel leaves
    // sitting without a reliable orders/items-ahead marker. It deliberately
    // bypasses the strategy worth floor: that floor controls market-driven
    // repositioning, but must never strand a low-value sell indefinitely.
    // A successful replacement records a fresh timestamp, so it cannot loop.
    if (timedRelist) return true
    const worthThreshold = Math.max(0, number(market?.relistWorthThreshold, number(settings.relistWorthThreshold, 0)))
    if (worthThreshold && worth && worth < worthThreshold) return false
    if (!threshold) return false
    const marketRelistKey = this.orderRuntimeKey(order)
    if (now - number(this.lastMarketRelistAt.get(marketRelistKey), 0) < MARKET_RELIST_COOLDOWN_MS) return false
    // A plain outbid marker represents one competing order. Larger configured
    // thresholds must wait for Hypixel's explicit orders/items-ahead count.
    const explicitlyOutbid = /outbid|not (?:the )?top|not best|undercut|better offer/.test(lower)
    if (explicitlyOutbid && threshold <= 1) return true
    const type = String(settings.relistAfterType || 'orderAmount').toLowerCase()
    const ahead = type === 'itemamount'
      ? Number(lower.match(/([\d,]+)\s*items?\s+ahead/)?.[1]?.replaceAll(',', ''))
      : Number(lower.match(/([\d,]+)\s*orders?\s+ahead/)?.[1]?.replaceAll(',', ''))
    if (Number.isFinite(ahead) && ahead >= threshold) return true
    if (!price || !market) return false
    const priceMoved = order.type === 'buy'
      ? price + 0.1 <= number(market.buyOffer)
      : price - 0.1 >= number(market.sellOffer)
    return threshold <= 1 && priceMoved
  }
  shouldRelistOrder(order) {
    return this.relistAssessment(order).eligible
  }
  reportRelistAudit(orders, assessments, now = Date.now()) {
    if (!orders.length) return
    const ranked = [...orders]
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'sell' ? -1 : 1
        return this.compareRelistNeed(a, b, now)
      })
      .slice(0, 4)
      .map(order => {
        const assessment = assessments.get(order) || this.relistAssessment(order, now)
        const side = order.type === 'sell' ? 'SELL' : 'BUY'
        return `${side} ${order.itemName}: ${assessment.reason}`
      })
    const signature = ranked.join(' | ')
    const changed = signature !== this.lastRelistAuditSignature
    const interval = changed ? 60 * 1000 : 5 * 60 * 1000
    if (now - this.lastRelistAuditAt < interval) return
    this.lastRelistAuditAt = now
    this.lastRelistAuditSignature = signature
    this.activity('info', `[Relist Check] No order currently requires repositioning. ${signature}`, null)
  }
  beginBuy(candidate, recovery = false) {
    if (!candidate) return false
    const recoveryAttempts = recovery ? number(candidate._buyRecoveryAttempts) + 1 : 0
    if (recoveryAttempts >= 3) {
      return this.skipFailedBuyTarget(candidate, 'The buy workflow did not complete after three bounded attempts.')
    }
    const searchRequestId = ++this.searchRequestId
    const target = { ...candidate, itemName: candidate.displayName || candidate.itemName || candidate.itemId, _buyRecoveryAttempts: recoveryAttempts, _searchPending: true, _searchRequestId: searchRequestId, _searchSentAt: 0 }
    this.buyReservations.set(itemKey(target.itemName), Date.now() + 3 * 60 * 1000)
    this.manageRefreshSlot = null
    this.clearConfirmationRetry()
    this.buySearchRetries = 0
    this.chatSubmissionAcknowledged = ''
    const accountSeed = String(this.bot.state.activeAccountId || this.bot.state.username || 'default')
    this.recentBuySelections.set(`${accountSeed}:${target.itemName.toLowerCase()}`, Date.now())
    this.setPhase('opening-buy', 'PLACING BUY ORDER', target)
    const orderValue = number(target.projectedOrderValue, number(target.buyOffer) * number(target.quantity))
    this.activity('action', `Selected ${target.itemName}: ${Math.round(target.quantity)} items targeting ${Math.round(orderValue).toLocaleString('en-US')} coins, projected ${Math.round(target.projectedProfit || 0).toLocaleString('en-US')} coins profit.`)
    this.bot.openItemByName(target.itemName)
      .then(sent => {
        if (this.state.phase !== 'opening-buy' || this.state.target?._searchRequestId !== searchRequestId) return
        this.state.target._searchPending = false
        this.state.target._searchSentAt = sent === false ? 0 : Date.now()
        if (sent !== false) {
          this.phaseStartedAt = Date.now()
          this.activity('action', `Bazaar search sent for ${target.itemName}; waiting for the search result.`)
        }
      })
      .catch(error => this.fail(error))
  }
  deferSell(target, reason, retry = true) {
    const key = itemKey(target?.itemName || target?.displayName)
    if (key) {
      if (retry) {
        this.pendingSells.set(key, {
          ...target,
          _sellRecoveryAttempts: 0,
          _account: this.accountKey(),
          inFlight: false,
          retryAfter: Date.now() + 5 * 60 * 1000
        })
      } else {
        // Two GUI snapshots are enough to stop an immediate retry loop, but
        // not strong enough evidence to erase persistent cost basis. Preserve
        // accounting and suppress tracker recovery for a bounded interval.
        this.missingInventorySuppressions.set(
          this.orderTimestampKey('sell', target?.itemName || target?.displayName),
          Date.now() + 30 * 60 * 1000
        )
        this.pendingSells.delete(key)
        // A tracker-restored task has no fresh Claim event behind it. After
        // two authoritative Bazaar inventory observations both say that the
        // item is absent, keeping its physical loose quantity makes the same
        // ghost task return every 30 minutes forever. Retire only that loose
        // queue; preserve inventory cost basis so a later real sell/claim can
        // still be accounted for correctly.
        if (target?._restored) {
          const account = this.accountLimitTracker()
          const loose = account.looseInventory?.[key]
          const retired = Math.min(Math.max(0, Math.floor(number(target.quantity))), Math.max(0, Math.floor(number(loose?.quantity))))
          if (retired > 0) {
            this.adjustLooseInventory(target.itemName || target.displayName, -retired)
            this.activity('warning', `Retired ${retired}x ${target.itemName || target.displayName} from the stale physical-inventory queue after two empty Bazaar inventory checks; profit cost basis was preserved.`, target)
          }
        }
      }
    }
    this.activity('warning', `${reason} ${retry ? 'It will be retried later while other orders continue.' : 'The task was paused for 30 minutes without deleting its persistent cost basis.'}`, target)
    this.finishCycle()
    this.nextSyncAt = Date.now() + 1000
  }
  beginSell(target, recovery = false) {
    if (!target?.itemName && !target?.displayName) return this.recover('Claimed item name was not recognized.')
    this.manageRefreshSlot = null
    const recoveryAttempts = recovery ? number(target._sellRecoveryAttempts) + 1 : 0
    if (recoveryAttempts >= 3) {
      return this.deferSell(target, `Sell setup for ${target.itemName || target.displayName} failed three complete workflows.`)
    }
    const normalized = { ...target, itemName: target.itemName || target.displayName, _sellRecoveryAttempts: recoveryAttempts, retryAfter: 0 }
    this.clearConfirmationRetry()
    this.sellPanelRetries = 0
    this.sellSearchRetries = 0
    this.chatSubmissionAcknowledged = ''
    this.setPhase('opening-sell', 'PLACING SELL OFFER', normalized)
    const screen = this.bot.windowSnapshot?.()
    const screenTitle = this.bot.cleanText(screen?.title || '').toLowerCase()
    const targetName = normalized.itemName.toLowerCase()
    const exactVisible = this.containerSlots(screen).some(slot => this.slotName(slot).toLowerCase() === targetName)
    const createVisible = this.bot.findSlot(screen || { slots: [] }, 'create sell offer')
    if (createVisible && (screenTitle.replaceAll('"', '').includes(targetName) || exactVisible)) {
      this.activity('action', `${normalized.itemName} is already open in Bazaar; selecting Create Sell Offer directly.`)
      return this.click(createVisible.slot, `Selected Create Sell Offer for ${normalized.itemName}.`, 'sell-price')
    }
    const visible = this.visibleBazaarItem(screen, normalized.itemName)
    if (visible) {
      this.activity('action', `${normalized.itemName} is already visible in Bazaar; opening it directly.`)
      return this.click(visible.slot, `Opened visible ${normalized.itemName} without another Bazaar search.`, 'sell-product')
    }
    const goBack = /(?:manage orders|bazaar orders)/i.test(this.bot.cleanText(screen?.title || ''))
      ? this.bot.findSlot(screen, 'go back')
      : null
    if (goBack) {
      this.setPhase('sell-bazaar-return', 'PLACING SELL OFFER', normalized)
      return this.click(goBack.slot, `Returning to the open Bazaar to locate ${normalized.itemName}.`, 'sell-bazaar-return')
    }
    this.openSellByCommand(normalized)
  }
  visibleBazaarItem(screen, itemName) {
    if (!screen || !/bazaar/i.test(this.bot.cleanText(screen.title || '')) || /orders?/i.test(this.bot.cleanText(screen.title || ''))) return null
    const target = itemKey(itemName)
    return this.containerSlots(screen).find(slot => itemKey(this.slotName(slot)) === target) || null
  }
  containerSlotLimit(screen) {
    const slotNumbers = (screen?.slots || []).map(slot => Number(slot.slot)).filter(Number.isFinite)
    if (!slotNumbers.length) return 0
    const maxSlot = Math.max(...slotNumbers)
    // Every live Bazaar inventory includes the player's 36 slots at the end,
    // but the container height varies (36, 45 or 54 slots).  A fixed <54
    // boundary therefore mistakes hotbar/inventory items for Bazaar results on
    // smaller pages such as Oddities -> Events and Confirm Sell Offer.
    return maxSlot >= PLAYER_INVENTORY_SLOT_COUNT
      ? Math.max(0, maxSlot - PLAYER_INVENTORY_SLOT_COUNT + 1)
      : maxSlot + 1
  }
  containerSlots(screen) {
    const limit = this.containerSlotLimit(screen)
    return (screen?.slots || []).filter(slot => Number(slot.slot) >= 0 && Number(slot.slot) < limit)
  }
  openSellByCommand(target) {
    const searchRequestId = ++this.searchRequestId
    const searchTarget = { ...target, _searchPending: true, _searchRequestId: searchRequestId, _searchSentAt: 0 }
    this.setPhase('opening-sell', 'PLACING SELL OFFER', searchTarget)
    this.activity('action', `Opening ${searchTarget.itemName} to place a sell offer.`)
    this.bot.openItemByName(searchTarget.itemName)
      .then(sent => {
        if (this.state.phase !== 'opening-sell' || this.state.target?._searchRequestId !== searchRequestId) return
        this.state.target._searchPending = false
        this.state.target._searchSentAt = sent === false ? 0 : Date.now()
        if (sent !== false) {
          this.phaseStartedAt = Date.now()
          this.activity('action', `Bazaar search sent for ${searchTarget.itemName}; waiting for the search result.`)
        }
      })
      .catch(error => this.fail(error))
  }
  slotName(slot) { return this.bot.cleanText(slot.name || '') }
  slotText(slot) { return this.bot.cleanText([slot.name || '', ...(slot.lore || [])].join(' ')) }
  findNamed(screen, patterns, excluded = []) {
    return (screen.slots || []).find(slot => {
      const text = this.slotText(slot).toLowerCase()
      return patterns.some(pattern => pattern.test(text)) && !excluded.some(pattern => pattern.test(text))
    })
  }
  findConfirmationControl(screen, kind) {
    const title = this.bot.cleanText(screen?.title || '').toLowerCase()
    const exactTitle = kind === 'buy' ? /confirm buy order/.test(title) : /confirm sell offer/.test(title)
    if (exactTitle) {
      const exactName = kind === 'buy' ? /^buy order$/i : /^sell offer$/i
      const direct = (screen.slots || []).find(slot => exactName.test(this.slotName(slot).trim()))
      if (direct) return direct
    }
    return this.findNamed(screen,
      kind === 'buy'
        ? [/buy order[\s\S]*click to (?:submit|confirm)/, /click to submit order/, /click to confirm/, /confirm buy order/, /submit buy order/]
        : [/sell offer[\s\S]*click to (?:submit|confirm)/, /click to submit (?:order|offer)/, /click to confirm/, /confirm sell offer/, /submit sell offer/],
      kind === 'buy'
        ? [/cancel/, /create/, /top order/, /same as/, /highest buy/, /go back/]
        : [/cancel/, /create/, /best offer/, /same as/, /lowest sell/, /sell instantly/, /go back/])
  }
  findCancelControl(screen) {
    return this.findNamed(screen,
      [/^cancel (?:buy )?order\b/, /^cancel (?:sell )?offer\b/, /click to cancel (?:the )?(?:buy |sell )?(?:order|offer)/],
      [/cancelled/, /cancel confirmation/])
  }
  findPreferredNamed(screen, patterns, excluded = []) {
    // Pattern order is the priority order. Do not let the GUI's numeric slot
    // order choose a slower equal-price option ahead of an available top-queue
    // price improvement.
    for (const pattern of patterns) {
      const found = (screen.slots || []).find(slot => {
        const text = this.slotText(slot).toLowerCase()
        return pattern.test(text) && !excluded.some(blocked => blocked.test(text))
      })
      if (found) return found
    }
    return null
  }
  chooseAmount(screen, quantity) {
    const choices = (screen.slots || []).flatMap(slot => {
      const text = this.slotText(slot)
      if (/custom|inventory|back|cancel|price|create (?:buy|sell)|confirm/i.test(text)) return []
      const match = text.match(/(?:amount\s*:\s*|^|\s)([\d,]+)\s*x(?:\s|$)/i)
      const stack = /buy a stack|sell a stack/i.test(text) ? 64 : 0
      const one = /(?:only one|buy one|sell one)/i.test(text) ? 1 : 0
      const amount = match ? Number(match[1].replaceAll(',', '')) : stack || one
      return amount > 0 ? [{ slot, amount }] : []
    }).sort((a, b) => b.amount - a.amount)
    return choices.find(choice => choice.amount <= Math.max(1, quantity)) || null
  }
  advanceSetup(kind, screen) {
    const phase = this.state.phase
    const title = this.bot.cleanText(screen.title || '').toLowerCase()
    const targetName = String(this.state.target?.itemName || this.state.target?.displayName || '').toLowerCase()
    const titleHasTarget = targetName && title.replaceAll('"', '').includes(targetName)
    const containerSlots = this.containerSlots(screen)
    const exactTargetVisible = Boolean(targetName && containerSlots.some(slot => this.slotName(slot).toLowerCase() === targetName))
    const productMatchesTarget = Boolean(titleHasTarget || exactTargetVisible)
    const directConfirmation = this.findConfirmationControl(screen, kind)
    if ([`${kind}-price`, `${kind}-confirm`].includes(phase)
      && directConfirmation
      && new RegExp(`confirm ${kind === 'buy' ? 'buy order' : 'sell offer'}`, 'i').test(title)) {
      return this.click(directConfirmation.slot, `Confirming ${kind === 'buy' ? 'buy order' : 'sell offer'} for ${this.state.target.itemName}.`, `awaiting-${kind}-confirmation`)
    }
    const searchResult = containerSlots.find(slot => {
      const name = this.slotName(slot).toLowerCase()
      const lore = (slot.lore || []).map(line => this.bot.cleanText(line)).join(' ').toLowerCase()
      // Some servers omit the final "Click to view details" lore line from
      // Azalea's first inventory packet.  The quoted /bz search title plus an
      // exact item-name match is equally unambiguous.
      return name === targetName && (/click to view details|click to view|view details/.test(lore) || productMatchesTarget)
    })
    if (phase === `opening-${kind}` && searchResult) {
      if (kind === 'buy') this.failedBuyTargets.delete(itemKey(targetName))
      return this.click(searchResult.slot, `Opened the exact ${this.state.target.itemName} search result.`, `${kind}-product`)
    }
    // The current Bazaar/category inventory continues emitting while the
    // human-like /bz typing delay is still pending. It is not the result of
    // the new search and must never consume retries or defer a sell task.
    if (phase === `opening-${kind}` && this.state.target?._searchPending) return
    const searchSentAt = number(this.state.target?._searchSentAt)
    if (phase === `opening-${kind}` && searchSentAt > 0 && Date.now() - searchSentAt < 3000) return

    const create = this.bot.findSlot(screen, kind === 'buy' ? 'create buy order' : 'create sell offer')
    if (kind === 'sell' && productMatchesTarget && ['sell-product', 'sell-price'].includes(phase)) {
      const noInventory = (screen.slots || []).some(slot => {
        const name = this.slotName(slot).toLowerCase()
        if (!/create sell offer|sell instantly/.test(name)) return false
        return /inventory\s*:\s*none|none (?:in|to sell)|nothing to sell|don't have .* to sell/i.test(this.slotText(slot))
      })
      if (noInventory) {
        const key = itemKey(this.state.target.itemName)
        const queued = this.pendingSells.get(key) || this.state.target
        const observations = Math.max(0, number(queued._noInventoryObservations)) + 1
        if (observations < 2) {
          this.pendingSells.set(key, {
            ...queued,
            ...this.state.target,
            _account: this.accountKey(),
            _noInventoryObservations: observations,
            inFlight: false,
            retryAfter: Date.now() + 5000
          })
          this.activity('warning', `${this.state.target.itemName} was absent from one Bazaar inventory snapshot. Keeping the persistent sell queue until a second independent workflow confirms it.`, this.state.target)
          this.finishCycle()
          this.nextSyncAt = Date.now() + 1000
          return
        }
        return this.deferSell(this.state.target, `${this.state.target.itemName} was absent from two independent Bazaar inventory checks.`, false)
      }
    }
    if ((phase === `opening-${kind}` || phase === `${kind}-product`) && create && !/how many|how much|at what price|confirm/.test(title)) {
      if (kind === 'sell') this.sellSearchRetries = 0
      else this.buySearchRetries = 0
      return this.click(create.slot, `Selected Create ${kind === 'buy' ? 'Buy Order' : 'Sell Offer'} for ${this.state.target.itemName}.`, kind === 'buy' ? 'buy-amount' : 'sell-price')
    }
    // A click on the exact /bz search result can occasionally be ignored.
    // Retry that already-visible item locally before paying the full command
    // typing delay again.
    if (kind === 'sell' && phase === 'sell-product' && productMatchesTarget && searchResult && !create) {
      if (this.sellSearchRetries >= 2) {
        this.activity('warning', `The ${this.state.target.itemName} product page did not open after three local clicks; reopening the sell workflow now.`)
        return this.beginSell(this.state.target, true)
      }
      this.sellSearchRetries += 1
      return this.click(searchResult.slot, `The ${this.state.target.itemName} product page did not open; retrying the exact visible item (${this.sellSearchRetries}/2).`, 'sell-product')
    }
    if (kind === 'buy' && phase === 'buy-product' && productMatchesTarget && searchResult && !create) {
      if (this.buySearchRetries >= 2) {
        const target = this.state.target
        this.activity('warning', `The ${target.itemName} product controls did not load after three local clicks; reopening the buy search now.`)
        return this.beginBuy(target, true)
      }
      this.buySearchRetries += 1
      return this.click(searchResult.slot, `The ${this.state.target.itemName} product controls are not ready; retrying the exact visible item (${this.buySearchRetries}/2).`, 'buy-product')
    }

    if (kind === 'buy' && phase === 'buy-amount' && /how many|amount/.test(title)) {
      const requested = Math.max(1, Math.floor(number(this.state.target?.quantity, 1)))
      const amount = this.chooseAmount(screen, requested)
      // A preset is safe only when it is the exact planned quantity. Even a
      // superficially close stack button can leave a material part of
      // MaxSpend unused (for example 64 instead of a planned 67).
      if (amount && amount.amount === requested) {
        this.state.target.executionQuantity = amount.amount
        return this.click(amount.slot.slot, `Selected preset amount ${amount.amount} for ${this.state.target.itemName}.`, 'buy-price')
      }
      const custom = this.findNamed(screen, [/custom amount/], [/cancel/])
      if (custom) {
        this.state.target.executionQuantity = requested
        const clickTask = this.click(custom.slot, `Opening custom amount input for ${requested}x ${this.state.target.itemName}.`, 'buy-price')
        const generation = clickTask.generation
        setTimeout(() => {
          if (!this.running() || generation !== this.actionGeneration || this.state.phase !== 'buy-price') return
          try { this.bot.submitSign(String(requested)); this.activity('action', `Entered custom amount ${requested} for ${this.state.target.itemName}.`) } catch (error) { this.fail(error) }
        }, Math.max(400, clickTask.delay + 350))
        return
      }
      if (amount) {
        this.state.target.executionQuantity = amount.amount
        return this.click(amount.slot.slot, `Custom Amount was unavailable; selected preset amount ${amount.amount} for ${this.state.target.itemName}.`, 'buy-price')
      }
    }

    const priceTitle = kind === 'buy' ? /how much|price/.test(title) : /at what price|price/.test(title)
    const pricePatterns = kind === 'buy'
      ? [/top order\s*\+\s*0\.1/, /same as top order/, /highest buy/]
      : [/best offer\s*-\s*0\.1/, /same as best offer/, /lowest sell/]
    const visiblePriceOption = this.findPreferredNamed(screen, pricePatterns, [/create/, /cancel/])
    if (phase === `${kind}-price` && (priceTitle || visiblePriceOption)) {
      if (kind === 'sell') this.sellPanelRetries = 0
      const priceOption = visiblePriceOption
      if (kind === 'buy' && priceOption) {
        const total = coinValue(this.slotText(priceOption).match(/total(?: price)?\s*:\s*([\d,.]+\s*[KMGBT]?)/i)?.[1])
        const maxSpend = Math.max(1, number(this.readSettings().config.purse?.maxSpentPerOrder, 10000000))
        const allowedOverage = Math.min(500000, Math.max(100000, maxSpend * 0.01))
        const hardMaxSpend = maxSpend + allowedOverage
        const current = Math.max(1, Math.floor(number(this.state.target?.executionQuantity || this.state.target?.quantity, 1)))
        if (total > hardMaxSpend + 0.01) {
          const reduced = Math.max(1, Math.min(current - 1, Math.floor(current * hardMaxSpend / total)))
          const goBack = this.bot.findSlot(screen, 'go back')
          if (current <= 1 || reduced >= current) return this.skipFailedBuyTarget(this.state.target, `One unit exceeds MaxSpend ${Math.round(maxSpend).toLocaleString('en-US')} coins.`)
          if (goBack) {
            this.state.target.quantity = reduced
            this.state.target.executionQuantity = reduced
            return this.click(goBack.slot, `Actual GUI total ${Math.round(total).toLocaleString('en-US')} exceeds allowed target ${Math.round(hardMaxSpend).toLocaleString('en-US')}; retrying with ${reduced}x.`, 'buy-amount')
          }
        }
      }
      const price = this.findPreferredNamed(screen, pricePatterns, [/create/, /cancel/, /can't afford/])
      if (price) return this.click(price.slot, `Selected competitive ${kind === 'buy' ? 'buy' : 'sell'} price.`, `${kind}-confirm`)
      if (kind === 'buy') {
        const priceOptions = (screen.slots || []).filter(slot => /same as top order|top order\s*\+\s*0\.1|5% of spread/i.test(this.slotText(slot)))
        if (priceOptions.length && priceOptions.every(slot => /can't afford/i.test(this.slotText(slot)))) {
          return this.waitForExistingOrders(this.state.target)
        }
      }
    }

    if (phase === `${kind}-confirm`) {
      const confirm = this.findConfirmationControl(screen, kind)
      if (confirm && (/confirm|submit/.test(title) || /confirm|submit|click to confirm/.test(this.slotText(confirm).toLowerCase()))) {
        return this.click(confirm.slot, `Confirming ${kind === 'buy' ? 'buy order' : 'sell offer'} for ${this.state.target.itemName}.`, `awaiting-${kind}-confirmation`)
      }
    }
    // Hypixel can occasionally return the item overview after selecting a
    // sell price instead of immediately sending its confirmation inventory.
    // That is a recoverable transition, not an unknown GUI: re-open the sell
    // offer panel directly and continue from the price step without restarting
    // the whole /bz search or emitting a misleading warning.
    if (kind === 'sell' && phase === 'sell-confirm' && productMatchesTarget) {
      if (create) return this.click(create.slot, `Sell confirmation was delayed; reopening Create Sell Offer for ${this.state.target.itemName}.`, 'sell-price')
      if (searchResult) return this.click(searchResult.slot, `Sell confirmation returned to ${this.state.target.itemName}; reopening the exact visible item.`, 'sell-product')
    }
    // Hypixel may acknowledge the Create Sell Offer click while leaving the
    // product overview open. Retry the already-visible control locally instead
    // of waiting for the action timeout and retyping the full /bz command.
    // Inventory slot deltas can briefly replace that control with the item
    // icon, which is a normal transition frame and should not emit a warning.
    if (kind === 'sell' && phase === 'sell-price' && productMatchesTarget) {
      if (!create && searchResult) return
      if (create) {
        if (this.sellPanelRetries >= 3) {
          this.activity('warning', `Create Sell Offer for ${this.state.target.itemName} did not open after four clicks; reopening the sell workflow now.`)
          return this.beginSell(this.state.target, true)
        }
        this.sellPanelRetries += 1
        return this.click(create.slot, `Create Sell Offer did not open; retrying locally for ${this.state.target.itemName} (${this.sellPanelRetries}/3).`, 'sell-price')
      }
    }
    // The custom-amount/sign transition can occasionally return a buy setup
    // to the exact /bz item overview instead of the final confirmation GUI.
    // Re-enter through the already-visible exact item instead of waiting for a
    // timeout and paying the full command typing delay again.
    if (kind === 'buy' && phase === 'buy-confirm' && titleHasTarget) {
      if (create) return this.click(create.slot, `Buy confirmation was delayed; reopening Create Buy Order for ${this.state.target.itemName}.`, 'buy-amount')
      if (searchResult) return this.click(searchResult.slot, `Buy confirmation returned to ${this.state.target.itemName}; reopening the exact visible item.`, 'buy-product')
    }
    // After Create Buy Order is clicked, Azalea can deliver one delayed frame
    // from the product overview (sometimes already showing Create Sell Offer).
    // The amount GUI follows immediately; this is not a failed buy workflow.
    if (kind === 'buy' && phase === 'buy-amount' && productMatchesTarget && !/how many|amount/.test(title)) return
    // Azalea can emit one final inventory delta from the previous GUI after a
    // click. These are recognized transition frames, not workflow failures.
    if ((phase === `${kind}-price` && (kind === 'buy' ? /how many|amount/.test(title) : /feast|bazaar/.test(title)))
      || (phase === `${kind}-confirm` && priceTitle)
      || (phase === `${kind}-product` && /bazaar/.test(title))
      || (phase === `opening-${kind}` && (/bazaar orders/.test(title) || (titleHasTarget && !create)))) return
    if (kind === 'sell' && phase === 'opening-sell' && this.bot.findSlot(screen, 'manage orders')) {
      if (this.sellSearchRetries >= 2) return this.deferSell(this.state.target, `Bazaar kept returning a category page instead of ${this.state.target.itemName}.`)
      this.sellSearchRetries += 1
      this.activity('warning', `Bazaar returned a category page instead of ${this.state.target.itemName}; retrying the exact item search (${this.sellSearchRetries}/2).`, this.state.target)
      return this.openSellByCommand(this.state.target)
    }
    const signature = this.signature(screen)
    if (kind === 'buy' && priceTitle && !(screen.slots || []).some(slot => this.slotName(slot))) {
      // Hypixel can send the price inventory title before its slot contents.
      // The next inventory update contains the competitive-price button, so
      // this empty transition frame is valid and needs no recovery warning.
      return
    }
    if (signature !== this.lastDiagnosticSignature) {
      this.lastDiagnosticSignature = signature
      const visible = (screen.slots || []).filter(slot => this.slotName(slot)).slice(0, 20).map(slot => `${slot.slot}:${this.slotName(slot)}`).join(' | ')
      this.log('warning', `[Auto Trader] Unrecognized ${kind} GUI "${this.bot.cleanText(screen.title)}". Visible slots: ${visible || 'none'}`)
    }
  }
  onChat(message) {
    const text = this.bot.cleanText(message)
    let match
    const stashNow = Date.now()
    const stashCountMatch = text.match(/you have\s+([\d,]+)\s+items?\s+stashed away/i)
    const reportedStashCount = stashCountMatch ? Math.max(0, Number(stashCountMatch[1].replaceAll(',', ''))) : null
    const stashCleared = reportedStashCount === 0
      || /(?:you picked up all items from (?:your )?item stash|(?:your )?(?:item )?stash (?:is|was)(?: already)? empty|(?:your )?(?:item )?stash has been (?:emptied|cleared)|(?:do not|don't) have (?:any items?|anything) in (?:your )?(?:item )?stash)/i.test(text)
    if (stashCleared) {
      const wasBlocked = this.stashBlocked
      this.stashBlocked = false
      this.stashItemCount = 0
      this.stashCountConfirmed = false
      this.stashRefundPendingUntil = 0
      this.inventoryCapacitySnapshot = null
      if (wasBlocked) this.activity('success', 'Hypixel confirmed the Item Stash is clear; the warning was removed.', null)
      return
    }
    const addedToStash = /(?:didn['’]?t fit|did not fit).*added to (?:your )?item stash/i.test(text)
    if (stashCountMatch || addedToStash) {
      const previousCount = this.stashItemCount
      const wasBlocked = this.stashBlocked
      this.stashBlocked = true
      if (stashCountMatch) {
        this.stashItemCount = reportedStashCount
        this.stashCountConfirmed = true
        if (!wasBlocked || previousCount !== this.stashItemCount) this.inventoryCapacitySnapshot = null
      } else {
        // The overflow message does not report the total number of distinct
        // Item Stash entries, so retain an unknown count in the warning.
        this.stashItemCount = Math.max(1, previousCount)
        this.stashCountConfirmed = false
        this.inventoryCapacitySnapshot = null
      }
      if (addedToStash) this.stashRefundPendingUntil = stashNow + 30000
      if (this.sellConsolidation) this.abortSellConsolidation('Hypixel reported an item-stash overflow during Sell Offer maintenance.')
      if (!wasBlocked || !stashCountMatch || previousCount !== this.stashItemCount) {
        this.activity('warning', `Hypixel Item Stash detected${this.stashCountConfirmed ? ` (${this.stashItemCount} item${this.stashItemCount === 1 ? '' : 's'})` : ' (exact count not confirmed)'}. Clear it manually with /pickupstash item; trading continues normally.`, null)
      }
      return
    }
    let trackedProfit = null
    const placedBuy = text.match(/Buy Order Setup!\s*([\d,]+)x\s+(.+?)\s+for\s+([\d,]+(?:\.\d+)?)\s+coins/i)
    const placedSell = text.match(/Sell Offer Setup!\s*([\d,]+)x\s+(.+?)\s+for\s+([\d,]+(?:\.\d+)?)\s+coins/i)
    const claimedItems = text.match(/Claimed\s+([\d,]+)x\s+(.+?)\s+worth\s+([\d,]+(?:\.\d+)?)\s+coins/i)
    const claimMessageKey = claimedItems ? `${this.accountKey()}:${itemKey(text)}` : ''
    const previousClaimMessageAt = claimMessageKey ? number(this.recentClaimMessages.get(claimMessageKey)) : 0
    const duplicateClaimMessage = Boolean(claimMessageKey && Date.now() - previousClaimMessageAt < 5000)
    if (claimMessageKey && !duplicateClaimMessage) {
      this.recentClaimMessages.set(claimMessageKey, Date.now())
      for (const [key, at] of this.recentClaimMessages) if (Date.now() - at >= 30000) this.recentClaimMessages.delete(key)
    }
    const claimedSale = this.parseCompletedSale(text)
    const instantSale = text.match(/\[Bazaar\]\s+Sold\s+([\d,]+)x\s+(.+?)\s+for\s+([\d,.]+\s*[KMGBT]?)\s+coins[!.]?$/i)
    const filledOrderMessage = /\[Bazaar\]\s+Your (?:Buy Order|Sell Offer) for\s+[\d,]+x\s+.+?\s+was filled!/i.test(text)
    const confirmedBazaarAction = Boolean(placedBuy || placedSell || claimedItems || claimedSale || instantSale || /Cancelled! Refunded/i.test(text) || /\[Bazaar\]\s+Your (?:Buy Order|Sell Offer) for\s+[\d,]+x\s+.+?\s+was filled!/i.test(text))
    const queuedPlacedSell = placedSell ? this.pendingSells.get(itemKey(placedSell[2])) : null
    const productiveBazaarAction = Boolean(
      claimedItems || claimedSale || instantSale || filledOrderMessage
      || (placedBuy && !this.state.target?.relistReason)
      || (placedSell && queuedPlacedSell && !queuedPlacedSell._restored && !this.state.target?.relistReason)
    )
    if (confirmedBazaarAction) this.noteConfirmedBazaarAction(productiveBazaarAction)
    if (placedBuy) this.trackOffer('buy', placedBuy[3])
    if (placedSell) { this.trackOffer('sell', placedSell[3]); this.trackSellPlan(placedSell[2], Number(placedSell[1].replaceAll(',', '')), placedSell[3]) }
    if (claimedItems && !duplicateClaimMessage) this.addAcquisition(claimedItems[2].trim(), Number(claimedItems[1].replaceAll(',', '')), claimedItems[3])
    if (claimedSale) {
      trackedProfit = this.realizeSale(claimedSale.itemName, claimedSale.revenue, claimedSale.quantity)
      const saleTarget = this.state.phase === 'awaiting-claim-sell'
        && itemKey(this.state.target?.itemName) === itemKey(claimedSale.itemName) ? this.state.target : null
      if (saleTarget) {
        const sellProgressKey = this.orderRuntimeKey(saleTarget, 'sell', claimedSale.itemName)
        const previousProgress = this.orderFillProgress.get(sellProgressKey)
        this.orderFillProgress.set(sellProgressKey, {
          count: number(previousProgress?.count) + Math.max(0, number(claimedSale.quantity)),
          at: Date.now()
        })
      }
      this.consumeSellOfferReservation(claimedSale.itemName, claimedSale.quantity)
      if (trackedProfit !== null) {
        const account = this.accountLimitTracker()
        account.chatProfitReconciledThrough = new Date().toISOString()
        this.saveTracker()
      }
    } else if (instantSale) {
      trackedProfit = this.realizeSale(instantSale[2].trim(), instantSale[3], Number(instantSale[1].replaceAll(',', '')))
    }
    if (!this.state.enabled) { this.update({ tracker: this.trackerSnapshot() }); return }
    if (/reached your maximum of\s+14\s+bazaar orders|maximum of\s+14\s+bazaar orders/i.test(text)) {
      const target = this.state.target ? { ...this.state.target } : null
      this.serverOrderCapUntil = Date.now() + 2 * 60 * 1000
      if (/sell/.test(this.state.phase) && target) {
        const key = itemKey(target.itemName || target.displayName)
        const queued = this.pendingSells.get(key)
        if (queued) this.pendingSells.set(key, { ...queued, inFlight: false, retryAfter: Date.now() + 5000 })
      }
      if (/buy/.test(this.state.phase) && target) this.buyReservations.delete(itemKey(target.itemName || target.displayName))
      this.clearConfirmationRetry()
      this.setPhase('idle', 'SERVER ORDER CAP REACHED', null)
      this.nextSyncAt = Date.now() + 1000
      this.activity('warning', 'Hypixel reports all 14 Bazaar slots are occupied. New placements are paused until a confirmed cancellation/claim and a fresh Manage Orders snapshot free a slot.', target)
      return
    }
    if (/(?:do not|don't) have the space required to claim/i.test(text) && this.state.phase === 'awaiting-claim-buy') {
      const target = this.state.target ? { ...this.state.target } : null
      if (!this.inventoryClaimRecoveryPending && typeof this.bot.recoverClaimInventory === 'function') {
        this.inventoryClaimRecoveryPending = true
        this.clearConfirmationRetry()
        this.manualControlUntil = Date.now() + 60000
        this.setPhase('idle', 'FREEING INVENTORY FOR CLAIM', null)
        this.activity('warning', `Inventory is full while claiming ${target?.itemName || 'a completed buy order'}. Selling existing Bazaar inventory once, then retrying the claim.`, target)
        try {
          const started = this.bot.recoverClaimInventory(target)
          if (started === false) throw new Error('another Bazaar action is already running')
        } catch (error) {
          this.inventoryClaimRecoveryPending = false
          this.manualControlUntil = 0
          this.nextSyncAt = Date.now() + 5000
          this.activity('error', `Automatic inventory recovery could not start: ${error.message || error}`, target)
        }
      }
      return
    }
    // Manual cancellation/claim workflows own the Bazaar GUI.  Keep passive
    // profit/limit tracking above, but never relist or open another item until
    // the controller hands control back.
    if (Date.now() < this.manualControlUntil) { this.update({ tracker: this.trackerSnapshot() }); return }
    if (/you haven['’]?t analyzed this mutation/i.test(text) && /buy/.test(this.state.phase) && this.state.target) {
      return this.skipFailedBuyTarget(this.state.target, 'This account has not analyzed the required mutation.', MUTATION_BLOCK_MS, true)
    }
    if (/booster\s*cookie/i.test(text) && /\[Bazaar\]/i.test(text) && /(?:bought|purchase(?:d)?)/i.test(text)) {
      this.cookiePurchaseAttempts = 0
      this.cookieConsumptionAttempts = 0
      this.cookieBeforePurchaseSeconds = this.currentCookieRemainingSeconds()
      this.cookiePurchaseCooldownUntil = Date.now() + 15 * 60 * 1000
      this.activity('success', 'Booster Cookie purchased from the Bazaar; preparing it for immediate consumption.', null)
      return setTimeout(() => this.preparePurchasedCookie(), 700)
    }
    if (/^cookie-/.test(this.state.phase) && /(?:not enough coins|cannot afford|can't afford|purchase failed|inventory.*full)/i.test(text)) {
      return this.failCookiePurchase(text)
    }
    const submitting = text.match(/\[Bazaar\]\s+Submitting\s+(buy order|sell offer)/i)
    const escrow = /\[Bazaar\]\s+Putting goods in escrow/i.test(text)
    const phaseKind = /sell/.test(this.state.phase) ? 'sell' : /buy/.test(this.state.phase) ? 'buy' : ''
    const submissionKind = submitting ? (submitting[1].toLowerCase().startsWith('buy') ? 'buy' : 'sell') : (escrow ? phaseKind : '')
    if (submissionKind && phaseKind === submissionKind && /(?:buy|sell)-(?:confirm|confirmation)/.test(this.state.phase)) {
      this.confirmationRetries = 0
      this.clearConfirmationRetry()
      const firstAcknowledgement = this.chatSubmissionAcknowledged !== submissionKind
      this.chatSubmissionAcknowledged = submissionKind
      this.setPhase(`awaiting-${submissionKind}-confirmation`, this.state.status)
      const acknowledgement = `Bazaar chat acknowledged the ${submissionKind === 'buy' ? 'buy order' : 'sell offer'} submission; waiting for the final Setup confirmation.`
      if (firstAcknowledgement) this.activity('info', acknowledgement)
      else this.update({ lastAction: acknowledgement, lastActionAt: new Date().toISOString() })
      return
    }
    if ((match = text.match(/\[Bazaar\]\s+Your Buy Order for\s+([\d,]+)x\s+(.+?)\s+was filled!/i))) {
      this.rememberPendingFilled('buy', match[2], Number(match[1].replaceAll(',', '')))
      this.nextSyncAt = Date.now()
      this.activity('info', `Filled buy order detected for ${match[2]}; refreshing Manage Orders immediately.`, null)
      return
    }
    if ((match = text.match(/\[Bazaar\]\s+Your Sell Offer for\s+([\d,]+)x\s+(.+?)\s+was filled!/i))) {
      this.rememberPendingFilled('sell', match[2], Number(match[1].replaceAll(',', '')))
      this.nextSyncAt = Date.now()
      this.activity('info', `Filled sell offer detected for ${match[2]}; refreshing Manage Orders immediately.`, null)
      return
    }
    if ((match = text.match(/Buy Order Setup!\s*([\d,]+)x\s+(.+?)\s+for\s+([\d,]+(?:\.\d+)?)\s+coins/i))) {
      this.confirmationRetries = 0
      this.clearConfirmationRetry()
      this.chatSubmissionAcknowledged = ''
      this.lastOrderPlacementAt = Date.now()
      this.rememberPlacement('buy', match[2], Number(match[1].replaceAll(',', '')), coinValue(match[3]), this.lastOrderPlacementAt)
      this.buyReservations.set(itemKey(match[2]), Date.now() + 3 * 60 * 1000)
      this.pendingBuyRelists.delete(itemKey(match[2]))
      this.state.counts.buyOrders += 1
      this.activity('success', `Buy order placed: ${match[1]}x ${match[2]} for ${match[3]} coins.`)
      return this.finishCycle()
    }
    if ((match = text.match(/Sell Offer Setup!\s*([\d,]+)x\s+(.+?)\s+for\s+([\d,]+(?:\.\d+)?)\s+coins/i))) {
      this.confirmationRetries = 0
      this.clearConfirmationRetry()
      this.sellPanelRetries = 0
      this.sellSearchRetries = 0
      this.chatSubmissionAcknowledged = ''
      this.lastOrderPlacementAt = Date.now()
      this.rememberPlacement('sell', match[2], Number(match[1].replaceAll(',', '')), coinValue(match[3]), this.lastOrderPlacementAt)
      // The claimed inventory is only considered secured after Hypixel's
      // authoritative Setup acknowledgement, never when FF merely clicks the
      // submit button.
      const sellQueueKey = itemKey(match[2])
      const queuedSell = this.pendingSells.get(sellQueueKey)
      const placedQuantity = Math.max(0, Number(match[1].replaceAll(',', '')))
      this.adjustLooseInventory(match[2], -placedQuantity)
      this.rememberSellOfferReservation(match[2], placedQuantity, this.lastOrderPlacementAt, 'add')
      if (queuedSell && number(queuedSell.quantity) > placedQuantity) {
        // A second claim acknowledgement can arrive while the first Sell
        // Offer workflow is already open. Preserve that extra quantity for a
        // subsequent offer instead of dropping it with the first Setup ack.
        if (queuedSell._restored) {
          // A tracker-restored amount is an estimate of physical inventory.
          // Hypixel's successful Setup acknowledgement is authoritative: if it
          // placed fewer items, the estimate included already-offered/stashed
          // stock. Keeping the numerical remainder creates an infinite loop.
          this.pendingSells.delete(sellQueueKey)
        } else {
          this.pendingSells.set(sellQueueKey, {
            ...queuedSell,
            quantity: number(queuedSell.quantity) - placedQuantity,
            inFlight: false,
            // Give the next Manage snapshot and tracker reconciliation time to
            // observe the confirmed offer before retrying any true remainder.
            retryAfter: Date.now() + 15000
          })
        }
      } else {
        this.pendingSells.delete(sellQueueKey)
      }
      this.state.counts.sellOffers += 1
      const consolidation = this.sellConsolidation
      if (consolidation
        && consolidation.account === this.accountKey()
        && consolidation.itemKey === sellQueueKey
        && consolidation.status === 'reposting'
        && (this.state.target?.sellConsolidationId === consolidation.id
          || Date.now() - number(consolidation.repostStartedAt) < 120000)) {
        this.finishSellConsolidation(`Duplicate ${match[2]} rows were consolidated into one ${placedQuantity.toLocaleString('en-US')}x Sell Offer.`)
      }
      this.activity('success', `Sell offer placed: ${match[1]}x ${match[2]} for ${match[3]} coins.`)
      return this.finishCycle()
    }
    if ((match = text.match(/Claimed\s+([\d,]+)x\s+(.+?)\s+worth\s+([\d,]+(?:\.\d+)?)\s+coins/i))) {
      const itemName = match[2].trim()
      const claimedQuantity = Number(match[1].replaceAll(',', ''))
      const phaseClaim = this.state.phase === 'awaiting-claim-buy' && itemKey(this.state.target?.itemName) === itemKey(itemName)
        ? this.state.target
        : null
      const attempt = phaseClaim
        ? this.buyClaimAttempts.get(this.orderRuntimeKey(phaseClaim, 'buy', itemName))
        : [...this.buyClaimAttempts.values()].find(entry => itemKey(entry?.target?.itemName) === itemKey(itemName))
      const lateClaim = attempt && Date.now() - number(attempt.at) < 120000 ? attempt.target : null
      if (duplicateClaimMessage) {
        this.update({ tracker: this.trackerSnapshot() })
        return
      }
      this.state.counts.claimedItems += 1
      this.serverOrderCapUntil = 0
      // Hypixel's Claim All can emit several authoritative item messages for a
      // single click. Only the first one necessarily matches the current phase;
      // every later message still represents real loose inventory that must be
      // offered for sale. Manual Clear is excluded by manualControlUntil above.
      const liveBuy = (this.bot.state.orders || []).find(order => order.type === 'buy' && itemKey(order.itemName) === itemKey(itemName))
      const claimedFrom = phaseClaim || lateClaim || (liveBuy ? this.targetFromOrder(liveBuy) : {
        itemName,
        displayName: itemName,
        quantity: 0,
        filledQuantity: claimedQuantity,
        claimCompletionUnknown: true
      })
      const claimKey = this.orderRuntimeKey(claimedFrom, 'buy', itemName)
      const target = { ...claimedFrom, quantity: claimedQuantity }
      const claimedBefore = Math.max(0, number(this.claimedBuyFillCounts.get(claimKey)))
      const cumulativeFill = Math.max(number(claimedFrom?.filledQuantity), claimedBefore + claimedQuantity)
      this.claimedBuyFillCounts.set(claimKey, cumulativeFill)
      this.buyClaimAttempts.delete(claimKey)
      this.partialBuyBatches.delete(claimKey)
      this.clearPendingFilled('buy', claimedFrom)
      const remainingQuantity = Math.max(0, Math.floor(number(claimedFrom.quantity)))
      if (!remainingQuantity && !claimedFrom.claimCompletionUnknown) this.removeTrackedOrder('buy', itemName, claimedFrom)
      this.queueSell(target)
      if (remainingQuantity > 0) {
        const decision = this.partialBuyDecision(claimedFrom)
        if (decision.cancel) this.queuePartialBuyCancel(claimedFrom)
        this.activity(decision.cancel ? 'warning' : 'info', `Claimed ${claimedQuantity}x ${itemName}; selling the filled portion. The remaining ${remainingQuantity} ${decision.cancel ? 'will be cancelled after this sell offer because' : 'will remain active because'} ${decision.reason}.`, target)
      } else {
        this.activity('success', `Claimed ${match[1]}x ${itemName}; preparing its sell offer.`, target)
      }
      if (!phaseClaim && !lateClaim && this.state.phase !== 'idle') {
        this.nextSyncAt = Date.now()
        this.update({ tracker: this.trackerSnapshot() })
        return
      }
      this.setPhase('idle', 'PREPARING SELL OFFER', null)
      const generation = this.actionGeneration
      return setTimeout(() => {
        if (generation === this.actionGeneration && this.state.phase === 'idle') this.flushPendingSell()
      }, this.randomDelay())
    }
    if ((match = text.match(/Claimed(?: Amount:)?\s*([\d,.]+\s*[KMGBT]?)\s+coins/i))) {
      const matchingClaimPhase = this.state.phase === 'awaiting-claim-sell'
      const claimedItemName = claimedSale?.itemName || (matchingClaimPhase ? this.state.target?.itemName : '')
      if (claimedItemName) {
        const batch = this.claimAllSellBatch
        const activeClaimAllBatch = batch
          && batch.account === this.accountKey()
          && Date.now() - number(batch.at) < 120000
          ? batch
          : null
        if (activeClaimAllBatch) {
          // Claim All emits one detailed line per card after the first line has
          // already returned the automation to idle. Keep every acknowledgement
          // attached to the exact click-time rows instead of suppressing every
          // live sibling that happens to share the item name.
          for (const card of activeClaimAllBatch.cards) {
            this.clearPendingFilled('sell', card)
            this.suppressClaimedSellCard(card)
          }
          activeClaimAllBatch.confirmedAt = Date.now()
        } else {
          if (batch) this.claimAllSellBatch = null
          const claimedTarget = matchingClaimPhase ? this.state.target : claimedItemName
          this.clearPendingFilled('sell', claimedTarget)
          this.suppressClaimedSellCard(claimedTarget)
        }
      }
      this.waitingForPurse = false
      this.serverOrderCapUntil = 0
      this.state.counts.claimedCoins += 1
      this.activity('success', `Claimed ${match[1]} coins from a completed sell offer${trackedProfit === null ? '.' : `; realized profit ${Math.round(trackedProfit).toLocaleString('en-US')} coins.`}`)
      if (matchingClaimPhase) return this.finishCycle()
      if (this.state.phase === 'idle') this.nextSyncAt = Date.now()
      return
    }
    if (/Cancelled! Refunded/i.test(text)) {
      const authorized = this.pendingCancel?.account === this.accountKey()
        && Date.now() - number(this.pendingCancel.at) < 120000
        ? this.pendingCancel
        : null
      const target = authorized?.target
      const acknowledgedType = /cancelling\s+Sell Offer/i.test(text)
        ? 'sell'
        : /cancelling\s+Buy Order/i.test(text) ? 'buy' : ''
      const targetType = target?.orderType || (this.state.status?.includes('SELL') ? 'sell' : 'buy')
      const refundedMatch = text.match(/Refunded\s+([\d,]+)x\s+(.+?)\s+from cancelling/i)
      const refundedQuantity = refundedMatch ? Number(refundedMatch[1].replaceAll(',', '')) : 0
      const refundedItem = refundedMatch?.[2] || ''
      // A manual cancel, or a delayed acknowledgement from some unrelated GUI,
      // must never reuse the current automation target and create a phantom
      // replacement order.
      if (!target
        || (acknowledgedType && acknowledgedType !== targetType)
        || (refundedItem && itemKey(refundedItem) !== itemKey(target.itemName))) {
        this.update({ tracker: this.trackerSnapshot() })
        return
      }
      this.pendingCancel = null
      this.serverOrderCapUntil = 0
      // Consume the authorization before doing any delayed relist/sell work.
      // A duplicated Bazaar acknowledgement must not observe awaiting-cancel
      // and enqueue the same refunded items or replacement order twice.
      this.setPhase('idle', 'PROCESSING CANCELLATION', null)
      this.waitingForPurse = false
      this.state.counts.cancelled += 1
      const wasSell = /Sell Offer/i.test(text) || target?.orderType === 'sell'
      const consolidation = wasSell ? this.matchingSellConsolidation(target) : null
      const stashedRefund = wasSell && Date.now() < this.stashRefundPendingUntil
      if (stashedRefund) this.stashRefundPendingUntil = 0
      if (wasSell) {
        // Ordinary relists retain their historical fallback for localized chat
        // variants. Consolidation is stricter: it may aggregate only the exact
        // refunded item quantity that Hypixel acknowledged for this row.
        const authoritativeQuantity = consolidation ? refundedQuantity : (refundedQuantity || number(target.quantity))
        if (authoritativeQuantity > 0) {
          this.consumeSellOfferReservation(target.itemName, authoritativeQuantity)
          if (!stashedRefund) this.adjustLooseInventory(target.itemName, authoritativeQuantity)
        }
      }
      let replacementTarget = target
      if (wasSell && target?.mergePendingSell && !stashedRefund) {
        const key = itemKey(target.itemName)
        const pending = this.pendingSells.get(key)
        if (pending && pending._account === this.accountKey()) {
          replacementTarget = {
            ...target,
            ...pending,
            quantity: Math.max(1, Math.floor(number(target.quantity) + number(pending.quantity))),
            mergePendingSell: false,
            inFlight: true,
            _account: this.accountKey()
          }
          this.pendingSells.set(key, replacementTarget)
        }
      }
      this.removeTrackedOrder(wasSell ? 'sell' : 'buy', target?.itemName, target)
      this.clearPendingFilled(wasSell ? 'sell' : 'buy', target)
      if (stashedRefund) {
        if (consolidation) this.abortSellConsolidation(`The confirmed ${target.itemName} refund entered the item stash.`)
        this.activity('warning', `${refundedQuantity || Math.max(1, number(target.quantity))}x ${refundedItem || target.itemName} was refunded into Hypixel's item stash. It was not added to physical inventory or the pending-sell queue.`, target)
        this.finishCycle()
        this.nextSyncAt = Date.now() + 5000
        return
      }
      if (consolidation) {
        if (!refundedMatch || refundedQuantity < 1) {
          this.abortSellConsolidation(`The cancellation of ${target.itemName} was acknowledged without a parseable refunded-item quantity.`)
          this.finishCycle()
          this.nextSyncAt = Date.now()
          return
        }
        consolidation.cancelledRows += 1
        consolidation.refundedQuantity += refundedQuantity
        consolidation.currentLiveOrderId = ''
        consolidation.refundReservations.push({ quantity: refundedQuantity, at: Date.now() })
        this.queueSell({
          itemName: refundedItem || target.itemName,
          displayName: refundedItem || target.itemName,
          quantity: refundedQuantity,
          sellConsolidationId: consolidation.id
        })
        this.activity('success', `Confirmed refund ${refundedQuantity.toLocaleString('en-US')}x ${refundedItem || target.itemName} from duplicate row ${consolidation.cancelledRows}/${consolidation.initialRows}; refreshing Manage Orders before touching the next sibling.`, target)
        this.finishCycle()
        this.nextSyncAt = Date.now()
        return
      }
      if (!wasSell) {
        const buyRuntimeKey = this.orderRuntimeKey(target, 'buy', target?.itemName)
        this.claimedBuyFillCounts.delete(buyRuntimeKey)
        this.buyClaimAttempts.delete(buyRuntimeKey)
        this.partialBuyBatches.delete(buyRuntimeKey)
      }
      // Cancelling a Buy Order refunds only the unfilled coins. A cumulative
      // Filled: N/M value is not proof that N physical items were returned;
      // they may have been claimed hours ago or moved to stash. Only an
      // authoritative Claim Items chat acknowledgement may queue inventory.
      if (!wasSell && number(target?.filledQuantity) > 0) {
        const remainingQuantity = Math.max(0, Math.floor(number(target?.quantity)))
        if (remainingQuantity > 0 && !target.suppressRelist && !target.cancelWithoutRelist) this.queueBuyRelist({ ...target, quantity: remainingQuantity })
        this.activity('warning', `Partially filled buy cancelled; no inventory was assumed from the cumulative fill counter. ${remainingQuantity > 0 && !target.suppressRelist && !target.cancelWithoutRelist ? `The remaining ${remainingQuantity} will be relisted.` : 'No replacement buy will be created.'}`, target)
        return this.finishCycle()
      }
      if (target?.suppressRelist || target?.cancelWithoutRelist) {
        this.activity('success', target.cancelWithoutRelist
          ? `Cancelled stale ${target.itemName} without a replacement because no fresh qualifying scanner candidate exists.`
          : `Removed the extra buy order for ${target.itemName}; the original matching order remains active.`)
        return this.finishCycle()
      }
      this.activity('warning', `${wasSell ? 'Sell offer' : 'Buy order'} cancelled; placing it again at the current competitive price.`)
      const generation = this.actionGeneration
      return setTimeout(() => {
        if (generation !== this.actionGeneration || this.state.phase !== 'idle') return
        wasSell ? this.beginSell(replacementTarget) : this.beginBuy(replacementTarget)
      }, this.randomDelay())
    }
    if (/daily.*limit/i.test(text)) this.activity('warning', 'Daily Bazaar Limit reached; account rotation requested.')
    if (/no (?:bazaar )?(?:products?|items?) (?:found|matched)|could(?: not|n't) find.*(?:product|item)|not available (?:on|in) (?:the )?bazaar/i.test(text)
      && this.state.phase === 'opening-buy' && this.state.target) this.skipFailedBuyTarget(this.state.target, 'The server returned no Bazaar search result.')
  }
  finishCycle() {
    this.clearConfirmationRetry()
    this.setPhase('idle', 'MONITORING', null)
    this.nextSyncAt = this.filledOrderRefreshPending ? Date.now() : Date.now() + 2000
  }
  waitForExistingOrders(target = this.state.target) {
    this.waitingForPurse = true
    this.lastPurseWaitLogAt = Date.now()
    this.activity('info', `Free purse is insufficient for ${target?.itemName || 'the next order'}. Waiting for existing buy/sell orders to complete instead of trying another item.`, target)
    this.setPhase('idle', 'WAITING FOR PURSE', null)
    this.nextSyncAt = Date.now() + 5000
  }
  prepareManualOrderAction(durationMs = 15000, clearsInventory = false) {
    this.pendingCancel = null
    this.claimAllSellBatch = null
    if (clearsInventory) {
      this.pendingSells.clear()
      this.sellConsolidation = null
      this.sellConsolidationCooldowns.clear()
      this.pendingBuyRelists.clear()
      this.sellOfferReservations.clear()
      this.missingInventorySuppressions.clear()
    }
    this.manualControlUntil = Date.now() + Math.max(15000, Number(durationMs) || 0)
    this.setPhase('idle', 'MANUAL ORDER ACTION', null)
    this.nextSyncAt = this.manualControlUntil
    this.activity('info', 'Automatic workflow yielded control to a manual order action.', null)
  }
  resumeManualOrderAction(message = 'Manual order action ended; automatic trading resumed.') {
    this.manualControlUntil = 0
    this.finishCycle()
    this.activity('warning', message, null)
    this.diagnostic('manual-action-recovered')
    this.schedulePostManualSync()
  }
  recover(reason) {
    this.state.counts.recoveries += 1
    const phase = this.state.phase
    const target = this.state.target
    this.activity('warning', `${reason} Recovering phase ${phase}.`)
    if (/^(?:opening|reading)-manage$/.test(phase)) {
      this.manageFailureStreak += 1
      if (this.bot.hubModeActive === true) {
        if (this.manageOpenMethod === 'remote' && typeof this.hubBazaarOpener === 'function') {
          this.hubNpcFallbackPending = true
        }
        const backoffMs = Math.min(
          HUB_MANAGE_FAILURE_BACKOFF_MAX_MS,
          HUB_MANAGE_FAILURE_BACKOFF_MIN_MS * (2 ** Math.max(0, this.manageFailureStreak - 1))
        )
        this.manageReconnectPending = false
        this.setPhase('idle', 'ROAMING BEFORE BAZAAR RETRY', null)
        this.nextSyncAt = Date.now() + backoffMs
        this.activity('warning', `Manage Orders failed ${this.manageFailureStreak} consecutive time${this.manageFailureStreak === 1 ? '' : 's'} in Hub mode. Movement gets ${Math.round(backoffMs / 1000)} seconds before the next Bazaar retry; this instance will not reconnect for a routine GUI timeout.`, null)
        return
      }
      if (this.manageFailureStreak >= 3 && !this.manageReconnectPending && typeof this.bot.reconnectCurrent === 'function') {
        this.manageReconnectPending = true
        this.setPhase('idle', 'RECONNECTING STUCK INSTANCE', null)
        this.nextSyncAt = Date.now() + 60000
        this.activity('warning', `Manage Orders failed ${this.manageFailureStreak} consecutive times. Restarting this instance only instead of repeating the same GUI loop.`, null)
        try {
          const scheduled = this.bot.reconnectCurrent('Manage Orders failed three consecutive workflows', 1000)
          if (scheduled === false) this.manageReconnectPending = false
        } catch (error) {
          this.manageReconnectPending = false
          this.activity('error', `The stuck-Manage restart could not be scheduled: ${error.message || error}`, null)
        }
        return
      }
      this.setPhase('idle', 'RECOVERING MANAGE ORDERS', null)
      this.nextSyncAt = Date.now() + 1000
      return
    }
    if (/^cookie-(?:preparing|use|consume-confirm|consumed-awaiting-check)$/.test(phase)) {
      this.activity('warning', `${reason} Retrying Booster Cookie consumption without buying another Cookie.`, target)
      return this.preparePurchasedCookie()
    }
    if (/^cookie-/.test(phase)) return this.beginCookiePurchase(true)
    if (/awaiting-claim-(?:buy|sell)/.test(phase)) {
      const type = phase === 'awaiting-claim-buy' ? 'buy' : 'sell'
      if (this.deferBrokenClaim(type, target, reason)) return
      this.setPhase('idle', 'RECOVERING CLAIM', null)
      this.nextSyncAt = Date.now() + 1000
      return
    }
    if (/cancel/.test(phase)) {
      this.setPhase('idle', 'RECOVERING', null)
      this.nextSyncAt = Date.now() + 1000
      return
    }
    if (/buy/.test(phase) && target) {
      if (phase === 'opening-buy') {
        const key = itemKey(target.displayName || target.itemName || target.itemId)
        const failure = this.failedBuyTargets.get(key) || { attempts: 0, cooldownUntil: 0 }
        failure.attempts += 1
        this.failedBuyTargets.set(key, failure)
        if (failure.attempts >= 2) return this.skipFailedBuyTarget(target, 'The Bazaar search did not open after two attempts.')
      }
      return this.beginBuy(target, true)
    }
    if (/sell/.test(phase) && target) return this.beginSell(target, true)
    this.setPhase('idle', 'RECOVERING', null)
    this.nextSyncAt = Date.now() + 1000
  }
  fail(error) {
    this.activity('error', error.message || String(error))
    this.setPhase('idle', 'ERROR RECOVERY', null)
    this.nextSyncAt = Date.now() + 3000
  }
  skipFailedBuyTarget(target, reason, cooldownMs = 10 * 60 * 1000, persist = false) {
    const name = target?.displayName || target?.itemName || target?.itemId || 'Unknown item'
    const key = itemKey(name)
    const cooldownUntil = Date.now() + Math.max(60000, number(cooldownMs, 10 * 60 * 1000))
    this.buyReservations.delete(itemKey(name))
    this.failedBuyTargets.set(key, { attempts: 0, cooldownUntil })
    if (persist) {
      const account = this.accountLimitTracker()
      account.blockedBuyItems[key] = { itemName: name, cooldownUntil, reason }
      this.saveTracker()
    }
    const durationMinutes = Math.round((cooldownUntil - Date.now()) / 60000)
    const durationLabel = durationMinutes >= 24 * 60 ? `${Math.round(durationMinutes / 1440)} day` : `${durationMinutes} minutes`
    this.activity('warning', `${reason} ${name} will be skipped for ${durationLabel}.`, target)
    this.setPhase('idle', 'MONITORING', null)
    this.nextSyncAt = Date.now() + 1000
  }
  close() {
    if (this.cookieProbeTimer) clearTimeout(this.cookieProbeTimer)
    if (this.cookieConsumeTimer) clearTimeout(this.cookieConsumeTimer)
    this.flushUptime(false)
    this.stopTimer()
    this.clearConfirmationRetry()
    if (this.postManualSyncTimer) clearTimeout(this.postManualSyncTimer)
    if (this.manageOrdersRecheckTimer) clearTimeout(this.manageOrdersRecheckTimer)
    if (this.orderDetailRecheckTimer) clearTimeout(this.orderDetailRecheckTimer)
    if (this.pendingClickTimer) clearTimeout(this.pendingClickTimer)
    if (this.startupClearTimer) clearTimeout(this.startupClearTimer)
    this.postManualSyncTimer = null
    this.manageOrdersRecheckTimer = null
    this.orderDetailRecheckTimer = null
    this.pendingClickTimer = null
    this.pendingClickIntent = ''
    this.pendingClickResult = null
    this.startupClearTimer = null
  }
}

module.exports = { BazaarAutomation, stackSizeForItem }
