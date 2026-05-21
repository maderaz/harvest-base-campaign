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
  const HOLDERS_PER_PAGE = 20;
  const EXPLORER = 'https://basescan.org/address/' + VAULT;
  // Annotation drawn as a solid blue vertical line on both charts.
  // Treat this as a placeholder until a real start date is provided.
  const BASE_INCENTIVES_START = '2026-04-15';
  const BASE_BLUE = '#0052ff';

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
    snapshotPage: 0,
    tvlChart: null,
    holdersChart: null,
    currentPeriod: 'ALL',
    chartType: 'bar',
    shareDecimals: 18,
    underlyingSymbol: 'WETH',
    usdPerShareNow: 0,
    currentTvl: 0,
    lastUpdated: 0,
    cacheStatusTimer: null,
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
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
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
  function fmtFullDate(dateKey) {
    // dateKey is YYYY-MM-DD. Return "April 15, 2026".
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return dateKey || '-';
    const d = new Date(dateKey + 'T00:00:00Z');
    if (isNaN(d.getTime())) return dateKey;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  function formatRelativeTime(ts) {
    if (!ts) return '';
    const ms = Date.now() - ts;
    if (ms < 0) return 'just now';
    const sec = Math.floor(ms / 1000);
    if (sec < 10) return 'just now';
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + 'd ago';
    return Math.floor(day / 30) + 'mo ago';
  }

  // ─── Local cache (localStorage) ──────────────────────────
  // Cache the raw history + tx records so a returning visitor sees
  // the dashboard immediately. Background fetch pulls only records
  // newer than the cached max-timestamp (delta sync), then merges
  // and writes back. Bump CACHE_VERSION to invalidate everything if
  // the cached shape ever changes.
  const CACHE_VERSION = 1;
  const CACHE_KEYS = {
    schema: 'harvest:v',
    meta: 'harvest:meta:' + VAULT,
    history: 'harvest:history:' + VAULT,
    txs: 'harvest:txs:' + VAULT,
    userField: 'harvest:userField:' + VAULT,
    updated: 'harvest:updated:' + VAULT,
  };

  function clearCache() {
    try {
      Object.keys(CACHE_KEYS).forEach((k) => localStorage.removeItem(CACHE_KEYS[k]));
    } catch (e) {}
  }

  function readCache() {
    try {
      const v = localStorage.getItem(CACHE_KEYS.schema);
      if (v !== String(CACHE_VERSION)) { clearCache(); return null; }
      const history = JSON.parse(localStorage.getItem(CACHE_KEYS.history) || '[]');
      const txs = JSON.parse(localStorage.getItem(CACHE_KEYS.txs) || '[]');
      const meta = JSON.parse(localStorage.getItem(CACHE_KEYS.meta) || 'null');
      const userField = localStorage.getItem(CACHE_KEYS.userField) || null;
      const updated = Number(localStorage.getItem(CACHE_KEYS.updated) || 0);
      return { history, txs, meta, userField, updated };
    } catch (e) {
      console.warn('Cache read failed:', e);
      return null;
    }
  }

  function writeCache(parts) {
    try {
      localStorage.setItem(CACHE_KEYS.schema, String(CACHE_VERSION));
      if (parts.meta !== undefined) localStorage.setItem(CACHE_KEYS.meta, JSON.stringify(parts.meta));
      if (parts.history) localStorage.setItem(CACHE_KEYS.history, JSON.stringify(parts.history));
      if (parts.txs) localStorage.setItem(CACHE_KEYS.txs, JSON.stringify(parts.txs));
      if (parts.userField) localStorage.setItem(CACHE_KEYS.userField, parts.userField);
      localStorage.setItem(CACHE_KEYS.updated, String(Date.now()));
    } catch (e) {
      // QuotaExceededError or private-mode storage block. Not fatal.
      console.warn('Cache write failed:', e);
    }
  }

  function maxTimestamp(arr) {
    let m = 0;
    for (let i = 0; i < arr.length; i++) {
      const t = Number(arr[i].timestamp);
      if (t > m) m = t;
    }
    return m;
  }

  function setCacheStatus(text, kind) {
    const el = $('cache-status');
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    const variant =
      kind === 'warn' ? 'is-warn' :
      kind === 'gold' ? 'is-gold' :
      kind === 'ok' ? 'is-ok' : 'is-muted';
    el.className = 'cache-status pill-tinted ' + variant;
  }

  // Re-render the "Updated Xm ago" badge from state.lastUpdated.
  // Called on a timer so the text stays accurate as time passes.
  function refreshCacheStatusTick() {
    if (!state.lastUpdated) return;
    setCacheStatus('Updated ' + formatRelativeTime(state.lastUpdated), 'ok');
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

  async function loadHistory(sinceTs) {
    const out = [];
    let lastTs = Number(sinceTs) || 0;
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

  async function loadTransactions(userField, sinceTs) {
    const out = [];
    let lastTs = Number(sinceTs) || 0;
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

  function bigToShares(big, decimals) {
    const d = decimals == null ? 18 : decimals;
    return Number(big) / Math.pow(10, d);
  }

  // Some endpoints return sharePrice pre-decimaled (e.g. 1.0219) and
  // others return it as a raw 18-decimal BigInt-string. Anything in
  // the high billions is almost certainly the raw form; normalize it
  // so the stat tile stays a clean 4-decimal number.
  function normalizeSharePrice(raw, decimals) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!isFinite(n)) return null;
    if (Math.abs(n) > 1e10) return n / Math.pow(10, decimals || 18);
    return n;
  }

  // Find the most recent historyDaily entry on-or-before the given day.
  function findHistoryForDate(dateKey) {
    const arr = state.historyDaily;
    let result = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].date <= dateKey) result = arr[i];
      else break;
    }
    return result;
  }

  // USD value of a single share unit (already accounting for token decimals).
  // Returns 0 when we can't derive it (no TVL, no shares).
  function usdPerShareForDate(dateKey) {
    const snap = getSnapshotForDate(dateKey);
    if (!snap || snap.size === 0) return 0;
    const h = findHistoryForDate(dateKey);
    if (!h || !isFinite(h.tvl)) return 0;
    let total = 0n;
    snap.forEach((b) => { total += b; });
    const totalNum = bigToShares(total, state.shareDecimals);
    if (totalNum <= 0) return 0;
    return h.tvl / totalNum;
  }

  // ─── Rendering: stats ────────────────────────────────────

  function renderStats(vault, historyDaily, holderCount) {
    const latest = historyDaily.length > 0 ? historyDaily[historyDaily.length - 1] : null;
    const tvl = (vault && vault.tvl != null) ? vault.tvl : (latest ? latest.tvl : null);
    const apy = (vault && vault.apy != null) ? vault.apy : (latest ? latest.apy : null);
    const rawSharePrice = (vault && vault.sharePrice != null) ? vault.sharePrice : (latest ? latest.sharePrice : null);
    const sharePrice = normalizeSharePrice(rawSharePrice, state.shareDecimals);

    $('stat-tvl').textContent = tvl != null ? fmtUsd(tvl) : '-';
    $('stat-apy').textContent = apy != null ? fmtPct(apy) : '-';
    $('stat-holders').textContent = fmtNumber(holderCount);
    $('stat-share').textContent = sharePrice != null ? sharePrice.toFixed(4) : '-';
  }

  // ─── Rendering: charts ───────────────────────────────────

  function getChartTheme() {
    const css = getComputedStyle(document.documentElement);
    return {
      gold: (css.getPropertyValue('--gold') || '#ffb936').trim(),
      apy: (css.getPropertyValue('--apy') || '#7c5cff').trim(),
      ink: (css.getPropertyValue('--ink') || '#191717').trim(),
      ink2: (css.getPropertyValue('--ink-2') || '#32312b').trim(),
      ink3: (css.getPropertyValue('--ink-3') || '#6e6c66').trim(),
      line2: (css.getPropertyValue('--line-2') || '#ebebe7').trim(),
      bg: (css.getPropertyValue('--bg') || '#ffffff').trim(),
      card: (css.getPropertyValue('--card-2') || '#ffffff').trim(),
    };
  }

  // ─── CSV download ────────────────────────────────────────
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // ─── Chart annotation: vertical line + label ─────────────
  // Draw a solid colored vertical line at the data point matching
  // `date` (YYYY-MM-DD) on a Chart.js category x-axis. Registered
  // once globally; per-chart config sits at options.plugins.vline.
  let _vlineRegistered = false;
  function ensureVerticalLinePlugin() {
    if (_vlineRegistered || typeof Chart === 'undefined') return;
    Chart.register({
      id: 'vline',
      afterDatasetsDraw(chart) {
        const opts = chart.options.plugins && chart.options.plugins.vline;
        if (!opts || !opts.date) return;
        const labels = chart.data.labels || [];
        const idx = labels.indexOf(opts.date);
        if (idx === -1) return;
        const xScale = chart.scales.x;
        if (!xScale) return;
        const x = xScale.getPixelForValue(idx);
        const top = chart.chartArea.top;
        const bottom = chart.chartArea.bottom;
        const color = opts.color || '#0052ff';
        const c = chart.ctx;
        c.save();
        c.strokeStyle = color;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x, bottom);
        c.stroke();
        if (opts.label) {
          const label = opts.label;
          c.font = '600 11px "Inter", sans-serif';
          c.textBaseline = 'top';
          const textWidth = c.measureText(label).width;
          // Decide which side of the line the label sits on so it
          // doesn't run off the right edge of the plot area.
          const padX = 7;
          const padY = 5;
          const labelRight = x + 8 + textWidth + padX * 2;
          const drawLeft = labelRight > chart.chartArea.right;
          const boxX = drawLeft ? (x - 8 - textWidth - padX * 2) : (x + 8);
          const boxY = top + 6;
          const boxW = textWidth + padX * 2;
          const boxH = 18 + padY;
          // Filled tag
          c.fillStyle = color;
          const r = 4;
          c.beginPath();
          c.moveTo(boxX + r, boxY);
          c.lineTo(boxX + boxW - r, boxY);
          c.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
          c.lineTo(boxX + boxW, boxY + boxH - r);
          c.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
          c.lineTo(boxX + r, boxY + boxH);
          c.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
          c.lineTo(boxX, boxY + r);
          c.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
          c.closePath();
          c.fill();
          c.fillStyle = '#ffffff';
          c.fillText(label, boxX + padX, boxY + padY + 1);
        }
        c.restore();
      },
    });
    _vlineRegistered = true;
  }

  function downloadCsv(filename, rows) {
    if (!rows || rows.length === 0) return;
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
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

  function renderTvlApyChart(daily, period, chartType) {
    if (typeof Chart === 'undefined') { console.warn('Chart.js not loaded'); return; }
    ensureVerticalLinePlugin();
    const theme = getChartTheme();
    const slice = getPeriodSlice(daily, period);
    if (state.tvlChart) state.tvlChart.destroy();
    const isBar = chartType === 'bar';

    const tvlDataset = isBar ? {
      type: 'bar',
      label: 'TVL',
      data: slice.map((d) => d.tvl),
      backgroundColor: hexToRgba(theme.gold, 0.85),
      hoverBackgroundColor: theme.gold,
      borderColor: theme.gold,
      borderWidth: 0,
      borderRadius: { topLeft: 3, topRight: 3, bottomLeft: 0, bottomRight: 0 },
      borderSkipped: false,
      barPercentage: 0.92,
      categoryPercentage: 0.96,
      yAxisID: 'y',
      order: 2,
    } : {
      type: 'line',
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
      order: 2,
    };

    const apyDataset = {
      type: 'line',
      label: 'APY',
      data: slice.map((d) => d.apy),
      borderColor: theme.apy,
      backgroundColor: 'transparent',
      yAxisID: 'y1',
      borderWidth: 2,
      borderDash: [5, 4],
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: theme.apy,
      pointHoverBorderColor: theme.apy,
      fill: false,
      order: 1,
    };

    const ctx = $('tvl-apy-chart').getContext('2d');
    state.tvlChart = new Chart(ctx, {
      type: isBar ? 'bar' : 'line',
      data: {
        labels: slice.map((d) => d.date),
        datasets: [tvlDataset, apyDataset],
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
            beginAtZero: false,
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
          legend: { display: false },
          vline: { date: BASE_INCENTIVES_START, label: 'Base Incentives Start', color: BASE_BLUE },
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

  function renderHoldersChart(dailyHolders, chartType) {
    if (typeof Chart === 'undefined') { console.warn('Chart.js not loaded'); return; }
    ensureVerticalLinePlugin();
    const theme = getChartTheme();
    if (state.holdersChart) state.holdersChart.destroy();
    const isBar = chartType === 'bar';

    const dataset = isBar ? {
      type: 'bar',
      label: 'Holders',
      data: dailyHolders.map((d) => d.count),
      backgroundColor: hexToRgba(theme.gold, 0.85),
      hoverBackgroundColor: theme.gold,
      borderColor: theme.gold,
      borderWidth: 0,
      borderRadius: { topLeft: 3, topRight: 3, bottomLeft: 0, bottomRight: 0 },
      borderSkipped: false,
      barPercentage: 0.92,
      categoryPercentage: 0.96,
    } : {
      type: 'line',
      label: 'Holders',
      data: dailyHolders.map((d) => d.count),
      borderColor: theme.gold,
      backgroundColor: hexToRgba(theme.gold, 0.12),
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: true,
    };

    const ctx = $('holders-chart').getContext('2d');
    state.holdersChart = new Chart(ctx, {
      type: isBar ? 'bar' : 'line',
      data: {
        labels: dailyHolders.map((d) => d.date),
        datasets: [dataset],
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
          vline: { date: BASE_INCENTIVES_START, label: 'Base Incentives Start', color: BASE_BLUE },
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

  // ─── Rendering: ranking summary strips ───────────────────
  // Small white-background tiles that sit above each ranking table.
  // For Current: latest balances. For Snapshot: balances at the
  // selected day's close.

  function renderCurrentStats() {
    let total = 0n;
    let max = 0n;
    let count = 0;
    state.currentBalances.forEach((b) => {
      if (b > 0n) {
        count++;
        total += b;
        if (b > max) max = b;
      }
    });
    const topPct = total > 0n ? Number((max * 10000n) / total) / 100 : 0;
    const totalUsd = state.usdPerShareNow > 0 ? bigToShares(total, state.shareDecimals) * state.usdPerShareNow : 0;

    setText('rstat-current-holders', count > 0 ? fmtNumber(count) : '-');
    setText('rstat-current-value', totalUsd > 0 ? fmtUsd(totalUsd) : '-');
    setText('rstat-current-top', count > 0 ? topPct.toFixed(2) + '%' : '-');
  }

  function renderSnapshotStats(dateKey, snapMaybe) {
    const snap = snapMaybe || getSnapshotForDate(dateKey);
    if (!snap || snap.size === 0) {
      setText('rstat-snapshot-holders', '-');
      setText('rstat-snapshot-value', '-');
      setText('rstat-snapshot-top', '-');
      return;
    }
    let total = 0n;
    let max = 0n;
    snap.forEach((b) => {
      total += b;
      if (b > max) max = b;
    });
    const topPct = total > 0n ? Number((max * 10000n) / total) / 100 : 0;
    const usdPerShare = usdPerShareForDate(dateKey);
    const totalUsd = usdPerShare > 0 ? bigToShares(total, state.shareDecimals) * usdPerShare : 0;

    setText('rstat-snapshot-holders', fmtNumber(snap.size));
    setText('rstat-snapshot-value', totalUsd > 0 ? fmtUsd(totalUsd) : '-');
    setText('rstat-snapshot-top', topPct.toFixed(2) + '%');
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
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

    const usdPerShare = state.usdPerShareNow;
    if (slice.length === 0) {
      $('holders-rows').innerHTML = '<div class="hub-empty">No holders yet.</div>';
    } else {
      const rows = slice.map((row, i) => {
        const addr = row[0];
        const shares = row[1];
        const rank = start + i + 1;
        const pct = total > 0n ? (Number((shares * 10000n) / total) / 100).toFixed(2) : '0.00';
        const fs = state.firstSeen.get(addr);
        const usd = usdPerShare > 0 ? fmtUsd(bigToShares(shares, state.shareDecimals) * usdPerShare) : '-';
        return ''
          + '<a class="hub-row holders-grid" href="https://basescan.org/address/' + addr + '" target="_blank" rel="noreferrer" role="row">'
          + '<span class="hub-cell hub-rank">' + rank + '</span>'
          + '<span class="hub-cell holder-addr" title="' + addr + '">' + fmtAddr(addr) + '</span>'
          + '<span class="hub-cell hub-num">' + usd + '</span>'
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
    const pager = $('snapshot-pagination');
    renderSnapshotStats(dateKey, snap);
    if (!snap || snap.size === 0) {
      $('snapshot-rows').innerHTML = '<div class="hub-empty">No holders on this date.</div>';
      if (pager) pager.hidden = true;
      return;
    }

    const holders = [];
    snap.forEach((b, a) => { holders.push([a, b]); });
    holders.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

    let total = 0n;
    for (let i = 0; i < holders.length; i++) total += holders[i][1];

    const usdPerShare = usdPerShareForDate(dateKey);

    const totalPages = Math.max(1, Math.ceil(holders.length / HOLDERS_PER_PAGE));
    if (state.snapshotPage >= totalPages) state.snapshotPage = totalPages - 1;
    if (state.snapshotPage < 0) state.snapshotPage = 0;
    const start = state.snapshotPage * HOLDERS_PER_PAGE;
    const slice = holders.slice(start, start + HOLDERS_PER_PAGE);

    const rows = slice.map((row, i) => {
      const addr = row[0];
      const shares = row[1];
      const rank = start + i + 1;
      const pct = total > 0n ? (Number((shares * 10000n) / total) / 100).toFixed(2) : '0.00';
      const usd = usdPerShare > 0 ? fmtUsd(bigToShares(shares, state.shareDecimals) * usdPerShare) : '-';
      return ''
        + '<a class="hub-row holders-snapshot-grid" href="https://basescan.org/address/' + addr + '" target="_blank" rel="noreferrer" role="row">'
        + '<span class="hub-cell hub-rank">' + rank + '</span>'
        + '<span class="hub-cell holder-addr" title="' + addr + '">' + fmtAddr(addr) + '</span>'
        + '<span class="hub-cell hub-num">' + usd + '</span>'
        + '<span class="hub-cell hub-num">' + fmtShares(shares, state.shareDecimals) + '</span>'
        + '<span class="hub-cell hub-num">' + pct + '%</span>'
        + '</a>';
    }).join('');
    $('snapshot-rows').innerHTML = rows;

    if (pager) {
      if (holders.length > HOLDERS_PER_PAGE) {
        pager.hidden = false;
        $('snapshot-info').textContent = 'Page ' + (state.snapshotPage + 1) + ' of ' + totalPages;
        $('snapshot-prev').disabled = state.snapshotPage === 0;
        $('snapshot-next').disabled = state.snapshotPage >= totalPages - 1;
      } else {
        pager.hidden = true;
      }
    }
  }

  // ─── Theme toggle ────────────────────────────────────────

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) {}
    updateThemeToggle();
    if (state.tvlChart) renderTvlApyChart(state.historyDaily, state.currentPeriod, state.chartType);
    if (state.holdersChart) renderHoldersChart(state.dailyHolderCounts, state.chartType);
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
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;
      const p = btn.getAttribute('data-period');
      state.currentPeriod = p;
      const all = $('period-toggle').querySelectorAll('.pill-btn');
      for (let i = 0; i < all.length; i++) {
        all[i].classList.toggle('is-active', all[i] === btn);
      }
      renderTvlApyChart(state.historyDaily, p, state.chartType);
    });

    const viewToggles = document.querySelectorAll('.chart-type-toggle');
    viewToggles.forEach((root) => {
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('.pill-btn');
        if (!btn) return;
        const t = btn.getAttribute('data-type');
        if (t === state.chartType) return;
        state.chartType = t;
        // Keep every chart-type toggle in sync.
        document.querySelectorAll('.chart-type-toggle .pill-btn').forEach((b) => {
          b.classList.toggle('is-active', b.getAttribute('data-type') === t);
        });
        renderTvlApyChart(state.historyDaily, state.currentPeriod, state.chartType);
        renderHoldersChart(state.dailyHolderCounts, state.chartType);
      });
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
      if (v) {
        state.snapshotPage = 0;
        renderSnapshot(v);
      }
    });

    const tvlCsv = $('download-tvl-csv');
    if (tvlCsv) {
      tvlCsv.addEventListener('click', () => {
        if (state.historyDaily.length === 0) return;
        const rows = [['date', 'tvl_usd', 'apy_pct', 'share_price']];
        state.historyDaily.forEach((d) => {
          rows.push([d.date, d.tvl, d.apy, d.sharePrice]);
        });
        downloadCsv('weth-autopilot-tvl-apy.csv', rows);
      });
    }

    const holdersCsv = $('download-holders-csv');
    if (holdersCsv) {
      holdersCsv.addEventListener('click', () => {
        if (state.dailyHolderCounts.length === 0) return;
        const rows = [['date', 'holders']];
        state.dailyHolderCounts.forEach((d) => rows.push([d.date, d.count]));
        downloadCsv('weth-autopilot-holders.csv', rows);
      });
    }

    $('snapshot-prev').addEventListener('click', () => {
      state.snapshotPage = Math.max(0, state.snapshotPage - 1);
      const v = $('snapshot-date').value;
      if (v) renderSnapshot(v);
    });
    $('snapshot-next').addEventListener('click', () => {
      state.snapshotPage = state.snapshotPage + 1;
      const v = $('snapshot-date').value;
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

  // Push raw history + txs into `state`. Recomputes all derived
  // collections (daily buckets, holder balances, day snapshots, the
  // current USD-per-share). Idempotent - safe to call again after a
  // delta fetch with the merged dataset.
  function applyData(vault, history, txs) {
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

    const latest = state.historyDaily.length > 0 ? state.historyDaily[state.historyDaily.length - 1] : null;
    const tvlNow = (vault && vault.tvl != null) ? Number(vault.tvl) : (latest ? Number(latest.tvl) : 0);
    const totalSharesNum = bigToShares(state.totalShares, state.shareDecimals);
    state.currentTvl = tvlNow;
    state.usdPerShareNow = (tvlNow > 0 && totalSharesNum > 0) ? (tvlNow / totalSharesNum) : 0;
  }

  function renderAll() {
    let holderCount = 0;
    state.currentBalances.forEach((b) => { if (b > 0n) holderCount++; });

    renderStats(state.vault, state.historyDaily, holderCount);
    renderTvlApyChart(state.historyDaily, state.currentPeriod, state.chartType);
    renderHoldersChart(state.dailyHolderCounts, state.chartType);
    renderCurrentStats();
    renderHoldersList();

    const dateInput = $('snapshot-date');
    const today = todayKey();
    const minDate = state.history.length > 0 ? dayKey(Number(state.history[0].timestamp)) : today;
    dateInput.min = minDate;
    dateInput.max = today;
    if (!dateInput.value) dateInput.value = today;
    renderSnapshot(dateInput.value || today);
  }

  async function init() {
    updateThemeToggle();
    setupEvents();
    $('vault-link').textContent = VAULT;
    $('vault-link').href = EXPLORER;
    const incEl = $('incentives-date');
    if (incEl) incEl.textContent = fmtFullDate(BASE_INCENTIVES_START);

    // Step 1 - hydrate from cache if we have one. This paints the
    // page within a few ms, so a returning visitor doesn't sit on
    // skeleton "..." text while the network round-trips.
    const cache = readCache();
    let renderedFromCache = false;
    if (cache && cache.history.length > 0 && cache.txs.length > 0) {
      try {
        applyData(cache.meta, cache.history, cache.txs);
        renderAll();
        renderedFromCache = true;
        // Show the live "Updated Nm ago" pill right away, using the
        // timestamp from cache. It will get updated again after the
        // delta-fetch lands.
        if (cache.updated) {
          state.lastUpdated = cache.updated;
          refreshCacheStatusTick();
        }
      } catch (e) {
        console.warn('Cache render failed:', e);
        renderedFromCache = false;
      }
    }
    if (!renderedFromCache) setLoadingState();

    // Step 2 - delta fetch. With a cache we ask the subgraph for
    // records strictly after our cached max-timestamp; otherwise
    // it's a full pull just like the cold-load path.
    try {
      const userField = (cache && cache.userField) || await discoverUserField();
      const sinceHistoryTs = (cache && cache.history.length > 0) ? maxTimestamp(cache.history) : 0;
      const sinceTxsTs = (cache && cache.txs.length > 0) ? maxTimestamp(cache.txs) : 0;

      const results = await Promise.all([
        loadVaultMeta().catch((e) => { console.warn('vault meta error', e); return null; }),
        loadHistory(sinceHistoryTs),
        loadTransactions(userField, sinceTxsTs),
      ]);
      const vault = results[0];
      const newHistory = results[1];
      const newTxs = results[2];

      const fullHistory = (cache ? cache.history : []).concat(newHistory);
      const fullTxs = (cache ? cache.txs : []).concat(newTxs);

      applyData(vault, fullHistory, fullTxs);
      renderAll();

      writeCache({ meta: vault, history: fullHistory, txs: fullTxs, userField: userField });

      state.lastUpdated = Date.now();
      refreshCacheStatusTick();
      // Live ticker so "1m ago" becomes "2m ago" etc. without a reload.
      if (state.cacheStatusTimer) clearInterval(state.cacheStatusTimer);
      state.cacheStatusTimer = setInterval(refreshCacheStatusTick, 30000);
    } catch (e) {
      console.error('Dashboard load error:', e);
      if (renderedFromCache) {
        setCacheStatus('Update failed, showing cached data', 'warn');
      } else {
        setErrorState(e && e.message ? e.message : 'unknown error');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
