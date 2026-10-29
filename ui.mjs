function formatTokens(num) {
const n = Number(num || 0);
if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
return String(n);
}
function formatCost(usd) {
const n = Number(usd || 0);
return '$' + n.toFixed(2);
}
function getTodayString() {
const d = new Date();
const year = d.getFullYear();
const month = String(d.getMonth() + 1).padStart(2, '0');
const day = String(d.getDate()).padStart(2, '0');
return `${year}-${month}-${day}`;
}
function getFirstDayOfMonthString() {
const d = new Date();
const year = d.getFullYear();
const month = String(d.getMonth() + 1).padStart(2, '0');
return `${year}-${month}-01`;
}
export function activate(ctx) {
return {
mount(container, context) {
let isDisposed = false;
let startDate = getFirstDayOfMonthString();
let endDate = getTodayString();
let accountFilter = 'all';
let state = null;
let isLoading = false;
let loadError = null;
let isVisible = true;
let isPluginCollapsed = false;
try {
const saved = localStorage.getItem('ag_ledger_plugin_collapsed');
if (saved !== null) {
isPluginCollapsed = saved === 'true';
}
} catch {
}
let isAccountSectionExpanded = false;
try {
const saved = localStorage.getItem('ag_ledger_accounts_expanded');
if (saved !== null) {
isAccountSectionExpanded = saved === 'true';
}
} catch {
}
const root = document.createElement('div');
root.className = `ag-ledger-root surface-${context?.surface || 'home'}`;
container.append(root);
const activeBadge = document.createElement('span');
activeBadge.className = 'ag-ledger-badge';
activeBadge.textContent = '检测活跃账号中...';
const compactSummary = document.createElement('span');
compactSummary.className = 'ag-ledger-compact-summary ag-ledger-num';
compactSummary.textContent = `${formatTokens(0)} · ${formatCost(0)}`;
const collapseBtn = document.createElement('button');
collapseBtn.type = 'button';
collapseBtn.className = 'ag-ledger-collapse-btn';
const headerRight = document.createElement('div');
headerRight.className = 'ag-ledger-header-right';
headerRight.append(activeBadge, compactSummary, collapseBtn);
const header = document.createElement('header');
header.className = 'ag-ledger-header';
const headerTitle = document.createElement('div');
headerTitle.className = 'ag-ledger-header-title';
const title = document.createElement('span');
title.className = 'ag-ledger-title';
title.textContent = 'Antigravity 多账号账本';
const titleHint = document.createElement('span');
titleHint.className = 'ag-ledger-title-hint';
titleHint.textContent = '自动多账号归属';
headerTitle.append(title, titleHint);
function onHeaderClick(e) {
if (e.target.closest('.ag-ledger-collapse-btn')) return;
togglePluginCollapse();
}
header.append(headerTitle, headerRight);
header.addEventListener('click', onHeaderClick);
root.append(header);
const body = document.createElement('div');
body.className = 'ag-ledger-body';
root.append(body);
const filterBar = document.createElement('div');
filterBar.className = 'ag-ledger-bar';
const dateGroup = document.createElement('div');
dateGroup.className = 'ag-ledger-group';
const dateLabel = document.createElement('span');
dateLabel.className = 'ag-ledger-label';
dateLabel.textContent = '统计区间:';
const startInput = document.createElement('input');
startInput.type = 'date';
startInput.className = 'ag-ledger-date';
startInput.value = startDate;
const toSpan = document.createElement('span');
toSpan.className = 'ag-ledger-label';
toSpan.textContent = '至';
const endInput = document.createElement('input');
endInput.type = 'date';
endInput.className = 'ag-ledger-date';
endInput.value = endDate;
dateGroup.append(dateLabel, startInput, toSpan, endInput);
const accountGroup = document.createElement('div');
accountGroup.className = 'ag-ledger-group';
const accountLabel = document.createElement('span');
accountLabel.className = 'ag-ledger-label';
accountLabel.textContent = '账号筛选:';
const accountSelect = document.createElement('select');
accountSelect.className = 'ag-ledger-select';
const defaultOpt = document.createElement('option');
defaultOpt.value = 'all';
defaultOpt.textContent = '全部 Antigravity 账号 (All Accounts)';
accountSelect.append(defaultOpt);
accountGroup.append(accountLabel, accountSelect);
filterBar.append(dateGroup, accountGroup);
body.append(filterBar);
const statusBanner = document.createElement('div');
statusBanner.className = 'ag-ledger-status-banner';
statusBanner.setAttribute('role', 'status');
body.append(statusBanner);
const kpiGrid = document.createElement('div');
kpiGrid.className = 'ag-ledger-kpi-grid';
body.append(kpiGrid);
const modelSection = document.createElement('div');
modelSection.className = 'ag-ledger-section';
const modelTitle = document.createElement('h4');
modelTitle.className = 'ag-ledger-section-title';
modelTitle.textContent = '模型用量与费用明细';
modelSection.append(modelTitle);
const modelTableWrap = document.createElement('div');
modelTableWrap.className = 'ag-ledger-table-wrap';
modelSection.append(modelTableWrap);
body.append(modelSection);
const accountSection = document.createElement('div');
accountSection.className = 'ag-ledger-section';
const accountToggle = document.createElement('button');
accountToggle.type = 'button';
accountToggle.className = 'ag-ledger-section-toggle';
const accountToggleLeft = document.createElement('span');
accountToggleLeft.className = 'ag-ledger-section-toggle-left';
const accountChevron = document.createElement('span');
accountChevron.className = 'ag-ledger-chevron';
const accountTitle = document.createElement('span');
accountTitle.textContent = '各 Google 账号用量占比';
accountToggleLeft.append(accountChevron, accountTitle);
const accountToggleHint = document.createElement('span');
accountToggleHint.className = 'ag-ledger-toggle-hint';
accountToggle.append(accountToggleLeft, accountToggleHint);
accountSection.append(accountToggle);
const accountTableWrap = document.createElement('div');
accountTableWrap.className = 'ag-ledger-table-wrap';
accountSection.append(accountTableWrap);
body.append(accountSection);
function updateAccountSectionCollapse() {
accountToggle.setAttribute('aria-expanded', String(isAccountSectionExpanded));
accountChevron.textContent = isAccountSectionExpanded ? '▾' : '▸';
accountToggleHint.textContent = isAccountSectionExpanded ? '点击收起' : '点击展开';
if (isAccountSectionExpanded) {
accountTableWrap.classList.remove('hidden');
} else {
accountTableWrap.classList.add('hidden');
}
}
accountToggle.addEventListener('click', () => {
isAccountSectionExpanded = !isAccountSectionExpanded;
try {
localStorage.setItem('ag_ledger_accounts_expanded', String(isAccountSectionExpanded));
} catch {
}
updateAccountSectionCollapse();
});
updateAccountSectionCollapse();
function updatePluginCollapse() {
collapseBtn.setAttribute('aria-expanded', String(!isPluginCollapsed));
collapseBtn.textContent = isPluginCollapsed ? '展开 ▾' : '收起 ▴';
root.classList.toggle('is-collapsed', isPluginCollapsed);
body.classList.toggle('hidden', isPluginCollapsed);
activeBadge.classList.toggle('hidden', isPluginCollapsed);
compactSummary.classList.toggle('hidden', !isPluginCollapsed);
}
function togglePluginCollapse() {
isPluginCollapsed = !isPluginCollapsed;
try {
localStorage.setItem('ag_ledger_plugin_collapsed', String(isPluginCollapsed));
} catch {
}
updatePluginCollapse();
}
collapseBtn.addEventListener('click', (e) => {
e.stopPropagation();
togglePluginCollapse();
});
updatePluginCollapse();
function renderStatusBanner() {
statusBanner.replaceChildren();
statusBanner.classList.remove('is-error');
statusBanner.setAttribute('role', 'status');
if (loadError) {
statusBanner.classList.add('is-error');
const message = document.createElement('span');
message.className = 'ag-ledger-status-text';
message.textContent = `读取用量数据失败：${loadError}`;
const retryBtn = document.createElement('button');
retryBtn.type = 'button';
retryBtn.className = 'ag-ledger-btn ag-ledger-retry-btn';
retryBtn.textContent = '重试';
retryBtn.addEventListener('click', () => {
refreshSummary();
});
statusBanner.append(message, retryBtn);
return;
}
if (isLoading || !state) {
statusBanner.textContent = '正在扫描本地 Antigravity 用量记录...';
return;
}
const summary = state.summary || state;
const totalTokens = Number(summary?.totalTokens || 0);
const costUsd = Number(summary?.costUsd || 0);
const cov = summary?.coverage || {};
const overallTokens = Number(summary?.overallTotalTokens ?? totalTokens);
const overallCostUsd = Number(summary?.overallCostUsd ?? costUsd);
const isSpecificAccount = accountFilter && accountFilter !== 'all' && accountFilter !== 'unattributed';
if (accountFilter === 'all') {
const tokenCoverage = cov.tokenCoveragePercent ?? 100;
const costCoverage = cov.costCoveragePercent ?? 100;
statusBanner.textContent = `自动多账号归属（实时心跳时间线 + 配额周期/日志锚点）· 已归属到具体账号：${tokenCoverage}% Tokens（${formatTokens(cov.attributedTokens)} / ${formatTokens(overallTokens)}）· ${costCoverage}% 费用（${formatCost(cov.attributedCostUsd)} / ${formatCost(overallCostUsd)}）；其余归入「历史汇总（未归属）」。`;
} else if (accountFilter === 'unattributed') {
statusBanner.textContent = '当前正在查看：历史汇总（未归属） — 仅包含未能通过心跳时间线、配额周期或日志锚点关联到具体账号的历史记录。';
} else if (isSpecificAccount) {
if (totalTokens === 0) {
statusBanner.textContent = '该账号在所选区间暂无归属记录（切换至该账号使用 Antigravity 后将自动记录并归属用量）。';
} else {
const accShare = summary?.accounts?.find(a => a.email === accountFilter)?.percentageOfTotal || 0;
statusBanner.textContent = `当前账号归属用量：${formatTokens(totalTokens)} Tokens · 折算费用 ${formatCost(costUsd)}（在当前区间占比 ${accShare}%）。`;
}
}
}
async function refreshSummary() {
if (isLoading || isDisposed) return;
isLoading = true;
loadError = null;
renderStatusBanner();
try {
const res = await ctx.backend.call('getSummary', {
range: { start: startDate, end: endDate },
accountFilter
});
if (!isDisposed && res) {
state = res;
}
} catch (err) {
console.error('[ag-ledger] getSummary error:', err);
if (!isDisposed) {
loadError = err?.message || '读取用量数据失败';
}
} finally {
isLoading = false;
if (!isDisposed) {
if (state) {
render();
} else {
renderStatusBanner();
}
}
}
}
startInput.addEventListener('change', () => {
startDate = startInput.value;
refreshSummary();
});
endInput.addEventListener('change', () => {
endDate = endInput.value;
refreshSummary();
});
accountSelect.addEventListener('change', () => {
accountFilter = accountSelect.value;
refreshSummary();
});
function render() {
if (!state) return;
const summary = state.summary || state;
const discoveredAccounts = state.discoveredAccounts || [];
const activeAccount = state.activeAccount || null;
const totalTokens = Number(summary?.totalTokens || 0);
const costUsd = Number(summary?.costUsd || 0);
const inputTokens = Number(summary?.inputTokens || 0);
const outputTokens = Number(summary?.outputTokens || 0);
const cacheReadTokens = Number(summary?.cacheReadTokens || 0);
const reasoningTokens = Number(summary?.reasoningTokens || 0);
activeBadge.replaceChildren();
if (activeAccount?.email) {
activeBadge.className = 'ag-ledger-badge active';
const dot = document.createElement('span');
dot.className = 'ag-ledger-badge-dot';
const text = document.createElement('span');
text.textContent = `Active: ${activeAccount.email}`;
activeBadge.append(dot, text);
} else {
activeBadge.className = 'ag-ledger-badge';
activeBadge.textContent = '未检测到活跃账号';
}
activeBadge.classList.toggle('hidden', isPluginCollapsed);
const currentSelected = accountSelect.value;
accountSelect.replaceChildren();
const optAll = document.createElement('option');
optAll.value = 'all';
optAll.textContent = '全部 Antigravity 账号 (All Accounts)';
accountSelect.append(optAll);
const optUnattr = document.createElement('option');
optUnattr.value = 'unattributed';
optUnattr.textContent = '历史汇总（未归属）';
accountSelect.append(optUnattr);
const normalizedAccounts = (discoveredAccounts || []).map((acc) => (
typeof acc === 'string' ? { email: acc, displayName: acc } : acc
)).filter((acc) => acc && acc.email);
for (const acc of normalizedAccounts) {
const label = acc.displayName && acc.displayName !== acc.email
? `${acc.email} (${acc.displayName})`
: acc.email;
const opt = document.createElement('option');
opt.value = acc.email;
opt.textContent = label;
accountSelect.append(opt);
}
accountSelect.value = currentSelected || accountFilter;
compactSummary.textContent = `${formatTokens(totalTokens)} · ${formatCost(costUsd)}`;
compactSummary.classList.toggle('hidden', !isPluginCollapsed);
renderStatusBanner();
kpiGrid.replaceChildren();
const cardTokens = document.createElement('div');
cardTokens.className = 'ag-ledger-kpi-card';
const labelTokens = document.createElement('span');
labelTokens.className = 'ag-ledger-kpi-label';
labelTokens.textContent = '总 Token 消耗';
const valTokens = document.createElement('span');
valTokens.className = 'ag-ledger-kpi-value ag-ledger-num';
valTokens.textContent = formatTokens(totalTokens);
valTokens.title = totalTokens.toLocaleString();
cardTokens.append(labelTokens, valTokens);
kpiGrid.append(cardTokens);
const cardCost = document.createElement('div');
cardCost.className = 'ag-ledger-kpi-card';
const labelCost = document.createElement('span');
labelCost.className = 'ag-ledger-kpi-label';
labelCost.textContent = '折算费用 (USD)';
const valCost = document.createElement('span');
valCost.className = 'ag-ledger-kpi-value ag-ledger-num';
valCost.textContent = formatCost(costUsd);
valCost.title = `$${costUsd.toFixed(6)}`;
cardCost.append(labelCost, valCost);
kpiGrid.append(cardCost);
const cardBreakdown = document.createElement('div');
cardBreakdown.className = 'ag-ledger-kpi-card';
const labelBreakdown = document.createElement('span');
labelBreakdown.className = 'ag-ledger-kpi-label';
labelBreakdown.textContent = 'Token 组成明细';
const subBreakdown = document.createElement('div');
subBreakdown.className = 'ag-ledger-kpi-sub ag-ledger-num';
subBreakdown.textContent = `输入: ${formatTokens(inputTokens)} · 输出: ${formatTokens(outputTokens)} · 缓存读取: ${formatTokens(cacheReadTokens)} · 思考: ${formatTokens(reasoningTokens)}`;
cardBreakdown.append(labelBreakdown, subBreakdown);
kpiGrid.append(cardBreakdown);
accountTableWrap.replaceChildren();
const accTable = document.createElement('table');
accTable.className = 'ag-ledger-table';
const thead = document.createElement('thead');
const trHead = document.createElement('tr');
for (const titleText of ['账号 (Account)', '活跃状态', 'Tokens', '费用 (Cost)', '占比 (%)']) {
const th = document.createElement('th');
th.className = 'ag-ledger-th';
th.textContent = titleText;
trHead.append(th);
}
thead.append(trHead);
accTable.append(thead);
const tbody = document.createElement('tbody');
const accountsList = summary?.accounts || [];
for (const acc of accountsList) {
const tr = document.createElement('tr');
tr.className = 'ag-ledger-row';
const tdName = document.createElement('td');
tdName.className = 'ag-ledger-td';
const nameWrap = document.createElement('div');
nameWrap.className = 'ag-ledger-account-name';
const nameSpan = document.createElement('span');
if (acc.email === 'unattributed') {
nameSpan.textContent = '历史汇总（未归属）';
} else {
nameSpan.textContent = acc.displayName || acc.email;
}
nameWrap.append(nameSpan);
if (acc.email !== 'unattributed' && acc.displayName && acc.displayName !== acc.email) {
const subSpan = document.createElement('span');
subSpan.className = 'ag-ledger-account-sub';
subSpan.textContent = acc.email;
nameWrap.append(subSpan);
}
tdName.append(nameWrap);
const tdStatus = document.createElement('td');
tdStatus.className = 'ag-ledger-td';
if (acc.email === 'unattributed') {
const sub = document.createElement('span');
sub.className = 'ag-ledger-account-sub';
sub.textContent = '只读历史';
tdStatus.append(sub);
} else if (activeAccount?.email && acc.email.toLowerCase() === activeAccount.email.toLowerCase()) {
const badge = document.createElement('span');
badge.className = 'ag-ledger-badge active';
const dot = document.createElement('span');
dot.className = 'ag-ledger-badge-dot';
const badgeText = document.createElement('span');
badgeText.textContent = '当前在线';
badge.append(dot, badgeText);
tdStatus.append(badge);
} else {
const sub = document.createElement('span');
sub.className = 'ag-ledger-account-sub';
sub.textContent = '未在线';
tdStatus.append(sub);
}
const tdTokens = document.createElement('td');
tdTokens.className = 'ag-ledger-td ag-ledger-num';
tdTokens.textContent = formatTokens(acc.totalTokens);
tdTokens.title = acc.totalTokens.toLocaleString();
const tdCost = document.createElement('td');
tdCost.className = 'ag-ledger-td ag-ledger-num';
tdCost.textContent = formatCost(acc.costUsd);
tdCost.title = `$${acc.costUsd.toFixed(6)}`;
const tdShare = document.createElement('td');
tdShare.className = 'ag-ledger-td';
const shareWrap = document.createElement('div');
shareWrap.className = 'ag-ledger-share-bar';
const progress = document.createElement('div');
progress.className = 'ag-ledger-progress';
const fill = document.createElement('div');
const pct = Math.min(100, Math.max(0, Math.round((acc.percentageOfTotal || 0) / 10) * 10));
fill.className = `ag-ledger-progress-fill w-${pct}`;
fill.setAttribute('data-percent', String(acc.percentageOfTotal || 0));
progress.append(fill);
const percentText = document.createElement('span');
percentText.className = 'ag-ledger-num ag-ledger-account-sub';
percentText.textContent = `${acc.percentageOfTotal || 0}%`;
shareWrap.append(progress, percentText);
tdShare.append(shareWrap);
tr.append(tdName, tdStatus, tdTokens, tdCost, tdShare);
tbody.append(tr);
}
accTable.append(tbody);
accountTableWrap.append(accTable);
modelTableWrap.replaceChildren();
const modelTable = document.createElement('table');
modelTable.className = 'ag-ledger-table';
const mThead = document.createElement('thead');
const mTrHead = document.createElement('tr');
for (const titleText of ['模型', '总 Token', '输入', '输出', '缓存读取', '思考/推理', '折算费用']) {
const th = document.createElement('th');
th.className = 'ag-ledger-th';
th.textContent = titleText;
mTrHead.append(th);
}
mThead.append(mTrHead);
modelTable.append(mThead);
const mTbody = document.createElement('tbody');
const modelEntries = Object.entries(summary?.models || {});
modelEntries.sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
if (modelEntries.length === 0) {
const trEmpty = document.createElement('tr');
const tdEmpty = document.createElement('td');
tdEmpty.className = 'ag-ledger-td ag-ledger-empty';
tdEmpty.colSpan = 7;
tdEmpty.textContent = '当前所选区间无模型用量记录';
trEmpty.append(tdEmpty);
mTbody.append(trEmpty);
} else {
for (const [modelId, m] of modelEntries) {
const tr = document.createElement('tr');
tr.className = 'ag-ledger-row';
const tdModel = document.createElement('td');
tdModel.className = 'ag-ledger-td ag-ledger-account-name';
tdModel.textContent = modelId;
const tdMTotal = document.createElement('td');
tdMTotal.className = 'ag-ledger-td ag-ledger-num';
tdMTotal.textContent = formatTokens(m.tokens);
tdMTotal.title = m.tokens.toLocaleString();
const tdMIn = document.createElement('td');
tdMIn.className = 'ag-ledger-td ag-ledger-num';
tdMIn.textContent = formatTokens(m.inputTokens);
tdMIn.title = m.inputTokens.toLocaleString();
const tdMOut = document.createElement('td');
tdMOut.className = 'ag-ledger-td ag-ledger-num';
tdMOut.textContent = formatTokens(m.outputTokens);
tdMOut.title = m.outputTokens.toLocaleString();
const tdMCache = document.createElement('td');
tdMCache.className = 'ag-ledger-td ag-ledger-num';
tdMCache.textContent = formatTokens(m.cacheReadTokens);
tdMCache.title = m.cacheReadTokens.toLocaleString();
const tdMReason = document.createElement('td');
tdMReason.className = 'ag-ledger-td ag-ledger-num';
tdMReason.textContent = formatTokens(m.reasoningTokens);
tdMReason.title = m.reasoningTokens.toLocaleString();
const tdMCost = document.createElement('td');
tdMCost.className = 'ag-ledger-td ag-ledger-num';
tdMCost.textContent = formatCost(m.costUsd);
tdMCost.title = `$${Number(m.costUsd || 0).toFixed(6)}`;
tr.append(tdModel, tdMTotal, tdMIn, tdMOut, tdMCache, tdMReason, tdMCost);
mTbody.append(tr);
}
}
modelTable.append(mTbody);
modelTableWrap.append(modelTable);
}
let unsub = null;
if (ctx.backend?.subscribe) {
unsub = ctx.backend.subscribe((published) => {
if (!isDisposed && published) {
state = published;
render();
}
});
}
refreshSummary();
return {
update(nextContext) {
if (!nextContext) return;
if (nextContext.surface) {
root.className = `ag-ledger-root surface-${nextContext.surface}`;
}
if (nextContext.visible !== undefined) {
isVisible = nextContext.visible !== false;
}
root.classList.toggle('is-collapsed', isPluginCollapsed);
root.classList.toggle('hidden', !isVisible);
},
dispose() {
isDisposed = true;
if (unsub) unsub();
header.removeEventListener('click', onHeaderClick);
root.remove();
}
};
}
};
}
