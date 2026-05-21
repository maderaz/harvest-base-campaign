/* ============================================================
   WETH Autopilot dashboard - data layer + rendering.
   Pure browser JS (no build step). Pulls from Harvest's plasma
   subgraph proxy, paginates by timestamp_gt as ruby prescribed,
   reconstructs per-day holder balances from deposit/withdraw
   events, and feeds two Chart.js instances.
   ============================================================ */
(function () {
  'use strict';

  // ─── Config ──────────────────────────────────────────────
  const VAULT = '0x7872893e528fe2c0829e405960db5b742112aa97';
  const CHAIN_ID = 8453;
  const ENDPOINT = 'https://clownfish-app-2dsdk.ondigitalocean.app/' + CHAIN_ID;
  const PAGE_SIZE = 1000;
  const HOLDERS_PER_PAGE = 50;
  const EXPLORER = 'https://basescan.org/address/' + VAULT;

  // ─── State ───────────────────────────────────────────────
  const state = {
    vault: null,
    history: [],
    historyDaily: [],
    txs: [],
    currentBalances: new Map(),
    firstSeen: new Map(),
    dailySnapshots: new Map(),
    dailyHolderCounts: [],
    totalShares: 0n,
    holdersPage: 0,
    tvlChart: null,
    holdersChart: null,
    currentPeriod: 'ALL',
    shareDecimals: 18,
    underlyingSymbol: 'WETH',
  };

  // ─── Tiny DOM helper ─────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  // ─── Formatters ──────────────────────────────────────────
  function fmtUsd(n) {
    const num = Number(n);
    if (n == null || !isFinite(num)) return '-';
    const abs = Math.abs(num);
    if (abs >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'K';
    return '$' + num.toFixed(2);
  }
  function fmtPct(n) {
    const num = Number(n);
    if (n == null || !isFinite(num)) return '-';
    return num.toFixed(2) + '%';
  }
  function fmtAddr(a) {
    if (!a) return '-';
    return a.slice(0, 6) + '...' + a.slice(-4);
  }
  function fmtNumber(n) {
    if (n == null) return '-';
    return Number(n).toLocaleString();
  }
  function fmtShares(big, decimals) {
    const d = decimals == null ? 18 : decimals;
    const n = Number(big) / Math.pow(10, d);
    if (!isFinite(n)) return '-';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    if (n >= 1) return n.toFixed(4);
    if (n > 0) return n.toFixed(6);
    return '0';
  }
  function fmtDate(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }
  function dayKey(timestampSec) {
    return new Date(timestampSec * 1000).toISOString().slice(0, 10);
  }
  function addDay(dayString) {
    const d = new Date(dayString + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  // ─── GraphQL ─────────────────────────────────────────────
  async function gql(query, variables) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from /' + CHAIN_ID);
    const json = await r.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
    return json.data;
  }

  // ─── Data loaders ────────────────────────────────────────

  async function loadVaultMeta() {
    // Try the friendly field set first. If the schema rejects any
    // field, fall back to a minimal query - the history records
    // already carry tvl/apy/sharePrice that we can use as a backup.
    const fullQuery = '{ plasmaVaults(where: { id: "' + VAULT + '" }) { id tvl sharePrice apy underlyingTokenSymbol underlyingTokenDecimals totalSupply } }';
    try {
      const d = await gql(fullQuery);
      return (d.plasmaVaults && d.plasmaVaults[0]) || null;
    } catch (e) {
      try {
        const d = await gql('{ plasmaVaults(where: { id: "' + VAULT + '" }) { id tvl } }');
        return (d.plasmaVaults && d.plasmaVaults[0]) || null;
      } catch (e2) {
        return null;
      }
    }
  }

  async function loadHistory() {
    const out = [];
    let lastTs = 0;
    while (true) {
      const q = '{ plasmaVaultHistories(where: { plasmaVault_: { id: "' + VAULT + '" }, timestamp_gt: "' + lastTs + '" } orderBy: timestamp orderDirection: asc first: ' + PAGE_SIZE + ') { timestamp tvl sharePrice apy } }';
      const d = await gql(q);
      const page = d.plasmaVaultHistories || [];
      out.push.apply(out, page);
      if (page.length < PAGE_SIZE) break;
      lastTs = page[page.length - 1].timestamp;
    }
    return out;
  }

  // The brief never named the user-address field on UserTransaction.
  // Introspect once to find it, so we don't have to guess.
  async function discoverUserField() {
    try {
      const q = '{ __type(name: "UserTransaction") { fields { name type { kind name ofType { kind name } } } } }';
      const d = await gql(q);
      if (!d.__type || !d.__type.fields) return 'user { id }';
      const names = d.__type.fields.map((f) => f.name);
      for (const f of d.__type.fields) {
        const tname = (f.type && f.type.name) || (f.type && f.type.ofType && f.type.ofType.name);
        if (tname === 'User' && (f.name === 'user' || f.name === 'sender' || f.name === 'owner' || f.name === 'from')) {
          return f.name + ' { id }';
        }
      }
      if (names.indexOf('user') !== -1) return 'user { id }';
      if (names.indexOf('sender') !== -1) return 'sender { id }';
      if (names.indexOf('from') !== -1) return 'from';
      if (names.indexOf('userAddress') !== -1) return 'userAddress';
      return 'user { id }';
    } catch (e) {
      return 'user { id }';
    }
  }

  async function loadTransactions(userField) {
    const out = [];
    let lastTs = 0;
    while (true) {
      const q = '{ userTransactions(where: { plasmaVault_: { id: "' + VAULT + '" }, timestamp_gt: "' + lastTs + '" } orderBy: timestamp orderDirection: asc first: ' + PAGE_SIZE + ') { timestamp value transactionType ' + userField + ' } }';
      const d = await gql(q);
      const page = d.userTransactions || [];
      out.push.apply(out, page);
      if (page.length < PAGE_SIZE) break;
      lastTs = page[page.length - 1].timestamp;
    }
    return out;
  }

  // ─── Holder reconstruction ───────────────────────────────

  function getUserAddr(tx) {
    if (tx.user && tx.user.id) return tx.user.id.toLowerCase();
    if (tx.sender && tx.sender.id) return tx.sender.id.toLowerCase();
    if (tx.owner && tx.owner.id) return tx.owner.id.toLowerCase();
    if (tx.from) return (typeof tx.from === 'object' ? tx.from.id : tx.from).toLowerCase();
    if (tx.userAddress) return tx.userAddress.toLowerCase();
    return null;
  }

  function isDeposit(tx) {
    const t = String(tx.transactionType || '').toLowerCase();
    if (t === 'deposit' || t === 'mint') return true;
    if (t === 'withdraw' || t === 'withdrawal' || t === 'redeem' || t === 'burn') return false;
    // Numeric encoding fallback: 0 = deposit, 1 = withdraw (subgraph convention varies)
    if (t === '0') return true;
    if (t === '1') return false;
    // Default - assume positive value is a deposit
    return true;
  }

  function reconstructBalances(txs) {
    const sorted = txs.slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const balances = new Map();
    const firstSeen = new Map();
    const dailySnapshots = new Map();
    let curDay = null;

    function snapshotDay(day) {
      const snap = new Map();
      balances.forEach((b, a) => { if (b > 0n) snap.set(a, b); });
      dailySnapshots.set(day, snap);
    }

    for (const tx of sorted) {
      const addr = getUserAddr(tx);
      if (!addr) continue;
      let value;
      try { value = BigInt(tx.value || '0'); } catch (e) { value = 0n; }
      const sign = isDeposit(tx) ? 1n : -1n;
      const prev = balances.get(addr) || 0n;
      balances.set(addr, prev + sign * value);
      if (!firstSeen.has(addr)) firstSeen.set(addr, Number(tx.timestamp));

      const day = dayKey(Number(tx.timestamp));
      // Snapshot only at day boundaries - the "end of previous day"
      // snapshot is whatever balances are when we cross into a new
      // day. Last write per day wins.
      if (curDay !== null && day !== curDay) snapshotDay(curDay);
      curDay = day;
    }
    if (curDay !== null) snapshotDay(curDay);

    return { balances, firstSeen, dailySnapshots };
  }

  function computeDailyHolderCounts(dailySnapshots, history) {
    if (history.length === 0) return [];
    const start = dayKey(Number(history[0].timestamp));
    const end = todayKey();
    if (start > end) return [];

    const sortedKeys = [...dailySnapshots.keys()].sort();
    const out = [];
    let lastCount = 0;
    let kIdx = 0;
    let cur = start;
    while (cur <= end) {
      while (kIdx < sortedKeys.length && sortedKeys[kIdx] <= cur) {
        lastCount = dailySnapshots.get(sortedKeys[kIdx]).size;
        kIdx++;
      }
      out.push({ date: cur, count: lastCount });
      cur = addDay(cur);
    }
    return out;
  }

  function getSnapshotForDate(dateKey) {
    if (state.dailySnapshots.has(dateKey)) {
      return state.dailySnapshots.get(dateKey);
    }
    const sortedKeys = [...state.dailySnapshots.keys()].sort();
    let result = null;
    for (const k of sortedKeys) {
      if (k <= dateKey) result = state.dailySnapshots.get(k);
      else break;
    }
    return result;
  }

  function bucketHistoryByDay(history) {
    const byDay = new Map();
    for (const h of history) {
      byDay.set(dayKey(Number(h.timestamp)), h);
    }
    return [...byDay.entries()]
      .map(([date, h]) => ({
        date,
        timestamp: Number(h.timestamp),
        tvl: Number(h.tvl),
        apy: Number(h.apy),
        sharePrice: Number(h.sharePrice),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  function sumPositive(balances) {
    let t = 0n;
    balances.forEach((b) => { if (b > 0n) t += b; });
    return t;
  }

  // ─── Rendering: stats ────────────────────────────────────

  function renderStats(vault, historyDaily, holderCount) {
    const latest = historyDaily.length > 0 ? historyDaily[historyDaily.length - 1] : null;
    const tvl = (vault && vault.tvl != null) ? vault.tvl : (latest ? latest.tvl : null);
    const apy = (vault && vault.apy != null) ? vault.apy : (latest ? latest.apy : null);
    const sharePrice = (vault && vault.sharePrice != null) ? vault.sharePrice : (latest ? latest.sharePrice : null);

    $('stat-tvl').textContent = tvl != null ? fmtUsd(tvl) : '-';
    $('stat-apy').textContent = apy != null ? fmtPct(apy) : '-';
    $('stat-holders').textContent = fmtNumber(holderCount);
    $('stat-share').textContent = sharePrice != null ? Number(sharePrice).toFixed(4) : '-';
  }

  // ─── Rendering: charts ───────────────────────────────────

  function getChartTheme() {
    const css = getComputedStyle(document.documentElement);
    return {
      gold: (css.getPropertyValue('--gold') || '#ffb936').trim(),
      ink: (css.getPropertyValue('--ink') || '#191717').trim(),
      ink2: (css.getPropertyValue('--ink-2') || '#32312b').trim(),
      ink3: (css.getPropertyValue('--ink-3') || '#6e6c66').trim(),
      line2: (css.getPropertyValue('--line-2') || '#ebebe7').trim(),
      bg: (css.getPropertyValue('--bg') || '#ffffff').trim(),
      card: (css.getPropertyValue('--card-2') || '#ffffff').trim(),
    };
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16);
    const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16);
    const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function getPeriodSlice(daily, period) {
    if (period === 'ALL') return daily;
    const days = { '7D': 7, '30D': 30, '90D': 90 }[period] || daily.length;
    return daily.slice(-days);
  }

  function renderTvlApyChart(daily, period) {
    if (typeof Chart === 'undefined') { console.warn('Chart.js not loaded'); return; }
    const theme = getChartTheme();
    const slice = getPeriodSlice(daily, period);
    if (state.tvlChart) state.tvlChart.destroy();

    const ctx = $('tvl-apy-chart').getContext('2d');
    state.tvlChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: slice.map((d) => d.date),
        datasets: [
          {
            label: 'TVL',
            data: slice.map((d) => d.tvl),
            borderColor: theme.gold,
            backgroundColor: hexToRgba(theme.gold, 0.12),
            yAxisID: 'y',
            borderWidth: 2,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: true,
          },
          {
            label: 'APY',
            data: slice.map((d) => d.apy),
            borderColor: theme.ink3,
            backgroundColor: 'transparent',
            yAxisID: 'y1',
            borderWidth: 1.5,
            borderDash: [4, 3],
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { color: theme.line2, drawBorder: false },
            ticks: {
              color: theme.ink3,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              autoSkip: true,
              maxTicksLimit: 8,
              maxRotation: 0,
            },
            border: { color: theme.line2 },
          },
          y: {
            position: 'left',
            grid: { color: theme.line2, drawBorder: false },
            border: { color: theme.line2 },
            ticks: {
              color: theme.ink3,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              callback: (v) => fmtUsd(v),
            },
            title: { display: true, text: 'TVL (USD)', color: theme.ink2, font: { family: "'Inter', sans-serif", size: 12, weight: '500' } },
          },
          y1: {
            position: 'right',
            grid: { display: false },
            border: { color: theme.line2 },
            ticks: {
              color: theme.ink3,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              callback: (v) => Number(v).toFixed(1) + '%',
            },
            title: { display: true, text: 'APY (%)', color: theme.ink2, font: { family: "'Inter', sans-serif", size: 12, weight: '500' } },
          },
        },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: {
              color: theme.ink2,
              usePointStyle: true,
              pointStyle: 'rectRounded',
              boxWidth: 10,
              boxHeight: 10,
              font: { family: "'Inter', sans-serif", size: 12, weight: '500' },
            },
          },
          tooltip: {
            backgroundColor: theme.ink,
            titleColor: theme.bg,
            bodyColor: theme.bg,
            padding: 10,
            cornerRadius: 8,
            displayColors: true,
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            callbacks: {
              label: (c) => c.dataset.yAxisID === 'y'
                ? ' TVL: ' + fmtUsd(c.parsed.y)
                : ' APY: ' + Number(c.parsed.y).toFixed(2) + '%',
            },
          },
        },
      },
    });
  }

  function renderHoldersChart(dailyHolders) {
    if (typeof Chart === 'undefined') { console.warn('Chart.js not loaded'); return; }
    const theme = getChartTheme();
    if (state.holdersChart) state.holdersChart.destroy();

    const ctx = $('holders-chart').getContext('2d');
    state.holdersChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dailyHolders.map((d) => d.date),
        datasets: [{
          label: 'Holders',
          data: dailyHolders.map((d) => d.count),
          borderColor: theme.gold,
          backgroundColor: hexToRgba(theme.gold, 0.12),
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { color: theme.line2, drawBorder: false },
            border: { color: theme.line2 },
            ticks: {
              color: theme.ink3,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              autoSkip: true,
              maxTicksLimit: 8,
              maxRotation: 0,
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: theme.line2, drawBorder: false },
            border: { color: theme.line2 },
            ticks: {
              color: theme.ink3,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              precision: 0,
              callback: (v) => fmtNumber(v),
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: theme.ink,
            titleColor: theme.bg,
            bodyColor: theme.bg,
            padding: 10,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              label: (c) => ' ' + fmtNumber(c.parsed.y) + ' holders',
            },
          },
        },
      },
    });
  }

  // ─── Rendering: holders list / snapshot ──────────────────

  function renderHoldersList() {
    const balances = state.currentBalances;
    const holders = [];
    balances.forEach((b, a) => { if (b > 0n) holders.push([a, b]); });
    holders.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

    const total = state.totalShares;
    $('holders-count').textContent = fmtNumber(holders.length) + ' holders';

    const totalPages = Math.max(1, Math.ceil(holders.length / HOLDERS_PER_PAGE));
    if (state.holdersPage >= totalPages) state.holdersPage = totalPages - 1;
    if (state.holdersPage < 0) state.holdersPage = 0;
    const start = state.holdersPage * HOLDERS_PER_PAGE;
    const slice = holders.slice(start, start + HOLDERS_PER_PAGE);

    if (slice.length === 0) {
      $('holders-rows').innerHTML = '<div class="hub-empty">No holders yet.</div>';
    } else {
      const rows = slice.map((row, i) => {
        const addr = row[0];
        const shares = row[1];
        const rank = start + i + 1;
        const pct = total > 0n ? (Number((shares * 10000n) / total) / 100).toFixed(2) : '0.00';
        const fs = state.firstSeen.get(addr);
        return ''
          + '<a class="hub-row holders-grid" href="https://basescan.org/address/' + addr + '" target="_blank" rel="noreferrer" role="row">'
          + '<span class="hub-cell hub-rank">' + rank + '</span>'
          + '<span class="hub-cell holder-addr" title="' + addr + '">' + fmtAddr(addr) + '</span>'
          + '<span class="hub-cell hub-num">' + fmtShares(shares, state.shareDecimals) + '</span>'
          + '<span class="hub-cell hub-num">' + pct + '%</span>'
          + '<span class="hub-cell hub-num">' + fmtDate(fs) + '</span>'
          + '</a>';
      }).join('');
      $('holders-rows').innerHTML = rows;
    }

    const pager = $('holders-pagination');
    if (holders.length > HOLDERS_PER_PAGE) {
      pager.hidden = false;
      $('holders-info').textContent = 'Page ' + (state.holdersPage + 1) + ' of ' + totalPages;
      $('holders-prev').disabled = state.holdersPage === 0;
      $('holders-next').disabled = state.holdersPage >= totalPages - 1;
    } else {
      pager.hidden = true;
    }
  }

  function renderSnapshot(dateKey) {
    const snap = getSnapshotForDate(dateKey);
    if (!snap || snap.size === 0) {
      $('snapshot-rows').innerHTML = '<div class="hub-empty">No holders on this date.</div>';
      $('snapshot-summary').textContent = '0 holders';
      return;
    }

    const holders = [];
    snap.forEach((b, a) => { holders.push([a, b]); });
    holders.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

    let total = 0n;
    for (let i = 0; i < holders.length; i++) total += holders[i][1];

    $('snapshot-summary').textContent = fmtNumber(holders.length) + ' holders, ' + fmtShares(total, state.shareDecimals) + ' shares';

    const rows = holders.map((row, i) => {
      const addr = row[0];
      const shares = row[1];
      const pct = total > 0n ? (Number((shares * 10000n) / total) / 100).toFixed(2) : '0.00';
      return ''
        + '<a class="hub-row holders-snapshot-grid" href="https://basescan.org/address/' + addr + '" target="_blank" rel="noreferrer" role="row">'
        + '<span class="hub-cell hub-rank">' + (i + 1) + '</span>'
        + '<span class="hub-cell holder-addr" title="' + addr + '">' + fmtAddr(addr) + '</span>'
        + '<span class="hub-cell hub-num">' + fmtShares(shares, state.shareDecimals) + '</span>'
        + '<span class="hub-cell hub-num">' + pct + '%</span>'
        + '</a>';
    }).join('');
    $('snapshot-rows').innerHTML = rows;
  }

  // ─── Theme toggle ────────────────────────────────────────

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) {}
    updateThemeToggle();
    if (state.tvlChart) renderTvlApyChart(state.historyDaily, state.currentPeriod);
    if (state.holdersChart) renderHoldersChart(state.dailyHolderCounts);
  }

  function updateThemeToggle() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const btn = $('theme-toggle');
    if (btn) btn.textContent = cur === 'dark' ? 'Light' : 'Dark';
  }

  // ─── Event wiring ────────────────────────────────────────

  function setupEvents() {
    $('theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    $('period-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('.period-btn');
      if (!btn) return;
      const p = btn.getAttribute('data-period');
      state.currentPeriod = p;
      const all = document.querySelectorAll('.period-btn');
      for (let i = 0; i < all.length; i++) {
        all[i].classList.toggle('is-active', all[i] === btn);
      }
      renderTvlApyChart(state.historyDaily, p);
    });

    $('holders-prev').addEventListener('click', () => {
      state.holdersPage = Math.max(0, state.holdersPage - 1);
      renderHoldersList();
    });
    $('holders-next').addEventListener('click', () => {
      state.holdersPage = state.holdersPage + 1;
      renderHoldersList();
    });

    $('snapshot-date').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v) renderSnapshot(v);
    });
  }

  // ─── Init ────────────────────────────────────────────────

  function setLoadingState() {
    $('stat-tvl').textContent = '...';
    $('stat-apy').textContent = '...';
    $('stat-holders').textContent = '...';
    $('stat-share').textContent = '...';
  }

  function setErrorState(msg) {
    $('stat-tvl').textContent = 'Error';
    $('stat-apy').textContent = '-';
    $('stat-holders').textContent = '-';
    $('stat-share').textContent = '-';
    $('holders-rows').innerHTML = '<div class="hub-empty">Failed to load: ' + msg + '</div>';
    $('snapshot-rows').innerHTML = '<div class="hub-empty">Failed to load: ' + msg + '</div>';
  }

  async function init() {
    updateThemeToggle();
    setupEvents();
    $('vault-link').textContent = fmtAddr(VAULT);
    $('vault-link').href = EXPLORER;
    setLoadingState();

    try {
      const userField = await discoverUserField();
      const results = await Promise.all([
        loadVaultMeta().catch((e) => { console.warn('vault meta error', e); return null; }),
        loadHistory(),
        loadTransactions(userField),
      ]);
      const vault = results[0];
      const history = results[1];
      const txs = results[2];

      state.vault = vault;
      state.history = history;
      state.historyDaily = bucketHistoryByDay(history);
      state.txs = txs;

      if (vault) {
        if (vault.underlyingTokenDecimals != null) {
          state.shareDecimals = Number(vault.underlyingTokenDecimals);
        }
        if (vault.underlyingTokenSymbol) {
          state.underlyingSymbol = vault.underlyingTokenSymbol;
        }
      }

      const recon = reconstructBalances(txs);
      state.currentBalances = recon.balances;
      state.firstSeen = recon.firstSeen;
      state.dailySnapshots = recon.dailySnapshots;
      state.totalShares = sumPositive(recon.balances);
      state.dailyHolderCounts = computeDailyHolderCounts(state.dailySnapshots, history);

      let holderCount = 0;
      recon.balances.forEach((b) => { if (b > 0n) holderCount++; });

      renderStats(vault, state.historyDaily, holderCount);
      renderTvlApyChart(state.historyDaily, state.currentPeriod);
      renderHoldersChart(state.dailyHolderCounts);
      renderHoldersList();

      const dateInput = $('snapshot-date');
      const today = todayKey();
      const minDate = history.length > 0 ? dayKey(Number(history[0].timestamp)) : today;
      dateInput.min = minDate;
      dateInput.max = today;
      dateInput.value = today;
      renderSnapshot(today);
    } catch (e) {
      console.error('Dashboard load error:', e);
      setErrorState(e && e.message ? e.message : 'unknown error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
