/* =============================================================
   HYPERBOOKMAP — Dual-Feed Renderer

   windowHalf = microTickSize * cfg.levels  (MICRO only, never wide)
   Price axis  = always centered on current midPrice
   Wide levels = rendered with their own rowH but same price window
   ============================================================= */

window.BookmapPage = (() => {

  let cfg = {
    coin:      localStorage.getItem('bm_coin')            || 'BTC',
    levels:    parseInt(localStorage.getItem('bm_levels') || '80'),
    colWidth:  parseInt(localStorage.getItem('bm_speed')  || '4'),
    maxBubble: 20,
  };

  let contrast = parseFloat(localStorage.getItem('bm_contrast') || '0.05');

  let canvas, ctx, wrap;
  let W = 0, H = 0;
  let dirty = false;

  let midPrice      = null;
  let microTickSize = null;
  let wideTickSize  = null;
  let windowHalf    = null;  // ALWAYS microTickSize * cfg.levels

  const MAX_COLS = 3000;
  const colBuf   = [];  // {mid, bids:[{px,sz,wide}], asks:[{px,sz,wide}]}
  const bubbles  = [];

  const latest = {
    micro: { bids: [], asks: [] },
    wide:  { bids: [], asks: [] },
  };

  // ── Colors ────────────────────────────────────────────────
  function bidColor(norm) {
    return `rgba(${Math.round(norm*40)},${Math.round(norm*200)},${Math.round(60+norm*150)},${(0.1+norm*0.9).toFixed(2)})`;
  }
  function askColor(norm) {
    return `rgba(${Math.round(60+norm*195)},${Math.round(norm*80)},${Math.round(norm*20)},${(0.1+norm*0.9).toFixed(2)})`;
  }

  // ── DOM ───────────────────────────────────────────────────
  function init() {
    const page = document.getElementById('page-bookmap');
    page.innerHTML = `
      <div id="bm-header">
        <span>Bookmap</span>
        <span id="bm-coin-badge">${cfg.coin}-PERP</span>
        <span id="bm-price">—</span>
        <span id="bm-spread"></span>
        <div id="bm-contrast-wrap">
          Contrast
          <input id="bm-contrast" type="range" min="0" max="0.5" step="0.01" value="${contrast}">
          <span id="bm-contrast-val">${Math.round(contrast*100)}%</span>
        </div>
        <div id="bm-status">
          <div class="status-dot" id="bm-dot"></div>
          <span id="bm-status-text">Connecting…</span>
        </div>
      </div>

      <div id="bm-body">
        <div id="bm-canvas-wrap">
          <canvas id="bm-canvas"></canvas>
          <div id="bm-overlay">
            Levels: <span id="ov-levels">${cfg.levels}</span><br>
            Coin: <span id="ov-coin">${cfg.coin}</span><br>
            Range: ±<span id="ov-range">—</span><br>
            Micro: <span id="ov-tick-micro">—</span> Wide: <span id="ov-tick-wide">—</span>
          </div>
          <div id="bm-waiting">
            <div class="spinner"></div>
            <span>Waiting for backend…</span>
            <small style="color:var(--faint);font-size:10px">Run: <code style="color:var(--accent)">python backend/server.py</code></small>
          </div>
        </div>

        <div id="bm-ob">
          <div id="bm-ob-header"><span>Price</span><span>Size</span></div>
          <div id="bm-ob-body">
            <div id="bm-ob-asks"></div>
            <div id="bm-ob-mid">—</div>
            <div id="bm-ob-bids"></div>
          </div>
        </div>
      </div>
    `;

    canvas = document.getElementById('bm-canvas');
    ctx    = canvas.getContext('2d');
    wrap   = document.getElementById('bm-canvas-wrap');

    new ResizeObserver(resize).observe(wrap);
    resize();
    startLoop();

    document.getElementById('bm-contrast').addEventListener('input', e => {
      contrast = parseFloat(e.target.value);
      localStorage.setItem('bm_contrast', contrast);
      document.getElementById('bm-contrast-val').textContent = Math.round(contrast*100) + '%';
      dirty = true;
    });

    BackendWS.on('l2Book',       onBook);
    BackendWS.on('trades',       onTrades);
    BackendWS.on('coin_changed', msg => {
      setEl('bm-coin-badge', msg.coin + '-PERP');
      setEl('ov-coin', msg.coin);
      resetState();
    });
  }

  function setEl(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = W; canvas.height = H;
    dirty = true;
  }

  // ── Window: ALWAYS based on micro tick ────────────────────
  function computeWindow() {
    if (!microTickSize) return;          // wait for micro, never use wide
    windowHalf = microTickSize * cfg.levels;
    setEl('ov-range', windowHalf.toFixed(windowHalf > 100 ? 0 : 2));
  }

  // price → canvas Y, always relative to CURRENT midPrice
  function py(price) {
    if (midPrice === null || !windowHalf) return H / 2;
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    return H - ((price - lo) / (hi - lo)) * H;
  }

  // row height for a given tick size
  function rowHForTick(tick) {
    if (!windowHalf || !tick) return 1;
    return Math.max(1, (H / (windowHalf * 2)) * tick);
  }

  // ── Book handler ─────────────────────────────────────────
  function onBook(msg) {
    const feed = msg.feed || 'micro';
    const bids = msg.bids || [];
    const asks = msg.asks || [];
    if (!bids.length && !asks.length) return;

    latest[feed].bids = bids;
    latest[feed].asks = asks;

    // Detect tick size once per feed
    if (bids.length >= 2) {
      const t = Math.abs(parseFloat(bids[0].px) - parseFloat(bids[1].px));
      if (t > 0) {
        if (feed === 'micro' && !microTickSize) {
          microTickSize = t;
          setEl('ov-tick-micro', 'Δ' + t.toFixed(t < 10 ? 2 : 1));
          computeWindow();   // now we can render
        }
        if (feed === 'wide' && !wideTickSize) {
          wideTickSize = t;
          setEl('ov-tick-wide', 'Δ' + t.toFixed(t < 10 ? 2 : 1));
          // do NOT recompute windowHalf from wide
        }
      }
    }

    // Mid from micro only
    if (feed === 'micro' && bids.length && asks.length) {
      const bb = parseFloat(bids[0].px);
      const ba = parseFloat(asks[0].px);
      midPrice = (bb + ba) / 2;
      const spread = ba - bb;
      setEl('bm-price', midPrice.toFixed(midPrice > 100 ? 1 : 4));
      const se = document.getElementById('bm-spread');
      if (se) se.textContent = 'sprd ' + spread.toFixed(spread < 1 ? 4 : 1);
    }

    // Push column — only when we have a valid window
    if (midPrice !== null && windowHalf !== null) {
      const isWide     = feed === 'wide';
      const microRange = microTickSize ? microTickSize * 100 : 0;

      const filteredBids = isWide
        ? bids.filter(b => Math.abs(parseFloat(b.px) - midPrice) > microRange)
        : bids;
      const filteredAsks = isWide
        ? asks.filter(a => Math.abs(parseFloat(a.px) - midPrice) > microRange)
        : asks;

      const snap = {
        mid:  midPrice,   // snapshot mid for historical columns
        bids: filteredBids.slice(0, cfg.levels).map(b => ({ px: parseFloat(b.px), sz: parseFloat(b.sz), wide: isWide })),
        asks: filteredAsks.slice(0, cfg.levels).map(a => ({ px: parseFloat(a.px), sz: parseFloat(a.sz), wide: isWide })),
      };

      if (snap.bids.length || snap.asks.length) {
        colBuf.push(snap);
        if (colBuf.length > MAX_COLS) colBuf.shift();
      }
    }

    updateOrderbook();
    dirty = true;
  }

  function onTrades(msg) {
    if (!W || !H || midPrice === null) return;
    const newestX = Math.floor((W - 58) * 0.85);
    for (const t of (msg.trades || [])) {
      const price = parseFloat(t.px);
      const size  = parseFloat(t.sz);
      const y = py(price);
      if (y < 0 || y > H) continue;
      const r = Math.min(cfg.maxBubble, Math.max(3, Math.sqrt(size) * 2));
      bubbles.push({ x: newestX, y, r, side: t.side, alpha: 0.9 });
    }
    if (bubbles.length > 600) bubbles.splice(0, bubbles.length - 600);
    dirty = true;
  }

  // ── Orderbook panel ───────────────────────────────────────
  function updateOrderbook() {
    const asksEl = document.getElementById('bm-ob-asks');
    const bidsEl = document.getElementById('bm-ob-bids');
    const midEl  = document.getElementById('bm-ob-mid');
    if (!asksEl || !bidsEl) return;

    const asks = latest.micro.asks.slice(0, 20);
    const bids = latest.micro.bids.slice(0, 20);
    if (!asks.length && !bids.length) return;

    const allSz = [...asks, ...bids].map(x => parseFloat(x.sz));
    const maxSz = Math.max(...allSz, 1);
    const fmt   = p => parseFloat(p).toFixed(midPrice > 100 ? 1 : 4);

    asksEl.innerHTML = asks.map(a => {
      const sz = parseFloat(a.sz);
      return `<div class="ob-row ask"><div class="ob-bar" style="width:${Math.round(sz/maxSz*100)}%"></div><span class="ob-px">${fmt(a.px)}</span><span class="ob-sz">${sz.toFixed(3)}</span></div>`;
    }).join('');

    bidsEl.innerHTML = bids.map(b => {
      const sz = parseFloat(b.sz);
      return `<div class="ob-row bid"><div class="ob-bar" style="width:${Math.round(sz/maxSz*100)}%"></div><span class="ob-px">${fmt(b.px)}</span><span class="ob-sz">${sz.toFixed(3)}</span></div>`;
    }).join('');

    if (midEl && midPrice !== null)
      midEl.textContent = midPrice.toFixed(midPrice > 100 ? 1 : 4);
  }

  function resetState() {
    colBuf.length = 0; bubbles.length = 0;
    midPrice = null; microTickSize = null; wideTickSize = null; windowHalf = null;
    latest.micro.bids = []; latest.micro.asks = [];
    latest.wide.bids  = []; latest.wide.asks  = [];
    setEl('bm-price', '—');
    setEl('ov-tick-micro', '—'); setEl('ov-tick-wide', '—'); setEl('ov-range', '—');
    ['bm-ob-asks','bm-ob-bids'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    setEl('bm-ob-mid', '—');
  }

  // ── Render ────────────────────────────────────────────────
  function startLoop() {
    (function loop() { if (dirty) { render(); dirty = false; } requestAnimationFrame(loop); })();
  }

  function render() {
    if (!ctx || !W || !H) return;
    ctx.clearRect(0, 0, W, H);
    if (!colBuf.length || !windowHalf || midPrice === null) return;

    const AXIS_W      = 58;
    const HEAT_W      = W - AXIS_W;
    const newestX     = Math.floor(HEAT_W * 0.85);
    const numCols     = colBuf.length;
    const visibleCols = Math.floor(newestX / cfg.colWidth) + 1;
    const startIdx    = Math.max(0, numCols - visibleCols);

    // Separate normalization per feed
    let maxM = 0, maxW = 0;
    for (let i = startIdx; i < numCols; i++) {
      const s = colBuf[i];
      for (const b of s.bids) b.wide ? (b.sz > maxW && (maxW = b.sz)) : (b.sz > maxM && (maxM = b.sz));
      for (const a of s.asks) a.wide ? (a.sz > maxW && (maxW = a.sz)) : (a.sz > maxM && (maxM = a.sz));
    }
    if (!maxM) maxM = maxW || 1;
    if (!maxW) maxW = maxM || 1;

    const thrM = contrast * maxM;
    const thrW = contrast * maxW;
    const rhM  = rowHForTick(microTickSize);
    const rhW  = rowHForTick(wideTickSize);

    // Grid
    ctx.strokeStyle = 'rgba(30,30,50,0.5)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const y = Math.round((i / 10) * H);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(HEAT_W, y); ctx.stroke();
    }

    // Columns — all prices projected onto CURRENT mid window via py()
    for (let col = 0; col < visibleCols; col++) {
      const si = startIdx + col;
      if (si >= numCols) break;
      const snap = colBuf[si];
      const x = newestX - (numCols - 1 - si) * cfg.colWidth;
      if (x + cfg.colWidth < 0) continue;

      for (const b of snap.bids) {
        if (b.sz < (b.wide ? thrW : thrM)) continue;
        const mx = b.wide ? maxW : maxM;
        const rh = b.wide ? rhW  : rhM;
        ctx.fillStyle = bidColor(b.sz / mx);
        ctx.fillRect(x, py(b.px) - rh * 0.5, cfg.colWidth, rh);
      }
      for (const a of snap.asks) {
        if (a.sz < (a.wide ? thrW : thrM)) continue;
        const mx = a.wide ? maxW : maxM;
        const rh = a.wide ? rhW  : rhM;
        ctx.fillStyle = askColor(a.sz / mx);
        ctx.fillRect(x, py(a.px) - rh * 0.5, cfg.colWidth, rh);
      }
    }

    // Mid line
    const midY = py(midPrice);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(122,162,247,0.9)';
    ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.moveTo(0, midY); ctx.lineTo(newestX + cfg.colWidth, midY);
    ctx.stroke(); ctx.setLineDash([]);

    // Price axis — always based on current mid + windowHalf
    ctx.fillStyle = 'rgba(10,10,20,0.7)';
    ctx.fillRect(HEAT_W, 0, AXIS_W, H);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(30,30,50,0.8)'; ctx.lineWidth = 1;
    ctx.moveTo(HEAT_W, 0); ctx.lineTo(HEAT_W, H); ctx.stroke();

    const lo    = midPrice - windowHalf;
    const range = windowHalf * 2;
    ctx.font = '10px Inter, monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 12; i++) {
      const price = lo + (range / 12) * i;
      const y     = H - (i / 12) * H;
      ctx.fillStyle = 'rgba(108,112,134,0.9)';
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), HEAT_W + 4, y + 3);
    }
    // Current mid highlighted in blue
    ctx.fillStyle = 'rgba(122,162,247,1)'; ctx.font = '11px Inter, monospace';
    ctx.fillText(midPrice.toFixed(midPrice > 100 ? 1 : 4), HEAT_W + 4, midY + 4);

    // Bubbles
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle   = b.side === 'B' ? `rgba(166,227,161,${b.alpha.toFixed(2)})` : `rgba(239,83,80,${b.alpha.toFixed(2)})`;
      ctx.strokeStyle = b.side === 'B' ? 'rgba(166,227,161,0.9)' : 'rgba(239,83,80,0.9)';
      ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
      b.alpha -= 0.003;
    }
    if (bubbles.length) dirty = true;
  }

  // ── Public ────────────────────────────────────────────────
  function onShow() { resize(); dirty = true; }

  function onConnected() {
    document.getElementById('bm-dot')?.classList.add('live');
    setEl('bm-status-text', 'Live');
    document.getElementById('bm-waiting')?.classList.add('hidden');
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
  }

  function onDisconnected() {
    document.getElementById('bm-dot')?.classList.remove('live');
    setEl('bm-status-text', 'Reconnecting…');
    document.getElementById('bm-waiting')?.classList.remove('hidden');
  }

  function updateCfg(newCfg) {
    Object.assign(cfg, newCfg);
    localStorage.setItem('bm_coin',   cfg.coin);
    localStorage.setItem('bm_levels', cfg.levels);
    localStorage.setItem('bm_speed',  cfg.colWidth);
    computeWindow();   // recalculate with new cfg.levels
    resetState();
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
    setEl('bm-coin-badge', cfg.coin + '-PERP');
    setEl('ov-coin',   cfg.coin);
    setEl('ov-levels', cfg.levels);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected, onDisconnected, updateCfg, getCfg: () => ({ ...cfg }) };
})();
