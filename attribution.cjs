'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const scanner = require('./scanner.cjs');
const { DatabaseSync, DEFAULT_LEDGER_FILENAME, DEFAULT_DB_CACHE_FILENAME, MODEL_ENUM_MAP, DISPLAY_NAME_TO_CANONICAL, MODEL_PRICING, normalizeEmail, normalizeDate, isAntigravityClient, getTempDir, getSharedDataDir, readJson, writeJsonAtomic, parseProto, fVal, fStr, unpackVarints, decodeTimestamp, parseUsageStats, resolveModelAndPrice, openConversationDbWithFallback, scanConversationDb, scanAllConversationDbs, extractEmailFromUserStatusValue, discoverFromTools, discoverCliLogWindows, discoverToolsTokenStatsWindows, discoverAccounts, discoverCurrentAccount, detectActiveAccount } = scanner;
function quotaGroupForModel(modelId) { const m = String(modelId || '').trim().toLowerCase();
if (m.startsWith('claude') || m.startsWith('gpt') || m.includes('claude') || m.includes('gpt')) {
return '3p-weekly'; }
if (m.startsWith('gemini') || m.includes('gemini') || m.includes('argon')) { return 'gemini-weekly'; }
return 'gemini-weekly'; }
function toEpochMs(val) { if (val === null || val === undefined || val === '') return 0;
if (typeof val === 'number' && Number.isFinite(val)) {
return val > 20_000_000_000 ? Math.round(val) : Math.round(val * 1000); }
const parsed = Date.parse(String(val));
return Number.isFinite(parsed) ? parsed : 0; }
function buildQuotaAttributionWindows(accounts = [], options = {}) {
const sourceAccounts = Array.isArray(accounts) && accounts.length > 0
? accounts
: discoverFromTools(options).accounts;
const byGroup = { 'gemini-weekly': [], '3p-weekly': [] };
const seenAccountGroup = new Set();
for (const acc of sourceAccounts) { const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
if (!email || !acc || typeof acc !== 'object') continue;
const quota = acc.quota;
if (!quota || typeof quota !== 'object') continue;
const createdAtMs = toEpochMs(acc.created_at ?? acc.createdAt ?? 0);
const lastUsedMs = Math.max( toEpochMs(acc.last_used ?? acc.lastUsed ?? 0),
toEpochMs(quota.last_updated ?? quota.lastUpdated ?? 0)
);
const groupStats = new Map();
const recordGroupStat = (groupKey, remainingFraction, resetTimeStr) => { const resetMs = toEpochMs(resetTimeStr);
if (!resetMs) return;
const frac = typeof remainingFraction === 'number' && Number.isFinite(remainingFraction)
? remainingFraction
: 1.0;
const cur = groupStats.get(groupKey);
if (!cur || frac < cur.remainingFraction) { groupStats.set(groupKey, { remainingFraction: frac, resetMs }); } };
if (Array.isArray(quota.quota_groups)) { for (const grp of quota.quota_groups) {
const disp = String(grp?.display_name || '').toLowerCase();
for (const b of Array.isArray(grp?.buckets) ? grp.buckets : []) {
const bid = String(b?.bucket_id || '').toLowerCase();
const win = String(b?.window || '').toLowerCase();
if (bid === 'gemini-weekly' || (win === 'weekly' && disp.includes('gemini'))) {
recordGroupStat('gemini-weekly', b.remaining_fraction ?? b.remainingFraction, b.reset_time ?? b.resetTime);
} else if (bid === '3p-weekly' || (win === 'weekly' && (disp.includes('claude') || disp.includes('gpt')))) {
recordGroupStat('3p-weekly', b.remaining_fraction ?? b.remainingFraction, b.reset_time ?? b.resetTime); } } } }
if (Array.isArray(quota.models)) { for (const m of quota.models) {
const mName = m?.name || m?.modelId || m?.display_name || m?.model || '';
const groupKey = quotaGroupForModel(mName);
let frac = 1.0;
if (typeof m?.remaining_fraction === 'number') frac = m.remaining_fraction;
else if (typeof m?.remainingFraction === 'number') frac = m.remainingFraction;
else if (typeof m?.percentage === 'number') frac = m.percentage / 100;
recordGroupStat(groupKey, frac, m?.reset_time ?? m?.resetTime); } }
for (const [groupKey, stat] of groupStats.entries()) { const dedupKey = `${email}:${groupKey}`;
if (seenAccountGroup.has(dedupKey)) continue;
seenAccountGroup.add(dedupKey);
const sevenDaysMs = 7 * 86400_000;
const startMs = Math.max(createdAtMs, stat.resetMs - sevenDaysMs);
const endMs = lastUsedMs > startMs ? lastUsedMs : stat.resetMs;
if (endMs < startMs) continue;
byGroup[groupKey].push({ email, group: groupKey, startMs, endMs, resetMs: stat.resetMs,
remainingFraction: stat.remainingFraction, consumed: stat.remainingFraction < 0.999999 }); } }
byGroup.cliLogWindows = discoverCliLogWindows(options);
byGroup.toolsUsageWindows = discoverToolsTokenStatsWindows(options);
return byGroup; }
function createDefaultLedger(activatedAt = new Date().toISOString()) { return { version: 1,
featureActivatedAt: activatedAt, lastActiveAccount: null, timeline: [], attributionRules: [], sessionAccounts: {}
}; }
function normalizeAttributionRules(rules) { if (!Array.isArray(rules)) return [];
const out = [];
for (const r of rules) { if (!r || typeof r !== 'object') continue;
const email = normalizeEmail(r.email || r.accountEmail);
let startDate = normalizeDate(r.startDate || r.start);
let endDate = normalizeDate(r.endDate || r.end);
if (!email || email === 'all' || email === 'unattributed' || !startDate || !endDate) continue;
if (startDate > endDate) { const tmp = startDate;
startDate = endDate;
endDate = tmp; }
out.push({ id: r.id || `rule-${startDate}-${endDate}-${email}`, startDate, endDate, email,
createdAt: r.createdAt || new Date().toISOString() }); }
return out; }
function normalizeLedger(loaded) { return { version: 1,
featureActivatedAt: loaded?.featureActivatedAt || new Date().toISOString(),
lastActiveAccount: loaded?.lastActiveAccount || null,
timeline: Array.isArray(loaded?.timeline) ? loaded.timeline : [],
attributionRules: normalizeAttributionRules(loaded?.attributionRules || loaded?.dateRangeRules),
sessionAccounts: (loaded?.sessionAccounts && typeof loaded.sessionAccounts === 'object') ? loaded.sessionAccounts : {}
}; }
function loadLedger(ledgerFile) { const loaded = readJson(ledgerFile, null);
if (loaded && typeof loaded === 'object') { return normalizeLedger(loaded); }
const defaultLedger = createDefaultLedger();
if (ledgerFile) { try { writeJsonAtomic(ledgerFile, defaultLedger); } catch (_) {} }
return defaultLedger; }
function saveLedger(ledger, ledgerFile) { const normalized = normalizeLedger(ledger);
if (ledgerFile && typeof ledgerFile === 'string') { writeJsonAtomic(ledgerFile, normalized); }
return true; }
function recordAccountHeartbeat(activeAccount, timestamp, ledger, ledgerFile) {
const email = normalizeEmail(typeof activeAccount === 'string' ? activeAccount : activeAccount?.email);
if (!email) return { changed: false, ledger };
const source = (typeof activeAccount === 'object' && activeAccount?.source) || 'heartbeat';
const ts = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
let changed = false;
if (!Array.isArray(ledger.timeline)) { ledger.timeline = []; }
const lastInterval = ledger.timeline[ledger.timeline.length - 1];
if (!lastInterval) { ledger.timeline.push({ email, startedAt: ts, endedAt: null, source });
ledger.lastActiveAccount = email;
changed = true; } else if (lastInterval.email !== email) {
if (!lastInterval.endedAt || lastInterval.endedAt < ts) { lastInterval.endedAt = ts; }
ledger.timeline.push({ email, startedAt: ts, endedAt: null, source });
ledger.lastActiveAccount = email;
changed = true; } else { ledger.lastActiveAccount = email;
if (lastInterval.endedAt && ts > lastInterval.endedAt) {
ledger.timeline.push({ email, startedAt: ts, endedAt: null, source });
changed = true; } }
if (changed && ledgerFile) { saveLedger(ledger, ledgerFile); }
return { changed, ledger }; }
function assignDateRange(args = {}, ledger, ledgerFile = null) {
if (!ledger) throw new Error('Ledger is required');
const email = normalizeEmail(args.email || args.accountEmail);
let startDate = normalizeDate(args.startDate || args.start || args.range?.start);
let endDate = normalizeDate(args.endDate || args.end || args.range?.end);
if (!email || email === 'all' || email === 'unattributed') {
throw new Error('A valid target account email is required'); }
if (!startDate || !endDate) { throw new Error('Both startDate and endDate are required'); }
if (startDate > endDate) { const tmp = startDate;
startDate = endDate;
endDate = tmp; }
if (!Array.isArray(ledger.attributionRules)) { ledger.attributionRules = []; }
const nowIso = new Date().toISOString();
let rule = ledger.attributionRules.find((r) => r.startDate === startDate && r.endDate === endDate);
if (rule) { rule.email = email;
rule.createdAt = nowIso; } else { rule = { id: args.id || `rule-${startDate}-${endDate}-${Date.now()}`, startDate,
endDate, email, createdAt: nowIso };
ledger.attributionRules.push(rule); }
if (ledgerFile) { saveLedger(ledger, ledgerFile); }
return { changed: true, rule, ledger }; }
function removeDateRangeRule(args = {}, ledger, ledgerFile = null) {
if (!ledger || !Array.isArray(ledger.attributionRules)) { return { changed: false, ledger }; }
const id = args.id || args.ruleId || null;
const startDate = normalizeDate(args.startDate || args.start);
const endDate = normalizeDate(args.endDate || args.end);
const beforeLen = ledger.attributionRules.length;
ledger.attributionRules = ledger.attributionRules.filter((r) => { if (id && r.id === id) return false;
if (!id && startDate && endDate && r.startDate === startDate && r.endDate === endDate) return false;
return true; });
const changed = ledger.attributionRules.length !== beforeLen;
if (changed && ledgerFile) { saveLedger(ledger, ledgerFile); }
return { changed, ledger }; }
function attributeCallRecord(call, options = {}) { const ledger = options.ledger;
const quotaWindows = options.quotaWindows;
const tsMs = typeof call?.timestampMs === 'number' && Number.isFinite(call.timestampMs)
? call.timestampMs
: toEpochMs(call?.callTimestamp ? call.callTimestamp * 1000 : (call?.timestamp || call?.startedAt || call?.day));
const callDay = call?.day || normalizeDate(tsMs);
const convId = call?.conversationId || call?.sessionId;
if (convId && ledger?.sessionAccounts?.[convId]?.source === 'manual' && ledger.sessionAccounts[convId].email) {
return { email: normalizeEmail(ledger.sessionAccounts[convId].email), source: 'manual', layer: 2,
isUnattributed: false }; }
if (tsMs > 0 && Array.isArray(ledger?.timeline)) { for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
const interval = ledger.timeline[i];
const startMs = toEpochMs(interval?.startedAt);
const endMs = interval?.endedAt ? toEpochMs(interval.endedAt) : Infinity;
if (startMs > 0 && startMs <= tsMs && tsMs <= endMs) { return { email: normalizeEmail(interval.email),
source: interval.source || 'timeline', layer: 1, isUnattributed: false }; } } }
if (callDay && Array.isArray(ledger?.attributionRules)) {
for (let i = ledger.attributionRules.length - 1; i >= 0; i -= 1) { const rule = ledger.attributionRules[i];
if (rule.startDate <= callDay && callDay <= rule.endDate) { return { email: normalizeEmail(rule.email),
source: 'attribution_rule', ruleId: rule.id, layer: 2, isUnattributed: false }; } } }
if (tsMs > 0 && quotaWindows && typeof quotaWindows === 'object') {
if (call?.source === 'antigravity-cli' && Array.isArray(quotaWindows.cliLogWindows)) {
for (let i = quotaWindows.cliLogWindows.length - 1; i >= 0; i -= 1) {
const cw = quotaWindows.cliLogWindows[i];
if (cw.startMs <= tsMs && tsMs <= cw.endMs) { return { email: normalizeEmail(cw.email),
source: 'cli_log', layer: 3, isUnattributed: false }; } } }
if (Array.isArray(quotaWindows.toolsUsageWindows)) {
for (let i = quotaWindows.toolsUsageWindows.length - 1; i >= 0; i -= 1) {
const tw = quotaWindows.toolsUsageWindows[i];
if (tw.startMs <= tsMs && tsMs <= tw.endMs) { return { email: normalizeEmail(tw.email),
source: 'tools_token_stats', layer: 3, isUnattributed: false }; } } }
const groupKey = quotaGroupForModel(call?.model);
const candidateGroups = [groupKey];
const mLower = String(call?.model || '').toLowerCase();
if (!mLower.startsWith('gemini') && !mLower.startsWith('claude') && !mLower.startsWith('gpt')) {
candidateGroups.push(groupKey === 'gemini-weekly' ? '3p-weekly' : 'gemini-weekly'); }
for (const gk of candidateGroups) { const groupList = Array.isArray(quotaWindows[gk]) ? quotaWindows[gk] : [];
const consumedInGroup = groupList.filter((w) => w.consumed);
const matchingConsumed = consumedInGroup.filter((w) => w.startMs <= tsMs && tsMs <= w.endMs);
if (matchingConsumed.length === 1) { return { email: normalizeEmail(matchingConsumed[0].email),
source: 'quota_anchor', layer: 3, isUnattributed: false }; } } }
return { email: 'unattributed', source: 'unattributed', layer: 4, isUnattributed: true }; }
function emptyMetrics() { return { tokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
cacheWriteTokens: 0, reasoningTokens: 0 }; }
function emptyAccountBucket(email, displayName = '') { return { email,
displayName: displayName || (email === 'unattributed' ? '历史汇总（未归属）' : email), totalTokens: 0, costUsd: 0,
inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, percentageOfTotal: 0,
models: {} }; }
function cloneMetrics(m) { if (!m) return null;
const models = {};
if (m.models) { for (const [k, v] of Object.entries(m.models)) { models[k] = { ...v }; } }
return { totalTokens: m.totalTokens || 0, costUsd: m.costUsd || 0, inputTokens: m.inputTokens || 0,
outputTokens: m.outputTokens || 0, cacheReadTokens: m.cacheReadTokens || 0,
cacheWriteTokens: m.cacheWriteTokens || 0, reasoningTokens: m.reasoningTokens || 0, models }; }
function hasActiveTodayPeriod(session) { if (!session?.periods?.today) return false;
const p = session.periods.today;
const tokens = Number(p.totalTokens || p.tokens || 0);
const cost = Number(p.costUsd || p.cost || 0);
return tokens > 0 || cost > 0; }
function extractSessionTimestamp(session) { if (!session || typeof session !== 'object') return '';
const ts = session.startedAt
|| session.periods?.allTime?.startedAt
|| session.periods?.month?.startedAt
|| session.periods?.today?.startedAt
|| session.lastUsedAt
|| session.periods?.allTime?.lastUsedAt
|| '';
return typeof ts === 'string' ? ts : ''; }
function resolveSessionDate(session) { if (!session || typeof session !== 'object') return '';
if (hasActiveTodayPeriod(session) && session.day) { return normalizeDate(session.day); }
if (session.periods && !hasActiveTodayPeriod(session)) {
return normalizeDate(extractSessionTimestamp(session) || session.periods?.allTime?.lastUsedAt || session.day); }
return normalizeDate(session.day || extractSessionTimestamp(session) || session.lastUsedAt); }
function extractSessionMetrics(session, options = {}) {
const target = (options.preferToday && hasActiveTodayPeriod(session) && !options.preferAllTime)
? session.periods.today
: (session?.periods?.allTime || session?.periods?.month || session?.periods?.today || session || {});
const totalTokens = Number(target.totalTokens || target.tokens || 0);
const costUsd = Number(target.costUsd || target.cost || 0);
const inputTokens = Number(target.inputTokens || 0);
const outputTokens = Number(target.outputTokens || 0);
const cacheReadTokens = Number(target.cacheReadTokens || 0);
const cacheWriteTokens = Number(target.cacheWriteTokens || 0);
const reasoningTokens = Number(target.reasoningTokens || 0);
const models = {};
const modelCosts = target.modelCosts || (target !== session ? session?.modelCosts : null) || {};
if (target.models && typeof target.models === 'object' && Object.keys(target.models).length > 0) {
const modelEntries = Object.entries(target.models);
for (const [modelId, modelTokens] of modelEntries) { const mTokens = Number(modelTokens || 0);
const mCost = Number(modelCosts[modelId] || 0);
if (!models[modelId]) models[modelId] = emptyMetrics();
const m = models[modelId];
m.tokens += mTokens;
m.costUsd += mCost;
const ratio = (totalTokens > 0 && modelEntries.length > 1) ? (mTokens / totalTokens) : 1;
m.inputTokens += Math.round(inputTokens * ratio);
m.outputTokens += Math.round(outputTokens * ratio);
m.cacheReadTokens += Math.round(cacheReadTokens * ratio);
m.cacheWriteTokens += Math.round(cacheWriteTokens * ratio);
m.reasoningTokens += Math.round(reasoningTokens * ratio); } } else {
const modelId = target.modelId || target.model || session?.modelId || session?.model || 'unknown';
if (!models[modelId]) models[modelId] = emptyMetrics();
const m = models[modelId];
m.tokens += totalTokens;
m.costUsd += costUsd;
m.inputTokens += inputTokens;
m.outputTokens += outputTokens;
m.cacheReadTokens += cacheReadTokens;
m.cacheWriteTokens += cacheWriteTokens;
m.reasoningTokens += reasoningTokens; }
return { totalTokens, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
models }; }
function subtractMetrics(totalM, subM) { const res = {
totalTokens: Math.max(0, (totalM.totalTokens || 0) - (subM.totalTokens || 0)),
costUsd: Number(Math.max(0, (totalM.costUsd || 0) - (subM.costUsd || 0)).toFixed(6)),
inputTokens: Math.max(0, (totalM.inputTokens || 0) - (subM.inputTokens || 0)),
outputTokens: Math.max(0, (totalM.outputTokens || 0) - (subM.outputTokens || 0)),
cacheReadTokens: Math.max(0, (totalM.cacheReadTokens || 0) - (subM.cacheReadTokens || 0)),
cacheWriteTokens: Math.max(0, (totalM.cacheWriteTokens || 0) - (subM.cacheWriteTokens || 0)),
reasoningTokens: Math.max(0, (totalM.reasoningTokens || 0) - (subM.reasoningTokens || 0)), models: {} };
for (const [modelId, mm] of Object.entries(totalM.models || {})) {
const sm = subM.models?.[modelId] || emptyMetrics();
const t = Math.max(0, mm.tokens - sm.tokens);
const c = Number(Math.max(0, mm.costUsd - sm.costUsd).toFixed(6));
if (t > 0 || c > 0) { res.models[modelId] = { tokens: t, costUsd: c,
inputTokens: Math.max(0, mm.inputTokens - sm.inputTokens),
outputTokens: Math.max(0, mm.outputTokens - sm.outputTokens),
cacheReadTokens: Math.max(0, mm.cacheReadTokens - sm.cacheReadTokens),
cacheWriteTokens: Math.max(0, mm.cacheWriteTokens - sm.cacheWriteTokens),
reasoningTokens: Math.max(0, mm.reasoningTokens - sm.reasoningTokens) }; } }
return res; }
function syncActiveAccountSessions(sessions, activeAccount, ledger, options = {}) {
const activeEmail = normalizeEmail(
typeof activeAccount === 'string' ? activeAccount : (activeAccount?.email || ledger?.lastActiveAccount)
);
if (!activeEmail || !Array.isArray(sessions) || !ledger) { return { changed: false, ledger }; }
let changed = false;
if (!ledger.sessionAccounts) { ledger.sessionAccounts = {}; }
for (const session of sessions) { if (!session || typeof session !== 'object' || !session.sessionId) continue;
if (session.client && !isAntigravityClient(session.client)) continue;
const startedAt = extractSessionTimestamp(session);
const hasToday = hasActiveTodayPeriod(session);
const isStartedPostActivation = Boolean(
startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt
);
const isEligible = Boolean(hasToday || isStartedPostActivation);
if (!isEligible) continue;
const allTimeMetrics = extractSessionMetrics(session, { preferAllTime: true });
const todayMetrics = hasToday ? extractSessionMetrics(session, { preferToday: true }) : allTimeMetrics;
const existing = ledger.sessionAccounts[session.sessionId];
const currentDay = resolveSessionDate(session);
if (!existing) { let targetEmail = activeEmail;
if (startedAt && Array.isArray(ledger.timeline)) { for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
const interval = ledger.timeline[i];
if (interval.startedAt <= startedAt && (!interval.endedAt || startedAt <= interval.endedAt)) {
targetEmail = normalizeEmail(interval.email);
break; } } }
const allocations = {};
if (!isStartedPostActivation && startedAt && ledger.featureActivatedAt && startedAt < ledger.featureActivatedAt && hasToday && allTimeMetrics.totalTokens > todayMetrics.totalTokens) {
const preMetrics = subtractMetrics(allTimeMetrics, todayMetrics);
if (preMetrics.totalTokens > 0 || preMetrics.costUsd > 0) { allocations.unattributed = preMetrics; }
allocations[targetEmail] = cloneMetrics(todayMetrics); } else {
const initialMetrics = isStartedPostActivation ? allTimeMetrics : todayMetrics;
allocations[targetEmail] = cloneMetrics(initialMetrics); }
ledger.sessionAccounts[session.sessionId] = { email: targetEmail, boundAt: options.now || new Date().toISOString(),
lastDay: currentDay || null,
source: (typeof activeAccount === 'object' && activeAccount?.source) || 'active_account',
lastSnapshot: cloneMetrics(allTimeMetrics), allocations };
changed = true; } else { if (!existing.allocations || !existing.lastSnapshot) {
const baseEmail = normalizeEmail(existing.email) || activeEmail;
existing.allocations = { [baseEmail]: cloneMetrics(allTimeMetrics) };
existing.lastSnapshot = cloneMetrics(allTimeMetrics);
existing.lastDay = currentDay || existing.lastDay || null;
changed = true; } else { const hasAllTimeObj = Boolean(session?.periods?.allTime);
const dayRolledOver = Boolean( !hasAllTimeObj
&& ((currentDay && existing.lastDay && currentDay > existing.lastDay)
|| allTimeMetrics.totalTokens < existing.lastSnapshot.totalTokens)
);
const baseline = dayRolledOver ? { totalTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
cacheWriteTokens: 0, reasoningTokens: 0, models: {}
} : existing.lastSnapshot;
if (allTimeMetrics.totalTokens > baseline.totalTokens || allTimeMetrics.costUsd > baseline.costUsd) {
const delta = subtractMetrics(allTimeMetrics, baseline);
if (!existing.allocations[activeEmail]) { existing.allocations[activeEmail] = { totalTokens: 0, costUsd: 0,
inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, models: {} }; }
const targetAlloc = existing.allocations[activeEmail];
addUsageToBucket(targetAlloc, delta);
existing.lastSnapshot = cloneMetrics(allTimeMetrics);
existing.lastDay = currentDay || existing.lastDay || null;
existing.email = activeEmail;
changed = true; } } } }
if (changed && options.save !== false) {
const targetFile = typeof options.ledgerFile === 'string' ? options.ledgerFile : null;
if (targetFile) saveLedger(ledger, targetFile); }
return { changed, ledger }; }
function attributeSession(session, ledger, options = {}) { if (!session || !ledger) {
return { email: 'unattributed', source: 'unattributed', isUnattributed: true }; }
const startedAt = extractSessionTimestamp(session);
const sessionDate = resolveSessionDate(session);
const hasToday = hasActiveTodayPeriod(session);
const isStartedPostActivation = Boolean(
startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt
);
const existingBinding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
if (existingBinding && existingBinding.source === 'manual' && existingBinding.email) { return {
email: normalizeEmail(existingBinding.email), source: 'manual', isUnattributed: false }; }
if (startedAt && Array.isArray(ledger.timeline)) { for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
const interval = ledger.timeline[i];
if (interval.startedAt <= startedAt && (!interval.endedAt || startedAt <= interval.endedAt)) {
const source = interval.source || 'timeline';
const normEmail = normalizeEmail(interval.email);
return { email: normEmail, source, isUnattributed: false }; } } }
if (sessionDate && Array.isArray(ledger.attributionRules)) {
for (let i = ledger.attributionRules.length - 1; i >= 0; i -= 1) { const rule = ledger.attributionRules[i];
if (rule.startDate <= sessionDate && sessionDate <= rule.endDate) { return { email: normalizeEmail(rule.email),
source: 'attribution_rule', isUnattributed: false }; } } }
if (startedAt && options.quotaWindows) {
const modelKeys = Object.keys(session?.periods?.allTime?.models || session?.models || {});
const primaryModel = modelKeys[0] || session?.modelId || session?.model || 'gemini-3.8-flash';
const callAttr = attributeCallRecord(
{ timestamp: startedAt, day: sessionDate, model: primaryModel, conversationId: session.sessionId },
{ ledger, quotaWindows: options.quotaWindows }
);
if (!callAttr.isUnattributed) { return callAttr; } }
if (!isStartedPostActivation && !hasToday) {
return { email: 'unattributed', source: 'unattributed', isUnattributed: true }; }
if (existingBinding && existingBinding.email) { return { email: normalizeEmail(existingBinding.email),
source: existingBinding.source || 'session_binding', isUnattributed: false }; }
const activeEmail = normalizeEmail( typeof options.activeAccount === 'string'
? options.activeAccount
: (options.activeAccount?.email || ledger.lastActiveAccount || ledger.timeline?.[ledger.timeline.length - 1]?.email)
);
if (activeEmail && (isStartedPostActivation || hasToday)) {
const source = (typeof options.activeAccount === 'object' && options.activeAccount?.source) || 'active_account';
return { email: activeEmail, source, isUnattributed: false }; }
return { email: 'unattributed', source: 'unattributed', isUnattributed: true }; }
function extractObsMetrics(obs) { const tokens = Number(obs.tokens || obs.totalTokens || 0);
const cost = Number(obs.cost || obs.costUsd || 0);
const inputTokens = Number(obs.inputTokens || 0);
const outputTokens = Number(obs.outputTokens || 0);
const cacheReadTokens = Number(obs.cacheReadTokens || 0);
const cacheWriteTokens = Number(obs.cacheWriteTokens || 0);
const reasoningTokens = Number(obs.reasoningTokens || 0);
const modelId = obs.modelId || obs.model || 'unknown';
const models = {};
models[modelId] = { tokens, costUsd: cost, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
reasoningTokens };
return { totalTokens: tokens, costUsd: cost, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
reasoningTokens, models }; }
function addUsageToBucket(bucket, usage) { bucket.totalTokens += usage.totalTokens || 0;
bucket.costUsd += usage.costUsd || 0;
bucket.inputTokens += usage.inputTokens || 0;
bucket.outputTokens += usage.outputTokens || 0;
bucket.cacheReadTokens += usage.cacheReadTokens || 0;
bucket.cacheWriteTokens += usage.cacheWriteTokens || 0;
bucket.reasoningTokens += usage.reasoningTokens || 0;
if (!bucket.models) bucket.models = {};
for (const [modelId, m] of Object.entries(usage.models || {})) {
if (!bucket.models[modelId]) bucket.models[modelId] = emptyMetrics();
const target = bucket.models[modelId];
target.tokens += m.tokens || 0;
target.costUsd += m.costUsd || 0;
target.inputTokens += m.inputTokens || 0;
target.outputTokens += m.outputTokens || 0;
target.cacheReadTokens += m.cacheReadTokens || 0;
target.cacheWriteTokens += m.cacheWriteTokens || 0;
target.reasoningTokens += m.reasoningTokens || 0; } }
module.exports = {
  extractObsMetrics, addUsageToBucket,
  quotaGroupForModel, toEpochMs, buildQuotaAttributionWindows, createDefaultLedger,
  normalizeAttributionRules, normalizeLedger, loadLedger, saveLedger, recordAccountHeartbeat,
  assignDateRange, removeDateRangeRule, attributeCallRecord,
  emptyMetrics, emptyAccountBucket, cloneMetrics, hasActiveTodayPeriod,
  extractSessionTimestamp, resolveSessionDate, extractSessionMetrics, subtractMetrics,
  syncActiveAccountSessions, attributeSession
};
