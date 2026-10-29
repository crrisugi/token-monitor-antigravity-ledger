// Antigravity Account Ledger Plugin UI

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

      // Persistence: plugin collapse state (default: false = expanded)
      let isPluginCollapsed = false;
      try {
        const saved = localStorage.getItem('ag_ledger_plugin_collapsed');
        if (saved !== null) {
          isPluginCollapsed = saved === 'true';
        }
      } catch {
        // ignore
      }

      // Persistence: account section expand state (default: false = collapsed)
      let isAccountSectionExpanded = false;
      try {
        const saved = localStorage.getItem('ag_ledger_accounts_expanded');
        if (saved !== null) {
          isAccountSectionExpanded = saved === 'true';
        }
      } catch {
        // ignore
      }

      const root = document.createElement('div');
      root.className = `ag-ledger-root surface-${context.surface || 'page'}`;
      container.append(root);

      // --- Header Controls ---
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

      const hostModule = container.closest('.home-module');
      const hostHead = hostModule?.querySelector('.home-module-head');
      const hostHeadEnd = hostModule?.querySelector('.home-module-head-end');
      const hostMeta = hostHeadEnd?.querySelector('.home-module-meta');

      function onHeaderClick(e) {
        if (e.target.closest('.ag-ledger-collapse-btn')) return;
        togglePluginCollapse();
      }

      if (hostHeadEnd) {
        if (hostMeta) {
          hostMeta.style.display = 'none';
        }
        const stale = hostHeadEnd.querySelector('.ag-ledger-header-right');
        if (stale) {
          stale.remove();
        }
        hostHeadEnd.append(headerRight);
        hostHead?.addEventListener('click', onHeaderClick);
      } else if (context?.headerActions) {
        context.headerActions.replaceChildren(headerRight);
      } else {
        const standaloneHeader = document.createElement('header');
        standaloneHeader.className = 'ag-ledger-header';
        standaloneHeader.append(headerRight);
        standaloneHeader.addEventListener('click', onHeaderClick);
        root.append(standaloneHeader);
      }

      // --- Body Container ---
      const body = document.createElement('div');
      body.className = 'ag-ledger-body';
      root.append(body);

      // --- Filter Bar ---
      const filterBar = document.createElement('div');
      filterBar.className = 'ag-ledger-bar';

      // Date Range Group
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

      // Account Selector Group
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

      // --- Status Banner ---
      const statusBanner = document.createElement('div');
      statusBanner.className = 'ag-ledger-status-banner';
      body.append(statusBanner);

      // --- KPI Banner ---
      const kpiGrid = document.createElement('div');
      kpiGrid.className = 'ag-ledger-kpi-grid';
      body.append(kpiGrid);

      // --- Model Breakdown Section ---
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

      // --- Per-Account Table Section ---
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
          // ignore
        }
        updateAccountSectionCollapse();
      });

      updateAccountSectionCollapse();

      // Plugin collapse handling
      function updatePluginCollapse() {
        collapseBtn.setAttribute('aria-expanded', String(!isPluginCollapsed));
        collapseBtn.textContent = isPluginCollapsed ? '展开 ▾' : '收起 ▴';
        root.classList.toggle('is-collapsed', isPluginCollapsed);
        body.classList.toggle('hidden', isPluginCollapsed);
        if (hostModule) {
          hostModule.classList.toggle('ag-ledger-module-collapsed', isPluginCollapsed);
        }
        activeBadge.classList.toggle('hidden', isPluginCollapsed);
        compactSummary.classList.toggle('hidden', !isPluginCollapsed);
      }

      function togglePluginCollapse() {
        isPluginCollapsed = !isPluginCollapsed;
        try {
          localStorage.setItem('ag_ledger_plugin_collapsed', String(isPluginCollapsed));
        } catch {
          // ignore
        }
        updatePluginCollapse();
      }

      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePluginCollapse();
      });

      updatePluginCollapse();

      // Event handlers
      async function refreshSummary() {
        if (isLoading || isDisposed) return;
        isLoading = true;
        try {
          const res = await ctx.backend.call('getSummary', {
            range: { start: startDate, end: endDate },
            accountFilter
          });
          if (!isDisposed && res) {
            state = res;
            render();
          }
        } catch (err) {
          console.error('[ag-ledger] getSummary error:', err);
        } finally {
          isLoading = false;
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

      // Render function
      function render() {
        if (!state) return;
        const { summary, discoveredAccounts, activeAccount } = state;

        // 1. Update Active Badge
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

        // 2. Update Account Selector Options
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

        for (const acc of discoveredAccounts || []) {
          const opt = document.createElement('option');
          opt.value = acc.email;
          opt.textContent = acc.displayName && acc.displayName !== acc.email
            ? `${acc.email} (${acc.displayName})`
            : acc.email;
          accountSelect.append(opt);
        }

        accountSelect.value = currentSelected || accountFilter;

        // 3. Update Status Banner & Compact Summary
        const isSpecificAccount = accountFilter && accountFilter !== 'all' && accountFilter !== 'unattributed';
        const totalTokens = summary?.totalTokens || 0;
        const costUsd = summary?.costUsd || 0;
        const inputTokens = summary?.inputTokens || 0;
        const outputTokens = summary?.outputTokens || 0;
        const cacheReadTokens = summary?.cacheReadTokens || 0;
        const reasoningTokens = summary?.reasoningTokens || 0;

        compactSummary.textContent = `${formatTokens(totalTokens)} · ${formatCost(costUsd)}`;
        compactSummary.classList.toggle('hidden', !isPluginCollapsed);

        if (accountFilter === 'all') {
          statusBanner.textContent = '已开启全自动账号归属：今日及后续活跃会话自动归入当前在线 Google 账号；过往存量历史数据作为只读「历史汇总（未归属）」展示。';
        } else if (accountFilter === 'unattributed') {
          statusBanner.textContent = '当前正在查看：历史汇总（未归属） — 仅包含功能启用前未关联具体账号的只读存量历史数据。';
        } else if (isSpecificAccount) {
          if (totalTokens === 0) {
            statusBanner.textContent = '该账号暂无自动归属的活跃会话记录（切换至该账号使用 Antigravity 后将自动累计用量）。';
          } else {
            const accShare = summary?.accounts?.find(a => a.email === accountFilter)?.percentageOfTotal || 0;
            statusBanner.textContent = `当前账号自动归属用量：${formatTokens(totalTokens)} Tokens · 折算费用 ${formatCost(costUsd)}（在当前区间占比 ${accShare}%）。`;
          }
        }

        // 4. Update KPI Banner
        kpiGrid.replaceChildren();

        // Card 1: Total Tokens
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

        // Card 2: USD Cost
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

        // Card 3: Token Breakdown
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

        // 5. Update Per-Account Breakdown Table
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

          // Account Name
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

          // Status column
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

          // Total Tokens
          const tdTokens = document.createElement('td');
          tdTokens.className = 'ag-ledger-td ag-ledger-num';
          tdTokens.textContent = formatTokens(acc.totalTokens);
          tdTokens.title = acc.totalTokens.toLocaleString();

          // Cost USD
          const tdCost = document.createElement('td');
          tdCost.className = 'ag-ledger-td ag-ledger-num';
          tdCost.textContent = formatCost(acc.costUsd);
          tdCost.title = `$${acc.costUsd.toFixed(6)}`;

          // Percentage
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

        // 6. Update Model Breakdown Table
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

      // Backend subscription
      let unsub = null;
      if (ctx.backend?.subscribe) {
        unsub = ctx.backend.subscribe((published) => {
          if (!isDisposed && published) {
            state = published;
            render();
          }
        });
      }

      // Initial fetch
      refreshSummary();

      return {
        update(nextContext) {
          if (nextContext?.surface) {
            root.className = `ag-ledger-root surface-${nextContext.surface}`;
            if (isPluginCollapsed) {
              root.classList.add('is-collapsed');
            }
          }
        },
        dispose() {
          isDisposed = true;
          if (unsub) unsub();
          if (hostHead && onHeaderClick) {
            hostHead.removeEventListener('click', onHeaderClick);
          }
          if (headerRight && headerRight.parentNode) {
            headerRight.remove();
          }
          if (hostMeta) {
            hostMeta.style.display = '';
          }
          if (hostModule) {
            hostModule.classList.remove('ag-ledger-module-collapsed');
          }
          root.remove();
        }
      };
    }
  };
}
