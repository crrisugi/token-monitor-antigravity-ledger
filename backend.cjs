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
  discoverAccounts, discoverCurrentAccount
} = scanner;
const {
  quotaGroupForModel, toEpochMs, buildQuotaAttributionWindows, createDefaultLedger,
  normalizeLedger, loadLedger, saveLedger, recordAccountHeartbeat,
  attributeCallRecord,
  emptyMetrics, emptyAccountBucket, cloneMetrics, hasActiveTodayPeriod,
  extractSessionTimestamp, resolveSessionDate, extractSessionMetrics, subtractMetrics,
  syncActiveAccountSessions, attributeSession, extractObsMetrics, addUsageToBucket
} = attr;
function aggregateAccountUsage(args = {}, options = {}) { const { calls = null, sessions = [], dailyHistory = [],
range = null, accountFilter = 'all', discoveredAccounts = []
} = args;
const ledger = args.ledger || options.ledger || createDefaultLedger();
const quotaWindows = args.quotaWindows || options.quotaWindows || buildQuotaAttributionWindows(discoveredAccounts, options);
const filter = normalizeEmail(accountFilter) || 'all';
let startDay = range?.start ? normalizeDate(range.start) : null;
let endDay = range?.end ? normalizeDate(range.end) : null;
if (startDay && endDay && startDay > endDay) { const tmp = startDay;
startDay = endDay;
endDay = tmp; }
const byAccount = {};
function getOrCreateAccount(email, displayName = '') {
const norm = email === 'unattributed' ? 'unattributed' : normalizeEmail(email);
if (!norm) return emptyAccountBucket('unattributed');
if (!byAccount[norm]) { byAccount[norm] = emptyAccountBucket(norm, displayName);
} else if (displayName && displayName !== norm && (!byAccount[norm].displayName || byAccount[norm].displayName === norm)) {
byAccount[norm].displayName = displayName; }
return byAccount[norm]; }
for (const acc of discoveredAccounts) { const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
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
} else if (dailyHistory && typeof dailyHistory === 'object' && dailyHistory.days) {
for (const [dayKey, dayObj] of Object.entries(dailyHistory.days)) { if (dayObj && dayObj.observations) {
for (const obs of Object.values(dayObj.observations)) { if (obs && !obs.day && !obs.date) {
allDailyObservations.push({ ...obs, day: dayKey }); } else { allDailyObservations.push(obs); } } } } }
const hasDailyHistory = allDailyObservations.length > 0;
if (!hasDailyHistory) { if (Array.isArray(sessions)) { for (const session of sessions) {
if (!isAntigravityClient(session?.client)) continue;
const sessionDate = resolveSessionDate(session);
if (sessionDate) { if (startDay && sessionDate < startDay) continue;
if (endDay && sessionDate > endDay) continue; }
const startedAt = extractSessionTimestamp(session);
const hasToday = hasActiveTodayPeriod(session);
const isEligible = Boolean(
hasToday || (startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt)
);
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
if (isEligible && binding?.allocations && Object.keys(binding.allocations).length > 0) {
for (const [allocEmail, allocMetrics] of Object.entries(binding.allocations)) {
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics); } } else {
const attr = attributeSession(session, ledger, { bindNewSessions: options.bindNewSessions ?? false, quotaWindows
});
const sMetrics = extractSessionMetrics(session, { preferAllTime: true });
addUsageToBucket(getOrCreateAccount(attr.email), sMetrics); } } } } else { const filteredObservations = [];
for (const obs of allDailyObservations) { if (!isAntigravityClient(obs?.client)) continue;
const obsDate = normalizeDate(obs.day || obs.date);
if (obsDate) { if (startDay && obsDate < startDay) continue;
if (endDay && obsDate > endDay) continue; }
filteredObservations.push(obs); }
const postActSessionsByDay = new Map();
if (Array.isArray(sessions)) { for (const session of sessions) {
if (!isAntigravityClient(session?.client)) continue;
const startedAt = extractSessionTimestamp(session);
const hasToday = hasActiveTodayPeriod(session);
const isPostActivation = Boolean(
hasToday || (startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt)
);
const isManualBinding = session.sessionId && ledger.sessionAccounts?.[session.sessionId]?.source === 'manual';
if (!isPostActivation && !isManualBinding) continue;
const sessionDate = resolveSessionDate(session);
if (sessionDate) { if (startDay && sessionDate < startDay) continue;
if (endDay && sessionDate > endDay) continue; }
const dayKey = sessionDate || 'unknown';
if (!postActSessionsByDay.has(dayKey)) { postActSessionsByDay.set(dayKey, []); }
postActSessionsByDay.get(dayKey).push(session); } }
const obsByDay = new Map();
for (const obs of filteredObservations) { const d = normalizeDate(obs.day || obs.date) || 'unknown';
if (!obsByDay.has(d)) obsByDay.set(d, []);
obsByDay.get(d).push(obs); }
for (const [d, dayObsList] of obsByDay.entries()) { const dayTotal = { totalTokens: 0, costUsd: 0, inputTokens: 0,
outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, models: {} };
for (const obs of dayObsList) { addUsageToBucket(dayTotal, extractObsMetrics(obs)); }
const daySessions = postActSessionsByDay.get(d) || [];
const subTotal = { totalTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
cacheWriteTokens: 0, reasoningTokens: 0, models: {} };
for (const session of daySessions) {
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
if (binding?.allocations && Object.keys(binding.allocations).length > 0) {
for (const [allocEmail, allocMetrics] of Object.entries(binding.allocations)) {
if (allocEmail === 'unattributed') continue;
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
addUsageToBucket(subTotal, allocMetrics); } } else { const sAttr = attributeSession(session, ledger, {
bindNewSessions: options.bindNewSessions ?? false, quotaWindows });
const sMetrics = extractSessionMetrics(session, { preferToday: hasActiveTodayPeriod(session) });
addUsageToBucket(getOrCreateAccount(sAttr.email), sMetrics);
addUsageToBucket(subTotal, sMetrics); } }
const rem = subtractMetrics(dayTotal, subTotal);
if (rem.totalTokens > 0 || rem.costUsd > 0) {
addUsageToBucket(getOrCreateAccount('unattributed'), rem); } }
for (const [d, daySessions] of postActSessionsByDay.entries()) { if (obsByDay.has(d)) continue;
for (const session of daySessions) {
const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
if (binding?.allocations && Object.keys(binding.allocations).length > 0) {
for (const [allocEmail, allocMetrics] of Object.entries(binding.allocations)) {
addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics); } } else {
const sAttr = attributeSession(session, ledger, { bindNewSessions: options.bindNewSessions ?? false, quotaWindows
});
const sMetrics = extractSessionMetrics(session, { preferAllTime: true });
addUsageToBucket(getOrCreateAccount(sAttr.email), sMetrics); } } } } }
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
function loadArchivedSessions(appDataRoot) { const sessions = [];
if (DatabaseSync) { const dbPath = path.join(appDataRoot, 'session-usage-archive.sqlite');
if (fs.existsSync(dbPath)) { try { const db = new DatabaseSync(dbPath, { readOnly: true });
try { try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
const rows = db.prepare('SELECT entry_json FROM sessions').all();
for (const row of rows) { try { const entry = JSON.parse(row.entry_json);
if (entry && isAntigravityClient(entry.client)) { sessions.push(entry); } } catch (_) {} }
} finally { try { db.close(); } catch (_) {} } } catch (_) {} } }
const archiveDir = path.join(appDataRoot, 'tokscale-cache', 'antigravity-archive');
if (fs.existsSync(archiveDir)) { try { const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
for (const entry of entries) { if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
const filePath = path.join(archiveDir, entry.name);
const data = readJson(filePath, null);
if (!data || typeof data !== 'object') continue;
if (Array.isArray(data.sessions)) { for (const s of data.sessions) {
if (s && typeof s === 'object') sessions.push({ client: 'antigravity', ...s }); }
} else if (data.sessionId || data.totalTokens || data.tokens || data.periods) { sessions.push({
client: 'antigravity', sessionId: data.sessionId || entry.name.replace(/\.json$/i, ''), ...data }); } }
} catch (_) {} }
return sessions; }
async function activate({ dataDirectory, storage, homeDir, conversationDirs, conversationSources, publish } = {}) {
const hostDataDir = getSharedDataDir();
const pluginDataDir = dataDirectory || path.join(hostDataDir, 'plugin-data', 'antigravity-account-ledger');
try { fs.mkdirSync(pluginDataDir, { recursive: true }); } catch (_) {}
const pluginLedgerFile = path.join(pluginDataDir, DEFAULT_LEDGER_FILENAME);
const hostLedgerFile = path.join(hostDataDir, DEFAULT_LEDGER_FILENAME);
const dbCacheFile = path.join(pluginDataDir, DEFAULT_DB_CACHE_FILENAME);
const preferencesFile = path.join(pluginDataDir, 'preferences.json');
let currentFilter = 'all';
let currentRange = null;
function applyPreferences(prefs) { if (!prefs || typeof prefs !== 'object') return;
if (prefs.accountFilter) currentFilter = prefs.accountFilter;
if (prefs.range) currentRange = prefs.range; }
applyPreferences(readJson(preferencesFile, null));
if (storage && typeof storage.get === 'function') { try {
applyPreferences(await storage.get('preferences')); } catch (_) {} }
function resolveLedger() { if (fs.existsSync(pluginLedgerFile)) {
return { ledger: loadLedger(pluginLedgerFile), ledgerFile: pluginLedgerFile }; }
if (fs.existsSync(hostLedgerFile)) { const migrated = loadLedger(hostLedgerFile);
saveLedger(migrated, pluginLedgerFile);
return { ledger: migrated, ledgerFile: pluginLedgerFile }; }
return { ledger: loadLedger(pluginLedgerFile), ledgerFile: pluginLedgerFile }; }
function computeSummary(payload = {}) { if (payload.accountFilter !== undefined) {
currentFilter = payload.accountFilter || 'all'; }
if (payload.range !== undefined) { currentRange = payload.range || null; }
const { ledger, ledgerFile } = resolveLedger();
const settings = readJson(path.join(hostDataDir, 'settings.json'), {});
const discoveredAccounts = discoverAccounts({ homeDir, settings });
const activeAccount = discoverCurrentAccount({ homeDir, settings });
if (activeAccount && activeAccount.email) {
recordAccountHeartbeat(activeAccount, new Date().toISOString(), ledger, ledgerFile); }
const quotaWindows = buildQuotaAttributionWindows(discoveredAccounts, { homeDir });
const calls = scanAllConversationDbs({ homeDir, conversationDirs, conversationSources, cacheFile: dbCacheFile });
const dailyHistory = readJson(path.join(hostDataDir, 'daily-history-archive.json'), null)
|| readJson(path.join(hostDataDir, 'daily-usage-history.json'), { days: {} });
const sessions = loadArchivedSessions(hostDataDir);
if (activeAccount && activeAccount.email && sessions.length > 0) {
syncActiveAccountSessions(sessions, activeAccount, ledger, { ledgerFile, save: true }); }
const summary = aggregateAccountUsage( { calls: calls.length > 0 ? calls : null, sessions, dailyHistory,
range: currentRange, accountFilter: currentFilter, discoveredAccounts, ledger, quotaWindows
}, { ledger, quotaWindows, bindNewSessions: true }
);
const resolvedActive = activeAccount
|| (ledger.lastActiveAccount ? { email: ledger.lastActiveAccount, source: 'ledger_last_active' } : null);
return { summary, ...summary, activeAccount: resolvedActive, discoveredAccounts, ledger,
featureActivatedAt: ledger.featureActivatedAt,
range: currentRange, scannerStats: { source: calls.length > 0 ? 'sqlite_protobuf_calls' : 'daily_history_fallback',
totalCalls: calls.length
}, updatedAt: new Date().toISOString() }; }
async function savePreferences() { const prefs = { accountFilter: currentFilter, range: currentRange };
if (storage && typeof storage.set === 'function') { try { await storage.set('preferences', prefs); } catch (_) {} }
try { writeJsonAtomic(preferencesFile, prefs); } catch (_) {} }
const actions = { async getSummary(payload = {}) { const result = computeSummary(payload);
await savePreferences();
if (typeof publish === 'function') { try { publish(result); } catch (_) {} }
return result;
} };
return { actions, async call(method, args = {}) { if (typeof actions[method] === 'function') {
return await actions[method](args); }
throw new Error(`Unknown method: ${method}`);
}, dispose() {} }; }
module.exports = {
  ...scanner,
  ...attr,
  activate,
  loadArchivedSessions,
  aggregateAccountUsage,
  discoverKnownAntigravityAccounts: scanner.discoverAccounts,
  discoverActiveAntigravityAccount: scanner.discoverCurrentAccount
};
