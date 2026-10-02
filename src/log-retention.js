'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_LOG_AGE_MS = 48 * 60 * 60 * 1000
const LOG_FILE_PATTERN = /\.(?:log|jsonl)$/i
const HEARTBEAT_SAMPLE_MS = 5 * 60 * 1000

function timestampForLine(line, fallback) {
  try {
    const parsed = Date.parse(JSON.parse(line)?.at)
    if (Number.isFinite(parsed)) return parsed
  } catch {}
  return fallback
}

function collectLogFiles(root) {
  const files = []
  const visit = directory => {
    let entries = []
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'auth-cache') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (LOG_FILE_PATTERN.test(entry.name)) files.push(full)
    }
  }
  visit(root)
  return files
}

function parseRecord(line) {
  try { return JSON.parse(line) } catch { return null }
}

function compactRecord(file, line) {
  const record = parseRecord(line)
  if (!record) return { line, kind: 'plain', priority: 2 }
  const name = path.basename(file).toLowerCase()
  // Packet-level files duplicate instance Bazaar chat but can be huge.
  if (name === 'full-chat.jsonl' || name === 'window-snapshots.jsonl') return null
  if (name === 'bazaar-chat.jsonl') {
    const text = String(record.text || '').trim()
    if (!text) return null
    return {
      line: JSON.stringify({ at: record.at, text }),
      kind: 'chat',
      priority: /\[Bazaar\]|Purse:|Your Island|profile:/i.test(text) ? 5 : 3
    }
  }
  const message = String(record.message || '')
  if (/\[Auto Trader Diagnostics\] heartbeat:/i.test(message)) {
    return { line: JSON.stringify({ at: record.at, level: 'debug', message }), kind: 'heartbeat', priority: 1 }
  }
  if (name === 'ff-trader-diagnostics.jsonl') {
    if (record.reason === 'window') return null
    return { line: JSON.stringify(record), kind: 'diagnostic', priority: 2 }
  }
  if (record.message !== undefined) {
    return {
      line: JSON.stringify({ at: record.at, level: record.level, message, instanceId: record.instanceId, instanceName: record.instanceName }),
      kind: 'event',
      priority: /^(?:error|warning|success)$/i.test(String(record.level)) ? 6 : (record.level === 'chat' ? 4 : 3)
    }
  }
  return { line: JSON.stringify(record), kind: 'record', priority: 2 }
}

// The 10 MB budget is shared by every runtime .log/.jsonl file. If 48 hours
// of output will not fit, the newest records win.
function pruneLogFiles(root, { now = Date.now(), maxBytes = MAX_LOG_BYTES, maxAgeMs = MAX_LOG_AGE_MS } = {}) {
  const cutoff = now - maxAgeMs
  const byFile = new Map()
  const originalByFile = new Map()
  const records = []
  const heartbeatSamples = new Set()
  for (const file of collectLogFiles(root)) {
    let stat; let text
    try { stat = fs.statSync(file); text = fs.readFileSync(file, 'utf8') } catch { continue }
    const fallback = Number(stat.mtimeMs) || now
    const lines = text.split(/\r?\n/).filter(Boolean)
    byFile.set(file, [])
    originalByFile.set(file, text)
    for (let index = 0; index < lines.length; index += 1) {
      const compact = compactRecord(file, lines[index])
      if (!compact) continue
      const at = timestampForLine(compact.line, fallback)
      if (at < cutoff) continue
      // A five-minute cadence preserves the diagnostic timeline without a
      // heartbeat line every thirty seconds for two days.
      if (compact.kind === 'heartbeat') {
        const bucket = `${file}:${Math.floor(at / HEARTBEAT_SAMPLE_MS)}`
        if (heartbeatSamples.has(bucket)) continue
        heartbeatSamples.add(bucket)
      }
      records.push({ file, line: compact.line, at, index, priority: compact.priority, bytes: Buffer.byteLength(`${compact.line}\n`, 'utf8') })
    }
  }
  // Under a very busy 48-hour window, keep errors and Bazaar actions before
  // routine debug/status lines; within each class the newest records win.
  records.sort((left, right) => right.priority - left.priority || right.at - left.at || right.index - left.index)
  let bytes = 0
  for (const record of records) {
    if (bytes + record.bytes > maxBytes) continue
    bytes += record.bytes
    byFile.get(record.file).push(record)
  }
  let changed = 0
  for (const [file, retained] of byFile) {
    retained.sort((left, right) => left.at - right.at || left.index - right.index)
    const rendered = retained.length ? `${retained.map(record => record.line).join('\n')}\n` : ''
    try {
      if (originalByFile.get(file) !== rendered) { fs.writeFileSync(file, rendered, 'utf8'); changed += 1 }
    } catch {}
  }
  return { files: byFile.size, bytes, changed }
}

module.exports = { MAX_LOG_BYTES, MAX_LOG_AGE_MS, collectLogFiles, pruneLogFiles, compactRecord }
