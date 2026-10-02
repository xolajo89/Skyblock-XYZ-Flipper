'use strict'

const { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray } = require('electron')

app.setAppUserModelId('local.xyzflipper.desktop')
const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const ffUserData = path.join(app.getPath('appData'), 'FF')
const legacyUserData = path.join(app.getPath('appData'), ['m', 'b', 'f', '-windows'].join(''))
if (!fs.existsSync(ffUserData) && fs.existsSync(legacyUserData)) {
  fs.cpSync(legacyUserData, ffUserData, { recursive: true })
}
app.setPath('userData', ffUserData)
const hasPrimaryLock = app.requestSingleInstanceLock()
if (!hasPrimaryLock) app.quit()
const { ConfigStore } = require('./config-store')
const { AzaleaController } = require('./azalea-controller')
const { MarketScanner } = require('./market-scanner')
const { BazaarCollector } = require('./bazaar-collector')
const { DynamicStrategy } = require('./dynamic-strategy')
const { BazaarAutomation } = require('./bazaar-automation')
const { parseServerAddress } = require('./server-address')
const { InstanceStore } = require('./instance-store')
const { runtimeConfig } = require('./runtime-config')
const { LanServer } = require('./lan-server')
const { buildAllLogsReport } = require('./all-logs')
const { MAX_LOG_BYTES, collectLogFiles, pruneLogFiles } = require('./log-retention')
const { validateConfig, validateFilter } = require('./validator')
const { mergeUltraProfitConfig } = require('./preset-profile')
const { profileFileName, createSavedProfile, summarizeSavedProfile, mergeProfileTradingConfig, bundledProfileIsCurrent } = require('./saved-profiles')
const { loadUltraProfitV2Instance, loadUltraProfitV2Fleet, loadUltraProfitV3Instance, loadUltraProfitV3Fleet, loadUltraProfitV4Instance, loadUltraProfitV4Fleet, loadUltraProfitV5Instance, loadUltraProfitV5Fleet, loadUltraProfitV6Instance, loadUltraProfitV6Fleet, loadUltraProfitV7Instance, loadUltraProfitV7Fleet, loadUltraProfitV8Instance, loadUltraProfitV8Fleet, resolveSavedProfileAllocation } = require('./ultra-profit-v2')
const { ProxyPool } = require('./proxy-pool')
const { compactInstanceStats } = require('./instance-stats')
const { HubRoaming } = require('./hub-roaming')
const { BanRateGuard } = require('./ban-rate-guard')

if (process.env.FF_UI_SCREENSHOT) app.disableHardwareAcceleration()

let mainWindow
let store
let bot
let scanner
let collector
let dynamicStrategy
let automation
let dataDir
let authCacheDir
let shuttingDown = false
let instanceStore
let selectedInstanceId = ''
let lanServer
let tray
let logPruneTimer
let instancesSummaryTimer
let logWriteTimer
let logWriteBuffer = ''
let lastLogPruneAt = Date.now()
let allAccountsAutoReconnect = false
let fleetSafety = { active: false }
let banRateGuard
let banRateResumeTimer
let lastBanRateMonitorWarningAt = 0
let banRateSafety = {
  active: false,
  ignored: false,
  mode: 'none',
  rate: 0,
  lastRate: 0,
  detectedAt: '',
  resumeAt: '',
  generation: 0,
  resumePlan: []
}
let proxyPool
const PROXY_UNHEALTHY_MS = 30 * 60 * 1000
const contexts = new Map()
const logs = []
const earlyCrashEntries = []
const commandHandlers = new Map()
const electronIpcHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  commandHandlers.set(channel, (...args) => listener(null, ...args))
  return electronIpcHandle(channel, listener)
}

function recordCrash(kind, error) {
  const entry = { at: new Date().toISOString(), kind, message: error?.stack || error?.message || String(error) }
  earlyCrashEntries.push(entry)
  if (earlyCrashEntries.length > 200) earlyCrashEntries.shift()
  if (dataDir) {
    try { fs.appendFileSync(path.join(dataDir, 'crash.log'), `${JSON.stringify(entry)}\n`, 'utf8') } catch {}
  }
}

process.on('uncaughtExceptionMonitor', error => recordCrash('uncaughtException', error))
process.on('unhandledRejection', reason => recordCrash('unhandledRejection', reason))

function pushLog(level, message, extra = {}) {
  if (shuttingDown) return
  const entry = { at: new Date().toISOString(), level, message: String(message), ...extra }
  logs.push(entry)
  if (logs.length > 1000) logs.splice(0, logs.length - 1000)
  logWriteBuffer += `${JSON.stringify(entry)}\n`
  if (!logWriteTimer) {
    logWriteTimer = setTimeout(flushLogWriteBuffer, 100)
    logWriteTimer.unref?.()
  }
  scheduleLogPrune()
  sendToRenderer('log-entry', entry)
}

function flushLogWriteBuffer() {
  if (logWriteTimer) clearTimeout(logWriteTimer)
  logWriteTimer = null
  if (!logWriteBuffer || !dataDir) return
  const chunk = logWriteBuffer
  logWriteBuffer = ''
  try { fs.appendFileSync(path.join(dataDir, 'FF.log'), chunk, 'utf8') } catch {}
}

function scheduleLogPrune() {
  if (!dataDir || logPruneTimer) return
  const intervalMs = 10 * 60 * 1000
  const delayMs = Math.max(1000, intervalMs - (Date.now() - lastLogPruneAt))
  logPruneTimer = setTimeout(() => {
    logPruneTimer = null
    lastLogPruneAt = Date.now()
    try {
      const totalBytes = collectLogFiles(dataDir).reduce((total, file) => {
        try { return total + fs.statSync(file).size } catch { return total }
      }, 0)
      // Compact only after meaningful growth above the final budget. This
      // prevents a full 10 MB parse/rewrite loop after virtually every log.
      if (totalBytes > MAX_LOG_BYTES * 1.15) pruneLogFiles(dataDir)
    } catch {}
  }, delayMs)
  logPruneTimer.unref?.()
}

function resolveBridgePath() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'bin', 'ff-azalea-bridge.exe'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'ff-azalea-bridge.exe')
      ]
    : [path.join(__dirname, '..', 'bin', 'ff-azalea-bridge.exe')]
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0]
}

function sendToRenderer(channel, payload) {
  if (shuttingDown) return false
  lanServer?.broadcast(channel, payload)
  if (!mainWindow) return Boolean(lanServer)
  try {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false
    mainWindow.webContents.send(channel, payload)
    return true
  } catch { return false }
}

function shutdownXyzFlipper() {
  if (shuttingDown) return
  shuttingDown = true
  if (logPruneTimer) clearTimeout(logPruneTimer)
  if (instancesSummaryTimer) clearTimeout(instancesSummaryTimer)
  if (banRateResumeTimer) clearTimeout(banRateResumeTimer)
  banRateResumeTimer = null
  try { banRateGuard?.stop() } catch {}
  flushLogWriteBuffer()
  allAccountsAutoReconnect = false
  try { lanServer?.close() } catch {}
  for (const context of contexts.values()) {
    cancelContextStart(context)
    try { context.hubRoaming?.close() } catch {}
    try { context.scanner?.stop() } catch {}
    try { context.automation?.close() } catch {}
    try { context.collector?.close() } catch {}
    try { context.bot?.shutdown() } catch {}
  }
}


function activeContext() { return contexts.get(selectedInstanceId) }
function activateInstance(id) {
  const context = contexts.get(id)
  if (!context) throw new Error('Instance not found.')
  selectedInstanceId = id
  store = context.store; bot = context.bot; scanner = context.scanner; collector = context.collector; dynamicStrategy = context.dynamicStrategy; automation = context.automation
  return context
}

function settings() {
  const config = runtimeConfig(store.read('config').parsed, activeContext()?.engineOverrides)
  const filter = store.read('filter').parsed
  return { config, filter }
}

function hubContext(rawInstanceId) {
  const instanceId = String(rawInstanceId || '')
  if (!instanceId) throw new Error('Choose an instance for Hub Roaming.')
  const context = contexts.get(instanceId)
  if (!context) throw new Error('Instance not found.')
  return context
}

function proxyPoolSnapshot() {
  const records = proxyPool?.publicRecords() || []
  const instances = instanceStore?.list()?.instances || []
  return {
    records,
    instances: instances.map(instance => {
      const context = contexts.get(instance.id)
      const proxy = context?.store?.read('config')?.parsed?.proxy || {}
      return {
        id: instance.id,
        name: instance.name,
        running: context?.bot?.state?.status === 'connected',
        assignedProxyId: proxyPool?.findId(proxy) || '',
        current: {
          enabled: proxy.enabled === true,
          ip: String(proxy.ip || ''),
          port: Number(proxy.port) || 0,
          country: String(proxy.country || 'Unknown')
        }
      }
    })
  }
}

function saveProxyAssignment(context, selectedProxy) {
  const config = context.store.read('config').parsed
  config.proxy = {
    enabled: true,
    ip: selectedProxy.ip,
    port: selectedProxy.port,
    country: selectedProxy.country,
    username: selectedProxy.username,
    password: selectedProxy.password
  }
  const file = context.store.save('config', `${JSON.stringify(config, null, 2)}\n`)
  applyLiveInstanceSettings(context, 'config')
  context.log('success', `[Proxy Pool] ${selectedProxy.country} SOCKS5 proxy assigned to ${context.name}. Credentials stayed local.`)
  return file
}

function assignedProxyPoolIds(excludedContext = null) {
  const used = new Set()
  for (const context of contexts.values()) {
    if (!context || context === excludedContext) continue
    const proxy = context.store?.read('config')?.parsed?.proxy || {}
    const id = proxyPool?.findId(proxy) || ''
    if (id) used.add(id)
  }
  return used
}

async function recoverFailedProxyEndpoint(context, failure = {}) {
  const configuredProxy = context.store.read('config').parsed.proxy || {}
  const currentId = proxyPool?.findId(configuredProxy) || ''
  const currentRecord = currentId ? proxyPool.get(currentId) : null
  if (currentRecord) {
    proxyPool.markUnhealthy(currentId, PROXY_UNHEALTHY_MS, Date.now(), failure.message || 'proxy endpoint failed')
    context.log('warning', `[Proxy Pool] Marked the failed ${currentRecord.country} endpoint unhealthy for 30 minutes.`)
  }
  const replacement = currentRecord
    ? proxyPool.findHealthyReplacement({
        currentId,
        country: currentRecord.country,
        usedIds: assignedProxyPoolIds(context)
      })
    : null
  if (!replacement) {
    try { cancelContextStart(context) } catch {}
    try { setInstanceAutoReconnect(context, false) } catch {}
    context.log('error', 'This instance was stopped and Auto Reconnect was disabled after five consecutive SOCKS5 endpoint failures because Proxy Pool had no healthy unused replacement in the same country. Save or import an active endpoint, then press Start again; direct-IP fallback remains blocked for safety.')
    sendToRenderer('instances-summary', instancesSummary())
    return { replaced: false, stopped: true }
  }

  try {
    const oldEndpoint = `${configuredProxy.ip || 'unknown'}:${configuredProxy.port || '?'}`
    saveProxyAssignment(context, replacement)
    context.bot.clearConnectionBlock?.()
    context.log('warning', `[Proxy Pool] Replacing failed ${oldEndpoint} with an unused healthy ${replacement.country} endpoint for this instance only. Auto Reconnect remains ${context.autoReconnectEnabled === true ? 'enabled' : 'unchanged'}.`)
    await startContext(context)
    context.log('success', `[Proxy Pool] ${context.name} restarted through its replacement ${replacement.country} proxy; other instances were not interrupted.`)
    sendToRenderer('instances-summary', instancesSummary())
    return { replaced: true, replacementId: replacement.id }
  } catch (error) {
    // The replacement config remains proxy-enabled and therefore fail-closed.
    // Preserve the user's Auto Reconnect toggle; if it is enabled, let the
    // controller retry only this newly assigned endpoint.
    context.log('error', `[Proxy Pool] Replacement proxy was assigned but ${context.name} could not restart immediately: ${error.message}. Direct-IP fallback remains blocked.`)
    if (context.autoReconnectEnabled === true) {
      try { context.bot.scheduleReconnect(`${context.name}: replacement proxy restart failed.`) } catch {}
    }
    sendToRenderer('instances-summary', instancesSummary())
    return { replaced: true, replacementId: replacement.id, restartPending: true }
  }
}

function fleetSafetyFile() { return path.join(dataDir, 'fleet-safety.json') }
function loadFleetSafety() {
  try {
    const parsed = JSON.parse(fs.readFileSync(fleetSafetyFile(), 'utf8'))
    if (parsed && typeof parsed === 'object') return { ...parsed, active: parsed.active === true }
  } catch {}
  return { active: false }
}
function saveFleetSafety() {
  try { fs.writeFileSync(fleetSafetyFile(), `${JSON.stringify(fleetSafety, null, 2)}\n`, 'utf8') } catch {}
}
function acknowledgeFleetSafety(trigger = 'Manual Start') {
  if (fleetSafety.active !== true) return false
  fleetSafety = { ...fleetSafety, active: false, acknowledgedAt: new Date().toISOString(), acknowledgedBy: trigger }
  saveFleetSafety()
  for (const context of contexts.values()) context.bot?.setSafetyLock(false)
  pushLog('warning', `[BAN SAFETY] ${trigger} acknowledged the previous fleet stop. Instances remain stopped until explicitly started.`)
  sendToRenderer('instances-summary', instancesSummary())
  return true
}
function stopFleetForBan(sourceContext, detection = {}) {
  if (fleetSafety.active === true) return fleetSafety
  const detectedAt = String(detection.detectedAt || new Date().toISOString())
  const durationText = String(detection.durationText || 'not specified by server')
  const reason = String(detection.reason || 'Server ban disconnect')
  fleetSafety = {
    active: true,
    detectedAt,
    sourceInstanceId: sourceContext?.id || '',
    sourceInstanceName: sourceContext?.name || 'Unknown instance',
    username: String(detection.username || sourceContext?.bot?.snapshot()?.username || ''),
    durationText,
    reason
  }
  saveFleetSafety()
  try { fs.appendFileSync(path.join(dataDir, 'fleet-ban-events.jsonl'), `${JSON.stringify(fleetSafety)}\n`, 'utf8') } catch {}
  for (const context of contexts.values()) {
    try { cancelContextStart(context) } catch {}
    try { setInstanceAutoReconnect(context, false) } catch {}
    try { context.hubRoaming?.terminate('Fleet ban safety stop.', { send: false }) } catch {}
    try { context.bot?.emergencyStop(`[BAN SAFETY] ${fleetSafety.sourceInstanceName} received a ban disconnect at ${detectedAt}.`) } catch {}
  }
  refreshAutoReconnectSummary()
  pushLog('error', `[BAN SAFETY] ALL INSTANCES STOPPED. Source: ${fleetSafety.sourceInstanceName}${fleetSafety.username ? ` (${fleetSafety.username})` : ''}; detected: ${detectedAt}; duration: ${durationText}; reason: ${reason}`)
  sendToRenderer('instances-summary', instancesSummary())
  return fleetSafety
}

const BAN_RATE_MODE_RANK = Object.freeze({
  none: 0,
  'fifteen-minutes': 1,
  'one-hour': 2,
  'three-hours': 3
})

function banRatePolicy(rate) {
  const value = Math.max(0, Number(rate) || 0)
  if (value > 100) return { mode: 'three-hours', holdMs: 3 * 60 * 60 * 1000, label: '3 hours' }
  if (value > 30) return { mode: 'one-hour', holdMs: 60 * 60 * 1000, label: '1 hour' }
  if (value > 10) return { mode: 'fifteen-minutes', holdMs: 15 * 60 * 1000, label: '15 minutes' }
  return { mode: 'none', holdMs: 0, label: 'none' }
}

function banRateTimestamp(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString()
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
}

function publicBanRateSafety() {
  return {
    active: banRateSafety.active === true,
    ignored: banRateSafety.ignored === true,
    mode: banRateSafety.mode || 'none',
    rate: Math.max(0, Number(banRateSafety.rate) || 0),
    lastRate: Math.max(0, Number(banRateSafety.lastRate) || 0),
    lastRateAt: String(banRateSafety.lastRateAt || ''),
    detectedAt: String(banRateSafety.detectedAt || ''),
    resumeAt: String(banRateSafety.resumeAt || ''),
    source: 'bans.fisproxy.org',
    resumeInstanceIds: Array.isArray(banRateSafety.resumePlan)
      ? banRateSafety.resumePlan.map(entry => entry.id)
      : []
  }
}

function banRateHoldError() {
  const safety = publicBanRateSafety()
  const suffix = `Automatic resume is scheduled for ${safety.resumeAt || 'the end of the safety period'}.`
  const error = new Error(`Global ban-rate protection is active (${safety.rate.toFixed(0)} bans/min). ${suffix}`)
  error.code = 'BAN_RATE_SAFETY_ACTIVE'
  return error
}

function contextWasRunning(context) {
  const status = String(context?.bot?.snapshot?.()?.status || '').toLowerCase()
  return context?.desiredRunning === true || Boolean(context?.bot?.process) || ['connected', 'connecting', 'authenticating', 'starting'].includes(status)
}

async function resumeFleetAfterBanRateHold(generation) {
  if (shuttingDown || banRateSafety.active !== true || generation !== banRateSafety.generation) return

  const lastRateAt = Date.parse(String(banRateSafety.lastRateAt || ''))
  const sampleIsFresh = Number.isFinite(lastRateAt) && Date.now() - lastRateAt <= 90 * 1000
  const currentPolicy = banRatePolicy(banRateSafety.lastRate)
  if (sampleIsFresh && currentPolicy.mode !== 'none') {
    const resumePlan = Array.isArray(banRateSafety.resumePlan) ? banRateSafety.resumePlan : []
    banRateSafety.active = false
    await stopFleetForBanRate({
      rate: banRateSafety.lastRate,
      mode: currentPolicy.mode,
      holdMs: currentPolicy.holdMs,
      observedAt: new Date().toISOString(),
      resumePlan,
      reason: 'The rolling one-minute ban rate is still above the safety threshold.'
    })
    return
  }

  const resumePlan = Array.isArray(banRateSafety.resumePlan) ? [...banRateSafety.resumePlan] : []
  banRateSafety = {
    ...banRateSafety,
    active: false,
    mode: 'none',
    rate: Math.max(0, Number(banRateSafety.lastRate) || 0),
    resumeAt: '',
    resumePlan: []
  }
  banRateResumeTimer = null
  if (fleetSafety.active === true) {
    pushLog('warning', '[GLOBAL BAN RATE] Timed protection ended, but the fleet remains stopped by a local server ban safety lock.')
    sendToRenderer('instances-summary', instancesSummary())
    return
  }

  const resumed = []; const skipped = []
  for (const entry of resumePlan) {
    const context = contexts.get(entry.id)
    if (!context) continue
    try {
      await startContext(context)
      resumed.push(context.name)
    } catch (error) {
      skipped.push(`${context.name}: ${error.message}`)
      context.log('error', `[GLOBAL BAN RATE] Automatic resume failed: ${error.message}`)
    }
  }
  pushLog(resumed.length ? 'success' : 'warning', `[GLOBAL BAN RATE] Safety pause ended. Resumed ${resumed.length} previously running instance(s)${skipped.length ? `; ${skipped.join('; ')}` : ''}.`)
  sendToRenderer('instances-summary', instancesSummary())
}

async function stopFleetForBanRate(signal = {}) {
  const rate = Math.max(0, Number(signal.rate) || 0)
  if (banRateSafety.ignored === true) {
    banRateSafety.lastRate = rate
    banRateSafety.lastRateAt = banRateTimestamp(signal.observedAt)
    scheduleInstancesSummary(250)
    return publicBanRateSafety()
  }
  const policy = banRatePolicy(rate)
  const requestedMode = BAN_RATE_MODE_RANK[signal.mode] ? signal.mode : policy.mode
  if (requestedMode === 'none') return publicBanRateSafety()
  const currentRank = BAN_RATE_MODE_RANK[banRateSafety.mode] || 0
  const nextRank = BAN_RATE_MODE_RANK[requestedMode] || 0
  if (banRateSafety.active === true && nextRank <= currentRank) return publicBanRateSafety()

  const resumePlan = Array.isArray(signal.resumePlan)
    ? signal.resumePlan
    : banRateSafety.active === true && Array.isArray(banRateSafety.resumePlan)
      ? banRateSafety.resumePlan
      : [...contexts.values()]
          .filter(contextWasRunning)
          .map(context => ({ id: context.id, autoReconnect: context.autoReconnectEnabled === true }))
  const detectedAt = banRateTimestamp(signal.observedAt)
  const holdMs = requestedMode === 'three-hours'
    ? 3 * 60 * 60 * 1000
    : requestedMode === 'one-hour'
      ? 60 * 60 * 1000
      : 15 * 60 * 1000
  const generation = Math.max(0, Number(banRateSafety.generation) || 0) + 1
  if (banRateResumeTimer) clearTimeout(banRateResumeTimer)
  banRateResumeTimer = null
  banRateSafety = {
    ...banRateSafety,
    active: true,
    mode: requestedMode,
    rate,
    lastRate: rate,
    lastRateAt: detectedAt,
    detectedAt,
    resumeAt: Number.isFinite(holdMs) ? new Date(Date.now() + holdMs).toISOString() : '',
    generation,
    resumePlan
  }

  for (const context of contexts.values()) {
    try { await stopContext(context, { preserveBanRateResume: true }) } catch (error) { context.log('error', `[GLOBAL BAN RATE] Could not fully stop this instance: ${error.message}`) }
  }
  refreshAutoReconnectSummary()
  const label = requestedMode === 'three-hours' ? 'for 3 hours' : requestedMode === 'one-hour' ? 'for 1 hour' : 'for 15 minutes'
  pushLog('error', `[GLOBAL BAN RATE] ${rate.toFixed(0)} bans/min detected by bans.fisproxy.org. All instances stopped ${label}. ${signal.reason || ''}`.trim())
  sendToRenderer('instances-summary', instancesSummary())

  if (Number.isFinite(holdMs)) {
    banRateResumeTimer = setTimeout(() => {
      resumeFleetAfterBanRateHold(generation).catch(error => pushLog('error', `[GLOBAL BAN RATE] Resume task failed: ${error.message}`))
    }, holdMs)
    banRateResumeTimer.unref?.()
  }
  return publicBanRateSafety()
}

async function ignoreBanRateSafety() {
  const resumePlan = Array.isArray(banRateSafety.resumePlan) ? [...banRateSafety.resumePlan] : []
  if (banRateResumeTimer) clearTimeout(banRateResumeTimer)
  banRateResumeTimer = null
  banRateSafety = {
    ...banRateSafety,
    active: false,
    ignored: true,
    mode: 'none',
    rate: Math.max(0, Number(banRateSafety.lastRate || banRateSafety.rate) || 0),
    resumeAt: '',
    resumePlan: [],
    generation: Math.max(0, Number(banRateSafety.generation) || 0) + 1
  }

  const resumed = []; const skipped = []
  if (fleetSafety.active !== true) {
    for (const entry of resumePlan) {
      const context = contexts.get(entry.id)
      if (!context) continue
      try {
        await startContext(context)
        resumed.push(context.name)
      } catch (error) {
        skipped.push(`${context.name}: ${error.message}`)
      }
    }
  }
  pushLog('warning', `[GLOBAL BAN RATE] User override enabled until XYZ FLIPPER restarts. External ban-rate stops are ignored; local account ban detection remains active.${resumed.length ? ` Resumed ${resumed.length} previously running instance(s).` : ''}${skipped.length ? ` ${skipped.join('; ')}` : ''}`)
  sendToRenderer('instances-summary', instancesSummary())
  return publicBanRateSafety()
}

function startBanRateGuard() {
  if (banRateGuard || shuttingDown) return
  banRateGuard = new BanRateGuard({
    endpoint: 'https://bans.fisproxy.org',
    log: (level, message) => {
      const normalized = level === 'error' ? 'warning' : level
      if (normalized === 'warning') {
        const now = Date.now()
        if (now - lastBanRateMonitorWarningAt < 60 * 1000) return
        lastBanRateMonitorWarningAt = now
      }
      pushLog(normalized, `[GLOBAL BAN RATE] ${message}`)
    }
  })
  banRateGuard.on('rate', sample => {
    const rate = Math.max(0, Number(sample?.rate) || 0)
    banRateSafety.lastRate = rate
    banRateSafety.lastRateAt = banRateTimestamp(sample?.observedAt)
    scheduleInstancesSummary(250)
  })
  banRateGuard.on('threshold', signal => {
    stopFleetForBanRate(signal).catch(error => pushLog('error', `[GLOBAL BAN RATE] Fleet stop failed: ${error.message}`))
  })
  banRateGuard.on('error', error => {
    pushLog('warning', `[GLOBAL BAN RATE] Live statistics are temporarily unavailable: ${error.message}. Existing local ban protection remains active; no stop is triggered by a monitoring outage.`)
  })
  banRateGuard.start()
}

function savedProfilesDir() {
  const dir = path.join(dataDir, 'saved-profiles')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ensureBundledSavedProfiles() {
  const presetDir = path.join(__dirname, '..', 'presets')
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'defaults', 'config.json'), 'utf8'))
  const configPatch = JSON.parse(fs.readFileSync(path.join(presetDir, 'ultra-profit-config.json'), 'utf8'))
  const filter = JSON.parse(fs.readFileSync(path.join(presetDir, 'ultra-profit-filter.json'), 'utf8'))
  const legacy = createSavedProfile('Ultra Profit', 'Built-in', mergeUltraProfitConfig(defaults, configPatch), filter)
  legacy.builtIn = true
  legacy.bundledVersion = 2
  const v2Profiles = loadUltraProfitV2Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V2 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 1
    profile.portfolio = 'ultra-profit-v2'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const v3Profiles = loadUltraProfitV3Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V3 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in aggressive allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 1
    profile.portfolio = 'ultra-profit-v3'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const v4Profiles = loadUltraProfitV4Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V4 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in sprint allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 1
    profile.portfolio = 'ultra-profit-v4'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const v5Profiles = loadUltraProfitV5Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V5 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in high-ticket allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 2
    profile.portfolio = 'ultra-profit-v5'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const v6Profiles = loadUltraProfitV6Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V6 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in five-instance allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 1
    profile.portfolio = 'ultra-profit-v6'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const v7Profiles = loadUltraProfitV7Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V7 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in 40-hour telemetry allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 1
    profile.portfolio = 'ultra-profit-v7'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const v8Profiles = loadUltraProfitV8Fleet(presetDir).map(allocation => {
    const name = `Ultra Profit V8 - ${allocation.id.toUpperCase()}`
    const profile = createSavedProfile(name, `Built-in 0.9.174 telemetry allocation ${allocation.id.toUpperCase()}`, mergeUltraProfitConfig(defaults, allocation.config), allocation.filter)
    profile.builtIn = true
    profile.bundledVersion = 2
    profile.portfolio = 'ultra-profit-v8'
    profile.portfolioInstanceId = allocation.id
    return profile
  })
  const profiles = [legacy, ...v2Profiles, ...v3Profiles, ...v4Profiles, ...v5Profiles, ...v6Profiles, ...v7Profiles, ...v8Profiles]
  for (const profile of profiles) {
    const file = path.join(savedProfilesDir(), profileFileName(profile.name))
    if (fs.existsSync(file)) {
      try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'))
        // Never overwrite a user-created profile that predates a protected
        // name. Bundled profiles are upgraded deterministically with the app.
        if (existing?.builtIn !== true || bundledProfileIsCurrent(existing, profile.bundledVersion)) continue
      } catch {}
    }
    validateSavedProfile(profile)
    fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  }
}

function validateSavedProfile(profile) {
  if (!profile || typeof profile !== 'object' || !profile.config || !profile.filter) throw new Error('Saved profile must contain both config and filter.')
  const configErrors = validateConfig(profile.config)
  const filterErrors = validateFilter(profile.filter)
  if (configErrors.length || filterErrors.length) throw new Error(`Saved profile is invalid:\n${[...configErrors, ...filterErrors].join('\n')}`)
  return profile
}

function readSavedProfile(name) {
  ensureBundledSavedProfiles()
  const file = path.join(savedProfilesDir(), profileFileName(name))
  if (!fs.existsSync(file)) throw new Error('Saved profile was not found.')
  return validateSavedProfile(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function listSavedProfiles() {
  ensureBundledSavedProfiles()
  return fs.readdirSync(savedProfilesDir(), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => {
      try { return summarizeSavedProfile(JSON.parse(fs.readFileSync(path.join(savedProfilesDir(), entry.name), 'utf8'))) } catch { return null }
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || String(right.createdAt).localeCompare(String(left.createdAt)))
}

function totalProfitSnapshot() {
  return [...contexts.values()].reduce((total, context) => total + Number(context.automation?.state?.tracker?.profit || context.automation?.snapshot?.().tracker?.profit || 0), 0)
}

function instancesSummary() {
  return {
    totalProfit: totalProfitSnapshot(),
    allAccountsAutoReconnect,
    fleetSafety: { ...fleetSafety },
    banRateSafety: publicBanRateSafety(),
    instancesRuntime: instanceListWithRuntime()
  }
}
function scheduleInstancesSummary(delayMs = 120) {
  if (instancesSummaryTimer || shuttingDown) return
  instancesSummaryTimer = setTimeout(() => {
    instancesSummaryTimer = null
    sendToRenderer('instances-summary', instancesSummary())
  }, Math.max(0, Number(delayMs) || 0))
  instancesSummaryTimer.unref?.()
}
function instanceListWithRuntime() {
  const listing = instanceStore.list()
  return {
    ...listing,
    instances: listing.instances.map(instance => {
      const context = contexts.get(instance.id)
      return {
        ...instance,
        running: context?.bot?.state?.status === 'connected',
        linkedAccounts: Math.max(0, Number(context?.bot?.snapshot?.()?.accounts?.length) || 0),
        autoReconnect: context?.autoReconnectEnabled === true,
        hubRoamingEnabled: context?.hubRoamingEnabled === true,
        banRateQueued: banRateSafety.active === true && Array.isArray(banRateSafety.resumePlan) && banRateSafety.resumePlan.some(entry => entry.id === instance.id),
        hub: context?.hubRoaming?.snapshot(),
        stats: compactInstanceStats(context)
      }
    })
  }
}
function refreshAutoReconnectSummary() {
  allAccountsAutoReconnect = contexts.size > 0 && [...contexts.values()].every(context => context.autoReconnectEnabled === true)
  return allAccountsAutoReconnect
}
function setInstanceAutoReconnect(context, enabled) {
  context.autoReconnectEnabled = Boolean(enabled)
  context.engineOverrides.autoReconnectEnabled = context.autoReconnectEnabled
  saveEngineOverrides(context)
  context.bot.setGroupReconnect(context.autoReconnectEnabled)
  if (context.autoReconnectEnabled && context.desiredRunning && context.bot.state?.status !== 'connected' && !context.bot.process) {
    context.bot.scheduleReconnect(`${context.name}: Auto Reconnect enabled while the instance is offline.`)
  }
  refreshAutoReconnectSummary()
  return context.autoReconnectEnabled
}

function saveHubRoamingPreference(context, enabled) {
  context.hubRoamingEnabled = Boolean(enabled)
  context.engineOverrides.hubRoamingEnabled = context.hubRoamingEnabled
  saveEngineOverrides(context)
  return context.hubRoamingEnabled
}

function setInstanceHubRoaming(context, enabled) {
  const next = Boolean(enabled)
  saveHubRoamingPreference(context, next)
  if (!next) {
    try { context.hubRoaming?.stop('Hub Roaming disabled from Instance Controls.') } catch {}
  } else if (context.bot.state?.status === 'connected' && context.bot.isAlive?.()) {
    try { context.hubRoaming.start() }
    catch (error) { context.log('warning', `[Hub Roaming] Enabled; automatic start is waiting: ${error.message || error}`) }
  }
  return context.hubRoamingEnabled
}

function loadEngineOverrides(root) {
  const engineFile = path.join(root, 'engine.json')
  const legacyFile = path.join(root, 'config.json')
  for (const file of [engineFile, legacyFile]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const overrides = {}
      if (parsed?.server && typeof parsed.server === 'object') overrides.server = parsed.server
      if (typeof parsed?.autoReconnectEnabled === 'boolean') overrides.autoReconnectEnabled = parsed.autoReconnectEnabled
      if (typeof parsed?.hubRoamingEnabled === 'boolean') overrides.hubRoamingEnabled = parsed.hubRoamingEnabled
      if (Object.keys(overrides).length) return overrides
    } catch {}
  }
  return {}
}

function saveEngineOverrides(context) {
  fs.writeFileSync(path.join(context.root, 'engine.json'), `${JSON.stringify(context.engineOverrides || {}, null, 2)}\n`, 'utf8')
}

function createInstanceContext(instance, bridgePath) {
  const root = instanceStore.directory(instance.id)
  const instanceAuth = path.join(root, 'auth-cache')
  fs.mkdirSync(instanceAuth, { recursive: true })
  const engineOverrides = loadEngineOverrides(root)
  const context = {
    id: instance.id,
    name: instance.name,
    root,
    instanceAuth,
    lastAutomaticStrategyAt: 0,
    desiredRunning: false,
    startEpoch: 0,
    engineOverrides,
    autoReconnectEnabled: engineOverrides.autoReconnectEnabled === true,
    hubRoamingEnabled: engineOverrides.hubRoamingEnabled === true
  }
  context.store = new ConfigStore(root, path.join(__dirname, '..', 'defaults'))
  const instanceLog = (level, message, extra = {}) => {
    pushLog(level, message, { instanceId: instance.id, instanceName: instance.name, ...extra })
  }
  context.log = instanceLog
  const getSettings = () => ({
    config: runtimeConfig(context.store.read('config').parsed, context.engineOverrides),
    filter: context.store.read('filter').parsed
  })
  context.getSettings = getSettings
  context.bot = new AzaleaController(bridgePath, instanceAuth, () => getSettings().config, instanceLog)
  context.scanner = new MarketScanner(getSettings, instanceLog)
  context.collector = new BazaarCollector(root, () => getSettings().config, instanceLog)
  context.dynamicStrategy = new DynamicStrategy(context.collector, context.store, instanceLog)
  context.automation = new BazaarAutomation(context.bot, getSettings, instanceLog, path.join(root, 'ff-tracker.json'), path.join(root, 'bazaar-chat.jsonl'))
  context.hubRoaming = new HubRoaming({
    instanceId: instance.id,
    instanceName: instance.name,
    root,
    bot: context.bot,
    automation: context.automation,
    log: instanceLog
  })
  context.hubRoaming.on('state', state => sendToRenderer('hub-state', state))
  context.bot.on('state', state => {
    if (selectedInstanceId === instance.id) sendToRenderer('bot-state', state)
    const roamingState = context.hubRoaming?.snapshot()
    if (state?.status === 'connected' && context.hubRoamingEnabled === true && context.hubRoaming?.recoveryTimer == null && context.hubRoaming?.recoveryBlocked !== true && (roamingState?.enabled !== true || roamingState?.modeActive !== true)) {
      try { roamingState?.enabled === true ? context.hubRoaming.restore('connection-restored') : context.hubRoaming.start() }
      catch (error) { instanceLog('error', `[Hub Roaming] Automatic start failed: ${error.message || error}`) }
    }
    scheduleInstancesSummary()
  })
  context.bot.on('ban-detected', detection => {
    try { stopFleetForBan(context, detection) } catch (error) { instanceLog('error', `[BAN SAFETY] Could not finish fleet stop: ${error.message}`) }
  })
  context.bot.on('movement-failsafe', event => {
    try { cancelContextStart(context) } catch {}
    try { setInstanceAutoReconnect(context, false) } catch {}
    try { context.hubRoaming?.suspend('Unexpected server movement correction triggered the restart-only failsafe; the user Hub Roaming toggle was preserved.', { error: event?.reason || 'Movement failsafe.', send: false, retry: false }) } catch {}
    instanceLog('error', `[MOVEMENT FAILSAFE] ${event?.reason || 'Unexpected server movement correction.'} This instance is locked until XYZ FLIPPER is restarted.`)
    sendToRenderer('instances-summary', instancesSummary())
  })
  context.bot.on('proxy-auth-failed', () => {
    try { cancelContextStart(context) } catch {}
    try { setInstanceAutoReconnect(context, false) } catch {}
    instanceLog('error', 'This instance was stopped and Auto Reconnect was disabled because its SOCKS5 credentials were rejected. Save valid proxy credentials, then press Start again.')
    sendToRenderer('instances-summary', instancesSummary())
  })
  context.bot.on('proxy-endpoint-failed', failure => {
    recoverFailedProxyEndpoint(context, failure).catch(error => {
      instanceLog('error', `[Proxy Pool] Automatic endpoint recovery failed unexpectedly: ${error.message}. The connection remains blocked and direct-IP fallback remains disabled.`)
      sendToRenderer('instances-summary', instancesSummary())
    })
  })
  context.bot.on('device-code', code => {
    if (selectedInstanceId === instance.id) sendToRenderer('device-code', { ...code, instanceId: instance.id, instanceName: instance.name })
  })
  context.bot.on('chat', message => {
    // The profit/recovery parser only requires readable chat. Avoid storing
    // duplicate raw protocol/component data for every message.
    fs.appendFile(path.join(root, 'bazaar-chat.jsonl'), `${JSON.stringify({ at: message.at || new Date().toISOString(), text: message.text || '' })}\n`, () => {})
    instanceLog('chat', message.text || '[empty chat packet]', { ansi: message.ansi || '' })
    if (selectedInstanceId === instance.id) sendToRenderer('chat-message', message)
  })
  context.bot.on('window', window => { if (selectedInstanceId === instance.id) sendToRenderer('window-state', window) })
  context.automation.on('state', state => {
    if (selectedInstanceId === instance.id) sendToRenderer('automation-state', state)
    scheduleInstancesSummary()
  })
  context.scanner.on('update', market => {
    context.automation.setMarket(market)
    if (selectedInstanceId === instance.id) {
      // The 2,000+ item catalog is loaded through scanner.items(). Do not
      // serialize and repaint that ~350 KB catalog every 15-second market tick.
      const { items: _items, ...marketUpdate } = market
      sendToRenderer('market-update', marketUpdate)
    }
  })
  context.scanner.on('raw', ({ payload, fetchedAt }) => {
    try {
      context.collector.record(payload, fetchedAt)
      const trader = getSettings().config.automation?.autoTrader || {}
      const refreshMs = Math.max(1, Number(trader.strategyRefreshMinutes) || 15) * 60000
      if (trader.enabled && trader.automaticConfigAndFilter && Date.now() - context.lastAutomaticStrategyAt >= refreshMs) {
        const result = context.dynamicStrategy.generate({
          purse: Number(trader.strategyPurse) || 150000000,
          lookbackHours: Number(trader.strategyLookbackHours) || 24
        })
        context.dynamicStrategy.apply()
        context.lastAutomaticStrategyAt = Date.now()
        instanceLog('success', `[Auto Trader] Dynamic config/filter applied automatically: ${result.summary.selectedItems} selected items.`)
      }
    } catch (error) {
      instanceLog('error', `Collector/automatic strategy: ${error.message}`)
    }
  })
  context.collector.on('state', state => { if (selectedInstanceId === instance.id) sendToRenderer('collector-state', state) })
  // Market data is a core service for every FF instance. It starts with the
  // instance and stays active without requiring dashboard controls.
  context.scanner.start()
  return context
}

function beginContextStart(context) {
  context.desiredRunning = true
  context.startEpoch = Math.max(0, Number(context.startEpoch) || 0) + 1
  return context.startEpoch
}

function cancelContextStart(context) {
  context.desiredRunning = false
  context.startEpoch = Math.max(0, Number(context.startEpoch) || 0) + 1
  return context.startEpoch
}

function contextStartIsCurrent(context, startEpoch) {
  return !shuttingDown && context.desiredRunning === true && context.startEpoch === startEpoch
}

function queueContextStartForBanRate(context) {
  const alreadyQueued = Array.isArray(banRateSafety.resumePlan) && banRateSafety.resumePlan.some(entry => entry.id === context.id)
  beginContextStart(context)
  context.bot.setGroupReconnect(false)
  if (!Array.isArray(banRateSafety.resumePlan)) banRateSafety.resumePlan = []
  if (!alreadyQueued) banRateSafety.resumePlan.push({ id: context.id, autoReconnect: context.autoReconnectEnabled === true })
  if (!alreadyQueued) context.log('warning', `[GLOBAL BAN RATE] Start queued. ${context.name} will connect automatically after the safety pause ends at ${banRateSafety.resumeAt || 'the next safe sample'}.`)
  return context.bot.snapshot()
}

async function startContext(context) {
  if (fleetSafety.active === true) throw new Error('Fleet safety lock is active after a ban disconnect. Use an explicit Start control to acknowledge it first.')
  if (typeof banRateSafety !== 'undefined' && banRateSafety.active === true) return queueContextStartForBanRate(context)
  context.bot.clearConnectionBlock?.()
  const startEpoch = beginContextStart(context)
  context.bot.setGroupReconnect(context.autoReconnectEnabled === true || (context.autoReconnectEnabled === undefined && allAccountsAutoReconnect === true))
  if (context.bot.isAlive?.()) return context.bot.snapshot()
  if (context.bot.process) {
    context.log('warning', `${context.name} had a stale Azalea process handle; clearing it before Start.`)
    context.bot.disconnect()
  }
  const activeAccountId = context.bot.snapshot().activeAccountId
  const cacheFile = activeAccountId ? path.join(context.instanceAuth, `${activeAccountId}.json`) : ''
  let reusableCache = false
  try { reusableCache = Boolean(cacheFile) && fs.statSync(cacheFile).size > 0 } catch {}
  // Cached Microsoft tokens are refreshed by Azalea during the real start.
  // Running the old bridge as a "preflight" caused a second full proxy/server
  // connection because that binary does not implement --verify-only.
  if (!reusableCache) {
    try { await context.bot.verifyActiveAccount() } catch (error) {
      if (!contextStartIsCurrent(context, startEpoch)) return context.bot.snapshot()
      throw error
    }
  }
  if (!contextStartIsCurrent(context, startEpoch)) return context.bot.snapshot()
  context.bot.connect()
  return context.bot.snapshot()
}

async function stopContext(context, { preserveBanRateResume = false } = {}) {
  cancelContextStart(context)
  if (!preserveBanRateResume && typeof banRateSafety !== 'undefined' && banRateSafety.active === true && Array.isArray(banRateSafety.resumePlan)) {
    banRateSafety.resumePlan = banRateSafety.resumePlan.filter(entry => entry.id !== context.id)
  }
  try { context.hubRoaming?.stop('Instance stopped.') } catch {}
  // Stop must cancel a pending retry immediately, while the persisted toggle
  // remains the user's chosen setting for the next explicit Start.
  context.bot.setGroupReconnect(false)
  context.bot.disconnect()
  return context.bot.snapshot()
}

async function waitForContextLaunch(context, startEpoch, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = context.bot.snapshot()
    if (snapshot.status === 'connected') return { status: 'connected', snapshot }
    if (snapshot.connectionBlocked === true) return { status: 'blocked', snapshot }
    if (!contextStartIsCurrent(context, startEpoch)) return { status: 'cancelled', snapshot }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { status: 'pending', snapshot: context.bot.snapshot() }
}

function applyLiveInstanceSettings(context, kind, { automatic = false } = {}) {
  if (kind === 'config') context.bot.clearConnectionBlock?.()
  context.automation.refreshEnabled()
  if (context.automation.state.phase === 'idle') context.automation.nextSyncAt = Math.min(context.automation.nextSyncAt || Infinity, Date.now() + 500)
  if (context.liveApplyTimer) clearTimeout(context.liveApplyTimer)
  context.liveApplyTimer = setTimeout(() => {
    context.liveApplyTimer = null
    context.scanner.scan().catch(error => context.log('error', `Live ${kind} refresh failed: ${error.message}`))
  }, 150)
  context.liveApplyTimer.unref?.()
  context.log('success', automatic
    ? `[Editor] ${kind}.json auto-saved and applied live to ${context.name}.`
    : `${kind}.json saved and applied live to ${context.name}.`)
}

function exportStamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) }

function scannerLogReport(context = activeContext()) {
  if (!context?.scanner) throw new Error('No XYZ instance is selected.')
  const { config, filter } = context.getSettings()
  // The report is designed for support analysis: it includes market inputs,
  // candidates and scanner diagnostics, but never the proxy endpoint,
  // Microsoft token, web password or other private connection settings.
  const tradingConfig = {
    profit: config.profit || {},
    price: config.price || {},
    orders: config.orders || {},
    volume: config.volume || {},
    purse: config.purse || {},
    scanner: config.scanner || {},
    selectiveBuys: config.selectiveBuys,
    clearOnStart: config.clearOnStart
  }
  const scannerEvents = logs
    .filter(entry => entry.instanceId === context.id && /scanner|market|manipulator|candidate|hypixel api/i.test(String(entry.message || '')))
    .slice(-1000)
  return JSON.stringify({
    format: 'xyz-flipper-market-scanner-log',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    instance: { id: context.id, name: context.name },
    scanner: { running: context.scanner.running, ...context.scanner.last },
    tradingConfig,
    filter,
    automation: context.automation?.snapshot(),
    scannerEvents
  }, null, 2)
}

async function exportScannerLog() {
  const context = activeContext()
  const instanceName = String(context?.name || 'scanner').replace(/[^a-z0-9_-]+/gi, '-')
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${context?.name || 'XYZ'} Market Scanner log`,
    defaultPath: `XYZ-market-scanner-${instanceName}-${exportStamp()}.json`,
    filters: [{ name: 'JSON scanner log', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.writeFileSync(result.filePath, scannerLogReport(context), 'utf8')
  pushLog('success', `Market Scanner log exported for ${context.name}: ${path.basename(result.filePath)}`, { instanceId: context.id, instanceName: context.name })
  return { canceled: false, path: result.filePath }
}

async function exportHubDiagnostics(rawInstanceId) {
  const context = hubContext(rawInstanceId)
  const instanceName = String(context.name || context.id).replace(/[^a-z0-9_-]+/gi, '-')
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${context.name} Hub diagnostics`,
    defaultPath: `XYZ-hub-diagnostics-${instanceName}-${exportStamp()}.json`,
    filters: [{ name: 'JSON Hub diagnostics', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.writeFileSync(result.filePath, context.hubRoaming.diagnosticsReport(app.getVersion()), 'utf8')
  pushLog('success', `Hub diagnostics exported for ${context.name}: ${path.basename(result.filePath)}`, { instanceId: context.id, instanceName: context.name })
  return { canceled: false, path: result.filePath }
}

function applyUltraProfitPortfolio(label, loadAllocation) {
  const presetDir = path.join(__dirname, '..', 'presets')
  // Validate every final file before the first write so a malformed preset
  // can never leave only part of the fleet on the new strategy.
  const plans = [...contexts.values()].map(context => {
    const allocation = loadAllocation(presetDir, context.id)
    const current = context.store.read('config').parsed
    const merged = mergeUltraProfitConfig(current, allocation.config)
    const errors = [...validateConfig(merged), ...validateFilter(allocation.filter)]
    if (errors.length) throw new Error(`${context.name} ${label} allocation is invalid:\n${errors.join('\n')}`)
    return { context, merged, filter: allocation.filter }
  })
  for (const { context, merged, filter } of plans) {
    context.store.save('config', `${JSON.stringify(merged, null, 2)}\n`)
    context.store.save('filter', `${JSON.stringify(filter, null, 2)}\n`)
    applyLiveInstanceSettings(context, `${label} portfolio`)
  }
  const selected = activeContext()
  pushLog('success', `${label} portfolio applied to ${plans.length} instance(s) with separate non-overlapping markets. Proxy, webpage, server and account data were preserved.`)
  return {
    config: selected.store.read('config'),
    filter: selected.store.read('filter'),
    instances: instanceListWithRuntime(),
    applied: plans.map(plan => plan.context.name)
  }
}

async function exportCrashLog() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export FF crash log',
    defaultPath: `FF-crash-log-${exportStamp()}.txt`,
    filters: [{ name: 'Text log', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const crashPath = path.join(dataDir, 'crash.log')
  const runtimePath = path.join(dataDir, 'FF.log')
  const crash = fs.existsSync(crashPath) ? fs.readFileSync(crashPath, 'utf8') : 'No captured process crashes.\n'
  const runtime = fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath, 'utf8') : 'No runtime log.\n'
  const report = `XYZ FLIPPER ${app.getVersion()} diagnostics\nExported: ${new Date().toISOString()}\nData directory: ${dataDir}\n\n=== CRASH EVENTS ===\n${crash}\n=== RUNTIME LOG ===\n${runtime}`
  fs.writeFileSync(result.filePath, report, 'utf8')
  return { canceled: false, path: result.filePath }
}

async function exportRuntimeLog() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Download all FF logs',
    defaultPath: `FF-all-logs-${exportStamp()}.log`,
    filters: [{ name: 'FF log', extensions: ['log'] }, { name: 'Text log', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.writeFileSync(result.filePath, buildAllLogsReport(dataDir, app.getVersion()))
  return { canceled: false, path: result.filePath }
}

async function exportChatLog() {
  const context = activeContext()
  const current = context ? path.join(context.root, 'bazaar-chat.jsonl') : ''
  const legacy = path.join(dataDir, 'full-chat.jsonl')
  const source = current && fs.existsSync(current) ? current : legacy
  if (!fs.existsSync(source)) throw new Error('No chat log has been recorded yet.')
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${context?.name || 'FF'} chat log`,
    defaultPath: `FF-${String(context?.name || 'chat').replace(/[^a-z0-9_-]+/gi, '-')}-${exportStamp()}.jsonl`,
    filters: [{ name: 'JSON Lines log', extensions: ['jsonl'] }, { name: 'Text log', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.copyFileSync(source, result.filePath)
  return { canceled: false, path: result.filePath }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#080b0f',
    icon: path.join(__dirname, '..', 'assets', 'xyz-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
  if (process.env.FF_UI_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.FF_UI_PAGE) {
        const page = ['dashboard', 'actions', 'market', 'files', 'logs'].includes(process.env.FF_UI_PAGE) ? process.env.FF_UI_PAGE : 'dashboard'
        await mainWindow.webContents.executeJavaScript(`(() => {
          const target = ${JSON.stringify(page)}
          document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item.dataset.page === target))
          document.querySelectorAll('.page').forEach(item => item.classList.toggle('active', item.id === 'page-' + target))
        })()`)
      }
      if (process.env.FF_UI_DIALOG === 'kill') {
        await mainWindow.webContents.executeJavaScript("document.getElementById('killTheFih').click()")
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      const image = await mainWindow.capturePage()
      fs.writeFileSync(process.env.FF_UI_SCREENSHOT, image.toPNG())
      app.quit()
    }, 1200))
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('render-process-gone', (_event, details) => recordCrash('renderer-process-gone', JSON.stringify(details)))
}

function openWebDashboard() {
  const url = lanServer?.info()?.desktopUrl
  if (!url) return false
  shell.openExternal(url).catch(error => pushLog('error', `Could not open the web dashboard: ${error.message}`))
  return true
}

function createTray() {
  if (tray || process.env.FF_UI_SCREENSHOT) return
  const icon = path.join(__dirname, '..', 'assets', 'xyz-icon.png')
  tray = new Tray(icon)
  tray.setToolTip('XYZ FLIPPER')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'XYZ FLIPPER', enabled: false },
    { type: 'separator' },
    { label: 'Open Web Dashboard', click: openWebDashboard },
    { label: 'Open Window', click: () => { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus() } } },
    { type: 'separator' },
    { label: 'Exit XYZ FLIPPER', click: () => { shutdownXyzFlipper(); app.quit() } }
  ]))
  tray.on('click', openWebDashboard)
}

function ensureWebCredentialsFile() {
  const webpage = settings().config.webpage || {}
  const username = String(webpage.username || 'xyz')
  const password = String(webpage.password || '')
  const credentialsFile = path.join(dataDir, 'webpage-credentials.txt')
  if (fs.existsSync(credentialsFile)) return
  const credentialsText = `Webpage username: ${username}\nWebpage password: ${password}\n`
  fs.writeFileSync(credentialsFile, credentialsText, 'utf8')
}

function ensureLanFirewallRule() {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const ruleName = 'XYZ FLIPPER Web Dashboard'
  execFile('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`], { windowsHide: true }, (error, stdout) => {
    if (!error && /rule name\s*:\s*xyz flipper web dashboard/i.test(stdout || '')) return
    const elevate = path.join(process.resourcesPath, 'elevate.exe')
    if (!fs.existsSync(elevate)) {
      pushLog('warning', 'Phone access needs a Windows Firewall rule, but the elevation helper is missing.')
      return
    }
    const args = [
      'netsh.exe', 'advfirewall', 'firewall', 'add', 'rule',
      `name=${ruleName}`, 'dir=in', 'action=allow', 'protocol=TCP',
      'localport=9090,1010', 'profile=any', 'remoteip=LocalSubnet', 'enable=yes'
    ]
    const child = spawn(elevate, args, { windowsHide: true, detached: false, stdio: 'ignore' })
    child.once('exit', code => {
      pushLog(code === 0 ? 'success' : 'warning', code === 0
        ? 'Windows Firewall now allows the FF dashboard from this local network.'
        : 'Phone dashboard firewall access was not approved. Run FF again and approve the Windows prompt.')
    })
    child.once('error', firewallError => pushLog('warning', `Could not request phone firewall access: ${firewallError.message}`))
  })
}

function registerIpc() {
  ipcMain.handle('app:snapshot', () => ({
    version: app.getVersion(),
    bot: bot.snapshot(),
    scanner: { running: scanner.running, ...scanner.last },
    collector: collector.snapshot(),
    automation: automation.snapshot(),
    files: { config: store.read('config'), filter: store.read('filter') },
    proxy: settings().config.proxy || {},
    webpage: settings().config.webpage || {},
    logs: logs.filter(entry => entry.instanceId === selectedInstanceId).slice(-300),
    paths: { dataDir },
    savedProfiles: listSavedProfiles(),
    proxyPool: proxyPoolSnapshot(),
    instances: instanceListWithRuntime(),
    lan: lanServer?.info() || null,
    totals: instancesSummary()
  }))
  ipcMain.handle('webpage:save', (_event, rawUsername, rawPassword) => {
    const username = String(rawUsername || '').trim()
    const password = String(rawPassword || '')
    if (!username || username.length > 64) throw new Error('Username must contain 1 to 64 characters.')
    if (password.length < 8 || password.length > 128) throw new Error('Password must contain 8 to 128 characters.')
    for (const context of contexts.values()) {
      const config = context.store.read('config').parsed
      config.webpage = { ...(config.webpage || {}), username, password }
      context.store.save('config', `${JSON.stringify(config, null, 2)}\n`)
    }
    fs.writeFileSync(path.join(dataDir, 'webpage-credentials.txt'), `Webpage username: ${username}\nWebpage password: ${password}\n`, 'utf8')
    pushLog('success', 'Web dashboard credentials updated for every instance.')
    return { username, password }
  })
  ipcMain.handle('instances:list', () => instanceListWithRuntime())
  ipcMain.handle('instances:select', (_event, id) => { instanceStore.select(String(id)); activateInstance(String(id)); return { ...instanceListWithRuntime(), snapshot: { bot: bot.snapshot(), automation: automation.snapshot(), proxy: settings().config.proxy || {}, logs: logs.filter(entry => entry.instanceId === selectedInstanceId).slice(-300), files: { config: store.read('config'), filter: store.read('filter') } } } })
  ipcMain.handle('instances:add', (_event, name) => { const instance = instanceStore.add(String(name || '')); contexts.set(instance.id, createInstanceContext(instance, resolveBridgePath())); activateInstance(instance.id); return instanceStore.list() })
  ipcMain.handle('instances:rename', (_event, id, name) => instanceStore.rename(String(id), String(name)))
  ipcMain.handle('instances:start', async (_event, id) => {
    const context = contexts.get(String(id))
    if (!context) throw new Error('Instance not found.')
    acknowledgeFleetSafety('Manual instance Start')
    return startContext(context)
  })
  ipcMain.handle('instances:stop', async (_event, id) => { const context = contexts.get(String(id)); if (!context) throw new Error('Instance not found.'); return stopContext(context) })
  ipcMain.handle('hub:status', (_event, instanceId) => hubContext(instanceId).hubRoaming.snapshot())
  ipcMain.handle('hub:teleport', (_event, instanceId) => hubContext(instanceId).hubRoaming.teleport())
  ipcMain.handle('hub:start', (_event, instanceId) => {
    const context = hubContext(instanceId)
    setInstanceHubRoaming(context, true)
    return context.hubRoaming.snapshot()
  })
  ipcMain.handle('hub:pause', (_event, instanceId) => hubContext(instanceId).hubRoaming.pause())
  ipcMain.handle('hub:resume', (_event, instanceId) => hubContext(instanceId).hubRoaming.resume())
  ipcMain.handle('hub:stop', (_event, instanceId) => {
    const context = hubContext(instanceId)
    setInstanceHubRoaming(context, false)
    return context.hubRoaming.snapshot()
  })
  ipcMain.handle('hub:set-activity-mode', (_event, instanceId, mode) => hubContext(instanceId).hubRoaming.setActivityMode(mode))
  ipcMain.handle('hub:set-humanizer-version', (_event, instanceId, version) => hubContext(instanceId).hubRoaming.setHumanizerVersion(version))
  ipcMain.handle('hub:export-diagnostics', (_event, instanceId) => exportHubDiagnostics(instanceId))
  ipcMain.handle('instances:set-auto-reconnect', (_event, id, enabled) => {
    const context = contexts.get(String(id))
    if (!context) throw new Error('Instance not found.')
    if (enabled && fleetSafety.active === true) throw new Error('Fleet safety lock is active after a ban disconnect. Press Start or Start All Instances to acknowledge it.')
    const active = setInstanceAutoReconnect(context, enabled)
    pushLog('info', `${context.name}: Auto Reconnect ${active ? 'enabled' : 'disabled'}.`)
    return { ...instanceListWithRuntime(), totals: instancesSummary() }
  })
  ipcMain.handle('instances:set-hub-roaming', (_event, id, enabled) => {
    const context = contexts.get(String(id))
    if (!context) throw new Error('Instance not found.')
    const active = setInstanceHubRoaming(context, enabled)
    pushLog('info', `${context.name}: Hub Roaming ${active ? 'enabled' : 'disabled'}.`)
    return { ...instanceListWithRuntime(), totals: instancesSummary() }
  })
  ipcMain.handle('instances:start-all', async () => {
    const eligible = [...contexts.values()].filter(context => (context.bot.snapshot().accounts || []).length > 0)
    if (!eligible.length) {
      pushLog('warning', 'Start All Instances: no linked Microsoft accounts were found.')
      return { started: [], skipped: ['No linked Microsoft accounts'], ...instancesSummary() }
    }
    acknowledgeFleetSafety('Start All Instances')
    for (const context of eligible) setInstanceAutoReconnect(context, true)
    const started = []; const skipped = []
    await Promise.all(eligible.map(async (context, index) => {
      if (index) await new Promise(resolve => setTimeout(resolve, index * 500))
      let startEpoch = 0
      try {
        const starting = startContext(context)
        startEpoch = context.startEpoch
        await starting
        if (!contextStartIsCurrent(context, startEpoch)) {
          skipped.push(`${context.name}: start cancelled`)
          return
        }
        const outcome = await waitForContextLaunch(context, startEpoch)
        if (outcome.status === 'connected') started.push(context.name)
        else if (outcome.status === 'blocked') skipped.push(`${context.name}: ${outcome.snapshot.lastError || 'connection blocked'}`)
        else if (outcome.status === 'cancelled') skipped.push(`${context.name}: start cancelled`)
        else skipped.push(`${context.name}: connection is still pending; Auto Reconnect remains enabled`)
      } catch (error) {
        if (!contextStartIsCurrent(context, startEpoch)) {
          skipped.push(`${context.name}: ${context.bot.snapshot().lastError || 'start cancelled'}`)
          return
        }
        context.bot.scheduleReconnect(`Start All could not start ${context.name}: ${error.message}.`)
        skipped.push(`${context.name}: ${error.message}; reconnect scheduled`)
      }
    }))
    pushLog(started.length ? 'success' : 'warning', `Start All Accounts: ${started.length} instance(s) started; automatic reconnect enabled (15/30/45/60 seconds)${skipped.length ? `; ${skipped.join('; ')}` : ''}.`)
    return { started, skipped, ...instancesSummary() }
  })
  ipcMain.handle('instances:ignore-ban-rate', async () => {
    await ignoreBanRateSafety()
    return instancesSummary()
  })
  ipcMain.handle('instances:close-all', async () => {
    for (const context of contexts.values()) setInstanceAutoReconnect(context, false)
    let closed = 0
    for (const context of contexts.values()) {
      if (context.bot.process) closed += 1
      await stopContext(context)
    }
    pushLog('warning', `Stop All Accounts: ${closed} running instance(s) stopped; automatic reconnect disabled.`)
    return { closed, ...instancesSummary() }
  })
  ipcMain.handle('instances:restart-all', async () => {
    acknowledgeFleetSafety('Restart All Instances')
    const restarted = []; const skipped = []
    for (const context of contexts.values()) {
      const accounts = context.bot.snapshot().accounts || []
      if (!accounts.length) { skipped.push(`${context.name} has no linked account`); continue }
      await stopContext(context)
      let startEpoch = 0
      try {
        const starting = startContext(context)
        startEpoch = context.startEpoch
        await starting
        if (!contextStartIsCurrent(context, startEpoch)) {
          skipped.push(`${context.name}: restart cancelled`)
          continue
        }
        restarted.push(context.name)
      } catch (error) { skipped.push(`${context.name}: ${error.message}`) }
    }
    pushLog(restarted.length ? 'warning' : 'error', `Restart All: ${restarted.length} instance(s) scheduled${skipped.length ? `; ${skipped.join('; ')}` : ''}.`)
    return { restarted, skipped, ...instancesSummary() }
  })
  ipcMain.handle('instances:remove', (_event, id) => { const context = contexts.get(String(id)); if (context?.bot?.process) throw new Error('Stop the instance before removing it.'); if (context) { cancelContextStart(context); context.hubRoaming?.close() } const removed = instanceStore.remove(String(id)); contexts.delete(String(id)); activateInstance(instanceStore.list().selectedId); return removed })
  ipcMain.handle('proxy-pool:list', () => proxyPoolSnapshot())
  ipcMain.handle('proxy-pool:import', (_event, content, options = {}) => {
    const result = proxyPool.import(content, options)
    pushLog('success', `Proxy Pool imported ${result.added} new and updated ${result.updated} SOCKS5 proxy entries${result.invalid ? `; ${result.invalid} invalid row(s) skipped` : ''}. Passwords are stored locally and are not returned to the browser after import.`)
    return { ...proxyPoolSnapshot(), importResult: result }
  })
  ipcMain.handle('proxy-pool:remove', (_event, rawProxyId) => {
    const removed = proxyPool.remove(String(rawProxyId))
    if (!removed) throw new Error('Proxy is no longer present in the imported list.')
    pushLog('info', 'One proxy was removed from Proxy Pool. Existing instance configs were left unchanged.')
    return proxyPoolSnapshot()
  })
  ipcMain.handle('proxy-pool:clear', () => {
    const removed = proxyPool.clear()
    pushLog('warning', `Proxy Pool cleared: ${removed} imported proxy entr${removed === 1 ? 'y' : 'ies'} removed. Existing instance configs were left unchanged.`)
    return { ...proxyPoolSnapshot(), removed }
  })
  ipcMain.handle('proxy-pool:auto-assign', (_event, rawCountryPreferences = {}) => {
    const preferences = rawCountryPreferences && typeof rawCountryPreferences === 'object' ? rawCountryPreferences : {}
    const available = (proxyPool.records || []).filter(record => proxyPool.isHealthy(record))
    if (!available.length) throw new Error('Import a proxy list first.')
    const used = new Set()
    const assigned = []; const skipped = []; const running = []
    for (const instance of instanceStore.list().instances) {
      const context = contexts.get(instance.id)
      if (!context) continue
      const country = String(preferences[instance.id] || '')
      const currentId = proxyPool.findId(context.store.read('config').parsed.proxy || {})
      let selectedProxy = available.find(record => record.id === currentId && !used.has(record.id) && (!country || record.country === country))
      if (!selectedProxy) selectedProxy = available.find(record => !used.has(record.id) && (!country || record.country === country))
      if (!selectedProxy) { skipped.push(`${instance.name}: no unused proxy${country ? ` for ${country}` : ''}`); continue }
      used.add(selectedProxy.id)
      saveProxyAssignment(context, selectedProxy)
      assigned.push(instance.name)
      if (context.bot.process || context.bot.state?.status === 'connected') running.push(instance.name)
    }
    pushLog(assigned.length ? 'success' : 'warning', `Proxy Pool distributed ${assigned.length} unique proxy entr${assigned.length === 1 ? 'y' : 'ies'}${skipped.length ? `; ${skipped.join('; ')}` : ''}.`)
    return { ...proxyPoolSnapshot(), assigned, skipped, restartRequired: running }
  })
  ipcMain.handle('proxy-pool:assign', async (_event, rawInstanceId, rawProxyId, restartRunning = false) => {
    const context = contexts.get(String(rawInstanceId))
    if (!context) throw new Error('Instance not found.')
    const selectedProxy = proxyPool.get(String(rawProxyId))
    if (!selectedProxy) throw new Error('Select a proxy from the imported list.')
    const wasRunning = Boolean(context.bot.process || context.bot.state?.status === 'connected')
    const file = saveProxyAssignment(context, selectedProxy)
    let restarted = false
    if (restartRunning === true && wasRunning) {
      await stopContext(context)
      await startContext(context)
      restarted = true
    }
    sendToRenderer('instances-summary', instancesSummary())
    return { ...proxyPoolSnapshot(), file, restarted, restartRequired: wasRunning && !restarted }
  })
  ipcMain.handle('file:read', (_event, kind) => store.read(kind))
  ipcMain.handle('file:save', (_event, kind, content, options = {}) => {
    const context = activeContext()
    const saved = context.store.save(kind, content)
    applyLiveInstanceSettings(context, kind, { automatic: options?.automatic === true })
    return { ...saved, appliedLive: Boolean(context.bot.process) }
  })
  ipcMain.handle('file:restore', (_event, kind) => {
    const context = activeContext()
    const saved = context.store.restore(kind)
    applyLiveInstanceSettings(context, kind)
    return { ...saved, appliedLive: Boolean(context.bot.process) }
  })
  ipcMain.handle('file:reset-defaults', () => ({
    config: store.save('config', `${JSON.stringify(store.defaults('config'), null, 2)}\n`),
    filter: store.save('filter', `${JSON.stringify(store.defaults('filter'), null, 2)}\n`)
  }))
  ipcMain.handle('file:import', async (_event, kind) => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json', 'txt'] }] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const content = fs.readFileSync(result.filePaths[0], 'utf8')
    return { canceled: false, file: store.save(kind, content) }
  })
  ipcMain.handle('bot:connect', async () => { acknowledgeFleetSafety('Manual instance Start'); return startContext(activeContext()) })
  ipcMain.handle('bot:account-add', async () => {
    const context = activeContext()
    context.log('info', '[Accounts] Add Account requested; starting Microsoft device authorization.')
    try {
      await context.bot.addAccount()
      context.log('success', '[Accounts] Microsoft account was added and saved successfully.')
      return context.bot.snapshot()
    } catch (error) {
      context.log('error', `[Accounts] Add Account failed: ${error.message}`)
      throw error
    }
  })
  ipcMain.handle('bot:account-select', (_event, id) => activeContext().bot.selectAccount(String(id)))
  ipcMain.handle('bot:account-remove', (_event, id) => activeContext().bot.removeAccount(String(id)))
  ipcMain.handle('bot:disconnect', async () => stopContext(activeContext()))
  ipcMain.handle('bot:open-bazaar', async () => { activeContext().hubRoaming?.yieldToTrade('Manual Bazaar action.', { manual: true }); await bot.openBazaar(); return true })
  ipcMain.handle('bot:open-item', async (_event, itemName) => { activeContext().hubRoaming?.yieldToTrade('Manual Bazaar item action.', { manual: true }); await bot.openItemByName(String(itemName)); return true })
  ipcMain.handle('bot:manage-orders', async () => { activeContext().hubRoaming?.yieldToTrade('Manual Manage Orders action.', { manual: true }); await bot.manageOrders(); return true })
  ipcMain.handle('bot:order-action', async (_event, orderId, action) => { activeContext().hubRoaming?.yieldToTrade('Manual order action.', { manual: true }); automation.prepareManualOrderAction(); await bot.actOnOrder(String(orderId), String(action)); return true })
  ipcMain.handle('bot:clear-orders-inventory', async () => {
    activeContext().hubRoaming?.yieldToTrade('Manual clear action.', { manual: true })
    automation.prepareManualOrderAction(90000, true)
    try { await bot.clearOrdersAndInventory(); return true }
    catch (error) { automation.resumeManualOrderAction(`Clear Orders / Inventory could not start: ${error.message}. Automatic trading resumed.`); throw error }
  })
  ipcMain.handle('bot:send-chat', async (_event, text) => { if (/^\/(?:bz|bazaar|sbmenu)\b/i.test(String(text).trim())) activeContext().hubRoaming?.yieldToTrade('Manual GUI command.', { manual: true }); await bot.sendChat(text); return true })
  ipcMain.handle('bot:window', () => bot.windowSnapshot())
  ipcMain.handle('bot:click-action', (_event, action) => { activeContext().hubRoaming?.yieldToTrade('Manual Bazaar click.', { manual: true }); return bot.clickBazaarAction(action) })
  ipcMain.handle('server:save', (_event, input) => {
    const server = parseServerAddress(input?.host || 'mc.hypixel.net')
    const context = activeContext()
    context.engineOverrides = { ...context.engineOverrides, server }
    saveEngineOverrides(context)
    pushLog('success', `Server saved: ${server.host} (Minecraft 26.2 via Azalea).`)
    return server
  })
  ipcMain.handle('bot:logout', () => {
    const context = activeContext()
    if (context.bot.process) throw new Error('Disconnect before removing the account.')
    const snapshot = context.bot.clearAccounts()
    pushLog('warning', 'Saved Microsoft account tokens removed from this computer.')
    return snapshot
  })
  ipcMain.handle('scanner:start', () => { scanner.start(); return true })
  ipcMain.handle('scanner:stop', () => { scanner.stop(); return true })
  ipcMain.handle('scanner:scan', () => scanner.scan())
  ipcMain.handle('scanner:items', () => scanner.loadItems())
  ipcMain.handle('scanner:export-log', () => exportScannerLog())
  ipcMain.handle('collector:status', () => collector.refreshStatus())
  ipcMain.handle('collector:export-csv', () => collector.exportCsv(settings().config.collector.exportHours))
  ipcMain.handle('collector:export-txt', () => collector.exportTxt())
  ipcMain.handle('tracker:adjust-profit', (_event, amount, note) => automation.adjustProfit(amount, note))
  ipcMain.handle('tracker:reset-information', () => automation.resetInformation())
  ipcMain.handle('dynamic:generate', (_event, options) => dynamicStrategy.generate(options))
  ipcMain.handle('dynamic:apply', () => dynamicStrategy.apply())
  ipcMain.handle('preset:apply-simple', () => {
    const presetDir = path.join(__dirname, '..', 'presets')
    const current = store.read('config').parsed
    const simpleConfig = JSON.parse(fs.readFileSync(path.join(presetDir, 'simple-config.json'), 'utf8'))
    const merged = mergeProfileTradingConfig(current, simpleConfig)
    const config = store.save('config', `${JSON.stringify(merged, null, 2)}\n`)
    const filter = store.save('filter', fs.readFileSync(path.join(presetDir, 'simple-filter.json'), 'utf8'))
    pushLog('success', 'Simple readable trading rules and ITEM_ID filter applied; all non-trading settings were preserved.')
    return { config, filter }
  })
  ipcMain.handle('preset:apply-ultra-profit', () => applyUltraProfitPortfolio('Ultra Profit V2', loadUltraProfitV2Instance))
  ipcMain.handle('preset:apply-ultra-profit-v3', () => applyUltraProfitPortfolio('Ultra Profit V3', loadUltraProfitV3Instance))
  ipcMain.handle('preset:apply-ultra-profit-v4', () => applyUltraProfitPortfolio('Ultra Profit V4 Fast Turnover', loadUltraProfitV4Instance))
  ipcMain.handle('preset:apply-ultra-profit-v5', () => applyUltraProfitPortfolio('Ultra Profit V5 High Ticket', loadUltraProfitV5Instance))
  ipcMain.handle('preset:apply-ultra-profit-v6', () => applyUltraProfitPortfolio('Ultra Profit V6 Five-Instance Aggressive', loadUltraProfitV6Instance))
  ipcMain.handle('preset:apply-ultra-profit-v7', () => applyUltraProfitPortfolio('Ultra Profit V7 40-Hour Telemetry', loadUltraProfitV7Instance))
  ipcMain.handle('preset:apply-ultra-profit-v8', () => applyUltraProfitPortfolio('Ultra Profit V8 Five-Account Recovery', loadUltraProfitV8Instance))
  ipcMain.handle('profiles:list', () => listSavedProfiles())
  ipcMain.handle('profiles:save-current', (_event, rawName, rawTargetInstanceId = '') => {
    const context = rawTargetInstanceId ? contexts.get(String(rawTargetInstanceId)) : activeContext()
    if (!context) throw new Error('The selected profile source instance no longer exists.')
    const profile = createSavedProfile(rawName, context.name, context.store.read('config').parsed, context.store.read('filter').parsed)
    if (/^ultra-profit(?:-v\d+)?(?:-|$)/.test(profile.id)) throw new Error('This name belongs to a protected built-in profile. Save your variation under another name.')
    validateSavedProfile(profile)
    fs.writeFileSync(path.join(savedProfilesDir(), profileFileName(profile.name)), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    pushLog('success', `${context.name}: saved config and filter profile "${profile.name}".`)
    return { profile: summarizeSavedProfile(profile), profiles: listSavedProfiles() }
  })
  ipcMain.handle('profiles:apply', (_event, rawName, rawScope = 'current', rawTargetInstanceId = '') => {
    const profile = readSavedProfile(rawName)
    const scope = rawScope === 'all' ? 'all' : 'current'
    const capturedTarget = rawTargetInstanceId ? contexts.get(String(rawTargetInstanceId)) : activeContext()
    if (!capturedTarget) throw new Error('The selected target instance no longer exists.')
    const targets = scope === 'all' ? [...contexts.values()] : [capturedTarget]
    const plans = targets.map(context => {
      const portfolioAllocation = resolveSavedProfileAllocation(profile, path.join(__dirname, '..', 'presets'), context.id)
      const sourceConfig = portfolioAllocation?.config || profile.config
      const sourceFilter = portfolioAllocation?.filter || profile.filter
      const config = mergeProfileTradingConfig(context.store.read('config').parsed, sourceConfig)
      const filter = structuredClone(sourceFilter)
      const configErrors = validateConfig(config)
      const filterErrors = validateFilter(filter)
      if (configErrors.length || filterErrors.length) throw new Error(`${context.name}: profile cannot be applied:\n${[...configErrors, ...filterErrors].join('\n')}`)
      return { context, config, filter }
    })
    for (const { context, config, filter } of plans) {
      context.store.save('config', `${JSON.stringify(config, null, 2)}\n`)
      context.store.save('filter', `${JSON.stringify(filter, null, 2)}\n`)
      applyLiveInstanceSettings(context, `saved profile "${profile.name}"`)
    }
    const selected = scope === 'current' ? capturedTarget : activeContext()
    const allocationNote = /^ultra-profit-v\d+$/.test(String(profile.portfolio || '')) ? ' with the matching per-instance portfolio allocation' : ''
    pushLog('success', `Saved profile "${profile.name}" applied to ${plans.length} instance(s)${allocationNote}; only profit, price, orders, volume, purse and selectiveBuys were changed. All other instance settings were preserved.`)
    return {
      config: selected.store.read('config'),
      filter: selected.store.read('filter'),
      profiles: listSavedProfiles(),
      instances: instanceListWithRuntime(),
      applied: plans.map(plan => plan.context.name),
      scope
    }
  })
  ipcMain.handle('profiles:delete', (_event, rawName) => {
    const profile = readSavedProfile(rawName)
    if (profile.builtIn === true) throw new Error('The built-in Ultra Profit profile cannot be deleted.')
    const file = path.join(savedProfilesDir(), profileFileName(rawName))
    if (!fs.existsSync(file)) throw new Error('Saved profile was not found.')
    fs.unlinkSync(file)
    pushLog('info', `Saved profile "${String(rawName || '').trim()}" deleted.`)
    return listSavedProfiles()
  })
  ipcMain.handle('external:open', (_event, rawUrl) => {
    const url = new URL(rawUrl)
    const allowed = new Set(['www.microsoft.com', 'microsoft.com', 'login.live.com'])
    if (url.protocol !== 'https:' || !allowed.has(url.hostname)) throw new Error('Only Microsoft sign-in links may be opened.')
    return shell.openExternal(url.toString())
  })
  ipcMain.handle('folder:open-data', () => shell.openPath(dataDir))
  ipcMain.handle('logs:export-crash', () => exportCrashLog())
  ipcMain.handle('logs:export-chat', () => exportChatLog())
  ipcMain.handle('logs:download', () => exportRuntimeLog())
  ipcMain.handle('app:kill', () => {
    pushLog('warning', 'KILL XYZ requested. Stopping every background service.')
    shutdownXyzFlipper()
    setImmediate(() => app.exit(0))
    return true
  })
}

app.whenReady().then(async () => {
  dataDir = path.join(app.getPath('userData'), 'data')
  authCacheDir = path.join(dataDir, 'auth-cache')
  fs.mkdirSync(authCacheDir, { recursive: true })
  fleetSafety = loadFleetSafety()
  const legacyRuntimeLog = path.join(dataDir, ['m', 'b', 'f', '.log'].join(''))
  const ffRuntimeLog = path.join(dataDir, 'FF.log')
  if (fs.existsSync(legacyRuntimeLog)) {
    if (!fs.existsSync(ffRuntimeLog)) fs.renameSync(legacyRuntimeLog, ffRuntimeLog)
    else fs.rmSync(legacyRuntimeLog, { force: true })
  }
  if (earlyCrashEntries.length) {
    for (const entry of earlyCrashEntries) fs.appendFileSync(path.join(dataDir, 'crash.log'), `${JSON.stringify(entry)}\n`, 'utf8')
    earlyCrashEntries.length = 0
  }
  try { pruneLogFiles(dataDir) } catch {}
  const bridgePath = resolveBridgePath()
  if (!fs.existsSync(bridgePath)) {
    recordCrash('missing-azalea-bridge', new Error(`FF Azalea bridge is missing from this installation: ${bridgePath}`))
  }
  instanceStore = new InstanceStore(dataDir)
  proxyPool = new ProxyPool(dataDir)
  const listing = instanceStore.list()
  for (const instance of listing.instances) contexts.set(instance.id, createInstanceContext(instance, bridgePath))
  startBanRateGuard()
  if (fleetSafety.active === true) {
    for (const context of contexts.values()) {
      try { setInstanceAutoReconnect(context, false) } catch {}
      try { context.bot.setSafetyLock(true, `[BAN SAFETY] Fleet remains stopped after ${fleetSafety.sourceInstanceName || 'an instance'} received a ban disconnect at ${fleetSafety.detectedAt || 'an unknown time'}.`) } catch {}
    }
  }
  activateInstance(listing.selectedId)
  /* legacy singleton event wiring intentionally omitted: each context above
     emits only when selected, while every scanner continues independently. */
  /*
  bot.on('state', state => sendToRenderer('bot-state', state))
  bot.on('device-code', code => sendToRenderer('device-code', code))
  bot.on('chat', message => {
    fs.appendFile(path.join(dataDir, 'full-chat.jsonl'), `${JSON.stringify(message)}\n`, error => {
      if (error) pushLog('error', `Could not save full chat: ${error.message}`)
    })
    pushLog('chat', message.text || '[empty chat packet]', { ansi: message.ansi || '' })
    sendToRenderer('chat-message', message)
  })
  bot.on('chat-packet', message => {
    fs.appendFile(path.join(dataDir, 'full-chat.jsonl'), `${JSON.stringify(message)}\n`, error => {
      if (error) pushLog('error', `Could not save full chat packet: ${error.message}`)
    })
  })
  bot.on('window', window => {
    const record = JSON.stringify({ at: new Date().toISOString(), ...window }) + '\n'
    fs.appendFile(path.join(dataDir, 'window-snapshots.jsonl'), record, error => {
      if (error) pushLog('error', `Could not save Bazaar window snapshot: ${error.message}`)
    })
    sendToRenderer('window-state', window)
  })
  automation.on('state', state => sendToRenderer('automation-state', state))
  scanner.on('update', market => {
    automation.setMarket(market)
    sendToRenderer('market-update', market)
  })
  scanner.on('raw', ({ payload, fetchedAt }) => {
    try {
      collector.record(payload, fetchedAt)
      const trader = settings().config.automation.autoTrader || {}
      const refreshMs = Math.max(1, Number(trader.strategyRefreshMinutes) || 15) * 60000
      if (trader.enabled && trader.automaticConfigAndFilter && Date.now() - lastAutomaticStrategyAt >= refreshMs) {
        const result = dynamicStrategy.generate({ purse: Number(trader.strategyPurse) || 150000000, lookbackHours: Number(trader.strategyLookbackHours) || 24 })
        dynamicStrategy.apply()
        lastAutomaticStrategyAt = Date.now()
        pushLog('success', `[Auto Trader] Dynamic config/filter applied automatically: ${result.summary.selectedItems} selected items.`)
      }
    } catch (error) { pushLog('error', `Collector/automatic strategy: ${error.message}`) }
  })
  collector.on('state', state => sendToRenderer('collector-state', state))
  registerIpc()
  lanServer = new LanServer({
    root: path.join(__dirname, '..'),
    dataDir,
    log: pushLog,
    invoke: async (method, args) => {
      const handler = commandHandlers.get(method)
      if (!handler) throw new Error(`Phone command is not available: ${method}`)
      return handler(...args)
    }
  })
  try { await lanServer.start() } catch (error) { pushLog('error', `Phone dashboard could not start: ${error.message}`) }
  createWindow()
  pushLog('info', 'XYZ FLIPPER started with the Azalea 26.2 engine.')
  if (settings().config.collector.enabled && settings().config.collector.autoStart) scanner.start()
  */
  registerIpc()
  lanServer = new LanServer({
    root: path.join(__dirname, '..'),
    dataDir,
    port: 9090,
    version: app.getVersion(),
    scannerReportProvider: () => ({
      content: scannerLogReport(activeContext()),
      instanceName: String(activeContext()?.name || 'scanner').replace(/[^a-z0-9_-]+/gi, '-')
    }),
    usernameProvider: () => settings().config.webpage?.username || 'xyz',
    passwordProvider: () => settings().config.webpage?.password || '',
    log: pushLog,
    invoke: async (method, args) => {
      const handler = commandHandlers.get(method)
      if (!handler) throw new Error(`Web command is not available: ${method}`)
      return handler(...args)
    }
  })
  try {
    await lanServer.start()
    createTray()
    ensureLanFirewallRule()
    if (process.env.FF_UI_SCREENSHOT) createWindow()
    else {
      ensureWebCredentialsFile()
      openWebDashboard()
    }
  } catch (error) {
    pushLog('error', `Web dashboard could not start: ${error.message}`)
    createWindow()
  }
  pushLog(fleetSafety.active ? 'error' : 'info', fleetSafety.active
    ? `[BAN SAFETY] ${listing.instances.length} instance(s) loaded but remain stopped. Previous ban disconnect: ${fleetSafety.sourceInstanceName || 'unknown instance'} at ${fleetSafety.detectedAt || 'unknown time'}; duration: ${fleetSafety.durationText || 'not specified by server'}.`
    : `${listing.instances.length} XYZ FLIPPER instance(s) loaded.`)
})

app.on('window-all-closed', () => {
  if (process.env.FF_UI_SCREENSHOT || !lanServer?.server?.listening) {
    shutdownXyzFlipper()
    app.quit()
  }
})
app.on('second-instance', openWebDashboard)
app.on('before-quit', shutdownXyzFlipper)
