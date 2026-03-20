/* =============================================================
   HYPERBOOKMAP — Canvas renderer
   x-axis = time (columns scrolling left, newest = right)
   y-axis = price levels
   color  = bid/ask liquidity (heatmap)
   bubbles = executed trades
   ============================================================= */

window.BookmapPage = (() => {
  // ── Config ─────────────────────────────────────────────
  let cfg = {
    coin:      localStorage.getItem('bm_coin')            || 'BTC',
    levels:    parseInt(localStorage.getItem('bm_levels') || '40'),
    colWidth:  parseInt(localStorage.getItem('bm_speed')  || '4'),
    maxBubble: 20,
  };

  // ── State ─────────────────────────────────────────────
  let canvas, ctx, wrap;
  let W = 0, H = 0;
  let dirty = false;

  let midPrice  = null;
  let tickSize  = null;
  let priceMin  = null;
  let priceMax  = null;

  // Simple array buffer — oldest at [0], newest at [length-1]
  // Fixed: no ring-buffer index confusion (Bug #1 & #2 fixed)
  const MAX_COLS = 2000;
  const colBuf   = [];

  // Trade bubbles
  const bubbles = [];

  // ── Color helpers ──────────────────────────────────────
  function bidColor(norm) {
    const r = Math.round(10  + norm * 30);
    const g = Math.round(30  + norm * 180);
    const b = Math.round(80  + norm * 120);
    return `rgba(${r},${g},${b},${(0.15 + norm * 0.7).toFixed(2)})`;
  }
  function askColor(norm) {
    const r = Math.round(80  + norm * 175);
    const g = Math.round(20  + norm * 60);
    const b = Math.round(20  + norm * 30);
    return `rgba(${r},${g},${b},${(0.15 + norm * 0.7).toFixed(2)})`;
  }

  // ── DOM init ──────────────────────────────────────────
  function init() {
    const page = document.getElementById('page-bookmap');
    page.innerHTML = `
      <div id="bm-header">
        <span>Bookmap</span>
        <span id="bm-coin-badge">${cfg.coin}-PERP</span>
        <span id="bm-price">—</span>
        <div id="bm-status">
          <div class="status-dot" id="bm-dot"></div>
          <span id="bm-status-text">Connecting…</span>
        </div>
      </div>
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
    `;

    canvas = document.getElementById('bm-canvas');
    ctx    = canvas.getContext('2d');
    wrap   = document.getElementById('bm-canvas-wrap');

    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    resize();
    startLoop();

    BackendWS.on('l2Book',       onBook);
    BackendWS.on('trades',       onTrades);
    BackendWS.on('coin_changed', (msg) => {
      const badge = document.getElementById('bm-coin-badge');
      const ovCoin = document.getElementById('ov-coin');
      if (badge)  badge.textContent  = msg.coin + '-PERP';
      if (ovCoin) ovCoin.textContent = msg.coin;
      resetState();
    });
  }

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width  = W;
    canvas.height = H;
    dirty = true;
  }

  // ── Data handlers ───────────────────────────────────────
  function onBook(msg) {
    const bids = msg.bids || [];
    const asks = msg.asks || [];
    if (!bids.length && !asks.length) return;

    if (!tickSize && bids.length >= 2) {
      const p0 = parseFloat(bids[0].px);
      const p1 = parseFloat(bids[1].px);
      tickSize = Math.abs(p0 - p1);
      const el = document.getElementById('ov-tick');
      if (el) el.textContent = tickSize.toFixed(tickSize < 1 ? 4 : 1);
    }

    if (bids.length && asks.length) {
      const bestBid = parseFloat(bids[0].px);
      const bestAsk = parseFloat(asks[0].px);
      midPrice = (bestBid + bestAsk) / 2;
      const el = document.getElementById('bm-price');
      if (el) el.textContent = midPrice.toFixed(midPrice > 100 ? 1 : 4);
    }

    const snap = {
      bids: bids.slice(0, cfg.levels).map(b => ({ px: parseFloat(b.px), sz: parseFloat(b.sz) })),
      asks: asks.slice(0, cfg.levels).map(a => ({ px: parseFloat(a.px), sz: parseFloat(a.sz) })),
      mid: midPrice,
    };

    // FIX Bug #1 & #2: simple push+shift, no modulo confusion
    colBuf.push(snap);
    if (colBuf.length > MAX_COLS) colBuf.shift();

    updatePriceRange(snap);
    dirty = true;
  }

  function onTrades(msg) {
    const trades = msg.trades || [];
    if (!W || !H || midPrice === null) return;

    trades.forEach(t => {
      const price = parseFloat(t.px);
      const size  = parseFloat(t.sz);
      const side  = t.side;

      const y = priceToY(price);
      if (y < 0 || y > H) return;

      const r = Math.min(cfg.maxBubble, Math.max(3, Math.sqrt(size) * 2));
      bubbles.push({ x: W - cfg.colWidth * 2, y, r, side, alpha: 0.85 });
      if (bubbles.length > 500) bubbles.splice(0, bubbles.length - 500);
    });

    dirty = true;
  }

  function updatePriceRange(snap) {
    const allPx = [...snap.bids.map(b => b.px), ...snap.asks.map(a => a.px)];
    if (!allPx.length) return;
    const lo = Math.min(...allPx);
    const hi = Math.max(...allPx);
    if (priceMin === null || lo < priceMin) priceMin = lo;
    if (priceMax === null || hi > priceMax) priceMax = hi;
  }

  function resetState() {
    colBuf.length = 0;
    midPrice = null;
    priceMin = null;
    priceMax = null;
    tickSize = null;
    bubbles.length = 0;
    const priceEl = document.getElementById('bm-price');
    const tickEl  = document.getElementById('ov-tick');
    if (priceEl) priceEl.textContent = '—';
    if (tickEl)  tickEl.textContent  = '—';
  }

  // ── Coordinate helpers ───────────────────────────────────
  function priceToY(price) {
    if (priceMin === null || priceMax === null || priceMax === priceMin) return H / 2;
    const padding = (priceMax - priceMin) * 0.1;
    const lo = priceMin - padding;
    const hi = priceMax + padding;
    return H - ((price - lo) / (hi - lo)) * H;
  }

  // ── Render loop ─────────────────────────────────────────
  function startLoop() {
    function loop() {
      if (dirty) { render(); dirty = false; }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  function render() {
    if (!ctx || !W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const numCols = colBuf.length;
    if (numCols === 0) return;

    const visibleCols = Math.floor(W / cfg.colWidth);

    // Normalize: find max size across visible window
    let maxSz = 0;
    const startIdx = Math.max(0, numCols - visibleCols);
    for (let i = startIdx; i < numCols; i++) {
      const snap = colBuf[i];
      if (!snap) continue;
      snap.bids.forEach(b => { if (b.sz > maxSz) maxSz = b.sz; });
      snap.asks.forEach(a => { if (a.sz > maxSz) maxSz = a.sz; });
    }
    if (maxSz === 0) return;

    // Draw columns left→right, newest on the right
    for (let col = 0; col < visibleCols; col++) {
      const snapIdx = startIdx + col;
      if (snapIdx >= numCols) break;
      const snap = colBuf[snapIdx];
      if (!snap) continue;

      const x = col * cfg.colWidth;

      snap.bids.forEach(b => {
        const y    = priceToY(b.px);
        const norm = b.sz / maxSz;
        ctx.fillStyle = bidColor(norm);
        ctx.fillRect(x, y - cfg.colWidth * 0.5, cfg.colWidth, cfg.colWidth);
      });

      snap.asks.forEach(a => {
        const y    = priceToY(a.px);
        const norm = a.sz / maxSz;
        ctx.fillStyle = askColor(norm);
        ctx.fillRect(x, y - cfg.colWidth * 0.5, cfg.colWidth, cfg.colWidth);
      });
    }

    drawPriceAxis();

    // Mid price line
    if (midPrice !== null) {
      const y = priceToY(midPrice);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(122,162,247,0.8)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trade bubbles
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle   = b.side === 'B' ? `rgba(166,227,161,${b.alpha})` : `rgba(239,83,80,${b.alpha})`;
      ctx.strokeStyle = b.side === 'B' ? 'rgba(166,227,161,0.9)'        : 'rgba(239,83,80,0.9)';
      ctx.lineWidth   = 1;
      ctx.fill();
      ctx.stroke();
      b.alpha -= 0.004;
    }

    if (bubbles.length > 0) dirty = true;
  }

  function drawPriceAxis() {
    if (priceMin === null || priceMax === null) return;
    const padding = (priceMax - priceMin) * 0.1;
    const lo = priceMin - padding;
    const hi = priceMax + padding;
    const range = hi - lo;
    if (range <= 0) return;

    const steps = 8;
    ctx.font      = '10px Inter, monospace';
    ctx.fillStyle = 'rgba(108,112,134,0.8)';
    ctx.textAlign = 'right';

    for (let i = 0; i <= steps; i++) {
      const price = lo + (range / steps) * i;
      const y     = H - (i / steps) * H;
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), W - 6, y + 3);
    }
  }

  // ── Public API ───────────────────────────────────────────
  function onShow()        { resize(); dirty = true; }

  function onConnected() {
    document.getElementById('bm-dot')?.classList.add('live');
    const stEl = document.getElementById('bm-status-text');
    if (stEl) stEl.textContent = 'Live';
    document.getElementById('bm-waiting')?.classList.add('hidden');
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
  }

  function onDisconnected() {
    document.getElementById('bm-dot')?.classList.remove('live');
    const stEl = document.getElementById('bm-status-text');
    if (stEl) stEl.textContent = 'Reconnecting…';
    document.getElementById('bm-waiting')?.classList.remove('hidden');
  }

  function updateCfg(newCfg) {
    Object.assign(cfg, newCfg);
    localStorage.setItem('bm_coin',   cfg.coin);
    localStorage.setItem('bm_levels', cfg.levels);
    localStorage.setItem('bm_speed',  cfg.colWidth);
    resetState();
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
    const badge   = document.getElementById('bm-coin-badge');
    const ovCoin  = document.getElementById('ov-coin');
    const ovLvl   = document.getElementById('ov-levels');
    if (badge)  badge.textContent  = cfg.coin + '-PERP';
    if (ovCoin) ovCoin.textContent = cfg.coin;
    if (ovLvl)  ovLvl.textContent  = cfg.levels;
  }

  document.addEventListener('DOMContentLoaded', init);

  return { onShow, onConnected, onDisconnected, updateCfg, getCfg: () => ({ ...cfg }) };
})();
