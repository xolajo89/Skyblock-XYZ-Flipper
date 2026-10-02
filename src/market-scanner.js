'use strict'

const { EventEmitter } = require('node:events')

const API_URL = 'https://api.hypixel.net/v2/skyblock/bazaar'
const ITEMS_API_URL = 'https://api.hypixel.net/v2/resources/skyblock/items'
const SHARED_BAZAAR_CACHE_MS = 8000

// All local instances observe the same public Hypixel market. Coalesce their
// fetches so three scanners do not triple API load or independently fall stale
// during a brief network hiccup; each scanner still ranks the shared payload
// with its own config and disjoint filter.
let sharedBazaarRequest = null
let sharedBazaarSnapshot = null

async function fetchSharedBazaar(maxAgeMs = SHARED_BAZAAR_CACHE_MS) {
  const now = Date.now()
  if (sharedBazaarSnapshot && now - sharedBazaarSnapshot.fetchedAt <= maxAgeMs) return sharedBazaarSnapshot
  if (sharedBazaarRequest) return sharedBazaarRequest
  sharedBazaarRequest = (async () => {
    const response = await fetch(API_URL, { headers: { 'User-Agent': 'XYZ-FLIPPER/0.9' }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Hypixel Bazaar API returned HTTP ${response.status}.`)
    const payload = await response.json()
    if (!payload.success || !payload.products) throw new Error('Hypixel Bazaar API returned incomplete data.')
    sharedBazaarSnapshot = { payload, fetchedAt: Date.now() }
    return sharedBazaarSnapshot
  })()
  try { return await sharedBazaarRequest } finally { sharedBazaarRequest = null }
}

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stableUnit(value) {
  let hash = 2166136261
  for (const character of String(value || '')) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0) / 4294967296
}

function humanizeItemId(itemId) {
  const shard = String(itemId || '').match(/^SHARD_(.+)$/)
  if (shard) return `${humanizeItemId(shard[1])} Shard`
  return String(itemId || '').split('_').filter(Boolean).map(word => /^\d+$/.test(word) ? word : word[0] + word.slice(1).toLowerCase()).join(' ')
}

function buildTradableCatalog(itemPayload, bazaarPayload) {
  const resources = new Map((itemPayload.items || []).map(item => [String(item.id || ''), item]))
  return Object.keys(bazaarPayload.products || {}).map(apiProductId => {
    const itemId = apiProductId.startsWith('ENCHANTMENT_') ? apiProductId.slice('ENCHANTMENT_'.length) : apiProductId
    const item = resources.get(itemId) || resources.get(apiProductId) || {}
    return {
      id: itemId,
      apiProductId,
      // SHARD_* product IDs are intentionally stored in reverse order by the
      // Bazaar API. Always normalize them, even when resources metadata also
      // reports the reversed display text.
      name: String(apiProductId.startsWith('SHARD_') ? humanizeItemId(apiProductId) : (item.name || humanizeItemId(itemId))).replace(/\u00A7[0-9a-fk-or]/gi, '').replace(/%%[a-z_]+%%/gi, ''),
      category: String(item.category || (apiProductId.startsWith('ENCHANTMENT_') ? 'ENCHANTMENT' : '')),
      tier: String(item.tier || ''),
      material: String(item.material || ''),
      maxStackSize: Math.max(0, number(item.maxStackSize ?? item.max_stack_size)),
      npcSellPrice: number(item.npc_sell_price)
    }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

function matches(candidate, criteria = {}) {
  const criteriaQuantity = criteria.maxBuyAmount === undefined
    ? candidate.quantity
    : Math.max(1, Math.min(candidate.quantity, Math.floor(number(criteria.maxBuyAmount, candidate.quantity))))
  const criteriaProjectedProfit = candidate.profitPerUnit * criteriaQuantity
  const checks = {
    maxPrice: candidate.buyOffer <= number(criteria.maxPrice, Infinity),
    minProfit: candidate.profitPerUnit >= number(criteria.minProfit, -Infinity),
    // High-volume items often make only a few thousand coins per unit while
    // still producing a six-figure order. Keep per-unit and whole-order
    // thresholds separate so profitable liquid lots are not discarded.
    minProjectedProfit: criteriaProjectedProfit >= number(criteria.minProjectedProfit, -Infinity),
    minPercentage: candidate.profitPercentage >= number(criteria.minPercentage, -Infinity),
    minBuyOrder: candidate.buyOrders >= number(criteria.minBuyOrder, -Infinity),
    maxBuyOrder: candidate.buyOrders <= number(criteria.maxBuyOrder, Infinity),
    minSellOffer: candidate.sellOrders >= number(criteria.minSellOffer, -Infinity),
    maxSellOffer: candidate.sellOrders <= number(criteria.maxSellOffer, Infinity),
    minBuyVolume: candidate.buyVolumeHour >= number(criteria.minBuyVolume, -Infinity),
    minSellVolume: candidate.sellVolumeHour >= number(criteria.minSellVolume, -Infinity)
  }
  return Object.entries(criteria).every(([key]) => checks[key] === undefined || checks[key])
}

function globalMatch(candidate, config) {
  return candidate.profitPerUnit >= number(config.profit.min) &&
    candidate.profitPerUnit <= number(config.profit.max, Infinity) &&
    candidate.profitPercentage >= number(config.profit.minPercentage) &&
    candidate.instantBuyPrice >= number(config.price.minPricePerUnitBuy) &&
    candidate.instantBuyPrice <= number(config.price.maxPricePerUnitBuy, Infinity) &&
    candidate.instantSellPrice <= number(config.price.maxPricePerUnitSell, Infinity) &&
    candidate.buyVolumeHour >= number(config.volume.minBuy) &&
    candidate.sellVolumeHour >= number(config.volume.minSell)
}

function applyQuantity(candidate, quantity) {
  candidate.quantity = quantity
  candidate.projectedOrderValue = number(candidate.buyOffer) * quantity
  candidate.projectedProfit = candidate.profitPerUnit * quantity
  const buyFillHours = candidate.sellVolumeHour > 0 ? quantity / candidate.sellVolumeHour : Infinity
  const sellFillHours = candidate.buyVolumeHour > 0 ? quantity / candidate.buyVolumeHour : Infinity
  const cycleHours = buyFillHours + sellFillHours
  candidate.estimatedBuyFillMinutes = Number.isFinite(buyFillHours) ? buyFillHours * 60 : null
  candidate.estimatedSellFillMinutes = Number.isFinite(sellFillHours) ? sellFillHours * 60 : null
  candidate.estimatedCycleMinutes = Number.isFinite(cycleHours) ? cycleHours * 60 : null
  candidate.coinsPerHour = Number.isFinite(cycleHours) && cycleHours > 0 ? candidate.projectedProfit / cycleHours : 0
  return candidate
}

function sortMetric(candidate, sortBy = 'coinsPerHour') {
  switch (String(sortBy)) {
    case 'profitMargin': return number(candidate.profitPerUnit)
    case 'percentageProfit':
    case 'profitPercentage': return number(candidate.profitPercentage)
    case 'profit': return number(candidate.projectedProfit)
    case 'sellVolume': return number(candidate.sellVolumeHour)
    case 'buyVolume': return number(candidate.buyVolumeHour)
    case 'volume': return number(candidate.tradeVolumeHour)
    case 'supplyDemandRatio': return number(candidate.supplyDemandRatio)
    default: return number(candidate.coinsPerHour)
  }
}

function orderBookLevels(summary) {
  return summary.slice(0, 10)
    .map(level => ({
      price: number(level?.pricePerUnit),
      amount: Math.max(0, number(level?.amount)),
      orders: Math.max(0, number(level?.orders))
    }))
    .filter(level => level.price > 0)
}

function legacyMarketLookupKey(value) {
  return String(value || '').replace(/§[0-9A-FK-OR]/gi, '').trim().toLowerCase()
}

function marketLookupKey(value) {
  return String(value || '')
    .replace(/\u00A7[0-9A-FK-OR]/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function buildOrderBookLookup(products, config, itemNames = new Map()) {
  const lookup = new Map()
  for (const [itemId, product] of Object.entries(products || {})) {
    const candidate = candidateFromProduct(itemId, product, config)
    const displayName = itemNames.get(itemId) || itemId
    const book = {
      itemId,
      displayName,
      buyOffer: candidate.buyOffer,
      sellOffer: candidate.sellOffer,
      buyCompetition: candidate.buyCompetition,
      sellCompetition: candidate.sellCompetition
    }
    lookup.set(marketLookupKey(itemId), book)
    lookup.set(marketLookupKey(displayName), book)
  }
  return lookup
}

function candidateFromProduct(itemId, product, config) {
  const status = product.quick_status || {}
  const buySummary = Array.isArray(product.buy_summary) ? product.buy_summary : []
  const sellSummary = Array.isArray(product.sell_summary) ? product.sell_summary : []
  const topBuy = number(product.buy_summary?.[0]?.pricePerUnit, number(status.buyPrice))
  const topSell = number(product.sell_summary?.[0]?.pricePerUnit, number(status.sellPrice))
  // Hypixel's buy side is the price paid by instant buyers; a flipper places
  // a buy order on the lower sell side and a sell offer on the upper buy side.
  const buyOffer = topSell > 0 ? topSell + 0.1 : 0
  const sellOffer = topBuy > 0 ? Math.max(0, topBuy - 0.1) : 0
  const taxRate = number(config.taxPercent, 1.25) / 100
  const taxPerUnit = sellOffer * taxRate
  const netSell = sellOffer * (1 - taxRate)
  const profitPerUnit = netSell - buyOffer
  const profitPercentage = buyOffer > 0 ? profitPerUnit / buyOffer * 100 : 0
  const buyVolumeHour = number(status.buyMovingWeek) / 168
  const sellVolumeHour = number(status.sellMovingWeek) / 168
  const tradeVolumeHour = Math.min(buyVolumeHour, sellVolumeHour)
  const maxSpend = number(config.purse.maxSpentPerOrder, 10000000)
  const allowedOverage = Math.min(500000, Math.max(100000, maxSpend * 0.01))
  // Keep each lot close to the configured capital target. The small stable
  // per-item variation avoids making every instance submit identical values,
  // while no longer leaving up to twelve percent of MaxSpend unused.
  const targetSpend = maxSpend * (0.96 + stableUnit(itemId) * 0.04)
  const itemCap = 71680
  // Zero is intentional: when even one unit exceeds the hard budget, the
  // product is not executable and must never consume a full GUI workflow.
  const hardQuantityCap = buyOffer > 0 ? Math.max(0, Math.floor((maxSpend + allowedOverage) / buyOffer)) : 0
  // Spend near maxSpentPerOrder only when the product can actually move that
  // quantity. Twenty-five percent of the slower hourly side is roughly fifteen
  // minutes per leg: aggressive enough to deploy more of MaxSpend, but still
  // bounded so a single order cannot consume hours of normal market flow.
  const flowQuantityCap = tradeVolumeHour > 0 ? Math.max(1, Math.floor(tradeVolumeHour * 0.25)) : 0
  const quantity = buyOffer > 0 && flowQuantityCap > 0
    ? Math.min(Math.max(1, Math.round(targetSpend / buyOffer)), hardQuantityCap, itemCap, flowQuantityCap)
    : 0
  const buyDepthTop5 = sellSummary.slice(0, 5).reduce((sum, order) => sum + number(order.amount), 0)
  const sellDepthTop5 = buySummary.slice(0, 5).reduce((sum, order) => sum + number(order.amount), 0)
  const totalFlow = buyVolumeHour + sellVolumeHour
  return applyQuantity({
    itemId: itemId.startsWith('ENCHANTMENT_') ? itemId.slice('ENCHANTMENT_'.length) : itemId,
    apiItemId: itemId,
    valid: topBuy > 0 && topSell > 0 && number(status.buyOrders) > 0 && number(status.sellOrders) > 0,
    instantBuyPrice: topBuy,
    instantSellPrice: topSell,
    buyOffer,
    sellOffer,
    grossSpread: sellOffer - buyOffer,
    taxPerUnit,
    netSell,
    profitPerUnit,
    profitPercentage,
    buyVolumeHour,
    sellVolumeHour,
    tradeVolumeHour,
    targetSpend,
    projectedOrderValue: buyOffer * quantity,
    buyOrders: number(status.buyOrders),
    sellOrders: number(status.sellOrders),
    // Preserve enough of the live book to prove whether an existing order is
    // still at the front. Hypixel's Manage Orders tooltip does not reliably
    // include "orders ahead", so relisting cannot depend on that text alone.
    buyCompetition: orderBookLevels(sellSummary),
    sellCompetition: orderBookLevels(buySummary),
    buyDepthTop5,
    sellDepthTop5,
    buyPressure: totalFlow > 0 ? buyVolumeHour / totalFlow * 100 : 0,
    supplyDemandRatio: sellVolumeHour > 0 ? buyVolumeHour / sellVolumeHour : 0,
    quantity: 0,
    projectedProfit: 0,
    estimatedBuyFillMinutes: null,
    estimatedSellFillMinutes: null,
    estimatedCycleMinutes: null,
    coinsPerHour: 0,
    source: 'market'
  }, quantity)
}

function manipulationSignal(itemId, product, candidate, config, triggerOverride) {
  const trigger = number(triggerOverride, number(config.price?.manipulationTriggerPercentage, 0))
  if (trigger <= 0) return null
  const signals = []
  const spread = candidate.buyOffer > 0 ? (candidate.sellOffer - candidate.buyOffer) / candidate.buyOffer * 100 : 0
  if (spread > trigger) signals.push(`spread ${spread.toFixed(1)}%`)

  const bids = Array.isArray(product.buy_summary) ? product.buy_summary : []
  const asks = Array.isArray(product.sell_summary) ? product.sell_summary : []
  const topBid = number(bids[0]?.pricePerUnit)
  const nextBid = number(bids[1]?.pricePerUnit)
  const topAsk = number(asks[0]?.pricePerUnit)
  const nextAsk = number(asks[1]?.pricePerUnit)
  const bidGap = nextBid > 0 ? (topBid - nextBid) / nextBid * 100 : 0
  const askGap = topAsk > 0 ? (nextAsk - topAsk) / topAsk * 100 : 0
  if (bidGap > trigger) signals.push(`top buy-order gap ${bidGap.toFixed(1)}%`)
  if (askGap > trigger) signals.push(`top sell-offer gap ${askGap.toFixed(1)}%`)
  if (!signals.length) return null
  return { itemId, reason: signals.join(', '), trigger }
}

function rankProducts(products, config, filter, options = {}) {
  const blacklist = new Set(filter.blacklist || [])
  const whitelist = filter.whitelist || {}
  const whitelistOnly = filter.whitelistOnly === true
  const selective = filter.selectiveBuys || {}
  const selectiveMode = config.selectiveBuys
  const candidates = []
  const temporaryBlacklist = options.temporaryBlacklist
  const now = number(options.now, Date.now())
  const blacklistMs = Math.max(1, number(config.price?.temporaryBlacklistDuration, 30)) * 60 * 1000
  for (const [itemId, product] of Object.entries(products || {})) {
    const blocked = temporaryBlacklist?.get(itemId)
    if (blocked && blocked.until > now) continue
    if (blocked) temporaryBlacklist.delete(itemId)
    const candidate = candidateFromProduct(itemId, product, config)
    if (!candidate.valid || candidate.buyOffer <= 0 || candidate.sellOffer <= 0 || candidate.profitPerUnit <= 0 || candidate.quantity <= 0) continue
    const normalizedId = candidate.itemId
    const selectiveCriteria = selective[normalizedId] || selective[itemId]
    let criteria = null
    let source = ''
    if (selectiveMode !== false && selectiveCriteria && matches(candidate, selectiveCriteria)) {
      criteria = selectiveCriteria
      source = 'selective'
    }
    if (!source) {
      if (selectiveMode === true) continue
      const hasWhitelistEntry = Object.prototype.hasOwnProperty.call(whitelist, normalizedId)
        || Object.prototype.hasOwnProperty.call(whitelist, itemId)
      if (whitelistOnly && !hasWhitelistEntry) continue
      const whitelistCriteria = whitelist[normalizedId] || whitelist[itemId]
      const hasWhitelistRules = whitelistCriteria && Object.keys(whitelistCriteria).length > 0
      const whitelisted = hasWhitelistRules && matches(candidate, whitelistCriteria)
      // An empty whitelist object means "use the global config". In
      // particular, it must not bypass volume.minBuy or volume.minSell.
      const blacklisted = blacklist.has(normalizedId) || blacklist.has(itemId)
      if ((blacklisted && !whitelisted) || (hasWhitelistRules ? !whitelisted : !globalMatch(candidate, config))) continue
      criteria = hasWhitelistRules ? whitelistCriteria : null
      source = whitelistCriteria ? 'whitelist' : 'market'
    }
    // Only run manipulation protection for products which otherwise pass the
    // user's profit, price, filter and volume rules. This prevents thousands
    // of irrelevant warnings for products FF would never trade.
    const manipulation = manipulationSignal(itemId, product, candidate, config, criteria?.manipulationTriggerPercentage)
    if (manipulation) {
      const detection = { ...manipulation, until: now + blacklistMs }
      temporaryBlacklist?.set(itemId, detection)
      options.onManipulation?.(detection)
      continue
    }
    if (criteria?.maxBuyAmount !== undefined) {
      const cap = Math.max(1, Math.floor(number(criteria.maxBuyAmount, candidate.quantity)))
      applyQuantity(candidate, Math.max(1, Math.min(candidate.quantity, cap)))
    }
    candidate.source = source
    if (criteria?.relistAfter !== undefined) candidate.relistAfter = number(criteria.relistAfter)
    if (criteria?.relistWorthThreshold !== undefined) candidate.relistWorthThreshold = number(criteria.relistWorthThreshold)
    if (criteria?.manipulationTriggerPercentage !== undefined) candidate.manipulationTriggerPercentage = number(criteria.manipulationTriggerPercentage)
    candidates.push(candidate)
  }
  candidates.sort((a, b) => {
    if (a.source === 'selective' && b.source !== 'selective' && config.selectiveBuys === 'both') return -1
    if (b.source === 'selective' && a.source !== 'selective' && config.selectiveBuys === 'both') return 1
    return sortMetric(b, config.orders.sortBy) - sortMetric(a, config.orders.sortBy)
  })
  return candidates.slice(0, number(config.scanner?.maxCandidates, 100))
}

class MarketScanner extends EventEmitter {
  constructor(readSettings, log) {
    super()
    this.readSettings = readSettings
    this.log = log
    this.timer = null
    this.running = false
    this.scanInFlight = null
    this.last = { updatedAt: null, candidates: [], productCount: 0, itemCount: 0, items: [] }
    this.itemsLoadedAt = 0
    this.temporaryBlacklist = new Map()
    this.lastScanErrorMessage = ''
    this.lastScanErrorLogAt = 0
  }

  async loadItems(force = false) {
    if (!force && this.last.items.length && Date.now() - this.itemsLoadedAt < 6 * 60 * 60 * 1000) {
      return { items: this.last.items, itemCount: this.last.itemCount, itemsUpdatedAt: this.last.itemsUpdatedAt }
    }
    const [response, bazaarSnapshot] = await Promise.all([
      fetch(ITEMS_API_URL, { headers: { 'User-Agent': 'XYZ-FLIPPER/0.9' }, signal: AbortSignal.timeout(20000) }),
      fetchSharedBazaar()
    ])
    if (!response.ok) throw new Error(`Hypixel Items API returned HTTP ${response.status}.`)
    const payload = await response.json()
    const bazaarPayload = bazaarSnapshot.payload
    if (!payload.success || !Array.isArray(payload.items)) throw new Error('Hypixel Items API returned incomplete data.')
    this.last.items = buildTradableCatalog(payload, bazaarPayload)
    this.last.itemCount = this.last.items.length
    this.last.itemsUpdatedAt = payload.lastUpdated ? new Date(payload.lastUpdated).toISOString() : new Date().toISOString()
    this.itemsLoadedAt = Date.now()
    this.log('success', `Loaded ${this.last.itemCount} Bazaar-tradable SkyBlock items from the official Hypixel APIs.`)
    this.emit('update', this.last)
    return { items: this.last.items, itemCount: this.last.itemCount, itemsUpdatedAt: this.last.itemsUpdatedAt }
  }

  async scan() {
    if (this.scanInFlight) return this.scanInFlight
    const request = this.scanOnce()
    this.scanInFlight = request
    try { return await request } finally {
      if (this.scanInFlight === request) this.scanInFlight = null
    }
  }

  async scanOnce() {
    const { config, filter } = this.readSettings()
    await this.loadItems()
    const { payload, fetchedAt } = await fetchSharedBazaar()
    this.emit('raw', { payload, fetchedAt })
    const itemNames = new Map(this.last.items.flatMap(item => [[item.id, item.name], [item.apiProductId, item.name]]))
    const itemMetadata = new Map(this.last.items.flatMap(item => [[item.id, item], [item.apiProductId, item]]))
    const manipulationDetections = []
    this.last = {
      ...this.last,
      updatedAt: new Date().toISOString(),
      apiUpdatedAt: payload.lastUpdated ? new Date(payload.lastUpdated).toISOString() : null,
      candidates: rankProducts(payload.products, config, filter, {
        temporaryBlacklist: this.temporaryBlacklist,
        onManipulation: detection => manipulationDetections.push(detection)
      }).map(candidate => {
        const metadata = itemMetadata.get(candidate.apiItemId) || itemMetadata.get(candidate.itemId) || {}
        return {
          ...candidate,
          displayName: itemNames.get(candidate.apiItemId) || itemNames.get(candidate.itemId) || candidate.itemId,
          category: metadata.category || '',
          material: metadata.material || '',
          maxStackSize: number(metadata.maxStackSize)
        }
      }),
      productCount: Object.keys(payload.products).length
    }
    if (manipulationDetections.length) {
      const minutes = Math.max(1, number(config.price?.temporaryBlacklistDuration, 30))
      const examples = manipulationDetections.slice(0, 6).map(detection => itemNames.get(detection.itemId) || detection.itemId)
      const remaining = manipulationDetections.length - examples.length
      const triggers = [...new Set(manipulationDetections.map(detection => `${detection.reason} > ${detection.trigger}%`))].slice(0, 3)
      this.log('warning', `[Manipulator Detector] Blocked ${manipulationDetections.length} product${manipulationDetections.length === 1 ? '' : 's'} for ${minutes} minutes: ${examples.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}. ${triggers.join('; ')}.`)
    }
    // Keep complete order-book depth available to Auto Trader without sending
    // thousands of products through Electron IPC to the dashboard every scan.
    // Active orders may stop qualifying as scanner candidates after placement;
    // they still need live depth so relisting never silently falls back to age.
    Object.defineProperty(this.last, 'orderBooks', {
      value: buildOrderBookLookup(payload.products, config, itemNames),
      enumerable: false,
      configurable: true
    })
    this.emit('update', this.last)
    return this.last
  }

  async tick() {
    try {
      await this.scan()
      this.lastScanErrorMessage = ''
    } catch (error) {
      const message = String(error?.message || error)
      const now = Date.now()
      if (message !== this.lastScanErrorMessage || now - this.lastScanErrorLogAt >= 5 * 60 * 1000) {
        this.log('error', `Scanner: ${message}`)
        this.lastScanErrorMessage = message
        this.lastScanErrorLogAt = now
      }
    }
    if (!this.running) return
    const { config } = this.readSettings()
    const delay = Math.max(10, number(config.scanner?.refreshSeconds, 15)) * 1000
    this.timer = setTimeout(() => this.tick(), delay)
  }

  start() {
    if (this.running) return
    this.running = true
    this.log('info', 'Market scanner started.')
    this.tick()
  }

  stop() {
    this.running = false
    clearTimeout(this.timer)
    this.timer = null
    this.log('info', 'Market scanner stopped.')
  }
}

module.exports = { MarketScanner, rankProducts, candidateFromProduct, manipulationSignal, matches, buildTradableCatalog, sortMetric }
