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
1419: 'gemini-4-argon', 1427: 'gemini-4-carbon', 1437: 'gemini-4-carbon', 1438: 'gemini-4-carbon',
1526: 'gemini-4-hydrogen', 1527: 'gemini-4-hydrogen', 1528: 'gemini-4-hydrogen' });
const DISPLAY_NAME_TO_CANONICAL = Object.freeze({ 'Gemini 3.7 Flash (Low)': 'gemini-3.7-flash',
'Gemini 3.7 Flash (Medium)': 'gemini-3.7-flash', 'Gemini 3.7 Flash (High)': 'gemini-3.7-flash',
'Gemini 3.8 Flash (Low)': 'gemini-3.8-flash', 'Gemini 3.8 Flash (Medium)': 'gemini-3.8-flash',
'Gemini 3.8 Flash (High)': 'gemini-3.8-flash', 'Gemini 4 Argon (Low)': 'gemini-4-argon',
'Gemini 4 Argon (Medium)': 'gemini-4-argon', 'Gemini 4 Argon (High)': 'gemini-4-argon',
'Gemini 4 Carbon (Low)': 'gemini-4-carbon', 'Gemini 4 Carbon (Medium)': 'gemini-4-carbon',
'Gemini 4 Carbon (High)': 'gemini-4-carbon', 'Gemini 4 Carbon (XHigh)': 'gemini-4-carbon',
'Gemini 4 Hydrogen (Low)': 'gemini-4-hydrogen', 'Gemini 4 Hydrogen (Medium)': 'gemini-4-hydrogen',
'Gemini 4 Hydrogen (High)': 'gemini-4-hydrogen', 'Gemini 4 Hydrogen (XHigh)': 'gemini-4-hydrogen',
'Claude Opus 4.6': 'claude-opus-4-6', 'Claude Opus 4.6 (Thinking)': 'claude-opus-4-6-thinking',
'Claude Sonnet 4.6': 'claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)': 'claude-sonnet-4-6-thinking',
'Claude Opus 5.5 (Low)': 'claude-opus-5-5-low', 'Claude Opus 5.5 (Medium)': 'claude-opus-5-5-medium',
'Claude Opus 5.5 (High)': 'claude-opus-5-5-high', 'Claude Sonnet 5.5 (Low)': 'claude-sonnet-5-5-low',
'Claude Sonnet 5.5 (Medium)': 'claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (High)': 'claude-sonnet-5-5-high' });
const MODEL_PRICING = Object.freeze({
'gemini-4-argon': { input: 2.0, cacheRead: 0.1, cacheWrite: 0.0, output: 10.0 },
'gemini-4-carbon': { input: 2.0, cacheRead: 0.1, cacheWrite: 0.1875, output: 10.0 },
'gemini-4-hydrogen': { input: 1.5, cacheRead: 0.075, cacheWrite: 0.083333, output: 7.5 },
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
const value = date instanceof Date ? date : new Date(date);
if (!value || Number.isNaN(value.getTime())) return '';
const y = value.getFullYear();
const m = String(value.getMonth() + 1).padStart(2, '0');
const d = String(value.getDate()).padStart(2, '0');
return `${y}-${m}-${d}`; }
function toEpochMs(val) { if (val === null || val === undefined || val === '') return 0;
if (typeof val === 'number' && Number.isFinite(val)) {
return val > 20_000_000_000 ? Math.round(val) : Math.round(val * 1000); }
const parsed = Date.parse(String(val));
return Number.isFinite(parsed) ? parsed : 0; }
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
function writeJsonAtomic(filePath, data, options = {}) { const dir = path.dirname(filePath);
if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
const payload = options && options.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
try {
fs.writeFileSync(tempPath, payload, 'utf8');
fs.renameSync(tempPath, filePath); } catch (err) {
try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
throw err; } }
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
while (true) { if (pos >= n) return [];
const b = buf[pos++];
v |= BigInt(b & 0x7f) << s;
if ((b & 0x80) === 0) break;
s += 7n;
if (s > 63n) return []; }
res.push(Number(v)); }
return res; }
function decodeTimestamp(buf) { if (!buf || !buf.length) return null;
const { out, errors } = parseProto(buf);
if (errors.length > 0) return null;
const sec = fVal(out, 1, 0);
const nsec = fVal(out, 2, 0) || 0;
if (sec === null || !Number.isSafeInteger(sec) || sec <= 0) return null;
if (!Number.isFinite(nsec) || nsec < 0 || nsec >= 1e9) return null;
const value = sec + nsec / 1e9;
if (Number.isNaN(new Date(value * 1000).getTime())) return null;
return value; }
function decodeModelEnumPlaceholder(enumVal) { if (!enumVal || enumVal <= 0) return null;
if (enumVal >= 1000) return `MODEL_PLACEHOLDER_M${enumVal - 1000}`;
return `MODEL_ENUM_${enumVal}`; }
function parseUsageStats(buf) { if (!buf || !buf.length) return null;
const { out: u, errors } = parseProto(buf);
if (errors.length > 0) return null;
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
for (const value of [inp, out, cacheW, cacheR, thinking, respOut]) {
if (!Number.isSafeInteger(value) || value < 0) return null; }
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
if (m.startsWith('gemini-4-carbon')) return 'gemini-4-carbon';
if (m.startsWith('gemini-4-hydrogen')) return 'gemini-4-hydrogen';
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
function toFiniteNonNeg(val) {
if (val === '' || val === null || val === undefined) return undefined;
const n = typeof val === 'number' ? val : Number(val);
return Number.isFinite(n) && n >= 0 ? n : undefined; }
function normalizeRateRecord(raw) {
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
const src = (raw.pricing && typeof raw.pricing === 'object' && !Array.isArray(raw.pricing)) ? raw.pricing : raw;
const pick = (perMKeys, perTokKeys) => {
for (const k of perMKeys) { const v = toFiniteNonNeg(src[k]); if (v !== undefined) return v; }
for (const k of perTokKeys) { const v = toFiniteNonNeg(src[k]); if (v !== undefined) return v * 1_000_000; }
return undefined; };
const input = pick(['input', 'inputPerM', 'input_cost_per_million_tokens'], ['inputCostPerToken', 'input_cost_per_token']);
const output = pick(['output', 'outputPerM', 'output_cost_per_million_tokens'], ['outputCostPerToken', 'output_cost_per_token']);
const cacheRead = pick(['cacheRead', 'cacheReadPerM', 'cache_read_input_token_cost_per_million_tokens'], ['cacheReadInputTokenCost', 'cache_read_input_token_cost']);
const cacheWrite = pick(['cacheWrite', 'cacheWritePerM', 'cache_creation_input_token_cost_per_million_tokens'], ['cacheCreationInputTokenCost', 'cache_creation_input_token_cost']);
if (input === undefined && output === undefined) return null;
return { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 }; }
function lookupPricingRates(modelId, pricingContext = null) {
const raw = String(modelId || '').trim().toLowerCase();
if (!raw || raw === 'unknown') return { rates: null, pricingKey: null };
const customMap = pricingContext?.customMap;
const aliasMap = pricingContext?.aliasMap;
const remoteCatalog = pricingContext?.remoteCatalog;
const directLookup = (id) => {
if (!id) return null;
const low = String(id).trim().toLowerCase();
if (customMap && customMap.has(low)) return { rates: customMap.get(low), pricingKey: low };
const canon = resolveCanonicalPricingKey(low);
if (canon && customMap && customMap.has(canon)) return { rates: customMap.get(canon), pricingKey: canon };
if (canon && MODEL_PRICING[canon]) return { rates: MODEL_PRICING[canon], pricingKey: canon };
if (remoteCatalog && typeof remoteCatalog === 'object') {
for (const cand of [low, `google/${low}`, `gemini/${low}`, `vertex_ai/${low}`, `google-vertex/${low}`, `anthropic/${low}`, `openai/${low}`, `openrouter/google/${low}`]) {
const r = normalizeRateRecord(remoteCatalog[cand]);
if (r) return { rates: r, pricingKey: cand }; } }
return null; };
const direct = directLookup(raw);
if (direct) return direct;
if (aliasMap && aliasMap.size > 0) {
let cur = raw;
const visited = new Set([cur]);
while (aliasMap.has(cur)) {
const next = aliasMap.get(cur);
if (!next || visited.has(next)) break;
visited.add(next);
const hit = directLookup(next);
if (hit) return hit;
cur = next; } }
return { rates: null, pricingKey: null }; }
function buildPricingContext({ settings = null, customPricingFile = null, remoteSnapshot = null } = {}) {
const customMap = new Map();
const manualModels = customPricingFile?.models;
if (manualModels && typeof manualModels === 'object' && !Array.isArray(manualModels)) {
for (const [k, v] of Object.entries(manualModels)) {
const r = normalizeRateRecord(v);
if (k && r) customMap.set(String(k).trim().toLowerCase(), r); } }
if (Array.isArray(settings?.customModelPricing)) {
for (const entry of settings.customModelPricing) {
const id = typeof entry?.modelId === 'string' ? entry.modelId.trim().toLowerCase() : '';
const r = normalizeRateRecord(entry);
if (id && r) customMap.set(id, r); } }
const aliasMap = new Map();
if (settings?.modelAliases && typeof settings.modelAliases === 'object' && !Array.isArray(settings.modelAliases)) {
for (const [src, tgt] of Object.entries(settings.modelAliases)) {
const s = String(src || '').trim().toLowerCase();
const t = String(tgt || '').trim().toLowerCase();
if (s && t && s !== t) aliasMap.set(s, t); } }
const remoteCatalog = {};
const mergeCatalogObj = (obj) => {
if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
const src = (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data))
? obj.data
: ((obj.catalog && typeof obj.catalog === 'object' && !Array.isArray(obj.catalog)) ? obj.catalog : obj);
for (const [k, v] of Object.entries(src)) {
const key = String(k || '').trim().toLowerCase();
if (key && !remoteCatalog[key]) remoteCatalog[key] = v; } };
if (Array.isArray(remoteSnapshot)) { for (const item of remoteSnapshot) mergeCatalogObj(item); }
else { mergeCatalogObj(remoteSnapshot); }
return { customMap, aliasMap, remoteCatalog: Object.keys(remoteCatalog).length > 0 ? remoteCatalog : null }; }
function resolveModelAndPrice({ responseModel = null, displayName = null, modelEnum = 0, fallbackModel = null,
inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0, pricingContext = null
} = {}) { let modelId = null;
let modelBasis = 'unknown';
const trimmedResp = typeof responseModel === 'string' ? responseModel.trim() : '';
const trimmedDisp = typeof displayName === 'string' ? displayName.trim() : '';
const trimmedFallback = typeof fallbackModel === 'string' ? fallbackModel.trim() : '';
if (trimmedResp) { modelId = DISPLAY_NAME_TO_CANONICAL[trimmedResp] || trimmedResp;
modelBasis = 'chat_model.response_model'; } else if (trimmedDisp && DISPLAY_NAME_TO_CANONICAL[trimmedDisp]) {
modelId = DISPLAY_NAME_TO_CANONICAL[trimmedDisp];
modelBasis = 'chat_model.model_display_name'; } else if (modelEnum && MODEL_ENUM_MAP[modelEnum]) {
modelId = MODEL_ENUM_MAP[modelEnum];
modelBasis = 'model_enum_map'; } else if (trimmedDisp) {
modelId = trimmedDisp.toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-|-$/g, '');
modelBasis = 'chat_model.model_display_name'; } else if (modelEnum > 0) {
modelId = decodeModelEnumPlaceholder(modelEnum);
modelBasis = 'model_enum_placeholder'; } else if (trimmedFallback) {
modelId = DISPLAY_NAME_TO_CANONICAL[trimmedFallback] || trimmedFallback;
modelBasis = 'conversation_fallback'; } else { modelId = 'unknown'; }
let { rates, pricingKey } = lookupPricingRates(modelId, pricingContext);
const isPlaceholderOrUnknown = !modelId || modelId === 'unknown' || String(modelId).startsWith('MODEL_');
if (!rates && isPlaceholderOrUnknown && modelEnum && MODEL_ENUM_MAP[modelEnum]) {
const enumLookup = lookupPricingRates(MODEL_ENUM_MAP[modelEnum], pricingContext);
rates = enumLookup.rates;
pricingKey = enumLookup.pricingKey; }
const totalTokens = (inputTokens || 0) + (outputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0);
let costUsd = 0;
let unpricedTokens = 0;
if (rates) { costUsd = ( inputTokens * rates.input
+ cacheReadTokens * rates.cacheRead
+ cacheWriteTokens * rates.cacheWrite
+ outputTokens * rates.output
) / 1_000_000; } else if (totalTokens > 0) { unpricedTokens = totalTokens; }
return { model: modelId || 'unknown', canonicalPricingModel: pricingKey, modelDisplayName: trimmedDisp || null,
modelEnum: modelEnum || 0, modelBasis, costUsd, unpricedTokens, priced: Boolean(rates) }; }
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
  normalizeEmail, localDayKey, toEpochMs, normalizeDate, isAntigravityClient, getTempDir, getSharedDataDir, readJson, writeJsonAtomic,
  parseProto, fVal, fStr, unpackVarints, decodeTimestamp, decodeModelEnumPlaceholder, parseUsageStats,
  walChecksum, inspectWalBytes, resolveCanonicalPricingKey, lookupPricingRates, buildPricingContext, resolveModelAndPrice, extractRetryEntries
};
