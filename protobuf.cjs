'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let DatabaseSync;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (_) { DatabaseSync = null; }
const DEFAULT_LEDGER_FILENAME = 'antigravity-account-ledger.json';
const DEFAULT_DB_CACHE_FILENAME = 'antigravity-db-cache.json';
const GLOBAL_DB_SCAN_CACHE = new Map();
const MODEL_ENUM_MAP = Object.freeze({ 1007: 'gemini-2.5-pro', 1008: 'gemini-2.5-flash',
1009: 'gemini-2.5-flash-thinking', 1012: 'gemini-2.5-flash-lite', 1016: 'gemini-3.1-pro-high',
1018: 'gemini-3-flash', 1021: 'gemini-3.1-flash-image', 1026: 'claude-opus-4-6-thinking',
1035: 'claude-sonnet-4-6', 1037: 'gemini-3.1-pro-high', 1038: 'gemini-3.1-pro-low', 1050: 'gemini-3.1-flash-lite',
1072: 'gemini-3.7-flash', 1198: 'gemini-3.5-flash-lite', 1298: 'gemini-3.7-flash', 1299: 'gemini-3.7-flash', 1318: 'gemini-3.8-flash', 1319: 'gemini-3.8-flash',
1320: 'gemini-3.8-flash', 1322: 'gemini-3.8-flash-tiered', 1400: 'claude-opus-5-5-low',
1401: 'claude-opus-5-5-medium', 1402: 'claude-opus-5-5-high', 1403: 'claude-sonnet-5-5-low',
1404: 'claude-sonnet-5-5-medium', 1405: 'claude-sonnet-5-5-high', 1417: 'gemini-4-argon', 1418: 'gemini-4-argon',
1419: 'gemini-4-argon' });
const DISPLAY_NAME_TO_CANONICAL = Object.freeze({ 'Gemini 3.7 Flash (Low)': 'gemini-3.7-flash',
'Gemini 3.7 Flash (Medium)': 'gemini-3.7-flash', 'Gemini 3.7 Flash (High)': 'gemini-3.7-flash',
'Gemini 3.8 Flash (Low)': 'gemini-3.8-flash', 'Gemini 3.8 Flash (Medium)': 'gemini-3.8-flash',
'Gemini 3.8 Flash (High)': 'gemini-3.8-flash', 'Gemini 4 Argon (Low)': 'gemini-4-argon',
'Gemini 4 Argon (Medium)': 'gemini-4-argon', 'Gemini 4 Argon (High)': 'gemini-4-argon',
'Claude Opus 4.6': 'claude-opus-4-6', 'Claude Opus 4.6 (Thinking)': 'claude-opus-4-6-thinking',
'Claude Sonnet 4.6': 'claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)': 'claude-sonnet-4-6-thinking',
'Claude Opus 5.5 (Low)': 'claude-opus-5-5-low', 'Claude Opus 5.5 (Medium)': 'claude-opus-5-5-medium',
'Claude Opus 5.5 (High)': 'claude-opus-5-5-high', 'Claude Sonnet 5.5 (Low)': 'claude-sonnet-5-5-low',
'Claude Sonnet 5.5 (Medium)': 'claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (High)': 'claude-sonnet-5-5-high' });
const MODEL_PRICING = Object.freeze({
'gemini-4-argon': { input: 2.0, cacheRead: 0.1, cacheWrite: 0.0, output: 10.0 },
'gemini-3.8-flash': { input: 0.75, cacheRead: 0.075, cacheWrite: 0.0, output: 3.75 },
'gemini-3.7-flash': { input: 0.75, cacheRead: 0.075, cacheWrite: 0.0, output: 3.75 },
'gemini-3.5-flash-lite': { input: 0.3, cacheRead: 0.03, cacheWrite: 0.0, output: 2.5 },
'gemini-3.1-pro': { input: 1.25, cacheRead: 0.125, cacheWrite: 0.0, output: 10.0 },
'gemini-2.5-pro': { input: 1.25, cacheRead: 0.125, cacheWrite: 0.0, output: 10.0 },
'gemini-2.5-flash': { input: 0.3, cacheRead: 0.03, cacheWrite: 0.0, output: 2.5 },
'claude-opus-4-6': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
'claude-sonnet-4-6': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
'claude-opus-5-5': { input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 20.0 },
'claude-sonnet-5-5': { input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 10.0 } });
function normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function localDayKey(date = new Date()) {
const y = date.getFullYear();
const m = String(date.getMonth() + 1).padStart(2, '0');
const d = String(date.getDate()).padStart(2, '0');
return `${y}-${m}-${d}`; }
function normalizeDate(value) {
if (value === null || value === undefined || value === '') return '';
if (typeof value === 'string') {
const trimmed = value.trim();
if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
const parsed = Date.parse(trimmed);
if (Number.isFinite(parsed)) return localDayKey(new Date(parsed));
return trimmed.slice(0, 10); }
if (typeof value === 'number' && Number.isFinite(value)) {
const ms = value > 20_000_000_000 ? value : value * 1000;
return localDayKey(new Date(ms)); }
if (value instanceof Date && !Number.isNaN(value.getTime())) {
return localDayKey(value); }
return ''; }
function isAntigravityClient(client) { const c = String(client || '').trim().toLowerCase();
return c === 'antigravity' || c === 'antigravity-cli' || c === 'antigravity-ide' || c === 'antigravity-extension';
}
function getTempDir() { const custom = process.env.TEMP || process.env.TMP;
if (custom && fs.existsSync(custom)) return custom;
return os.tmpdir(); }
function getSharedDataDir() {
if (process.env.TOKEN_MONITOR_SHARED_DIR) return process.env.TOKEN_MONITOR_SHARED_DIR;
const platform = process.platform;
const homeDir = os.homedir();
const productName = 'Token Monitor';
if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', productName);
if (platform === 'win32') return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), productName);
return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), productName); }
function readJson(filePath, fallback = null) { try { if (!fs.existsSync(filePath)) return fallback;
const content = fs.readFileSync(filePath, 'utf8');
if (!content.trim()) return fallback;
return JSON.parse(content); } catch (_) { return fallback; } }
function writeJsonAtomic(filePath, data) { const dir = path.dirname(filePath);
if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
fs.renameSync(tempPath, filePath); }
function parseProto(buf, keepFields = null) { const out = new Map();
const errors = [];
if (!buf || !buf.length) return { out, errors };
const u8 = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
const n = u8.length;
let pos = 0;
while (pos < n) { let key = 0n;
let shift = 0n;
while (true) { if (pos >= n) { errors.push(`truncated_key_at_${pos}`);
return { out, errors }; }
const b = u8[pos++];
key |= BigInt(b & 0x7f) << shift;
if ((b & 0x80) === 0) break;
shift += 7n;
if (shift > 63n) { errors.push(`key_varint_overflow_at_${pos}`);
return { out, errors }; } }
const wt = Number(key & 7n);
const fn = Number(key >> 3n);
if (fn === 0) { errors.push(`zero_field_number_at_${pos}`);
break; }
const keep = keepFields === null || keepFields.has(fn);
if (wt === 0) { let val = 0n;
let vShift = 0n;
while (true) { if (pos >= n) { errors.push(`truncated_varint_fn${fn}_at_${pos}`);
return { out, errors }; }
const b = u8[pos++];
val |= BigInt(b & 0x7f) << vShift;
if ((b & 0x80) === 0) break;
vShift += 7n;
if (vShift > 63n) { errors.push(`varint_overflow_fn${fn}_at_${pos}`);
return { out, errors }; } }
if (keep) { if (!out.has(fn)) out.set(fn, []);
out.get(fn).push([0, Number(val)]); } } else if (wt === 2) { let ln = 0n;
let lShift = 0n;
while (true) { if (pos >= n) { errors.push(`truncated_length_fn${fn}_at_${pos}`);
return { out, errors }; }
const b = u8[pos++];
ln |= BigInt(b & 0x7f) << lShift;
if ((b & 0x80) === 0) break;
lShift += 7n;
if (lShift > 63n) { errors.push(`length_overflow_fn${fn}_at_${pos}`);
return { out, errors }; } }
const lenNum = Number(ln);
if (pos + lenNum > n) { errors.push(`truncated_bytes_fn${fn}_at_${pos}`);
return { out, errors }; }
if (keep) { if (!out.has(fn)) out.set(fn, []);
out.get(fn).push([2, u8.subarray(pos, pos + lenNum)]); }
pos += lenNum; } else if (wt === 1) { if (pos + 8 > n) { errors.push(`truncated_fixed64_fn${fn}_at_${pos}`);
return { out, errors }; }
if (keep) { if (!out.has(fn)) out.set(fn, []);
out.get(fn).push([1, u8.subarray(pos, pos + 8)]); }
pos += 8; } else if (wt === 5) { if (pos + 4 > n) { errors.push(`truncated_fixed32_fn${fn}_at_${pos}`);
return { out, errors }; }
if (keep) { if (!out.has(fn)) out.set(fn, []);
out.get(fn).push([5, u8.subarray(pos, pos + 4)]); }
pos += 4; } else { errors.push(`unsupported_wire_type_${wt}_fn${fn}_at_${pos}`);
break; } }
return { out, errors }; }
function fVal(d, fn, wt = null) { const list = d.get(fn);
if (!list) return null;
for (const [w, v] of list) { if (wt === null || w === wt) return v; }
return null; }
function fStr(d, fn) { const v = fVal(d, fn, 2);
return v ? Buffer.from(v).toString('utf8') : null; }
function unpackVarints(buf) { const res = [];
if (!buf || !buf.length) return res;
let pos = 0;
const n = buf.length;
while (pos < n) { let v = 0n;
let s = 0n;
while (true) { if (pos >= n) return res;
const b = buf[pos++];
v |= BigInt(b & 0x7f) << s;
if ((b & 0x80) === 0) break;
s += 7n; }
res.push(Number(v)); }
return res; }
function decodeTimestamp(buf) { if (!buf || !buf.length) return null;
const { out, errors } = parseProto(buf);
if (errors.length > 0) return null;
const sec = fVal(out, 1, 0);
const nsec = fVal(out, 2, 0) || 0;
if (sec === null || sec <= 0) return null;
return sec + nsec / 1e9; }
function decodeModelEnumPlaceholder(enumVal) { if (!enumVal || enumVal <= 0) return null;
if (enumVal >= 1000) return `MODEL_PLACEHOLDER_M${enumVal - 1000}`;
return `MODEL_ENUM_${enumVal}`; }
function parseUsageStats(buf) { if (!buf || !buf.length) return null;
const { out: u } = parseProto(buf);
const modelEnum = fVal(u, 1, 0) || 0;
const inp = fVal(u, 2, 0) || 0;
const out = fVal(u, 3, 0) || 0;
const cacheW = fVal(u, 4, 0) || 0;
const cacheR = fVal(u, 5, 0) || 0;
const apiProvider = fVal(u, 6, 0) || 0;
const messageId = fStr(u, 7);
const thinking = fVal(u, 9, 0) || 0;
const respOut = fVal(u, 10, 0) || 0;
const respId = fStr(u, 11);
const effectiveOut = out > 0 ? out : (thinking + respOut);
const nonZero = (inp + effectiveOut + cacheW + cacheR + thinking + respOut) > 0;
return { modelEnum, inputTokens: inp, outputTokens: effectiveOut, rawOutputTokens: out, cacheWriteTokens: cacheW,
cacheReadTokens: cacheR, apiProvider, messageId, thinkingTokens: thinking, responseOutputTokens: respOut,
responseId: respId, nonZero }; }
function walChecksum(buf, s0, s1, bigEndian) { let c0 = s0 >>> 0;
let c1 = s1 >>> 0;
for (let i = 0; i + 8 <= buf.length; i += 8) { const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
c0 = (c0 + x0 + c1) >>> 0;
c1 = (c1 + x1 + c0) >>> 0; }
return [c0, c1]; }
function inspectWalBytes(wbytes, expectedPageSize = 0) { const n = wbytes ? wbytes.length : 0;
if (n === 0) {
return { validConsistentWal: true, reason: 'empty_wal', committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
if (n < 32) {
return { validConsistentWal: false, reason: `truncated_wal_header(${n}_bytes)`, committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
const magic = wbytes.readUInt32BE(0);
const fmtVer = wbytes.readUInt32BE(4);
const pageSize = wbytes.readUInt32BE(8);
const ckptSeq = wbytes.readUInt32BE(12);
const salt1 = wbytes.readUInt32BE(16);
const salt2 = wbytes.readUInt32BE(20);
const hck1 = wbytes.readUInt32BE(24);
const hck2 = wbytes.readUInt32BE(28);
if (magic !== 0x377f0682 && magic !== 0x377f0683) {
return { validConsistentWal: false, reason: 'invalid_wal_magic', committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
if (fmtVer !== 3007000) {
return { validConsistentWal: false, reason: 'unsupported_wal_version', committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
if (expectedPageSize > 0 && pageSize !== expectedPageSize) {
return { validConsistentWal: false, reason: 'wal_page_size_mismatch', committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
return { validConsistentWal: false, reason: 'invalid_wal_page_size', committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
const be = magic === 0x377f0683;
let [s0, s1] = walChecksum(wbytes.subarray(0, 24), 0, 0, be);
if (s0 !== hck1 || s1 !== hck2) {
return { validConsistentWal: false, reason: 'wal_header_checksum_mismatch', committedTransactions: 0, currentFrames: 0, committedEndOffset: 0 };
}
let pos = 32;
const frameLen = 24 + pageSize;
let currentFrames = 0;
let committedTx = 0;
let uncommittedFrames = 0;
let committedEnd = 32;
while (pos + frameLen <= n) { const pgno = wbytes.readUInt32BE(pos);
const commitSz = wbytes.readUInt32BE(pos + 4);
const fs1 = wbytes.readUInt32BE(pos + 8);
const fs2 = wbytes.readUInt32BE(pos + 12);
const fck1 = wbytes.readUInt32BE(pos + 16);
const fck2 = wbytes.readUInt32BE(pos + 20);
if (fs1 !== salt1 || fs2 !== salt2) break;
[s0, s1] = walChecksum(wbytes.subarray(pos, pos + 8), s0, s1, be);
[s0, s1] = walChecksum(wbytes.subarray(pos + 24, pos + frameLen), s0, s1, be);
if (pgno === 0 || s0 !== fck1 || s1 !== fck2) break;
currentFrames += 1;
if (commitSz > 0) { committedTx += 1;
uncommittedFrames = 0;
committedEnd = pos + frameLen; } else { uncommittedFrames += 1; }
pos += frameLen; }
return { validConsistentWal: true, reason: uncommittedFrames ? 'valid_uncommitted_tail' : 'ok',
committedTransactions: committedTx, currentFrames, committedEndOffset: committedEnd, uncommittedFrames,
checkpointSeq: ckptSeq }; }
function resolveCanonicalPricingKey(modelId) { if (!modelId) return null;
const m = String(modelId).trim().toLowerCase();
if (m.startsWith('gemini-4-argon')) return 'gemini-4-argon';
if (m.startsWith('gemini-3.8-flash')) return 'gemini-3.8-flash';
if (m.startsWith('gemini-3.7-flash') || m.startsWith('gemini-3.6-flash')) return 'gemini-3.7-flash';
if (m.includes('flash-lite')) return 'gemini-3.5-flash-lite';
if (m.startsWith('gemini-3.1-pro') || m.startsWith('gemini-2.5-pro') || m.startsWith('gemini-pro')) return 'gemini-3.1-pro';
if (m.startsWith('gemini-3-flash') || m.startsWith('gemini-3.1-flash') || m.startsWith('gemini-2.5-flash')) return 'gemini-2.5-flash';
if (m.startsWith('claude-opus-4-6')) return 'claude-opus-4-6';
if (m.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
if (m.startsWith('claude-opus-5-5')) return 'claude-opus-5-5';
if (m.startsWith('claude-sonnet-5-5')) return 'claude-sonnet-5-5';
return null; }
function resolveModelAndPrice({ responseModel = null, displayName = null, modelEnum = 0, inputTokens = 0,
cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0
} = {}) { let modelId = null;
let modelBasis = 'unknown';
const trimmedResp = typeof responseModel === 'string' ? responseModel.trim() : '';
const trimmedDisp = typeof displayName === 'string' ? displayName.trim() : '';
if (trimmedResp) { modelId = DISPLAY_NAME_TO_CANONICAL[trimmedResp] || trimmedResp;
modelBasis = 'chat_model.response_model'; } else if (trimmedDisp && DISPLAY_NAME_TO_CANONICAL[trimmedDisp]) {
modelId = DISPLAY_NAME_TO_CANONICAL[trimmedDisp];
modelBasis = 'chat_model.model_display_name'; } else if (modelEnum && MODEL_ENUM_MAP[modelEnum]) {
modelId = MODEL_ENUM_MAP[modelEnum];
modelBasis = 'model_enum_map'; } else if (trimmedDisp) {
modelId = trimmedDisp.toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-|-$/g, '');
modelBasis = 'chat_model.model_display_name'; } else if (modelEnum > 0) {
modelId = decodeModelEnumPlaceholder(modelEnum);
modelBasis = 'model_enum_placeholder'; } else { modelId = 'unknown'; }
const pricingKey = resolveCanonicalPricingKey(modelId) || resolveCanonicalPricingKey(MODEL_ENUM_MAP[modelEnum]);
const rates = pricingKey ? MODEL_PRICING[pricingKey] : null;
let costUsd = 0;
if (rates) { costUsd = ( inputTokens * rates.input
+ cacheReadTokens * rates.cacheRead
+ cacheWriteTokens * rates.cacheWrite
+ outputTokens * rates.output
) / 1_000_000; }
return { model: modelId || 'unknown', canonicalPricingModel: pricingKey, modelDisplayName: trimmedDisp || null,
modelEnum: modelEnum || 0, modelBasis, costUsd }; }
function extractRetryEntries(rawRetryBlobs) { const nonZero = [];
if (!Array.isArray(rawRetryBlobs)) return nonZero;
for (let i = 0; i < rawRetryBlobs.length; i += 1) { const [, rb] = rawRetryBlobs[i];
const { out: rp } = parseProto(rb);
const ru = parseUsageStats(fVal(rp, 2, 2));
if (ru && ru.nonZero) { nonZero.push({ attemptIndex: i, attemptId: fStr(rp, 4), errorMessage: fStr(rp, 3),
statusCode: fVal(rp, 5, 0), usage: ru }); } }
return nonZero; }
module.exports = {
  DatabaseSync, DEFAULT_LEDGER_FILENAME, DEFAULT_DB_CACHE_FILENAME, GLOBAL_DB_SCAN_CACHE,
  MODEL_ENUM_MAP, DISPLAY_NAME_TO_CANONICAL, MODEL_PRICING,
  normalizeEmail, localDayKey, normalizeDate, isAntigravityClient, getTempDir, getSharedDataDir, readJson, writeJsonAtomic,
  parseProto, fVal, fStr, unpackVarints, decodeTimestamp, decodeModelEnumPlaceholder, parseUsageStats,
  walChecksum, inspectWalBytes, resolveCanonicalPricingKey, resolveModelAndPrice, extractRetryEntries
};
