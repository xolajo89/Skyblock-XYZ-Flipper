'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const MAX_IMPORT_BYTES = 1024 * 1024
const MAX_PROXIES = 5000
const DEFAULT_UNHEALTHY_MS = 30 * 60 * 1000

function clean(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim()
}

function normalizeCountry(value) {
  const country = clean(value).replaceAll('_', ' ').replace(/\s+/g, ' ')
  if (!country) return 'Unknown'
  return country.length === 2 ? country.toUpperCase() : country.slice(0, 64)
}

function countryFromUsername(username) {
  const value = clean(username)
  const match = value.match(/(?:^|[-_])country[-_]?([a-z]{2})(?:[-_]|$)/i)
  return match ? match[1].toUpperCase() : ''
}

function stableProxyId(proxy) {
  return crypto.createHash('sha256')
    .update(`${proxy.ip}\u0000${proxy.port}\u0000${proxy.username}`)
    .digest('hex')
    .slice(0, 20)
}

function normalizeProxy(input, fallbackCountry = '') {
  const ip = clean(input.ip ?? input.host ?? input.proxy_address ?? input.address)
  const port = Number(input.port ?? input.proxy_port)
  const username = clean(input.username ?? input.user ?? input.proxy_username)
  const password = String(input.password ?? input.pass ?? input.proxy_password ?? '').trim()
  if (net.isIP(ip) === 0) throw new Error('Proxy host must be a literal IPv4 or IPv6 address.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535.')
  if (!username || !password) throw new Error('Proxy username and password are required.')
  const explicitCountry = input.country ?? input.country_code ?? input.countryCode ?? input.location
  const country = normalizeCountry(clean(explicitCountry) || countryFromUsername(username) || fallbackCountry)
  const proxy = { ip, port, username, password, country }
  return { id: stableProxyId(proxy), ...proxy }
}

function splitDelimited(line, delimiter) {
  const cells = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (character === delimiter && !quoted) {
      cells.push(value.trim()); value = ''
    } else value += character
  }
  cells.push(value.trim())
  return cells
}

function parseJsonList(text) {
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  for (const key of ['proxies', 'results', 'data']) if (Array.isArray(parsed?.[key])) return parsed[key]
  if (parsed && typeof parsed === 'object') return [parsed]
  throw new Error('JSON does not contain a proxy list.')
}

function headerKey(value) {
  return clean(value).toLowerCase().replace(/[\s-]+/g, '_')
}

function parseDelimitedList(lines, delimiter) {
  const headers = splitDelimited(lines[0], delimiter).map(headerKey)
  const recognized = headers.some(header => ['ip', 'host', 'proxy_address', 'address'].includes(header)) && headers.some(header => ['port', 'proxy_port'].includes(header))
  if (!recognized) return null
  return lines.slice(1).map(line => {
    const cells = splitDelimited(line, delimiter)
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
  })
}

function parseTextLine(line) {
  const value = clean(line)
  const uri = value.match(/^socks5:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/i)
  if (uri) return { username: decodeURIComponent(uri[1]), password: decodeURIComponent(uri[2]), ip: uri[3], port: uri[4] }
  const pieces = value.split(':')
  if (pieces.length < 4) throw new Error('Expected IP:PORT:USERNAME:PASSWORD.')
  const [ip, port, username, ...password] = pieces
  return { ip, port, username, password: password.join(':') }
}

function parseProxyImport(content, options = {}) {
  const text = String(content ?? '')
  if (!text.trim()) throw new Error('The selected proxy list is empty.')
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new Error('Proxy list must be smaller than 1 MB.')
  const filename = clean(options.filename)
  const fallbackCountry = clean(options.country)
  const rawLines = text.split(/\r?\n/).map(clean).filter(line => line && !line.startsWith('#'))
  let inputs
  if (/\.json$/i.test(filename) || /^[\[{]/.test(text.trim())) {
    inputs = parseJsonList(text)
  } else {
    const first = rawLines[0] || ''
    const delimiter = first.includes('\t') ? '\t' : (first.includes(',') ? ',' : '')
    inputs = delimiter ? parseDelimitedList(rawLines, delimiter) : null
    if (!inputs) inputs = rawLines.map(parseTextLine)
  }
  const records = []
  const errors = []
  const seen = new Set()
  for (let index = 0; index < inputs.length; index += 1) {
    try {
      const record = normalizeProxy(inputs[index], fallbackCountry)
      if (seen.has(record.id)) continue
      seen.add(record.id)
      if (records.length >= MAX_PROXIES) throw new Error(`A maximum of ${MAX_PROXIES} proxies can be imported at once.`)
      records.push(record)
    } catch (error) {
      errors.push({ line: index + 1, message: error.message })
    }
  }
  if (!records.length) throw new Error(errors[0]?.message || 'No valid SOCKS5 proxies were found.')
  return { records, errors, sourceName: filename || 'pasted proxy list' }
}

class ProxyPool {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'proxy-pool.json')
    this.records = []
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.records = Array.isArray(parsed?.proxies) ? parsed.proxies.map(item => ({ ...item, ...normalizeProxy(item, item.country) })) : []
    } catch { this.records = [] }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, proxies: this.records }, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, this.file)
  }

  import(content, options = {}) {
    const parsed = parseProxyImport(content, options)
    const current = new Map(this.records.map(record => [record.id, record]))
    let added = 0; let updated = 0
    for (const record of parsed.records) {
      const previous = current.get(record.id)
      const next = {
        ...previous,
        ...record,
        country: record.country === 'Unknown' && previous?.country ? previous.country : record.country,
        sourceName: parsed.sourceName,
        importedAt: new Date().toISOString()
      }
      if (previous) updated += 1
      else added += 1
      current.set(record.id, next)
    }
    this.records = [...current.values()].slice(0, MAX_PROXIES)
    this.save()
    return { added, updated, invalid: parsed.errors.length, errors: parsed.errors.slice(0, 5) }
  }

  get(id) {
    return this.records.find(record => record.id === String(id)) || null
  }

  remove(id) {
    const before = this.records.length
    this.records = this.records.filter(record => record.id !== String(id))
    if (this.records.length === before) return false
    this.save()
    return true
  }

  clear() {
    const removed = this.records.length
    this.records = []
    this.save()
    return removed
  }

  findId(proxy = {}) {
    if (!proxy.ip || !proxy.port || !proxy.username) return ''
    try { return stableProxyId(normalizeProxy(proxy, proxy.country)) } catch { return '' }
  }

  markUnhealthy(id, durationMs = DEFAULT_UNHEALTHY_MS, now = Date.now(), reason = 'endpoint failure') {
    const record = this.get(id)
    if (!record) return null
    const boundedDuration = Math.max(1000, Number(durationMs) || DEFAULT_UNHEALTHY_MS)
    record.unhealthyAt = new Date(now).toISOString()
    record.unhealthyUntil = new Date(now + boundedDuration).toISOString()
    record.unhealthyReason = String(reason || 'endpoint failure').slice(0, 160)
    this.save()
    return record
  }

  isHealthy(record, now = Date.now()) {
    if (!record) return false
    const unhealthyUntil = Date.parse(record.unhealthyUntil || '')
    return !Number.isFinite(unhealthyUntil) || unhealthyUntil <= now
  }

  findHealthyReplacement(options = {}, now = Date.now()) {
    const currentId = String(options.currentId || options.excludeId || '')
    const country = normalizeCountry(options.country || this.get(currentId)?.country || '')
    const usedIds = new Set(Array.from(options.usedIds || [], value => String(value || '')))
    if (currentId) usedIds.add(currentId)
    return this.records.find(record => (
      !usedIds.has(record.id)
      && normalizeCountry(record.country) === country
      && this.isHealthy(record, now)
    )) || null
  }

  publicRecords() {
    return this.records.map(record => ({
      id: record.id,
      ip: record.ip,
      port: record.port,
      country: record.country,
      usernameHint: record.username.length <= 4 ? '••••' : `${record.username.slice(0, 2)}••${record.username.slice(-2)}`,
      sourceName: record.sourceName || '',
      unhealthyUntil: record.unhealthyUntil || '',
      unhealthy: !this.isHealthy(record)
    }))
  }
}

module.exports = { ProxyPool, normalizeProxy, parseProxyImport, stableProxyId, DEFAULT_UNHEALTHY_MS }
