'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { validateConfig, validateFilter } = require('./validator')

class ConfigStore {
  constructor(dataDir, defaultsDir) {
    this.dataDir = dataDir
    this.defaultsDir = defaultsDir
    this.backupDir = path.join(dataDir, 'backups')
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(this.backupDir, { recursive: true })
    for (const kind of ['config', 'filter']) this.ensure(kind)
  }

  file(kind) {
    if (!['config', 'filter'].includes(kind)) throw new Error('Unsupported file type.')
    return path.join(this.dataDir, `${kind}.json`)
  }

  ensure(kind) {
    const target = this.file(kind)
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(this.defaultsDir, `${kind}.json`), target)
  }

  read(kind) {
    const file = this.file(kind)
    const stored = fs.readFileSync(file, 'utf8')
    const parsed = this.migrate(kind, JSON.parse(stored))
    const content = `${JSON.stringify(parsed, null, 2)}\n`
    // Persist migrations once so removed settings do not remain visible in the
    // editor or return through a later save.
    if (stored.trim() !== content.trim()) fs.writeFileSync(file, content, 'utf8')
    const errors = kind === 'config' ? validateConfig(parsed) : validateFilter(parsed)
    return { kind, path: file, content, parsed, errors }
  }

  defaults(kind) {
    return JSON.parse(fs.readFileSync(path.join(this.defaultsDir, `${kind}.json`), 'utf8'))
  }

  merge(base, incoming) {
    if (!base || typeof base !== 'object' || Array.isArray(base) || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
    const result = { ...base }
    for (const [key, value] of Object.entries(incoming)) result[key] = key in base ? this.merge(base[key], value) : value
    return result
  }

  migrate(kind, parsed) {
    const migrated = this.merge(this.defaults(kind), parsed)
    if (kind === 'config') {
      delete migrated.humanSimulation
      delete migrated.respectCoopOrders
      // Engine settings are deliberately internal. Keep unrelated website,
      // webhook, appearance and implementation controls out of the editable
      // trading file, while retaining the documented connection/rest fields.
      for (const key of [
        'key', 'webhook', 'detailedWebhooks', 'friendlyKeys',
        'discord', 'automation', 'sessionBreakdown', 'collector', 'scanner',
        'taxPercent', 'accountLabel', 'username', 'flipOnIsland'
      ]) delete migrated[key]
      if (!migrated.webpage || typeof migrated.webpage !== 'object') migrated.webpage = {}
      if (!String(migrated.webpage.username || '').trim()) migrated.webpage.username = 'xyz'
      if (!String(migrated.webpage.password || '').trim()) migrated.webpage.password = crypto.randomBytes(12).toString('base64url').slice(0, 16)
      if (migrated.proxy && typeof migrated.proxy === 'object' && !Array.isArray(migrated.proxy)) {
        if ((!migrated.proxy.ip || (Array.isArray(migrated.proxy.ip) && !migrated.proxy.ip.length)) && migrated.proxy.host !== undefined) migrated.proxy.ip = migrated.proxy.host
        delete migrated.proxy.host
        delete migrated.proxy.type
      }
      delete migrated.orders?.MaxItemAmount
      // Stale-order timing is an internal safety rule. Remove the short-lived
      // editable field from older 0.9.89 files so it cannot be misconfigured.
      delete migrated.orders?.relistAfterMinutes
    } else if (kind === 'filter') {
      for (const group of ['whitelist', 'selectiveBuys']) {
        for (const criteria of Object.values(migrated[group] || {})) {
          if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) delete criteria.relistAfterMinutes
        }
      }
    }
    return migrated
  }

  save(kind, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('JSON file must be text smaller than 2 MB.')
    let parsed
    try { parsed = JSON.parse(content) } catch (error) { throw new Error(`Invalid JSON: ${error.message}`) }
    parsed = this.migrate(kind, parsed)
    const errors = kind === 'config' ? validateConfig(parsed) : validateFilter(parsed)
    if (errors.length) throw new Error(errors.join('\n'))
    const target = this.file(kind)
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(this.backupDir, `${kind}-${stamp}.json`))
    const temporary = `${target}.tmp`
    const rendered = `${JSON.stringify(parsed, null, 2)}\n`
    fs.writeFileSync(temporary, rendered, 'utf8')
    fs.renameSync(temporary, target)
    this.trim(kind)
    return { kind, path: target, content: rendered, parsed, errors: [] }
  }

  trim(kind) {
    const files = fs.readdirSync(this.backupDir).filter(name => name.startsWith(`${kind}-`)).sort().reverse()
    for (const old of files.slice(20)) fs.rmSync(path.join(this.backupDir, old), { force: true })
  }

  restore(kind) {
    const files = fs.readdirSync(this.backupDir).filter(name => name.startsWith(`${kind}-`)).sort().reverse()
    if (!files.length) throw new Error(`No ${kind} backup is available.`)
    const content = fs.readFileSync(path.join(this.backupDir, files[0]), 'utf8')
    return this.save(kind, content)
  }
}

module.exports = { ConfigStore }
