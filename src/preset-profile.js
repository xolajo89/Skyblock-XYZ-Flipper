'use strict'

const ULTRA_PROFIT_CONFIG_KEYS = Object.freeze([
  'profit',
  'price',
  'orders',
  'volume',
  'purse',
  'selectiveBuys'
])

const clone = value => JSON.parse(JSON.stringify(value))

function mergeUltraProfitConfig(current, preset) {
  const next = clone(current || {})
  for (const key of ULTRA_PROFIT_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(preset || {}, key)) next[key] = clone(preset[key])
  }
  return next
}

module.exports = { ULTRA_PROFIT_CONFIG_KEYS, mergeUltraProfitConfig }
