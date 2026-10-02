'use strict'

const { EventEmitter } = require('node:events')

const DEFAULT_ENDPOINT = 'https://bans.fisproxy.org'
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
const DEFAULT_BACKOFF_BASE_MS = 1_000
const DEFAULT_BACKOFF_MAX_MS = 30_000
const ENGINE_PAYLOAD_SEPARATOR = '\x1e'

function finiteNonNegativeInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(1_000_000, Math.floor(number))
}

function thresholdForRate(value) {
  const rate = Math.max(0, Number(value) || 0)
  if (rate > 100) return { level: 'critical', mode: 'three-hours', holdMs: 3 * 60 * 60 * 1000 }
  if (rate > 30) return { level: 'high', mode: 'timed', holdMs: 60 * 60 * 1000 }
  if (rate > 10) return { level: 'elevated', mode: 'timed', holdMs: 15 * 60 * 1000 }
  return null
}

function parseJsonSuffix(packet, from = 1) {
  const start = packet.indexOf('{', from)
  if (start < 0) return null
  try { return JSON.parse(packet.slice(start)) } catch { return null }
}

function parseSocketEvent(packet) {
  const start = packet.indexOf('[')
  if (start < 0) return null
  try {
    const decoded = JSON.parse(packet.slice(start))
    if (!Array.isArray(decoded) || typeof decoded[0] !== 'string') return null
    return { name: decoded[0], data: decoded[1] }
  } catch {
    return null
  }
}

/**
 * Parse an Engine.IO v4 polling payload without performing any I/O.
 * Socket.IO event packets are exposed as { name, data }; Engine.IO ping data
 * is preserved so callers can reply with the matching pong payload.
 */
function parseEnginePayload(raw) {
  const packets = String(raw ?? '').split(ENGINE_PAYLOAD_SEPARATOR).filter(Boolean)
  const result = {
    packets,
    handshake: null,
    socketConnected: false,
    close: false,
    pings: [],
    events: [],
    malformed: []
  }
  for (const packet of packets) {
    if (packet.startsWith('0')) {
      const handshake = parseJsonSuffix(packet)
      if (handshake && typeof handshake.sid === 'string') result.handshake = handshake
      else result.malformed.push(packet)
      continue
    }
    if (packet.startsWith('2')) {
      result.pings.push(`3${packet.slice(1)}`)
      continue
    }
    if (packet === '1') {
      result.close = true
      continue
    }
    if (packet.startsWith('40')) {
      result.socketConnected = true
      continue
    }
    if (packet.startsWith('42')) {
      const event = parseSocketEvent(packet)
      if (event) result.events.push(event)
      else result.malformed.push(packet)
    }
  }
  return result
}

function extractBanRecords(name, payload) {
  if (name !== 'historyData' && name !== 'banUpdate') return []
  if (Array.isArray(payload)) return payload.flatMap(value => Array.isArray(value) ? value : [value]).filter(value => value && typeof value === 'object')
  if (!payload || typeof payload !== 'object') return []
  if (name === 'historyData') {
    for (const key of ['history', 'records', 'items', 'bans', 'data']) {
      if (Array.isArray(payload[key])) return payload[key].filter(value => value && typeof value === 'object')
    }
  }
  return [payload]
}

function rawTimestamp(record) {
  for (const key of ['timestamp', 'time', 'createdAt', 'created_at', 'observedAt', 'observed_at', 'at', 'date']) {
    if (record?.[key] !== undefined && record[key] !== null && record[key] !== '') return record[key]
  }
  return null
}

function timestampMilliseconds(value) {
  if (value === null || value === undefined || value === '') return NaN
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return NaN
    return number < 100_000_000_000 ? Math.round(number * 1000) : Math.round(number)
  }
  return Date.parse(String(value))
}

function explicitRecordId(record) {
  for (const key of ['id', '_id', 'eventId', 'event_id', 'banId', 'ban_id', 'uuid']) {
    const value = record?.[key]
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }
  return ''
}

function stableValue(value, depth = 0) {
  if (depth > 5) return '[depth]'
  if (Array.isArray(value)) return value.slice(0, 64).map(item => stableValue(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().slice(0, 64).map(key => [key, stableValue(value[key], depth + 1)]))
  }
  if (typeof value === 'string') return value.slice(0, 256)
  return value
}

function normalizeBanRecord(record, receivedAt = Date.now(), eventName = 'banUpdate') {
  if (!record || typeof record !== 'object') return null
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : null
  const source = nested ? { ...record, ...nested } : record
  const watchdog = finiteNonNegativeInteger(source.watchdog_increment)
  const staff = finiteNonNegativeInteger(source.staff_increment)
  if (watchdog + staff <= 0) return null

  const received = Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : Date.now()
  const sourceTimestamp = rawTimestamp(source) ?? rawTimestamp(record)
  let at = timestampMilliseconds(sourceTimestamp)
  const hasSourceTimestamp = Number.isFinite(at)
  if (!hasSourceTimestamp || at > received + 5000) at = received

  const id = explicitRecordId(source) || explicitRecordId(record)
  const identity = id
    ? { key: `id:${id}`, durable: true }
    : hasSourceTimestamp
      ? { key: `time:${at}|w:${watchdog}|s:${staff}|${JSON.stringify(stableValue(source))}`, durable: true }
      : { key: `volatile:${eventName}|w:${watchdog}|s:${staff}|${JSON.stringify(stableValue(source))}`, durable: false }

  return { at, watchdog, staff, key: identity.key, durable: identity.durable }
}

function boundedBackoff(attempt, { baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS, random = Math.random } = {}) {
  const exponent = Math.max(0, Math.min(20, Math.floor(Number(attempt) || 0)))
  const base = Math.max(1, Number(baseMs) || DEFAULT_BACKOFF_BASE_MS)
  const maximum = Math.max(base, Number(maxMs) || DEFAULT_BACKOFF_MAX_MS)
  const raw = Math.min(maximum, base * (2 ** exponent))
  const randomValue = Math.max(0, Math.min(1, Number(random?.()) || 0))
  return Math.max(1, Math.min(maximum, Math.round(raw * (0.8 + randomValue * 0.4))))
}

function thresholdRank(level) {
  return { elevated: 1, high: 2, critical: 3 }[String(level || '')] || 0
}

class BanRateGuard extends EventEmitter {
  constructor(options = {}) {
    super()
    const endpoint = new URL(String(options.endpoint || DEFAULT_ENDPOINT))
    if (!/^https?:$/.test(endpoint.protocol)) throw new Error('Ban rate endpoint must use HTTP or HTTPS.')
    this.origin = endpoint.origin
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis) || null
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.random = typeof options.random === 'function' ? options.random : Math.random
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.windowMs = Math.max(1000, Number(options.windowMs) || DEFAULT_WINDOW_MS)
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)
    this.backoffBaseMs = Math.max(1, Number(options.backoffBaseMs) || DEFAULT_BACKOFF_BASE_MS)
    this.backoffMaxMs = Math.max(this.backoffBaseMs, Number(options.backoffMaxMs) || DEFAULT_BACKOFF_MAX_MS)
    this.maxPayloadBytes = Math.max(1024, Number(options.maxPayloadBytes) || 1_000_000)

    this.running = false
    this.networkStatus = 'stopped'
    this.sessionId = ''
    this.entries = []
    this.seen = new Map()
    this.rate = 0
    this.watchdogRate = 0
    this.staffRate = 0
    this.level = ''
    this.mode = ''
    this.holdUntil = 0
    this.untilRestart = false
    this.lastSuccessAt = 0
    this.lastError = ''
    this.retryInMs = 0
    this.failureCount = 0
    this.activeAbort = null
    this.sleepTimer = null
    this.resolveSleep = null
    this.requestCounter = 0
    this.loopPromise = null
  }

  start() {
    if (this.running) return this.snapshot()
    this.running = true
    this.networkStatus = 'connecting'
    this.lastError = ''
    this.retryInMs = 0
    this.loopPromise = this.runLoop().catch(error => {
      if (this.running) this.noteFailure(error)
    })
    return this.snapshot()
  }

  stop() {
    this.running = false
    this.networkStatus = 'stopped'
    this.sessionId = ''
    this.retryInMs = 0
    try { this.activeAbort?.abort() } catch {}
    this.activeAbort = null
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    const resolve = this.resolveSleep
    this.resolveSleep = null
    resolve?.()
    return this.snapshot()
  }

  snapshot() {
    const now = this.currentTime()
    this.recalculate(now)
    const blocked = this.untilRestart || this.holdUntil > now
    return {
      running: this.running,
      networkStatus: this.networkStatus,
      failOpen: !blocked && this.networkStatus !== 'online',
      rate: this.rate,
      watchdogRate: this.watchdogRate,
      staffRate: this.staffRate,
      windowMs: this.windowMs,
      blocked,
      level: blocked ? this.level : '',
      mode: blocked ? this.mode : '',
      holdUntil: this.untilRestart ? null : (this.holdUntil || null),
      untilRestart: this.untilRestart,
      lastSuccessAt: this.lastSuccessAt || null,
      lastError: this.lastError,
      retryInMs: this.retryInMs
    }
  }

  currentTime() {
    const value = Number(this.now())
    return Number.isFinite(value) ? value : Date.now()
  }

  ingest(name, payload, receivedAt = this.currentTime()) {
    const now = Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : this.currentTime()
    const records = extractBanRecords(name, payload)
    let added = 0
    this.pruneSeen(now)
    for (const raw of records) {
      const record = normalizeBanRecord(raw, now, name)
      if (!record) continue
      const previous = this.seen.get(record.key)
      const ttl = record.durable ? Math.max(this.windowMs * 2, 120_000) : 5_000
      if (previous !== undefined && now - previous < ttl) continue
      this.seen.set(record.key, now)
      if (record.at < now - this.windowMs || record.at > now + 5000) continue
      this.entries.push(record)
      added += 1
    }
    this.recalculate(now, { evaluateThreshold: added > 0 })
    return { added, ...this.snapshot() }
  }

  pruneSeen(now) {
    const retention = Math.max(this.windowMs * 3, 180_000)
    for (const [key, seenAt] of this.seen) if (now - seenAt > retention) this.seen.delete(key)
  }

  recalculate(now, { evaluateThreshold = false } = {}) {
    this.entries = this.entries.filter(entry => entry.at >= now - this.windowMs && entry.at <= now + 5000)
    let watchdog = 0
    let staff = 0
    for (const entry of this.entries) {
      watchdog += entry.watchdog
      staff += entry.staff
    }
    const rate = watchdog + staff
    const changed = rate !== this.rate || watchdog !== this.watchdogRate || staff !== this.staffRate
    this.rate = rate
    this.watchdogRate = watchdog
    this.staffRate = staff
    if (changed) this.emit('rate', { rate, watchdog, staff, windowMs: this.windowMs, observedAt: now })
    if (evaluateThreshold) this.applyThreshold(rate, now)
    if (!this.untilRestart && this.holdUntil <= now) {
      this.holdUntil = 0
      this.level = ''
      this.mode = ''
    }
  }

  applyThreshold(rate, observedAt) {
    const threshold = thresholdForRate(rate)
    if (!threshold || this.untilRestart) return
    const existingBlocked = this.holdUntil > observedAt
    if (existingBlocked && thresholdRank(threshold.level) < thresholdRank(this.level)) return

    this.holdUntil = Math.max(this.holdUntil, observedAt + threshold.holdMs)
    this.level = threshold.level
    this.mode = threshold.mode
    this.emit('threshold', { rate, ...threshold, observedAt })
  }

  socketUrl(sessionId = '') {
    const url = new URL('/socket.io/', this.origin)
    url.searchParams.set('EIO', '4')
    url.searchParams.set('transport', 'polling')
    url.searchParams.set('t', `${Math.floor(this.currentTime()).toString(36)}-${++this.requestCounter}`)
    if (sessionId) url.searchParams.set('sid', sessionId)
    return url
  }

  async request(method, url, body) {
    if (!this.fetch) throw new Error('Fetch API is unavailable; ban-rate monitoring remains fail-open.')
    if (url.origin !== this.origin) throw new Error('Cross-origin ban-rate request was blocked.')
    const controller = new AbortController()
    this.activeAbort = controller
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    timeout.unref?.()
    try {
      const response = await this.fetch(url.href, {
        method,
        body,
        signal: controller.signal,
        redirect: 'manual',
        headers: body === undefined
          ? { Accept: 'text/plain' }
          : { Accept: 'text/plain', 'Content-Type': 'text/plain;charset=UTF-8' }
      })
      const status = Number(response?.status)
      if (Number.isFinite(status) && status >= 300 && status < 400) throw new Error(`Ban-rate endpoint redirect was blocked (HTTP ${status}).`)
      if (response?.ok === false || Number.isFinite(status) && status >= 400) throw new Error(`Ban-rate endpoint returned HTTP ${status || 'error'}.`)
      if (response?.url && new URL(response.url).origin !== this.origin) throw new Error('Cross-origin ban-rate response was blocked.')
      const declared = Number(response?.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > this.maxPayloadBytes) throw new Error('Ban-rate payload exceeded the size limit.')
      const text = String(await response.text())
      if (Buffer.byteLength(text, 'utf8') > this.maxPayloadBytes) throw new Error('Ban-rate payload exceeded the size limit.')
      return text
    } catch (error) {
      if (timedOut) throw new Error(`Ban-rate request timed out after ${this.requestTimeoutMs}ms.`)
      throw error
    } finally {
      clearTimeout(timeout)
      if (this.activeAbort === controller) this.activeAbort = null
    }
  }

  noteSuccess() {
    const now = this.currentTime()
    this.networkStatus = 'online'
    this.lastSuccessAt = now
    this.lastError = ''
    this.retryInMs = 0
    this.failureCount = 0
    this.recalculate(now)
  }

  noteFailure(error) {
    const message = String(error?.message || error || 'Unknown ban-rate endpoint failure.')
    this.networkStatus = 'offline'
    this.lastError = message
    this.sessionId = ''
    this.log('warning', `[Ban Rate Guard] ${message} Monitoring is fail-open; retrying with bounded backoff.`)
  }

  async connectAndPoll() {
    const handshakeText = await this.request('GET', this.socketUrl())
    const handshake = parseEnginePayload(handshakeText).handshake
    if (!handshake?.sid) throw new Error('Ban-rate endpoint returned an invalid Engine.IO handshake.')
    this.sessionId = String(handshake.sid)
    await this.request('POST', this.socketUrl(this.sessionId), '40')
    this.noteSuccess()

    while (this.running && this.sessionId) {
      const text = await this.request('GET', this.socketUrl(this.sessionId))
      const parsed = parseEnginePayload(text)
      if (parsed.close) throw new Error('Ban-rate Engine.IO session was closed by the server.')
      for (const pong of parsed.pings) await this.request('POST', this.socketUrl(this.sessionId), pong)
      for (const event of parsed.events) this.ingest(event.name, event.data, this.currentTime())
      this.noteSuccess()
    }
  }

  async sleep(milliseconds) {
    if (!this.running || milliseconds <= 0) return
    await new Promise(resolve => {
      this.resolveSleep = resolve
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null
        this.resolveSleep = null
        resolve()
      }, milliseconds)
      this.sleepTimer.unref?.()
    })
  }

  async runLoop() {
    while (this.running) {
      try {
        await this.connectAndPoll()
        if (this.running) throw new Error('Ban-rate polling session ended unexpectedly.')
      } catch (error) {
        if (!this.running) break
        this.noteFailure(error)
        const delay = boundedBackoff(this.failureCount++, {
          baseMs: this.backoffBaseMs,
          maxMs: this.backoffMaxMs,
          random: this.random
        })
        this.retryInMs = delay
        await this.sleep(delay)
      }
    }
  }
}

module.exports = {
  BanRateGuard,
  thresholdForRate,
  parseEnginePayload,
  extractBanRecords,
  normalizeBanRecord,
  boundedBackoff
}
