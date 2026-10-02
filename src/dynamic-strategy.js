'use strict'

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function percentile(values, ratio, fallback) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return fallback
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]
}

class DynamicStrategy {
  constructor(collector, store, log = () => {}) {
    this.collector = collector
    this.store = store
    this.log = log
    this.last = null
  }

  generate(options = {}) {
    const purse = clamp(Math.floor(number(options.purse, 150000000)), 1000000, 600000000)
    const lookbackHours = clamp(number(options.lookbackHours, 24), 1, 168)
    const current = structuredClone(this.store.read('config').parsed)
    // Prefer five small, high-turnover orders over seven large allocations.
    // This keeps cash moving and limits the amount stuck in a slow queue.
    const targetBuyOrders = 5
    const targetOrderBudget = Math.max(100000, Math.floor(purse / targetBuyOrders))
    const requestedMaxSpend = number(options.maxSpendPerOrder, current.purse.maxSpentPerOrder)
    // Never let one generated order consume the cash reserved for the other
    // target orders. A caller may lower the budget, but cannot accidentally
    // turn a five-order strategy into one oversized, slow-filling order.
    const maxSpend = clamp(Math.floor(Math.min(requestedMaxSpend, targetOrderBudget)), 100000, purse)
    const cutoff = Date.now() - lookbackHours * 3600000
    const rows = this.collector.db.prepare(`
      SELECT item_id,
        avg(last_buy) avg_buy, avg(last_sell) avg_sell,
        min(min_buy) min_buy, max(max_buy) max_buy,
        min(min_sell) min_sell, max(max_sell) max_sell,
        avg(buy_volume_hour) buy_volume_hour,
        avg(sell_volume_hour) sell_volume_hour,
        avg(buy_orders) buy_orders, avg(sell_orders) sell_orders,
        avg(buy_depth5) buy_depth5, avg(sell_depth5) sell_depth5,
        avg(profit_unit) profit_unit, avg(roi) roi,
        sum(samples) samples
      FROM market_buckets_v2
      WHERE bucket >= ?
      GROUP BY item_id
    `).all(cutoff)
    if (!rows.length) throw new Error('Collect at least one Bazaar API sample before generating a dynamic strategy.')

    const evaluated = rows.map(row => {
      const buy = number(row.avg_buy)
      const sell = number(row.avg_sell)
      const profitUnit = number(row.profit_unit)
      const roi = number(row.roi)
      const buyVolumeHour = number(row.buy_volume_hour)
      const sellVolumeHour = number(row.sell_volume_hour)
      // Cap each leg to roughly six minutes of the slower hourly flow.
      // Small orders should fill promptly even when a product stays stable.
      const flow = Math.min(buyVolumeHour, sellVolumeHour)
      const fastFillQuantity = Math.floor(flow * 0.1)
      const quantity = buy > 0 ? Math.min(Math.floor(maxSpend / buy), Math.max(1, fastFillQuantity), 128) : 0
      const buyHours = quantity > 0 && sellVolumeHour > 0 ? quantity / sellVolumeHour : Infinity
      const sellHours = quantity > 0 && buyVolumeHour > 0 ? quantity / buyVolumeHour : Infinity
      const cycleHours = buyHours + sellHours
      const projectedProfit = profitUnit * quantity
      const coinsPerHour = Number.isFinite(cycleHours) && cycleHours > 0 ? projectedProfit / cycleHours : 0
      const turnover = quantity * (buy + sell)
      const limitEfficiency = turnover > 0 ? projectedProfit / turnover * 100 : 0
      const buyVolatility = buy > 0 ? (number(row.max_buy) - number(row.min_buy)) / buy * 100 : Infinity
      const sellVolatility = sell > 0 ? (number(row.max_sell) - number(row.min_sell)) / sell * 100 : Infinity
      const volatility = Math.max(0, (buyVolatility + sellVolatility) / 2)
      const stability = clamp(1 - volatility / 20, 0.05, 1)
      const score = coinsPerHour * stability * (1 + clamp(limitEfficiency, 0, 25) / 25)
      const accepted = quantity >= 1 && profitUnit >= 3000 && roi >= 5 &&
        buyVolumeHour >= 500 && sellVolumeHour >= 500 && volatility <= 12 && cycleHours <= 0.2 &&
        number(row.buy_orders) > 0 && number(row.sell_orders) > 0
      return {
        itemId: row.item_id,
        buy, sell, profitUnit, roi, quantity, projectedProfit, coinsPerHour,
        limitEfficiency, volatility, flow, score, accepted,
        samples: number(row.samples),
        buyDepth5: number(row.buy_depth5), sellDepth5: number(row.sell_depth5)
      }
    })

    const accepted = evaluated.filter(item => item.accepted).sort((a, b) => b.score - a.score || b.flow - a.flow)
    const fallback = evaluated.filter(item => item.quantity >= 1 && item.profitUnit > 0 && item.roi >= 1 && item.flow >= 50 && item.volatility <= 30)
      .sort((a, b) => b.score - a.score || b.flow - a.flow)
    const usingFallback = accepted.length === 0
    const selected = (usingFallback ? fallback : accepted).slice(0, 30)
    if (!selected.length) throw new Error('No items currently satisfy the minimum profit, volume, and stability requirements.')
    const selectedIds = new Set(selected.map(item => item.itemId))
    // When strict selection is empty, fallback is the active universe. Those
    // selected IDs must not also be emitted into blacklist, which has priority
    // over an empty whitelist rule in the scanner.
    const blacklist = evaluated.filter(item => !item.accepted && !selectedIds.has(item.itemId)).map(item => item.itemId).sort()
    const profitFloor = usingFallback ? 1 : 3000
    const roiFloor = usingFallback ? 1 : 5
    const volumeFloor = usingFallback ? 50 : 500
    const profitThreshold = clamp(percentile(selected.map(item => item.profitUnit), 0.2, profitFloor), profitFloor, 250000)
    const roiThreshold = clamp(percentile(selected.map(item => item.roi), 0.15, roiFloor), roiFloor, 20)
    const volumeThreshold = clamp(percentile(selected.map(item => item.flow), 0.15, volumeFloor), volumeFloor, 100000)
    // A fallback threshold must not round above the observations which caused
    // fallback selection, otherwise the generated config immediately filters
    // every selected item back out. Strict mode keeps its existing rounding.
    current.profit.min = usingFallback ? Math.floor(profitThreshold) : Math.round(profitThreshold)
    current.profit.max = 7000000
    current.profit.minPercentage = (usingFallback ? Math.floor(roiThreshold * 100) : Math.round(roiThreshold * 100)) / 100
    current.price.minPricePerUnitBuy = usingFallback ? 1 : 20000
    current.price.maxPricePerUnitBuy = maxSpend
    current.price.maxPricePerUnitSell = 2000000000000
    // Seven is the slot ceiling, not a purse estimate. Runtime affordability
    // checks decide when to stop placing orders as the free purse decreases.
    current.orders.maxBuyOrders = 7
    delete current.orders.MaxItemAmount
    current.orders.maxAmountOfSellOffers = Math.round(
      clamp(number(current.orders.maxAmountOfSellOffers, 7), 1, 100),
    )
    current.orders.sortBy = 'coinsPerHour'
    current.orders.relistAfterType = 'orderAmount'
    current.orders.relistAfter = 1
    current.orders.relistWorthThreshold = 1000000
    current.volume.minBuy = usingFallback ? Math.floor(volumeThreshold) : Math.round(volumeThreshold)
    current.volume.minSell = current.volume.minBuy
    current.purse.minPurse = 0
    current.purse.maxSpentPerOrder = maxSpend
    current.selectiveBuys = 'both'

    const filter = {
      blacklist,
      whitelist: Object.fromEntries(selected.map(item => [item.itemId, {}])),
      selectiveBuys: {}
    }
    this.last = {
      generatedAt: new Date().toISOString(), purse, lookbackHours, config: current, filter,
      summary: {
        observedItems: evaluated.length,
        acceptedItems: accepted.length,
        usingFallback,
        selectedItems: selected.length,
        blacklistedItems: blacklist.length,
        maxSpendPerOrder: maxSpend,
        projectedCoinsPerHour: selected.slice(0, current.orders.maxBuyOrders).reduce((sum, item) => sum + item.coinsPerHour, 0)
      },
      topItems: selected.slice(0, 20)
    }
    return this.last
  }

  apply() {
    if (!this.last) throw new Error('Generate a dynamic strategy before applying it.')
    const config = this.store.save('config', `${JSON.stringify(this.last.config, null, 2)}\n`)
    const filter = this.store.save('filter', `${JSON.stringify(this.last.filter, null, 2)}\n`)
    this.log('success', `Dynamic config/filter applied for ${this.last.purse.toLocaleString('en-US')} purse.`)
    return { config, filter, strategy: this.last }
  }
}

module.exports = { DynamicStrategy }
