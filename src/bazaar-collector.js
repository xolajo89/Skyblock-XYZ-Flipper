'use strict'

const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const { runtimeConfig } = require('./runtime-config')

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function csv(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

class BazaarCollector extends EventEmitter {
  constructor(dataDir, readConfig, log = () => {}) {
    super()
    this.dataDir = dataDir
    this.readConfig = readConfig
    this.log = log
    this.databasePath = path.join(dataDir, 'bazaar-history.sqlite')
    this.reportsDir = path.join(dataDir, 'reports')
    fs.mkdirSync(this.reportsDir, { recursive: true })
    this.db = new DatabaseSync(this.databasePath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_buckets_v2 (
        bucket INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        first_buy REAL NOT NULL, last_buy REAL NOT NULL, min_buy REAL NOT NULL, max_buy REAL NOT NULL,
        first_sell REAL NOT NULL, last_sell REAL NOT NULL, min_sell REAL NOT NULL, max_sell REAL NOT NULL,
        buy_volume_hour REAL NOT NULL, sell_volume_hour REAL NOT NULL,
        buy_orders INTEGER NOT NULL, sell_orders INTEGER NOT NULL,
        buy_depth5 REAL NOT NULL, sell_depth5 REAL NOT NULL,
        profit_unit REAL NOT NULL, roi REAL NOT NULL,
        samples INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (bucket, item_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS market_buckets_v2_item_bucket ON market_buckets_v2(item_id, bucket);
      CREATE TABLE IF NOT EXISTS collector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    this.upsert = this.db.prepare(`
      INSERT INTO market_buckets_v2 (
        bucket, item_id, first_buy, last_buy, min_buy, max_buy,
        first_sell, last_sell, min_sell, max_sell,
        buy_volume_hour, sell_volume_hour, buy_orders, sell_orders,
        buy_depth5, sell_depth5, profit_unit, roi, samples
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(bucket, item_id) DO UPDATE SET
        last_buy=excluded.last_buy, min_buy=min(min_buy, excluded.last_buy), max_buy=max(max_buy, excluded.last_buy),
        last_sell=excluded.last_sell, min_sell=min(min_sell, excluded.last_sell), max_sell=max(max_sell, excluded.last_sell),
        buy_volume_hour=excluded.buy_volume_hour, sell_volume_hour=excluded.sell_volume_hour,
        buy_orders=excluded.buy_orders, sell_orders=excluded.sell_orders,
        buy_depth5=excluded.buy_depth5, sell_depth5=excluded.sell_depth5,
        profit_unit=excluded.profit_unit, roi=excluded.roi, samples=samples+1
    `)
    this.lastRecordedAt = 0
    this.lastCleanupAt = 0
    this.state = { enabled: false, lastSampleAt: null, productCount: 0, bucketCount: 0, rowCount: 0, databaseBytes: 0 }
    this.refreshStatus()
  }

  config() {
    return runtimeConfig(this.readConfig()).collector
  }

  record(payload, fetchedAt = Date.now(), force = false) {
    const config = this.config()
    this.state.enabled = config.enabled === true
    if (!this.state.enabled || !payload?.products) return this.snapshot()
    const sampleMs = Math.max(15, number(config.sampleSeconds, 60)) * 1000
    if (!force && fetchedAt - this.lastRecordedAt < sampleMs) return this.snapshot()
    const bucketMs = Math.max(1, number(config.bucketMinutes, 15)) * 60 * 1000
    const bucket = Math.floor(fetchedAt / bucketMs) * bucketMs
    const taxRate = number(runtimeConfig(this.readConfig()).taxPercent, 1.25) / 100
    let productCount = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [itemId, product] of Object.entries(payload.products)) {
        const status = product.quick_status || {}
        const buySummary = Array.isArray(product.buy_summary) ? product.buy_summary : []
        const sellSummary = Array.isArray(product.sell_summary) ? product.sell_summary : []
        const buy = number(buySummary[0]?.pricePerUnit, number(status.buyPrice))
        const sell = number(sellSummary[0]?.pricePerUnit, number(status.sellPrice))
        if (buy <= 0 || sell <= 0) continue
        const buyOffer = sell + 0.1
        const sellOffer = Math.max(0, buy - 0.1)
        const profit = sellOffer * (1 - taxRate) - buyOffer
        const roi = buyOffer > 0 ? profit / buyOffer * 100 : 0
        const buyDepth = sellSummary.slice(0, 5).reduce((sum, row) => sum + number(row.amount), 0)
        const sellDepth = buySummary.slice(0, 5).reduce((sum, row) => sum + number(row.amount), 0)
        this.upsert.run(
          bucket, itemId, buyOffer, buyOffer, buyOffer, buyOffer,
          sellOffer, sellOffer, sellOffer, sellOffer,
          number(status.buyMovingWeek) / 168, number(status.sellMovingWeek) / 168,
          number(status.buyOrders), number(status.sellOrders), buyDepth, sellDepth, profit, roi
        )
        productCount += 1
      }
      this.db.prepare('INSERT OR REPLACE INTO collector_meta(key, value) VALUES (?, ?)').run('last_sample_at', new Date(fetchedAt).toISOString())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.lastRecordedAt = fetchedAt
    this.state.lastSampleAt = new Date(fetchedAt).toISOString()
    this.state.productCount = productCount
    if (fetchedAt - this.lastCleanupAt > 60 * 60 * 1000) this.cleanup(fetchedAt)
    this.refreshStatus()
    this.emit('state', this.snapshot())
    return this.snapshot()
  }

  cleanup(now = Date.now()) {
    const days = Math.max(1, number(this.config().retentionDays, 7))
    this.db.prepare('DELETE FROM market_buckets_v2 WHERE bucket < ?').run(now - days * 86400000)
    this.lastCleanupAt = now
  }

  refreshStatus() {
    const counts = this.db.prepare('SELECT count(*) row_count, count(DISTINCT bucket) bucket_count FROM market_buckets_v2').get()
    const last = this.db.prepare("SELECT value FROM collector_meta WHERE key='last_sample_at'").get()
    const databaseBytes = [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]
      .reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0)
    this.state = {
      ...this.state,
      enabled: this.config().enabled === true,
      lastSampleAt: last?.value || this.state.lastSampleAt,
      rowCount: number(counts?.row_count),
      bucketCount: number(counts?.bucket_count),
      databaseBytes
    }
    return this.snapshot()
  }

  snapshot() {
    return { ...this.state, databasePath: this.databasePath, reportsDir: this.reportsDir }
  }

  exportCsv(hours = 24) {
    const safeHours = Math.min(168, Math.max(1, number(hours, 24)))
    const rows = this.db.prepare('SELECT * FROM market_buckets_v2 WHERE bucket >= ? ORDER BY bucket, item_id').all(Date.now() - safeHours * 3600000)
    const fields = ['bucket', 'item_id', 'first_buy', 'last_buy', 'min_buy', 'max_buy', 'first_sell', 'last_sell', 'min_sell', 'max_sell', 'buy_volume_hour', 'sell_volume_hour', 'buy_orders', 'sell_orders', 'buy_depth5', 'sell_depth5', 'profit_unit', 'roi', 'samples']
    const lines = [fields.join(',')]
    for (const row of rows) lines.push(fields.map(field => csv(field === 'bucket' ? new Date(Number(row[field])).toISOString() : row[field])).join(','))
    const file = path.join(this.reportsDir, `bazaar-${safeHours}h-${new Date().toISOString().replaceAll(':', '-')}.csv`)
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    this.log('success', `Bazaar CSV exported: ${path.basename(file)}`)
    return file
  }

  exportTxt() {
    const latest = this.db.prepare('SELECT max(bucket) bucket FROM market_buckets_v2').get()?.bucket
    if (!latest) throw new Error('No collected Bazaar data is available yet.')
    const config = this.readConfig()
    const maxSpend = number(config.purse?.maxSpentPerOrder, 10000000)
    const rows = this.db.prepare('SELECT * FROM market_buckets_v2 WHERE bucket=? AND profit_unit>0').all(latest)
    const ranked = rows.map(row => {
      const quantity = Math.max(1, Math.floor(maxSpend / row.last_buy))
      const buyHours = row.sell_volume_hour > 0 ? quantity / row.sell_volume_hour : Infinity
      const sellHours = row.buy_volume_hour > 0 ? quantity / row.buy_volume_hour : Infinity
      const cycle = buyHours + sellHours
      return { ...row, quantity, coinsHour: Number.isFinite(cycle) && cycle > 0 ? row.profit_unit * quantity / cycle : 0 }
    }).sort((a, b) => b.coinsHour - a.coinsHour).slice(0, 100)
    const lines = [
      'XYZ FLIPPER BAZAAR DATA REPORT', `Bucket: ${new Date(Number(latest)).toISOString()}`, `Products: ${rows.length}`, '',
      'TOP ITEMS BY ESTIMATED COINS/HOUR',
      'Rank | Item | Buy | Sell | Profit/unit | ROI | Quantity | Coins/hour'
    ]
    ranked.forEach((row, index) => lines.push(`${index + 1} | ${row.item_id} | ${row.last_buy.toFixed(1)} | ${row.last_sell.toFixed(1)} | ${row.profit_unit.toFixed(1)} | ${row.roi.toFixed(2)}% | ${row.quantity} | ${row.coinsHour.toFixed(0)}`))
    const file = path.join(this.reportsDir, `bazaar-report-${new Date().toISOString().replaceAll(':', '-')}.txt`)
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    this.log('success', `Bazaar TXT report exported: ${path.basename(file)}`)
    return file
  }

  close() {
    this.db.close()
  }
}

module.exports = { BazaarCollector }
