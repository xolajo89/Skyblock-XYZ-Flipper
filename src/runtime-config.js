'use strict'

// Engine-only settings live here so config.json can stay focused on the
// trading controls people are expected to edit.  Values from config.json win
// when an older installation still contains one of these sections.
const ENGINE_DEFAULTS = Object.freeze({
  server: { host: 'mc.hypixel.net', version: '26.2' },
  automation: {
    enterSkyblockOnSpawn: true,
    openBazaarOnSpawn: true,
    commandDelayMinMs: 1800,
    commandDelayMaxMs: 3200,
    skyblockLoadMinMs: 5000,
    skyblockLoadMaxMs: 8000,
    clickDelayMinMs: 300,
    clickDelayMaxMs: 650,
    maxClicksPerMinute: 40,
    bazaarSearchTyping: {
      enabled: true,
      shortNameMaxChars: 8,
      shortDelayMinMs: 1500,
      shortDelayMaxMs: 2300,
      mediumNameMaxChars: 16,
      mediumDelayMinMs: 2400,
      mediumDelayMaxMs: 4200,
      extraDelayPerCharacterMs: 100,
      maximumDelayMs: 6500
    },
    autoTrader: {
      enabled: true,
      automaticConfigAndFilter: false,
      strategyPurse: 150000000,
      strategyLookbackHours: 24,
      strategyRefreshMinutes: 15,
      manageOrdersIntervalSeconds: 20,
      actionTimeoutSeconds: 12,
      relistOutbidOrders: true,
      relistMinAgeSeconds: 90
    }
  },
  taxPercent: 1.25,
  scanner: { refreshSeconds: 15, maxCandidates: 100 },
  collector: {
    enabled: true,
    autoStart: true,
    sampleSeconds: 60,
    bucketMinutes: 15,
    retentionDays: 7,
    exportHours: 24
  }
})

function merge(base, incoming) {
  if (!base || typeof base !== 'object' || Array.isArray(base) || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
  const result = { ...base }
  for (const [key, value] of Object.entries(incoming)) result[key] = key in base ? merge(base[key], value) : value
  return result
}

function runtimeConfig(userConfig = {}, engineOverrides = {}) {
  return merge(merge(structuredClone(ENGINE_DEFAULTS), engineOverrides), userConfig)
}

module.exports = { ENGINE_DEFAULTS, runtimeConfig }
