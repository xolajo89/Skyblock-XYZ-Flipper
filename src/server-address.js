'use strict'

function parseServerAddress(input) {
  let address = String(input || '').trim()
  address = address.replace(/^minecraft:\/\//i, '').replace(/\/$/, '')
  if (!address || address.length > 253 || /[\s/:\\]/.test(address) || !/^[a-z0-9.-]+$/i.test(address)) {
    throw new Error('Enter only the server IP or hostname, without a port.')
  }
  return { host: address, version: '26.2' }
}

module.exports = { parseServerAddress }
