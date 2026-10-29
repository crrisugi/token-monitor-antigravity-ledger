'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (_) {
  DatabaseSync = null;
}

const DEFAULT_LEDGER_FILENAME = 'antigravity-account-ledger.json';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeDate(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function isAntigravityClient(client) {
  const c = String(client || '').trim().toLowerCase();
  return c === 'antigravity' || c === 'antigravity-cli' || c === 'antigravity-extension';
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

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function getVscdbCandidates() {
  const platform = process.platform;
  const homeDir = os.homedir();
  const paths = [];

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    paths.push(
      path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb')
    );
  } else if (platform === 'darwin') {
    paths.push(
      path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb')
    );
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    paths.push(
      path.join(configHome, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(configHome, 'Code', 'User', 'globalStorage', 'state.vscdb')
    );
  }
  return paths;
}

function discoverFromVscdb() {
  if (!DatabaseSync) return { accounts: [], activeEmail: null };
  const candidates = getVscdbCandidates();
  const accounts = [];
  let activeEmail = null;

  for (const dbPath of candidates) {
    try {
      if (!fs.existsSync(dbPath)) continue;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
        try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
        if (row && typeof row.value === 'string') {
          const parsed = JSON.parse(row.value);
          const email = normalizeEmail(parsed?.email);
          if (email) {
            if (!activeEmail) activeEmail = email;
            accounts.push({
              email,
              displayName: (typeof parsed.name === 'string' && parsed.name.trim()) ? parsed.name.trim() : email,
              source: 'state_vscdb'
            });
          }
        }
      } finally {
        try { db.close(); } catch (_) {}
      }
    } catch (_) {}
  }
  return { accounts, activeEmail };
}

function discoverFromTools() {
  const home = os.homedir();
  const toolsDir = path.join(home, '.antigravity_tools');
  const accountsJsonPath = path.join(toolsDir, 'accounts.json');
  const data = readJson(accountsJsonPath, null);
  const accounts = [];
  let activeEmail = null;

  if (data && Array.isArray(data.accounts)) {
    const activeId = data.current_account_id || data.current_classic_account_id || null;
    for (const a of data.accounts) {
      const email = normalizeEmail(a?.email);
      if (!email) continue;
      if (activeId && a.id === activeId) {
        activeEmail = email;
      }
      accounts.push({
        email,
        displayName: (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : email,
        source: 'antigravity_tools',
        lastUsed: a.last_used || null,
        disabled: a.disabled === true
      });
    }
  }

  const accountsSubdir = path.join(toolsDir, 'accounts');
  try {
    if (fs.existsSync(accountsSubdir)) {
      const files = fs.readdirSync(accountsSubdir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const acc = readJson(path.join(accountsSubdir, file), null);
        const email = normalizeEmail(acc?.email);
        if (!email) continue;
        accounts.push({
          email,
          displayName: (typeof acc.name === 'string' && acc.name.trim()) ? acc.name.trim() : email,
          source: 'antigravity_tools',
          lastUsed: acc.last_used || null,
          disabled: acc.disabled === true
        });
      }
    }
  } catch (_) {}

  return { accounts, activeEmail };
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

function discoverAccounts({ settings } = {}) {
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
        lastUsed: acc.lastUsed || null
      });
    } else {
      if (source && !existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      if (acc.displayName && acc.displayName !== email && (!existing.displayName || existing.displayName === email)) {
        existing.displayName = acc.displayName;
      }
      if (acc.lastUsed && (!existing.lastUsed || acc.lastUsed > existing.lastUsed)) {
        existing.lastUsed = acc.lastUsed;
      }
    }
  }

  const managed = discoverFromManaged(settings);
  for (const a of managed) addAccount(a);

  const tools = discoverFromTools();
  for (const a of tools.accounts) addAccount(a);

  const vscdb = discoverFromVscdb();
  for (const a of vscdb.accounts) addAccount(a);

  return Array.from(map.values());
}

function detectActiveAccount({ settings } = {}) {
  const tools = discoverFromTools();
  if (tools.activeEmail) {
    return { email: tools.activeEmail, source: 'antigravity_tools' };
  }

  const vscdb = discoverFromVscdb();
  if (vscdb.activeEmail) {
    return { email: vscdb.activeEmail, source: 'state_vscdb' };
  }

  const managed = discoverFromManaged(settings);
  const enabled = managed.filter((a) => a.enabled !== false);
  if (enabled.length === 1) {
    return { email: enabled[0].email, source: 'managed' };
  }

  return null;
}

function createDefaultLedger(activatedAt = new Date().toISOString()) {
  return {
    version: 1,
    featureActivatedAt: activatedAt,
    lastActiveAccount: null,
    timeline: [],
    sessionAccounts: {}
  };
}

function normalizeLedger(loaded) {
  return {
    version: 1,
    featureActivatedAt: loaded?.featureActivatedAt || new Date().toISOString(),
    lastActiveAccount: loaded?.lastActiveAccount || null,
    timeline: Array.isArray(loaded?.timeline) ? loaded.timeline : [],
    sessionAccounts: (loaded?.sessionAccounts && typeof loaded.sessionAccounts === 'object') ? loaded.sessionAccounts : {}
  };
}

function loadLedger(ledgerFile) {
  const loaded = readJson(ledgerFile, null);
  if (loaded && typeof loaded === 'object') {
    return normalizeLedger(loaded);
  }
  const defaultLedger = createDefaultLedger();
  try {
    writeJsonAtomic(ledgerFile, defaultLedger);
  } catch (_) {}
  return defaultLedger;
}

function saveLedger(ledger, ledgerFile) {
  const normalized = normalizeLedger(ledger);
  writeJsonAtomic(ledgerFile, normalized);
  return true;
}

function recordAccountHeartbeat(activeAccount, timestamp, ledger, ledgerFile) {
  const email = normalizeEmail(typeof activeAccount === 'string' ? activeAccount : activeAccount?.email);
  if (!email) return { changed: false, ledger };

  const source = (typeof activeAccount === 'object' && activeAccount?.source) || 'heartbeat';
  const ts = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  let changed = false;

  if (!Array.isArray(ledger.timeline)) {
    ledger.timeline = [];
  }

  const lastInterval = ledger.timeline[ledger.timeline.length - 1];

  if (!lastInterval) {
    ledger.timeline.push({ email, startedAt: ts, endedAt: null, source });
    ledger.lastActiveAccount = email;
    changed = true;
  } else if (lastInterval.email !== email) {
    if (!lastInterval.endedAt || lastInterval.endedAt < ts) {
      lastInterval.endedAt = ts;
    }
    ledger.timeline.push({ email, startedAt: ts, endedAt: null, source });
    ledger.lastActiveAccount = email;
    changed = true;
  } else {
    ledger.lastActiveAccount = email;
    if (lastInterval.endedAt && ts > lastInterval.endedAt) {
      ledger.timeline.push({ email, startedAt: ts, endedAt: null, source });
      changed = true;
    }
  }

  if (changed && ledgerFile) {
    saveLedger(ledger, ledgerFile);
  }

  return { changed, ledger };
}

function cloneMetrics(m) {
  if (!m) return null;
  const models = {};
  if (m.models) {
    for (const [k, v] of Object.entries(m.models)) {
      models[k] = { ...v };
    }
  }
  return {
    totalTokens: m.totalTokens || 0,
    costUsd: m.costUsd || 0,
    inputTokens: m.inputTokens || 0,
    outputTokens: m.outputTokens || 0,
    cacheReadTokens: m.cacheReadTokens || 0,
    cacheWriteTokens: m.cacheWriteTokens || 0,
    reasoningTokens: m.reasoningTokens || 0,
    models
  };
}

function hasActiveTodayPeriod(session) {
  if (!session?.periods?.today) return false;
  const p = session.periods.today;
  const tokens = Number(p.totalTokens || p.tokens || 0);
  const cost = Number(p.costUsd || p.cost || 0);
  return tokens > 0 || cost > 0;
}

function resolveSessionDate(session) {
  if (!session || typeof session !== 'object') return '';
  if (hasActiveTodayPeriod(session) && session.day) {
    return normalizeDate(session.day);
  }
  if (session.periods && !hasActiveTodayPeriod(session)) {
    return normalizeDate(extractSessionTimestamp(session) || session.periods?.allTime?.lastUsedAt || session.day);
  }
  return normalizeDate(session.day || extractSessionTimestamp(session) || session.lastUsedAt);
}

function extractSessionTimestamp(session) {
  if (!session || typeof session !== 'object') return '';
  const ts = session.startedAt
    || session.periods?.allTime?.startedAt
    || session.periods?.month?.startedAt
    || session.periods?.today?.startedAt
    || '';
  return typeof ts === 'string' ? ts : '';
}

function syncActiveAccountSessions(sessions, activeAccount, ledger, options = {}) {
  const activeEmail = normalizeEmail(
    typeof activeAccount === 'string' ? activeAccount : (activeAccount?.email || ledger?.lastActiveAccount)
  );
  if (!activeEmail || !Array.isArray(sessions) || !ledger) {
    return { changed: false, ledger };
  }

  let changed = false;
  if (!ledger.sessionAccounts) {
    ledger.sessionAccounts = {};
  }

  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    if (session.client && !isAntigravityClient(session.client)) continue;

    const startedAt = extractSessionTimestamp(session);
    const hasToday = hasActiveTodayPeriod(session);
    const isEligible = Boolean(
      hasToday || (startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt)
    );

    if (!isEligible || !session.sessionId) continue;

    const metrics = extractSessionMetrics(session, { preferToday: hasToday });
    const existing = ledger.sessionAccounts[session.sessionId];

    if (!existing) {
      let targetEmail = activeEmail;
      if (startedAt && Array.isArray(ledger.timeline)) {
        for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
          const interval = ledger.timeline[i];
          if (interval.startedAt <= startedAt && interval.endedAt && startedAt <= interval.endedAt) {
            targetEmail = normalizeEmail(interval.email);
            break;
          }
        }
      }
      ledger.sessionAccounts[session.sessionId] = {
        email: targetEmail,
        boundAt: options.now || new Date().toISOString(),
        source: (typeof activeAccount === 'object' && activeAccount?.source) || 'active_account',
        lastSnapshot: cloneMetrics(metrics),
        allocations: { [targetEmail]: cloneMetrics(metrics) }
      };
      changed = true;
    } else {
      if (!existing.allocations || !existing.lastSnapshot) {
        const baseEmail = normalizeEmail(existing.email) || activeEmail;
        existing.allocations = { [baseEmail]: cloneMetrics(metrics) };
        existing.lastSnapshot = cloneMetrics(metrics);
        changed = true;
      } else if (metrics.totalTokens > existing.lastSnapshot.totalTokens || metrics.costUsd > existing.lastSnapshot.costUsd) {
        const deltaTokens = Math.max(0, metrics.totalTokens - existing.lastSnapshot.totalTokens);
        const deltaCost = Math.max(0, metrics.costUsd - existing.lastSnapshot.costUsd);
        const deltaInput = Math.max(0, metrics.inputTokens - existing.lastSnapshot.inputTokens);
        const deltaOutput = Math.max(0, metrics.outputTokens - existing.lastSnapshot.outputTokens);
        const deltaCacheRead = Math.max(0, metrics.cacheReadTokens - existing.lastSnapshot.cacheReadTokens);
        const deltaCacheWrite = Math.max(0, metrics.cacheWriteTokens - existing.lastSnapshot.cacheWriteTokens);
        const deltaReasoning = Math.max(0, metrics.reasoningTokens - existing.lastSnapshot.reasoningTokens);

        if (!existing.allocations[activeEmail]) {
          existing.allocations[activeEmail] = {
            totalTokens: 0,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            models: {}
          };
        }
        const targetAlloc = existing.allocations[activeEmail];
        targetAlloc.totalTokens += deltaTokens;
        targetAlloc.costUsd = Number((targetAlloc.costUsd + deltaCost).toFixed(6));
        targetAlloc.inputTokens += deltaInput;
        targetAlloc.outputTokens += deltaOutput;
        targetAlloc.cacheReadTokens += deltaCacheRead;
        targetAlloc.cacheWriteTokens += deltaCacheWrite;
        targetAlloc.reasoningTokens += deltaReasoning;

        if (!targetAlloc.models) targetAlloc.models = {};
        for (const [modelId, mm] of Object.entries(metrics.models)) {
          const prevM = existing.lastSnapshot.models?.[modelId] || emptyMetrics();
          const mDeltaTokens = Math.max(0, mm.tokens - prevM.tokens);
          const mDeltaCost = Math.max(0, mm.costUsd - prevM.costUsd);
          const mDeltaInput = Math.max(0, mm.inputTokens - prevM.inputTokens);
          const mDeltaOutput = Math.max(0, mm.outputTokens - prevM.outputTokens);
          const mDeltaCacheRead = Math.max(0, mm.cacheReadTokens - prevM.cacheReadTokens);
          const mDeltaCacheWrite = Math.max(0, mm.cacheWriteTokens - prevM.cacheWriteTokens);
          const mDeltaReasoning = Math.max(0, mm.reasoningTokens - prevM.reasoningTokens);

          if (mDeltaTokens > 0 || mDeltaCost > 0) {
            if (!targetAlloc.models[modelId]) targetAlloc.models[modelId] = emptyMetrics();
            const tam = targetAlloc.models[modelId];
            tam.tokens += mDeltaTokens;
            tam.costUsd = Number((tam.costUsd + mDeltaCost).toFixed(6));
            tam.inputTokens += mDeltaInput;
            tam.outputTokens += mDeltaOutput;
            tam.cacheReadTokens += mDeltaCacheRead;
            tam.cacheWriteTokens += mDeltaCacheWrite;
            tam.reasoningTokens += mDeltaReasoning;
          }
        }

        existing.lastSnapshot = cloneMetrics(metrics);
        existing.email = activeEmail;
        changed = true;
      }
    }
  }

  if (changed && options.save !== false) {
    const targetFile = typeof options.ledgerFile === 'string' ? options.ledgerFile : (options.ledgerFile || options);
    saveLedger(ledger, targetFile);
  }

  return { changed, ledger };
}

function attributeSession(session, ledger, options = {}) {
  if (!session || !ledger) {
    return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
  }

  const startedAt = extractSessionTimestamp(session);
  const hasToday = hasActiveTodayPeriod(session);
  const isPostActivation = Boolean(
    hasToday || (startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt)
  );

  const existingBinding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
  if (!isPostActivation) {
    if (existingBinding && existingBinding.source === 'manual') {
      return {
        email: normalizeEmail(existingBinding.email),
        source: 'manual',
        isUnattributed: false
      };
    }
    return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
  }

  if (existingBinding && existingBinding.email) {
    return {
      email: normalizeEmail(existingBinding.email),
      source: existingBinding.source || 'session_binding',
      isUnattributed: false
    };
  }

  if (startedAt && Array.isArray(ledger.timeline)) {
    for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
      const interval = ledger.timeline[i];
      if (interval.startedAt <= startedAt && (!interval.endedAt || startedAt <= interval.endedAt)) {
        const source = interval.source || 'timeline';
        const normEmail = normalizeEmail(interval.email);
        if (options.bindNewSessions !== false && session.sessionId) {
          if (!ledger.sessionAccounts) ledger.sessionAccounts = {};
          const metrics = extractSessionMetrics(session, { preferToday: hasToday });
          ledger.sessionAccounts[session.sessionId] = {
            email: normEmail,
            boundAt: options.now || new Date().toISOString(),
            source,
            lastSnapshot: cloneMetrics(metrics),
            allocations: { [normEmail]: cloneMetrics(metrics) }
          };
          if (options.save === true && options.ledgerFile) {
            saveLedger(ledger, options.ledgerFile);
          }
        }
        return {
          email: normEmail,
          source,
          isUnattributed: false
        };
      }
    }
  }

  const activeEmail = normalizeEmail(
    typeof options.activeAccount === 'string'
      ? options.activeAccount
      : (options.activeAccount?.email || ledger.lastActiveAccount || ledger.timeline?.[ledger.timeline.length - 1]?.email)
  );

  if (activeEmail) {
    const source = (typeof options.activeAccount === 'object' && options.activeAccount?.source) || 'active_account';
    if (options.bindNewSessions !== false && session.sessionId) {
      if (!ledger.sessionAccounts) ledger.sessionAccounts = {};
      const metrics = extractSessionMetrics(session, { preferToday: hasToday });
      ledger.sessionAccounts[session.sessionId] = {
        email: activeEmail,
        boundAt: options.now || new Date().toISOString(),
        source,
        lastSnapshot: cloneMetrics(metrics),
        allocations: { [activeEmail]: cloneMetrics(metrics) }
      };
      if (options.save === true && options.ledgerFile) {
        saveLedger(ledger, options.ledgerFile);
      }
    }
    return {
      email: activeEmail,
      source,
      isUnattributed: false
    };
  }

  return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
}

function emptyMetrics() {
  return {
    tokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  };
}

function emptyAccountBucket(email, displayName = '') {
  return {
    email,
    displayName: displayName || (email === 'unattributed' ? '历史汇总（未归属）' : email),
    totalTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    percentageOfTotal: 0,
    models: {}
  };
}

function extractSessionMetrics(session, options = {}) {
  const target = (options.preferToday && hasActiveTodayPeriod(session))
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
    for (const [modelId, modelTokens] of modelEntries) {
      const mTokens = Number(modelTokens || 0);
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
      m.reasoningTokens += Math.round(reasoningTokens * ratio);
    }
  } else {
    const modelId = target.modelId || target.model || session?.modelId || session?.model || 'unknown';
    if (!models[modelId]) models[modelId] = emptyMetrics();
    const m = models[modelId];
    m.tokens += totalTokens;
    m.costUsd += costUsd;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
    m.cacheReadTokens += cacheReadTokens;
    m.cacheWriteTokens += cacheWriteTokens;
    m.reasoningTokens += reasoningTokens;
  }

  return {
    totalTokens,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    models
  };
}

function extractObsMetrics(obs) {
  const tokens = Number(obs.tokens || obs.totalTokens || 0);
  const cost = Number(obs.cost || obs.costUsd || 0);
  const inputTokens = Number(obs.inputTokens || 0);
  const outputTokens = Number(obs.outputTokens || 0);
  const cacheReadTokens = Number(obs.cacheReadTokens || 0);
  const cacheWriteTokens = Number(obs.cacheWriteTokens || 0);
  const reasoningTokens = Number(obs.reasoningTokens || 0);
  const modelId = obs.modelId || obs.model || 'unknown';

  const models = {};
  models[modelId] = {
    tokens,
    costUsd: cost,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens
  };

  return {
    totalTokens: tokens,
    costUsd: cost,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    models
  };
}

function addUsageToBucket(bucket, usage) {
  bucket.totalTokens += usage.totalTokens;
  bucket.costUsd += usage.costUsd;
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.cacheReadTokens += usage.cacheReadTokens;
  bucket.cacheWriteTokens += usage.cacheWriteTokens;
  bucket.reasoningTokens += usage.reasoningTokens;

  for (const [modelId, m] of Object.entries(usage.models)) {
    if (!bucket.models[modelId]) bucket.models[modelId] = emptyMetrics();
    const target = bucket.models[modelId];
    target.tokens += m.tokens;
    target.costUsd += m.costUsd;
    target.inputTokens += m.inputTokens;
    target.outputTokens += m.outputTokens;
    target.cacheReadTokens += m.cacheReadTokens;
    target.cacheWriteTokens += m.cacheWriteTokens;
    target.reasoningTokens += m.reasoningTokens;
  }
}

function aggregateAccountUsage(args = {}, options = {}) {
  const {
    sessions = [],
    dailyHistory = [],
    range = null,
    accountFilter = 'all',
    discoveredAccounts = []
  } = args;

  const ledger = args.ledger || options.ledger;
  const filter = normalizeEmail(accountFilter) || 'all';

  let startDay = range?.start ? normalizeDate(range.start) : null;
  let endDay = range?.end ? normalizeDate(range.end) : null;
  if (startDay && endDay && startDay > endDay) {
    const tmp = startDay;
    startDay = endDay;
    endDay = tmp;
  }

  const byAccount = {};

  function getOrCreateAccount(email, displayName = '') {
    if (!byAccount[email]) {
      byAccount[email] = emptyAccountBucket(email, displayName);
    }
    return byAccount[email];
  }

  for (const acc of discoveredAccounts) {
    const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
    if (!email) continue;
    const displayName = (typeof acc === 'object' && (acc.displayName || acc.name)) || email;
    getOrCreateAccount(email, displayName);
  }

  let allDailyObservations = [];
  if (Array.isArray(dailyHistory)) {
    allDailyObservations = dailyHistory;
  } else if (dailyHistory && typeof dailyHistory === 'object' && dailyHistory.days) {
    for (const [dayKey, dayObj] of Object.entries(dailyHistory.days)) {
      if (dayObj && dayObj.observations) {
        for (const obs of Object.values(dayObj.observations)) {
          if (obs && !obs.day && !obs.date) {
            allDailyObservations.push({ ...obs, day: dayKey });
          } else {
            allDailyObservations.push(obs);
          }
        }
      }
    }
  }

  const hasDailyHistory = allDailyObservations.length > 0;

  if (!hasDailyHistory) {
    // If dailyHistory is empty (e.g. unit tests passing only sessions), process all sessions directly
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        if (!isAntigravityClient(session?.client)) continue;
        const sessionDate = resolveSessionDate(session);
        if (sessionDate) {
          if (startDay && sessionDate < startDay) continue;
          if (endDay && sessionDate > endDay) continue;
        }

        const startedAt = extractSessionTimestamp(session);
        const hasToday = hasActiveTodayPeriod(session);
        const isEligible = Boolean(
          hasToday || (startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt)
        );
        const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];

        if (isEligible && binding?.allocations && Object.keys(binding.allocations).length > 0) {
          for (const [allocEmail, allocMetrics] of Object.entries(binding.allocations)) {
            addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
          }
        } else {
          const attr = attributeSession(session, ledger, { bindNewSessions: options.bindNewSessions ?? false });
          const sMetrics = extractSessionMetrics(session, { preferToday: hasToday });
          addUsageToBucket(getOrCreateAccount(attr.email), sMetrics);
        }
      }
    }
  } else {
    // When dailyHistory is provided and non-empty:
    const filteredObservations = [];
    for (const obs of allDailyObservations) {
      if (!isAntigravityClient(obs?.client)) continue;
      const obsDate = normalizeDate(obs.day || obs.date);
      if (obsDate) {
        if (startDay && obsDate < startDay) continue;
        if (endDay && obsDate > endDay) continue;
      }
      filteredObservations.push(obs);
    }

    const postActSessionsByDay = new Map();
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        if (!isAntigravityClient(session?.client)) continue;
        const startedAt = extractSessionTimestamp(session);
        const hasToday = hasActiveTodayPeriod(session);
        const isPostActivation = Boolean(
          hasToday || (startedAt && ledger.featureActivatedAt && startedAt >= ledger.featureActivatedAt)
        );
        const isManualBinding = session.sessionId && ledger.sessionAccounts?.[session.sessionId]?.source === 'manual';
        if (!isPostActivation && !isManualBinding) continue;

        const sessionDate = resolveSessionDate(session);
        if (sessionDate) {
          if (startDay && sessionDate < startDay) continue;
          if (endDay && sessionDate > endDay) continue;
        }

        const dayKey = sessionDate || 'unknown';
        if (!postActSessionsByDay.has(dayKey)) {
          postActSessionsByDay.set(dayKey, []);
        }
        postActSessionsByDay.get(dayKey).push(session);
      }
    }

    const obsByDay = new Map();
    for (const obs of filteredObservations) {
      const d = normalizeDate(obs.day || obs.date) || 'unknown';
      if (!obsByDay.has(d)) obsByDay.set(d, []);
      obsByDay.get(d).push(obs);
    }

    // For any day d that has dailyHistory observations:
    for (const [d, dayObsList] of obsByDay.entries()) {
      let dayObsTotalTokens = 0;
      let dayObsCostUsd = 0;
      let dayObsInput = 0;
      let dayObsOutput = 0;
      let dayObsCacheRead = 0;
      let dayObsCacheWrite = 0;
      let dayObsReasoning = 0;
      const dayObsModels = {};

      for (const obs of dayObsList) {
        const m = extractObsMetrics(obs);
        dayObsTotalTokens += m.totalTokens;
        dayObsCostUsd += m.costUsd;
        dayObsInput += m.inputTokens;
        dayObsOutput += m.outputTokens;
        dayObsCacheRead += m.cacheReadTokens;
        dayObsCacheWrite += m.cacheWriteTokens;
        dayObsReasoning += m.reasoningTokens;
        for (const [modelId, mm] of Object.entries(m.models)) {
          if (!dayObsModels[modelId]) dayObsModels[modelId] = emptyMetrics();
          const target = dayObsModels[modelId];
          target.tokens += mm.tokens;
          target.costUsd += mm.costUsd;
          target.inputTokens += mm.inputTokens;
          target.outputTokens += mm.outputTokens;
          target.cacheReadTokens += mm.cacheReadTokens;
          target.cacheWriteTokens += mm.cacheWriteTokens;
          target.reasoningTokens += mm.reasoningTokens;
        }
      }

      const daySessions = postActSessionsByDay.get(d) || [];
      let subTokens = 0;
      let subCost = 0;
      let subInput = 0;
      let subOutput = 0;
      let subCacheRead = 0;
      let subCacheWrite = 0;
      let subReasoning = 0;
      const subModels = {};

      function addSubMetrics(m) {
        subTokens += m.totalTokens;
        subCost += m.costUsd;
        subInput += m.inputTokens;
        subOutput += m.outputTokens;
        subCacheRead += m.cacheReadTokens;
        subCacheWrite += m.cacheWriteTokens;
        subReasoning += m.reasoningTokens;
        for (const [modelId, mm] of Object.entries(m.models || {})) {
          if (!subModels[modelId]) subModels[modelId] = emptyMetrics();
          const target = subModels[modelId];
          target.tokens += mm.tokens;
          target.costUsd += mm.costUsd;
          target.inputTokens += mm.inputTokens;
          target.outputTokens += mm.outputTokens;
          target.cacheReadTokens += mm.cacheReadTokens;
          target.cacheWriteTokens += mm.cacheWriteTokens;
          target.reasoningTokens += mm.reasoningTokens;
        }
      }

      for (const session of daySessions) {
        const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
        const hasToday = hasActiveTodayPeriod(session);
        if (binding?.allocations && Object.keys(binding.allocations).length > 0) {
          for (const [allocEmail, allocMetrics] of Object.entries(binding.allocations)) {
            addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
            addSubMetrics(allocMetrics);
          }
        } else {
          const sAttr = attributeSession(session, ledger, { bindNewSessions: options.bindNewSessions ?? false });
          const sMetrics = extractSessionMetrics(session, { preferToday: hasToday });
          addUsageToBucket(getOrCreateAccount(sAttr.email), sMetrics);
          addSubMetrics(sMetrics);
        }
      }

      const remTokens = Math.max(0, dayObsTotalTokens - subTokens);
      const remCost = Math.max(0, dayObsCostUsd - subCost);
      const remInput = Math.max(0, dayObsInput - subInput);
      const remOutput = Math.max(0, dayObsOutput - subOutput);
      const remCacheRead = Math.max(0, dayObsCacheRead - subCacheRead);
      const remCacheWrite = Math.max(0, dayObsCacheWrite - subCacheWrite);
      const remReasoning = Math.max(0, dayObsReasoning - subReasoning);

      const remModels = {};
      for (const [modelId, mm] of Object.entries(dayObsModels)) {
        const smm = subModels[modelId] || emptyMetrics();
        const mTokens = Math.max(0, mm.tokens - smm.tokens);
        const mCost = Math.max(0, mm.costUsd - smm.costUsd);
        if (mTokens > 0 || mCost > 0) {
          remModels[modelId] = {
            tokens: mTokens,
            costUsd: mCost,
            inputTokens: Math.max(0, mm.inputTokens - smm.inputTokens),
            outputTokens: Math.max(0, mm.outputTokens - smm.outputTokens),
            cacheReadTokens: Math.max(0, mm.cacheReadTokens - smm.cacheReadTokens),
            cacheWriteTokens: Math.max(0, mm.cacheWriteTokens - smm.cacheWriteTokens),
            reasoningTokens: Math.max(0, mm.reasoningTokens - smm.reasoningTokens)
          };
        }
      }

      if (remTokens > 0 || remCost > 0) {
        const unattributedBucket = getOrCreateAccount('unattributed');
        addUsageToBucket(unattributedBucket, {
          totalTokens: remTokens,
          costUsd: remCost,
          inputTokens: remInput,
          outputTokens: remOutput,
          cacheReadTokens: remCacheRead,
          cacheWriteTokens: remCacheWrite,
          reasoningTokens: remReasoning,
          models: remModels
        });
      }
    }

    // Process post-activation sessions for days without dailyHistory observations
    for (const [d, daySessions] of postActSessionsByDay.entries()) {
      if (obsByDay.has(d)) continue;
      for (const session of daySessions) {
        const binding = session.sessionId && ledger.sessionAccounts?.[session.sessionId];
        const hasToday = hasActiveTodayPeriod(session);
        if (binding?.allocations && Object.keys(binding.allocations).length > 0) {
          for (const [allocEmail, allocMetrics] of Object.entries(binding.allocations)) {
            addUsageToBucket(getOrCreateAccount(allocEmail), allocMetrics);
          }
        } else {
          const sAttr = attributeSession(session, ledger, { bindNewSessions: options.bindNewSessions ?? false });
          const sMetrics = extractSessionMetrics(session, { preferToday: hasToday });
          addUsageToBucket(getOrCreateAccount(sAttr.email), sMetrics);
        }
      }
    }
  }

  if (filter === 'unattributed' && !byAccount.unattributed) {
    getOrCreateAccount('unattributed');
  }

  let overallTotalTokens = 0;
  let overallCostUsd = 0;
  let overallInputTokens = 0;
  let overallOutputTokens = 0;
  let overallCacheReadTokens = 0;
  let overallCacheWriteTokens = 0;
  let overallReasoningTokens = 0;
  const overallModels = {};

  for (const bucket of Object.values(byAccount)) {
    overallTotalTokens += bucket.totalTokens;
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
      om.reasoningTokens += m.reasoningTokens;
    }
  }

  for (const bucket of Object.values(byAccount)) {
    bucket.percentageOfTotal = overallTotalTokens > 0
      ? Number(((bucket.totalTokens / overallTotalTokens) * 100).toFixed(2))
      : 0;
    bucket.costUsd = Number(bucket.costUsd.toFixed(6));
    for (const m of Object.values(bucket.models)) {
      m.costUsd = Number(m.costUsd.toFixed(6));
    }
  }
  for (const om of Object.values(overallModels)) {
    om.costUsd = Number(om.costUsd.toFixed(6));
  }

  let totalTokens;
  let costUsd;
  let inputTokens;
  let outputTokens;
  let cacheReadTokens;
  let cacheWriteTokens;
  let reasoningTokens;
  let models;

  if (filter === 'all') {
    totalTokens = overallTotalTokens;
    costUsd = Number(overallCostUsd.toFixed(6));
    inputTokens = overallInputTokens;
    outputTokens = overallOutputTokens;
    cacheReadTokens = overallCacheReadTokens;
    cacheWriteTokens = overallCacheWriteTokens;
    reasoningTokens = overallReasoningTokens;
    models = overallModels;
  } else {
    const target = byAccount[filter] || emptyAccountBucket(filter);
    totalTokens = target.totalTokens;
    costUsd = target.costUsd;
    inputTokens = target.inputTokens;
    outputTokens = target.outputTokens;
    cacheReadTokens = target.cacheReadTokens;
    cacheWriteTokens = target.cacheWriteTokens;
    reasoningTokens = target.reasoningTokens;
    models = target.models;
  }

  const accounts = Object.values(byAccount);
  accounts.sort((a, b) => b.totalTokens - a.totalTokens || a.email.localeCompare(b.email));

  return {
    accountFilter: filter,
    totalTokens,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    models,
    accounts,
    byAccount,
    overallTotalTokens
  };
}

function loadArchivedSessions(sharedDir) {
  if (!DatabaseSync) return [];
  const dbPath = path.join(sharedDir, 'session-usage-archive.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
      try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
      const rows = db.prepare('SELECT entry_json FROM sessions').all();
      const sessions = [];
      for (const row of rows) {
        try {
          const entry = JSON.parse(row.entry_json);
          if (entry && isAntigravityClient(entry.client)) {
            sessions.push(entry);
          }
        } catch (_) {}
      }
      return sessions;
    } finally {
      try { db.close(); } catch (_) {}
    }
  } catch (_) {
    return [];
  }
}

exports.activate = async ({ dataDirectory }) => {
  const ledgerFile = path.join(dataDirectory, DEFAULT_LEDGER_FILENAME);
  let ledger = loadLedger(ledgerFile);

  function syncNow() {
    try {
      const sharedDir = getSharedDataDir();
      const settings = readJson(path.join(sharedDir, 'settings.json'), {});
      const activeAccount = detectActiveAccount({ settings });
      if (activeAccount) {
        const hb = recordAccountHeartbeat(activeAccount, new Date().toISOString(), ledger, ledgerFile);
        ledger = hb.ledger;
      }
      const sessions = loadArchivedSessions(sharedDir);
      if (activeAccount && sessions.length > 0) {
        const res = syncActiveAccountSessions(sessions, activeAccount, ledger, { ledgerFile, save: true });
        ledger = res.ledger;
      }
    } catch (_) {}
  }

  syncNow();
  const syncTimer = setInterval(syncNow, 15000);
  if (syncTimer.unref) {
    syncTimer.unref();
  }

  async function getSummaryPayload({ range = null, accountFilter = 'all' } = {}) {
    syncNow();
    const sharedDir = getSharedDataDir();
    const settings = readJson(path.join(sharedDir, 'settings.json'), {});
    const discoveredAccounts = discoverAccounts({ settings });
    const activeAccount = detectActiveAccount({ settings });
    const dailyHistory = readJson(path.join(sharedDir, 'daily-history-archive.json'), null);
    const sessions = loadArchivedSessions(sharedDir);

    const summary = aggregateAccountUsage({
      sessions,
      dailyHistory,
      range,
      accountFilter,
      discoveredAccounts,
      ledger
    });

    return {
      summary,
      discoveredAccounts,
      activeAccount,
      ledger
    };
  }

  return {
    async call(method, args = {}) {
      if (method === 'getSummary') {
        return await getSummaryPayload(args);
      }
      throw new Error(`Unknown method: ${method}`);
    },
    dispose() {
      clearInterval(syncTimer);
    }
  };
};
