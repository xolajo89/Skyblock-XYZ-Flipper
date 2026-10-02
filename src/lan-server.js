'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { buildAllLogsReport } = require('./all-logs')

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

function localAddresses() {
  const addresses = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) addresses.push(entry.address)
    }
  }
  return [...new Set(addresses)]
}

class LanServer {
  constructor({ root, dataDir, invoke, log, usernameProvider = () => 'xyz', passwordProvider = () => '', scannerReportProvider = null, port = 9090, version = '' }) {
    this.root = root
    this.dataDir = dataDir
    this.version = version
    this.invoke = invoke
    this.log = log
    this.usernameProvider = usernameProvider
    this.passwordProvider = passwordProvider
    this.scannerReportProvider = scannerReportProvider
    this.preferredPort = port
    this.clients = new Set()
    this.server = null
    this.port = 0
    this.sessionToken = crypto.randomBytes(24).toString('base64url')
  }

  info() {
    const hosts = localAddresses()
    return {
      running: Boolean(this.server?.listening),
      port: this.port,
      desktopUrl: `http://127.0.0.1:${this.port}/`,
      urls: hosts.map(host => `http://${host}:${this.port}/`)
    }
  }

  authorized(_requestUrl, request) {
    const address = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '')
    const privateNetwork = address === '::1' || address === '127.0.0.1' || address.startsWith('10.') ||
      address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
      address.toLowerCase().startsWith('fe80:')
    if (!privateNetwork) return false
    const password = String(this.passwordProvider() || '').trim()
    if (!password) return true
    return String(request.headers.cookie || '').split(';').some(value => value.trim() === `xyz_auth=${this.sessionToken}`)
  }

  deny(response) {
    response.writeHead(302, { Location: '/renderer/login2.html', 'Cache-Control': 'no-store' }); response.end()
  }

  async start() {
    for (const port of [...new Set([this.preferredPort, 9090, 1010])]) {
      try {
        await this.listen(port)
        this.port = port
        const host = localAddresses()[0]
        this.log('success', `Web dashboard ready at http://127.0.0.1:${port}/${host ? ` and http://${host}:${port}/ for phones on this network` : ''}.`)
        return this.info()
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error('Ports 9090 and 1010 are already in use.')
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this.route(request, response))
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', reject)
        this.server = server
        resolve()
      })
    })
  }

  async route(request, response) {
    const requestUrl = new URL(request.url, 'http://localhost')
    try {
      if (requestUrl.pathname === '/api/login' && request.method === 'POST') {
        const body = await this.readBody(request)
        const valid = String(body.username || '') === String(this.usernameProvider() || 'xyz') && String(body.password || '') === String(this.passwordProvider() || '')
        if (!valid) return this.json(response, 401, { error: 'Invalid username or password.' })
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `xyz_auth=${this.sessionToken}; Path=/; SameSite=Strict`, 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ ok: true })); return
      }
      if (['/renderer/login2.html', '/renderer/login2.css', '/renderer/login2.js', '/renderer/background.mp4', '/assets/xyz-icon.png'].includes(requestUrl.pathname)) return this.staticFile(requestUrl.pathname, response)
      if (!this.authorized(requestUrl, request)) return this.deny(response)
      if (requestUrl.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        response.write(`data: ${JSON.stringify({ channel: 'ready', payload: true })}\n\n`)
        this.clients.add(response)
        request.on('close', () => this.clients.delete(response))
        return
      }
      if (requestUrl.pathname === '/api/rpc' && request.method === 'POST') {
        const body = await this.readBody(request)
        const result = await this.invoke(String(body.method || ''), Array.isArray(body.args) ? body.args : [])
        return this.json(response, 200, { result })
      }
      if (requestUrl.pathname === '/api/download-log' && request.method === 'GET') {
        return this.downloadLog(response)
      }
      if (requestUrl.pathname === '/api/download-scanner-log' && request.method === 'GET') {
        return this.downloadScannerLog(response)
      }
      if (requestUrl.pathname.startsWith('/api/')) return this.json(response, 404, { error: 'Not found.' })
      this.staticFile(requestUrl.pathname, response)
    } catch (error) {
      this.json(response, 500, { error: error.message || String(error) })
    }
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      let text = ''
      request.setEncoding('utf8')
      request.on('data', chunk => {
        text += chunk
        if (text.length > 2_000_000) request.destroy(new Error('Request is too large.'))
      })
      request.on('end', () => {
        try { resolve(JSON.parse(text || '{}')) } catch { reject(new Error('Invalid JSON request.')) }
      })
      request.on('error', reject)
    })
  }

  staticFile(urlPath, response) {
    let relative = decodeURIComponent(urlPath === '/' ? '/renderer/index.html' : urlPath)
    if (relative.startsWith('/assets/')) relative = relative
    else if (!relative.startsWith('/renderer/')) relative = `/renderer${relative}`
    const file = path.resolve(this.root, `.${relative}`)
    if (!file.startsWith(path.resolve(this.root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return this.json(response, 404, { error: 'Not found.' })
    }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(response)
  }

  downloadLog(response) {
    const content = buildAllLogsReport(this.dataDir, this.version)
    const body = Buffer.from(content, 'utf8')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="FF-all-logs-${stamp}.log"`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(body)
  }

  downloadScannerLog(response) {
    if (typeof this.scannerReportProvider !== 'function') return this.json(response, 404, { error: 'Scanner export is unavailable.' })
    const report = this.scannerReportProvider()
    const body = Buffer.from(String(report?.content || ''), 'utf8')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const instanceName = String(report?.instanceName || 'scanner').replace(/[^a-z0-9_-]+/gi, '-')
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="XYZ-market-scanner-${instanceName}-${stamp}.json"`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(body)
  }

  json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }

  broadcast(channel, payload) {
    // Avoid serializing large tracker histories when no browser/SSE client is
    // connected. The desktop renderer receives its own Electron IPC event.
    if (!this.clients.size) return false
    const line = `data: ${JSON.stringify({ channel, payload })}\n\n`
    for (const client of this.clients) {
      try { client.write(line) } catch { this.clients.delete(client) }
    }
    return true
  }

  close() {
    for (const client of this.clients) client.end()
    this.clients.clear()
    this.server?.close()
    this.server = null
  }
}

module.exports = { LanServer, localAddresses }
