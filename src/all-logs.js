'use strict'

const fs = require('node:fs')
const path = require('node:path')

function logFiles(root) {
  const files = []
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'auth-cache') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.(?:log|jsonl)$/i.test(entry.name)) files.push(full)
    }
  }
  if (fs.existsSync(root)) visit(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function buildAllLogsReport(dataDir, version = '') {
  const files = logFiles(dataDir)
  const header = [
    `XYZ FLIPPER${version ? ` ${version}` : ''} all logs`,
    `Exported: ${new Date().toISOString()}`,
    `Files: ${files.length}`,
    ''
  ]
  if (!files.length) return Buffer.from(`${header.join('\n')}No FF logs have been recorded yet.\n`, 'utf8')
  const sections = files.map(file => {
    const relative = path.relative(dataDir, file).replaceAll('\\', '/')
    let content = ''
    try { content = fs.readFileSync(file, 'utf8') }
    catch (error) { content = `[Could not read this log: ${error.message}]\n` }
    return `===== ${relative} =====\n${content.trimEnd()}\n`
  })
  return Buffer.from(`${header.join('\n')}${sections.join('\n')}`, 'utf8')
}

module.exports = { buildAllLogsReport, logFiles }
