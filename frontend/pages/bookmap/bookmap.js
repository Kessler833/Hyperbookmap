/* =============================================================
   HYPERBOOKMAP — Proper Bookmap renderer

   HOW IT WORKS (like real Bookmap):
   - Every l2Book snapshot = one vertical column on canvas
   - Y-axis = price, centered around mid price
   - The visible price window is fixed height around mid (e.g. ±N ticks)
   - Every price level in that window gets a colored pixel/rect
   - Brightness = order size at that level
   - Columns scroll left, newest always on right
   - 85% scroll: newest column drawn at x=85% of canvas width,
     leaving 15% empty space on the right
   ============================================================= */

window.BookmapPage = (() => {
  let cfg = {
    coin:      localStorage.getItem('bm_coin')            || 'BTC',
    levels:    parseInt(localStorage.getItem('bm_levels') || '80'),
    colWidth:  parseInt(localStorage.getItem('bm_speed')  || '4'),
    maxBubble: 20,
  };

  // contrast: 0..1 — fraction of maxSz below which levels are hidden
  let contrast = parseFloat(localStorage.getItem('bm_contrast') || '0.05');

  let canvas, ctx, wrap;
  let W = 0, H = 0;
  let dirty = false;

  let midPrice    = null;
  let tickSize    = null;

  // Fixed-height price window centered on mid (in price units)
  // Derived once tickSize is known: windowHalf = levels * tickSize
  let windowHalf  = null;  // half the visible price range

  const MAX_COLS  = 3000;
  const colBuf    = [];   // [{bids:[{px,sz}], asks:[{px,sz}], mid}]
  const bubbles   = [];

  let latestBids  = [];
  let latestAsks  = [];

  // ── Colors ─────────────────────────────────────────────
  function bidColor(norm) {
    // black → bright cyan/blue
    const r = Math.round(norm * 40);
    const g = Math.round(norm * 200);
    const b = Math.round(60 + norm * 150);
    return `rgba(${r},${g},${b},${(0.1 + norm * 0.9).toFixed(2)})`;
  }
  function askColor(norm) {
    // black → bright red/orange
    const r = Math.round(60 + norm * 195);
    const g = Math.round(norm * 80);
    const b = Math.round(norm * 20);
    return `rgba(${r},${g},${b},${(0.1 + norm * 0.9).toFixed(2)})`;
  }

  // ── DOM init ──────────────────────────────────────────
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
            Tick: <span id="ov-tick">—</span>
          </div>
          <div id="bm-waiting">
            <div class="spinner"></div>
            <span>Waiting for backend…</span>
            <small style="color:var(--faint);font-size:10px">Run: <code style="color:var(--accent)">python backend/server.py</code></small>
          </div>
        </div>

        <div id="bm-ob">
          <div id="bm-ob-header">
            <span>Price</span><span>Size</span>
          </div>
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

    new ResizeObserver(() => resize()).observe(wrap);
    resize();
    startLoop();

    document.getElementById('bm-contrast').addEventListener('input', e => {
      contrast = parseFloat(e.target.value);
      localStorage.setItem('bm_contrast', contrast);
      document.getElementById('bm-contrast-val').textContent = Math.round(contrast * 100) + '%';
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

  function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width  = W;
    canvas.height = H;
    dirty = true;
  }

  // ── Price window helpers ───────────────────────────────────
  // The visible price window: [mid - windowHalf, mid + windowHalf]
  // windowHalf is recalculated whenever tickSize or cfg.levels changes
  function computeWindow() {
    if (tickSize === null) return;
    windowHalf = tickSize * cfg.levels;
  }

  // Convert price to Y pixel using the CURRENT mid as center
  function priceToY(price) {
    if (midPrice === null || windowHalf === null || windowHalf === 0) return H / 2;
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    // price==hi → y=0 (top), price==lo → y=H (bottom)
    return H - ((price - lo) / (hi - lo)) * H;
  }

  // The Y coordinate a stored snapshot column used (it had its own mid)
  function priceToYWithMid(price, snapMid) {
    if (snapMid === null || windowHalf === null || windowHalf === 0) return H / 2;
    const lo = snapMid - windowHalf;
    const hi = snapMid + windowHalf;
    return H - ((price - lo) / (hi - lo)) * H;
  }

  // How tall is one tick in pixels?
  function tickPx() {
    if (tickSize === null || windowHalf === null) return cfg.colWidth;
    return Math.max(1, (H / (windowHalf * 2)) * tickSize);
  }

  // ── Data handlers ───────────────────────────────────────
  function onBook(msg) {
    const bids = msg.bids || [];
    const asks = msg.asks || [];
    if (!bids.length && !asks.length) return;

    latestBids = bids;
    latestAsks = asks;

    // Derive tick size from first snapshot
    if (tickSize === null && bids.length >= 2) {
      tickSize = Math.abs(parseFloat(bids[0].px) - parseFloat(bids[1].px));
      if (tickSize === 0) tickSize = null; // guard
      else {
        computeWindow();
        setEl('ov-tick', tickSize.toFixed(tickSize < 1 ? 4 : 1));
      }
    }

    if (bids.length && asks.length) {
      const bestBid = parseFloat(bids[0].px);
      const bestAsk = parseFloat(asks[0].px);
      midPrice = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;
      setEl('bm-price', midPrice.toFixed(midPrice > 100 ? 1 : 4));
      const spreadEl = document.getElementById('bm-spread');
      if (spreadEl) spreadEl.textContent = 'sprd ' + spread.toFixed(spread < 1 ? 4 : 1);
    }

    // Store full snapshot with its mid
    const snap = {
      mid:  midPrice,
      bids: bids.slice(0, cfg.levels).map(b => ({ px: parseFloat(b.px), sz: parseFloat(b.sz) })),
      asks: asks.slice(0, cfg.levels).map(a => ({ px: parseFloat(a.px), sz: parseFloat(a.sz) })),
    };
    colBuf.push(snap);
    if (colBuf.length > MAX_COLS) colBuf.shift();

    updateOrderbook();
    dirty = true;
  }

  function onTrades(msg) {
    const trades = msg.trades || [];
    if (!W || !H || midPrice === null) return;
    // 85% anchor: newest trades appear at 85% of width
    const newestX = Math.floor(W * 0.85);
    trades.forEach(t => {
      const price = parseFloat(t.px);
      const size  = parseFloat(t.sz);
      const y = priceToY(price);
      if (y < 0 || y > H) return;
      const r = Math.min(cfg.maxBubble, Math.max(3, Math.sqrt(size) * 2));
      bubbles.push({ x: newestX, y, r, side: t.side, alpha: 0.9 });
      if (bubbles.length > 600) bubbles.splice(0, bubbles.length - 600);
    });
    dirty = true;
  }

  // ── Orderbook panel ────────────────────────────────────────
  function updateOrderbook() {
    const asksEl = document.getElementById('bm-ob-asks');
    const bidsEl = document.getElementById('bm-ob-bids');
    const midEl  = document.getElementById('bm-ob-mid');
    if (!asksEl || !bidsEl) return;

    const ROWS = 20;
    const asks = latestAsks.slice(0, ROWS);
    const bids = latestBids.slice(0, ROWS);
    const allSz = [...asks.map(a => parseFloat(a.sz)), ...bids.map(b => parseFloat(b.sz))];
    const maxSz = allSz.length ? Math.max(...allSz) : 1;

    const fmt = p => parseFloat(p).toFixed(midPrice > 100 ? 1 : 4);

    asksEl.innerHTML = asks.map(a => {
      const sz  = parseFloat(a.sz);
      const pct = Math.round((sz / maxSz) * 100);
      return `<div class="ob-row ask"><div class="ob-bar" style="width:${pct}%"></div><span class="ob-px">${fmt(a.px)}</span><span class="ob-sz">${sz.toFixed(3)}</span></div>`;
    }).join('');

    bidsEl.innerHTML = bids.map(b => {
      const sz  = parseFloat(b.sz);
      const pct = Math.round((sz / maxSz) * 100);
      return `<div class="ob-row bid"><div class="ob-bar" style="width:${pct}%"></div><span class="ob-px">${fmt(b.px)}</span><span class="ob-sz">${sz.toFixed(3)}</span></div>`;
    }).join('');

    if (midEl && midPrice !== null)
      midEl.textContent = midPrice.toFixed(midPrice > 100 ? 1 : 4);
  }

  function resetState() {
    colBuf.length = 0;
    bubbles.length = 0;
    midPrice = null; tickSize = null; windowHalf = null;
    latestBids = []; latestAsks = [];
    setEl('bm-price', '—');
    setEl('ov-tick',  '—');
    const asksEl = document.getElementById('bm-ob-asks');
    const bidsEl = document.getElementById('bm-ob-bids');
    const midEl  = document.getElementById('bm-ob-mid');
    if (asksEl) asksEl.innerHTML = '';
    if (bidsEl) bidsEl.innerHTML = '';
    if (midEl)  midEl.textContent = '—';
  }

  // ── Render loop ─────────────────────────────────────────
  function startLoop() {
    (function loop() {
      if (dirty) { render(); dirty = false; }
      requestAnimationFrame(loop);
    })();
  }

  function render() {
    if (!ctx || !W || !H) return;
    ctx.clearRect(0, 0, W, H);

    if (colBuf.length === 0 || windowHalf === null || midPrice === null) return;

    // ── Layout constants ────────────────────────────────────
    const AXIS_W     = 58;          // px reserved for price axis on right
    const HEAT_W     = W - AXIS_W;  // canvas width for heatmap columns
    const ANCHOR     = 0.85;        // newest column at 85% of HEAT_W
    const newestX    = Math.floor(HEAT_W * ANCHOR);
    const numCols    = colBuf.length;

    // How many columns fit from 0 to newestX?
    const visibleCols = Math.floor(newestX / cfg.colWidth) + 1;
    const startIdx    = Math.max(0, numCols - visibleCols);

    // Pixel height of one tick
    const tPx = tickPx();
    const rowH = Math.max(1, tPx);

    // ── Global normalize: max order size across visible window ──
    let maxSz = 0;
    for (let i = startIdx; i < numCols; i++) {
      const s = colBuf[i];
      for (const b of s.bids) if (b.sz > maxSz) maxSz = b.sz;
      for (const a of s.asks) if (a.sz > maxSz) maxSz = a.sz;
    }
    if (maxSz === 0) return;

    const threshold = contrast * maxSz;

    // ── Draw grid lines ────────────────────────────────────
    ctx.strokeStyle = 'rgba(30,30,50,0.5)';
    ctx.lineWidth   = 1;
    const gridSteps = 10;
    for (let i = 0; i <= gridSteps; i++) {
      const y = Math.round((i / gridSteps) * H);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(HEAT_W, y);
      ctx.stroke();
    }

    // ── Draw heatmap columns ───────────────────────────────
    // Each stored snapshot is rendered as one vertical column.
    // X position: newest at newestX, older columns to the left.
    // Y position: computed from that snapshot's own mid price
    //             so the price ladder is stable relative to mid.

    for (let col = 0; col < visibleCols; col++) {
      const snapIdx = startIdx + col;
      if (snapIdx >= numCols) break;
      const snap = colBuf[snapIdx];
      const snapMid = snap.mid;
      if (snapMid === null) continue;

      // x of this column (older = further left)
      const colsFromNewest = (numCols - 1) - snapIdx;
      const x = newestX - colsFromNewest * cfg.colWidth;
      if (x + cfg.colWidth < 0) continue; // off-screen left

      for (const b of snap.bids) {
        if (b.sz < threshold) continue;
        const norm = b.sz / maxSz;
        const y    = priceToYWithMid(b.px, snapMid);
        ctx.fillStyle = bidColor(norm);
        ctx.fillRect(x, y - rowH * 0.5, cfg.colWidth, rowH);
      }

      for (const a of snap.asks) {
        if (a.sz < threshold) continue;
        const norm = a.sz / maxSz;
        const y    = priceToYWithMid(a.px, snapMid);
        ctx.fillStyle = askColor(norm);
        ctx.fillRect(x, y - rowH * 0.5, cfg.colWidth, rowH);
      }
    }

    // ── Mid price line (at current mid, drawn at newestX anchor) ──
    const midY = priceToY(midPrice);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(122,162,247,0.9)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, midY);
    ctx.lineTo(newestX + cfg.colWidth, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Price axis (right of heatmap) ────────────────────────
    ctx.fillStyle   = 'rgba(10,10,20,0.7)';
    ctx.fillRect(HEAT_W, 0, AXIS_W, H);
    ctx.strokeStyle = 'rgba(30,30,50,0.8)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(HEAT_W, 0);
    ctx.lineTo(HEAT_W, H);
    ctx.stroke();

    ctx.font      = '10px Inter, monospace';
    ctx.fillStyle = 'rgba(108,112,134,0.9)';
    ctx.textAlign = 'left';
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    const range = hi - lo;
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const price = lo + (range / steps) * i;
      const y     = H - (i / steps) * H;
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), HEAT_W + 4, y + 3);
    }

    // Highlight mid price label
    ctx.fillStyle = 'rgba(122,162,247,1)';
    ctx.font      = '11px Inter, monospace';
    ctx.fillText(midPrice.toFixed(midPrice > 100 ? 1 : 4), HEAT_W + 4, midY + 4);

    // ── Trade bubbles ────────────────────────────────────────
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle   = b.side === 'B'
        ? `rgba(166,227,161,${b.alpha.toFixed(2)})`
        : `rgba(239,83,80,${b.alpha.toFixed(2)})`;
      ctx.strokeStyle = b.side === 'B' ? 'rgba(166,227,161,0.9)' : 'rgba(239,83,80,0.9)';
      ctx.lineWidth   = 1;
      ctx.fill();
      ctx.stroke();
      b.alpha -= 0.003;
    }
    if (bubbles.length > 0) dirty = true;
  }

  // ── Public API ───────────────────────────────────────────
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
    // Recompute window if levels changed
    computeWindow();
    resetState();
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
    setEl('bm-coin-badge', cfg.coin + '-PERP');
    setEl('ov-coin',   cfg.coin);
    setEl('ov-levels', cfg.levels);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected, onDisconnected, updateCfg, getCfg: () => ({ ...cfg }) };
})();
