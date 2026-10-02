'use strict'

const fs = require('node:fs')
const path = require('node:path')

const INSTANCE_IDS = Object.freeze(['ff-1', 'ff-2', 'ff-3'])
const V6_INSTANCE_IDS = Object.freeze(['ff-1', 'ff-2', 'ff-3', 'ff-4', 'ff-5'])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function loadUltraProfitV2Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V2 has no portfolio allocation for ${instanceId}.`)
  const config = readJson(path.join(presetDir, `ultra-profit-v2-config-${id}.json`))
  const localFilter = readJson(path.join(presetDir, `ultra-profit-v2-filter-${id}.json`))
  const historical = readJson(path.join(presetDir, 'high-volume-adapted-filter.json'))
  const selected = new Set(Object.keys(localFilter.selectiveBuys || {}))
  const blacklist = [...new Set([
    ...(historical.blacklist || []),
    ...(localFilter.blacklist || [])
  ])].filter(itemId => !selected.has(itemId)).sort()
  return {
    id,
    config,
    filter: {
      blacklist,
      whitelist: structuredClone(localFilter.whitelist || {}),
      selectiveBuys: structuredClone(localFilter.selectiveBuys || {})
    }
  }
}

function loadUltraProfitV2Fleet(presetDir) {
  return INSTANCE_IDS.map(id => loadUltraProfitV2Instance(presetDir, id))
}

function loadUltraProfitV3Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V3 has no portfolio allocation for ${instanceId}.`)
  // V3 keeps V2's proven, disjoint item pools. Its aggression is capital and
  // throughput based: a sixth buy slot and a larger per-order allocation, not
  // low-margin or manipulated items that only look profitable in a snapshot.
  const base = loadUltraProfitV2Instance(presetDir, id)
  const config = readJson(path.join(presetDir, `ultra-profit-v3-config-${id}.json`))
  const selectiveBuys = Object.fromEntries(Object.entries(base.filter.selectiveBuys).map(([itemId, rule]) => [itemId, {
    ...rule,
    maxBuyAmount: Math.max(1, Math.ceil(Number(rule.maxBuyAmount || 1) * 1.45))
  }]))
  return { id, config, filter: { ...base.filter, selectiveBuys } }
}

function loadUltraProfitV3Fleet(presetDir) {
  return INSTANCE_IDS.map(id => loadUltraProfitV3Instance(presetDir, id))
}

function loadUltraProfitV4Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V4 has no portfolio allocation for ${instanceId}.`)
  const base = loadUltraProfitV2Instance(presetDir, id)
  const config = readJson(path.join(presetDir, `ultra-profit-v4-config-${id}.json`))
  // Fast-turnover profile: wider but still bounded entry band for the same
  // disjoint, historically vetted items. Live scanner exports showed that the
  // former 2x lots parked whole instances in the Buy queue, so V4 keeps the
  // proven base lot size and lets all six slots cycle more quickly.
  const selectiveBuys = Object.fromEntries(Object.entries(base.filter.selectiveBuys).map(([itemId, rule]) => [itemId, {
    ...rule,
    maxPrice: Math.ceil(Number(rule.maxPrice || 0) * 1.035),
    minProfit: Math.max(3000, Math.floor(Number(rule.minProfit || 0) * 0.8)),
    minPercentage: Math.max(6, Number(rule.minPercentage || 0) - 1),
    minBuyVolume: Math.max(50, Math.floor(Number(rule.minBuyVolume || 0) * 0.8)),
    minSellVolume: Math.max(50, Math.floor(Number(rule.minSellVolume || 0) * 0.8)),
    maxBuyAmount: Math.max(1, Math.ceil(Number(rule.maxBuyAmount || 1))),
    // Repricing after three competitors consumed more time than it recovered
    // in live V4 runs. Five confirmed orders is still responsive, while it
    // preserves queue position and stops cancellation churn from dominating
    // the GUI budget.
    relistAfter: 5
  }]))
  return { id, config, filter: { ...base.filter, selectiveBuys } }
}

function loadUltraProfitV4Fleet(presetDir) {
  return INSTANCE_IDS.map(id => loadUltraProfitV4Instance(presetDir, id))
}

function loadUltraProfitV5Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V5 has no portfolio allocation for ${instanceId}.`)
  const base = loadUltraProfitV2Instance(presetDir, id)
  const config = readJson(path.join(presetDir, `ultra-profit-v5-config-${id}.json`))
  // V5 is deliberately a high-ticket portfolio, but "ticket" means the
  // projected profit of the complete order. The previous implementation used
  // minProfit (profit per unit) and accidentally removed the strongest
  // high-volume products such as Enchanted Glowstone, Fly and Hideonleaf.
  const selectiveBuys = Object.fromEntries(Object.entries(base.filter.selectiveBuys)
    .map(([itemId, rule]) => [itemId, {
      ...rule,
      maxPrice: Math.floor(Number(rule.maxPrice || 0) * 1.01),
      minProfit: Math.max(3000, Number(rule.minProfit || 0)),
      minProjectedProfit: 150000,
      minPercentage: Math.max(8, Number(rule.minPercentage || 0)),
      maxBuyAmount: Math.max(1, Math.ceil(Number(rule.maxBuyAmount || 1) * 1.35)),
      relistAfter: 5
    }]))
  return { id, config, filter: { ...base.filter, selectiveBuys } }
}

function loadUltraProfitV5Fleet(presetDir) {
  return INSTANCE_IDS.map(id => loadUltraProfitV5Instance(presetDir, id))
}

function loadUltraProfitV6Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!V6_INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V6 has no portfolio allocation for ${instanceId}.`)
  const config = readJson(path.join(presetDir, `ultra-profit-v6-config-${id}.json`))
  const localFilter = readJson(path.join(presetDir, `ultra-profit-v6-filter-${id}.json`))
  const historical = readJson(path.join(presetDir, 'high-volume-adapted-filter.json'))
  const assigned = new Set(Object.keys(localFilter.whitelist || {}))
  const blacklist = [...new Set([
    ...(historical.blacklist || []),
    ...(localFilter.blacklist || []),
    // Confirmed loss makers in the fresh V6 source log stay excluded even if
    // a future baseline blacklist changes.
    'RUSTY_COIN',
    'ENCHANTED_BLAZE_ROD',
    'SHARD_TITANOBOA',
    'TREASURITE'
  ])].filter(itemId => !assigned.has(itemId)).sort()
  return {
    id,
    config,
    filter: {
      whitelistOnly: true,
      blacklist,
      whitelist: structuredClone(localFilter.whitelist || {}),
      selectiveBuys: {}
    }
  }
}

function loadUltraProfitV6Fleet(presetDir) {
  return V6_INSTANCE_IDS.map(id => loadUltraProfitV6Instance(presetDir, id))
}

function loadUltraProfitV7Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!V6_INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V7 has no portfolio allocation for ${instanceId}.`)
  const config = readJson(path.join(presetDir, `ultra-profit-v7-config-${id}.json`))
  const localFilter = readJson(path.join(presetDir, `ultra-profit-v7-filter-${id}.json`))
  const historical = readJson(path.join(presetDir, 'high-volume-adapted-filter.json'))
  const assigned = new Set(Object.keys(localFilter.whitelist || {}))
  const confirmedSlowOrLossMaking = [
    'RUSTY_COIN', 'ENCHANTED_BLAZE_ROD', 'SHARD_TITANOBOA', 'TREASURITE',
    'BUSTED_BELT_BUCKLE', 'SALTED_SUNFLOWER_SEEDS', 'SUMMONING_EYE',
    'ENCHANTED_GOLD_BLOCK', 'SHARD_HIDEONSUN', 'SHARD_MOTH', 'GRIFFIN_FEATHER',
    'REFINED_DIAMOND', 'REFINED_MITHRIL', 'VERY_CRUDE_GABAGOOL', 'NULL_OVOID',
    'SHARD_VIPER', 'SHARD_ALLIGATOR'
  ]
  const blacklist = [...new Set([
    ...(historical.blacklist || []),
    ...(localFilter.blacklist || []),
    ...confirmedSlowOrLossMaking
  ])].filter(itemId => !assigned.has(itemId)).sort()
  return {
    id,
    config,
    filter: {
      whitelistOnly: true,
      blacklist,
      whitelist: structuredClone(localFilter.whitelist || {}),
      selectiveBuys: {}
    }
  }
}

function loadUltraProfitV7Fleet(presetDir) {
  return V6_INSTANCE_IDS.map(id => loadUltraProfitV7Instance(presetDir, id))
}

function loadUltraProfitV8Instance(presetDir, instanceId) {
  const id = String(instanceId || '').toLowerCase()
  if (!V6_INSTANCE_IDS.includes(id)) throw new Error(`Ultra Profit V8 has no portfolio allocation for ${instanceId}.`)
  const config = readJson(path.join(presetDir, `ultra-profit-v8-config-${id}.json`))
  const localFilter = readJson(path.join(presetDir, `ultra-profit-v8-filter-${id}.json`))
  const historical = readJson(path.join(presetDir, 'high-volume-adapted-filter.json'))
  const assigned = new Set(Object.keys(localFilter.whitelist || {}))
  // V8 removes the highest-churn/no-completion products found in the supplied
  // 0.9.174 telemetry. Keep the baseline blacklist as defense in depth while
  // allowing only this instance's explicitly assigned market pool.
  const telemetryRejects = [
    'FLEXBONE', 'MELON_JUICE', 'BLUE_RING', 'FLORAL_GELATIN',
    'SHARD_DOOMSPIRAL', 'COMPACTED_SUNFLOWER', 'SHARD_LOCUST',
    'SHARD_CRICKET', 'BLUE_ICE_HUNK', 'ENCHANTED_QUARTZ_BLOCK',
    'SEARED_ESCARGOT', 'FINE_JASPER_GEM', 'CHOCOBERRY', 'ENCHANTED_SHARK_FIN',
    'FOUL_FLESH', 'ENCHANTED_COAL_BLOCK', 'GLACITE_JEWEL', 'FINE_RUBY_GEM',
    'ECTOPLASM', 'FINE_SAPPHIRE_GEM'
  ]
  const blacklist = [...new Set([
    ...(historical.blacklist || []),
    ...(localFilter.blacklist || []),
    ...telemetryRejects
  ])].filter(itemId => !assigned.has(itemId)).sort()
  return {
    id,
    config,
    filter: {
      whitelistOnly: true,
      blacklist,
      whitelist: structuredClone(localFilter.whitelist || {}),
      selectiveBuys: {}
    }
  }
}

function loadUltraProfitV8Fleet(presetDir) {
  return V6_INSTANCE_IDS.map(id => loadUltraProfitV8Instance(presetDir, id))
}

function resolveSavedProfileAllocation(profile, presetDir, targetInstanceId) {
  if (!['ultra-profit-v2', 'ultra-profit-v3', 'ultra-profit-v4', 'ultra-profit-v5', 'ultra-profit-v6', 'ultra-profit-v7', 'ultra-profit-v8'].includes(profile?.portfolio)) return null
  // A portfolio profile is an entry point, not permission to install FF-3's
  // market pool on FF-2. Always resolve the allocation from the captured target
  // instance so separate pools cannot be crossed by UI selection or a race.
  if (profile.portfolio === 'ultra-profit-v4') return loadUltraProfitV4Instance(presetDir, targetInstanceId)
  if (profile.portfolio === 'ultra-profit-v5') return loadUltraProfitV5Instance(presetDir, targetInstanceId)
  if (profile.portfolio === 'ultra-profit-v6') return loadUltraProfitV6Instance(presetDir, targetInstanceId)
  if (profile.portfolio === 'ultra-profit-v7') return loadUltraProfitV7Instance(presetDir, targetInstanceId)
  if (profile.portfolio === 'ultra-profit-v8') return loadUltraProfitV8Instance(presetDir, targetInstanceId)
  return profile.portfolio === 'ultra-profit-v3' ? loadUltraProfitV3Instance(presetDir, targetInstanceId) : loadUltraProfitV2Instance(presetDir, targetInstanceId)
}

module.exports = { INSTANCE_IDS, V6_INSTANCE_IDS, loadUltraProfitV2Instance, loadUltraProfitV2Fleet, loadUltraProfitV3Instance, loadUltraProfitV3Fleet, loadUltraProfitV4Instance, loadUltraProfitV4Fleet, loadUltraProfitV5Instance, loadUltraProfitV5Fleet, loadUltraProfitV6Instance, loadUltraProfitV6Fleet, loadUltraProfitV7Instance, loadUltraProfitV7Fleet, loadUltraProfitV8Instance, loadUltraProfitV8Fleet, resolveSavedProfileAllocation }
