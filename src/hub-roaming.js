'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const HUB_ROUTE = Object.freeze([
  Object.freeze({ x: 0.5, y: 77, z: -0.5 }),
  Object.freeze({ x: -3.36, y: 78, z: -5.352 }),
  Object.freeze({ x: -7.13, y: 71, z: -10.64 }),
  Object.freeze({ x: -13.629, y: 71, z: -20.085 }),
  Object.freeze({ x: -25.409, y: 71, z: -27.103 }),
  Object.freeze({ x: -36.016, y: 72, z: -27.401 }),
  Object.freeze({ x: -61.222, y: 70, z: -27.267 })
])

// Captured clockwise around the central Hub portal. The elevated spawn and
// stair points stay exact; the paved ring is wide enough for conservative
// in-segment variation without inventing shortcuts through scenery.
const HUB_PORTAL_LOOP = Object.freeze([
  Object.freeze({ x: 0.5, y: 77, z: -0.5 }),
  Object.freeze({ x: -6.666, y: 74.5, z: -1.732 }),
  Object.freeze({ x: -9.818, y: 71.5, z: -8.487 }),
  Object.freeze({ x: -14.388, y: 71, z: -17.578 }),
  Object.freeze({ x: -16.181, y: 71, z: -34.874 }),
  Object.freeze({ x: -7.989, y: 71, z: -44.545 }),
  Object.freeze({ x: 5.389, y: 71, z: -45.335 }),
  Object.freeze({ x: 17.881, y: 71, z: -39.096 }),
  Object.freeze({ x: 18.709, y: 71, z: -22.415 }),
  Object.freeze({ x: 11.588, y: 71, z: -11.758 }),
  Object.freeze({ x: -9.874, y: 71, z: -12.023 })
])

const BAZAAR_APPROACH_POINTS = Object.freeze([
  Object.freeze({ x: -33.371, y: 72, z: -25.53 }),
  Object.freeze({ x: -32.9, y: 72, z: -25.55 }),
  Object.freeze({ x: -33.84, y: 72, z: -25.55 })
])

const BAZAAR_INTERACTION_ZONE = Object.freeze({
  approach: Object.freeze({ x: -33.371, y: 72, z: -25.53 }),
  labelHint: Object.freeze({ x: -33.34, y: 74.2, z: -23.25 }),
  targetHint: Object.freeze({ x: -33.34, y: 72, z: -23.35 }),
  // The native bridge validates this as the maximum distance from the
  // account's *current* position to the safe NPC approach point. 2.25 made
  // the recovery impossible from virtually every roaming waypoint. The
  // bridge still uses a dry, no-mining path and refuses non-Hub locations.
  maxApproachDistance: 64,
  maxTargetDistance: 4.5
})

const ACTIVITY_PROFILES = Object.freeze({
  'ultra-low': Object.freeze({
    id: 'ultra-low', label: 'Ultra Low Activity', initialWalkChance: 0.12,
    walkMinMs: 18_000, walkMaxMs: 42_000, idleMinMs: 300_000, idleMaxMs: 600_000,
    dwellMinMs: 6_000, dwellMaxMs: 20_000,
    jumpMinMs: 420, jumpMaxMs: 900, swingMinMs: 55_000, swingMaxMs: 150_000,
    bazaarNpcChance: 0.08, bazaarCommandChance: 0.01, bazaarCooldownMinMs: 900_000, bazaarCooldownMaxMs: 1_800_000
  }),
  low: Object.freeze({
    id: 'low', label: 'Low Activity', initialWalkChance: 0.38,
    walkMinMs: 35_000, walkMaxMs: 105_000, idleMinMs: 120_000, idleMaxMs: 300_000,
    dwellMinMs: 5_000, dwellMaxMs: 18_000,
    jumpMinMs: 380, jumpMaxMs: 850, swingMinMs: 38_000, swingMaxMs: 115_000,
    bazaarNpcChance: 0.24, bazaarCommandChance: 0.04, bazaarCooldownMinMs: 420_000, bazaarCooldownMaxMs: 900_000
  }),
  medium: Object.freeze({
    id: 'medium', label: 'Medium Activity', initialWalkChance: 0.68,
    walkMinMs: 90_000, walkMaxMs: 240_000, idleMinMs: 45_000, idleMaxMs: 150_000,
    dwellMinMs: 3_000, dwellMaxMs: 13_000,
    jumpMinMs: 330, jumpMaxMs: 760, swingMinMs: 20_000, swingMaxMs: 68_000,
    bazaarNpcChance: 0.55, bazaarCommandChance: 0.12, bazaarCooldownMinMs: 210_000, bazaarCooldownMaxMs: 480_000
  }),
  high: Object.freeze({
    id: 'high', label: 'High Activity', initialWalkChance: 0.88,
    walkMinMs: 210_000, walkMaxMs: 540_000, idleMinMs: 18_000, idleMaxMs: 70_000,
    dwellMinMs: 1_800, dwellMaxMs: 8_500,
    jumpMinMs: 280, jumpMaxMs: 650, swingMinMs: 11_000, swingMaxMs: 42_000,
    bazaarNpcChance: 0.72, bazaarCommandChance: 0.22, bazaarCooldownMinMs: 120_000, bazaarCooldownMaxMs: 330_000
  }),
  'no-bazaar': Object.freeze({
    id: 'no-bazaar', label: 'No Bazaar', initialWalkChance: 0.62,
    walkMinMs: 75_000, walkMaxMs: 230_000, idleMinMs: 55_000, idleMaxMs: 180_000,
    dwellMinMs: 3_500, dwellMaxMs: 15_000,
    jumpMinMs: 350, jumpMaxMs: 800, swingMinMs: 22_000, swingMaxMs: 72_000,
    bazaarNpcChance: 0, bazaarCommandChance: 0, bazaarCooldownMinMs: 0, bazaarCooldownMaxMs: 0
  })
})

function activityProfile(value) {
  return ACTIVITY_PROFILES[String(value || '').trim().toLowerCase()] || ACTIVITY_PROFILES.medium
}

function variedDuration(random, minMs, maxMs) {
  const low = Math.max(250, Number(minMs) || 250)
  const high = Math.max(low, Number(maxMs) || low)
  // Averaging two draws produces mostly ordinary pauses while retaining rare
  // short and long sessions. It avoids a mechanical fixed or uniform cadence.
  const shaped = (randomUnit(random) + randomUnit(random)) / 2
  return Math.round(low + (high - low) * shaped)
}

function randomUnit(random = Math.random) {
  const value = Number(random())
  if (!Number.isFinite(value)) return 0.5
  return Math.min(0.999999999, Math.max(0, value))
}

function rounded(value, precision = 3) {
  const scale = 10 ** precision
  return Math.round(Number(value) * scale) / scale
}

function variedPointOnSegment(start, end, t, lateral = 0, y = start.y) {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz) || 1
  return {
    x: rounded(start.x + dx * t - (dz / length) * lateral),
    y: rounded(y),
    z: rounded(start.z + dz * t + (dx / length) * lateral)
  }
}

function routeFingerprint(route) {
  return route.map(point => `${rounded(point.x, 3)},${rounded(point.y, 3)},${rounded(point.z, 3)}`).join('|')
}

function createVariedBazaarRoute(random = Math.random, lap = 1, previousFingerprints = '') {
  const cycle = Math.max(1, Math.floor(Number(lap) || 1))
  const excluded = previousFingerprints instanceof Set
    ? previousFingerprints
    : new Set(Array.isArray(previousFingerprints) ? previousFingerprints : [previousFingerprints].filter(Boolean))
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const variation = cycle + attempt
    // Lap-derived phases keep even a broken/constant RNG from recreating an
    // earlier physical plan. They move targets along already captured flat
    // corridors, so a several-block longitudinal change does not invent a
    // new unverified side path.
    const firstPhase = ((variation * 613) % 997) / 996
    const secondPhase = ((variation * 379) % 991) / 990
    const firstT = Math.min(0.8, Math.max(0.2, 0.25 + randomUnit(random) * 0.42 + (firstPhase - 0.5) * 0.13))
    const secondT = Math.min(0.82, Math.max(0.18, 0.2 + randomUnit(random) * 0.47 + (secondPhase - 0.5) * 0.17))
    const firstLateral = (randomUnit(random) * 2 - 1) * 0.3 + (variation % 2 ? 0.08 : -0.08)
    const secondLateral = (randomUnit(random) * 2 - 1) * 0.45 + (variation % 3 - 1) * 0.1
    const approach = BAZAAR_APPROACH_POINTS[(Math.floor(randomUnit(random) * BAZAAR_APPROACH_POINTS.length) + variation) % BAZAAR_APPROACH_POINTS.length]
    const joinIn = {
      x: rounded(-31.25 + (randomUnit(random) * 1.2 - 0.6)),
      y: 72,
      z: rounded(-27.27 + (randomUnit(random) * 0.36 - 0.18))
    }
    const joinOut = {
      x: rounded(-34.75 + (randomUnit(random) * 0.8 - 0.4)),
      y: 72,
      z: rounded(-27.37 + (randomUnit(random) * 0.3 - 0.15))
    }
    const route = [
      { ...HUB_ROUTE[0] },
      { ...HUB_ROUTE[1] },
      { ...HUB_ROUTE[2] },
      { ...variedPointOnSegment(HUB_ROUTE[2], HUB_ROUTE[3], firstT, firstLateral, 71), behavior: variation % 2 ? 'ambient-bazaar' : 'look-stop' },
      { ...HUB_ROUTE[3] },
      { ...variedPointOnSegment(HUB_ROUTE[3], HUB_ROUTE[4], secondT, secondLateral, 71), behavior: variation % 2 ? 'look-stop' : 'ambient-bazaar' },
      { ...HUB_ROUTE[4] },
      { ...joinIn, behavior: 'bazaar-spur' },
      { ...approach, behavior: 'bazaar-npc' },
      { ...joinOut, behavior: 'bazaar-spur' },
      { ...HUB_ROUTE[5] },
      { ...HUB_ROUTE[6] }
    ]
    const fingerprint = routeFingerprint(route)
    if (!excluded.has(fingerprint)) return { route, fingerprint, family: 'bazaar-spur', pingPong: true }
  }

  // A deterministic last-resort nudge along the already captured flat
  // corridor guarantees that adjacent plans still differ if a caller supplies
  // a constant RNG. It never changes Y or moves outside the conservative lane.
  for (let offset = 1; offset <= 4096; offset += 1) {
    const fallback = createVariedBazaarRoute(
      () => (((cycle + offset) * 0.61803398875) % 0.8) + 0.1,
      cycle + 32 + offset,
      ''
    )
    if (!excluded.has(fallback.fingerprint)) return fallback
  }
  throw new Error('No unused safe Hub route variation could be generated for this session.')
}

function createVariedPortalLoop(random = Math.random, lap = 1, previousFingerprints = '') {
  const cycle = Math.max(1, Math.floor(Number(lap) || 1))
  const excluded = previousFingerprints instanceof Set
    ? previousFingerprints
    : new Set(Array.isArray(previousFingerprints) ? previousFingerprints : [previousFingerprints].filter(Boolean))

  for (let attempt = 0; attempt < 128; attempt += 1) {
    const variation = cycle + attempt
    // Successive portal laps alternate direction even though portal laps are
    // themselves the even-numbered entries in the two-family rotation.
    const clockwise = Math.floor(variation / 2) % 2 === 1
    const ring = HUB_PORTAL_LOOP.slice(2)
    const orderedRing = clockwise ? ring : [ring[0], ...ring.slice(1).reverse()]
    // Return through the captured western stair approach instead of allowing
    // a loop wrap to cut directly across the portal or decorative walls.
    const anchors = [HUB_PORTAL_LOOP[0], HUB_PORTAL_LOOP[1], ...orderedRing, HUB_PORTAL_LOOP[2], HUB_PORTAL_LOOP[1]]
    const route = [{ ...anchors[0] }]

    for (let index = 1; index < anchors.length; index += 1) {
      const start = anchors[index - 1]
      const end = anchors[index]
      const horizontalDistance = Math.hypot(end.x - start.x, end.z - start.z)
      const onPavedRing = start.y <= 71.5 && end.y <= 71.5 && horizontalDistance >= 4
      if (onPavedRing) {
        const phase = (((variation * 431) + (index * 197)) % 997) / 996
        const t = Math.min(0.68, Math.max(0.32, 0.38 + randomUnit(random) * 0.22 + (phase - 0.5) * 0.12))
        const lateralSign = ((variation + index) % 2) ? 1 : -1
        const lateral = lateralSign * (0.08 + randomUnit(random) * 0.22 + phase * 0.08)
        const y = rounded(start.y + (end.y - start.y) * t)
        const behaviorSelector = (variation + index) % 6
        route.push({
          ...variedPointOnSegment(start, end, t, lateral, y),
          ...(behaviorSelector === 0 ? { behavior: 'ambient-bazaar' } : (behaviorSelector === 3 ? { behavior: 'look-stop' } : {}))
        })
      }
      route.push({ ...end })
    }

    const fingerprint = routeFingerprint(route)
    if (!excluded.has(fingerprint)) {
      // Reverse at route ends instead of wrapping from the last captured
      // portal point back to spawn across decorative geometry.
      return { route, fingerprint, family: 'portal-loop', pingPong: true, clockwise }
    }
  }
  throw new Error('No unused safe portal-loop variation could be generated for this session.')
}

function createVariedHubRoute(random = Math.random, lap = 1, previousFingerprints = '') {
  const cycle = Math.max(1, Math.floor(Number(lap) || 1))
  // Deterministic alternation guarantees both captured routes are exercised;
  // each family still has its own per-lap physical and camera variation.
  return cycle % 2 === 0
    ? createVariedPortalLoop(random, cycle, previousFingerprints)
    : createVariedBazaarRoute(random, cycle, previousFingerprints)
}

function cleanLocation(value) {
  return String(value || '').replace(/\u00a7./g, '').replace(/[\uE000-\uF8FF]/g, '').replace(/^[^a-z]+/i, '').trim()
}

function isHubLocation(value) {
  return /^(?:hub|village|bazaar alley|forest)(?:\b|$)/i.test(cleanLocation(value))
}

function finitePoint(value) {
  if (!value || typeof value !== 'object') return null
  const raw = [value.x, value.y, value.z]
  if (raw.some(axis => axis === null || axis === undefined || axis === '')) return null
  const x = Number(raw[0]); const y = Number(raw[1]); const z = Number(raw[2])
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}

function mentionsUsernameInPlayerChat(event, username) {
  const name = String(username || '').trim()
  if (!name || !event?.sender) return false
  const source = String(event.content || event.text || '')
  if (!source) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(source)
}

class HubRoaming extends EventEmitter {
  constructor({ instanceId, instanceName, root, bot, automation, log, acquire, release, random = Math.random }) {
    super()
    this.instanceId = String(instanceId)
    this.instanceName = String(instanceName || instanceId)
    this.root = root
    this.bot = bot
    this.automation = automation
    this.log = log
    this.acquire = acquire || (() => true)
    this.release = release || (() => {})
    this.random = random
    this.userPaused = false
    this.tradePaused = false
    this.manualTradeHold = false
    this.awaitingHub = false
    this.routeStarted = false
    this.resumeTimer = null
    this.recoveryTimer = null
    this.recoveryBlocked = false
    this.resumeAfterNextConnection = false
    this.startTeleportTimer = null
    this.routeRefreshTimer = null
    this.activityTimer = null
    this.guardTimer = null
    this.mentionFailSafeTimer = null
    this.mentionFailSafeActive = false
    this.mentionFailSafeHubRequested = false
    this.mentionFailSafeUntil = 0
    this.closed = false
    this.lastMovementDiagnosticAt = 0
    this.activeRoute = HUB_ROUTE.map(point => ({ ...point }))
    this.lastRouteFingerprint = routeFingerprint(this.activeRoute)
    this.routeFingerprintHistory = new Set([this.lastRouteFingerprint])
    this.activeRouteFamily = 'bazaar-spur'
    this.activeRoutePingPong = true
    this.routeLap = 0
    this.pendingRouteRefresh = false
    this.nextAmbientBazaarAt = 0
    this.activityMode = 'medium'
    this.humanizerVersion = 2
    this.activityPaused = false
    this.nextActivityAt = 0
    this.activityPausedBeforeTrade = false
    this.activityDeadlineBeforeTrade = 0
    this.settingsFile = path.join(root, 'hub-roaming-settings.json')
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'))
      if (ACTIVITY_PROFILES[saved?.activityMode]) this.activityMode = saved.activityMode
      if ([1, 2].includes(Number(saved?.humanizerVersion))) this.humanizerVersion = Number(saved.humanizerVersion)
    } catch {}
    this.lastBehavior = 'Route ready.'
    this.diagnostics = []
    this.diagnosticsFile = path.join(root, 'hub-diagnostics.jsonl')
    this.state = {
      instanceId: this.instanceId,
      enabled: false,
      modeActive: false,
      paused: false,
      userPaused: false,
      status: 'OFF',
      location: '',
      position: null,
      goal: null,
      currentWaypoint: 0,
      totalWaypoints: this.activeRoute.length,
      lap: 0,
      variation: this.lastRouteFingerprint.slice(0, 48),
      routeFamily: this.activeRouteFamily,
      activityMode: this.activityMode,
      activityLabel: activityProfile(this.activityMode).label,
      activityModeConfirmed: true,
      activityModeAppliedAt: new Date().toISOString(),
      humanizerVersion: this.humanizerVersion,
      godPotion: { godPotionActive: false, speedLevel: 0, jumpBoostLevel: 0, activeEffectCount: 0 },
      activityPaused: false,
      nextActivityAt: '',
      lastBehavior: this.lastBehavior,
      error: '',
      updatedAt: new Date().toISOString()
    }
    this.onBotStateBound = snapshot => this.onBotState(snapshot)
    this.onMovementStateBound = event => this.onMovementState(event)
    this.onPathResultBound = event => this.onPathResult(event)
    this.onWorldSpawnBound = event => this.onWorldSpawn(event)
    this.onDailyLimitBound = event => this.onDailyLimit(event)
    this.onManualActionCompleteBound = () => this.onManualActionComplete()
    this.onAutomationStateBound = state => this.onAutomationState(state)
    this.onChatBound = event => this.onChat(event)
    bot.on('state', this.onBotStateBound)
    bot.on('movement-state', this.onMovementStateBound)
    bot.on('path-result', this.onPathResultBound)
    bot.on('world-spawn', this.onWorldSpawnBound)
    bot.on('daily-limit', this.onDailyLimitBound)
    bot.on('manual-order-action-complete', this.onManualActionCompleteBound)
    automation.on('state', this.onAutomationStateBound)
    bot.on('chat', this.onChatBound)
    automation.setHubBazaarOpener?.(async () => {
      if (!this.state.enabled || !this.locationReady() || typeof this.bot.openBazaarViaNpc !== 'function') return false
      this.lastBehavior = 'Remote /bz timed out; approaching the physical Bazaar NPC for this instance.'
      this.update({ lastBehavior: this.lastBehavior }, 'bazaar-npc-recovery')
      const result = await this.bot.openBazaarViaNpc(BAZAAR_INTERACTION_ZONE)
      if (result?.opened) {
        this.lastBehavior = 'Opened Bazaar through the verified nearby NPC fallback.'
        this.update({ lastBehavior: this.lastBehavior }, 'bazaar-npc-recovered')
        return true
      }
      this.lastBehavior = `NPC fallback was not confirmed (${result?.reason || 'no verified target'}); one remote /bz fallback remains available.`
      this.update({ lastBehavior: this.lastBehavior }, 'bazaar-npc-recovery-failed')
      return false
    })
  }

  snapshot() {
    const current = Math.max(0, Number(this.state.currentWaypoint) || 0)
    const total = Math.max(0, Number(this.state.totalWaypoints) || HUB_ROUTE.length)
    return { ...this.state, userPaused: this.userPaused, position: finitePoint(this.state.position), goal: finitePoint(this.state.goal), route: { current, total } }
  }

  update(patch, diagnosticType = 'state') {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() })
    const snapshot = this.snapshot()
    this.record(diagnosticType, snapshot)
    this.emit('state', snapshot)
    return snapshot
  }

  record(type, payload = {}) {
    const entry = { at: new Date().toISOString(), type, instanceId: this.instanceId, instanceName: this.instanceName, ...payload }
    // The bridge normally reports movement at about 1 Hz. Keep the UI live,
    // but cap persistent writes if an old/noisy bridge floods telemetry.
    if (type === 'movement') {
      const now = Date.now()
      if (now - this.lastMovementDiagnosticAt < 500) return entry
      this.lastMovementDiagnosticAt = now
    }
    this.diagnostics.push(entry)
    if (this.diagnostics.length > 10000) this.diagnostics.splice(0, this.diagnostics.length - 10000)
    fs.appendFile(this.diagnosticsFile, `${JSON.stringify(entry)}\n`, () => {})
    return entry
  }

  assertConnected() {
    if (this.bot.state?.status !== 'connected' || !this.bot.isAlive?.()) throw new Error(`${this.instanceName} must be connected before Hub Roaming can start.`)
  }

  locationName(snapshot = this.bot.state) { return cleanLocation(snapshot?.location?.name) }
  locationReady(snapshot = this.bot.state) {
    const location = snapshot?.location
    return Boolean(location?.known === true && location?.onIsland !== true && isHubLocation(this.locationName(snapshot)))
  }

  enforceHubPresence(snapshot = this.bot.state, reason = 'hub-presence-check') {
    if (!this.state.enabled || this.mentionFailSafeActive || this.locationReady(snapshot)) return true
    const wasMoving = this.routeStarted
    this.awaitingHub = true
    this.routeStarted = false
    this.clearResumeTimer()
    this.clearRouteRefreshTimer()
    this.clearActivityTimer()
    if (wasMoving) {
      try { this.bot.pauseHubRoaming('Hub location is no longer confirmed.') } catch {}
    }
    if (!this.userPaused && this.bot.isAlive?.() && !this.startTeleportTimer) this.scheduleStartHubTeleport(10_000)
    if (this.state.status !== 'WAITING FOR HUB' || this.state.location !== this.locationName(snapshot)) {
      this.lastBehavior = 'Hub confirmation was lost; movement is frozen until Hub is confirmed again.'
      this.update({
        paused: true,
        status: 'WAITING FOR HUB',
        location: this.locationName(snapshot),
        goal: null,
        lastBehavior: this.lastBehavior
      }, reason)
    }
    return false
  }

  claim() {
    this.acquire(this.instanceId)
  }

  setActivityMode(mode) {
    const profile = activityProfile(mode)
    this.activityMode = profile.id
    try {
      fs.mkdirSync(this.root, { recursive: true })
      fs.writeFileSync(this.settingsFile, `${JSON.stringify({ activityMode: profile.id, humanizerVersion: this.humanizerVersion }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log('warning', `[Hub Roaming] Could not save the activity mode: ${error.message || error}`)
    }
    this.clearActivityTimer()
    this.activityPausedBeforeTrade = false
    this.activityDeadlineBeforeTrade = 0
    const canApplyLive = this.state.enabled && !this.userPaused && !this.tradePaused && !this.automationBusy() && this.locationReady()
    if (this.state.enabled) this.pendingRouteRefresh = true
    if (canApplyLive) {
      // roam_start carries the activity-dependent dwell/jump/swing timings.
      // Replacing the current route applies the new profile immediately while
      // also producing a fresh route variation instead of replaying one.
      this.beginRoute('activity-profile-live')
    }
    const appliedAt = new Date().toISOString()
    const snapshot = this.update({
      activityMode: profile.id,
      activityLabel: profile.label,
      activityModeConfirmed: true,
      activityModeAppliedAt: appliedAt,
      activityPaused: this.activityPaused,
      nextActivityAt: this.nextActivityAt ? new Date(this.nextActivityAt).toISOString() : ''
    }, 'activity-profile')
    this.log('info', `[Hub Roaming] Activity mode confirmed for ${this.instanceName}: ${profile.label}.`)
    return snapshot
  }

  setHumanizerVersion(version) {
    const selected = Number(version) === 1 ? 1 : 2
    this.humanizerVersion = selected
    try {
      fs.mkdirSync(this.root, { recursive: true })
      fs.writeFileSync(this.settingsFile, `${JSON.stringify({ activityMode: this.activityMode, humanizerVersion: selected }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log('warning', `[Hub Roaming] Could not save the humanizer version: ${error.message || error}`)
    }
    if (this.state.enabled) this.pendingRouteRefresh = true
    const canApplyLive = this.state.enabled && !this.userPaused && !this.tradePaused && !this.automationBusy() && this.locationReady()
    if (canApplyLive) this.beginRoute('humanizer-version-live')
    return this.update({ humanizerVersion: selected }, 'humanizer-version')
  }

  scheduleActivityTransition(phase = 'walk', { initial = false, delayMs: exactDelayMs = 0 } = {}) {
    this.clearActivityTimer()
    if (!this.state.enabled || this.userPaused || this.tradePaused || !this.routeStarted) return
    const profile = activityProfile(this.activityMode)
    if (initial && randomUnit(this.random) > profile.initialWalkChance) {
      const initialDelay = variedDuration(this.random, 4_000, 18_000)
      this.nextActivityAt = Date.now() + initialDelay
      this.activityTimer = setTimeout(() => this.enterActivityIdle('initial-idle'), initialDelay)
    } else {
      const idle = phase === 'idle'
      const delayMs = exactDelayMs > 0
        ? Math.max(250, Number(exactDelayMs) || 250)
        : idle
          ? variedDuration(this.random, profile.idleMinMs, profile.idleMaxMs)
          : variedDuration(this.random, profile.walkMinMs, profile.walkMaxMs)
      this.nextActivityAt = Date.now() + delayMs
      this.activityTimer = setTimeout(() => idle ? this.leaveActivityIdle('scheduled-walk') : this.enterActivityIdle('scheduled-idle'), delayMs)
    }
    this.activityTimer.unref?.()
    this.update({ nextActivityAt: new Date(this.nextActivityAt).toISOString() }, 'activity-scheduled')
  }

  enterActivityIdle(reason = 'scheduled-idle') {
    this.activityTimer = null
    this.nextActivityAt = 0
    if (!this.state.enabled || this.userPaused || this.tradePaused || this.automationBusy() || !this.routeStarted) {
      if (this.state.enabled && !this.userPaused && !this.tradePaused) this.scheduleActivityTransition('walk')
      return this.snapshot()
    }
    this.activityPaused = true
    try { this.bot.pauseHubRoaming('Random activity rest.') } catch {}
    this.lastBehavior = 'Taking a varied idle break between walks.'
    const snapshot = this.update({
      paused: true,
      activityPaused: true,
      status: 'IDLING',
      lastBehavior: this.lastBehavior
    }, reason)
    this.scheduleActivityTransition('idle')
    return snapshot
  }

  leaveActivityIdle(reason = 'scheduled-walk') {
    this.activityTimer = null
    this.nextActivityAt = 0
    if (!this.state.enabled || this.userPaused || this.tradePaused || this.automationBusy() || !this.locationReady()) return this.snapshot()
    this.activityPaused = false
    try {
      if (this.pendingRouteRefresh) this.beginRoute('activity-lap')
      else if (this.routeStarted) this.bot.resumeHubRoaming()
      else this.beginRoute('activity-start')
    } catch (error) {
      return this.suspend('Movement could not resume after an activity break; roaming remains enabled.', { error: error.message, send: false })
    }
    this.lastBehavior = 'Resumed a varied walking period.'
    const snapshot = this.update({
      paused: false,
      activityPaused: false,
      status: 'ROAMING',
      lastBehavior: this.lastBehavior
    }, reason)
    this.scheduleActivityTransition('walk')
    return snapshot
  }

  teleport() {
    this.assertConnected()
    this.clearResumeTimer()
    this.routeStarted = false
    this.awaitingHub = true
    try {
      this.bot.setHubMode(true)
      this.bot.teleportHub()
    } catch (error) {
      this.awaitingHub = false
      try { this.bot.setHubMode(false, { notifyBridge: false }) } catch {}
      const message = String(error?.message || error)
      if (this.state.enabled) this.suspend('Hub teleport failed; roaming remains enabled and will retry.', { error: message, send: false })
      else this.update({ modeActive: false, paused: false, status: 'ERROR', error: message }, 'error')
      throw error
    }
    this.log('info', '[Hub Roaming] /hub requested; movement stays stopped until a supported Hub location is positively confirmed.')
    return this.update({ modeActive: true, status: 'TELEPORTING', location: this.locationName(), goal: null, currentWaypoint: 0, error: '' }, 'teleport')
  }

  start() {
    this.assertConnected()
    this.recoveryBlocked = false
    this.resumeAfterNextConnection = false
    if (this.state.enabled) return this.restore('explicit-start')
    this.state.enabled = true
    this.userPaused = false
    return this.restore('explicit-start')
  }

  restore(reason = 'automatic-recovery') {
    if (!this.state.enabled) return this.snapshot()
    if (this.recoveryBlocked) return this.snapshot()
    this.assertConnected()
    this.clearRecoveryTimer()
    this.claim()
    try {
      this.state.modeActive = true
      this.state.goal = null
      this.state.currentWaypoint = 0
      this.routeStarted = false
      this.startTradeGuard()
      this.tradePaused = this.automationBusy()
      const needsTeleport = !this.locationReady()
      this.awaitingHub = needsTeleport
      this.bot.setHubMode(true)
      if (needsTeleport) {
        this.scheduleStartHubTeleport()
        this.log('info', '[Hub Roaming] Start accepted on the island; /hub will be sent after the required 10 second delay.')
        return this.update({ enabled: true, modeActive: true, paused: this.tradePaused, status: 'WAITING FOR HUB', location: this.locationName(), error: '' }, 'start')
      }
      return this.beginRoute(reason)
    } catch (error) {
      this.suspend('Hub Roaming could not start yet; automatic recovery is scheduled.', { error: String(error?.message || error), send: false })
      throw error
    }
  }

  beginRoute(reason = 'resume') {
    if (!this.state.enabled) return this.snapshot()
    if (this.userPaused) return this.update({ paused: true, status: 'PAUSED' }, reason)
    if (this.tradePaused) return this.update({ paused: true, status: 'TRADING' }, reason)
    if (!this.locationReady()) return this.update({ paused: true, status: 'WAITING FOR HUB', location: this.locationName() }, reason)
    this.clearResumeTimer()
    this.clearStartTeleportTimer()
    this.clearRouteRefreshTimer()
    this.awaitingHub = false
    this.activityPaused = false
    const profile = activityProfile(this.activityMode)
    const generated = createVariedHubRoute(this.random, this.routeLap + 1, this.routeFingerprintHistory)
    this.activeRoute = generated.route
    this.lastRouteFingerprint = generated.fingerprint
    this.routeFingerprintHistory.add(generated.fingerprint)
    this.activeRouteFamily = generated.family
    this.activeRoutePingPong = generated.pingPong !== false
    this.routeLap += 1
    this.lastBehavior = `Generated safe ${this.activeRouteFamily} variation ${this.routeLap}.`
    this.bot.startHubRoaming(this.activeRoute, {
      profile: this.activeRoutePingPong ? 'safe-varied-humanized-ping-pong' : 'safe-varied-humanized-portal-loop',
      pingPong: this.activeRoutePingPong,
      dwellMinMs: variedDuration(this.random, profile.dwellMinMs, Math.min(profile.dwellMaxMs, profile.dwellMinMs * 1.6)),
      dwellMaxMs: variedDuration(this.random, Math.max(profile.dwellMinMs, profile.dwellMaxMs * 0.72), profile.dwellMaxMs),
      allowMining: false,
      avoidWater: true,
      avoidLadders: true,
      humanizeCamera: true,
      humanizerVersion: this.humanizerVersion,
      jumpMinMs: profile.jumpMinMs,
      jumpMaxMs: profile.jumpMaxMs,
      swingMinMs: profile.swingMinMs,
      swingMaxMs: profile.swingMaxMs
    })
    this.routeStarted = true
    this.pendingRouteRefresh = false
    this.log('success', `[Hub Roaming] ${this.instanceName} started ${this.activeRouteFamily} route ${this.routeLap} with ${this.activeRoute.length} safe targets; Bazaar workflows retain priority.`)
    const snapshot = this.update({
      enabled: true,
      modeActive: true,
      paused: false,
      status: 'ROAMING',
      location: this.locationName(),
      currentWaypoint: 0,
      totalWaypoints: this.activeRoute.length,
      lap: this.routeLap,
      variation: this.lastRouteFingerprint.slice(0, 48),
      routeFamily: this.activeRouteFamily,
      activityMode: profile.id,
      activityLabel: profile.label,
      humanizerVersion: this.humanizerVersion,
      activityPaused: false,
      lastBehavior: this.lastBehavior,
      error: ''
    }, reason)
    if (!this.activityTimer) this.scheduleActivityTransition('walk', { initial: this.routeLap === 1 })
    return snapshot
  }

  pause(reason = 'Paused by user.') {
    if (!this.state.enabled) return this.snapshot()
    this.userPaused = true
    this.clearResumeTimer()
    this.clearStartTeleportTimer()
    this.clearRouteRefreshTimer()
    this.clearActivityTimer()
    this.clearMentionFailSafeTimer()
    this.activityPaused = false
    if (this.routeStarted) this.bot.pauseHubRoaming(reason)
    return this.update({ paused: true, activityPaused: false, status: 'PAUSED', nextActivityAt: '' }, 'pause')
  }

  resume() {
    if (!this.state.enabled) throw new Error('Start Hub Roaming before resuming it.')
    this.assertConnected()
    this.clearResumeTimer()
    this.clearActivityTimer()
    this.userPaused = false
    this.activityPaused = false
    // Explicit Resume also acknowledges that a manually opened Bazaar GUI is
    // no longer in use. Active automatic/manual order workflows still defer it.
    this.manualTradeHold = false
    if (this.automationBusy()) {
      this.tradePaused = true
      return this.update({ paused: true, status: 'TRADING' }, 'resume-deferred')
    }
    if (!this.locationReady()) return this.teleport()
    this.tradePaused = false
    if (this.pendingRouteRefresh) return this.beginRoute('lap-resume')
    if (!this.routeStarted) return this.beginRoute('resume-start')
    try { this.bot.closeHubContainer?.() } catch {}
    this.bot.resumeHubRoaming()
    const snapshot = this.update({ paused: false, activityPaused: false, status: 'ROAMING', location: this.locationName(), error: '' }, 'resume')
    this.scheduleActivityTransition('walk')
    return snapshot
  }

  terminate(reason = 'Stopped.', { error = '', send = true } = {}) {
    const wasActive = this.state.enabled || this.state.modeActive || this.awaitingHub || this.bot.hubModeActive === true
    this.clearResumeTimer()
    this.clearRecoveryTimer()
    this.clearStartTeleportTimer()
    this.clearRouteRefreshTimer()
    this.clearActivityTimer()
    this.stopTradeGuard()
    this.userPaused = false
    this.tradePaused = false
    this.manualTradeHold = false
    this.activityPaused = false
    this.activityPausedBeforeTrade = false
    this.activityDeadlineBeforeTrade = 0
    this.awaitingHub = false
    this.mentionFailSafeActive = false
    this.mentionFailSafeHubRequested = false
    this.routeStarted = false
    this.pendingRouteRefresh = false
    this.recoveryBlocked = false
    this.resumeAfterNextConnection = false
    if (send && this.bot.isAlive?.()) {
      try { this.bot.stopHubRoaming(reason) } catch {}
    }
    try { this.bot.setHubMode(false, { notifyBridge: send && this.bot.isAlive?.() }) } catch {}
    this.release(this.instanceId)
    if (wasActive) this.log(error ? 'error' : 'info', `[Hub Roaming] ${reason}`)
    return this.update({ enabled: false, modeActive: false, paused: false, activityPaused: false, nextActivityAt: '', status: error ? 'ERROR' : 'STOPPED', goal: null, error: String(error || '') }, error ? 'error' : 'stop')
  }

  stop(reason = 'Stopped by user.') { return this.terminate(reason) }

  suspend(reason = 'Temporarily suspended.', { error = '', send = true, retry = true } = {}) {
    const wasActive = this.state.enabled || this.state.modeActive || this.awaitingHub || this.bot.hubModeActive === true
    this.clearResumeTimer()
    this.clearRecoveryTimer()
    this.clearStartTeleportTimer()
    this.clearRouteRefreshTimer()
    this.clearActivityTimer()
    this.stopTradeGuard()
    this.tradePaused = false
    this.manualTradeHold = false
    this.activityPaused = false
    this.activityPausedBeforeTrade = false
    this.activityDeadlineBeforeTrade = 0
    this.awaitingHub = false
    this.mentionFailSafeActive = false
    this.mentionFailSafeHubRequested = false
    this.routeStarted = false
    this.pendingRouteRefresh = true
    this.recoveryBlocked = !retry
    this.resumeAfterNextConnection = false
    if (send && this.bot.isAlive?.()) {
      try { this.bot.stopHubRoaming(reason) } catch {}
    }
    try { this.bot.setHubMode(false, { notifyBridge: send && this.bot.isAlive?.() }) } catch {}
    this.release(this.instanceId)
    if (wasActive) this.log(error ? 'warning' : 'info', `[Hub Roaming] ${reason}`)
    const snapshot = this.update({ enabled: true, modeActive: false, paused: true, activityPaused: false, nextActivityAt: '', status: 'SUSPENDED', goal: null, error: String(error || '') }, error ? 'suspend-error' : 'suspend')
    if (retry) this.scheduleRecovery()
    return snapshot
  }

  scheduleRecovery(delayMs = 15_000) {
    this.clearRecoveryTimer()
    if (!this.state.enabled || this.closed || this.userPaused || this.recoveryBlocked) return false
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      if (!this.state.enabled || this.closed || this.userPaused || this.recoveryBlocked || this.bot.state?.status !== 'connected' || !this.bot.isAlive?.()) return
      try { this.restore('automatic-recovery') }
      catch (error) { this.log('warning', `[Hub Roaming] Automatic recovery is still waiting: ${error.message || error}`) }
    }, Math.max(1000, Number(delayMs) || 15_000))
    this.recoveryTimer.unref?.()
    return true
  }

  clearRecoveryTimer() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }

  automationBusy(state = this.automation.state) {
    return Boolean(
      this.manualTradeHold
      || Number(this.automation.manualControlUntil) > Date.now()
      || (state?.phase && state.phase !== 'idle')
      || this.bot.pendingOrderAction
    )
  }

  yieldToTrade(reason = 'Bazaar workflow has priority.', { manual = false } = {}) {
    if (!this.state.enabled) return this.snapshot()
    if (manual) this.manualTradeHold = true
    if (this.tradePaused) return this.snapshot()
    if (this.bot.needsHubSpawnClearance?.()) {
      this.lastBehavior = 'Moving at least 5 blocks away from Hub spawn before opening Bazaar.'
      return this.update({
        paused: false,
        status: 'CLEARING SPAWN',
        lastBehavior: this.lastBehavior
      }, 'spawn-clearance')
    }
    this.clearResumeTimer()
    this.activityPausedBeforeTrade = this.activityPaused
    this.activityDeadlineBeforeTrade = this.activityPaused ? this.nextActivityAt : 0
    this.clearActivityTimer()
    this.activityPaused = false
    this.tradePaused = true
    if (this.routeStarted) {
      try { this.bot.pauseHubRoaming(reason) } catch {}
    }
    return this.update({ paused: true, activityPaused: false, nextActivityAt: '', status: 'TRADING' }, 'trade-pause')
  }

  onAutomationState(state) {
    if (!this.state.enabled) return
    if (this.automationBusy(state)) {
      this.clearResumeTimer()
      if (!this.tradePaused) {
        this.yieldToTrade('Bazaar workflow has priority.')
      }
      return
    }
    if (!this.tradePaused) return
    this.tradePaused = false
    if (this.userPaused) return this.update({ paused: true, status: 'PAUSED' }, 'trade-finished')
    if (this.activityPausedBeforeTrade) {
      const remainingMs = Math.max(250, this.activityDeadlineBeforeTrade - Date.now())
      this.activityPausedBeforeTrade = false
      this.activityDeadlineBeforeTrade = 0
      this.activityPaused = true
      this.lastBehavior = 'Continuing the same varied idle break after trading.'
      this.scheduleActivityTransition('idle', { delayMs: remainingMs })
      return this.update({
        paused: true,
        activityPaused: true,
        status: 'IDLING',
        lastBehavior: this.lastBehavior
      }, 'trade-finished-idle')
    }
    this.activityPausedBeforeTrade = false
    this.activityDeadlineBeforeTrade = 0
    this.clearResumeTimer()
    const delayMs = 1500 + Math.floor(this.random() * 2500)
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (!this.state.enabled || this.userPaused || this.automationBusy() || !this.locationReady()) return
      try {
        // Bazaar automation may be idle while its last GUI is still open.
        // Azalea deliberately refuses to walk through an open container, so
        // close the completed trading screen before releasing movement.
        try { this.bot.closeHubContainer?.() } catch {}
        if (this.pendingRouteRefresh) {
          this.beginRoute('lap-after-trade')
        } else if (this.routeStarted) {
          this.bot.resumeHubRoaming()
          this.update({ paused: false, status: 'ROAMING' }, 'trade-resume')
        } else this.beginRoute('trade-start')
        this.scheduleActivityTransition('walk')
      }
      catch (error) { this.suspend('Movement could not resume after trading; roaming remains enabled.', { error: error.message, send: false }) }
    }, delayMs)
    this.resumeTimer.unref?.()
    this.update({ paused: true, status: 'RESUMING SOON' }, 'trade-finished')
  }

  onManualActionComplete() {
    if (!this.manualTradeHold) return
    this.manualTradeHold = false
    if (this.state.enabled) this.onAutomationState(this.automation.state)
  }

  onDailyLimit(event = {}) {
    if (!this.state.enabled && !this.state.modeActive && !this.awaitingHub) return
    const reason = String(event.reason || event.message || 'Daily Bazaar limit reached.')
    this.suspend(`Daily limit wait: ${reason}`, { send: true, retry: false })
  }

  onBotState(snapshot) {
    const location = this.locationName(snapshot)
    if (snapshot?.status !== 'connected') {
      if (this.state.enabled || this.state.modeActive || this.awaitingHub) {
        this.suspend('Connection ended; Hub Roaming remains enabled for the next connection.', { send: false, retry: false })
        this.resumeAfterNextConnection = true
      }
      else if (this.state.location !== location) this.update({ location }, 'location')
      return
    }
    if (this.resumeAfterNextConnection) {
      this.recoveryBlocked = false
      this.resumeAfterNextConnection = false
    }
    // World-transfer events deliberately clear the controller location. Do
    // not keep displaying the previous island as if it were current while
    // the new world's scoreboard is still loading.
    if (this.state.location !== location) this.update({ location }, 'location')
    if (this.mentionFailSafeActive) {
      if (snapshot?.location?.onIsland === true && !this.mentionFailSafeHubRequested) {
        this.mentionFailSafeHubRequested = true
        this.clearMentionFailSafeTimer()
        // The server enforces a cooldown between /is and /hub. Keep this
        // delay here as an additional guard even if the controller queues it.
        this.mentionFailSafeTimer = setTimeout(() => {
          this.mentionFailSafeTimer = null
          if (!this.mentionFailSafeActive || !this.bot.isAlive?.()) return
          this.awaitingHub = true
          this.bot.teleportHub()
          this.update({ paused: true, status: 'FAILSAFE: CHANGING HUB', location: this.locationName() }, 'mention-failsafe-hub')
        }, 11_000)
        this.mentionFailSafeTimer.unref?.()
        return this.update({ paused: true, status: 'FAILSAFE: ON ISLAND', location }, 'mention-failsafe-island')
      }
      if (this.locationReady(snapshot) && this.mentionFailSafeHubRequested) {
        this.mentionFailSafeActive = false
        this.mentionFailSafeHubRequested = false
        this.awaitingHub = false
        this.routeStarted = false
        this.clearMentionFailSafeTimer()
        this.lastBehavior = 'Changed Hub after a player mentioned this account.'
        if (this.state.enabled && !this.userPaused && !this.tradePaused) return this.beginRoute('mention-failsafe-complete')
        return this.update({ paused: this.state.enabled, status: this.state.enabled ? 'PAUSED' : 'HUB READY', lastBehavior: this.lastBehavior }, 'mention-failsafe-complete')
      }
      return
    }
    if (!this.locationReady(snapshot)) {
      this.enforceHubPresence(snapshot, 'hub-presence-lost')
      return
    }
    if (this.awaitingHub) {
      this.awaitingHub = false
      this.clearStartTeleportTimer()
      if (this.state.enabled && !this.userPaused && !this.tradePaused) this.beginRoute('hub-confirmed')
      else this.update({ status: this.state.enabled ? (this.userPaused ? 'PAUSED' : 'TRADING') : 'HUB READY', paused: this.state.enabled }, 'hub-confirmed')
    }
  }

  onMovementState(event = {}) {
    const position = finitePoint(event.position) || finitePoint(event)
    const goal = finitePoint(event.goal)
    const numberIfPresent = value => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null)
    const directCurrent = numberIfPresent(event.currentWaypoint)
    const indexedCurrent = numberIfPresent(event.waypointIndex)
    const directTotal = numberIfPresent(event.totalWaypoints)
    const countedTotal = numberIfPresent(event.waypointCount)
    // The bridge exposes both currentWaypoint and waypointIndex as zero-based
    // route indexes. The public/UI snapshot uses a human-readable 1..N count.
    const routeIndex = directCurrent ?? indexedCurrent
    const patch = {
      currentWaypoint: routeIndex === null ? this.state.currentWaypoint : routeIndex + 1,
      totalWaypoints: directTotal ?? countedTotal ?? this.state.totalWaypoints
    }
    // Optional telemetry fields must not erase the last valid coordinates.
    if (position) patch.position = position
    if (goal) patch.goal = goal
    else if (Object.prototype.hasOwnProperty.call(event, 'goal') && event.goal === null) patch.goal = null
    const location = cleanLocation(event.location) || this.locationName()
    if (location) patch.location = location
    if (event.godPotion && typeof event.godPotion === 'object') patch.godPotion = { ...event.godPotion }
    if ([1, 2].includes(Number(event.humanizerVersion))) patch.humanizerVersion = Number(event.humanizerVersion)
    if (this.state.enabled && this.routeStarted && !this.userPaused && !this.tradePaused && !this.activityPaused && /^(?:pathfinding|walking|dwelling|roaming|turning|rerouting|retrying)$/i.test(String(event.status || ''))) patch.status = 'ROAMING'
    else if (this.state.enabled && !this.tradePaused && String(event.status || '').toLowerCase() === 'container_open') patch.status = 'CLOSING MENU'
    this.update(patch, 'movement')
  }

  onPathResult(event = {}) {
    this.record('path-result', event)
    const result = String(event.result || event.status || '').toLowerCase()
    if (result === 'world_changed') {
      this.routeStarted = false
      if (this.awaitingHub || this.mentionFailSafeActive) return this.update({ status: this.mentionFailSafeActive ? 'FAILSAFE: CHANGING HUB' : 'WAITING FOR HUB', paused: true }, 'world-change')
      return this.suspend('The world changed unexpectedly; Hub Roaming remains enabled.', { error: event.reason || 'Unexpected world change.', send: false })
    }
    if (['no_path', 'stuck', 'timeout', 'error'].includes(result)) {
      return this.suspend('The Hub route could not continue safely; a new route will be attempted.', { error: event.reason || result.replace('_', ' '), send: true })
    }
    if (result === 'reached') {
      const index = Number(event.waypointIndex ?? event.currentWaypoint)
      if (Number.isInteger(index) && index >= 0 && index < this.activeRoute.length) {
        const target = this.activeRoute[index]
        if (target?.behavior === 'bazaar-npc') this.requestAmbientBazaar('npc', index)
        else if (target?.behavior === 'ambient-bazaar') this.requestAmbientBazaar('command', index)
        const routeBoundaryReached = this.activeRoutePingPong
          ? (index === 0 || index === this.activeRoute.length - 1)
          : index === this.activeRoute.length - 1
        if (routeBoundaryReached) this.scheduleRouteRefresh()
      }
    }
    return this.snapshot()
  }

  requestAmbientBazaar(kind, waypointIndex) {
    const now = Date.now()
    const profile = activityProfile(this.activityMode)
    if (!this.state.enabled || this.userPaused || this.tradePaused || this.activityPaused || this.automationBusy()) return false
    if (profile.id === 'no-bazaar') return false
    if (now < this.nextAmbientBazaarAt || typeof this.automation.requestHubSync !== 'function') return false
    const chance = kind === 'npc' ? profile.bazaarNpcChance : profile.bazaarCommandChance
    if (randomUnit(this.random) > chance) return false
    const cooldownMs = variedDuration(this.random, profile.bazaarCooldownMinMs, profile.bazaarCooldownMaxMs)
    const reason = kind === 'npc' ? 'near-NPC /bz route stop' : 'between-waypoint /bz stop'
    const options = { reason }
    const accepted = this.automation.requestHubSync(options)
    if (!accepted) return false
    this.nextAmbientBazaarAt = now + cooldownMs
    this.lastBehavior = kind === 'npc' ? 'Stopping near the Bazaar NPC and opening with /bz.' : 'Stopping between route points for /bz.'
    this.update({ lastBehavior: this.lastBehavior }, 'bazaar-command-request')
    this.record('behavior', { behavior: kind, waypointIndex, cooldownMs })
    return true
  }

  scheduleRouteRefresh() {
    if (!this.state.enabled || this.userPaused || this.routeRefreshTimer) return
    const delayMs = 2200 + Math.floor(randomUnit(this.random) * 2800)
    this.routeRefreshTimer = setTimeout(() => {
      this.routeRefreshTimer = null
      if (!this.state.enabled || this.userPaused || !this.locationReady()) return
      if (this.automationBusy() || this.tradePaused || this.activityPaused) {
        this.pendingRouteRefresh = true
        return
      }
      try { this.beginRoute('new-lap') }
      catch (error) { this.suspend('The next varied route could not start; roaming remains enabled.', { error: error.message, send: false }) }
    }, delayMs)
    this.routeRefreshTimer.unref?.()
  }

  onWorldSpawn(event = {}) {
    this.record('world-spawn', event)
    if (!this.state.enabled) return
    this.routeStarted = false
    if (this.awaitingHub || this.mentionFailSafeActive) return this.update({ paused: true, status: this.mentionFailSafeActive ? 'FAILSAFE: CHANGING HUB' : 'WAITING FOR HUB', location: '' }, 'world-spawn')
    this.suspend('The server changed worlds while roaming; roaming remains enabled.', { error: 'Unexpected world change.', send: false })
  }

  clearResumeTimer() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
  }

  scheduleStartHubTeleport(delayMs = 10_000) {
    this.clearStartTeleportTimer()
    this.startTeleportTimer = setTimeout(() => this.sendStartHubTeleport(), Math.max(0, Number(delayMs) || 0))
    this.startTeleportTimer.unref?.()
  }

  sendStartHubTeleport() {
    this.clearStartTeleportTimer()
    if (!this.state.enabled || this.userPaused || !this.awaitingHub || !this.bot.isAlive?.()) return false
    if (this.locationReady()) {
      this.awaitingHub = false
      if (!this.tradePaused) this.beginRoute('hub-ready-before-delayed-command')
      return true
    }
    this.bot.teleportHub()
    this.log('info', '[Hub Roaming] Sent delayed /hub 10 seconds after Start Roaming.')
    this.update({ paused: this.tradePaused, status: 'WAITING FOR HUB', location: this.locationName(), error: '' }, 'delayed-hub-command')
    return true
  }

  clearStartTeleportTimer() {
    if (this.startTeleportTimer) clearTimeout(this.startTeleportTimer)
    this.startTeleportTimer = null
  }

  clearRouteRefreshTimer() {
    if (this.routeRefreshTimer) clearTimeout(this.routeRefreshTimer)
    this.routeRefreshTimer = null
  }

  clearActivityTimer() {
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = null
    this.nextActivityAt = 0
  }

  clearMentionFailSafeTimer() {
    if (this.mentionFailSafeTimer) clearTimeout(this.mentionFailSafeTimer)
    this.mentionFailSafeTimer = null
  }

  onChat(event = {}) {
    if (!this.state.enabled || this.mentionFailSafeActive || this.userPaused || !this.locationReady()) return
    if (!mentionsUsernameInPlayerChat(event, this.bot.state?.username)) return
    const now = Date.now()
    if (now < this.mentionFailSafeUntil) return
    this.mentionFailSafeUntil = now + 120_000
    this.mentionFailSafeActive = true
    this.mentionFailSafeHubRequested = false
    this.awaitingHub = true
    this.routeStarted = false
    this.clearActivityTimer()
    try { this.bot.pauseHubRoaming('Player-name mention failsafe.') } catch {}
    try { this.bot.setHubMode(false) } catch {}
    try { this.bot.sendChat('/is') } catch (error) {
      this.mentionFailSafeActive = false
      this.awaitingHub = false
      return this.update({ status: 'ROAMING', paused: false, error: String(error?.message || error) }, 'mention-failsafe-error')
    }
    this.lastBehavior = 'Player-name mention detected; moving to the island before changing Hub.'
    this.record('mention-failsafe', { sender: event.sender, content: String(event.content || event.text || '').slice(0, 240) })
    this.update({ paused: true, status: 'FAILSAFE: GOING TO ISLAND', lastBehavior: this.lastBehavior, error: '' }, 'mention-failsafe')
  }

  startTradeGuard() {
    if (this.guardTimer) return
    this.guardTimer = setInterval(() => {
      if (!this.state.enabled) return
      if (!this.enforceHubPresence(this.bot.state, 'hub-presence-guard')) return
      const busy = this.automationBusy()
      if (busy && !this.tradePaused) this.yieldToTrade('Bazaar workflow has priority.')
      else if (!busy && this.tradePaused) this.onAutomationState(this.automation.state)
    }, 250)
    this.guardTimer.unref?.()
  }
  stopTradeGuard() {
    if (this.guardTimer) clearInterval(this.guardTimer)
    this.guardTimer = null
  }

  diagnosticsReport(appVersion = '') {
    return JSON.stringify({
      format: 'xyz-flipper-hub-diagnostics',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: String(appVersion || ''),
      instance: { id: this.instanceId, name: this.instanceName },
      state: this.snapshot(),
      route: this.activeRoute,
      baseRoute: HUB_ROUTE,
      baseRoutes: { bazaarSpur: HUB_ROUTE, portalLoop: HUB_PORTAL_LOOP },
      routeFamily: this.activeRouteFamily,
      routeVariationsUsed: this.routeFingerprintHistory.size,
      bazaarInteractionZone: BAZAAR_INTERACTION_ZONE,
      activityProfile: activityProfile(this.activityMode),
      humanizerVersion: this.humanizerVersion,
      safety: { pingPong: this.activeRoutePingPong, circularPortalLoop: true, variedRoute: true, randomizedWalkAndIdlePeriods: true, allowMining: false, avoidWater: true, avoidLadders: true, tradeHasPriority: true, ambientBazaarEnabled: this.activityMode !== 'no-bazaar', npcRequiresRaycast: true, npcFallbackCommand: '/bz' },
      events: this.diagnostics.slice(-10000)
    }, null, 2)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.terminate('Hub Roaming closed.', { send: this.bot.isAlive?.() })
    this.bot.off('state', this.onBotStateBound)
    this.bot.off('movement-state', this.onMovementStateBound)
    this.bot.off('path-result', this.onPathResultBound)
    this.bot.off('world-spawn', this.onWorldSpawnBound)
    this.bot.off('daily-limit', this.onDailyLimitBound)
    this.bot.off('manual-order-action-complete', this.onManualActionCompleteBound)
    this.bot.off('chat', this.onChatBound)
    this.automation.off('state', this.onAutomationStateBound)
    this.automation.setHubBazaarOpener?.(null)
  }
}

module.exports = {
  ACTIVITY_PROFILES,
  HUB_ROUTE,
  HUB_PORTAL_LOOP,
  BAZAAR_APPROACH_POINTS,
  BAZAAR_INTERACTION_ZONE,
  HubRoaming,
  activityProfile,
  cleanLocation,
  createVariedHubRoute,
  createVariedPortalLoop,
  mentionsUsernameInPlayerChat,
  isHubLocation,
  routeFingerprint,
  variedDuration,
  variedPointOnSegment
}
