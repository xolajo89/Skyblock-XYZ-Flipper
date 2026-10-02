'use strict'

const fs = require('node:fs')
const path = require('node:path')

class InstanceStore {
  constructor(root) {
    this.root = root
    this.file = path.join(root, 'instances.json')
    this.instancesRoot = path.join(root, 'instances')
    fs.mkdirSync(this.instancesRoot, { recursive: true })
    if (!fs.existsSync(this.file)) this.write({ selectedId: 'ff-1', instances: [{ id: 'ff-1', name: 'FF-1', createdAt: new Date().toISOString() }] })
    else this.upgradeNames()
  }
  read() { return JSON.parse(fs.readFileSync(this.file, 'utf8')) }
  upgradeNames() {
    const data = this.read()
    let changed = false
    const legacyPattern = new RegExp(`^${['m', 'b', 'f'].join('')}[-_]?(\\d+)$`, 'i')
    data.instances.forEach((item, index) => {
      const idMatch = String(item.id || '').match(legacyPattern)
      if (idMatch) {
        const previousId = item.id
        const nextId = `ff-${idMatch[1]}`
        const previousDirectory = path.join(this.instancesRoot, previousId)
        const nextDirectory = path.join(this.instancesRoot, nextId)
        if (fs.existsSync(previousDirectory) && !fs.existsSync(nextDirectory)) {
          fs.renameSync(previousDirectory, nextDirectory)
        }
        item.id = nextId
        if (data.selectedId === previousId) data.selectedId = nextId
        changed = true
      }
      if (legacyPattern.test(item.name || '')) {
        item.name = `FF-${index + 1}`
        changed = true
      }
    })
    if (changed) this.write(data)
  }
  write(data) { fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8') }
  directory(id) { return path.join(this.instancesRoot, id) }
  list() { return this.read() }
  add(name = '') {
    const data = this.read(); let number = 1; let id
    do { id = `ff-${number++}` } while (data.instances.some(item => item.id === id))
    const defaultName = `FF-${number - 1}`
    const instance = { id, name: String(name || defaultName).trim().slice(0, 40) || defaultName, createdAt: new Date().toISOString() }
    data.instances.push(instance); data.selectedId = id; this.write(data); return instance
  }
  select(id) { const data = this.read(); if (!data.instances.some(item => item.id === id)) throw new Error('Instance not found.'); data.selectedId = id; this.write(data); return data }
  rename(id, name) { const data = this.read(); const item = data.instances.find(entry => entry.id === id); if (!item) throw new Error('Instance not found.'); item.name = String(name || '').trim().slice(0, 40) || item.id; this.write(data); return item }
  remove(id) { const data = this.read(); if (data.instances.length <= 1) throw new Error('Keep at least one instance.'); const index = data.instances.findIndex(item => item.id === id); if (index < 0) throw new Error('Instance not found.'); const [removed] = data.instances.splice(index, 1); if (data.selectedId === id) data.selectedId = data.instances[0].id; this.write(data); return removed }
}

module.exports = { InstanceStore }
