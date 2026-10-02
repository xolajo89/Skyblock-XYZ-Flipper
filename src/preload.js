'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args)
}

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('ff', {
  snapshot: () => invoke('app:snapshot'),
  files: {
    read: kind => invoke('file:read', kind),
    save: (kind, content, options) => invoke('file:save', kind, content, options),
    restore: kind => invoke('file:restore', kind),
    resetDefaults: () => invoke('file:reset-defaults'),
    import: kind => invoke('file:import', kind)
  },
  bot: {
    connect: () => invoke('bot:connect'),
    disconnect: () => invoke('bot:disconnect'),
    openBazaar: () => invoke('bot:open-bazaar'),
    openItem: itemName => invoke('bot:open-item', itemName),
    manageOrders: () => invoke('bot:manage-orders'),
    orderAction: (orderId, action) => invoke('bot:order-action', orderId, action),
    clearOrdersInventory: () => invoke('bot:clear-orders-inventory'),
    sendChat: text => invoke('bot:send-chat', text),
    window: () => invoke('bot:window'),
    logout: () => invoke('bot:logout'),
    clickAction: action => invoke('bot:click-action', action),
    addAccount: () => invoke('bot:account-add'),
    selectAccount: id => invoke('bot:account-select', id),
    removeAccount: id => invoke('bot:account-remove', id)
  },
  server: {
    save: settings => invoke('server:save', settings)
  },
  webpage: {
    save: (username, password) => invoke('webpage:save', username, password)
  },
  proxyPool: {
    list: () => invoke('proxy-pool:list'),
    import: (content, options) => invoke('proxy-pool:import', content, options),
    assign: (instanceId, proxyId, restartRunning) => invoke('proxy-pool:assign', instanceId, proxyId, restartRunning),
    autoAssign: countryPreferences => invoke('proxy-pool:auto-assign', countryPreferences),
    remove: proxyId => invoke('proxy-pool:remove', proxyId),
    clear: () => invoke('proxy-pool:clear')
  },
  scanner: {
    start: () => invoke('scanner:start'),
    stop: () => invoke('scanner:stop'),
    scan: () => invoke('scanner:scan'),
    items: () => invoke('scanner:items'),
    exportLog: () => invoke('scanner:export-log')
  },
  collector: {
    status: () => invoke('collector:status'),
    exportCsv: () => invoke('collector:export-csv'),
    exportTxt: () => invoke('collector:export-txt')
  },
  tracker: {
    adjustProfit: (amount, note) => invoke('tracker:adjust-profit', amount, note),
    resetInformation: () => invoke('tracker:reset-information')
  },
  dynamic: {
    generate: options => invoke('dynamic:generate', options),
    apply: () => invoke('dynamic:apply')
  },
  preset: {
    applySimple: () => invoke('preset:apply-simple'),
    applyUltraProfit: () => invoke('preset:apply-ultra-profit'),
    applyUltraProfitV3: () => invoke('preset:apply-ultra-profit-v3'),
    applyUltraProfitV4: () => invoke('preset:apply-ultra-profit-v4'),
    applyUltraProfitV5: () => invoke('preset:apply-ultra-profit-v5'),
    applyUltraProfitV6: () => invoke('preset:apply-ultra-profit-v6'),
    applyUltraProfitV7: () => invoke('preset:apply-ultra-profit-v7'),
    applyUltraProfitV8: () => invoke('preset:apply-ultra-profit-v8'),
    listProfiles: () => invoke('profiles:list'),
    saveCurrentProfile: (name, targetInstanceId) => invoke('profiles:save-current', name, targetInstanceId),
    applyProfile: (name, scope, targetInstanceId) => invoke('profiles:apply', name, scope, targetInstanceId),
    deleteProfile: name => invoke('profiles:delete', name)
  },
  instances: {
    list: () => invoke('instances:list'), select: id => invoke('instances:select', id), add: name => invoke('instances:add', name), rename: (id, name) => invoke('instances:rename', id, name), start: id => invoke('instances:start', id), stop: id => invoke('instances:stop', id), setAutoReconnect: (id, enabled) => invoke('instances:set-auto-reconnect', id, enabled), setHubRoaming: (id, enabled) => invoke('instances:set-hub-roaming', id, enabled), remove: id => invoke('instances:remove', id),
    startAll: () => invoke('instances:start-all'), closeAll: () => invoke('instances:close-all'), restartAll: () => invoke('instances:restart-all'), ignoreBanRate: () => invoke('instances:ignore-ban-rate')
  },
  hub: {
    status: id => invoke('hub:status', id),
    teleport: id => invoke('hub:teleport', id),
    start: id => invoke('hub:start', id),
    pause: id => invoke('hub:pause', id),
    resume: id => invoke('hub:resume', id),
    stop: id => invoke('hub:stop', id),
    setActivityMode: (id, mode) => invoke('hub:set-activity-mode', id, mode),
    setHumanizerVersion: (id, version) => invoke('hub:set-humanizer-version', id, version),
    exportDiagnostics: id => invoke('hub:export-diagnostics', id)
  },
  openMicrosoft: url => invoke('external:open', url),
  openDataFolder: () => invoke('folder:open-data'),
  killApp: () => invoke('app:kill'),
  logs: {
    exportCrash: () => invoke('logs:export-crash'),
    exportChat: () => invoke('logs:export-chat'),
    download: () => invoke('logs:download')
  },
  onBotState: callback => on('bot-state', callback),
  onDeviceCode: callback => on('device-code', callback),
  onInstancesSummary: callback => on('instances-summary', callback),
  onHubState: callback => on('hub-state', callback),
  onMarket: callback => on('market-update', callback),
  onCollector: callback => on('collector-state', callback),
  onAutomation: callback => on('automation-state', callback),
  onLog: callback => on('log-entry', callback),
  onChat: callback => on('chat-message', callback),
  onWindow: callback => on('window-state', callback)
})
