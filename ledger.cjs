'use strict';

const fs = require('node:fs');
const {
  normalizeEmail,
  localDayKey,
  toEpochMs,
  normalizeDate,
  writeJsonAtomic
} = require('./accounts.cjs');

const DEFAULT_LEDGER_FILENAME = 'antigravity-account-ledger.json';
const LEDGER_VERSION = 2;
const DEFAULT_HEARTBEAT_GAP_MS = 10 * 60 * 1000;
const SAME_ACCOUNT_CONTINUITY_GAP_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_PERSIST_INTERVAL_MS = 60 * 1000;

function toNonNegNum(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundUsd(val) {
  return Number(toNonNegNum(val).toFixed(6));
}

function emptyModelMetrics() {
  return { tokens: 0, costUsd: 0, unpricedTokens: 0 };
}

function emptyUsageBucket() {
  return {
    totalTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    models: {}
  };
}

function emptyAccountBucket(email, displayName = '') {
  return {
    email,
    displayName: displayName || (email === 'unattributed' ? '历史汇总（未归属）' : email),
    ...emptyUsageBucket(),
    percentageOfTotal: 0
  };
}

function cloneUsage(u) {
  if (!u || typeof u !== 'object') return emptyUsageBucket();
  const models = {};
  for (const [modelId, m] of Object.entries(u.models || {})) {
    if (!modelId || !m || typeof m !== 'object') continue;
    models[modelId] = {
      tokens: toNonNegNum(m.tokens ?? m.totalTokens),
      costUsd: roundUsd(m.costUsd ?? m.cost ?? m.knownUsd),
      unpricedTokens: toNonNegNum(m.unpricedTokens)
    };
  }
  return {
    totalTokens: toNonNegNum(u.totalTokens ?? u.tokens),
    costUsd: roundUsd(u.costUsd ?? u.cost ?? u.knownUsd),
    unpricedTokens: toNonNegNum(u.unpricedTokens),
    inputTokens: toNonNegNum(u.inputTokens),
    outputTokens: toNonNegNum(u.outputTokens),
    cacheReadTokens: toNonNegNum(u.cacheReadTokens),
    cacheWriteTokens: toNonNegNum(u.cacheWriteTokens),
    reasoningTokens: toNonNegNum(u.reasoningTokens),
    models
  };
}

function addUsageToBucket(bucket, usage) {
  if (!usage || typeof usage !== 'object') return;
  bucket.totalTokens += toNonNegNum(usage.totalTokens ?? usage.tokens);
  bucket.costUsd += toNonNegNum(usage.costUsd ?? usage.cost ?? usage.knownUsd);
  bucket.unpricedTokens = toNonNegNum(bucket.unpricedTokens) + toNonNegNum(usage.unpricedTokens);
  bucket.inputTokens += toNonNegNum(usage.inputTokens);
  bucket.outputTokens += toNonNegNum(usage.outputTokens);
  bucket.cacheReadTokens += toNonNegNum(usage.cacheReadTokens);
  bucket.cacheWriteTokens += toNonNegNum(usage.cacheWriteTokens);
  bucket.reasoningTokens += toNonNegNum(usage.reasoningTokens);
  if (!bucket.models) bucket.models = {};
  for (const [modelId, m] of Object.entries(usage.models || {})) {
    if (!modelId || !m || typeof m !== 'object') continue;
    if (!bucket.models[modelId]) bucket.models[modelId] = emptyModelMetrics();
    const target = bucket.models[modelId];
    target.tokens += toNonNegNum(m.tokens ?? m.totalTokens);
    target.costUsd += toNonNegNum(m.costUsd ?? m.cost ?? m.knownUsd);
    target.unpricedTokens = toNonNegNum(target.unpricedTokens) + toNonNegNum(m.unpricedTokens);
  }
}

function subtractUsage(next, prev) {
  const n = cloneUsage(next);
  const p = cloneUsage(prev);
  const res = {
    totalTokens: Math.max(0, n.totalTokens - p.totalTokens),
    costUsd: roundUsd(Math.max(0, n.costUsd - p.costUsd)),
    unpricedTokens: Math.max(0, n.unpricedTokens - p.unpricedTokens),
    inputTokens: Math.max(0, n.inputTokens - p.inputTokens),
    outputTokens: Math.max(0, n.outputTokens - p.outputTokens),
    cacheReadTokens: Math.max(0, n.cacheReadTokens - p.cacheReadTokens),
    cacheWriteTokens: Math.max(0, n.cacheWriteTokens - p.cacheWriteTokens),
    reasoningTokens: Math.max(0, n.reasoningTokens - p.reasoningTokens),
    models: {}
  };
  for (const [modelId, nm] of Object.entries(n.models)) {
    const pm = p.models[modelId] || emptyModelMetrics();
    const tokens = Math.max(0, nm.tokens - pm.tokens);
    const costUsd = roundUsd(Math.max(0, nm.costUsd - pm.costUsd));
    const unpricedTokens = Math.max(0, nm.unpricedTokens - pm.unpricedTokens);
    if (tokens > 0 || costUsd > 0 || unpricedTokens > 0) {
      res.models[modelId] = { tokens, costUsd, unpricedTokens };
    }
  }
  return res;
}

function mergeHighWater(prev, next) {
  const p = cloneUsage(prev);
  const n = cloneUsage(next);
  const models = {};
  const allModelIds = new Set([...Object.keys(p.models), ...Object.keys(n.models)]);
  for (const modelId of allModelIds) {
    const pm = p.models[modelId] || emptyModelMetrics();
    const nm = n.models[modelId] || emptyModelMetrics();
    const tokens = Math.max(pm.tokens, nm.tokens);
    const costUsd = roundUsd(Math.max(pm.costUsd, nm.costUsd));
    // If host re-priced a previously unpriced model while total tokens did not regress,
    // adopt the lower unpricedTokens count so stale '?' indicators clear.
    const unpricedTokens = nm.tokens >= pm.tokens ? nm.unpricedTokens : pm.unpricedTokens;
    if (tokens > 0 || costUsd > 0 || unpricedTokens > 0) {
      models[modelId] = { tokens, costUsd, unpricedTokens };
    }
  }
  return {
    totalTokens: Math.max(p.totalTokens, n.totalTokens),
    costUsd: roundUsd(Math.max(p.costUsd, n.costUsd)),
    unpricedTokens: n.totalTokens >= p.totalTokens ? n.unpricedTokens : p.unpricedTokens,
    inputTokens: Math.max(p.inputTokens, n.inputTokens),
    outputTokens: Math.max(p.outputTokens, n.outputTokens),
    cacheReadTokens: Math.max(p.cacheReadTokens, n.cacheReadTokens),
    cacheWriteTokens: Math.max(p.cacheWriteTokens, n.cacheWriteTokens),
    reasoningTokens: Math.max(p.reasoningTokens, n.reasoningTokens),
    models
  };
}

function reconcileUnpricedReduction(allocations, nextSnapshot) {
  if (!allocations || typeof allocations !== 'object' || !nextSnapshot) return false;
  let changed = false;
  const targetTotal = toNonNegNum(nextSnapshot.unpricedTokens);
  let curTotal = 0;
  for (const bucket of Object.values(allocations)) {
    curTotal += toNonNegNum(bucket?.unpricedTokens);
  }
  if (curTotal > targetTotal) {
    const ratio = targetTotal === 0 ? 0 : targetTotal / curTotal;
    for (const bucket of Object.values(allocations)) {
      if (!bucket) continue;
      const nextVal = targetTotal === 0 ? 0 : Math.round(toNonNegNum(bucket.unpricedTokens) * ratio);
      if (bucket.unpricedTokens !== nextVal) {
        bucket.unpricedTokens = nextVal;
        changed = true;
      }
    }
  }
  for (const [modelId, nm] of Object.entries(nextSnapshot.models || {})) {
    const modelTarget = toNonNegNum(nm?.unpricedTokens);
    let modelCur = 0;
    for (const bucket of Object.values(allocations)) {
      modelCur += toNonNegNum(bucket?.models?.[modelId]?.unpricedTokens);
    }
    if (modelCur > modelTarget) {
      const ratio = modelTarget === 0 ? 0 : modelTarget / modelCur;
      for (const bucket of Object.values(allocations)) {
        const bm = bucket?.models?.[modelId];
        if (!bm) continue;
        const nextVal = modelTarget === 0 ? 0 : Math.round(toNonNegNum(bm.unpricedTokens) * ratio);
        if (bm.unpricedTokens !== nextVal) {
          bm.unpricedTokens = nextVal;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function createDefaultLedger(activatedAt = new Date().toISOString()) {
  return {
    version: LEDGER_VERSION,
    featureActivatedAt: activatedAt,
    lastActiveAccount: null,
    lastObservedAt: null,
    timeline: [],
    daily: {}
  };
}

function normalizeDailyEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allocations = {};
  if (raw.allocations && typeof raw.allocations === 'object' && !Array.isArray(raw.allocations)) {
    for (const [email, bucket] of Object.entries(raw.allocations)) {
      const norm = email === 'unattributed' ? 'unattributed' : normalizeEmail(email);
      if (!norm || !bucket || typeof bucket !== 'object') continue;
      allocations[norm] = cloneUsage(bucket);
    }
  }
  return {
    lastObservedAt: typeof raw.lastObservedAt === 'string' ? raw.lastObservedAt : null,
    lastSnapshot: cloneUsage(raw.lastSnapshot),
    allocations
  };
}

function normalizeLedger(loaded) {
  const daily = {};
  if (loaded?.daily && typeof loaded.daily === 'object' && !Array.isArray(loaded.daily)) {
    for (const [dayKey, entry] of Object.entries(loaded.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
      const norm = normalizeDailyEntry(entry);
      if (norm) daily[dayKey] = norm;
    }
  }
  // Migrate v1 timeline cleanly: close any unclosed legacy intervals lacking lastSeenAt
  // so stale v1 intervals never stretch across offline gaps after upgrading.
  const timeline = [];
  if (Array.isArray(loaded?.timeline)) {
    for (const item of loaded.timeline) {
      if (!item || typeof item !== 'object') continue;
      const email = normalizeEmail(item.email);
      if (!email || !item.startedAt) continue;
      const hasLastSeen = Boolean(item.lastSeenAt);
      timeline.push({
        email,
        startedAt: item.startedAt,
        lastSeenAt: item.lastSeenAt || item.endedAt || item.startedAt,
        endedAt: item.endedAt || (loaded?.version === 1 && !hasLastSeen ? item.startedAt : null),
        source: item.source || 'heartbeat'
      });
    }
  }
  return {
    version: LEDGER_VERSION,
    featureActivatedAt: loaded?.featureActivatedAt || new Date().toISOString(),
    lastActiveAccount: loaded?.lastActiveAccount ? normalizeEmail(loaded.lastActiveAccount) : null,
    lastObservedAt: typeof loaded?.lastObservedAt === 'string' ? loaded.lastObservedAt : null,
    timeline,
    daily
  };
}

function isLedgerStructureValid(loaded) {
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return false;
  if (loaded.version !== undefined && loaded.version !== 1 && loaded.version !== 2) return false;
  if (loaded.timeline !== undefined && !Array.isArray(loaded.timeline)) return false;
  if (loaded.daily !== undefined && (!loaded.daily || typeof loaded.daily !== 'object' || Array.isArray(loaded.daily))) return false;
  if (loaded.sessionAccounts !== undefined && (!loaded.sessionAccounts || typeof loaded.sessionAccounts !== 'object' || Array.isArray(loaded.sessionAccounts))) return false;
  return loaded.version !== undefined
    || loaded.featureActivatedAt !== undefined
    || loaded.timeline !== undefined
    || loaded.daily !== undefined
    || loaded.sessionAccounts !== undefined
    || loaded.lastActiveAccount !== undefined;
}

function loadLedger(ledgerFile) {
  if (!ledgerFile) return createDefaultLedger();
  if (fs.existsSync(ledgerFile)) {
    let corrupt = false;
    try {
      const loaded = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      if (isLedgerStructureValid(loaded)) return normalizeLedger(loaded);
      corrupt = true;
    } catch (_) {
      corrupt = true;
    }
    if (corrupt) {
      const backupFile = `${ledgerFile}.corrupt-${Date.now()}`;
      try { fs.renameSync(ledgerFile, backupFile); } catch (_) {}
    }
  }
  const defaultLedger = createDefaultLedger();
  try { writeJsonAtomic(ledgerFile, defaultLedger); } catch (_) {}
  return defaultLedger;
}

function saveLedger(ledger, ledgerFile) {
  const normalized = normalizeLedger(ledger);
  if (ledgerFile && typeof ledgerFile === 'string') {
    writeJsonAtomic(ledgerFile, normalized);
  }
  return true;
}

function recordAccountHeartbeat(activeAccount, timestamp, ledger, ledgerFile, options = {}) {
  const email = normalizeEmail(typeof activeAccount === 'string' ? activeAccount : activeAccount?.email);
  if (!email) return { changed: false, ledger };
  const source = (typeof activeAccount === 'object' && activeAccount?.source) || 'heartbeat';
  const date = timestamp ? new Date(timestamp) : new Date();
  const ts = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const tsMs = toEpochMs(ts);
  const maxGapMs = Number.isFinite(options?.maxGapMs) && options.maxGapMs > 0 ? options.maxGapMs : DEFAULT_HEARTBEAT_GAP_MS;
  const persistIntervalMs = Number.isFinite(options?.persistIntervalMs) && options.persistIntervalMs >= 0
    ? options.persistIntervalMs : HEARTBEAT_PERSIST_INTERVAL_MS;

  let changed = false;
  if (!Array.isArray(ledger.timeline)) ledger.timeline = [];
  const lastInterval = ledger.timeline[ledger.timeline.length - 1];
  if (!lastInterval) {
    ledger.timeline.push({ email, startedAt: ts, lastSeenAt: ts, endedAt: null, source });
    ledger.lastActiveAccount = email;
    changed = true;
  } else {
    const prevAnchorIso = lastInterval.lastSeenAt || lastInterval.endedAt || lastInterval.startedAt;
    const prevAnchorMs = toEpochMs(prevAnchorIso);
    const isGap = Boolean(prevAnchorMs > 0 && tsMs > prevAnchorMs && (tsMs - prevAnchorMs) > maxGapMs);
    if (lastInterval.email !== email) {
      if (!lastInterval.endedAt) {
        lastInterval.endedAt = isGap ? prevAnchorIso : ts;
      } else if (!isGap && toEpochMs(lastInterval.endedAt) < tsMs) {
        lastInterval.endedAt = ts;
      }
      ledger.timeline.push({ email, startedAt: ts, lastSeenAt: ts, endedAt: null, source });
      ledger.lastActiveAccount = email;
      changed = true;
    } else {
      ledger.lastActiveAccount = email;
      if (lastInterval.endedAt && tsMs > toEpochMs(lastInterval.endedAt)) {
        ledger.timeline.push({ email, startedAt: ts, lastSeenAt: ts, endedAt: null, source });
        changed = true;
      } else if (!lastInterval.endedAt && isGap) {
        lastInterval.endedAt = prevAnchorIso;
        ledger.timeline.push({ email, startedAt: ts, lastSeenAt: ts, endedAt: null, source });
        changed = true;
      } else if (!lastInterval.endedAt) {
        const lastPersistedMs = toEpochMs(lastInterval.lastSeenAt || 0);
        if (!lastInterval.lastSeenAt || (tsMs - lastPersistedMs) >= persistIntervalMs) {
          lastInterval.lastSeenAt = ts;
          changed = true;
        }
      }
    }
  }
  if (changed && ledgerFile) saveLedger(ledger, ledgerFile);
  return { changed, ledger };
}

function syncTodaySnapshot(todayKey, rawSnapshot, activeAccount, ledger, options = {}) {
  if (!todayKey || !/^\d{4}-\d{2}-\d{2}$/.test(todayKey) || !rawSnapshot || !ledger) {
    return { changed: false, ledger };
  }
  if (!ledger.daily || typeof ledger.daily !== 'object') ledger.daily = {};
  const snapshot = cloneUsage(rawSnapshot);
  const activeEmail = normalizeEmail(typeof activeAccount === 'string' ? activeAccount : activeAccount?.email);
  const nowDate = options.now ? new Date(options.now) : new Date();
  const nowIso = Number.isNaN(nowDate.getTime()) ? new Date().toISOString() : nowDate.toISOString();
  const nowMs = toEpochMs(nowIso);
  const maxGapMs = Number.isFinite(options.maxGapMs) && options.maxGapMs > 0 ? options.maxGapMs : DEFAULT_HEARTBEAT_GAP_MS;
  const persistIntervalMs = Number.isFinite(options.persistIntervalMs) && options.persistIntervalMs >= 0
    ? options.persistIntervalMs : HEARTBEAT_PERSIST_INTERVAL_MS;

  let changed = false;
  const existing = ledger.daily[todayKey];
  if (!existing) {
    const prevObservedMs = toEpochMs(ledger.lastObservedAt);
    const hasContinuousObservation = Boolean(prevObservedMs > 0 && nowMs >= prevObservedMs && (nowMs - prevObservedMs) <= maxGapMs);
    const allocations = {};
    if (snapshot.totalTokens > 0 || snapshot.costUsd > 0) {
      // Pre-install usage or usage accumulated while Token Monitor was closed goes honestly
      // to 'unattributed'. Continuous observation across midnight attributes directly to activeEmail.
      const targetEmail = (hasContinuousObservation && activeEmail) ? activeEmail : 'unattributed';
      allocations[targetEmail] = cloneUsage(snapshot);
    }
    ledger.daily[todayKey] = {
      lastObservedAt: nowIso,
      lastSnapshot: cloneUsage(snapshot),
      allocations
    };
    ledger.lastObservedAt = nowIso;
    changed = true;
  } else {
    const prevObservedMs = toEpochMs(existing.lastObservedAt || ledger.lastObservedAt);
    const gapMs = prevObservedMs > 0 && nowMs >= prevObservedMs ? (nowMs - prevObservedMs) : Infinity;
    const prevAccountEmail = normalizeEmail(options.previousActiveAccount || ledger.lastActiveAccount);
    const sameAccountContinuityGapMs = Number.isFinite(options.sameAccountContinuityGapMs) && options.sameAccountContinuityGapMs >= 0
      ? options.sameAccountContinuityGapMs
      : SAME_ACCOUNT_CONTINUITY_GAP_MS;
    const otherAccountUsedDuringGap = Array.isArray(options.discoveredAccounts)
      && options.discoveredAccounts.some((acc) => {
        const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
        if (!email || email === activeEmail) return false;
        const usedMs = toEpochMs(acc?.lastUsed ?? acc?.last_used ?? 0);
        return usedMs > prevObservedMs && usedMs <= nowMs;
      });
    const isSameAccountShortPause = Boolean(
      activeEmail && prevAccountEmail && activeEmail === prevAccountEmail
      && gapMs <= sameAccountContinuityGapMs && !otherAccountUsedDuringGap
    );
    const isContinuous = Boolean((gapMs <= maxGapMs) || isSameAccountShortPause);
    const delta = subtractUsage(snapshot, existing.lastSnapshot);
    const hasDelta = delta.totalTokens > 0 || delta.costUsd > 0 || Object.keys(delta.models).length > 0;
    if (hasDelta) {
      const targetEmail = (isContinuous && activeEmail) ? activeEmail : 'unattributed';
      if (!existing.allocations[targetEmail]) existing.allocations[targetEmail] = emptyUsageBucket();
      addUsageToBucket(existing.allocations[targetEmail], delta);
      existing.lastSnapshot = mergeHighWater(existing.lastSnapshot, snapshot);
      existing.lastObservedAt = nowIso;
      ledger.lastObservedAt = nowIso;
      changed = true;
    }
    if (reconcileUnpricedReduction(existing.allocations, snapshot)) {
      existing.lastSnapshot = mergeHighWater(existing.lastSnapshot, snapshot);
      changed = true;
    }
    if (!changed && (!prevObservedMs || (nowMs - prevObservedMs) >= persistIntervalMs)) {
      existing.lastObservedAt = nowIso;
      ledger.lastObservedAt = nowIso;
      changed = true;
    }
  }
  if (changed && options.save !== false && typeof options.ledgerFile === 'string') {
    saveLedger(ledger, options.ledgerFile);
  }
  return { changed, ledger };
}

function aggregateAccountUsage(args = {}, options = {}) {
  const {
    hostHistoryByDay = {},
    range = null,
    accountFilter = 'all',
    discoveredAccounts = []
  } = args;
  const ledger = args.ledger || options.ledger || createDefaultLedger();
  const filter = normalizeEmail(accountFilter) || 'all';
  const normalizeValidDay = (raw) => {
    const d = normalizeDate(raw);
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };
  let startDay = range?.start ? normalizeValidDay(range.start) : null;
  let endDay = range?.end ? normalizeValidDay(range.end) : null;
  if (startDay && endDay && startDay > endDay) {
    const tmp = startDay; startDay = endDay; endDay = tmp;
  }

  const byAccount = {};
  function getOrCreateAccount(email, displayName = '') {
    const norm = email === 'unattributed' ? 'unattributed' : normalizeEmail(email);
    if (!norm) return emptyAccountBucket('unattributed');
    if (!byAccount[norm]) {
      byAccount[norm] = emptyAccountBucket(norm, displayName);
    } else if (displayName && displayName !== norm && (!byAccount[norm].displayName || byAccount[norm].displayName === norm)) {
      byAccount[norm].displayName = displayName;
    }
    return byAccount[norm];
  }

  for (const acc of Array.isArray(discoveredAccounts) ? discoveredAccounts : []) {
    const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
    if (!email) continue;
    const displayName = (typeof acc === 'object' && (acc.displayName || acc.name)) || email;
    getOrCreateAccount(email, displayName);
  }

  const dailyLedger = ledger?.daily && typeof ledger.daily === 'object' ? ledger.daily : {};
  const historyDays = hostHistoryByDay && typeof hostHistoryByDay === 'object' ? hostHistoryByDay : {};
  const allDays = new Set([...Object.keys(dailyLedger), ...Object.keys(historyDays)]);

  for (const dayKey of [...allDays].sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
    if (startDay && dayKey < startDay) continue;
    if (endDay && dayKey > endDay) continue;

    const ledgerDay = dailyLedger[dayKey];
    const hostDay = historyDays[dayKey] ? cloneUsage(historyDays[dayKey]) : null;

    if (ledgerDay && ledgerDay.allocations && Object.keys(ledgerDay.allocations).length > 0) {
      const allocatedSum = emptyUsageBucket();
      for (const [allocEmail, allocMetrics] of Object.entries(ledgerDay.allocations)) {
        if (!allocMetrics) continue;
        addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
        addUsageToBucket(allocatedSum, allocMetrics);
      }
      if (hostDay) {
        const rem = subtractUsage(hostDay, allocatedSum);
        if (rem.totalTokens > 0 || rem.costUsd > 0) {
          addUsageToBucket(getOrCreateAccount('unattributed'), rem);
        }
      }
    } else if (hostDay && (hostDay.totalTokens > 0 || hostDay.costUsd > 0)) {
      addUsageToBucket(getOrCreateAccount('unattributed'), hostDay);
    }
  }

  if (filter === 'unattributed' && !byAccount.unattributed) {
    getOrCreateAccount('unattributed');
  }

  let overallTotalTokens = 0;
  let overallCostUsd = 0;
  let overallUnpricedTokens = 0;
  let overallInputTokens = 0;
  let overallOutputTokens = 0;
  let overallCacheReadTokens = 0;
  let overallCacheWriteTokens = 0;
  let overallReasoningTokens = 0;
  const overallModels = {};

  for (const bucket of Object.values(byAccount)) {
    overallTotalTokens += bucket.totalTokens;
    overallCostUsd += bucket.costUsd;
    overallUnpricedTokens += bucket.unpricedTokens || 0;
    overallInputTokens += bucket.inputTokens;
    overallOutputTokens += bucket.outputTokens;
    overallCacheReadTokens += bucket.cacheReadTokens;
    overallCacheWriteTokens += bucket.cacheWriteTokens;
    overallReasoningTokens += bucket.reasoningTokens;
    for (const [modelId, m] of Object.entries(bucket.models)) {
      if (!overallModels[modelId]) overallModels[modelId] = emptyModelMetrics();
      const om = overallModels[modelId];
      om.tokens += m.tokens;
      om.costUsd += m.costUsd;
      om.unpricedTokens = (om.unpricedTokens || 0) + (m.unpricedTokens || 0);
    }
  }

  for (const bucket of Object.values(byAccount)) {
    bucket.percentageOfTotal = overallTotalTokens > 0
      ? Number(((bucket.totalTokens / overallTotalTokens) * 100).toFixed(2))
      : 0;
    bucket.costUsd = roundUsd(bucket.costUsd);
    for (const m of Object.values(bucket.models)) {
      m.costUsd = roundUsd(m.costUsd);
    }
  }
  for (const om of Object.values(overallModels)) {
    om.costUsd = roundUsd(om.costUsd);
  }

  const target = filter === 'all' ? null : (byAccount[filter] || emptyAccountBucket(filter));
  const totalTokens = target ? target.totalTokens : overallTotalTokens;
  const costUsd = target ? target.costUsd : roundUsd(overallCostUsd);
  const unpricedTokens = target ? (target.unpricedTokens || 0) : overallUnpricedTokens;
  const inputTokens = target ? target.inputTokens : overallInputTokens;
  const outputTokens = target ? target.outputTokens : overallOutputTokens;
  const cacheReadTokens = target ? target.cacheReadTokens : overallCacheReadTokens;
  const cacheWriteTokens = target ? target.cacheWriteTokens : overallCacheWriteTokens;
  const reasoningTokens = target ? target.reasoningTokens : overallReasoningTokens;
  const models = target ? target.models : overallModels;

  const accounts = Object.values(byAccount);
  accounts.sort((a, b) => b.totalTokens - a.totalTokens || a.email.localeCompare(b.email));

  const unattrBucket = byAccount.unattributed || { totalTokens: 0, costUsd: 0 };
  const unattributedTokens = unattrBucket.totalTokens || 0;
  const attributedTokens = Math.max(0, overallTotalTokens - unattributedTokens);
  const unattributedCostUsd = roundUsd(unattrBucket.costUsd || 0);
  const attributedCostUsd = roundUsd(Math.max(0, overallCostUsd - unattributedCostUsd));
  const tokenCoveragePercent = overallTotalTokens > 0
    ? Number(((attributedTokens / overallTotalTokens) * 100).toFixed(1))
    : 100;
  const costCoveragePercent = overallCostUsd > 0
    ? Number(((attributedCostUsd / overallCostUsd) * 100).toFixed(1))
    : 100;

  return {
    accountFilter: filter,
    totalTokens,
    costUsd,
    unpricedTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    models,
    accounts,
    byAccount,
    overallTotalTokens,
    overallCostUsd: roundUsd(overallCostUsd),
    overallUnpricedTokens,
    coverage: {
      attributedTokens,
      unattributedTokens,
      attributedCostUsd,
      unattributedCostUsd,
      tokenCoveragePercent,
      costCoveragePercent
    }
  };
}

module.exports = {
  DEFAULT_LEDGER_FILENAME,
  LEDGER_VERSION,
  DEFAULT_HEARTBEAT_GAP_MS,
  HEARTBEAT_PERSIST_INTERVAL_MS,
  emptyModelMetrics,
  emptyUsageBucket,
  emptyAccountBucket,
  cloneUsage,
  addUsageToBucket,
  subtractUsage,
  mergeHighWater,
  createDefaultLedger,
  normalizeLedger,
  isLedgerStructureValid,
  loadLedger,
  saveLedger,
  recordAccountHeartbeat,
  syncTodaySnapshot,
  aggregateAccountUsage,
  localDayKey
};
