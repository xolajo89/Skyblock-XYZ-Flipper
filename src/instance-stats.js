'use strict'

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback

function normalizedInstanceStatus(bot = {}, automation = {}) {
  if (bot.status !== 'connected') return 'DISCONNECTED'
  return automation.enabled === true && automation.phase && automation.phase !== 'idle' ? 'ACTIVE' : 'IDLE'
}

function compactInstanceStats(context) {
  // Runtime summaries are emitted very frequently. Reading the live state is
  // enough for these four numbers and avoids cloning the complete 2,000-point
  // tracker history for every instance on every GUI action.
  const bot = context?.bot?.state || context?.bot?.snapshot?.() || {}
  const automation = context?.automation?.state || context?.automation?.snapshot?.() || {}
  const tracker = automation.tracker || {}
  const stash = automation.stash || {
    blocked: context?.automation?.stashBlocked === true,
    itemCount: context?.automation?.stashCountConfirmed ? context?.automation?.stashItemCount : null,
    status: context?.automation?.stashBlocked ? context?.automation?.stashStatus?.() : ''
  }
  const eta = Number(tracker.estimatedSecondsToLimit)
  return {
    status: normalizedInstanceStatus(bot, automation),
    coinsPerHour: finite(tracker.profitPerHour),
    profit: finite(tracker.profit),
    uptimeSeconds: Math.max(0, finite(tracker.uptimeSeconds ?? tracker.runningSeconds)),
    uptimeActive: tracker.uptimeActive === true && bot.status === 'connected',
    totalLimit: Math.max(0, finite(tracker.dailyLimitUsed)),
    limitPerHour: Math.max(0, finite(tracker.limitRatePerHour)),
    estimatedSecondsToLimit: Number.isFinite(eta) ? Math.max(0, eta) : null,
    stashBlocked: stash.blocked === true,
    stashItemCount: Number.isFinite(Number(stash.itemCount)) ? Math.max(0, Math.floor(Number(stash.itemCount))) : null,
    stashStatus: String(stash.status || ''),
    observedAt: Date.now()
  }
}

module.exports = { normalizedInstanceStatus, compactInstanceStats }
