'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const proto = require('./protobuf.cjs');
const {
  DatabaseSync, DEFAULT_LEDGER_FILENAME, DEFAULT_DB_CACHE_FILENAME, GLOBAL_DB_SCAN_CACHE,
  MODEL_ENUM_MAP, DISPLAY_NAME_TO_CANONICAL, MODEL_PRICING,
  normalizeEmail, normalizeDate, toEpochMs, isAntigravityClient, getTempDir, getSharedDataDir, readJson, writeJsonAtomic,
  parseProto, fVal, fStr, unpackVarints, decodeTimestamp, decodeModelEnumPlaceholder, parseUsageStats,
  walChecksum, inspectWalBytes, resolveCanonicalPricingKey, resolveModelAndPrice, extractRetryEntries
} = proto;
const DB_CACHE_VERSION = 2;
function usageSignature(usage) { if (!usage) return '';
return [usage.modelEnum || 0, usage.inputTokens || 0, usage.outputTokens || 0, usage.cacheReadTokens || 0,
usage.cacheWriteTokens || 0, usage.thinkingTokens || 0, usage.responseId || ''].join(':'); }
function callUsageSignature(record) { if (!record) return '';
return [record.modelEnum || 0, record.inputTokens || 0, record.outputTokens || 0, record.cacheReadTokens || 0,
record.cacheWriteTokens || 0, record.reasoningTokens || 0].join(':'); }
function removeSnapshotDir(dir) { if (!dir) return;
// rmSync() can unlink the contents yet leave the directory behind on Windows, so remove the
// files first and only then the directory itself.
try { for (const name of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, name)); } catch (_) {} } } catch (_) {}
try { fs.rmdirSync(dir); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) {} }
function hasCorruptWalOrShm(dbPath) {
try {
const shmPath = `${dbPath}-shm`;
if (fs.existsSync(shmPath) && !fs.statSync(shmPath).isFile()) return true;
const walPath = `${dbPath}-wal`;
if (fs.existsSync(walPath)) {
const walStat = fs.statSync(walPath);
if (!walStat.isFile()) return true;
if (walStat.size > 0) {
if (walStat.size < 32) return true;
const fd = fs.openSync(walPath, 'r');
try {
const hdr = Buffer.alloc(4);
fs.readSync(fd, hdr, 0, 4, 0);
const magic = hdr.readUInt32BE(0);
if (magic !== 0x377f0682 && magic !== 0x377f0683) return true; } finally { fs.closeSync(fd); } } } }
catch (_) { return true; }
return false; }
function openConversationDbWithFallback(dbPath) { if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
let db = null;
try { if (hasCorruptWalOrShm(dbPath)) throw new Error('corrupt wal or shm');
db = new DatabaseSync(dbPath, { readOnly: true });
try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
return { db, close() { try { db.close(); } catch (_) {} } }; } catch (_) {
if (db) { try { db.close(); } catch (_) {} }
let tmpDir = null;
try { tmpDir = fs.mkdtempSync(path.join(getTempDir(), 'ag-db-snap-'));
const snapDb = path.join(tmpDir, path.basename(dbPath));
fs.copyFileSync(dbPath, snapDb);
const walPath = `${dbPath}-wal`;
if (fs.existsSync(walPath)) { const walStat = fs.statSync(walPath);
if (walStat.size > 0) { const snapWal = `${snapDb}-wal`;
fs.copyFileSync(walPath, snapWal);
let expectedPageSize = 0;
try { const fd = fs.openSync(snapDb, 'r');
try { const hdr = Buffer.alloc(100);
fs.readSync(fd, hdr, 0, 100, 0);
if (hdr.subarray(0, 16).toString('utf8') === 'SQLite format 3\0') { const rawPs = hdr.readUInt16BE(16);
expectedPageSize = rawPs === 1 ? 65536 : rawPs; } } finally { fs.closeSync(fd); } } catch (_) {}
const wbytes = fs.readFileSync(snapWal);
const walInfo = inspectWalBytes(wbytes, expectedPageSize);
if (walInfo.validConsistentWal && walInfo.committedEndOffset >= 32) {
fs.truncateSync(snapWal, walInfo.committedEndOffset);
} else { try { fs.unlinkSync(snapWal); } catch (_) {} } } }
const snapDbHandle = new DatabaseSync(snapDb, { readOnly: true });
try { snapDbHandle.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
try { snapDbHandle.exec('PRAGMA query_only = ON'); } catch (_) {}
return { db: snapDbHandle, close() { try { snapDbHandle.close(); } catch (_) {}
removeSnapshotDir(tmpDir); } }; } catch (_) {
removeSnapshotDir(tmpDir);
return null; } } }
function reclaimOrphanSnapshots() { const dir = getTempDir();
let names = [];
try { names = fs.readdirSync(dir); } catch (_) { return; }
const cutoff = Date.now() - 600_000;
for (const name of names) { if (!name.startsWith('ag-db-snap-')) continue;
const full = path.join(dir, name);
try { const st = fs.statSync(full);
if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
removeSnapshotDir(full); } catch (_) {} } }
function scanConversationDb(dbPath, sourceName = 'antigravity') {
const handle = openConversationDbWithFallback(dbPath);
if (!handle) return [];
const { db } = handle;
const conversationId = path.basename(dbPath, '.db');
let fallbackFileTs = null;
try { fallbackFileTs = fs.statSync(dbPath).mtimeMs / 1000; } catch (_) { fallbackFileTs = Date.now() / 1000; }
try { const stepsByIdx = new Map();
const stepsByDirectResp = new Map();
const stepsByRetryResp = new Map();
const stepsByGenIdx = new Map();
try { const stepRows = db.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx').all();
for (const row of stepRows) { const sidx = Number(row.idx);
const smeta = row.metadata;
if (!smeta || !smeta.length) continue;
let { out: smd } = parseProto(smeta);
let createdAt = decodeTimestamp(fVal(smd, 1, 2));
if (createdAt === null && fVal(smd, 4, 2)) { const { out: innerMeta } = parseProto(fVal(smd, 4, 2));
const innerTs = decodeTimestamp(fVal(innerMeta, 1, 2));
if (innerTs !== null) { createdAt = innerTs;
if (!fVal(smd, 9, 2) && fVal(innerMeta, 9, 2)) smd = innerMeta; } }
const startedAt = decodeTimestamp(fVal(smd, 5, 2));
const viewableAt = decodeTimestamp(fVal(smd, 6, 2));
const finishedAt = decodeTimestamp(fVal(smd, 7, 2));
const completedAt = decodeTimestamp(fVal(smd, 8, 2));
const effectiveTs = createdAt ?? startedAt ?? viewableAt ?? finishedAt ?? completedAt;
const su = parseUsageStats(fVal(smd, 9, 2));
const srNonzero = extractRetryEntries(smd.get(28) || []);
const stInfoBuf = fVal(smd, 20, 2);
let genIdxRef = null;
if (stInfoBuf) { const { out: stInfo } = parseProto(stInfoBuf);
genIdxRef = fVal(stInfo, 3, 0); }
const stepObj = { idx: sidx, stepType: row.step_type, status: row.status, createdAt: effectiveTs, usage: su,
retryEntries: srNonzero, generatorModelEnum: fVal(smd, 11, 0) || 0, requestedModelEnum: fVal(smd, 15, 0) || 0,
execId: fStr(smd, 12), genIdxRef };
stepsByIdx.set(sidx, stepObj);
if (su && su.responseId) { if (!stepsByDirectResp.has(su.responseId)) stepsByDirectResp.set(su.responseId, []);
stepsByDirectResp.get(su.responseId).push(stepObj); }
for (const sre of srNonzero) { const rid = sre.usage?.responseId;
if (rid) { if (!stepsByRetryResp.has(rid)) stepsByRetryResp.set(rid, []);
stepsByRetryResp.get(rid).push(stepObj); } }
if (genIdxRef !== null && genIdxRef !== undefined) {
if (!stepsByGenIdx.has(genIdxRef)) stepsByGenIdx.set(genIdxRef, []);
stepsByGenIdx.get(genIdxRef).push(stepObj); } } } catch (_) {}
const genUsageByRespId = new Set();
const consumedStepAttempts = new Map();
const consumedStepSignatures = new Map();
const genModelByIdx = new Map();
let lastConvModel = null;
const rawCalls = [];
try { const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
for (const row of genRows) { const gidx = Number(row.idx);
const gdata = row.data;
if (!gdata || !gdata.length) continue;
const { out: top } = parseProto(gdata, new Set([1, 2, 4]));
const cmBuf = fVal(top, 1, 2);
if (!cmBuf) continue;
let { out: cm } = parseProto(cmBuf, new Set([1, 3, 4, 9, 17, 19, 21, 22]));
if (!fVal(cm, 4, 2) && !(cm.get(17)?.length) && !fStr(cm, 19) && !fStr(cm, 21) && fVal(cm, 3, 2)) {
const { out: mid } = parseProto(fVal(cm, 3, 2));
if (fVal(mid, 1, 2)) { cm = parseProto(fVal(mid, 1, 2), new Set([1, 3, 4, 9, 17, 19, 21, 22])).out; } }
const usageBuf = fVal(cm, 4, 2) || (!fVal(cm, 3, 0) && fVal(cm, 1, 2) ? fVal(cm, 1, 2) : null);
const mainU = parseUsageStats(usageBuf);
const retryNonzero = extractRetryEntries(cm.get(17) || []);
const mainNz = Boolean(mainU && mainU.nonZero);
if (!mainNz && retryNonzero.length === 0) continue;
const stepIndices = [];
for (const [wt, val] of top.get(2) || []) { if (wt === 2) stepIndices.push(...unpackVarints(val));
else if (wt === 0) stepIndices.push(val); }
const execId = fStr(top, 4);
const cmModelEnum = fVal(cm, 3, 0) || 0;
const respModel = fStr(cm, 19);
const dispName = fStr(cm, 21);
let legacyChatStartTs = null;
const cstartBuf = fVal(cm, 9, 2);
if (cstartBuf) { const { out: cstart } = parseProto(cstartBuf, new Set([1, 4]));
legacyChatStartTs = decodeTimestamp(fVal(cstart, 4, 2)) ?? decodeTimestamp(fVal(cstart, 1, 2)); }
const chosenAttempts = retryNonzero.length > 0
? retryNonzero
: [{ attemptIndex: 0, usage: mainU }];
for (const att of chosenAttempts) { const au = att.usage;
if (!au || !au.nonZero) continue;
const rid = au.responseId || null;
if (rid) genUsageByRespId.add(`${au.apiProvider || 0}:${rid}`);
let callTs = null;
let matchedStepIdx = null;
let alignmentMode = 'gen_only';
if (rid) { const directCands = stepsByDirectResp.get(rid) || [];
const retryCands = stepsByRetryResp.get(rid) || [];
const cand = directCands[0] || retryCands[0];
if (cand && cand.createdAt !== null) { callTs = cand.createdAt;
matchedStepIdx = cand.idx;
alignmentMode = 'both'; } }
if (callTs === null && stepIndices.length > 0) { for (const sidx of stepIndices) {
const sObj = stepsByIdx.get(sidx);
if (sObj && sObj.createdAt !== null) { callTs = sObj.createdAt;
matchedStepIdx = sObj.idx;
alignmentMode = 'both';
break; } } }
if (callTs === null && stepsByGenIdx.has(gidx)) { const cands = stepsByGenIdx.get(gidx);
const found = cands.find((c) => c.createdAt !== null);
if (found) { callTs = found.createdAt;
matchedStepIdx = found.idx;
alignmentMode = 'both'; } }
if (callTs === null && stepsByIdx.has(gidx) && stepsByIdx.get(gidx).createdAt !== null) {
callTs = stepsByIdx.get(gidx).createdAt;
matchedStepIdx = gidx;
alignmentMode = 'both'; }
if (callTs === null && legacyChatStartTs !== null) { callTs = legacyChatStartTs; }
if (matchedStepIdx !== null) {
const signature = usageSignature(au);
consumedStepAttempts.set(`${matchedStepIdx}:${att.attemptIndex || 0}`, signature);
if (!consumedStepSignatures.has(matchedStepIdx)) consumedStepSignatures.set(matchedStepIdx, new Set());
consumedStepSignatures.get(matchedStepIdx).add(signature); }
const effEnum = au.modelEnum || cmModelEnum;
const mp = resolveModelAndPrice({ responseModel: respModel, displayName: dispName, modelEnum: effEnum,
fallbackModel: lastConvModel, inputTokens: au.inputTokens, cacheReadTokens: au.cacheReadTokens,
cacheWriteTokens: au.cacheWriteTokens, outputTokens: au.outputTokens });
if (mp.model && mp.model !== 'unknown' && !mp.model.startsWith('MODEL_')) {
lastConvModel = mp.model;
genModelByIdx.set(gidx, mp.model); }
rawCalls.push({ source: sourceName, conversationId, dbPath, originTable: 'gen_metadata', alignmentMode,
genIdx: gidx, stepIdx: matchedStepIdx ?? (stepIndices[0] ?? gidx), attemptIndex: att.attemptIndex || 0,
executionId: execId, responseId: rid, apiProvider: au.apiProvider || 0, model: mp.model, modelEnum: effEnum,
modelDisplayName: mp.modelDisplayName, inputTokens: au.inputTokens, outputTokens: au.outputTokens,
cacheReadTokens: au.cacheReadTokens, cacheWriteTokens: au.cacheWriteTokens, reasoningTokens: au.thinkingTokens,
totalTokens: au.inputTokens + au.outputTokens + au.cacheReadTokens + au.cacheWriteTokens, costUsd: mp.costUsd,
callTimestamp: callTs }); } } } catch (_) {}
for (const [sidx, stepObj] of stepsByIdx.entries()) { const su = stepObj.usage;
const srEntries = stepObj.retryEntries;
const suNz = Boolean(su && su.nonZero);
if (!suNz && srEntries.length === 0) continue;
const stepAttempts = srEntries.length > 0 ? srEntries : [{ attemptIndex: 0, usage: su }];
for (const att of stepAttempts) { const au = att.usage;
if (!au || !au.nonZero) continue;
const rid = au.responseId || null;
if (rid && genUsageByRespId.has(`${au.apiProvider || 0}:${rid}`)) continue;
const signature = usageSignature(au);
const attemptKey = `${sidx}:${att.attemptIndex || 0}`;
if (consumedStepAttempts.get(attemptKey) === signature
|| consumedStepSignatures.get(sidx)?.has(signature)) continue;
const effEnum = au.modelEnum || stepObj.generatorModelEnum || stepObj.requestedModelEnum;
const refModel = (stepObj.genIdxRef !== null && stepObj.genIdxRef !== undefined)
? genModelByIdx.get(stepObj.genIdxRef)
: null;
const fallbackModel = (!effEnum || !MODEL_ENUM_MAP[effEnum]) ? (refModel || lastConvModel || null) : null;
const mp = resolveModelAndPrice({ fallbackModel, displayName: null, modelEnum: effEnum,
inputTokens: au.inputTokens, cacheReadTokens: au.cacheReadTokens, cacheWriteTokens: au.cacheWriteTokens,
outputTokens: au.outputTokens });
rawCalls.push({ source: sourceName, conversationId, dbPath, originTable: 'steps', alignmentMode: 'step_only',
genIdx: stepObj.genIdxRef ?? null, stepIdx: sidx, attemptIndex: att.attemptIndex || 0, executionId: stepObj.execId,
responseId: rid, apiProvider: au.apiProvider || 0, model: mp.model, modelEnum: effEnum,
modelDisplayName: mp.modelDisplayName, inputTokens: au.inputTokens, outputTokens: au.outputTokens,
cacheReadTokens: au.cacheReadTokens, cacheWriteTokens: au.cacheWriteTokens, reasoningTokens: au.thinkingTokens,
totalTokens: au.inputTokens + au.outputTokens + au.cacheReadTokens + au.cacheWriteTokens, costUsd: mp.costUsd,
callTimestamp: stepObj.createdAt }); } }
const anchors = [];
for (const [sidx, stepObj] of stepsByIdx.entries()) {
if (stepObj.createdAt !== null) anchors.push({ idx: sidx, ts: stepObj.createdAt }); }
for (const c of rawCalls) { if (c.callTimestamp !== null && Number.isFinite(c.stepIdx)) {
anchors.push({ idx: c.stepIdx, ts: c.callTimestamp }); } }
anchors.sort((a, b) => a.idx - b.idx || a.ts - b.ts);
for (const c of rawCalls) { if (c.callTimestamp === null) {
const targetIdx = Number.isFinite(c.stepIdx) ? c.stepIdx : (c.genIdx ?? 0);
let prev = null;
let next = null;
for (const a of anchors) { if (a.idx <= targetIdx) prev = a;
if (a.idx >= targetIdx && next === null) next = a; }
if (prev && next && next.idx > prev.idx) {
c.callTimestamp = prev.ts + ((targetIdx - prev.idx) / (next.idx - prev.idx)) * (next.ts - prev.ts);
} else if (prev) { c.callTimestamp = prev.ts; } else if (next) { c.callTimestamp = next.ts; } else {
c.callTimestamp = fallbackFileTs; } }
c.timestampMs = Math.round(c.callTimestamp * 1000);
c.day = normalizeDate(new Date(c.timestampMs)); }
return rawCalls;
} finally { handle.close(); } }
function getDefaultConversationSources(homeDir = os.homedir()) {
const cliBase = process.env.GEMINI_CLI_HOME || path.join(homeDir, '.gemini', 'antigravity-cli');
const candidates = [
{ source: 'antigravity', root: process.env.ANTIGRAVITY_HOME },
{ source: 'antigravity', root: process.env.ANTIGRAVITY_DATA_DIR },
{ source: 'antigravity-ide', root: path.join(homeDir, '.gemini', 'antigravity-ide') },
{ source: 'antigravity', root: path.join(homeDir, '.gemini', 'antigravity') },
{ source: 'antigravity-backup', root: path.join(homeDir, '.gemini', 'antigravity-backup') },
{ source: 'antigravity-cli', root: cliBase }
];
const sources = [];
const seen = new Set();
for (const candidate of candidates) { if (typeof candidate.root !== 'string' || !candidate.root.trim()) continue;
const dir = path.join(candidate.root.trim(), 'conversations');
if (seen.has(dir)) continue;
seen.add(dir);
sources.push({ source: candidate.source, dir }); }
return sources; }
function getDbFingerprint(dbPath) { try { const st = fs.statSync(dbPath);
let walMtimeMs = 0;
let walSize = 0;
const walPath = `${dbPath}-wal`;
if (fs.existsSync(walPath)) { const wst = fs.statSync(walPath);
walMtimeMs = Math.round(wst.mtimeMs);
walSize = wst.size; }
return { mtimeMs: Math.round(st.mtimeMs), size: st.size, walMtimeMs, walSize,
key: `${Math.round(st.mtimeMs)}:${st.size}:${walMtimeMs}:${walSize}` }; } catch (_) { return null; } }
function scanAllConversationDbs(options = {}) { reclaimOrphanSnapshots();
const homeDir = options.homeDir || os.homedir();
const sources = Array.isArray(options.conversationSources)
? options.conversationSources
: (Array.isArray(options.conversationDirs)
? options.conversationDirs.map((dir) => (typeof dir === 'string' ? { source: 'antigravity', dir } : dir))
: getDefaultConversationSources(homeDir));
const cacheFile = options.cacheFile || (options.dataDirectory ? path.join(options.dataDirectory, DEFAULT_DB_CACHE_FILENAME) : null);
function loadDiskCache(filePath) { const loaded = readJson(filePath, null);
if (!loaded || loaded.version !== DB_CACHE_VERSION || !loaded.entries || typeof loaded.entries !== 'object') return null;
const entries = {};
for (const [dbPath, entry] of Object.entries(loaded.entries)) {
if (entry && typeof entry === 'object' && typeof entry.key === 'string' && Array.isArray(entry.calls)) { entries[dbPath] = entry; } }
return { version: DB_CACHE_VERSION, entries }; }
let diskCache = null;
let diskCacheLoaded = false;
const ensureDiskCache = () => { if (diskCacheLoaded) return diskCache;
diskCacheLoaded = true;
diskCache = (cacheFile ? loadDiskCache(cacheFile) : null) || { version: DB_CACHE_VERSION, entries: {} };
if (!cacheFile && !options.homeDir && !options.conversationDirs && !options.conversationSources) {
const sharedCacheFile = path.join(getSharedDataDir(), 'plugin-data', 'antigravity-account-ledger', DEFAULT_DB_CACHE_FILENAME);
diskCache = loadDiskCache(sharedCacheFile) || diskCache; }
return diskCache; };
const retagCalls = (calls, source) => { const list = Array.isArray(calls) ? calls : [];
const out = new Array(list.length);
for (let i = 0; i < list.length; i += 1) { const call = list[i];
out[i] = (call && call.source !== source) ? { ...call, source } : call; }
return out; };
let cacheChanged = false;
const rawRecords = [];
const liveEntries = new Map();
for (const src of sources) { if (!src || !src.dir || !fs.existsSync(src.dir)) continue;
let files = [];
try { files = fs.readdirSync(src.dir).filter((f) => f.endsWith('.db')).sort(); } catch (_) { continue; }
for (const file of files) { const dbPath = path.join(src.dir, file);
const fp = getDbFingerprint(dbPath);
if (!fp) continue;
const targetSource = src.source || 'antigravity';
const memHit = GLOBAL_DB_SCAN_CACHE.get(dbPath);
if (memHit && memHit.key === fp.key) { rawRecords.push(...retagCalls(memHit.calls, targetSource));
liveEntries.set(dbPath, memHit);
continue; }
const diskHit = ensureDiskCache().entries[dbPath];
if (diskHit && diskHit.key === fp.key && Array.isArray(diskHit.calls)) { GLOBAL_DB_SCAN_CACHE.set(dbPath, diskHit);
rawRecords.push(...retagCalls(diskHit.calls, targetSource));
liveEntries.set(dbPath, diskHit);
continue; }

const calls = scanConversationDb(dbPath, targetSource);
const entry = { key: fp.key, mtimeMs: fp.mtimeMs, size: fp.size, walMtimeMs: fp.walMtimeMs, walSize: fp.walSize,
calls };
GLOBAL_DB_SCAN_CACHE.set(dbPath, entry);
ensureDiskCache().entries[dbPath] = entry;
liveEntries.set(dbPath, entry);
cacheChanged = true;
rawRecords.push(...calls); } }
if (cacheChanged && cacheFile) { const cache = ensureDiskCache();
for (const [dbPath, entry] of liveEntries) { cache.entries[dbPath] = entry; }
try { writeJsonAtomic(cacheFile, cache, { compact: true }); } catch (_) {} }
const dedupByKey = new Map();
for (const rec of rawRecords) { const rid = rec.responseId;
const dkey = rid
? `rid:${rec.apiProvider || 0}:${rid}`
: `no_rid:${rec.conversationId}:${rec.genIdx ?? -1}:${rec.stepIdx ?? -1}:${rec.attemptIndex ?? 0}:${callUsageSignature(rec)}`;
if (!dedupByKey.has(dkey)) { dedupByKey.set(dkey, { ...rec }); } else { const existing = dedupByKey.get(dkey);
const existingIsPlaceholder = !existing.model || existing.model === 'unknown' || existing.model.startsWith('MODEL_');
const recHasBetterModel = rec.model && rec.model !== 'unknown' && !rec.model.startsWith('MODEL_');
if (existingIsPlaceholder && recHasBetterModel) {
existing.model = rec.model;
existing.modelDisplayName = rec.modelDisplayName || existing.modelDisplayName;
existing.costUsd = rec.costUsd; }
if (!existing.callTimestamp && rec.callTimestamp) { existing.callTimestamp = rec.callTimestamp;
existing.timestampMs = rec.timestampMs;
existing.day = rec.day; } } }
return Array.from(dedupByKey.values()); }
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
function extractEmailFromUserStatusValue(rawValue) { if (!rawValue || typeof rawValue !== 'string') return null;
const trimmed = rawValue.trim();
if (!trimmed) return null;
try { const parsed = JSON.parse(trimmed);
const email = normalizeEmail(parsed?.email || parsed?.userStatus?.email);
if (email) {
const displayName = (typeof parsed.name === 'string' && parsed.name.trim()) ? parsed.name.trim() : email;
return { email, displayName }; } } catch (_) {}
try { const outerBuf = Buffer.from(trimmed, 'base64');
const outerStr = outerBuf.toString('utf8');
const chunks = outerStr.match(/[A-Za-z0-9+/=]{20,}/g) || [];
for (const chunk of chunks) { try { const innerBuf = Buffer.from(chunk, 'base64');
const { out: innerProto } = parseProto(innerBuf);
const protoEmail = normalizeEmail(fStr(innerProto, 7));
if (protoEmail && protoEmail.includes('@')) { const protoName = fStr(innerProto, 3);
return { email: protoEmail, displayName: (protoName && protoName.trim()) ? protoName.trim() : protoEmail }; }
const innerText = innerBuf.toString('utf8');
const match = innerText.match(EMAIL_REGEX);
if (match && match[0]) { const email = normalizeEmail(match[0]);
return { email, displayName: email }; } } catch (_) {} }
const { out: directProto } = parseProto(outerBuf);
const directEmail = normalizeEmail(fStr(directProto, 7) || fStr(directProto, 1));
if (directEmail && directEmail.includes('@')) { const directName = fStr(directProto, 3);
return { email: directEmail, displayName: (directName && directName.trim()) ? directName.trim() : directEmail }; }
const outerMatch = outerStr.match(EMAIL_REGEX);
if (outerMatch && outerMatch[0]) { const email = normalizeEmail(outerMatch[0]);
return { email, displayName: email }; } } catch (_) {}
const rawMatch = trimmed.match(EMAIL_REGEX);
if (rawMatch && rawMatch[0]) { const email = normalizeEmail(rawMatch[0]);
return { email, displayName: email }; }
return null; }
function getVscdbCandidates(options = {}) { if (Array.isArray(options.vscdbPaths)) {
return options.vscdbPaths.map((p) => (typeof p === 'string' ? { path: p, kind: 'custom' } : p)); }
const platform = options.platform || process.platform;
const homeDir = options.homeDir || os.homedir();
const appData = options.appDataDir || process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
const candidates = [];
if (platform === 'win32') { candidates.push(
{ path: path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'), kind: 'ide' },
{ path: path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' },
{ path: path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' },
{ path: path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' }
); } else if (platform === 'darwin') { candidates.push(
{ path: path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'), kind: 'ide' },
{ path: path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' },
{ path: path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' }
); } else { const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
candidates.push(
{ path: path.join(configHome, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'), kind: 'ide' },
{ path: path.join(configHome, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' },
{ path: path.join(configHome, 'Code', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' }
); }
return candidates; }
function discoverFromVscdb(options = {}) {
if (!DatabaseSync) return { accounts: [], ideActiveEmail: null, legacyActiveEmail: null, activeEmail: null };
const candidates = getVscdbCandidates(options);
const accounts = [];
let ideActiveEmail = null;
let legacyActiveEmail = null;
for (const cand of candidates) { const dbPath = cand.path;
try { if (!fs.existsSync(dbPath)) continue;
const db = new DatabaseSync(dbPath, { readOnly: true });
try { try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
const keys = ['antigravityUnifiedStateSync.userStatus', 'antigravityAuthStatus'];
for (const key of keys) { const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
if (!row || typeof row.value !== 'string') continue;
const info = extractEmailFromUserStatusValue(row.value);
if (info && info.email) { if (cand.kind === 'ide' || cand.kind === 'custom') {
if (!ideActiveEmail) ideActiveEmail = info.email; } else if (!legacyActiveEmail) { legacyActiveEmail = info.email;
}
accounts.push({ email: info.email, displayName: info.displayName || info.email,
source: cand.kind === 'ide' ? 'antigravity_ide_vscdb' : 'state_vscdb' }); } }
} finally { try { db.close(); } catch (_) {} } } catch (_) {} }
return { accounts, ideActiveEmail, legacyActiveEmail, activeEmail: ideActiveEmail || legacyActiveEmail }; }
function discoverFromTools(options = {}) { const home = options.homeDir || os.homedir();
const toolsDir = options.toolsDir || path.join(home, '.antigravity_tools');
const accountsSubdir = path.join(toolsDir, 'accounts');
const indexJsonPath = path.join(accountsSubdir, 'index.json');
const accountsJsonPath = path.join(toolsDir, 'accounts.json');
const indexData = readJson(indexJsonPath, null);
const rootData = readJson(accountsJsonPath, null);
const accounts = [];
const accountById = new Map();
let activeId = indexData?.current_account_id
|| indexData?.current_classic_account_id
|| rootData?.current_account_id
|| rootData?.current_classic_account_id
|| null;
let activeEmail = normalizeEmail(indexData?.current_email || rootData?.current_email || '');
for (const data of [indexData, rootData]) { if (data && Array.isArray(data.accounts)) {
for (const a of data.accounts) { const email = normalizeEmail(a?.email);
if (!email) continue;
if (a.id) accountById.set(String(a.id), email);
if (activeId && a.id === activeId && !activeEmail) { activeEmail = email; }
accounts.push({ id: a.id || null, email,
displayName: (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : email, source: 'antigravity_tools',
createdAt: a.created_at || null, lastUsed: a.last_used || null, disabled: a.disabled === true,
quota: a.quota || null }); } } }
try { if (fs.existsSync(accountsSubdir)) { const files = fs.readdirSync(accountsSubdir).sort();
for (const file of files) { if (!file.endsWith('.json') || file === 'index.json') continue;
const acc = readJson(path.join(accountsSubdir, file), null);
const email = normalizeEmail(acc?.email);
if (!email) continue;
const id = acc.id || path.basename(file, '.json');
accountById.set(String(id), email);
if (activeId && String(id) === String(activeId) && !activeEmail) { activeEmail = email; }
accounts.push({ id, email,
displayName: (typeof acc.name === 'string' && acc.name.trim()) ? acc.name.trim() : email,
source: 'antigravity_tools', createdAt: acc.created_at || null, lastUsed: acc.last_used || null,
disabled: acc.disabled === true, quota: acc.quota || null }); } } } catch (_) {}
if (!activeEmail && activeId && accountById.has(String(activeId))) {
activeEmail = accountById.get(String(activeId)); }
return { accounts, activeEmail: activeEmail || null, activeId }; }
function discoverFromGoogleAccountsJson(options = {}) { const home = options.homeDir || os.homedir();
const filePath = options.googleAccountsPath || path.join(home, '.gemini', 'google_accounts.json');
const data = readJson(filePath, null);
const accounts = [];
let activeEmail = null;
if (data && typeof data === 'object') { const active = normalizeEmail(data.active);
if (active) { activeEmail = active;
accounts.push({ email: active, displayName: active, source: 'google_accounts_json' }); }
if (Array.isArray(data.old)) { for (const item of data.old) {
const oldEmail = normalizeEmail(typeof item === 'string' ? item : item?.email);
if (oldEmail) { accounts.push({ email: oldEmail, displayName: oldEmail, source: 'google_accounts_json' }); } } } }
return { accounts, activeEmail }; }
function extractEmailFromJwtIdToken(idToken) {
if (!idToken || typeof idToken !== 'string') return null;
const parts = idToken.split('.');
if (parts.length < 2) return null;
try { const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
return normalizeEmail(payload?.email); } catch (_) { return null; } }
function discoverFromOAuthTokens(options = {}) { const home = options.homeDir || os.homedir();
const cliBase = process.env.GEMINI_CLI_HOME || path.join(home, '.gemini', 'antigravity-cli');
const candidates = [
{ path: path.join(home, '.gemini', 'jetski-standalone-oauth-token'), source: 'jetski_oauth_token' },
{ path: path.join(cliBase, 'antigravity-oauth-token'), source: 'cli_oauth_token' },
{ path: path.join(home, '.gemini', 'oauth_creds.json'), source: 'oauth_creds_json' }
];
const accounts = [];
let activeEmail = null;
let latestMtimeMs = 0;
for (const cand of candidates) { try { if (!fs.existsSync(cand.path)) continue;
const st = fs.statSync(cand.path);
const obj = readJson(cand.path, null);
const email = extractEmailFromJwtIdToken(obj?.id_token) || normalizeEmail(obj?.email);
if (email) { accounts.push({ email, displayName: email, source: cand.source, lastUsed: Math.round(st.mtimeMs / 1000) });
if (st.mtimeMs >= latestMtimeMs) { latestMtimeMs = st.mtimeMs;
activeEmail = email; } } } catch (_) {} }
return { accounts, activeEmail }; }
const CLI_LOG_FN_RE = /cli-(\d{4})\d{4}_\d{6}\.log$/;
const CLI_AUTH_RE = /I(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)\s+\d+\s+server_oauth\.go:\d+\]\s+applyAuthResult:\s+email=([^\s,]+)/;
const CLI_AUTH_RE_GLOBAL = new RegExp(CLI_AUTH_RE.source, 'g');
const CLI_LOG_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const CLI_LOG_HEAD_BYTES = 64 * 1024;
function readCliLogText(fd, size) { if (size <= CLI_LOG_MAX_SCAN_BYTES) { const buf = Buffer.alloc(size);
fs.readSync(fd, buf, 0, size, 0);
return buf.toString('utf8'); }
const headBuf = Buffer.alloc(CLI_LOG_HEAD_BYTES);
fs.readSync(fd, headBuf, 0, CLI_LOG_HEAD_BYTES, 0);
const tailLen = CLI_LOG_MAX_SCAN_BYTES - CLI_LOG_HEAD_BYTES;
const tailBuf = Buffer.alloc(tailLen);
fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);
return `${headBuf.toString('utf8')}\n${tailBuf.toString('utf8')}`; }
function discoverCliLogWindows(options = {}) { const home = options.homeDir || os.homedir();
const cliBase = options.cliHomeDir || process.env.GEMINI_CLI_HOME || path.join(home, '.gemini', 'antigravity-cli');
const logDir = options.cliLogDir || path.join(cliBase, 'log');
const windows = [];
try { if (!fs.existsSync(logDir)) return windows;
const files = fs.readdirSync(logDir).filter((f) => f.startsWith('cli-') && f.endsWith('.log')).sort();
for (const file of files) { const fullPath = path.join(logDir, file);
let fd = null;
try { const st = fs.statSync(fullPath);
fd = fs.openSync(fullPath, 'r');
const text = readCliLogText(fd, st.size || 0);
const matches = [...text.matchAll(CLI_AUTH_RE_GLOBAL)];
if (!matches.length) continue;
const m = matches[matches.length - 1];
const fnMatch = file.match(CLI_LOG_FN_RE);
let year = fnMatch ? Number(fnMatch[1]) : new Date(st.mtimeMs).getFullYear();
const [, mo, da, hh, mm, ss, us, rawEmail] = m;
const email = normalizeEmail(rawEmail);
if (!email) continue;
const buildStartMs = (yr) => new Date(yr, Number(mo) - 1, Number(da), Number(hh), Number(mm), Number(ss), Math.floor(Number(us) / 1000)).getTime();
let startMs = buildStartMs(year);
if (fnMatch && startMs > st.mtimeMs + 86400_000) { year -= 1; startMs = buildStartMs(year); }
const endMs = Math.min(Math.max(startMs + 60_000, Math.round(st.mtimeMs) + 60_000), startMs + 24 * 60 * 60 * 1000);
windows.push({ email, startMs: startMs - 5_000, endMs, source: 'cli_log' }); } catch (_) {} finally {
if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } } } } catch (_) {}
return windows; }
function discoverToolsTokenStatsWindows(options = {}) { if (!DatabaseSync) return [];
const home = options.homeDir || os.homedir();
const dbPath = path.join(options.toolsDir || path.join(home, '.antigravity_tools'), 'token_stats.db');
const windows = [];
try { if (!fs.existsSync(dbPath)) return windows;
const db = new DatabaseSync(dbPath, { readOnly: true });
try { try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
let sql = 'SELECT timestamp, account_email, total_tokens FROM token_usage WHERE total_tokens > 0 ORDER BY timestamp';
try { const columns = new Set(db.prepare('PRAGMA table_info(token_usage)').all().map((c) => String(c.name)));
if (columns.has('input_tokens') && columns.has('output_tokens')) {
sql = 'SELECT timestamp, account_email, total_tokens, input_tokens, output_tokens FROM token_usage WHERE (total_tokens > 0 OR input_tokens > 0 OR output_tokens > 0) ORDER BY timestamp'; } } catch (_) {}
const rows = db.prepare(sql).all();
for (const r of rows) { const email = normalizeEmail(r?.account_email);
const tsSec = Number(r?.timestamp || 0);
if (!email || !tsSec) continue;
const tsMs = tsSec > 20_000_000_000 ? tsSec : tsSec * 1000;
windows.push({ email, startMs: tsMs - 30_000, endMs: tsMs + 300_000, source: 'tools_token_stats' }); }
} finally { try { db.close(); } catch (_) {} } } catch (_) {}
return windows; }
function discoverFromManaged(settings) { const raw = settings?.antigravityManagedAccounts;
if (!Array.isArray(raw)) return [];
const accounts = [];
const seen = new Set();
for (const entry of raw) { const email = normalizeEmail(entry?.accountEmail || entry?.email);
if (!email || seen.has(email)) continue;
seen.add(email);
accounts.push({ email, displayName: (entry?.accountLabel && String(entry.accountLabel).trim()) || email,
source: 'managed', enabled: entry?.enabled !== false }); }
return accounts; }
function quotaFreshnessMs(quota, fallbackMs = 0) { const explicit = toEpochMs(quota?.last_updated ?? quota?.lastUpdated ?? 0);
if (explicit > 0) return explicit;
return fallbackMs > 0 ? fallbackMs : 0; }
function discoverAccounts(options = {}) { const map = new Map();
function addAccount(acc) { const email = normalizeEmail(acc?.email);
if (!email) return;
const existing = map.get(email);
const source = acc.source || 'unknown';
if (!existing) { map.set(email, { email, displayName: acc.displayName || email, sources: [source],
createdAt: acc.createdAt || null, lastUsed: acc.lastUsed || null, quota: acc.quota || null,
disabled: acc.disabled === true }); } else {
if (source && !existing.sources.includes(source)) { existing.sources.push(source); }
if (acc.disabled === true) { existing.disabled = true; }
else if (acc.disabled === false) { existing.disabled = false; }
if (acc.displayName && acc.displayName !== email && (!existing.displayName || existing.displayName === email)) {
existing.displayName = acc.displayName; }
if (acc.createdAt) { const createdMs = toEpochMs(acc.createdAt);
const existingCreatedMs = toEpochMs(existing.createdAt);
if (createdMs > 0 && (!existing.createdAt || existingCreatedMs === 0 || createdMs < existingCreatedMs)) {
existing.createdAt = acc.createdAt; } }
if (acc.lastUsed) { const lastMs = toEpochMs(acc.lastUsed);
const existingLastMs = toEpochMs(existing.lastUsed);
if (lastMs > 0 && lastMs > existingLastMs) { existing.lastUsed = acc.lastUsed; } }
if (acc.quota) { if (!existing.quota) { existing.quota = acc.quota; } else {
const incomingFreshness = quotaFreshnessMs(acc.quota, toEpochMs(acc.lastUsed));
const existingFreshness = quotaFreshnessMs(existing.quota, toEpochMs(existing.lastUsed));
if (incomingFreshness > existingFreshness) { existing.quota = acc.quota; } } } } }
const tools = discoverFromTools(options);
for (const a of tools.accounts) addAccount(a);
const vscdb = discoverFromVscdb(options);
for (const a of vscdb.accounts) addAccount(a);
const googleAccs = discoverFromGoogleAccountsJson(options);
for (const a of googleAccs.accounts) addAccount(a);
const oauthAccs = discoverFromOAuthTokens(options);
for (const a of oauthAccs.accounts) addAccount(a);
for (const w of discoverCliLogWindows(options)) addAccount({ email: w.email, source: 'cli_log', lastUsed: Math.round(w.endMs / 1000) });
for (const w of discoverToolsTokenStatsWindows(options)) {
if (w.email && w.email !== 'unattributed') { addAccount({ email: w.email, source: 'tools_token_stats', lastUsed: Math.round(w.endMs / 1000) }); } }
const managed = discoverFromManaged(options.settings);
for (const a of managed) addAccount(a);
return Array.from(map.values()); }
function discoverCurrentAccount(options = {}) { const tools = discoverFromTools(options);
const disabledEmails = new Set(tools.accounts.filter((a) => a.disabled === true).map((a) => a.email));
if (tools.activeEmail && !disabledEmails.has(tools.activeEmail)) { return { email: tools.activeEmail, source: 'antigravity_tools' }; }
const vscdb = discoverFromVscdb(options);
if (vscdb.ideActiveEmail) { return { email: vscdb.ideActiveEmail, source: 'antigravity_ide_vscdb' }; }
const googleAccs = discoverFromGoogleAccountsJson(options);
if (googleAccs.activeEmail) { return { email: googleAccs.activeEmail, source: 'google_accounts_json' }; }
const oauthAccs = discoverFromOAuthTokens(options);
if (oauthAccs.activeEmail) { return { email: oauthAccs.activeEmail, source: 'oauth_token' }; }
if (vscdb.legacyActiveEmail) { return { email: vscdb.legacyActiveEmail, source: 'state_vscdb' }; }
const managed = discoverFromManaged(options.settings);
const enabled = managed.filter((a) => a.enabled !== false && !disabledEmails.has(a.email));
if (enabled.length === 1) { return { email: enabled[0].email, source: 'managed' }; }
return null; }
const detectActiveAccount = discoverCurrentAccount;
module.exports = {
  ...proto,
  openConversationDbWithFallback, scanConversationDb, getDefaultConversationSources, getDbFingerprint, scanAllConversationDbs,
  reclaimOrphanSnapshots,
  extractEmailFromUserStatusValue, getVscdbCandidates, discoverFromVscdb, discoverFromTools,
  discoverFromGoogleAccountsJson, discoverFromOAuthTokens, discoverCliLogWindows, discoverToolsTokenStatsWindows,
  discoverFromManaged, discoverAccounts, discoverCurrentAccount, detectActiveAccount,
  DB_CACHE_VERSION
};
