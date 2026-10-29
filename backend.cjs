'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scanner = require('./scanner.cjs');
const attr = require('./attribution.cjs');
const {
  DatabaseSync, DEFAULT_LEDGER_FILENAME, DEFAULT_DB_CACHE_FILENAME,
  MODEL_ENUM_MAP, DISPLAY_NAME_TO_CANONICAL, MODEL_PRICING,
  normalizeEmail, normalizeDate, isAntigravityClient, getSharedDataDir, readJson, writeJsonAtomic,
  parseProto, decodeTimestamp, parseUsageStats, inspectWalBytes, resolveModelAndPrice,
  scanConversationDb, scanAllConversationDbs, extractEmailFromUserStatusValue,
  discoverFromVscdb, discoverFromTools, discoverFromGoogleAccountsJson, discoverFromManaged,
  discoverAccounts, discoverCurrentAccount, localDayKey
} = scanner;
const {
  quotaGroupForModel, toEpochMs, buildQuotaAttributionWindows, createDefaultLedger,
  normalizeLedger, loadLedger, saveLedger, recordAccountHeartbeat,
  attributeCallRecord,
  emptyMetrics, emptyAccountBucket, cloneMetrics, hasActiveTodayPeriod,
  extractSessionTimestamp, resolveSessionDate, extractSessionMetrics, subtractMetrics,
  syncActiveAccountSessions, allocationsForDay, attributeSession, extractObsMetrics, addUsageToBucket
} = attr;
function dayQualityScore(dayObj) { let tokens = 0;
let quality = 0;
if (dayObj && typeof dayObj === 'object') {
tokens = Number(dayObj.totalTokens || dayObj.tokens || 0);
const observations = dayObj.observations && typeof dayObj.observations === 'object'
? Object.values(dayObj.observations) : [];
for (const obs of observations) { if (!obs || typeof obs !== 'object') continue;
tokens = Math.max(tokens, Number(obs.tokens || obs.totalTokens || 0));
quality = Math.max(quality, Number(obs.quality || obs.sourceQuality || 0) || 0); }
if (quality === 0 && observations.length > 0) quality = 1; }
return { tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0, quality }; }
function liveDayIsGreater(live, existing) { const l = dayQualityScore(live);
const e = dayQualityScore(existing);
if (l.tokens !== e.tokens) return l.tokens > e.tokens;
return l.quality > e.quality; }
function isValidDayKey(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}
function normalizeValidDay(raw) {
  const d = normalizeDate(raw);
  return isValidDayKey(d) ? d : null;
}
function aggregateAccountUsage(args = {}, options = {}) { const { calls = null, sessions = [], dailyHistory = [],
range = null, accountFilter = 'all', discoveredAccounts = [], activeAccount = null
} = args;
const ledger = args.ledger || options.ledger || createDefaultLedger();
const quotaWindows = args.quotaWindows || options.quotaWindows || buildQuotaAttributionWindows(discoveredAccounts, options);
const filter = normalizeEmail(accountFilter) || 'all';
let startDay = range?.start ? normalizeValidDay(range.start) : null;
let endDay = range?.end ? normalizeValidDay(range.end) : null;
if (startDay && endDay && startDay > endDay) { const tmp = startDay;
startDay = endDay;
endDay = tmp; }
const byAccount = {};
const discoveredList = Array.isArray(discoveredAccounts) ? discoveredAccounts : [];
function getOrCreateAccount(email, displayName = '') {
const norm = email === 'unattributed' ? 'unattributed' : normalizeEmail(email);
if (!norm) return emptyAccountBucket('unattributed');
if (!byAccount[norm]) { byAccount[norm] = emptyAccountBucket(norm, displayName);
} else if (displayName && displayName !== norm && (!byAccount[norm].displayName || byAccount[norm].displayName === norm)) {
byAccount[norm].displayName = displayName; }
return byAccount[norm]; }
for (const acc of discoveredList) { const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
if (!email) continue;
const displayName = (typeof acc === 'object' && (acc.displayName || acc.name)) || email;
getOrCreateAccount(email, displayName); }
let totalCalls = 0;
let attributedCalls = 0;
let unattributedCalls = 0;
const useCalls = Array.isArray(calls) && calls.length > 0;
if (useCalls) { for (const call of calls) {
if (!call || typeof call !== 'object') continue;
const callDay = call.day || normalizeDate(call.timestampMs || (call.callTimestamp ? call.callTimestamp * 1000 : ''));
if (callDay) { if (startDay && callDay < startDay) continue;
if (endDay && callDay > endDay) continue; }
const attribution = attributeCallRecord(call, { ledger, quotaWindows });
totalCalls += 1;
if (attribution.isUnattributed) { unattributedCalls += 1; } else { attributedCalls += 1; }
const bucket = getOrCreateAccount(attribution.email);
const modelId = call.model || 'unknown';
const totalTokens = Number(call.totalTokens ?? ((call.inputTokens || 0) + (call.outputTokens || 0) + (call.cacheReadTokens || 0) + (call.cacheWriteTokens || 0)));
const costUsd = Number(call.costUsd || 0);
addUsageToBucket(bucket, { totalTokens, costUsd, inputTokens: Number(call.inputTokens || 0),
outputTokens: Number(call.outputTokens || 0), cacheReadTokens: Number(call.cacheReadTokens || 0),
cacheWriteTokens: Number(call.cacheWriteTokens || 0),
reasoningTokens: Number(call.reasoningTokens ?? call.thinkingTokens ?? 0), models: { [modelId]: {
tokens: totalTokens, costUsd, inputTokens: Number(call.inputTokens || 0),
outputTokens: Number(call.outputTokens || 0), cacheReadTokens: Number(call.cacheReadTokens || 0),
cacheWriteTokens: Number(call.cacheWriteTokens || 0),
reasoningTokens: Number(call.reasoningTokens ?? call.thinkingTokens ?? 0) } } }); } } else {
let allDailyObservations = [];
if (Array.isArray(dailyHistory)) { allDailyObservations = dailyHistory;
} else if (dailyHistory && typeof dailyHistory === 'object') { const days = {};
if (dailyHistory.days && typeof dailyHistory.days === 'object') {
for (const [dayKey, dayObj] of Object.entries(dailyHistory.days)) { days[dayKey] = dayObj; } }
if (dailyHistory.liveDays && typeof dailyHistory.liveDays === 'object') {
for (const [dayKey, liveObj] of Object.entries(dailyHistory.liveDays)) {
if (!days[dayKey] || liveDayIsGreater(liveObj, days[dayKey])) { days[dayKey] = liveObj; } } }
for (const [dayKey, dayObj] of Object.entries(days)) { if (dayObj && dayObj.observations) {
for (const obs of Object.values(dayObj.observations)) { if (obs && !obs.day && !obs.date) {
allDailyObservations.push({ ...obs, day: dayKey }); } else { allDailyObservations.push(obs); } } } } }
const hasDailyHistory = allDailyObservations.length > 0;
if (!hasDailyHistory) { if (Array.isArray(sessions)) { for (const session of sessions) {
if (!isAntigravityClient(session?.client)) continue;
const startedAt = extractSessionTimestamp(session);
const hasToday = hasActiveTodayPeriod(session);
const isEligible = Boolean(
hasToday || (toEpochMs(startedAt) > 0 && toEpochMs(ledger.featureActivatedAt) > 0
&& toEpochMs(startedAt) >= toEpochMs(ledger.featureActivatedAt))
);
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
const dailyAllocations = binding?.allocationsByDay;
const hasDailyAllocations = Boolean(dailyAllocations && typeof dailyAllocations === 'object'
&& Object.keys(dailyAllocations).length > 0);
if (isEligible && hasDailyAllocations) {
// A session spanning several days contributes every recorded day inside the range.
let counted = false;
for (const [allocDay, alloc] of Object.entries(dailyAllocations)) {
if (!alloc || typeof alloc !== 'object' || !Object.keys(alloc).length) continue;
if (startDay && allocDay < startDay) continue;
if (endDay && allocDay > endDay) continue;
counted = true;
for (const [allocEmail, allocMetrics] of Object.entries(alloc)) {
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics); } }
if (counted) continue; }
const sessionDate = resolveSessionDate(session);
if (sessionDate) { if (startDay && sessionDate < startDay) continue;
if (endDay && sessionDate > endDay) continue; }
const dayAlloc = allocationsForDay(binding, sessionDate || 'unknown');
if (isEligible && dayAlloc && Object.keys(dayAlloc).length > 0) {
for (const [allocEmail, allocMetrics] of Object.entries(dayAlloc)) {
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics); } } else {
const attr = attributeSession(session, ledger, { activeAccount, bindNewSessions: options.bindNewSessions ?? false, quotaWindows
});
const sMetrics = extractSessionMetrics(session, { preferAllTime: true });
addUsageToBucket(getOrCreateAccount(attr.email), sMetrics); } } } } else { const filteredObservations = [];
for (const obs of allDailyObservations) { if (!isAntigravityClient(obs?.client)) continue;
const obsDate = normalizeDate(obs.day || obs.date);
if (obsDate) { if (startDay && obsDate < startDay) continue;
if (endDay && obsDate > endDay) continue; }
filteredObservations.push(obs); }
const dailyAllocByDay = new Map();
const sessionsWithoutDailyAlloc = new Map();
if (Array.isArray(sessions)) { for (const session of sessions) {
if (!isAntigravityClient(session?.client)) continue;
const startedAt = extractSessionTimestamp(session);
const hasToday = hasActiveTodayPeriod(session);
const isPostActivation = Boolean(
hasToday || (toEpochMs(startedAt) > 0 && toEpochMs(ledger.featureActivatedAt) > 0
&& toEpochMs(startedAt) >= toEpochMs(ledger.featureActivatedAt))
);
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
const isManualBinding = session.sessionId && ledger.sessionAccounts?.[session.sessionId]?.source === 'manual';
if (!isPostActivation && !isManualBinding) continue;
const dailyAllocations = binding?.allocationsByDay;
const hasDailyAllocations = Boolean(dailyAllocations && typeof dailyAllocations === 'object'
&& Object.keys(dailyAllocations).length > 0);
if (hasDailyAllocations) {
// Each recorded day is attributed to that day, not to the session's last active day.
for (const [allocDay, alloc] of Object.entries(dailyAllocations)) {
if (!alloc || typeof alloc !== 'object' || !Object.keys(alloc).length) continue;
if (startDay && allocDay < startDay) continue;
if (endDay && allocDay > endDay) continue;
let dayBucket = dailyAllocByDay.get(allocDay);
if (!dayBucket) { dayBucket = new Map(); dailyAllocByDay.set(allocDay, dayBucket); }
for (const [allocEmail, allocMetrics] of Object.entries(alloc)) {
const prev = dayBucket.get(allocEmail);
if (!prev) { dayBucket.set(allocEmail, cloneMetrics(allocMetrics)); continue; }
addUsageToBucket(prev, allocMetrics); } }
continue; }
const sessionDate = resolveSessionDate(session);
if (sessionDate) { if (startDay && sessionDate < startDay) continue;
if (endDay && sessionDate > endDay) continue; }
const dayKey = sessionDate || 'unknown';
if (!sessionsWithoutDailyAlloc.has(dayKey)) { sessionsWithoutDailyAlloc.set(dayKey, []); }
sessionsWithoutDailyAlloc.get(dayKey).push(session); } }
const obsByDay = new Map();
for (const obs of filteredObservations) { const d = normalizeDate(obs.day || obs.date) || 'unknown';
if (!obsByDay.has(d)) obsByDay.set(d, []);
obsByDay.get(d).push(obs); }
for (const [d, dayObsList] of obsByDay.entries()) { const dayTotal = { totalTokens: 0, costUsd: 0, inputTokens: 0,
outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, models: {} };
for (const obs of dayObsList) { addUsageToBucket(dayTotal, extractObsMetrics(obs)); }
const daySessions = sessionsWithoutDailyAlloc.get(d) || [];
const subTotal = { totalTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
cacheWriteTokens: 0, reasoningTokens: 0, models: {} };
const dayAllocations = dailyAllocByDay.get(d);
if (dayAllocations) { for (const [allocEmail, allocMetrics] of dayAllocations.entries()) {
if (allocEmail === 'unattributed') continue;
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
addUsageToBucket(subTotal, allocMetrics); } }
for (const session of daySessions) {
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
const dayAlloc = allocationsForDay(binding, d);
if (dayAlloc && Object.keys(dayAlloc).length > 0) {
for (const [allocEmail, allocMetrics] of Object.entries(dayAlloc)) {
if (allocEmail === 'unattributed') continue;
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
addUsageToBucket(subTotal, allocMetrics); } } else { const sAttr = attributeSession(session, ledger, {
activeAccount, bindNewSessions: options.bindNewSessions ?? false, quotaWindows });
const sMetrics = extractSessionMetrics(session, { preferToday: hasActiveTodayPeriod(session) });
addUsageToBucket(getOrCreateAccount(sAttr.email), sMetrics);
addUsageToBucket(subTotal, sMetrics); } }
const rem = subtractMetrics(dayTotal, subTotal);
if (rem.totalTokens > 0 || rem.costUsd > 0) {
addUsageToBucket(getOrCreateAccount('unattributed'), rem); } }
for (const [d, daySessions] of sessionsWithoutDailyAlloc.entries()) { if (obsByDay.has(d)) continue;
for (const session of daySessions) {
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
const dayAlloc = allocationsForDay(binding, d);
if (dayAlloc && Object.keys(dayAlloc).length > 0) {
for (const [allocEmail, allocMetrics] of Object.entries(dayAlloc)) {
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics); } } else {
const sAttr = attributeSession(session, ledger, { activeAccount, bindNewSessions: options.bindNewSessions ?? false, quotaWindows
});
const sMetrics = extractSessionMetrics(session, { preferAllTime: true });
addUsageToBucket(getOrCreateAccount(sAttr.email), sMetrics); } } }
for (const [d, dayAllocations] of dailyAllocByDay.entries()) { if (obsByDay.has(d)) continue;
for (const [allocEmail, allocMetrics] of dayAllocations.entries()) {
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics); } } } }
if (filter === 'unattributed' && !byAccount.unattributed) { getOrCreateAccount('unattributed'); }
let overallTotalTokens = 0;
let overallCostUsd = 0;
let overallInputTokens = 0;
let overallOutputTokens = 0;
let overallCacheReadTokens = 0;
let overallCacheWriteTokens = 0;
let overallReasoningTokens = 0;
const overallModels = {};
for (const bucket of Object.values(byAccount)) { overallTotalTokens += bucket.totalTokens;
overallCostUsd += bucket.costUsd;
overallInputTokens += bucket.inputTokens;
overallOutputTokens += bucket.outputTokens;
overallCacheReadTokens += bucket.cacheReadTokens;
overallCacheWriteTokens += bucket.cacheWriteTokens;
overallReasoningTokens += bucket.reasoningTokens;
for (const [modelId, m] of Object.entries(bucket.models)) {
if (!overallModels[modelId]) overallModels[modelId] = emptyMetrics();
const om = overallModels[modelId];
om.tokens += m.tokens;
om.costUsd += m.costUsd;
om.inputTokens += m.inputTokens;
om.outputTokens += m.outputTokens;
om.cacheReadTokens += m.cacheReadTokens;
om.cacheWriteTokens += m.cacheWriteTokens;
om.reasoningTokens += m.reasoningTokens; } }
for (const bucket of Object.values(byAccount)) { bucket.percentageOfTotal = overallTotalTokens > 0
? Number(((bucket.totalTokens / overallTotalTokens) * 100).toFixed(2))
: 0;
bucket.costUsd = Number(bucket.costUsd.toFixed(6));
for (const m of Object.values(bucket.models)) { m.costUsd = Number(m.costUsd.toFixed(6)); } }
for (const om of Object.values(overallModels)) { om.costUsd = Number(om.costUsd.toFixed(6)); }
let totalTokens;
let costUsd;
let inputTokens;
let outputTokens;
let cacheReadTokens;
let cacheWriteTokens;
let reasoningTokens;
let models;
if (filter === 'all') { totalTokens = overallTotalTokens;
costUsd = Number(overallCostUsd.toFixed(6));
inputTokens = overallInputTokens;
outputTokens = overallOutputTokens;
cacheReadTokens = overallCacheReadTokens;
cacheWriteTokens = overallCacheWriteTokens;
reasoningTokens = overallReasoningTokens;
models = overallModels; } else { const target = byAccount[filter] || emptyAccountBucket(filter);
totalTokens = target.totalTokens;
costUsd = target.costUsd;
inputTokens = target.inputTokens;
outputTokens = target.outputTokens;
cacheReadTokens = target.cacheReadTokens;
cacheWriteTokens = target.cacheWriteTokens;
reasoningTokens = target.reasoningTokens;
models = target.models; }
const accounts = Object.values(byAccount);
accounts.sort((a, b) => b.totalTokens - a.totalTokens || a.email.localeCompare(b.email));
const unattrBucket = byAccount.unattributed || { totalTokens: 0, costUsd: 0 };
const unattributedTokens = unattrBucket.totalTokens || 0;
const attributedTokens = Math.max(0, overallTotalTokens - unattributedTokens);
const unattributedCostUsd = Number((unattrBucket.costUsd || 0).toFixed(6));
const attributedCostUsd = Number(Math.max(0, overallCostUsd - unattributedCostUsd).toFixed(6));
const tokenCoveragePercent = overallTotalTokens > 0
? Number(((attributedTokens / overallTotalTokens) * 100).toFixed(1))
: 100;
const costCoveragePercent = overallCostUsd > 0
? Number(((attributedCostUsd / overallCostUsd) * 100).toFixed(1))
: 100;
const coverage = { attributedTokens, unattributedTokens, attributedCostUsd, unattributedCostUsd,
tokenCoveragePercent, costCoveragePercent };
if (useCalls) { coverage.totalCalls = totalCalls;
coverage.attributedCalls = attributedCalls;
coverage.unattributedCalls = unattributedCalls; }
return { accountFilter: filter, totalTokens, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
reasoningTokens, models, accounts, byAccount, overallTotalTokens, overallCostUsd: Number(overallCostUsd.toFixed(6)),
coverage }; }
function sessionTokenTotal(entry) { if (!entry || typeof entry !== 'object') return 0;
const target = entry.periods?.allTime || entry.periods?.month || entry.periods?.today || entry;
return Number(target.totalTokens || target.tokens || entry.totalTokens || entry.tokens || 0) || 0; }
function loadArchivedSessions(appDataRoot) { const bySession = new Map();
function addSession(entry, fromSqlite = false) { if (!entry || typeof entry !== 'object') return;
if (fromSqlite && !isAntigravityClient(entry.client)) return;
if (!entry.sessionId) return;
const key = `${entry.client || 'antigravity'}:${entry.sessionId}`;
const existing = bySession.get(key);
if (!existing) { bySession.set(key, { entry, fromSqlite }); return; }
if (existing.fromSqlite && !fromSqlite) return;
if (!existing.fromSqlite && fromSqlite) { bySession.set(key, { entry, fromSqlite }); return; }
if (!existing.fromSqlite && !fromSqlite && sessionTokenTotal(entry) > sessionTokenTotal(existing.entry)) {
bySession.set(key, { entry, fromSqlite }); } }
if (DatabaseSync) { const dbPath = path.join(appDataRoot, 'session-usage-archive.sqlite');
if (fs.existsSync(dbPath)) { try { const db = new DatabaseSync(dbPath, { readOnly: true });
try { try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
const rows = db.prepare('SELECT entry_json FROM sessions').all();
for (const row of rows) { try { addSession(JSON.parse(row.entry_json), true); } catch (_) {} }
} finally { try { db.close(); } catch (_) {} } } catch (_) {} } }
const legacyJsonPath = path.join(appDataRoot, 'session-usage-archive.json');
if (fs.existsSync(legacyJsonPath)) { const data = readJson(legacyJsonPath, null);
const source = data?.sessions && typeof data.sessions === 'object' ? data.sessions : data;
if (Array.isArray(source)) { for (const entry of source) { addSession(entry); } }
else if (source && typeof source === 'object') { for (const [rawKey, value] of Object.entries(source)) {
if (!value || typeof value !== 'object') continue;
const key = String(rawKey);
const keySessionId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
addSession({ ...value, client: value.client || 'antigravity', sessionId: value.sessionId || keySessionId }); } } }
const archiveDir = path.join(appDataRoot, 'tokscale-cache', 'antigravity-archive');
if (fs.existsSync(archiveDir)) { try { const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
for (const entry of entries) { if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
const filePath = path.join(archiveDir, entry.name);
const data = readJson(filePath, null);
if (!data || typeof data !== 'object') continue;
if (Array.isArray(data.sessions)) { for (const s of data.sessions) {
if (s && typeof s === 'object') { addSession({ client: 'antigravity', ...s }); } }
} else if (data.sessionId || data.totalTokens || data.tokens || data.periods) {
addSession({ client: 'antigravity', sessionId: data.sessionId || entry.name.replace(/\.json$/i, ''), ...data }); } }
} catch (_) {} }
return [...bySession.values()].map((record) => record.entry); }
function resolveHostDataDir(options = {}) { if (options.hostDataDir) return options.hostDataDir;
if (options.dataDirectory) { const parentDir = path.dirname(options.dataDirectory);
if (path.basename(parentDir) === 'plugin-data') return path.dirname(parentDir); }
return getSharedDataDir(); }
const AUTO_REFRESH_INTERVAL_MS = 15_000;
async function activate({ dataDirectory, storage, homeDir, hostDataDir: configuredHostDataDir, conversationDirs, conversationSources,
publish, log, autoRefreshIntervalMs } = {}) {
const hostDataDir = resolveHostDataDir({ hostDataDir: configuredHostDataDir, dataDirectory });
const pluginDataDir = dataDirectory || path.join(hostDataDir, 'plugin-data', 'antigravity-account-ledger');
try { fs.mkdirSync(pluginDataDir, { recursive: true }); } catch (_) {}
const pluginLedgerFile = path.join(pluginDataDir, DEFAULT_LEDGER_FILENAME);
const hostLedgerFile = path.join(hostDataDir, DEFAULT_LEDGER_FILENAME);
const dbCacheFile = path.join(pluginDataDir, DEFAULT_DB_CACHE_FILENAME);
const preferencesFile = path.join(pluginDataDir, 'preferences.json');
const refreshIntervalMs = Number.isFinite(autoRefreshIntervalMs) && autoRefreshIntervalMs > 0
? autoRefreshIntervalMs
: AUTO_REFRESH_INTERVAL_MS;
let currentFilter = 'all';
let currentStartDate = null;
let customEndDate = null;
let currentRange = null;
let currentVisible = true;
let lastScanAt = Date.now();
let autoRefreshTimer = null;
let disposed = false;
function applyPreferences(prefs) { if (!prefs || typeof prefs !== 'object') return;
if (prefs.accountFilter) currentFilter = prefs.accountFilter;
const persistedStart = normalizeValidDay(prefs.startDate || prefs.range?.start);
if (persistedStart) currentStartDate = persistedStart;
const persistedEnd = normalizeValidDay(prefs.endDate ?? prefs.range?.end);
const today = localDayKey();
if (persistedEnd && today && persistedEnd < today) { customEndDate = persistedEnd; } }
applyPreferences(readJson(preferencesFile, null));
if (storage && typeof storage.get === 'function') { try {
applyPreferences(await storage.get('preferences')); } catch (_) {} }
let ledgerCache = null;
let ledgerCacheStamp = null;
function ledgerFileStamp(file) { try { const st = fs.statSync(file);
return `${Math.round(st.mtimeMs)}:${st.size}`; } catch (_) { return null; } }
function resolveLedger() { const stamp = ledgerFileStamp(pluginLedgerFile);
if (ledgerCache && ledgerCacheStamp === stamp) { return { ledger: ledgerCache, ledgerFile: pluginLedgerFile }; }
let loaded;
if (fs.existsSync(pluginLedgerFile)) { loaded = loadLedger(pluginLedgerFile); }
else if (fs.existsSync(hostLedgerFile)) { loaded = loadLedger(hostLedgerFile);
saveLedger(loaded, pluginLedgerFile); }
else { loaded = loadLedger(pluginLedgerFile); }
ledgerCache = loaded;
ledgerCacheStamp = ledgerFileStamp(pluginLedgerFile);
return { ledger: loaded, ledgerFile: pluginLedgerFile }; }
function persistLedger(ledger) { try { saveLedger(ledger, pluginLedgerFile);
ledgerCache = ledger;
ledgerCacheStamp = ledgerFileStamp(pluginLedgerFile); } catch (_) {} }
function computeSummary(payload = {}) { const today = localDayKey() || normalizeDate(new Date());
if (payload.accountFilter !== undefined) {
currentFilter = payload.accountFilter || 'all'; }
if (payload.range === undefined && payload.auto !== true) { customEndDate = null; }
if (payload.range !== undefined) {
const reqStart = normalizeValidDay(payload.range?.start);
if (reqStart) currentStartDate = reqStart;
if (payload.auto !== true && payload.range?.end !== undefined) {
const reqEnd = normalizeValidDay(payload.range.end);
customEndDate = (reqEnd && reqEnd !== today) ? reqEnd : null; } }
let rangeStart = currentStartDate || `${today.slice(0, 7)}-01`;
let rangeEnd = customEndDate || today;
if (rangeStart > rangeEnd) { const swapped = rangeStart;
rangeStart = rangeEnd;
rangeEnd = swapped;
currentStartDate = rangeStart;
customEndDate = rangeEnd === today ? null : rangeEnd; }
currentRange = { start: rangeStart, end: rangeEnd };
const { ledger } = resolveLedger();
const settings = readJson(path.join(hostDataDir, 'settings.json'), {});
const discoveredAccounts = discoverAccounts({ homeDir, settings });
const activeAccount = discoverCurrentAccount({ homeDir, settings });
let ledgerChanged = false;
if (activeAccount && activeAccount.email) {
const heartbeat = recordAccountHeartbeat(activeAccount, new Date().toISOString(), ledger, null);
ledgerChanged = ledgerChanged || heartbeat.changed; }
const quotaWindows = buildQuotaAttributionWindows(discoveredAccounts, { homeDir });
const calls = scanAllConversationDbs({ homeDir, conversationDirs, conversationSources, cacheFile: dbCacheFile });
const dailyHistory = readJson(path.join(hostDataDir, 'daily-history-archive.json'), null)
|| readJson(path.join(hostDataDir, 'daily-usage-history.json'), { days: {} });
const sessions = loadArchivedSessions(hostDataDir);
if (activeAccount && activeAccount.email && sessions.length > 0) {
const sync = syncActiveAccountSessions(sessions, activeAccount, ledger, { save: false });
ledgerChanged = ledgerChanged || sync.changed; }
const summary = aggregateAccountUsage( { calls: calls.length > 0 ? calls : null, sessions, dailyHistory,
range: currentRange, accountFilter: currentFilter, discoveredAccounts, activeAccount, ledger, quotaWindows
}, { ledger, quotaWindows, bindNewSessions: true }
);
if (ledgerChanged) { persistLedger(ledger); }
const resolvedActive = activeAccount
|| (ledger.lastActiveAccount ? { email: ledger.lastActiveAccount, source: 'ledger_last_active' } : null);
return { summary, ...summary, accountFilter: currentFilter, activeAccount: resolvedActive, discoveredAccounts, ledger,
featureActivatedAt: ledger.featureActivatedAt,
range: currentRange, scannerStats: { source: calls.length > 0 ? 'sqlite_protobuf_calls' : 'daily_history_fallback',
totalCalls: calls.length
}, updatedAt: new Date().toISOString() }; }
function stampAndCompute(payload = {}) { const result = computeSummary(payload);
lastScanAt = Date.now();
return result; }
async function savePreferences() { const prefs = { accountFilter: currentFilter, startDate: currentStartDate,
endDate: customEndDate, range: { start: currentStartDate } };
if (storage && typeof storage.set === 'function') { try { await storage.set('preferences', prefs); } catch (_) {} }
try { writeJsonAtomic(preferencesFile, prefs); } catch (_) {} }
function publishResult(result) { if (typeof publish === 'function') { try { publish(result); } catch (_) {} } }
function clearAutoRefresh() { if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; } }
function scheduleAutoRefresh({ immediate = false } = {}) {
if (disposed || !currentVisible || typeof publish !== 'function') return;
clearAutoRefresh();
const delay = immediate ? 0 : Math.max(0, refreshIntervalMs - (Date.now() - lastScanAt));
autoRefreshTimer = setTimeout(() => { autoRefreshTimer = null;
runAutoRefresh(immediate); }, delay);
if (typeof autoRefreshTimer.unref === 'function') autoRefreshTimer.unref(); }
function runAutoRefresh(force = false) { if (disposed || !currentVisible) return;
if (!force && Date.now() - lastScanAt < refreshIntervalMs) { scheduleAutoRefresh(); return; }
try { publishResult(stampAndCompute({ auto: true })); } catch (err) {
if (typeof log === 'function') { try { log(`warn: Auto refresh failed: ${err?.message || err}`); } catch (_) {} } }
scheduleAutoRefresh(); }
const actions = { async getSummary(payload = {}) {
const explicit = Boolean(payload && (payload.range !== undefined || payload.accountFilter !== undefined));
const result = stampAndCompute(payload);
if (explicit && payload.auto !== true) { await savePreferences(); }
return result;
} };
function update(context = {}) { if (disposed) return;
const nextVisible = typeof context?.visible === 'boolean' ? context.visible : currentVisible;
const becameVisible = nextVisible && !currentVisible;
currentVisible = nextVisible;
if (!currentVisible) { clearAutoRefresh(); return; }
scheduleAutoRefresh({ immediate: becameVisible }); }
scheduleAutoRefresh();
return { actions, async call(method, args = {}) { if (typeof actions[method] === 'function') {
return await actions[method](args); }
throw new Error(`Unknown method: ${method}`);
}, update, dispose() { disposed = true; clearAutoRefresh(); } }; }
module.exports = {
  ...scanner,
  ...attr,
  activate,
  loadArchivedSessions,
  aggregateAccountUsage,
  discoverKnownAntigravityAccounts: scanner.discoverAccounts,
  discoverActiveAntigravityAccount: scanner.discoverCurrentAccount
};
