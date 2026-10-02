'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

function sanitizeDisconnectText(value) {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u00A7./g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseBanDisconnect(event) {
  if (event?.type !== 'disconnect') return null
  const reason = sanitizeDisconnectText([event.reason || event.display || event.message, event.detail].filter(Boolean).join(' · '))
  const accountDirected = /(?:\byou\s+(?:are|have been|were)\s+(?:(?:temporarily|permanently)\s+)?(?:banned|suspended)\b|\byour account\s+(?:is|has been|was)\s+(?:(?:temporarily|permanently)\s+)?(?:banned|suspended)\b)/i.test(reason)
  if (!accountDirected) return null
  const permanent = /permanently\s+(?:banned|suspended)/i.test(reason)
  const duration = reason.match(/(?:ban\s+duration\s*[:\-]?|(?:banned|suspended)\s+for|time\s+remaining\s*[:\-]?)\s*((?:\d+\s*(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|[ywdhms])\s*)+)/i)?.[1]
    || reason.match(/(?:until|expires?(?:\s+at)?)\s+([^·|]{3,80})/i)?.[1]
    || (permanent ? 'permanent' : 'not specified by server')
  return { reason, durationText: sanitizeDisconnectText(duration), permanent }
}

function isProxyAuthenticationFailure(value) {
  const match = String(value || '').match(/invalid authentication status\s*:\s*(\d+)\b/i)
  return Boolean(match) && Number(match[1]) !== 0
}

function isProxyEndpointFailure(value) {
  const text = sanitizeDisconnectText(value)
  return /(?:\bos error\s*1006[01]\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bconnection\s+(?:was\s+)?refused\b|\b(?:connection|connect)\s+timed\s*out\b|конечн(?:ый|ому)\s+компьютер(?:у)?\s+отверг\s+запрос)/i.test(text)
}

function isHubLocation(value) {
  const clean = sanitizeDisconnectText(value).replace(/^[^a-z]+/i, '')
  return /^(?:hub|village|bazaar alley|forest)(?:\b|$)/i.test(clean)
}

// Backward-compatible export name retained for callers/tests written before
// endpoint timeouts were classified alongside explicit TCP refusals.
const isProxyEndpointRefused = isProxyEndpointFailure

const zonedParts = (at, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(at))
  const value = type => Number(parts.find(part => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

const zonedEpoch = (parts, timeZone) => {
  const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
  let guess = wanted
  // Convert a wall-clock time in a named zone without relying on the Windows
  // process timezone. Iteration also handles seasonal UTC-offset changes.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(guess, timeZone)
    const delta = wanted - Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second)
    if (!delta) break
    guess += delta
  }
  return guess
}

function tallinnDailyLimitResumeAt(now = Date.now(), random = Math.random) {
  const timeZone = 'Europe/Tallinn'
  const local = zonedParts(now, timeZone)
  // Pick any instant inside the local 03:00:00–03:59:59 window instead of
  // reconnecting every instance on the same minute.
  const randomSecondOfHour = Math.min(3599, Math.max(0, Math.floor(Number(random()) * 3600)))
  const randomMinute = Math.floor(randomSecondOfHour / 60)
  const randomSecond = randomSecondOfHour % 60
  let calendar = new Date(Date.UTC(local.year, local.month - 1, local.day))
  let target = zonedEpoch({
    year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(),
    hour: 3, minute: randomMinute, second: randomSecond
  }, timeZone)
  if (target <= now) {
    calendar = new Date(calendar.getTime() + 24 * 60 * 60 * 1000)
    target = zonedEpoch({
      year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(),
      hour: 3, minute: randomMinute, second: randomSecond
    }, timeZone)
  }
  return target
}

class AzaleaController extends EventEmitter {
  constructor(bridgePath, authCacheDir, readConfig, log) {
    super()
    this.bridgePath = bridgePath
    this.authCacheDir = authCacheDir
    this.readConfig = readConfig
    this.log = log
    this.process = null
    this.pendingOrderAction = null
    this.clearOrdersTimer = null
    this.clearCompletionTimer = null
    this.clearWatchdogTimer = null
    this.orderRefreshTimer = null
    this.reconnectTimer = null
    this.connectionFailureTimer = null
    this.islandRecoveryTimer = null
    this.islandRecoveryAttempts = 0
    this.islandRecoveryGeneration = 0
    this.islandRecoveryDelays = [2000, 5000, 10000, 20000, 30000]
    this.pendingSkyBlockCommand = null
    this.skyBlockEntryTimer = null
    this.skyBlockEntryAttempts = 0
    this.skyBlockEntryGeneration = 0
    this.skyBlockEntryRetryMs = 11000
    this.skyBlockEntryMaxAttempts = 5
    // The scoreboard location row can be omitted by Hypixel while the Purse
    // row is still present. Keep a per-world SkyBlock proof so gated commands
    // such as /hub are not trapped behind a location row that never arrives.
    this.skyBlockPresenceConfirmed = false
    this.hubTeleportEvidence = null
    this.hubTeleportTimer = null
    this.hubTeleportAttempts = 0
    this.hubTeleportGeneration = 0
    this.skyBlockNavigationCooldownMs = 11000
    this.hubTeleportDelayAfterSkyBlockMs = 11000
    this.hubTeleportRetryMs = 11000
    this.hubTeleportMaxAttempts = 4
    this.hubModeActive = false
    this.lifecycleTimer = null
    this.lifecycleGeneration = 0
    this.reconnectAttempts = 0
    this.groupReconnectEnabled = false
    this.connectionGeneration = 0
    this.bazaarSearchGeneration = 0
    this.emptyOrdersObservation = null
    this.ordersScreenObservation = null
    this.confirmedOrdersSnapshot = false
    this.screenPacketSequence = 0
    this.screenPacketIds = new WeakMap()
    this.pendingOrderPlacements = new Map()
    this.bazaarNpcAttempt = null
    this.bazaarNpcSequence = 0
    this.lastMovementPosition = null
    this.hubSpawnClearanceRequired = false
    this.hubSpawnClearanceWaiters = new Set()
    this.accountLinkPromise = null
    this.pendingDeviceCode = null
    this.verificationChildren = new Set()
    this.shuttingDown = false
    this.safetyLockActive = false
    this.safetyLockReason = ''
    this.connectionBlockedReason = ''
    this.proxyEndpointRefusalCount = 0
    this.lastProxyEndpointRefusalGeneration = null
    this.currentAccountId = ''
    this.accountsFile = path.join(authCacheDir, 'accounts.json')
    this.accountsBackupFile = path.join(authCacheDir, 'accounts.backup.json')
    this.orderTimesFile = path.join(authCacheDir, 'order-times.json')
    this.accountData = this.loadAccounts()
    this.orderTimes = this.loadOrderTimes()
    this.lastWindow = { title: '', slots: [], actions: [] }
    const savedAccount = this.accountData.accounts.find(account => account.id === this.accountData.activeId)
    this.state = { status: 'disconnected', username: savedAccount?.username || '', server: '', version: '26.2', engine: 'Azalea', window: '', accountConnected: Boolean(savedAccount), lastError: '', accounts: this.accountData.accounts, activeAccountId: this.accountData.activeId, orders: [], purse: null, purseUpdatedAt: '', cookieRemainingSeconds: null, cookieUpdatedAt: '', location: { known: false, name: '', onIsland: false }, hubMode: false, safetyLocked: false, connectionBlocked: false }
  }

  loadAccounts() {
    const readAccountList = file => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(parsed.accounts)) return { activeId: String(parsed.activeId || ''), accounts: parsed.accounts }
      } catch {}
      return null
    }
    const primary = readAccountList(this.accountsFile)
    const backup = readAccountList(this.accountsBackupFile)
    if (primary?.accounts?.length) return primary

    // A crash or interrupted write must not make every linked account vanish.
    // Recover only entries that still have a real token cache; this prevents an
    // intentionally removed account from being resurrected by the backup.
    const recoverableAccounts = (backup?.accounts || []).filter(account => {
      const id = String(account?.id || '')
      if (!id || !/^account-[a-z0-9-]+$/i.test(id)) return false
      try { return fs.statSync(path.join(this.authCacheDir, `${id}.json`)).size > 0 } catch { return false }
    })
    if (recoverableAccounts.length) {
      const activeId = recoverableAccounts.some(account => account.id === backup.activeId)
        ? backup.activeId
        : recoverableAccounts[0].id
      const restored = { activeId, accounts: recoverableAccounts }
      fs.mkdirSync(this.authCacheDir, { recursive: true })
      fs.writeFileSync(this.accountsFile, JSON.stringify(restored, null, 2), 'utf8')
      this.log('warning', `Recovered ${recoverableAccounts.length} saved Microsoft account(s) from the protected account index backup.`)
      return restored
    }
    if (primary) return primary
    const legacyFile = path.join(this.authCacheDir, 'azalea-auth.json')
    const migratedFile = path.join(this.authCacheDir, 'account-legacy.json')
    if (fs.existsSync(legacyFile)) {
      try { fs.renameSync(legacyFile, migratedFile) } catch { fs.copyFileSync(legacyFile, migratedFile) }
      return { activeId: 'account-legacy', accounts: [{ id: 'account-legacy', username: 'Saved account', addedAt: new Date().toISOString() }] }
    }
    return { activeId: '', accounts: [] }
  }
  saveAccounts() {
    fs.mkdirSync(this.authCacheDir, { recursive: true })
    const serialized = JSON.stringify(this.accountData, null, 2)
    fs.writeFileSync(this.accountsFile, serialized, 'utf8')
    if (this.accountData.accounts.length) fs.writeFileSync(this.accountsBackupFile, serialized, 'utf8')
    this.update({ accounts: this.accountData.accounts.map(item => ({ ...item })), activeAccountId: this.accountData.activeId })
  }
  loadOrderTimes() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.orderTimesFile, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { return {} }
  }
  saveOrderTimes() {
    try {
      fs.mkdirSync(this.authCacheDir, { recursive: true })
      fs.writeFileSync(this.orderTimesFile, JSON.stringify(this.orderTimes, null, 2), 'utf8')
    } catch (error) {
      this.log('warning', `Could not save Bazaar order ages: ${error.message}`)
    }
  }
  orderTimeKey(type, itemName) {
    const account = this.currentAccountId || this.accountData.activeId || 'default'
    const item = this.cleanText(itemName).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return `${account}:${type}:${item}`
  }
  orderRowTimeKey(type, itemName, slot) {
    const row = Number.isFinite(Number(slot)) ? Number(slot) : 'unknown'
    return `${this.orderTimeKey(type, itemName)}:row:${row}`
  }
  orderStructureKey(order) {
    return `${String(order?.type || '').toLowerCase()}:${Number(order?.slot)}:${this.cleanText(order?.itemName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
  }
  orderMatchKey(order) {
    const total = Math.max(0, Number(order?.totalCount ?? order?.count) || 0)
    const unitPrice = Math.max(0, Number(order?.unitPriceCoins) || 0)
    return `${String(order?.type || '').toLowerCase()}:${this.cleanText(order?.itemName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${total}:${unitPrice}`
  }
  rememberOrderTime(type, itemName, placedAt = Date.now()) {
    const key = this.orderTimeKey(type, itemName)
    const now = Date.now()
    const queue = (this.pendingOrderPlacements.get(key) || [])
      .filter(entry => Number(entry.expiresAt) > now)
    queue.push({
      placedAt: Math.max(1, Number(placedAt) || now),
      expiresAt: now + 5 * 60 * 1000
    })
    // Chat confirms the item and type before the server exposes its GUI slot.
    // Keep a short FIFO instead of overwriting every same-item order's age.
    this.pendingOrderPlacements.set(key, queue.slice(-16))
  }
  snapshot() { return { ...this.state, accounts: this.accountData.accounts.map(item => ({ ...item })), activeAccountId: this.accountData.activeId, pendingDeviceCode: this.pendingDeviceCode ? { ...this.pendingDeviceCode } : null } }
  update(patch) { Object.assign(this.state, patch); this.emit('state', this.snapshot()) }
  resetEmptyOrdersObservation() {
    this.emptyOrdersObservation = null
    this.ordersScreenObservation = null
  }
  screenPacketId(screen) {
    if (!screen || typeof screen !== 'object') return ++this.screenPacketSequence
    const known = this.screenPacketIds.get(screen)
    if (known) return known
    const next = ++this.screenPacketSequence
    this.screenPacketIds.set(screen, next)
    return next
  }
  resetLiveSession(patch = {}) {
    this.skyBlockPresenceConfirmed = false
    this.lastWindow = { title: '', slots: [], actions: [] }
    this.resetEmptyOrdersObservation()
    this.confirmedOrdersSnapshot = false
    this.pendingOrderPlacements.clear()
    this.update({
      status: 'disconnected',
      window: '',
      orders: [],
      purse: null,
      purseUpdatedAt: '',
      cookieRemainingSeconds: null,
      cookieUpdatedAt: '',
      location: { known: false, name: '', onIsland: false },
      hubMode: this.hubModeActive,
      ...patch
    })
  }
  isCurrentChild(child, generation) {
    return Boolean(child && child === this.process && generation === this.connectionGeneration)
  }
  isAlive() {
    const child = this.process
    return Boolean(child && !child.killed && child.exitCode == null && child.signalCode == null && child.stdin?.writable)
  }
  clearConnectionFailureWatchdog() {
    if (this.connectionFailureTimer) clearTimeout(this.connectionFailureTimer)
    this.connectionFailureTimer = null
  }
  clearIslandRecovery() {
    if (this.islandRecoveryTimer) clearTimeout(this.islandRecoveryTimer)
    this.islandRecoveryTimer = null
    this.islandRecoveryAttempts = 0
    this.islandRecoveryGeneration += 1
  }
  inSkyBlock(location = this.state.location) {
    return this.skyBlockPresenceConfirmed || location?.onIsland === true || this.hubLocation(location)
  }
  clearSkyBlockEntry({ keepPending = false } = {}) {
    if (this.skyBlockEntryTimer) clearTimeout(this.skyBlockEntryTimer)
    this.skyBlockEntryTimer = null
    this.skyBlockEntryAttempts = 0
    this.skyBlockEntryGeneration += 1
    if (!keepPending) this.pendingSkyBlockCommand = null
  }
  skyBlockCommandPriority(command) {
    if (command === 'hub') return 30
    if (command === 'island') return 20
    return 10
  }
  executePendingSkyBlockCommand() {
    if (!this.pendingSkyBlockCommand || !this.inSkyBlock() || !this.isAlive()) return false
    const pending = this.pendingSkyBlockCommand
    this.clearSkyBlockEntry()
    try {
      const result = pending.execute({ afterSkyBlockEntry: true })
      this.log('success', result?.deferred
        ? `SkyBlock confirmed; ${pending.label} queued after the server command cooldown.`
        : `SkyBlock confirmed; sent ${pending.label}.`)
      return true
    } catch (error) {
      this.log('error', `SkyBlock was confirmed, but ${pending.label} could not be sent: ${error.message}`)
      return false
    }
  }
  armSkyBlockEntryRetry() {
    if (!this.pendingSkyBlockCommand || this.skyBlockEntryTimer || !this.isAlive()) return false
    const generation = this.skyBlockEntryGeneration
    this.skyBlockEntryTimer = setTimeout(() => {
      this.skyBlockEntryTimer = null
      if (generation !== this.skyBlockEntryGeneration || !this.pendingSkyBlockCommand || !this.isAlive()) return
      if (this.executePendingSkyBlockCommand()) return
      if (this.skyBlockEntryAttempts >= this.skyBlockEntryMaxAttempts) {
        const label = this.pendingSkyBlockCommand.label
        this.clearSkyBlockEntry()
        this.log('error', `Could not enter SkyBlock after ${this.skyBlockEntryMaxAttempts} attempts; ${label} was not sent from the Hypixel lobby. Reconnecting this instance.`)
        this.reconnectCurrent('SkyBlock entry timed out', 3000)
        return
      }
      this.send({ command: 'chat', text: '/skyblock' })
      this.skyBlockEntryAttempts += 1
      this.log('warning', `SkyBlock is not confirmed yet; sent /skyblock again (attempt ${this.skyBlockEntryAttempts}/${this.skyBlockEntryMaxAttempts}).`)
      this.armSkyBlockEntryRetry()
    }, this.skyBlockEntryRetryMs)
    this.skyBlockEntryTimer.unref?.()
    return true
  }
  requireSkyBlock(command, label, execute) {
    if (this.inSkyBlock()) {
      execute({ afterSkyBlockEntry: false })
      return true
    }
    const next = { command, label, execute, priority: this.skyBlockCommandPriority(command) }
    const current = this.pendingSkyBlockCommand
    if (current && current.priority > next.priority) {
      this.log('debug', `Kept pending ${current.label}; ignored lower-priority ${label} until the SkyBlock transition finishes.`)
      return true
    }
    const firstRequest = !current
    this.pendingSkyBlockCommand = next
    if (firstRequest) {
      this.skyBlockEntryAttempts = 1
      this.send({ command: 'chat', text: '/skyblock' })
      this.log('warning', `The instance is outside confirmed SkyBlock. Sent /skyblock first; ${label} is queued until location confirmation.`)
      this.armSkyBlockEntryRetry()
    } else {
      this.log('debug', `Updated the command waiting for SkyBlock confirmation to ${label}.`)
    }
    return true
  }
  armHubTeleportConfirmation() {
    this.hubTeleportEvidence = {
      requestedAt: Date.now(),
      transferSeen: false,
      matchingSamples: 0
    }
  }
  clearHubTeleportRetry({ keepEvidence = false } = {}) {
    if (this.hubTeleportTimer) clearTimeout(this.hubTeleportTimer)
    this.hubTeleportTimer = null
    this.hubTeleportAttempts = 0
    this.hubTeleportGeneration += 1
    if (!keepEvidence) this.hubTeleportEvidence = null
  }
  beginHubTeleport({ delayMs = 0 } = {}) {
    this.clearHubTeleportRetry()
    const generation = this.hubTeleportGeneration
    const sendAttempt = () => {
      this.hubTeleportTimer = null
      if (generation !== this.hubTeleportGeneration || !this.hubModeActive || !this.isAlive() || this.hubLocation()) return
      this.armHubTeleportConfirmation()
      this.send({ command: 'hub' })
      this.hubTeleportAttempts += 1
      if (this.hubTeleportAttempts > 1) this.log('warning', `/hub produced no server transfer; retry ${this.hubTeleportAttempts}/${this.hubTeleportMaxAttempts}.`)
      this.hubTeleportTimer = setTimeout(() => {
        this.hubTeleportTimer = null
        if (generation !== this.hubTeleportGeneration || !this.hubModeActive || !this.isAlive() || this.hubLocation()) return
        if (this.hubTeleportEvidence?.transferSeen) return
        if (this.hubTeleportAttempts >= this.hubTeleportMaxAttempts) {
          this.log('error', `/hub was ignored after ${this.hubTeleportMaxAttempts} attempts; no server transfer was observed.`)
          return
        }
        sendAttempt()
      }, this.hubTeleportRetryMs)
      this.hubTeleportTimer.unref?.()
    }
    const wait = Math.max(0, Number(delayMs) || 0)
    if (!wait) sendAttempt()
    else {
      this.hubTeleportTimer = setTimeout(sendAttempt, wait)
      this.hubTeleportTimer.unref?.()
    }
    return { deferred: wait > 0 }
  }
  deferAfterSkyBlockCooldown(execute) {
    const generation = this.skyBlockEntryGeneration
    const wait = Math.max(0, Number(this.skyBlockNavigationCooldownMs) || 11000)
    this.skyBlockEntryTimer = setTimeout(() => {
      this.skyBlockEntryTimer = null
      if (generation !== this.skyBlockEntryGeneration || !this.isAlive()) return
      execute()
    }, wait)
    this.skyBlockEntryTimer.unref?.()
    return { deferred: true }
  }
  noteHubTeleportTransfer() {
    const evidence = this.hubTeleportEvidence
    if (!evidence || Date.now() - evidence.requestedAt > 45000) return false
    evidence.transferSeen = true
    evidence.matchingSamples = 0
    this.clearHubTeleportRetry({ keepEvidence: true })
    return true
  }
  confirmHubFromMovement(event = {}) {
    const evidence = this.hubTeleportEvidence
    if (!evidence) return false
    if (Date.now() - evidence.requestedAt > 45000) {
      this.hubTeleportEvidence = null
      return false
    }
    if (!evidence.transferSeen || !this.hubModeActive) return false
    const x = Number(event.position?.x ?? event.x)
    const y = Number(event.position?.y ?? event.y)
    const z = Number(event.position?.z ?? event.z)
    const nearHubSpawn = [x, y, z].every(Number.isFinite)
      && Math.hypot(x - 0.5, z + 0.5) <= 8
      && y >= 74
      && y <= 82
    evidence.matchingSamples = nearHubSpawn ? evidence.matchingSamples + 1 : 0
    if (evidence.matchingSamples < 2) return false
    this.clearHubTeleportRetry()
    this.update({ location: { known: true, name: 'Hub', onIsland: false } })
    this.clearIslandRecovery()
    this.log('success', `Hub confirmed from the requested /hub transfer and stable spawn telemetry at X ${x.toFixed(2)}, Y ${y.toFixed(2)}, Z ${z.toFixed(2)}.`)
    return true
  }
  ensureIslandRecovery(reason = 'Your Island is not confirmed.') {
    if (this.shuttingDown || this.state.status !== 'connected' || !this.isAlive()) return false
    // Hub Roaming is an explicit per-instance mode. Never let the legacy
    // island watchdog fight a requested /hub session by sending /is.
    if (this.hubModeActive) {
      this.clearIslandRecovery()
      return false
    }
    if (this.state.location?.onIsland === true) {
      this.clearIslandRecovery()
      return false
    }
    if (this.islandRecoveryTimer) return true
    const delays = this.islandRecoveryDelays
    const delayMs = delays[Math.min(this.islandRecoveryAttempts, delays.length - 1)]
    const generation = this.islandRecoveryGeneration
    this.islandRecoveryTimer = setTimeout(() => {
      this.islandRecoveryTimer = null
      if (this.shuttingDown || generation !== this.islandRecoveryGeneration || this.state.location?.onIsland === true || !this.isAlive()) return
      this.islandRecoveryAttempts += 1
      try {
        this.sendChat('/is')
        this.log('warning', `${reason} Returning to Your Island with /is (attempt ${this.islandRecoveryAttempts}/${delays.length}).`)
      } catch (error) {
        this.log('warning', `${reason} Could not send /is: ${error.message}`)
      }
      if (this.islandRecoveryAttempts >= delays.length) {
        this.log('error', `${reason} Your Island was not confirmed after ${delays.length} /is attempts; reconnecting this instance.`)
        this.reconnectCurrent('Island recovery timed out', 3000)
        return
      }
      this.ensureIslandRecovery(reason)
    }, delayMs)
    this.islandRecoveryTimer.unref?.()
    return true
  }
  cancelLifecycleConnect() {
    if (this.lifecycleTimer) clearTimeout(this.lifecycleTimer)
    this.lifecycleTimer = null
    this.lifecycleGeneration += 1
  }
  scheduleLifecycleConnect(accountId, delayMs, failureLabel) {
    if (this.shuttingDown || this.safetyLockActive || this.connectionBlockedReason) return false
    this.cancelLifecycleConnect()
    const generation = this.lifecycleGeneration
    this.lifecycleTimer = setTimeout(() => {
      this.lifecycleTimer = null
      if (this.shuttingDown || generation !== this.lifecycleGeneration || this.process) return
      try {
        this.connect(accountId)
      } catch (error) {
        if (this.shuttingDown) return
        this.log('error', `${failureLabel}: ${error.message}`)
        this.scheduleReconnect(`${failureLabel}.`)
      }
    }, Math.max(0, Number(delayMs) || 0))
    this.lifecycleTimer.unref?.()
    return true
  }
  configuredValue(value, index, sharedFallback = false) {
    if (!Array.isArray(value)) return value
    if (value[index] !== undefined) return value[index]
    return sharedFallback && value.length === 1 ? value[0] : undefined
  }
  bridgeEnvironment(selectedId, includeLocation = true) {
    const config = this.readConfig()
    const env = { ...process.env }
    const accountIndex = Math.max(0, this.accountData.accounts.findIndex(account => account.id === selectedId))
    const proxy = config.proxy || {}
    if (proxy.enabled) {
      const ip = String(this.configuredValue(proxy.ip, accountIndex) || '').trim()
      const port = Number(this.configuredValue(proxy.port, accountIndex))
      // The bundled bridge accepts a proxy host, but its legacy fallback can
      // ignore an unresolvable value. Require a literal IP here so an enabled
      // proxy can never silently turn into a direct game connection.
      if (net.isIP(ip) !== 0 && Number.isInteger(port) && port >= 1 && port <= 65535) {
        env.FF_PROXY_JSON = JSON.stringify({
          ip,
          port,
          username: String(this.configuredValue(proxy.username, accountIndex, true) || ''),
          password: String(this.configuredValue(proxy.password, accountIndex, true) || '')
        })
      } else {
        // Proxy is a privacy boundary. If it was explicitly enabled, an
        // incomplete entry must fail closed instead of exposing the direct IP.
        throw new Error(`Proxy entry ${accountIndex + 1} is missing a valid literal IP or port; connection was blocked to prevent a direct connection.`)
      }
    }
    return env
  }

  connect(accountId = '') {
    if (this.shuttingDown) throw new Error('Azalea controller is shutting down.')
    if (this.safetyLockActive) throw new Error(this.safetyLockReason || 'Fleet safety lock is active after a ban disconnect.')
    if (this.connectionBlockedReason) throw new Error(this.connectionBlockedReason)
    if (this.process) throw new Error('Azalea is already connecting or connected.')
    this.cancelLifecycleConnect()
    this.clearConnectionFailureWatchdog()
    this.cancelBazaarSearch()
    this.abortOrderAction()
    const host = this.readConfig().server.host
    const selectedId = accountId || this.accountData.activeId || `account-${Date.now()}`
    const selectedAccount = this.accountData.accounts.find(account => account.id === selectedId)
    const dailyLimitResumeAt = Number(selectedAccount?.dailyLimitResumeAt)
    if (dailyLimitResumeAt > Date.now()) {
      const delayMs = dailyLimitResumeAt - Date.now()
      const resumeText = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Tallinn', day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).format(new Date(dailyLimitResumeAt))
      this.currentAccountId = selectedId
      this.update({
        status: 'daily-limit-wait',
        username: selectedAccount?.username || this.state.username,
        activeAccountId: selectedId,
        accountConnected: Boolean(selectedAccount),
        lastError: `Daily Bazaar Limit reached; reconnect scheduled for ${resumeText} Tallinn time.`
      })
      this.log('warning', `Daily Bazaar Limit wait is still active. Reconnecting at ${resumeText} Tallinn time.`)
      this.scheduleLifecycleConnect(selectedId, delayMs, 'Daily limit reconnect failed')
      return this.snapshot()
    }
    if (selectedAccount?.dailyLimitResumeAt) {
      delete selectedAccount.dailyLimitResumeAt
      this.saveAccounts()
    }
    this.currentAccountId = selectedId
    const cacheFile = path.join(this.authCacheDir, `${selectedId}.json`)
    // Purse and Cookie values belong to the account that produced them. Clear
    // the previous account's live values before every start/restart/rotation;
    // BazaarAutomation will refresh them after the new account reaches its
    // island.
    this.lastWindow = { title: '', slots: [], actions: [] }
    this.resetEmptyOrdersObservation()
    this.confirmedOrdersSnapshot = false
    this.pendingOrderPlacements.clear()
    this.update({
      status: 'connecting',
      username: selectedAccount?.username || this.state.username,
      server: host,
      lastError: '',
      activeAccountId: selectedId,
      accountConnected: Boolean(selectedAccount),
      purse: null,
      purseUpdatedAt: '',
      orders: [],
      window: '',
      location: { known: false, name: '', onIsland: false },
      hubMode: this.hubModeActive,
      cookieRemainingSeconds: null,
      cookieUpdatedAt: ''
    })
    this.log('info', `Starting Azalea 26.2 for ${host} with account slot ${selectedId}.`)
    const generation = ++this.connectionGeneration
    let child
    try {
      child = spawn(this.bridgePath, [host, cacheFile], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.bridgeEnvironment(selectedId)
      })
    } catch (error) {
      const message = `Could not start Azalea bridge: ${error.message}`
      this.resetLiveSession({ lastError: message })
      this.log('error', message)
      throw error
    }
    this.process = child
    this.attachChildHandlers(child, generation)
    return this.snapshot()
  }

  attachChildHandlers(child, generation) {
    readline.createInterface({ input: child.stdout }).on('line', line => this.handleLine(line, child, generation))
    readline.createInterface({ input: child.stderr }).on('line', line => {
      if (!this.isCurrentChild(child, generation)) return
      if (line.trim() && !this.handleAuthLine(line)) this.log('debug', `[Azalea stderr] ${this.stripAnsi(line)}`)
    })
    child.once('error', error => this.handleChildError(child, generation, error))
    // ChildProcess can emit `exit` before its stdout/stderr pipes are fully
    // drained. Finalize on `close` so a last server disconnect packet (most
    // importantly a ban reason) is still handled with the current identity.
    child.once('close', (code, signal) => this.handleChildExit(child, generation, code, signal))
  }

  handleChildError(child, generation, error) {
    if (!this.isCurrentChild(child, generation)) return false
    const message = `Could not start Azalea bridge: ${error.message}`
    this.process = null
    this.connectionGeneration += 1
    this.clearConnectionFailureWatchdog()
    this.cancelBazaarSearch()
    this.abortOrderAction()
    this.resetLiveSession({ lastError: message })
    this.log('error', message)
    this.scheduleReconnect('Azalea failed to start.')
    return true
  }

  handleChildExit(child, generation, code, signal) {
    if (!this.isCurrentChild(child, generation)) return false
    const message = `Azalea process exited (code=${code ?? 'none'}, signal=${signal || 'none'}). See preceding logs for the server reason.`
    this.process = null
    this.connectionGeneration += 1
    this.clearConnectionFailureWatchdog()
    this.cancelBazaarSearch()
    this.abortOrderAction()
    this.resetLiveSession({ lastError: message })
    this.log(code === 0 ? 'warning' : 'error', message)
    this.scheduleReconnect('Azalea stopped unexpectedly.')
    return true
  }

  verifyAccountSlot(selectedId, { register = false, makeActive = false } = {}) {
    let selected = this.accountData.accounts.find(account => account.id === selectedId)
    if (!selected && register) selected = { id: selectedId, username: '', addedAt: new Date().toISOString() }
    if (!selected) throw new Error('Select a linked Microsoft account first.')
    const cacheFile = path.join(this.authCacheDir, `${selectedId}.json`)
    if (!register && !fs.existsSync(cacheFile)) throw new Error(`${selected.username || 'Selected account'} must be linked again because its Microsoft token is missing.`)
    const host = this.readConfig().server.host
    this.log('info', register
      ? 'Waiting for Microsoft authorization for the new FF account.'
      : `Verifying Microsoft token for ${selected.username || selectedId} before starting.`)
    const bridgeRuntime = path.join(path.dirname(this.bridgePath), 'VCRUNTIME140.dll')
    if (process.platform === 'win32' && !fs.existsSync(bridgeRuntime)) {
      throw new Error(`Microsoft verification cannot start: ${bridgeRuntime} is missing. Reinstall the portable build.`)
    }
    this.pendingDeviceCode = null
    return new Promise((resolve, reject) => {
      const child = spawn(this.bridgePath, [host, cacheFile, '--verify-only'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.bridgeEnvironment(selectedId, false)
      })
      let verified = false
      let failure = ''
      let settled = false
      let timeout = null
      this.verificationChildren.add(child)
      const finish = (error) => {
        if (settled) return
        settled = true
        this.pendingDeviceCode = null
        this.verificationChildren.delete(child)
        if (timeout) clearTimeout(timeout)
        if (error) reject(error)
        else resolve(this.snapshot())
      }
      const inspect = line => {
        let event
        try { event = JSON.parse(line) } catch {
          this.handleAuthLine(line)
          return
        }
        if (event.type === 'authenticated' || event.type === 'verified') {
          verified = true
          if (event.username) {
            selected.username = event.username
            if (register && !this.accountData.accounts.some(account => account.id === selectedId)) this.accountData.accounts.push(selected)
            if (makeActive || !this.accountData.activeId) this.accountData.activeId = selectedId
            this.saveAccounts()
          }
          // The bundled proxy-aware bridge does not implement --verify-only.
          // Microsoft verification is complete at this event, so terminate
          // the helper before it performs a second, misleading server join.
          this.log('success', register
            ? `Microsoft account confirmed: ${selected.username || selectedId}.`
            : `Microsoft account verified: ${selected.username || selectedId}.`)
          try { child.kill() } catch {}
          finish()
        } else if (event.type === 'fatal') failure = event.message || 'Microsoft account verification failed.'
      }
      readline.createInterface({ input: child.stdout }).on('line', inspect)
      readline.createInterface({ input: child.stderr }).on('line', line => {
        if (!this.handleAuthLine(line) && line.trim()) this.log('debug', `[Microsoft verification] ${this.stripAnsi(line)}`)
      })
      child.once('error', error => finish(new Error(`Could not verify Microsoft account: ${error.message}`)))
      child.once('exit', code => {
        this.verificationChildren.delete(child)
        if (settled) return
        const windowsStatus = Number(code) >>> 0
        if (windowsStatus === 0xC0000135) {
          finish(new Error('Microsoft verification could not start because a required Visual C++ runtime DLL is missing. Reinstall this portable build.'))
          return
        }
        if (verified && code === 0) finish()
        else finish(new Error(failure || `Microsoft account verification failed (code ${code ?? 'none'}). Link the account again.`))
      })
      timeout = setTimeout(() => {
        child.kill()
        finish(new Error('Microsoft account verification timed out. Complete Microsoft Link and try again.'))
      }, 180000)
      timeout.unref?.()
    })
  }

  verifyActiveAccount() {
    if (this.process) throw new Error('The instance is already running.')
    return this.verifyAccountSlot(this.accountData.activeId)
  }

  stripAnsi(value) { return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '') }
  handleAuthLine(line) {
    const clean = this.stripAnsi(line).replaceAll('&amp;', '&')
    const rawUri = clean.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, '')
    if (!rawUri) return false

    let authUrl
    try { authUrl = new URL(rawUri) } catch { return false }
    const host = authUrl.hostname.toLowerCase()
    const path = authUrl.pathname.toLowerCase()
    const trustedMicrosoftLogin = (
      (host === 'microsoft.com' || host === 'www.microsoft.com') && path.startsWith('/link')
    ) || (
      host === 'login.live.com' && path.includes('remoteconnect')
    )
    if (!trustedMicrosoftLogin) return false

    let code = ''
    code = authUrl.searchParams.get('otc') || authUrl.searchParams.get('user_code') || authUrl.searchParams.get('code') || ''
    // Localized output is safe to support without matching translated words:
    // require a trusted Microsoft device-login URL on the same line, then
    // locate the protocol-shaped token beside it.
    if (!code) {
      const candidates = clean.toUpperCase().match(/\b(?:[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{6,12})\b/g) || []
      code = candidates.find(value => value.includes('-') || (/[A-Z]/.test(value) && /\d/.test(value))) || ''
    }
    code = String(code).trim().toUpperCase()
    const validCode = /^(?:[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{6,12})$/.test(code)
      && /[A-Z]/.test(code)
      && (code.includes('-') || /\d/.test(code))
    if (!validCode) return false
    const payload = {
      message: clean,
      userCode: code,
      // Always present the stable Microsoft entry page. The original
      // remoteconnect URL is retained for diagnostics, but some browsers or
      // locales fail to render that direct endpoint correctly.
      verificationUri: 'https://www.microsoft.com/link',
      directUri: rawUri || ''
    }
    this.pendingDeviceCode = payload
    this.emit('device-code', payload)
    this.log('info', 'Microsoft device-code window opened. Complete authorization in the browser.')
    return true
  }

  handleLine(line, sourceChild = null, sourceGeneration = null) {
    if (sourceChild && !this.isCurrentChild(sourceChild, sourceGeneration)) return false
    let event
    try { event = JSON.parse(line) } catch {
      if (!this.handleAuthLine(line) && line.trim()) this.log('debug', `[Azalea] ${this.stripAnsi(line)}`)
      return
    }
    if (event.type === 'status') this.update({ status: event.status === 'authenticating' ? 'connecting' : event.status, engine: 'Azalea', version: '26.2' })
    else if (event.type === 'authenticated') {
      const existing = this.accountData.accounts.find(item => item.id === this.currentAccountId)
      if (existing) existing.username = event.username
      else this.accountData.accounts.push({ id: this.currentAccountId, username: event.username, addedAt: new Date().toISOString() })
      this.accountData.activeId = this.currentAccountId
      this.saveAccounts()
      this.update({ status: 'authenticated', username: event.username, accountConnected: true })
      this.log('success', `Microsoft account authenticated: ${event.username}. Waiting for the game-world connection.`)
    } else if (event.type === 'spawn') {
      this.lastMovementPosition = null
      if (this.hubModeActive) this.hubSpawnClearanceRequired = true
      this.skyBlockPresenceConfirmed = false
      this.clearConnectionFailureWatchdog()
      this.clearIslandRecovery()
      this.reconnectAttempts = 0
      this.proxyEndpointRefusalCount = 0
      this.lastProxyEndpointRefusalGeneration = null
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.update({
        status: 'connected',
        username: event.username || this.state.username,
        version: '26.2',
        location: { known: false, name: '', onIsland: false },
        hubMode: this.hubModeActive
      })
      // Older bundled bridges scheduled their own unconditional /skyblock
      // and /bz pair after the first spawn. Toggle native Hub mode once to
      // mark that legacy pair as handled, then let this controller's
      // location-confirmed command gate own every transition. This remains
      // harmless with newer bridges where the legacy scheduler is removed.
      if (!this.hubModeActive && this.isAlive()) {
        this.send({ command: 'hub_mode', enabled: true })
        this.send({ command: 'hub_mode', enabled: false })
      }
      this.log('success', `World spawn #${event.count} received.`)
      this.emit('world-spawn', { count: Number(event.count) || 0, username: event.username || this.state.username, hubMode: this.hubModeActive })
    } else if (event.type === 'chat') {
      // Guild chatter is unrelated to Bazaar automation and can be extremely
      // noisy. Drop it before it reaches automation, disk logs, or the UI.
      const cleanChat = this.cleanText(event.text || '')
      if (/^Guild\s*>/i.test(cleanChat)) return
      const prototypeLobbyConfirmed = /(?:being transferred to the Prototype Lobby for being AFK|reached your Hype limit.*Prototype Lobby minigames)/i.test(cleanChat)
      if (prototypeLobbyConfirmed) {
        this.skyBlockPresenceConfirmed = false
        this.clearHubTeleportRetry()
        this.lastMovementPosition = null
        this.hubSpawnClearanceRequired = this.hubModeActive === true
        this.completeBazaarNpcAttempt({ opened: false, reason: 'Prototype Lobby was confirmed before the NPC interaction completed.' })
        this.resolveHubSpawnClearance(new Error('Prototype Lobby was confirmed; waiting to enter SkyBlock and Hub again.'))
        this.update({ location: { known: true, name: 'Prototype Lobby', onIsland: false }, window: '' })
        this.log('warning', 'Prototype Lobby confirmed from server chat. Hub and SkyBlock confirmation were cleared; Bazaar is blocked until /skyblock and /hub complete again.')
      }
      if (/^(?:Sending to server|Evacuating to (?:Hub|Lobby))/i.test(cleanChat)) {
        this.skyBlockPresenceConfirmed = false
        this.noteHubTeleportTransfer()
        this.update({ location: { known: false, name: '', onIsland: false } })
      }
      if (/^Warping\.\.\.$/i.test(cleanChat)) this.noteHubTeleportTransfer()
      if (/^You are already playing SkyBlock!?$/i.test(cleanChat)) {
        this.skyBlockPresenceConfirmed = true
        this.log('success', 'SkyBlock confirmed from the Hypixel already-playing response.')
        this.executePendingSkyBlockCommand()
      }
      if (/(?:appears on your island at|already on your island)/i.test(cleanChat) && !this.state.location?.onIsland) {
        this.skyBlockPresenceConfirmed = true
        this.update({ location: { known: true, name: 'Your Island', onIsland: true } })
        this.clearIslandRecovery()
        this.log('success', 'Your Island confirmed from Hypixel island chat.')
        this.executePendingSkyBlockCommand()
      }
      this.handleOrderChat(event.text)
      this.emit('chat', { at: new Date().toISOString(), text: event.text, ansi: event.ansi, sender: event.sender, content: event.content, packet: event.packet })
    } else if (event.type === 'overlay') {
      this.emit('chat-packet', { at: new Date().toISOString(), kind: 'overlay', text: event.text, ansi: event.ansi, sender: event.sender, content: event.content, packet: event.packet })
    } else if (event.type === 'screen') {
      const packetId = this.screenPacketId(event)
      const labels = ['create buy order', 'create sell offer', 'buy instantly', 'sell instantly', 'manage orders', 'cancel order', 'claim order', 'claim items', 'claim coins']
      const actions = labels.flatMap(label => {
        const match = this.findSlot(event, label)
        return match ? [{ action: label.replaceAll(' ', '-'), label, slot: match.slot }] : []
      })
      this.lastWindow = { title: event.title, slots: event.slots, actions }
      if (this.bazaarNpcAttempt && /(?:^|\b)bazaar(?:\b|\s*->)/i.test(this.cleanText(event.title || ''))) {
        this.bazaarNpcAttempt.guiConfirmed = true
        if (this.bazaarNpcAttempt.clicked) this.completeBazaarNpcAttempt({ opened: true, reason: 'Verified NPC right-click and Bazaar GUI were both confirmed.' })
      }
      this.screenPacketIds.set(this.lastWindow, packetId)
      const patch = { window: event.title }
      const cookie = this.parseBoosterCookie(event)
      if (cookie) {
        patch.cookieRemainingSeconds = cookie.remainingSeconds
        patch.cookieUpdatedAt = new Date().toISOString()
        const previous = Number(this.state.cookieRemainingSeconds)
        if (!Number.isFinite(previous) || Math.abs(previous - cookie.remainingSeconds) >= 60) {
          this.log('debug', `[Cookie Tracker] Booster Cookie duration detected: ${cookie.durationText}.`)
        }
      }
      // Hypixel can publish a new title one packet before the slots belonging
      // to that title arrive. In that short transition, "Your Bazaar Orders"
      // may still contain the Bazaar root's Sell Inventory Now / Manage
      // Orders controls. Never replace the real order snapshot with those
      // stale slots.
      const parsedOrders = /(?:manage orders|bazaar orders)/i.test(this.cleanText(event.title || ''))
        ? this.parseOrders(event)
        : []
      if (this.isStableOrdersScreen(event, parsedOrders)) patch.orders = parsedOrders
      this.update(patch)
      this.emit('window', this.lastWindow)
      this.advanceOrderAction(event)
    } else if (event.type === 'hotbar_item_ready') {
      this.emit('hotbar-item-ready', { name: this.cleanText(event.name), slot: Number(event.slot) })
    } else if (event.type === 'hotbar_item_error') {
      this.emit('hotbar-item-error', { name: this.cleanText(event.name), message: this.cleanText(event.message) })
    } else if (event.type === 'log') this.log(event.level || 'info', event.message || '')
    else if (event.type === 'command') this.log(event.level || 'info', event.message || this.cleanText(event.text || ''))
    else if (event.type === 'daily_limit') this.rotateAccount(event.message)
    else if (event.type === 'location_reset') {
      this.update({ location: { known: false, name: '', onIsland: false } })
      this.log('debug', `Location confirmation cleared: ${this.cleanText(event.reason || 'scoreboard location was reset')}.`)
    }
    else if (event.type === 'location') {
      const onIsland = Boolean(event.onIsland)
      const detected = this.cleanText(event.name)
      const hub = !onIsland && isHubLocation(detected)
      if (onIsland || hub) this.skyBlockPresenceConfirmed = true
      this.update({ location: { known: true, name: onIsland ? 'Your Island' : detected, onIsland } })
      if (hub) this.clearHubTeleportRetry()
      if (onIsland || (this.hubModeActive && hub)) this.clearIslandRecovery()
      this.log(onIsland || hub ? 'success' : 'warning', `Location detected: ${onIsland ? 'Your Island' : detected}.`)
      if (onIsland || hub) this.executePendingSkyBlockCommand()
    } else if (event.type === 'purse') {
      const clean = this.cleanText(event.text || '')
      const raw = clean.match(/(?:purse|piggy(?:\s+bank)?)\s*:?\s*[^0-9]*([\d,.]+\s*[KMGBT]?)/i)?.[1]
      const purse = this.parseCoinAmount(raw)
      if (Number.isFinite(purse)) {
        this.skyBlockPresenceConfirmed = true
        this.update({ purse, purseUpdatedAt: new Date().toISOString() })
        this.executePendingSkyBlockCommand()
        this.log('debug', `[Purse Tracker] Detected ${purse.toLocaleString('en-US')} coins from scoreboard row: ${clean}`)
      } else {
        this.log('warning', `[Purse Tracker] Received a scoreboard purse row but could not parse it: ${clean}`)
      }
    } else if (event.type === 'movement_state') {
      const position = this.finiteMovementPosition(event.position || event)
      if (position) {
        this.lastMovementPosition = position
        if (this.hubSpawnClearanceRequired && this.hubSpawnDistance(position) >= 5) {
          this.hubSpawnClearanceRequired = false
          this.resolveHubSpawnClearance()
          this.log('success', '[Hub Roaming] Spawn clearance confirmed at 5+ blocks; Bazaar may now open.')
        }
      }
      this.confirmHubFromMovement(event)
      this.emit('movement-state', { ...event })
    } else if (event.type === 'path_result') {
      this.emit('path-result', { ...event })
    } else if (event.type === 'bazaar_interact_result') {
      if (this.bazaarNpcAttempt && String(event.requestId || event.request_id || '') === this.bazaarNpcAttempt.requestId) {
        if (event.success === false) this.completeBazaarNpcAttempt({ opened: false, reason: this.cleanText(event.reason || 'NPC target was not verified.') })
        else {
          this.bazaarNpcAttempt.clicked = true
          this.bazaarNpcAttempt.native = { ...event }
          if (this.bazaarNpcAttempt.guiConfirmed) this.completeBazaarNpcAttempt({ opened: true, reason: 'Verified NPC right-click and Bazaar GUI were both confirmed.' })
        }
      }
    } else if (event.type === 'movement_failsafe') {
      const reason = this.cleanText(event.reason || 'Unexpected server movement correction detected.')
      this.emergencyStop(`[MOVEMENT FAILSAFE] ${reason}`)
      this.emit('movement-failsafe', { ...event, reason })
      return true
    } else if (event.type === 'reconnect_required') this.reconnectCurrent(event.reason)
    else if (event.type === 'disconnect' || event.type === 'connection_failed' || event.type === 'fatal') {
      this.completeBazaarNpcAttempt({ opened: false, reason: 'Connection ended during the NPC interaction.' })
      const ban = parseBanDisconnect(event)
      if (ban) {
        const detection = { ...ban, detectedAt: new Date().toISOString(), username: this.state.username, accountId: this.currentAccountId || this.accountData.activeId }
        this.emergencyStop(`Ban disconnect detected: ${ban.reason}`)
        this.log('error', `[BAN SAFETY] Server ban disconnect detected at ${detection.detectedAt}; duration: ${ban.durationText}; ${ban.reason}`)
        this.emit('ban-detected', detection)
        return true
      }
      const rawMessage = [event.reason || event.display || event.message, event.detail].filter(Boolean).join(' · ')
      this.hubModeActive = false
      const proxyEnabled = this.readConfig()?.proxy?.enabled === true
      const proxyAuthFailure = proxyEnabled && isProxyAuthenticationFailure(rawMessage)
      const proxyEndpointFailed = proxyEnabled && isProxyEndpointFailure(rawMessage)
      const proxyAuthStatus = rawMessage.match(/invalid authentication status\s*:\s*(\d+)\b/i)?.[1] || 'nonzero'
      if (proxyEndpointFailed) {
        const refusalGeneration = sourceChild ? sourceGeneration : this.connectionGeneration
        if (this.lastProxyEndpointRefusalGeneration !== refusalGeneration) {
          this.lastProxyEndpointRefusalGeneration = refusalGeneration
          this.proxyEndpointRefusalCount += 1
        }
      }
      const message = proxyAuthFailure
        ? `SOCKS5 proxy rejected its username/password (authentication status ${proxyAuthStatus}). Update or renew this instance proxy credentials; the Microsoft account is valid and direct-IP fallback remains blocked.`
        : proxyEndpointFailed
          ? `SOCKS5 proxy endpoint failed or timed out (10060/10061/ETIMEDOUT/ECONNREFUSED; attempt ${this.proxyEndpointRefusalCount} of 5). Check that this proxy endpoint/port is active and that the provider permits enough simultaneous endpoints; direct-IP fallback remains blocked.`
        : rawMessage
      this.update({ status: 'disconnected', lastError: message, hubMode: false })
      this.log('error', `${event.type}: ${message}`)
      if (proxyAuthFailure) {
        this.blockConnection(message)
        this.emit('proxy-auth-failed', { at: new Date().toISOString(), message, accountId: this.currentAccountId || this.accountData.activeId })
        return true
      }
      // Four bounded retries use the advertised 15/30/45/60-second sequence.
      // A fifth consecutive refusal proves this endpoint is not recovering;
      // stop only this instance instead of hammering a dead proxy forever.
      if (proxyEndpointFailed && this.proxyEndpointRefusalCount >= 5) {
        this.blockConnection(message)
        this.update({ status: 'proxy-unavailable' })
        this.emit('proxy-endpoint-failed', { at: new Date().toISOString(), message, accountId: this.currentAccountId || this.accountData.activeId })
        return true
      }
      this.armConnectionFailureWatchdog(`${event.type}: ${message}`, sourceChild || this.process, sourceChild ? sourceGeneration : this.connectionGeneration)
    }
    return true
  }

  cleanText(value) {
    return this.stripAnsi(value).replace(/\u00A7./g, '').replace(/[\uE000-\uF8FF]/g, '').trim()
  }
  parseBoosterCookie(screen) {
    let best = null
    for (const slot of screen.slots || []) {
      if (!/booster\s*cookie/i.test(this.cleanText(slot.name || ''))) continue
      const lore = (slot.lore || []).map(line => this.cleanText(line)).join(' ')
      if (/(?:duration\s*[:\-]?\s*)?(?:expired|inactive|not active)|no active booster cookie/i.test(lore)) {
        if (!best) best = { remainingSeconds: 0, durationText: 'Expired' }
        continue
      }
      const durationText = lore.match(/duration\s*[:\-]?\s*((?:\d+\s*[dhms]\s*)+)/i)?.[1]?.trim()
      if (!durationText) continue
      let remainingSeconds = 0
      let units = 0
      for (const match of durationText.matchAll(/(\d+)\s*([dhms])/gi)) {
        remainingSeconds += Number(match[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 }[match[2].toLowerCase()] || 0)
        units += 1
      }
      if (units && (!best || remainingSeconds > best.remainingSeconds)) best = { remainingSeconds, durationText }
    }
    return best
  }
  parseCoinAmount(value) {
    const original = String(value || '').trim()
    const match = original.replaceAll(',', '').match(/^([\d.]+)\s*([KMGBT])?$/i)
    if (!match) return NaN
    // Hypixel's full purse value uses comma-separated digits. A letter
    // immediately following that value can be a hidden scoreboard entry, not
    // a compact-number suffix; accepting it caused values such as 295,838M.
    if (match[2] && original.includes(',')) return NaN
    return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(match[2] || '').toUpperCase()] || 1)
  }
  parseOrders(screen) {
    const parsed = (screen.slots || []).flatMap(slot => {
      const name = this.cleanText(slot.name || '')
      const lore = (slot.lore || []).map(line => this.cleanText(line)).filter(Boolean)
      const searchable = [name, ...lore, this.cleanText(slot.item || '')].join(' ').toLowerCase()
      const headingType = /^(?:buy(?: order)?)(?:\s*[:\-]|\s+)/i.test(name)
        ? 'buy'
        : /^(?:sell(?: offer)?)(?:\s*[:\-]|\s+)/i.test(name)
          ? 'sell'
          : ''
      const explicitType = /\bbuy order\b/i.test(name) ? 'buy' : /\bsell offer\b/i.test(name) ? 'sell' : ''
      const type = headingType || explicitType
      const hasOrderDetails = /(?:order|offer) amount\s*:\s*[\d,]+x|filled\s*:\s*[\d,]+\s*\/\s*[\d,]+|price per unit\s*:|items?\s+to claim|coins\s+to claim/i.test(searchable)
      const isBazaarControl = /^(?:sell inventory now|buy instantly|sell instantly|manage orders|bazaar history|bazaar settings|claim all coins|go back)\b/i.test(name)
      // BUY/SELL order headings need actual order lore. This prevents action
      // controls such as "Sell Inventory Now" from becoming fake orders.
      if (!type || isBazaarControl || /create (?:a )?(?:buy order|sell offer)/.test(searchable) || (!explicitType && !hasOrderDetails)) return []
      const itemName = name.replace(/^(?:buy(?: order)?|sell(?: offer)?)\s*[:\-]?\s*/i, '').trim() || this.cleanText(slot.kind || 'Unknown item')
      const amount = searchable.match(/(?:order|offer) amount\s*:\s*([\d,]+)x/i) || searchable.match(/filled\s*:\s*[\d,]+\s*\/\s*([\d,]+)/i)
      const count = amount ? Number(amount[1].replaceAll(',', '')) : Number(slot.count) || 0
      const fill = searchable.match(/filled\s*:\s*([\d,]+)\s*\/\s*([\d,]+)(?:\s*\(([\d.]+)%\))?/i)
      const filledCount = fill ? Number(fill[1].replaceAll(',', '')) : 0
      const totalCount = fill ? Number(fill[2].replaceAll(',', '')) : count
      const filledPercent = fill?.[3] ? Number(fill[3]) : totalCount > 0 ? filledCount / totalCount * 100 : 0
      const worthRaw = searchable.match(/\bworth\s*:?\s*([\d,.]+\s*[kmgbt]?)\s*coins/i)?.[1]
      const unitPriceRaw = searchable.match(/price per unit\s*:\s*([\d,.]+\s*[kmgbt]?)\s*coins/i)?.[1]
      const claimableItems = Number(searchable.match(/you have\s+([\d,]+)\s+items?\s+to claim/i)?.[1]?.replaceAll(',', '') || 0)
      const claimableCoinsRaw = searchable.match(/you have\s+([\d,.]+\s*[kmgbt]?)\s+coins\s+to claim/i)?.[1]
      const worthCoins = this.parseCoinAmount(worthRaw)
      const unitPriceCoins = this.parseCoinAmount(unitPriceRaw)
      const claimableCoins = this.parseCoinAmount(claimableCoinsRaw)
      const totalWorthCoins = Number.isFinite(unitPriceCoins) && totalCount > 0 ? totalCount * unitPriceCoins : Number.isFinite(worthCoins) ? worthCoins : 0
      const collectedCoins = Number.isFinite(claimableCoins) ? claimableCoins : Number.isFinite(unitPriceCoins) ? filledCount * unitPriceCoins : 0
      const complete = Boolean(/filled!/i.test(searchable) || (totalCount > 0 && filledCount >= totalCount) || filledPercent >= 99.999 || (!fill && /you have [\d,]+ (?:items?|coins) to claim/i.test(searchable)))
      const owner = lore.map(line => line.match(/\bby\s*:\s*(.+)$/i)?.[1]?.trim()).find(Boolean) || ''
      // Claim text is often at the bottom of long sell-order lore. Keeping the
      // complete lore lets automation recognize "coins to claim" reliably.
      return [{ id: `${type}:${slot.slot}:${itemName}`, type, itemName, owner, count, filledCount, totalCount, filledPercent, claimableItems, claimableCoins: Number.isFinite(claimableCoins) ? claimableCoins : 0, collectedCoins, totalWorthCoins, unitPriceCoins: Number.isFinite(unitPriceCoins) ? unitPriceCoins : 0, complete, slot: slot.slot, details: lore }]
    })
    const previous = Array.isArray(this.state.orders) ? this.state.orders : []
    const unmatchedPrevious = new Set(previous.map((_, index) => index))
    const matches = new Array(parsed.length).fill(null)
    const previousMatchCounts = new Map()
    const parsedMatchCounts = new Map()
    for (const order of previous) {
      const key = this.orderMatchKey(order)
      previousMatchCounts.set(key, (previousMatchCounts.get(key) || 0) + 1)
    }
    for (const order of parsed) {
      const key = this.orderMatchKey(order)
      parsedMatchCounts.set(key, (parsedMatchCounts.get(key) || 0) + 1)
    }
    // Two rows with the same type/item/amount/price are observationally
    // identical. If that group shrinks, a card that moved into the vacated
    // slot cannot safely inherit either old row's timestamp. Reset ambiguous
    // survivors rather than assigning the removed row's age by slot.
    const ambiguousShrinkingMatches = new Set([...previousMatchCounts]
      .filter(([key, count]) => count > 1
        && (parsedMatchCounts.get(key) || 0) > 0
        && (parsedMatchCounts.get(key) || 0) < count)
      .map(([key]) => key))

    // First preserve exact rows, then reconcile a row that moved because a
    // neighbouring order disappeared. Fill progress is deliberately excluded
    // from orderMatchKey so ordinary fills never change an order's age.
    for (let index = 0; index < parsed.length; index += 1) {
      if (ambiguousShrinkingMatches.has(this.orderMatchKey(parsed[index]))) continue
      const exact = previous.findIndex((order, previousIndex) => unmatchedPrevious.has(previousIndex) &&
        this.orderStructureKey(order) === this.orderStructureKey(parsed[index]) &&
        this.orderMatchKey(order) === this.orderMatchKey(parsed[index]))
      if (exact >= 0) {
        matches[index] = previous[exact]
        unmatchedPrevious.delete(exact)
      }
    }
    for (let index = 0; index < parsed.length; index += 1) {
      if (matches[index]) continue
      if (ambiguousShrinkingMatches.has(this.orderMatchKey(parsed[index]))) continue
      const moved = previous.findIndex((order, previousIndex) => unmatchedPrevious.has(previousIndex) &&
        this.orderMatchKey(order) === this.orderMatchKey(parsed[index]))
      if (moved >= 0) {
        matches[index] = previous[moved]
        unmatchedPrevious.delete(moved)
      }
    }

    const now = Date.now()
    let orderTimesChanged = false
    const migratedLegacyKeys = new Set()
    for (let index = 0; index < parsed.length; index += 1) {
      const order = parsed[index]
      const semanticKey = this.orderTimeKey(order.type, order.itemName)
      const rowKey = this.orderRowTimeKey(order.type, order.itemName, order.slot)
      const ambiguousIdentity = ambiguousShrinkingMatches.has(this.orderMatchKey(order))
      const pending = (this.pendingOrderPlacements.get(semanticKey) || [])
        .filter(entry => Number(entry.expiresAt) > now)
      if (pending.length > 0) this.pendingOrderPlacements.set(semanticKey, pending)
      else this.pendingOrderPlacements.delete(semanticKey)

      let placedAt = Number(matches[index]?.placedAt)
      // An unmatched row following a Setup chat line is the newly-created
      // sibling. Consume exactly one FIFO entry for it; existing siblings keep
      // their independent timestamps.
      if (!Number.isFinite(placedAt) && pending.length > 0) {
        placedAt = Number(pending.shift()?.placedAt)
        if (pending.length > 0) this.pendingOrderPlacements.set(semanticKey, pending)
        else this.pendingOrderPlacements.delete(semanticKey)
      }
      if (!Number.isFinite(placedAt) && !ambiguousIdentity) placedAt = Number(this.orderTimes[rowKey])
      // One-time compatibility with order-times.json written by older builds.
      if (!Number.isFinite(placedAt) && !ambiguousIdentity) {
        placedAt = Number(this.orderTimes[semanticKey])
        if (Number.isFinite(placedAt)) migratedLegacyKeys.add(semanticKey)
      }
      if (!Number.isFinite(placedAt)) placedAt = now
      placedAt = Math.max(1, placedAt)
      order.placedAt = placedAt
      if (Number(this.orderTimes[rowKey]) !== placedAt) {
        this.orderTimes[rowKey] = placedAt
        orderTimesChanged = true
      }
    }
    for (const legacyKey of migratedLegacyKeys) {
      delete this.orderTimes[legacyKey]
      orderTimesChanged = true
    }
    if (orderTimesChanged) this.saveOrderTimes()
    return parsed
  }
  isStableOrdersScreen(screen, parsedOrders = null) {
    const title = this.cleanText(screen?.title || '')
    if (!/(?:manage orders|bazaar orders)/i.test(title)) {
      this.resetEmptyOrdersObservation()
      return false
    }
    const names = (screen.slots || []).map(slot => this.cleanText(slot.name || ''))
    const orders = Array.isArray(parsedOrders) ? parsedOrders : this.parseOrders(screen)
    // These only belong to the Bazaar root/category screen. Their presence
    // under an orders title proves the slot packet is transitional.
    const hasRootTransitionControl = names.some(name => /^(?:sell inventory now|manage orders|bazaar history|bazaar settings)$/i.test(name))
    if (orders.length === 0 && hasRootTransitionControl) {
      this.resetEmptyOrdersObservation()
      return false
    }
    const hasOrdersControl = names.some(name => /^(?:claim all coins|go back)$/i.test(name))
    if (orders.length === 0 && names.length > 0 && !hasOrdersControl) {
      this.resetEmptyOrdersObservation()
      return false
    }

    const now = Date.now()
    const identities = orders.map(order => this.orderStructureKey(order)).sort()
    const fingerprint = `${title.toLowerCase()}|${identities.join('|')}|${orders.length === 0 ? 'empty' : 'orders'}`
    const stateIdentities = (this.state.orders || []).map(order => this.orderStructureKey(order)).sort()
    const stateFingerprint = `${title.toLowerCase()}|${stateIdentities.join('|')}|${stateIdentities.length === 0 ? 'empty' : 'orders'}`
    // Once a structure was confirmed, fill/claim numbers may update without
    // another delay. Structural additions/removals still need fresh packets.
    if (this.confirmedOrdersSnapshot && fingerprint === stateFingerprint) {
      this.ordersScreenObservation = null
      this.emptyOrdersObservation = null
      return true
    }

    const packetId = this.screenPacketId(screen)
    let observation = this.ordersScreenObservation
    const currentIsSuperset = observation && observation.identities.every(identity => identities.includes(identity))
    if (!observation || now - observation.firstAt > 5000 || (observation.fingerprint !== fingerprint && !currentIsSuperset)) {
      observation = { fingerprint, identities, firstAt: now, packetIds: new Set([packetId]) }
      this.ordersScreenObservation = observation
      this.emptyOrdersObservation = observation
      return false
    }

    observation.fingerprint = fingerprint
    observation.identities = identities
    observation.packetIds.add(packetId)
    const observedFor = now - observation.firstAt
    // Azalea normally emits several inventory packets while a GUI fills in,
    // but a completely unchanged Manage screen can legitimately arrive as one
    // final packet. After a full second, accept that same packet only when it
    // contains authoritative order-list evidence and no stale Bazaar-root
    // controls. Transitional/partial packets still require a second packet.
    const settledSinglePacket = observation.packetIds.size === 1
      && observedFor >= 1000
      && observation.fingerprint === fingerprint
      && !hasRootTransitionControl
      && (orders.length > 0 || hasOrdersControl)
    if ((observation.packetIds.size >= 2 && observedFor >= 250) || settledSinglePacket) {
      this.confirmedOrdersSnapshot = true
      this.ordersScreenObservation = null
      this.emptyOrdersObservation = null
      return true
    }
    return false
  }
  slotText(slot) {
    return this.cleanText([slot.name || '', ...(slot.lore || []), slot.item || ''].join(' ')).toLowerCase()
  }
  findSlot(screen, phrase) {
    const needle = String(phrase).toLowerCase()
    return (screen.slots || []).find(slot => {
      const text = this.slotText(slot)
      if (text.includes(needle)) return true
      if (needle === 'cancel order') return /\bcancel (?:buy |sell )?order\b/.test(text)
      if (needle === 'cancel offer') return /\bcancel (?:buy |sell )?offer\b/.test(text)
      return false
    })
  }
  bazaarSearchDelayRange(itemName) {
    const settings = this.readConfig()?.automation?.bazaarSearchTyping || {}
    if (settings.enabled === false) return { minMs: 0, maxMs: 0 }
    const length = String(itemName || '').length
    const shortMax = Number.isFinite(settings.shortNameMaxChars) ? settings.shortNameMaxChars : 8
    const mediumMax = Number.isFinite(settings.mediumNameMaxChars) ? settings.mediumNameMaxChars : 16
    if (length <= shortMax) return {
      minMs: Number.isFinite(settings.shortDelayMinMs) ? settings.shortDelayMinMs : 2000,
      maxMs: Number.isFinite(settings.shortDelayMaxMs) ? settings.shortDelayMaxMs : 3000
    }
    if (length <= mediumMax) return {
      minMs: Number.isFinite(settings.mediumDelayMinMs) ? settings.mediumDelayMinMs : 3000,
      maxMs: Number.isFinite(settings.mediumDelayMaxMs) ? settings.mediumDelayMaxMs : 6000
    }
    const extra = (length - mediumMax) * (Number.isFinite(settings.extraDelayPerCharacterMs) ? settings.extraDelayPerCharacterMs : 150)
    const maximum = Number.isFinite(settings.maximumDelayMs) ? settings.maximumDelayMs : 9000
    const minMs = Math.min(maximum, (Number.isFinite(settings.mediumDelayMinMs) ? settings.mediumDelayMinMs : 3000) + extra)
    const maxMs = Math.max(minMs, Math.min(maximum, (Number.isFinite(settings.mediumDelayMaxMs) ? settings.mediumDelayMaxMs : 6000) + extra))
    return { minMs, maxMs }
  }
  async openItemByName(itemName) {
    const name = this.cleanText(itemName)
    if (!name || name.length > 100 || /[\r\n]/.test(name)) throw new Error('Invalid Bazaar item name.')
    const generation = ++this.bazaarSearchGeneration
    const accountId = this.currentAccountId || this.accountData.activeId
    const child = this.process
    const { minMs, maxMs } = this.bazaarSearchDelayRange(name)
    const delayMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
    this.log('info', `Preparing /bz ${name}: ${(delayMs / 1000).toFixed(2)}s typing delay for ${name.length} Item name characters.`)
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    if (generation !== this.bazaarSearchGeneration || child !== this.process || accountId !== (this.currentAccountId || this.accountData.activeId)) return false
    return this.sendChat(`/bz ${name}`)
  }
  cancelBazaarSearch() { this.bazaarSearchGeneration += 1 }
  manageOrders() {
    this.pendingOrderAction = { action: 'refresh', phase: 'bazaar' }
    return this.sendChat('/bz')
  }
  actOnOrder(orderId, action) {
    if (!['claim', 'cancel'].includes(action)) throw new Error('Unknown order action.')
    const order = (this.state.orders || []).find(item => item.id === orderId)
    if (!order) throw new Error('Order is no longer present. Refresh Manage Orders.')
    this.pendingOrderAction = { action, phase: 'bazaar', target: { type: order.type, itemName: order.itemName } }
    return this.sendChat('/bz')
  }
  scheduleOrderRefresh(delayMs = 900) {
    if (this.orderRefreshTimer) clearTimeout(this.orderRefreshTimer)
    this.orderRefreshTimer = setTimeout(() => {
      this.orderRefreshTimer = null
      // The card was already removed optimistically. Refresh in the background
      // so the remaining cards never flash to an empty order list.
      if (!this.pendingOrderAction && this.process?.stdin?.writable) this.manageOrders()
    }, delayMs)
    this.orderRefreshTimer.unref?.()
  }
  clearOrdersAndInventory() {
    if (this.pendingOrderAction) throw new Error('Another Bazaar order action is already running.')
    this.pendingOrderAction = { action: 'clear-all', phase: 'bazaar', cancelled: 0, claimed: 0 }
    if (this.clearWatchdogTimer) clearTimeout(this.clearWatchdogTimer)
    this.clearWatchdogTimer = setTimeout(() => {
      this.finishClearOrdersAndInventory('Clear Orders / Inventory timed out safely; automatic trading resumed.')
    }, 90000)
    this.clearWatchdogTimer.unref?.()
    this.log('warning', 'Clear Orders / Inventory started: active orders will be claimed or cancelled, then inventory will be sold instantly.')
    return this.sendChat('/bz')
  }
  recoverClaimInventory(target = null) {
    if (this.pendingOrderAction) return false
    this.pendingOrderAction = { action: 'claim-inventory-recovery', phase: 'inventory-bazaar', target: target ? { ...target } : null }
    if (this.clearWatchdogTimer) clearTimeout(this.clearWatchdogTimer)
    this.clearWatchdogTimer = setTimeout(() => {
      this.finishClaimInventoryRecovery(false, 'Automatic inventory recovery timed out; clear one inventory slot manually.')
    }, 45000)
    this.clearWatchdogTimer.unref?.()
    this.log('warning', `Inventory is full while claiming ${target?.itemName || 'a completed buy order'}. Opening Sell Inventory Now once to free claim space.`)
    return this.sendChat('/bz')
  }
  finishClaimInventoryRecovery(success, message) {
    const pending = this.pendingOrderAction
    if (!pending || pending.action !== 'claim-inventory-recovery') return false
    if (this.clearCompletionTimer) clearTimeout(this.clearCompletionTimer)
    if (this.clearWatchdogTimer) clearTimeout(this.clearWatchdogTimer)
    this.clearCompletionTimer = null
    this.clearWatchdogTimer = null
    this.pendingOrderAction = null
    this.log(success ? 'success' : 'error', message)
    this.emit('claim-inventory-recovery-complete', { success, message, target: pending.target || null })
    return true
  }
  scheduleClearOrdersRefresh(delayMs = 1400) {
    if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
    this.clearOrdersTimer = setTimeout(() => {
      this.clearOrdersTimer = null
      const pending = this.pendingOrderAction
      if (!pending || pending.action !== 'clear-all') return
      pending.phase = 'bazaar'
      this.sendChat('/bz')
    }, delayMs)
    this.clearOrdersTimer.unref?.()
  }
  finishClearOrdersAndInventory(message, level = 'success') {
    const pending = this.pendingOrderAction
    if (!pending || pending.action !== 'clear-all') return false
    if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
    if (this.clearCompletionTimer) clearTimeout(this.clearCompletionTimer)
    if (this.clearWatchdogTimer) clearTimeout(this.clearWatchdogTimer)
    this.clearOrdersTimer = null
    this.clearCompletionTimer = null
    this.clearWatchdogTimer = null
    this.pendingOrderAction = null
    this.log(level, message)
    this.emit('manual-order-action-complete')
    return true
  }
  resumeClearAfterInventorySale(message = 'Inventory sold; returning to Manage Orders to retry the interrupted claim.') {
    const pending = this.pendingOrderAction
    if (!pending || pending.action !== 'clear-all' || !pending.resumeAfterInventorySale) return false
    if (this.clearCompletionTimer) clearTimeout(this.clearCompletionTimer)
    this.clearCompletionTimer = null
    pending.resumeAfterInventorySale = false
    this.log('success', message)
    this.scheduleClearOrdersRefresh(900)
    return true
  }
  abortOrderAction() {
    if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
    if (this.clearCompletionTimer) clearTimeout(this.clearCompletionTimer)
    if (this.clearWatchdogTimer) clearTimeout(this.clearWatchdogTimer)
    if (this.orderRefreshTimer) clearTimeout(this.orderRefreshTimer)
    this.clearOrdersTimer = null
    this.clearCompletionTimer = null
    this.clearWatchdogTimer = null
    this.orderRefreshTimer = null
    this.pendingOrderAction = null
  }
  advanceOrderAction(screen) {
    const pending = this.pendingOrderAction
    if (!pending) return
    if (pending.phase === 'bazaar') {
      const manage = this.findSlot(screen, 'manage orders')
      if (!manage) return
      this.send({ command: 'click', slot: manage.slot })
      pending.phase = 'manage'
      if (pending.action === 'clear-all') this.scheduleClearOrdersRefresh(2500)
      this.log('info', 'Clicked Manage Orders.')
      return
    }
    if (pending.phase === 'manage' && /order/i.test(screen.title || '')) {
      if (pending.action === 'refresh') {
        this.pendingOrderAction = null
        this.log('success', 'Bazaar orders synchronized.')
        return
      }
      const orders = this.parseOrders(screen)
      if (pending.action === 'clear-all') {
        if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
        this.clearOrdersTimer = null
        const target = orders[0]
        if (!target) {
          pending.emptyManageObservations = Number(pending.emptyManageObservations || 0) + 1
          const now = Date.now()
          if (!pending.emptyManageFirstAt) pending.emptyManageFirstAt = now
          if (pending.emptyManageObservations < 2 || now - pending.emptyManageFirstAt < 700) {
            this.log('info', 'Manage Orders appeared empty; verifying once before selling inventory.')
            this.scheduleClearOrdersRefresh(900)
            return
          }
          pending.phase = 'inventory-bazaar'
          this.log('success', `All Bazaar orders cleared (${pending.cancelled} cancelled, ${pending.claimed} claimed). Opening Sell Inventory Now.`)
          this.sendChat('/bz')
          return
        }
        pending.emptyManageObservations = 0
        pending.emptyManageFirstAt = 0
        pending.target = { type: target.type, itemName: target.itemName }
        pending.phase = 'clear-order-result'
        this.send({ command: 'click', slot: target.slot })
        // A filled order claims immediately; an unfilled order opens its
        // options.  Re-open Manage Orders if no options packet arrives.
        this.scheduleClearOrdersRefresh()
        this.log('info', `Clearing ${target.type === 'buy' ? 'Buy Order' : 'Sell Offer'} for ${target.itemName}.`)
        return
      }
      const target = orders.find(order => order.type === pending.target.type && order.itemName.toLowerCase() === pending.target.itemName.toLowerCase())
      if (!target) {
        this.pendingOrderAction = null
        this.log('warning', `${pending.target.itemName} is no longer present in Manage Orders.`)
        return
      }
      this.send({ command: 'click', slot: target.slot })
      if (pending.action === 'claim') {
        this.update({ orders: (this.state.orders || []).filter(order => order.id !== target.id) })
        this.pendingOrderAction = null
        this.log('info', `Clicked ${target.itemName} to claim the filled order.`)
      } else {
        pending.phase = 'cancel'
        this.log('info', `Opened ${target.itemName}; waiting for Cancel Order.`)
      }
      return
    }
    if (pending.action === 'clear-all' && pending.phase === 'clear-order-result') {
      const cancel = this.findSlot(screen, 'cancel order') || this.findSlot(screen, 'cancel offer')
      if (!cancel) return
      if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
      this.send({ command: 'click', slot: cancel.slot })
      pending.cancelled += 1
      this.log('warning', `Cancelled ${pending.target.itemName}. Continuing Clear Orders / Inventory.`)
      this.scheduleClearOrdersRefresh(1200)
      return
    }
    if ((pending.action === 'clear-all' || pending.action === 'claim-inventory-recovery') && pending.phase === 'inventory-bazaar') {
      const sellInventory = this.findSlot(screen, 'sell inventory now')
      if (!sellInventory) return
      this.send({ command: 'click', slot: sellInventory.slot })
      pending.phase = 'inventory-confirm'
      this.log('info', 'Opened Sell Inventory Now.')
      // Some server implementations sell immediately and never send a second
      // confirmation window or a recognizable chat line.  Hand control back
      // after the GUI has had time to finish instead of pausing Auto Trader.
      this.clearCompletionTimer = setTimeout(() => {
        if (pending.action === 'claim-inventory-recovery') {
          this.finishClaimInventoryRecovery(true, 'Bazaar inventory sale completed; retrying the interrupted claim.')
        } else if (!this.resumeClearAfterInventorySale()) this.finishClearOrdersAndInventory('Clear Orders / Inventory completed; automatic trading resumed.')
      }, 5000)
      this.clearCompletionTimer.unref?.()
      return
    }
    if ((pending.action === 'clear-all' || pending.action === 'claim-inventory-recovery') && pending.phase === 'inventory-confirm') {
      // Never click the original Bazaar button twice when Azalea sends a
      // delayed duplicate frame.  Confirmation must be a distinct screen.
      if (/^bazaar\b/i.test(this.cleanText(screen.title || ''))) return
      const confirm = this.findSlot(screen, 'confirm') ||
        (screen.slots || []).find(slot => /confirm sale|sell all|click to confirm/i.test(this.slotText(slot)))
      if (!confirm) return
      this.send({ command: 'click', slot: confirm.slot })
      if (pending.action === 'claim-inventory-recovery') {
        this.finishClaimInventoryRecovery(true, 'Inventory sale confirmed; retrying the interrupted completed order.')
      } else if (!this.resumeClearAfterInventorySale('Inventory sale confirmed; returning to Manage Orders to retry the interrupted claim.')) {
        this.finishClearOrdersAndInventory('Clear Orders / Inventory completed. Remaining Bazaar inventory was sold instantly; automatic trading resumed.')
      }
      return
    }
    if (pending.phase === 'cancel') {
      const cancel = this.findSlot(screen, 'cancel order') || this.findSlot(screen, 'cancel offer')
      if (!cancel) return
      this.send({ command: 'click', slot: cancel.slot })
      this.update({ orders: (this.state.orders || []).filter(order => !(order.type === pending.target.type && order.itemName.toLowerCase() === pending.target.itemName.toLowerCase())) })
      this.pendingOrderAction = null
      this.log('warning', `Clicked Cancel Order for ${pending.target.itemName}.`)
      this.scheduleOrderRefresh()
    }
  }
  handleOrderChat(message) {
    const text = this.cleanText(message)
    const lower = text.toLowerCase()
    const pending = this.pendingOrderAction
    let placed
    if ((placed = text.match(/Buy Order Setup!\s*[\d,]+x\s+(.+?)\s+for\s+[\d,.]+\s+coins/i))) {
      this.rememberOrderTime('buy', placed[1])
    } else if ((placed = text.match(/Sell Offer Setup!\s*[\d,]+x\s+(.+?)\s+for\s+[\d,.]+\s+coins/i))) {
      this.rememberOrderTime('sell', placed[1])
    }
    if (pending?.action === 'clear-all' && /(?:do not|don't) have the space required to claim/.test(lower)) {
      if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
      this.clearOrdersTimer = null
      pending.inventoryRecoveryAttempts = Number(pending.inventoryRecoveryAttempts || 0) + 1
      if (pending.inventoryRecoveryAttempts > 2) {
        this.log('error', `Could not free enough inventory space to claim ${pending.target?.itemName || 'the filled order'} after two Sell Inventory Now attempts.`)
        this.finishClearOrdersAndInventory('Clear Orders / Inventory stopped safely; clear an inventory slot manually, then try again.', 'warning')
        return
      }
      pending.resumeAfterInventorySale = true
      pending.phase = 'inventory-bazaar'
      this.log('warning', `Inventory is full while claiming ${pending.target?.itemName || 'an order'}. Selling Bazaar inventory first, then returning to Manage Orders.`)
      this.sendChat('/bz')
      return
    }
    if (this.pendingOrderAction?.action === 'clear-all' && /claimed\s+[\d,]+x|claimed items/i.test(lower)) this.pendingOrderAction.claimed += 1
    if (this.pendingOrderAction?.action === 'clear-all' && /sold (?:your |the )?(?:entire )?inventory|inventory sold|insta(?:nt)? sell/i.test(lower)) {
      if (!this.resumeClearAfterInventorySale('Inventory sold; returning to Manage Orders to retry the interrupted claim.')) {
        this.finishClearOrdersAndInventory('Clear Orders / Inventory completed from the server confirmation message; automatic trading resumed.')
      }
    }
    if (this.pendingOrderAction?.action === 'clear-all' && /you don't have anything to sell/.test(lower)) {
      this.resumeClearAfterInventorySale('Sell Inventory Now found nothing sellable; returning to Manage Orders for one guarded retry.')
    }
    if (this.pendingOrderAction?.action === 'claim-inventory-recovery' && /sold (?:your |the )?(?:entire )?inventory|inventory sold|insta(?:nt)? sell/i.test(lower)) {
      this.finishClaimInventoryRecovery(true, 'Inventory sold; retrying the interrupted completed order.')
    }
    if (this.pendingOrderAction?.action === 'claim-inventory-recovery' && /you don't have anything to sell/.test(lower)) {
      this.finishClaimInventoryRecovery(false, 'Sell Inventory Now found nothing sellable; clear one inventory slot manually.')
    }
    if (/claim(?:ed)? all/.test(lower)) this.update({ orders: [] })
    else if (/cancel(?:led|ed)? (?:order|offer)/.test(lower)) {
      const remaining = (this.state.orders || []).filter(order => !lower.includes(order.itemName.toLowerCase()))
      if (remaining.length !== this.state.orders.length) this.update({ orders: remaining })
    }
  }
  armConnectionFailureWatchdog(reason, child = this.process, generation = this.connectionGeneration) {
    if (this.shuttingDown || this.safetyLockActive || this.connectionBlockedReason) return false
    if (!this.groupReconnectEnabled) {
      this.log('warning', `${reason} Auto Reconnect is disabled; this instance will remain stopped.`)
      this.stopChildImmediately(reason)
      return false
    }
    if (!this.isCurrentChild(child, generation)) {
      if (!this.process) this.scheduleReconnect(reason)
      return false
    }
    if (this.connectionFailureTimer) return true
    const groupDelays = [15000, 30000, 45000, 60000]
    const delayMs = groupDelays[Math.min(this.reconnectAttempts, groupDelays.length - 1)]
    this.log('warning', `${reason} Waiting ${(delayMs / 1000).toFixed(0)} seconds for bridge recovery before forcing a clean reconnect.`)
    this.connectionFailureTimer = setTimeout(() => {
      this.connectionFailureTimer = null
      this.forceReconnectAfterConnectionFailure(child, generation, reason)
    }, delayMs)
    this.connectionFailureTimer.unref?.()
    return true
  }
  forceReconnectAfterConnectionFailure(child, generation, reason) {
    if (this.shuttingDown || this.safetyLockActive || this.connectionBlockedReason || !this.groupReconnectEnabled || !this.isCurrentChild(child, generation)) return false
    const id = this.currentAccountId || this.accountData.activeId
    this.process = null
    this.connectionGeneration += 1
    this.cancelBazaarSearch()
    this.abortOrderAction()
    try { child.stdin?.write(`${JSON.stringify({ command: 'disconnect' })}\n`) } catch {}
    try { child.kill() } catch {}
    if (!id) {
      this.resetLiveSession({ lastError: reason })
      this.log('error', `${reason} No saved account is available for reconnect.`)
      return false
    }
    // The watchdog itself is the first retry (3 seconds normally, 15 seconds
    // in Start All mode). If this new child also fails, scheduleReconnect uses
    // the next 6/30 second step instead of repeating the first delay forever.
    this.reconnectAttempts += 1
    try {
      this.connect(id)
    } catch (error) {
      this.resetLiveSession({ lastError: error.message })
      this.log('error', `Forced Azalea reconnect failed: ${error.message}`)
      this.scheduleReconnect('Forced reconnect attempt failed.')
    }
    return true
  }
  reconnectCurrent(reason = 'Reconnect requested', delayMs = 3000) {
    if (this.shuttingDown || this.safetyLockActive || this.connectionBlockedReason) return false
    const id = this.currentAccountId || this.accountData.activeId
    if (!id) return false
    this.log('warning', `${reason} Reconnecting the current account.`)
    this.disconnect()
    return this.scheduleLifecycleConnect(id, delayMs, 'Reconnect failed')
  }
  scheduleReconnect(reason = 'Azalea is not running.') {
    if (this.shuttingDown || this.safetyLockActive || this.connectionBlockedReason) return false
    if (!this.groupReconnectEnabled) {
      this.update({ status: 'disconnected' })
      this.log('warning', `${reason} Auto Reconnect is disabled; this instance will remain stopped.`)
      return false
    }
    if (this.process || this.reconnectTimer) return false
    const id = this.currentAccountId || this.accountData.activeId
    if (!id) {
      this.log('error', `${reason} No saved account is available for reconnect.`)
      return false
    }
    const groupDelays = [15000, 30000, 45000, 60000]
    const delayMs = groupDelays[Math.min(this.reconnectAttempts, groupDelays.length - 1)]
    this.reconnectAttempts += 1
    this.update({ status: 'connecting', lastError: '' })
    this.log('warning', `${reason} Reconnecting automatically in ${(delayMs / 1000).toFixed(0)} seconds.`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      try { this.connect(id) } catch (error) {
        this.log('error', `Automatic Azalea reconnect failed: ${error.message}`)
        this.scheduleReconnect('Reconnect attempt failed.')
      }
    }, delayMs)
    this.reconnectTimer.unref?.()
    return true
  }

  setGroupReconnect(enabled) {
    const next = Boolean(enabled)
    if (next && this.safetyLockActive) return false
    if (this.groupReconnectEnabled === next) return next
    // Enabling group reconnect must not cancel the only retry that is already
    // pending. Disabling it is an explicit request to stop future retries.
    if (!next) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.clearConnectionFailureWatchdog()
      this.reconnectAttempts = 0
    }
    this.groupReconnectEnabled = next
    return next
  }

  addAccount() {
    if (this.accountLinkPromise) return this.accountLinkPromise
    const id = `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.accountLinkPromise = this.verifyAccountSlot(id, { register: true, makeActive: !this.process })
      .finally(() => { this.accountLinkPromise = null })
    return this.accountLinkPromise
  }
  selectAccount(id) {
    if (this.process) throw new Error('Disconnect before changing the active account.')
    if (!this.accountData.accounts.some(item => item.id === id)) throw new Error('Account not found.')
    this.accountData.activeId = id
    this.saveAccounts()
    const account = this.accountData.accounts.find(item => item.id === id)
    this.update({ username: account.username || '', accountConnected: true })
    return this.snapshot()
  }
  removeAccount(id) {
    if (this.process && id === this.currentAccountId) throw new Error('Disconnect this account before removing it.')
    const index = this.accountData.accounts.findIndex(item => item.id === id)
    if (index < 0) throw new Error('Account not found.')
    this.accountData.accounts.splice(index, 1)
    fs.rmSync(path.join(this.authCacheDir, `${id}.json`), { force: true })
    if (this.accountData.activeId === id) this.accountData.activeId = this.accountData.accounts[0]?.id || ''
    this.saveAccounts()
    return this.snapshot()
  }
  clearAccounts() {
    if (this.process) throw new Error('Disconnect before removing saved accounts.')
    fs.rmSync(this.authCacheDir, { recursive: true, force: true })
    fs.mkdirSync(this.authCacheDir, { recursive: true })
    this.accountData = { activeId: '', accounts: [] }
    this.currentAccountId = ''
    this.saveAccounts()
    this.update({ username: '', accountConnected: false })
    return this.snapshot()
  }
  rotateAccount(reason = 'Daily Limit reached', delayMs = 2500, now = Date.now(), random = Math.random) {
    if (this.shuttingDown || this.safetyLockActive || this.connectionBlockedReason) return false
    this.emit('daily-limit', { reason: String(reason || 'Daily Limit reached'), at: new Date(now).toISOString() })
    const accounts = this.accountData.accounts
    const currentId = this.currentAccountId || this.accountData.activeId
    const currentIndex = Math.max(0, accounts.findIndex(item => item.id === currentId))
    const current = accounts[currentIndex]
    if (!current) {
      this.log('warning', `${reason}. No saved account is available for the scheduled reconnect.`)
      this.disconnect()
      return false
    }

    // Mark every exhausted account individually. The old round-robin path did
    // not remember limits when two or more accounts were linked, so a fleet of
    // already-limited accounts could rotate forever and flood the GUI.
    const existingResumeAt = Number(current.dailyLimitResumeAt)
    current.dailyLimitResumeAt = existingResumeAt > now ? existingResumeAt : tallinnDailyLimitResumeAt(now, random)
    const ordered = accounts.slice(currentIndex + 1).concat(accounts.slice(0, currentIndex))
    const next = ordered.find(account => !Number(account.dailyLimitResumeAt) || Number(account.dailyLimitResumeAt) <= now)
    if (next) {
      this.log('warning', `${reason}. Switching automatically to ${next.username || next.id}.`)
      this.accountData.activeId = next.id
      this.saveAccounts()
      this.disconnect()
      return this.scheduleLifecycleConnect(next.id, delayMs, 'Account rotation failed')
    }

    const resumeAccount = accounts.reduce((earliest, account) => Number(account.dailyLimitResumeAt) < Number(earliest.dailyLimitResumeAt) ? account : earliest, accounts[0])
    const resumeAt = Number(resumeAccount.dailyLimitResumeAt)
    const resumeText = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Tallinn', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date(resumeAt))
    this.accountData.activeId = resumeAccount.id
    this.saveAccounts()
    this.log('warning', `${reason}. ${accounts.length === 1 ? 'No additional account is available' : 'Every saved account is already limited'}; disconnecting until ${resumeText} Tallinn time.`)
    this.disconnect()
    this.update({
      status: 'daily-limit-wait',
      username: resumeAccount.username || this.state.username,
      activeAccountId: resumeAccount.id,
      accountConnected: true,
      lastError: `Daily Bazaar Limit reached; reconnect scheduled for ${resumeText} Tallinn time.`
    })
    return this.scheduleLifecycleConnect(resumeAccount.id, Math.max(0, resumeAt - now), 'Daily limit reconnect failed')
  }

  send(command) {
    if (this.safetyLockActive) throw new Error(this.safetyLockReason || 'Fleet safety lock is active.')
    if (this.connectionBlockedReason) throw new Error(this.connectionBlockedReason)
    if (!this.process?.stdin?.writable) {
      const scheduled = this.scheduleReconnect('Azalea is not running.')
      throw new Error(scheduled ? 'Azalea is reconnecting automatically.' : 'Azalea is not running and Auto Reconnect is disabled.')
    }
    this.process.stdin.write(`${JSON.stringify(command)}\n`)
  }
  setHubMode(enabled, { notifyBridge = true } = {}) {
    const next = Boolean(enabled)
    const changed = this.hubModeActive !== next
    this.hubModeActive = next
    if (!next) {
      this.completeBazaarNpcAttempt({ opened: false, reason: 'Hub mode ended before the NPC interaction completed.' })
      this.hubSpawnClearanceRequired = false
      this.resolveHubSpawnClearance(new Error('Hub Roaming ended before spawn clearance was confirmed.'))
    }
    if (!next && this.pendingSkyBlockCommand?.command === 'hub') this.clearSkyBlockEntry()
    if (!next) this.clearHubTeleportRetry()
    if (next) {
      this.clearIslandRecovery()
      // Island recovery may already have queued /is behind the shared
      // SkyBlock command cooldown. Once Hub mode wins, that deferred command
      // must be cancelled or it can fire after /hub and tear down roaming.
      if (this.pendingSkyBlockCommand?.command === 'island') this.clearSkyBlockEntry()
    }
    if (changed && notifyBridge && this.isAlive()) this.send({ command: 'hub_mode', enabled: next })
    if (this.state.hubMode !== next) this.update({ hubMode: next })
    return next
  }
  hubLocation(location = this.state.location) {
    return Boolean(isHubLocation(location?.name))
  }
  canTradeHere(location = this.state.location) {
    return this.hubModeActive ? this.hubLocation(location) : location?.onIsland === true
  }
  teleportHub() {
    this.setHubMode(true)
    return this.requireSkyBlock('hub', '/hub', ({ afterSkyBlockEntry = false } = {}) => this.beginHubTeleport({
      delayMs: afterSkyBlockEntry ? this.hubTeleportDelayAfterSkyBlockMs : 0
    }))
  }
  startHubRoaming(waypoints, options = {}) {
    const route = Array.isArray(waypoints) ? waypoints.map(point => ({ x: Number(point.x), y: Number(point.y), z: Number(point.z) })) : []
    if (!route.length || route.some(point => ![point.x, point.y, point.z].every(Number.isFinite))) throw new Error('Hub route contains an invalid waypoint.')
    this.setHubMode(true)
    this.hubSpawnClearanceRequired = !this.lastMovementPosition || this.hubSpawnDistance(this.lastMovementPosition) < 5
    this.send({
      command: 'roam_start',
      waypoints: route,
      profile: String(options.profile || 'safe-humanized-ping-pong'),
      ping_pong: options.pingPong !== false,
      dwell_min_ms: Math.max(0, Number(options.dwellMinMs) || 2500),
      dwell_max_ms: Math.max(0, Number(options.dwellMaxMs) || 10000),
      allow_mining: options.allowMining === true,
      avoid_water: options.avoidWater !== false,
      avoid_ladders: options.avoidLadders !== false,
      humanize_camera: options.humanizeCamera !== false,
      humanizer_version: Number(options.humanizerVersion) === 1 ? 1 : 2,
      jump_min_ms: Math.max(250, Number(options.jumpMinMs) || 500),
      jump_max_ms: Math.max(250, Number(options.jumpMaxMs) || 900),
      swing_min_ms: Math.max(5000, Number(options.swingMinMs) || 18000),
      swing_max_ms: Math.max(5000, Number(options.swingMaxMs) || 65000)
    })
    return true
  }
  pauseHubRoaming(reason = '') { this.send({ command: 'roam_pause', reason: String(reason || '') }); return true }
  resumeHubRoaming() { this.send({ command: 'roam_resume' }); return true }
  closeHubContainer() { this.send({ command: 'close_container' }); return true }
  stopHubRoaming(reason = '') { this.send({ command: 'roam_stop', reason: String(reason || '') }); return true }
  requestMovementStatus() { this.send({ command: 'position_request' }); return true }
  finiteMovementPosition(value) {
    const x = Number(value?.x); const y = Number(value?.y); const z = Number(value?.z)
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
  }
  hubSpawnDistance(position = this.lastMovementPosition) {
    const point = this.finiteMovementPosition(position)
    return point ? Math.hypot(point.x - 0.5, point.z + 0.5) : 0
  }
  needsHubSpawnClearance() {
    if (this.hubModeActive !== true) return false
    if (!this.lastMovementPosition || this.hubSpawnDistance(this.lastMovementPosition) < 5) {
      this.hubSpawnClearanceRequired = true
    }
    return this.hubSpawnClearanceRequired === true
  }
  resolveHubSpawnClearance(error = null) {
    const waiters = [...this.hubSpawnClearanceWaiters]
    this.hubSpawnClearanceWaiters.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve(true)
    }
  }
  waitForHubSpawnClearance(timeoutMs = 45_000) {
    if (!this.needsHubSpawnClearance()) return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this.hubSpawnClearanceWaiters.delete(waiter)
        reject(new Error('Hub Roaming did not move 5 blocks away from spawn before the Bazaar timeout.'))
      }, Math.max(1000, Number(timeoutMs) || 45_000))
      waiter.timer.unref?.()
      this.hubSpawnClearanceWaiters.add(waiter)
    })
  }
  async sendChat(text) {
    const value = String(text).trim()
    const gated = value.match(/^\/(hub|is|bz)(?:\s|$)/i)
    if (!gated) {
      this.send({ command: 'chat', text: value })
      return true
    }
    const command = gated[1].toLowerCase() === 'is' ? 'island' : gated[1].toLowerCase()
    return this.requireSkyBlock(command, value, ({ afterSkyBlockEntry = false } = {}) => {
      if (command === 'hub') {
        return this.beginHubTeleport({ delayMs: afterSkyBlockEntry ? this.hubTeleportDelayAfterSkyBlockMs : 0 })
      }
      else if (command === 'island' && afterSkyBlockEntry) {
        return this.deferAfterSkyBlockCooldown(() => this.send({ command: 'chat', text: value }))
      }
      else this.send({ command: 'chat', text: value })
    })
  }
  completeBazaarNpcAttempt(result = {}) {
    const attempt = this.bazaarNpcAttempt
    if (!attempt) return false
    this.bazaarNpcAttempt = null
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.resolve({ opened: result.opened === true, reason: this.cleanText(result.reason || '') })
    return true
  }
  async openBazaarViaNpc(zone = {}) {
    if (!this.hubModeActive || !this.hubLocation()) return Promise.resolve({ opened: false, reason: 'The instance is not in a confirmed Hub location.' })
    this.completeBazaarNpcAttempt({ opened: false, reason: 'A newer NPC interaction replaced the previous attempt.' })
    const requestId = `bazaar-${Date.now().toString(36)}-${(++this.bazaarNpcSequence).toString(36)}`
    const point = value => {
      const parsed = { x: Number(value?.x), y: Number(value?.y), z: Number(value?.z) }
      return Object.values(parsed).every(Number.isFinite) ? parsed : null
    }
    return new Promise(resolve => {
      const attempt = { requestId, resolve, clicked: false, guiConfirmed: false, native: null, timer: null }
      attempt.timer = setTimeout(() => {
        if (this.bazaarNpcAttempt !== attempt) return
        this.completeBazaarNpcAttempt({
          opened: false,
          reason: attempt.clicked ? 'The right-click was sent, but no Bazaar GUI was confirmed.' : 'The NPC interaction timed out before a verified click.'
        })
      // The native side may need several smooth-look ticks plus a raycast
      // verification round. Keep this below Auto Trader's ordinary 15-second
      // phase timeout, but do not fall back to /bz while a safe click is still
      // genuinely converging.
      }, 12000)
      attempt.timer.unref?.()
      this.bazaarNpcAttempt = attempt
      try {
        this.send({
          command: 'bazaar_interact',
          request_id: requestId,
          approach: point(zone.approach),
          label_hint: point(zone.labelHint),
          target_hint: point(zone.targetHint),
          max_approach_distance: Math.max(0.5, Number(zone.maxApproachDistance) || 2.25),
          max_target_distance: Math.max(2, Number(zone.maxTargetDistance) || 4.5)
        })
      } catch (error) {
        this.completeBazaarNpcAttempt({ opened: false, reason: error.message || String(error) })
      }
    })
  }
  prepareHotbarItem(name) {
    const value = this.cleanText(name)
    if (!value) throw new Error('A hotbar item name is required.')
    this.send({ command: 'prepare_hotbar_item', name: value })
  }
  useHeldItem() { this.send({ command: 'use_held_item' }) }
  clickSlot(slot) {
    if (!Number.isInteger(Number(slot)) || Number(slot) < 0) throw new Error('Invalid Minecraft inventory slot.')
    this.send({ command: 'click', slot: Number(slot) })
  }
  submitSign(text) {
    const value = String(text || '').trim()
    if (!/^\d{1,9}$/.test(value)) throw new Error('Invalid custom Bazaar amount.')
    this.send({ command: 'sign', text: value })
  }
  async openBazaar() {
    // Never wait on Hub-only movement telemetry while the account is in a
    // lobby. sendChat() must get the first chance to gate /bz behind the
    // /skyblock -> /hub transition.
    if (this.hubModeActive && this.hubLocation()) await this.waitForHubSpawnClearance()
    return this.sendChat('/bz')
  }
  async clickBazaarAction(action) {
    const found = this.lastWindow.actions.find(item => item.action === action)
    if (!found) throw new Error('The current Azalea screen does not contain this action.')
    this.send({ command: 'click', slot: found.slot })
    return found
  }
  windowSnapshot() { return this.lastWindow }
  clearConnectionBlock() {
    const cleared = Boolean(this.connectionBlockedReason || this.state.connectionBlocked === true)
    this.connectionBlockedReason = ''
    this.proxyEndpointRefusalCount = 0
    this.lastProxyEndpointRefusalGeneration = null
    this.update({ connectionBlocked: false, lastError: '' })
    return cleared
  }
  setSafetyLock(active, reason = '') {
    this.safetyLockActive = Boolean(active)
    this.safetyLockReason = this.safetyLockActive ? String(reason || 'Fleet safety lock is active after a ban disconnect.') : ''
    if (this.safetyLockActive) this.setGroupReconnect(false)
    this.update({ safetyLocked: this.safetyLockActive, lastError: this.safetyLockActive ? this.safetyLockReason : this.state.lastError })
    return this.safetyLockActive
  }
  stopChildImmediately(reason, { safety = false, blocked = false } = {}) {
    this.hubSpawnClearanceRequired = false
    this.resolveHubSpawnClearance(new Error(String(reason || 'Instance stopped.')))
    this.completeBazaarNpcAttempt({ opened: false, reason: String(reason || 'Instance stopped.') })
    this.cancelLifecycleConnect()
    this.cancelBazaarSearch()
    this.clearConnectionFailureWatchdog()
    this.clearIslandRecovery()
    this.clearSkyBlockEntry()
    this.clearHubTeleportRetry()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    if (safety) {
      this.safetyLockActive = true
      this.safetyLockReason = String(reason || 'Fleet safety lock is active.')
      this.groupReconnectEnabled = false
    }
    if (blocked) this.connectionBlockedReason = String(reason || 'Connection is blocked.')
    for (const verificationChild of this.verificationChildren) {
      try { verificationChild.kill() } catch {}
    }
    this.verificationChildren.clear()
    this.hubModeActive = false
    const child = this.process
    this.process = null
    this.connectionGeneration += 1
    this.abortOrderAction()
    this.resetLiveSession({
      lastError: String(reason || ''),
      safetyLocked: this.safetyLockActive,
      connectionBlocked: Boolean(this.connectionBlockedReason)
    })
    if (child) {
      try { child.stdin?.write(`${JSON.stringify({ command: 'disconnect' })}\n`) } catch {}
      try { child.kill() } catch {}
    }
    return true
  }
  emergencyStop(reason) { return this.stopChildImmediately(reason, { safety: true }) }
  blockConnection(reason) { return this.stopChildImmediately(reason, { blocked: true }) }
  disconnect() {
    this.hubSpawnClearanceRequired = false
    this.resolveHubSpawnClearance(new Error('Instance disconnected.'))
    this.completeBazaarNpcAttempt({ opened: false, reason: 'Instance disconnected.' })
    this.cancelLifecycleConnect()
    this.cancelBazaarSearch()
    this.clearConnectionFailureWatchdog()
    this.clearIslandRecovery()
    this.clearSkyBlockEntry()
    this.clearHubTeleportRetry()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.hubModeActive = false
    const child = this.process
    this.process = null
    this.connectionGeneration += 1
    this.abortOrderAction()
    this.resetLiveSession()
    if (!child) return
    try { child.stdin.write(`${JSON.stringify({ command: 'disconnect' })}\n`) } catch {}
    const killTimer = setTimeout(() => { if (!child.killed) child.kill() }, 1500)
    killTimer.unref?.()
  }
  shutdown() {
    this.completeBazaarNpcAttempt({ opened: false, reason: 'XYZ FLIPPER is shutting down.' })
    this.shuttingDown = true
    this.cancelLifecycleConnect()
    this.cancelBazaarSearch()
    this.clearConnectionFailureWatchdog()
    this.clearIslandRecovery()
    this.clearSkyBlockEntry()
    this.clearHubTeleportRetry()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.clearOrdersTimer) clearTimeout(this.clearOrdersTimer)
    if (this.clearCompletionTimer) clearTimeout(this.clearCompletionTimer)
    if (this.clearWatchdogTimer) clearTimeout(this.clearWatchdogTimer)
    for (const verificationChild of this.verificationChildren) {
      try { verificationChild.kill() } catch {}
    }
    this.verificationChildren.clear()
    this.reconnectTimer = null
    this.clearOrdersTimer = null
    this.clearCompletionTimer = null
    this.clearWatchdogTimer = null
    this.hubModeActive = false
    const child = this.process
    this.process = null
    this.connectionGeneration += 1
    this.abortOrderAction()
    this.resetLiveSession()
    if (child) {
      try { child.stdin.write(`${JSON.stringify({ command: 'disconnect' })}\n`) } catch {}
      try { child.kill() } catch {}
    }
  }
}

module.exports = { AzaleaController, parseBanDisconnect, isProxyAuthenticationFailure, isProxyEndpointFailure, isProxyEndpointRefused, isHubLocation, tallinnDailyLimitResumeAt }
