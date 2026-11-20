'use strict';

const fs = require('node:fs');
const path = require('node:path');
const accountsMod = require('./accounts.cjs');
const ledgerMod = require('./ledger.cjs');

const {
  normalizeEmail,
  localDayKey,
  toEpochMs,
  normalizeDate,
  isAntigravityClient,
  getSharedDataDir,
  readJson,
  writeJsonAtomic,
  discoverAccounts,
  discoverCurrentAccount
} = accountsMod;

const {
  DEFAULT_LEDGER_FILENAME,
  emptyModelMetrics,
  emptyUsageBucket,
  addUsageToBucket,
  cloneUsage,
  createDefaultLedger,
  loadLedger,
  saveLedger,
  recordAccountHeartbeat,
  syncTodaySnapshot,
  aggregateAccountUsage
} = ledgerMod;

const AUTO_REFRESH_INTERVAL_MS = 15_000;
const BACKGROUND_HEARTBEAT_INTERVAL_MS = 30_000;
const HOST_QUERY_TIMEOUT_MS = 2_500;
const MAX_QUERY_PAGES = 20;
const DAILY_HISTORY_MODEL_LABEL = '历史日汇总（未按模型拆分）';

function isValidDayKey(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function normalizeValidDay(raw) {
  const d = normalizeDate(raw);
  return isValidDayKey(d) ? d : null;
}

function toNonNegNum(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveHostDataDir(options = {}) {
  if (options.hostDataDir) return options.hostDataDir;
  if (options.dataDirectory) {
    const parentDir = path.dirname(options.dataDirectory);
    if (path.basename(parentDir) === 'plugin-data') return path.dirname(parentDir);
  }
  return getSharedDataDir();
}

async function callHostSafe(host, method, args, timeoutMs = HOST_QUERY_TIMEOUT_MS) {
  if (!host || typeof host.call !== 'function') return null;
  try {
    const callPromise = Promise.resolve(host.call(method, args));
    return await Promise.race([
      callPromise,
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      })
    ]);
  } catch (_) {
    return null;
  }
}

async function queryHostPaginated(host, queryArgs) {
  if (!host || typeof host.call !== 'function') return null;
  const rows = [];
  let cursor = null;
  let availability = 'unavailable';
  for (let pageIndex = 0; pageIndex < MAX_QUERY_PAGES; pageIndex += 1) {
    const page = cursor ? { limit: 500, cursor } : { limit: 500 };
    const res = await callHostSafe(host, 'data.query', { ...queryArgs, page });
    if (!res || typeof res !== 'object') return pageIndex === 0 ? null : { availability, rows };
    availability = res.availability || availability;
    if (Array.isArray(res.rows)) rows.push(...res.rows);
    if (!res.pageInfo?.hasMore || !res.pageInfo?.nextCursor) break;
    cursor = res.pageInfo.nextCursor;
  }
  return { availability, rows };
}

async function queryHostLimits(host) {
  const res = await queryHostPaginated(host, {
    resource: 'limits',
    filter: { provider: 'antigravity' }
  });
  if (!res || !Array.isArray(res.rows)) {
    return { hostActiveAccount: null, hostAccounts: [] };
  }
  const hostAccounts = [];
  const rpcRows = [];
  for (const row of res.rows) {
    if (!row || row.provider !== 'antigravity') continue;
    const email = normalizeEmail(row.accountEmail);
    if (!email) continue;
    const displayName = (typeof row.accountName === 'string' && row.accountName.trim())
      || (typeof row.accountLabel === 'string' && row.accountLabel.trim())
      || email;
    const mtimeMs = toEpochMs(row.updatedAt || 0);
    const source = row.source === 'rpc' ? 'host_limits_probe' : 'host_limits_oauth';
    hostAccounts.push({
      email,
      displayName,
      source,
      lastUsed: mtimeMs > 0 ? Math.round(mtimeMs / 1000) : null
    });
    if (row.source === 'rpc' && row.status === 'ok') {
      rpcRows.push({ email, displayName, source: 'host_limits_probe', mtimeMs: mtimeMs || Date.now() });
    }
  }
  rpcRows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    hostActiveAccount: rpcRows[0] || null,
    hostAccounts
  };
}

function deriveInputTokens(row, totalTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  if (row?.inputTokens !== null && row?.inputTokens !== undefined && Number.isFinite(Number(row.inputTokens))) {
    return toNonNegNum(row.inputTokens);
  }
  if (row?.tokenComponentsAvailable === true || (outputTokens + cacheReadTokens + cacheWriteTokens) > 0) {
    return Math.max(0, totalTokens - outputTokens - cacheReadTokens - cacheWriteTokens);
  }
  return 0;
}

async function queryHostTodaySnapshot(host) {
  const toolsRes = await queryHostPaginated(host, { resource: 'tools', period: 'today' });
  if (!toolsRes || toolsRes.availability !== 'available') return null;

  const agRows = toolsRes.rows.filter((r) => r && isAntigravityClient(r.client));
  const snapshot = emptyUsageBucket();
  if (agRows.length === 0) return snapshot;

  const hasAnyUnpriced = agRows.some((r) => toNonNegNum(r?.cost?.unpricedTokens) > 0);
  const unpricedByModel = new Map();
  if (hasAnyUnpriced) {
    const modelsRes = await queryHostPaginated(host, { resource: 'models', period: 'today' });
    for (const mr of modelsRes?.rows || []) {
      const mName = typeof mr?.model === 'string' ? mr.model.trim() : '';
      const unpriced = toNonNegNum(mr?.cost?.unpricedTokens);
      if (mName && unpriced > 0) unpricedByModel.set(mName, unpriced);
    }
  }

  for (const row of agRows) {
    const totalTokens = toNonNegNum(row.totalTokens);
    const costUsd = toNonNegNum(row.cost?.knownUsd);
    const unpricedTokens = toNonNegNum(row.cost?.unpricedTokens);
    const outputTokens = toNonNegNum(row.outputTokens);
    const cacheReadTokens = toNonNegNum(row.cacheReadTokens);
    const cacheWriteTokens = toNonNegNum(row.cacheWriteTokens);
    const reasoningTokens = toNonNegNum(row.reasoningTokens);
    const inputTokens = deriveInputTokens(row, totalTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

    const models = {};
    for (const m of Array.isArray(row.models) ? row.models : []) {
      const modelId = typeof m?.model === 'string' && m.model.trim() ? m.model.trim() : 'unknown';
      const mTokens = toNonNegNum(m?.totalTokens);
      const mCost = toNonNegNum(m?.knownUsd);
      let mUnpriced = 0;
      if (unpricedByModel.has(modelId)) {
        mUnpriced = Math.min(mTokens, unpricedByModel.get(modelId));
      } else if (mCost === 0 && mTokens > 0 && unpricedTokens > 0 && unpricedByModel.size === 0) {
        mUnpriced = Math.min(mTokens, unpricedTokens);
      }
      if (!models[modelId]) models[modelId] = emptyModelMetrics();
      models[modelId].tokens += mTokens;
      models[modelId].costUsd += mCost;
      models[modelId].unpricedTokens += mUnpriced;
    }

    addUsageToBucket(snapshot, {
      totalTokens,
      costUsd,
      unpricedTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      models
    });
  }

  return snapshot;
}

function dayQualityScore(dayObj) {
  let tokens = 0;
  let quality = 0;
  if (dayObj && typeof dayObj === 'object') {
    tokens = toNonNegNum(dayObj.totalTokens || dayObj.tokens);
    const observations = dayObj.observations && typeof dayObj.observations === 'object'
      ? Object.values(dayObj.observations) : [];
    for (const obs of observations) {
      if (!obs || typeof obs !== 'object') continue;
      tokens = Math.max(tokens, toNonNegNum(obs.tokens || obs.totalTokens));
      quality = Math.max(quality, toNonNegNum(obs.quality || obs.sourceQuality));
    }
    if (quality === 0 && observations.length > 0) quality = 1;
  }
  return { tokens, quality };
}

function liveDayIsGreater(live, existing) {
  const l = dayQualityScore(live);
  const e = dayQualityScore(existing);
  if (l.tokens !== e.tokens) return l.tokens > e.tokens;
  return l.quality > e.quality;
}

function extractArchiveHistoryByDay(dailyHistory) {
  const byDay = {};
  if (!dailyHistory) return byDay;

  const observations = [];
  if (Array.isArray(dailyHistory)) {
    for (const obs of dailyHistory) {
      if (obs && typeof obs === 'object') observations.push(obs);
    }
  } else if (typeof dailyHistory === 'object') {
    const days = {};
    if (dailyHistory.days && typeof dailyHistory.days === 'object') {
      for (const [dayKey, dayObj] of Object.entries(dailyHistory.days)) days[dayKey] = dayObj;
    }
    if (dailyHistory.liveDays && typeof dailyHistory.liveDays === 'object') {
      for (const [dayKey, liveObj] of Object.entries(dailyHistory.liveDays)) {
        if (!days[dayKey] || liveDayIsGreater(liveObj, days[dayKey])) days[dayKey] = liveObj;
      }
    }
    for (const [dayKey, dayObj] of Object.entries(days)) {
      if (!dayObj || !dayObj.observations || typeof dayObj.observations !== 'object') continue;
      for (const obs of Object.values(dayObj.observations)) {
        if (!obs || typeof obs !== 'object') continue;
        observations.push((!obs.day && !obs.date) ? { ...obs, day: dayKey } : obs);
      }
    }
  }

  for (const obs of observations) {
    if (!isAntigravityClient(obs?.client)) continue;
    const dayKey = normalizeValidDay(obs.day || obs.date);
    if (!dayKey) continue;
    if (!byDay[dayKey]) byDay[dayKey] = emptyUsageBucket();
    const totalTokens = toNonNegNum(obs.tokens ?? obs.totalTokens);
    const costUsd = toNonNegNum(obs.cost ?? obs.costUsd);
    const unpricedTokens = toNonNegNum(obs.unpricedTokens);
    const outputTokens = toNonNegNum(obs.outputTokens);
    const cacheReadTokens = toNonNegNum(obs.cacheReadTokens);
    const cacheWriteTokens = toNonNegNum(obs.cacheWriteTokens);
    const reasoningTokens = toNonNegNum(obs.reasoningTokens);
    const inputTokens = deriveInputTokens(obs, totalTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    const modelId = (typeof obs.modelId === 'string' && obs.modelId.trim())
      || (typeof obs.model === 'string' && obs.model.trim())
      || 'unknown';
    addUsageToBucket(byDay[dayKey], {
      totalTokens,
      costUsd,
      unpricedTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      models: { [modelId]: { tokens: totalTokens, costUsd, unpricedTokens } }
    });
  }
  return byDay;
}

async function queryHostHistoryByDay(host, startDay, endDay, hostDataDir) {
  const archiveFile = readJson(path.join(hostDataDir, 'daily-history-archive.json'), null)
    || readJson(path.join(hostDataDir, 'daily-usage-history.json'), null);
  const archiveByDay = extractArchiveHistoryByDay(archiveFile);

  const hostRes = await queryHostPaginated(host, {
    resource: 'history',
    resolution: 'daily',
    groupBy: 'client',
    filter: {
      ...(startDay ? { from: startDay } : {}),
      ...(endDay ? { to: endDay } : {}),
      client: 'antigravity'
    }
  });

  if (!hostRes || hostRes.availability !== 'available') {
    return { historyByDay: archiveByDay, source: 'daily_history_archive' };
  }

  const historyByDay = {};
  for (const row of hostRes.rows) {
    if (!row || !isAntigravityClient(row.client)) continue;
    const dayKey = normalizeValidDay(row.date);
    if (!dayKey) continue;
    const totalTokens = toNonNegNum(row.totalTokens);
    const costUsd = toNonNegNum(row.cost?.knownUsd);
    const unpricedTokens = toNonNegNum(row.cost?.unpricedTokens);
    const outputTokens = toNonNegNum(row.outputTokens);
    const cacheReadTokens = toNonNegNum(row.cacheReadTokens);
    const cacheWriteTokens = toNonNegNum(row.cacheWriteTokens);
    const reasoningTokens = toNonNegNum(row.reasoningTokens);
    const inputTokens = deriveInputTokens(row, totalTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

    const archived = archiveByDay[dayKey];
    let models = {};
    if (archived && Object.keys(archived.models).length > 0) {
      models = cloneUsage(archived).models;
      let archivedTokens = 0;
      let archivedCost = 0;
      let archivedUnpriced = 0;
      for (const m of Object.values(models)) {
        archivedTokens += m.tokens;
        archivedCost += m.costUsd;
        archivedUnpriced += m.unpricedTokens;
      }
      const remTokens = Math.max(0, totalTokens - archivedTokens);
      const remCost = Math.max(0, Number((costUsd - archivedCost).toFixed(6)));
      const remUnpriced = Math.max(0, unpricedTokens - archivedUnpriced);
      if (remTokens > 0 || remCost > 0) {
        models[DAILY_HISTORY_MODEL_LABEL] = { tokens: remTokens, costUsd: remCost, unpricedTokens: remUnpriced };
      }
    } else if (totalTokens > 0 || costUsd > 0) {
      models[DAILY_HISTORY_MODEL_LABEL] = { tokens: totalTokens, costUsd, unpricedTokens };
    }

    if (!historyByDay[dayKey]) historyByDay[dayKey] = emptyUsageBucket();
    addUsageToBucket(historyByDay[dayKey], {
      totalTokens,
      costUsd,
      unpricedTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      models
    });
  }

  return { historyByDay, source: 'host_business_data' };
}

async function activate({
  dataDirectory,
  host,
  storage,
  homeDir,
  hostDataDir: configuredHostDataDir,
  publish,
  log,
  autoRefreshIntervalMs,
  backgroundHeartbeatIntervalMs
} = {}) {
  const hostDataDir = resolveHostDataDir({ hostDataDir: configuredHostDataDir, dataDirectory });
  const pluginDataDir = dataDirectory || path.join(hostDataDir, 'plugin-data', 'antigravity-account-ledger');
  try { fs.mkdirSync(pluginDataDir, { recursive: true }); } catch (_) {}

  const pluginLedgerFile = path.join(pluginDataDir, DEFAULT_LEDGER_FILENAME);
  const hostLedgerFile = path.join(hostDataDir, DEFAULT_LEDGER_FILENAME);
  const preferencesFile = path.join(pluginDataDir, 'preferences.json');
  const refreshIntervalMs = Number.isFinite(autoRefreshIntervalMs) && autoRefreshIntervalMs > 0
    ? autoRefreshIntervalMs
    : AUTO_REFRESH_INTERVAL_MS;
  const heartbeatIntervalMs = Number.isFinite(backgroundHeartbeatIntervalMs) && backgroundHeartbeatIntervalMs > 0
    ? backgroundHeartbeatIntervalMs
    : BACKGROUND_HEARTBEAT_INTERVAL_MS;

  let currentFilter = 'all';
  let currentStartDate = null;
  let customEndDate = null;
  let currentRange = null;
  let currentVisible = true;
  let lastScanAt = Date.now();
  let autoRefreshTimer = null;
  let heartbeatTimer = null;
  let disposed = false;

  function applyPreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (prefs.accountFilter) currentFilter = prefs.accountFilter;
    const persistedStart = normalizeValidDay(prefs.startDate || prefs.range?.start);
    if (persistedStart) currentStartDate = persistedStart;
    const persistedEnd = normalizeValidDay(prefs.endDate ?? prefs.range?.end);
    const today = localDayKey();
    if (persistedEnd && today && persistedEnd < today) { customEndDate = persistedEnd; }
  }
  applyPreferences(readJson(preferencesFile, null));
  if (storage && typeof storage.get === 'function') {
    try { applyPreferences(await storage.get('preferences')); } catch (_) {}
  }

  let ledgerCache = null;
  let ledgerCacheStamp = null;
  function ledgerFileStamp(file) {
    try { const st = fs.statSync(file); return `${Math.round(st.mtimeMs)}:${st.size}`; } catch (_) { return null; }
  }
  function resolveLedger() {
    const stamp = ledgerFileStamp(pluginLedgerFile);
    if (ledgerCache && ledgerCacheStamp === stamp) {
      return { ledger: ledgerCache, ledgerFile: pluginLedgerFile };
    }
    let loaded;
    if (fs.existsSync(pluginLedgerFile)) {
      loaded = loadLedger(pluginLedgerFile);
    } else if (fs.existsSync(hostLedgerFile)) {
      loaded = loadLedger(hostLedgerFile);
      saveLedger(loaded, pluginLedgerFile);
    } else {
      loaded = loadLedger(pluginLedgerFile);
    }
    ledgerCache = loaded;
    ledgerCacheStamp = ledgerFileStamp(pluginLedgerFile);
    return { ledger: loaded, ledgerFile: pluginLedgerFile };
  }
  function persistLedger(ledger) {
    try {
      saveLedger(ledger, pluginLedgerFile);
      ledgerCache = ledger;
      ledgerCacheStamp = ledgerFileStamp(pluginLedgerFile);
    } catch (_) {}
  }

  async function resolveSettings() {
    const fromHost = await callHostSafe(host, 'app.settings', {});
    if (fromHost && typeof fromHost === 'object' && !Array.isArray(fromHost)) return fromHost;
    return readJson(path.join(hostDataDir, 'settings.json'), {});
  }

  async function syncLiveState(today) {
    const { ledger } = resolveLedger();
    const [settings, limitsInfo, todaySnapshot] = await Promise.all([
      resolveSettings(),
      queryHostLimits(host),
      queryHostTodaySnapshot(host)
    ]);
    const activeHostHint = limitsInfo.hostActiveAccount && limitsInfo.hostActiveAccount.mtimeMs > 0
      && (Date.now() - limitsInfo.hostActiveAccount.mtimeMs) <= 15 * 60 * 1000
      ? limitsInfo.hostActiveAccount
      : null;
    const discoverOpts = {
      homeDir,
      settings,
      hostActiveAccount: activeHostHint,
      hostAccounts: limitsInfo.hostAccounts
    };
    const discoveredAccounts = discoverAccounts(discoverOpts);
    const activeAccount = discoverCurrentAccount(discoverOpts);

    let ledgerChanged = false;
    const nowIso = new Date().toISOString();
    if (activeAccount && activeAccount.email) {
      const hb = recordAccountHeartbeat(activeAccount, nowIso, ledger, null);
      ledgerChanged = ledgerChanged || hb.changed;
    }
    if (todaySnapshot) {
      const sync = syncTodaySnapshot(today, todaySnapshot, activeAccount, ledger, { now: nowIso, save: false });
      ledgerChanged = ledgerChanged || sync.changed;
    }
    if (ledgerChanged) persistLedger(ledger);
    return { ledger, discoveredAccounts, activeAccount, todaySnapshot };
  }

  async function computeSummary(payload = {}) {
    const today = localDayKey() || normalizeDate(new Date());
    if (payload.accountFilter !== undefined) currentFilter = payload.accountFilter || 'all';
    if (payload.range === undefined && payload.auto !== true) customEndDate = null;
    if (payload.range !== undefined) {
      const reqStart = normalizeValidDay(payload.range?.start);
      if (reqStart) currentStartDate = reqStart;
      if (payload.auto !== true && payload.range?.end !== undefined) {
        const reqEnd = normalizeValidDay(payload.range.end);
        customEndDate = (reqEnd && reqEnd !== today) ? reqEnd : null;
      }
    }
    let rangeStart = currentStartDate || `${today.slice(0, 7)}-01`;
    let rangeEnd = customEndDate || today;
    if (rangeStart > rangeEnd) {
      const swapped = rangeStart; rangeStart = rangeEnd; rangeEnd = swapped;
      currentStartDate = rangeStart;
      customEndDate = rangeEnd === today ? null : rangeEnd;
    }
    currentRange = { start: rangeStart, end: rangeEnd };

    const [{ ledger, discoveredAccounts, activeAccount, todaySnapshot }, historyResult] = await Promise.all([
      syncLiveState(today),
      queryHostHistoryByDay(host, rangeStart, rangeEnd, hostDataDir)
    ]);

    const hostHistoryByDay = { ...historyResult.historyByDay };
    if (todaySnapshot && (!hostHistoryByDay[today] || todaySnapshot.totalTokens >= hostHistoryByDay[today].totalTokens)) {
      hostHistoryByDay[today] = todaySnapshot;
    }

    const summary = aggregateAccountUsage({
      ledger,
      hostHistoryByDay,
      range: currentRange,
      accountFilter: currentFilter,
      discoveredAccounts
    });

    const resolvedActive = activeAccount
      || (ledger.lastActiveAccount ? { email: ledger.lastActiveAccount, source: 'ledger_last_active' } : null);

    return {
      summary,
      ...summary,
      accountFilter: currentFilter,
      activeAccount: resolvedActive,
      discoveredAccounts,
      ledger,
      featureActivatedAt: ledger.featureActivatedAt,
      range: currentRange,
      scannerStats: {
        source: todaySnapshot ? 'host_business_data' : historyResult.source
      },
      updatedAt: new Date().toISOString()
    };
  }

  async function stampAndCompute(payload = {}) {
    const result = await computeSummary(payload);
    lastScanAt = Date.now();
    return result;
  }

  async function savePreferences() {
    const prefs = {
      accountFilter: currentFilter,
      startDate: currentStartDate,
      endDate: customEndDate,
      range: { start: currentStartDate }
    };
    if (storage && typeof storage.set === 'function') {
      try { await storage.set('preferences', prefs); } catch (_) {}
    }
    try { writeJsonAtomic(preferencesFile, prefs); } catch (_) {}
  }

  function publishResult(result) {
    if (typeof publish === 'function') {
      try { publish(result); } catch (_) {}
    }
  }

  function clearAutoRefresh() {
    if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
  }
  function clearBackgroundHeartbeat() {
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  }

  function scheduleBackgroundHeartbeat() {
    if (disposed || currentVisible) return;
    clearBackgroundHeartbeat();
    heartbeatTimer = setTimeout(async () => {
      heartbeatTimer = null;
      if (disposed || currentVisible) return;
      try {
        const today = localDayKey() || normalizeDate(new Date());
        await syncLiveState(today);
      } catch (_) {}
      scheduleBackgroundHeartbeat();
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  function scheduleAutoRefresh({ immediate = false } = {}) {
    if (disposed || !currentVisible || typeof publish !== 'function') return;
    clearAutoRefresh();
    const delay = immediate ? 0 : Math.max(0, refreshIntervalMs - (Date.now() - lastScanAt));
    autoRefreshTimer = setTimeout(() => {
      autoRefreshTimer = null;
      runAutoRefresh(immediate);
    }, delay);
    if (typeof autoRefreshTimer.unref === 'function') autoRefreshTimer.unref();
  }

  async function runAutoRefresh(force = false) {
    if (disposed || !currentVisible) return;
    if (!force && Date.now() - lastScanAt < refreshIntervalMs) {
      scheduleAutoRefresh();
      return;
    }
    try {
      const result = await stampAndCompute({ auto: true });
      if (!disposed && currentVisible) publishResult(result);
    } catch (err) {
      if (typeof log === 'function') {
        try { log(`warn: Auto refresh failed: ${err?.message || err}`); } catch (_) {}
      }
    }
    scheduleAutoRefresh();
  }

  const actions = {
    async getSummary(payload = {}) {
      const explicit = Boolean(payload && (payload.range !== undefined || payload.accountFilter !== undefined));
      const result = await stampAndCompute(payload);
      if (explicit && payload.auto !== true) await savePreferences();
      return result;
    }
  };

  function update(context = {}) {
    if (disposed) return;
    const nextVisible = typeof context?.visible === 'boolean' ? context.visible : currentVisible;
    const becameVisible = nextVisible && !currentVisible;
    currentVisible = nextVisible;
    if (!currentVisible) {
      clearAutoRefresh();
      scheduleBackgroundHeartbeat();
      return;
    }
    clearBackgroundHeartbeat();
    scheduleAutoRefresh({ immediate: becameVisible });
  }

  scheduleAutoRefresh();
  return {
    actions,
    async call(method, args = {}) {
      if (typeof actions[method] === 'function') return await actions[method](args);
      throw new Error(`Unknown method: ${method}`);
    },
    update,
    dispose() {
      disposed = true;
      clearAutoRefresh();
      clearBackgroundHeartbeat();
    }
  };
}

module.exports = {
  ...accountsMod,
  ...ledgerMod,
  DAILY_HISTORY_MODEL_LABEL,
  queryHostLimits,
  queryHostTodaySnapshot,
  extractArchiveHistoryByDay,
  queryHostHistoryByDay,
  activate,
  discoverKnownAntigravityAccounts: accountsMod.discoverAccounts,
  discoverActiveAntigravityAccount: accountsMod.discoverCurrentAccount
};
