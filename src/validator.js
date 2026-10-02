'use strict'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value, path, errors, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number.`)
    return
  }
  if (options.min !== undefined && value < options.min) errors.push(`${path} must be at least ${options.min}.`)
  if (options.max !== undefined && value > options.max) errors.push(`${path} must be at most ${options.max}.`)
}

function scalarOrArray(value, path, errors, check) {
  const values = Array.isArray(value) ? value : [value]
  if (!values.length) {
    errors.push(`${path} cannot be an empty array.`)
    return
  }
  values.forEach((entry, index) => check(entry, Array.isArray(value) ? `${path}[${index}]` : path))
}

function validateConfig(config) {
  const errors = []
  if (!object(config)) return ['Config root must be a JSON object.']
  const requiredObjects = ['profit', 'price', 'orders', 'volume', 'purse']
  for (const key of requiredObjects) if (!object(config[key])) errors.push(`${key} must be an object.`)
  if (typeof config.clearOnStart !== 'boolean') errors.push('clearOnStart must be a boolean.')
  if (object(config.server)) {
    if (typeof config.server.host !== 'string' || !config.server.host.trim()) errors.push('server.host is required.')
    if (config.server.version !== undefined && !(config.server.version === false || typeof config.server.version === 'string')) errors.push('server.version must be false or a version string.')
  }
  if (object(config.proxy)) {
    if (typeof config.proxy.enabled !== 'boolean') errors.push('proxy.enabled must be a boolean.')
    scalarOrArray(config.proxy.ip, 'proxy.ip', errors, (value, path) => {
      if (typeof value !== 'string') errors.push(`${path} must be a string.`)
    })
    scalarOrArray(config.proxy.port, 'proxy.port', errors, (value, path) => finite(value, path, errors, { min: 0, max: 65535 }))
    for (const field of ['username', 'password']) {
      scalarOrArray(config.proxy[field], `proxy.${field}`, errors, (value, path) => {
        if (typeof value !== 'string') errors.push(`${path} must be a string.`)
      })
    }
  }
  if (object(config.dynamicRest)) {
    if (typeof config.dynamicRest.enabled !== 'boolean') errors.push('dynamicRest.enabled must be a boolean.')
    for (const section of ['workMinutes', 'breakMinutes']) {
      const range = config.dynamicRest[section]
      if (!object(range)) errors.push(`dynamicRest.${section} must be an object.`)
      else {
        finite(range.min, `dynamicRest.${section}.min`, errors, { min: 0 })
        finite(range.max, `dynamicRest.${section}.max`, errors, { min: 0 })
        if (Number(range.min) > Number(range.max)) errors.push(`dynamicRest.${section}.min cannot exceed its maximum.`)
      }
    }
  }
  if (object(config.cookie)) {
    finite(config.cookie.purchaseThresholdHours, 'cookie.purchaseThresholdHours', errors, { min: 0, max: 8760 })
  }
  if (object(config.automation)) {
    for (const key of ['enterSkyblockOnSpawn', 'openBazaarOnSpawn']) if (typeof config.automation[key] !== 'boolean') errors.push(`automation.${key} must be a boolean.`)
    for (const key of ['commandDelayMinMs', 'commandDelayMaxMs', 'skyblockLoadMinMs', 'skyblockLoadMaxMs', 'clickDelayMinMs', 'clickDelayMaxMs']) finite(config.automation[key], `automation.${key}`, errors, { min: 0, max: 60000 })
    finite(config.automation.maxClicksPerMinute, 'automation.maxClicksPerMinute', errors, { min: 1, max: 120 })
    if (Number(config.automation.commandDelayMinMs) > Number(config.automation.commandDelayMaxMs)) errors.push('automation command delay minimum cannot exceed its maximum.')
    if (Number(config.automation.skyblockLoadMinMs) > Number(config.automation.skyblockLoadMaxMs)) errors.push('automation SkyBlock load minimum cannot exceed its maximum.')
    if (Number(config.automation.clickDelayMinMs) > Number(config.automation.clickDelayMaxMs)) errors.push('automation click delay minimum cannot exceed its maximum.')
    const typing = config.automation.bazaarSearchTyping
    if (!object(typing)) errors.push('automation.bazaarSearchTyping must be an object.')
    else {
      if (typeof typing.enabled !== 'boolean') errors.push('automation.bazaarSearchTyping.enabled must be a boolean.')
      finite(typing.shortNameMaxChars, 'automation.bazaarSearchTyping.shortNameMaxChars', errors, { min: 1, max: 100 })
      finite(typing.mediumNameMaxChars, 'automation.bazaarSearchTyping.mediumNameMaxChars', errors, { min: 1, max: 100 })
      for (const key of ['shortDelayMinMs', 'shortDelayMaxMs', 'mediumDelayMinMs', 'mediumDelayMaxMs', 'extraDelayPerCharacterMs', 'maximumDelayMs']) finite(typing[key], `automation.bazaarSearchTyping.${key}`, errors, { min: 0, max: 60000 })
      if (Number(typing.shortNameMaxChars) >= Number(typing.mediumNameMaxChars)) errors.push('Bazaar search short-name limit must be below its medium-name limit.')
      if (Number(typing.shortDelayMinMs) > Number(typing.shortDelayMaxMs)) errors.push('Bazaar short-name typing delay minimum cannot exceed its maximum.')
      if (Number(typing.mediumDelayMinMs) > Number(typing.mediumDelayMaxMs)) errors.push('Bazaar medium-name typing delay minimum cannot exceed its maximum.')
    }
    const trader = config.automation.autoTrader
    if (!object(trader)) errors.push('automation.autoTrader must be an object.')
    else {
      for (const key of ['enabled', 'automaticConfigAndFilter', 'relistOutbidOrders']) if (typeof trader[key] !== 'boolean') errors.push(`automation.autoTrader.${key} must be a boolean.`)
      finite(trader.strategyPurse, 'automation.autoTrader.strategyPurse', errors, { min: 1, max: 1000000000000 })
      finite(trader.strategyLookbackHours, 'automation.autoTrader.strategyLookbackHours', errors, { min: 1, max: 720 })
      finite(trader.strategyRefreshMinutes, 'automation.autoTrader.strategyRefreshMinutes', errors, { min: 1, max: 1440 })
      finite(trader.manageOrdersIntervalSeconds, 'automation.autoTrader.manageOrdersIntervalSeconds', errors, { min: 10, max: 3600 })
      finite(trader.actionTimeoutSeconds, 'automation.autoTrader.actionTimeoutSeconds', errors, { min: 8, max: 120 })
      finite(trader.relistMinAgeSeconds, 'automation.autoTrader.relistMinAgeSeconds', errors, { min: 0, max: 3600 })
    }
  }
  if (object(config.profit)) {
    finite(config.profit.min, 'profit.min', errors, { min: 0 })
    finite(config.profit.max, 'profit.max', errors, { min: 0 })
    finite(config.profit.minPercentage, 'profit.minPercentage', errors, { min: 0, max: 10000 })
    if (Number(config.profit.min) > Number(config.profit.max)) errors.push('profit.min cannot exceed profit.max.')
  }
  if (object(config.price)) {
    finite(config.price.minPricePerUnitBuy, 'price.minPricePerUnitBuy', errors, { min: 0 })
    finite(config.price.maxPricePerUnitBuy, 'price.maxPricePerUnitBuy', errors, { min: 0 })
    finite(config.price.maxPricePerUnitSell, 'price.maxPricePerUnitSell', errors, { min: 0 })
    finite(config.price.manipulationTriggerPercentage, 'price.manipulationTriggerPercentage', errors, { min: 0, max: 10000 })
    finite(config.price.temporaryBlacklistDuration, 'price.temporaryBlacklistDuration', errors, { min: 0 })
    if (Number(config.price.minPricePerUnitBuy) > Number(config.price.maxPricePerUnitBuy)) errors.push('price.minPricePerUnitBuy cannot exceed price.maxPricePerUnitBuy.')
  }
  if (object(config.orders)) {
    finite(config.orders.maxBuyOrders, 'orders.maxBuyOrders', errors, { min: 1, max: 7 })
    finite(config.orders.maxAmountOfSellOffers, 'orders.maxAmountOfSellOffers', errors, { min: 1, max: 100 })
    if (!['coinsPerHour', 'profitMargin', 'percentageProfit', 'profitPercentage', 'profit', 'sellVolume', 'buyVolume', 'volume', 'supplyDemandRatio'].includes(config.orders.sortBy)) errors.push('orders.sortBy is not supported.')
    if (!['orderAmount', 'itemAmount'].includes(config.orders.relistAfterType)) errors.push('orders.relistAfterType must be "orderAmount" or "itemAmount".')
    finite(config.orders.relistAfter, 'orders.relistAfter', errors, { min: 0 })
    finite(config.orders.relistWorthThreshold, 'orders.relistWorthThreshold', errors, { min: 0 })
  }
  if (object(config.volume)) {
    finite(config.volume.minBuy, 'volume.minBuy', errors, { min: 0 })
    finite(config.volume.minSell, 'volume.minSell', errors, { min: 0 })
  }
  if (object(config.purse)) {
    finite(config.purse.minPurse, 'purse.minPurse', errors, { min: 0 })
    finite(config.purse.maxSpentPerOrder, 'purse.maxSpentPerOrder', errors, { min: 1 })
  }
  if (config.taxPercent !== undefined) finite(config.taxPercent, 'taxPercent', errors, { min: 0, max: 100 })
  if (object(config.collector)) {
    if (typeof config.collector.enabled !== 'boolean') errors.push('collector.enabled must be a boolean.')
    if (typeof config.collector.autoStart !== 'boolean') errors.push('collector.autoStart must be a boolean.')
    finite(config.collector.sampleSeconds, 'collector.sampleSeconds', errors, { min: 15, max: 3600 })
    finite(config.collector.bucketMinutes, 'collector.bucketMinutes', errors, { min: 1, max: 1440 })
    finite(config.collector.retentionDays, 'collector.retentionDays', errors, { min: 1, max: 365 })
    finite(config.collector.exportHours, 'collector.exportHours', errors, { min: 1, max: 168 })
  }
  if (!['both', true, false].includes(config.selectiveBuys)) errors.push('selectiveBuys must be "both", true, or false.')
  return errors
}

function validateCriteria(criteria, path, errors) {
  if (!object(criteria)) {
    errors.push(`${path} must be an object.`)
    return
  }
  const numeric = ['maxPrice', 'minProfit', 'minProjectedProfit', 'minPercentage', 'minBuyOrder', 'maxBuyOrder', 'minSellOffer', 'maxSellOffer', 'minBuyVolume', 'minSellVolume', 'maxBuyAmount', 'relistAfter', 'relistWorthThreshold', 'manipulationTriggerPercentage']
  for (const key of numeric) if (criteria[key] !== undefined) finite(criteria[key], `${path}.${key}`, errors, { min: 0 })
}

function validateFilter(filter) {
  const errors = []
  if (!object(filter)) return ['Filter root must be a JSON object.']
  if (filter.whitelistOnly !== undefined && typeof filter.whitelistOnly !== 'boolean') errors.push('whitelistOnly must be a boolean when provided.')
  if (!Array.isArray(filter.blacklist) || filter.blacklist.some(item => typeof item !== 'string' || !item.trim())) errors.push('blacklist must be an array of item ID strings.')
  for (const section of ['whitelist', 'selectiveBuys']) {
    if (!object(filter[section])) {
      errors.push(`${section} must be an object.`)
      continue
    }
    for (const [itemId, criteria] of Object.entries(filter[section])) {
      if (!/^[A-Z0-9_:%-]+$/.test(itemId)) errors.push(`${section} contains an invalid item ID: ${itemId}`)
      validateCriteria(criteria, `${section}.${itemId}`, errors)
    }
  }
  return errors
}

module.exports = { validateConfig, validateFilter }
