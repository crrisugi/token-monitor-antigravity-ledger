'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (_) { DatabaseSync = null; }

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function localDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!value || Number.isNaN(value.getTime())) return '';
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toEpochMs(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val > 20_000_000_000 ? Math.round(val) : Math.round(val * 1000);
  }
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return localDayKey(new Date(parsed));
    return trimmed.slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 20_000_000_000 ? value : value * 1000;
    return localDayKey(new Date(ms));
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return localDayKey(value);
  }
  return '';
}

function isAntigravityClient(client) {
  const c = String(client || '').trim().toLowerCase();
  return c === 'antigravity' || c === 'antigravity-cli' || c === 'antigravity-ide' || c === 'antigravity-extension';
}

function getSharedDataDir() {
  if (process.env.TOKEN_MONITOR_SHARED_DIR) return process.env.TOKEN_MONITOR_SHARED_DIR;
  const platform = process.platform;
  const homeDir = os.homedir();
  const productName = 'Token Monitor';
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', productName);
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), productName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), productName);
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return fallback;
    return JSON.parse(content);
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data, options = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const payload = options && options.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempPath, payload, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    throw err;
  }
}

function fileMtimeMs(filePath) {
  try { return Math.round(fs.statSync(filePath).mtimeMs); } catch (_) { return 0; }
}

function resolveAppDataDir(options = {}) {
  if (options.appDataDir) return options.appDataDir;
  const homeDir = options.homeDir || os.homedir();
  const isCustomHome = Boolean(options.homeDir && path.resolve(options.homeDir) !== path.resolve(os.homedir()));
  if (!isCustomHome && process.env.APPDATA) return process.env.APPDATA;
  return path.join(homeDir, 'AppData', 'Roaming');
}

function resolveConfigHome(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const isCustomHome = Boolean(options.homeDir && path.resolve(options.homeDir) !== path.resolve(os.homedir()));
  if (!isCustomHome && process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return path.join(homeDir, '.config');
}

function extractEmailFromUserStatusValue(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const email = normalizeEmail(parsed?.email || parsed?.userStatus?.email);
    if (email && email.includes('@')) {
      const displayName = (typeof parsed.name === 'string' && parsed.name.trim()) ? parsed.name.trim() : email;
      return { email, displayName };
    }
  } catch (_) {}
  try {
    const outerBuf = Buffer.from(trimmed, 'base64');
    const outerStr = outerBuf.toString('utf8');
    const chunks = outerStr.match(/[A-Za-z0-9+/=]{20,}/g) || [];
    for (const chunk of chunks) {
      try {
        const innerText = Buffer.from(chunk, 'base64').toString('utf8');
        const match = innerText.match(EMAIL_REGEX);
        if (match && match[0]) {
          const email = normalizeEmail(match[0]);
          return { email, displayName: email };
        }
      } catch (_) {}
    }
    const outerMatch = outerStr.match(EMAIL_REGEX);
    if (outerMatch && outerMatch[0]) {
      const email = normalizeEmail(outerMatch[0]);
      return { email, displayName: email };
    }
  } catch (_) {}
  const rawMatch = trimmed.match(EMAIL_REGEX);
  if (rawMatch && rawMatch[0]) {
    const email = normalizeEmail(rawMatch[0]);
    return { email, displayName: email };
  }
  return null;
}

function getAppStorageCandidates(options = {}) {
  if (Array.isArray(options.appStoragePaths)) {
    return options.appStoragePaths.map((p) => (typeof p === 'string' ? { path: p, kind: 'custom' } : p));
  }
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  if (platform === 'win32') {
    const appData = resolveAppDataDir(options);
    return [
      { path: path.join(appData, 'Antigravity', 'app_storage.json'), kind: 'desktop' },
      { path: path.join(appData, 'Antigravity IDE', 'app_storage.json'), kind: 'ide' }
    ];
  }
  if (platform === 'darwin') {
    const appSupport = path.join(homeDir, 'Library', 'Application Support');
    return [
      { path: path.join(appSupport, 'Antigravity', 'app_storage.json'), kind: 'desktop' },
      { path: path.join(appSupport, 'Antigravity IDE', 'app_storage.json'), kind: 'ide' }
    ];
  }
  const configHome = resolveConfigHome(options);
  return [
    { path: path.join(configHome, 'Antigravity', 'app_storage.json'), kind: 'desktop' },
    { path: path.join(configHome, 'Antigravity IDE', 'app_storage.json'), kind: 'ide' }
  ];
}

function discoverFromAppStorage(options = {}) {
  const candidates = getAppStorageCandidates(options);
  const accounts = [];
  let activeEmail = null;
  let activeMtimeMs = 0;
  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand.path)) continue;
      const mtimeMs = fileMtimeMs(cand.path);
      const data = readJson(cand.path, null);
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const rawEmail = data['agy.onboarding.lastLoginUsername']
        ?? data?.agy?.onboarding?.lastLoginUsername
        ?? null;
      const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : '');
      if (!email || !email.includes('@')) continue;
      accounts.push({
        email,
        displayName: email,
        source: 'antigravity_app_storage',
        lastUsed: mtimeMs > 0 ? Math.round(mtimeMs / 1000) : null
      });
      if (!activeEmail || mtimeMs > activeMtimeMs) {
        activeEmail = email;
        activeMtimeMs = mtimeMs;
      }
    } catch (_) {}
  }
  return { accounts, activeEmail, activeMtimeMs };
}

function getVscdbCandidates(options = {}) {
  if (Array.isArray(options.vscdbPaths)) {
    return options.vscdbPaths.map((p) => (typeof p === 'string' ? { path: p, kind: 'custom' } : p));
  }
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const base = platform === 'win32'
    ? resolveAppDataDir(options)
    : (platform === 'darwin' ? path.join(homeDir, 'Library', 'Application Support') : resolveConfigHome(options));
  const candidates = [
    { path: path.join(base, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'), kind: 'ide' },
    { path: path.join(base, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'), kind: 'antigravity' },
    { path: path.join(base, 'Code', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' }
  ];
  if (platform === 'win32') {
    candidates.push({ path: path.join(base, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'), kind: 'legacy' });
  }
  return candidates;
}

function discoverFromVscdb(options = {}) {
  const empty = {
    accounts: [],
    ideActiveEmail: null, ideActiveMtimeMs: 0,
    antigravityActiveEmail: null, antigravityActiveMtimeMs: 0,
    legacyActiveEmail: null, legacyActiveMtimeMs: 0,
    activeEmail: null
  };
  if (!DatabaseSync) return empty;
  const candidates = getVscdbCandidates(options);
  const accounts = [];
  let ideActiveEmail = null; let ideActiveMtimeMs = 0;
  let antigravityActiveEmail = null; let antigravityActiveMtimeMs = 0;
  let legacyActiveEmail = null; let legacyActiveMtimeMs = 0;
  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand.path)) continue;
      const mtimeMs = Math.max(fileMtimeMs(cand.path), fileMtimeMs(`${cand.path}-wal`));
      const db = new DatabaseSync(cand.path, { readOnly: true });
      try {
        try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
        try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
        for (const key of ['antigravityUnifiedStateSync.userStatus', 'antigravityAuthStatus']) {
          const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
          if (!row || typeof row.value !== 'string') continue;
          const info = extractEmailFromUserStatusValue(row.value);
          if (!info || !info.email) continue;
          if (cand.kind === 'ide' || cand.kind === 'custom') {
            if (!ideActiveEmail) { ideActiveEmail = info.email; ideActiveMtimeMs = mtimeMs; }
          } else if (cand.kind === 'antigravity') {
            if (!antigravityActiveEmail) { antigravityActiveEmail = info.email; antigravityActiveMtimeMs = mtimeMs; }
          } else if (!legacyActiveEmail) {
            legacyActiveEmail = info.email; legacyActiveMtimeMs = mtimeMs;
          }
          const src = (cand.kind === 'ide' || cand.kind === 'custom')
            ? 'antigravity_ide_vscdb'
            : (cand.kind === 'antigravity' ? 'antigravity_vscdb' : 'state_vscdb');
          accounts.push({
            email: info.email,
            displayName: info.displayName || info.email,
            source: src,
            lastUsed: mtimeMs > 0 ? Math.round(mtimeMs / 1000) : null
          });
        }
      } finally {
        try { db.close(); } catch (_) {}
      }
    } catch (_) {}
  }
  return {
    accounts,
    ideActiveEmail, ideActiveMtimeMs,
    antigravityActiveEmail, antigravityActiveMtimeMs,
    legacyActiveEmail, legacyActiveMtimeMs,
    activeEmail: ideActiveEmail || antigravityActiveEmail || legacyActiveEmail
  };
}

function discoverFromTools(options = {}) {
  const home = options.homeDir || os.homedir();
  const toolsDir = options.toolsDir || path.join(home, '.antigravity_tools');
  const accountsSubdir = path.join(toolsDir, 'accounts');
  const indexJsonPath = path.join(accountsSubdir, 'index.json');
  const accountsJsonPath = path.join(toolsDir, 'accounts.json');
  const indexData = readJson(indexJsonPath, null);
  const rootData = readJson(accountsJsonPath, null);
  const accounts = [];
  const accountById = new Map();
  const activeId = indexData?.current_account_id
    || indexData?.current_classic_account_id
    || rootData?.current_account_id
    || rootData?.current_classic_account_id
    || null;
  let activeEmail = normalizeEmail(indexData?.current_email || rootData?.current_email || '');
  const indexHasActive = Boolean(indexData && (indexData.current_account_id || indexData.current_classic_account_id || indexData.current_email));
  const rootHasActive = Boolean(rootData && (rootData.current_account_id || rootData.current_classic_account_id || rootData.current_email));
  const activeMtimeMs = indexHasActive ? fileMtimeMs(indexJsonPath) : (rootHasActive ? fileMtimeMs(accountsJsonPath) : 0);

  for (const data of [indexData, rootData]) {
    if (!data || !Array.isArray(data.accounts)) continue;
    for (const a of data.accounts) {
      const email = normalizeEmail(a?.email);
      if (!email) continue;
      if (a.id) accountById.set(String(a.id), email);
      if (activeId && String(a.id) === String(activeId) && !activeEmail) activeEmail = email;
      accounts.push({
        id: a.id || null,
        email,
        displayName: (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : email,
        source: 'antigravity_tools',
        lastUsed: a.last_used || null,
        disabled: a.disabled === true
      });
    }
  }
  try {
    if (fs.existsSync(accountsSubdir)) {
      for (const file of fs.readdirSync(accountsSubdir).sort()) {
        if (!file.endsWith('.json') || file === 'index.json') continue;
        const acc = readJson(path.join(accountsSubdir, file), null);
        const email = normalizeEmail(acc?.email);
        if (!email) continue;
        const id = acc.id || path.basename(file, '.json');
        accountById.set(String(id), email);
        if (activeId && String(id) === String(activeId) && !activeEmail) activeEmail = email;
        accounts.push({
          id,
          email,
          displayName: (typeof acc.name === 'string' && acc.name.trim()) ? acc.name.trim() : email,
          source: 'antigravity_tools',
          lastUsed: acc.last_used || null,
          disabled: acc.disabled === true
        });
      }
    }
  } catch (_) {}
  if (!activeEmail && activeId && accountById.has(String(activeId))) {
    activeEmail = accountById.get(String(activeId));
  }
  return { accounts, activeEmail: activeEmail || null, activeId, activeMtimeMs };
}

function discoverFromGoogleAccountsJson(options = {}) {
  const home = options.homeDir || os.homedir();
  const filePath = options.googleAccountsPath || path.join(home, '.gemini', 'google_accounts.json');
  const data = readJson(filePath, null);
  const accounts = [];
  let activeEmail = null;
  let activeMtimeMs = 0;
  if (data && typeof data === 'object') {
    const active = normalizeEmail(data.active);
    if (active) {
      activeEmail = active;
      activeMtimeMs = fileMtimeMs(filePath);
      accounts.push({
        email: active,
        displayName: active,
        source: 'google_accounts_json',
        lastUsed: activeMtimeMs > 0 ? Math.round(activeMtimeMs / 1000) : null
      });
    }
    if (Array.isArray(data.old)) {
      for (const item of data.old) {
        const oldEmail = normalizeEmail(typeof item === 'string' ? item : item?.email);
        if (oldEmail) accounts.push({ email: oldEmail, displayName: oldEmail, source: 'google_accounts_json' });
      }
    }
  }
  return { accounts, activeEmail, activeMtimeMs };
}

function extractEmailFromJwtIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return normalizeEmail(payload?.email);
  } catch (_) {
    return null;
  }
}

function discoverFromOAuthTokens(options = {}) {
  const home = options.homeDir || os.homedir();
  const cliBase = process.env.GEMINI_CLI_HOME || path.join(home, '.gemini', 'antigravity-cli');
  const candidates = [
    { path: path.join(home, '.gemini', 'jetski-standalone-oauth-token'), source: 'jetski_oauth_token' },
    { path: path.join(cliBase, 'antigravity-oauth-token'), source: 'cli_oauth_token' },
    { path: path.join(home, '.gemini', 'oauth_creds.json'), source: 'oauth_creds_json' }
  ];
  const accounts = [];
  let activeEmail = null;
  let latestMtimeMs = 0;
  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand.path)) continue;
      const mtimeMs = fileMtimeMs(cand.path);
      const obj = readJson(cand.path, null);
      const email = extractEmailFromJwtIdToken(obj?.id_token) || normalizeEmail(obj?.email);
      if (!email) continue;
      accounts.push({
        email,
        displayName: email,
        source: cand.source,
        lastUsed: mtimeMs > 0 ? Math.round(mtimeMs / 1000) : null
      });
      if (mtimeMs >= latestMtimeMs) {
        latestMtimeMs = mtimeMs;
        activeEmail = email;
      }
    } catch (_) {}
  }
  return { accounts, activeEmail, activeMtimeMs: latestMtimeMs };
}

function discoverFromManaged(settings) {
  const raw = settings?.antigravityManagedAccounts;
  if (!Array.isArray(raw)) return [];
  const accounts = [];
  const seen = new Set();
  for (const entry of raw) {
    const email = normalizeEmail(entry?.accountEmail || entry?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    accounts.push({
      email,
      displayName: (entry?.accountLabel && String(entry.accountLabel).trim()) || email,
      source: 'managed',
      enabled: entry?.enabled !== false
    });
  }
  return accounts;
}

function discoverAccounts(options = {}) {
  const map = new Map();
  function addAccount(acc) {
    const email = normalizeEmail(acc?.email);
    if (!email) return;
    const existing = map.get(email);
    const source = acc.source || 'unknown';
    if (!existing) {
      map.set(email, {
        email,
        displayName: acc.displayName || email,
        sources: [source],
        lastUsed: acc.lastUsed || null,
        disabled: acc.disabled === true
      });
      return;
    }
    if (source && !existing.sources.includes(source)) existing.sources.push(source);
    if (acc.disabled === true) existing.disabled = true;
    else if (acc.disabled === false) existing.disabled = false;
    if (acc.displayName && acc.displayName !== email && (!existing.displayName || existing.displayName === email)) {
      existing.displayName = acc.displayName;
    }
    if (acc.lastUsed && toEpochMs(acc.lastUsed) > toEpochMs(existing.lastUsed)) {
      existing.lastUsed = acc.lastUsed;
    }
  }

  for (const a of Array.isArray(options.hostAccounts) ? options.hostAccounts : []) addAccount(a);
  if (options.hostActiveAccount?.email) {
    addAccount({
      email: options.hostActiveAccount.email,
      displayName: options.hostActiveAccount.displayName || options.hostActiveAccount.email,
      source: options.hostActiveAccount.source || 'host_limits_probe',
      lastUsed: options.hostActiveAccount.mtimeMs ? Math.round(options.hostActiveAccount.mtimeMs / 1000) : null
    });
  }
  for (const a of discoverFromAppStorage(options).accounts) addAccount(a);
  for (const a of discoverFromTools(options).accounts) addAccount(a);
  for (const a of discoverFromVscdb(options).accounts) addAccount(a);
  for (const a of discoverFromGoogleAccountsJson(options).accounts) addAccount(a);
  for (const a of discoverFromOAuthTokens(options).accounts) addAccount(a);
  for (const a of discoverFromManaged(options.settings)) addAccount(a);
  return Array.from(map.values());
}

function pickFreshestCandidate(candidates) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => {
    const diff = (b.mtimeMs || 0) - (a.mtimeMs || 0);
    if (Math.abs(diff) > 2000) return diff;
    return a.tieRank - b.tieRank;
  });
  return { email: sorted[0].email, source: sorted[0].source };
}

function discoverCurrentAccount(options = {}) {
  const tools = discoverFromTools(options);
  const disabledEmails = new Set(tools.accounts.filter((a) => a.disabled === true).map((a) => a.email));
  const appStorage = discoverFromAppStorage(options);
  const vscdb = discoverFromVscdb(options);

  const tier1 = [];
  if (options.hostActiveAccount?.email) {
    const hostEmail = normalizeEmail(options.hostActiveAccount.email);
    if (hostEmail) {
      const hostMtime = toEpochMs(options.hostActiveAccount.mtimeMs || options.hostActiveAccount.updatedAt || 0) || Date.now();
      tier1.push({ email: hostEmail, source: options.hostActiveAccount.source || 'host_limits_probe', mtimeMs: hostMtime, tieRank: 1 });
    }
  }
  if (appStorage.activeEmail) {
    tier1.push({ email: appStorage.activeEmail, source: 'antigravity_app_storage', mtimeMs: appStorage.activeMtimeMs, tieRank: 2 });
  }
  if (tools.activeEmail && !disabledEmails.has(tools.activeEmail)) {
    tier1.push({ email: tools.activeEmail, source: 'antigravity_tools', mtimeMs: tools.activeMtimeMs, tieRank: 3 });
  }
  if (vscdb.ideActiveEmail) {
    tier1.push({ email: vscdb.ideActiveEmail, source: 'antigravity_ide_vscdb', mtimeMs: vscdb.ideActiveMtimeMs, tieRank: 4 });
  }
  if (vscdb.antigravityActiveEmail) {
    tier1.push({ email: vscdb.antigravityActiveEmail, source: 'antigravity_vscdb', mtimeMs: vscdb.antigravityActiveMtimeMs, tieRank: 5 });
  }
  const primary = pickFreshestCandidate(tier1);
  if (primary) return primary;

  const googleAccs = discoverFromGoogleAccountsJson(options);
  const oauthAccs = discoverFromOAuthTokens(options);
  const tier2 = [];
  if (googleAccs.activeEmail) {
    tier2.push({ email: googleAccs.activeEmail, source: 'google_accounts_json', mtimeMs: googleAccs.activeMtimeMs, tieRank: 6 });
  }
  if (oauthAccs.activeEmail) {
    tier2.push({ email: oauthAccs.activeEmail, source: 'oauth_token', mtimeMs: oauthAccs.activeMtimeMs, tieRank: 7 });
  }
  if (vscdb.legacyActiveEmail) {
    tier2.push({ email: vscdb.legacyActiveEmail, source: 'state_vscdb', mtimeMs: vscdb.legacyActiveMtimeMs, tieRank: 8 });
  }
  const secondary = pickFreshestCandidate(tier2);
  if (secondary) return secondary;

  const managed = discoverFromManaged(options.settings);
  const hostOauth = (Array.isArray(options.hostAccounts) ? options.hostAccounts : [])
    .filter((a) => a && a.email && a.disabled !== true);
  const enabledManaged = managed.filter((a) => a.enabled !== false && !disabledEmails.has(a.email));
  if (enabledManaged.length === 1) return { email: enabledManaged[0].email, source: 'managed' };
  if (enabledManaged.length === 0 && hostOauth.length === 1 && !disabledEmails.has(normalizeEmail(hostOauth[0].email))) {
    return { email: normalizeEmail(hostOauth[0].email), source: hostOauth[0].source || 'host_limits_oauth' };
  }
  return null;
}

module.exports = {
  normalizeEmail,
  localDayKey,
  toEpochMs,
  normalizeDate,
  isAntigravityClient,
  getSharedDataDir,
  readJson,
  writeJsonAtomic,
  extractEmailFromUserStatusValue,
  getAppStorageCandidates,
  discoverFromAppStorage,
  getVscdbCandidates,
  discoverFromVscdb,
  discoverFromTools,
  discoverFromGoogleAccountsJson,
  discoverFromOAuthTokens,
  discoverFromManaged,
  discoverAccounts,
  discoverCurrentAccount,
  detectActiveAccount: discoverCurrentAccount
};
