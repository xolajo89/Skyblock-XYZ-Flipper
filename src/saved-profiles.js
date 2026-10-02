'use strict'

// A saved profile is deliberately a trading-rules preset, not a complete
// instance backup. Applying it must never replace connectivity, credentials,
// recovery policy, or any future non-trading settings.
const PROFILE_TRADING_CONFIG_KEYS = Object.freeze([
  'profit',
  'price',
  'orders',
  'volume',
  'purse',
  'selectiveBuys'
])

function profileId(value) {
  const id = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!id || id.length > 64) throw new Error('Profile name must contain 1 to 64 letters, numbers, spaces, dashes, or underscores.')
  return id
}

function profileFileName(name) {
  return `${profileId(name)}.json`
}

function createSavedProfile(name, sourceInstance, config, filter) {
  const id = profileId(name)
  return {
    version: 1,
    id,
    name: String(name || '').trim(),
    createdAt: new Date().toISOString(),
    sourceInstance: String(sourceInstance || ''),
    config,
    filter
  }
}

function summarizeSavedProfile(profile) {
  return {
    id: profileId(profile?.id || profile?.name),
    name: String(profile?.name || profile?.id || '').trim(),
    createdAt: String(profile?.createdAt || ''),
    sourceInstance: String(profile?.sourceInstance || ''),
    builtIn: profile?.builtIn === true
  }
}

function mergeProfileTradingConfig(current, saved) {
  const next = structuredClone(current || {})
  for (const key of PROFILE_TRADING_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(saved || {}, key)) continue
    next[key] = structuredClone(saved[key])
  }
  return next
}

function bundledProfileIsCurrent(profile, bundledVersion) {
  return profile?.builtIn === true && Number(profile.bundledVersion) === Number(bundledVersion)
}

module.exports = { PROFILE_TRADING_CONFIG_KEYS, profileId, profileFileName, createSavedProfile, summarizeSavedProfile, mergeProfileTradingConfig, bundledProfileIsCurrent }
