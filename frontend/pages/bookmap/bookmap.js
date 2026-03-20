/* =============================================================
   HYPERBOOKMAP — Canvas renderer + Live Orderbook panel
   ============================================================= */

window.BookmapPage = (() => {
  let cfg = {
    coin:      localStorage.getItem('bm_coin')            || 'BTC',
    levels:    parseInt(localStorage.getItem('bm_levels') || '80'),   // default 80
    colWidth:  parseInt(localStorage.getItem('bm_speed')  || '4'),
    maxBubble: 20,
  };

  // contrast threshold 0..1 — levels below this fraction of maxSz are hidden
  let contrast = parseFloat(localStorage.getItem('bm_contrast') || '0.05');

  let canvas, ctx, wrap;
  let W = 0, H = 0;
  let dirty = false;

  let midPrice = null;
  let tickSize = null;
  let priceMin = null;
  let priceMax = null;

  const MAX_COLS = 2000;
  const colBuf   = [];
  const bubbles  = [];

  // Latest raw book for the orderbook panel
  let latestBids = [];
  let latestAsks = [];

  // ── Colors ─────────────────────────────────────────────
  function bidColor(norm) {
    const r = Math.round(10  + norm * 30);
    const g = Math.round(30  + norm * 180);
    const b = Math.round(80  + norm * 120);
    return `rgba(${r},${g},${b},${(0.15 + norm * 0.75).toFixed(2)})`;
  }
  function askColor(norm) {
    const r = Math.round(80  + norm * 175);
    const g = Math.round(20  + norm * 60);
    const b = Math.round(20  + norm * 30);
    return `rgba(${r},${g},${b},${(0.15 + norm * 0.75).toFixed(2)})`;
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

    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    resize();
    startLoop();

    // Contrast slider
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

  // ── Data handlers ───────────────────────────────────────
  function onBook(msg) {
    const bids = msg.bids || [];
    const asks = msg.asks || [];
    if (!bids.length && !asks.length) return;

    latestBids = bids;
    latestAsks = asks;

    if (!tickSize && bids.length >= 2) {
      tickSize = Math.abs(parseFloat(bids[0].px) - parseFloat(bids[1].px));
      setEl('ov-tick', tickSize.toFixed(tickSize < 1 ? 4 : 1));
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

    const snap = {
      bids: bids.slice(0, cfg.levels).map(b => ({ px: parseFloat(b.px), sz: parseFloat(b.sz) })),
      asks: asks.slice(0, cfg.levels).map(a => ({ px: parseFloat(a.px), sz: parseFloat(a.sz) })),
    };
    colBuf.push(snap);
    if (colBuf.length > MAX_COLS) colBuf.shift();

    updatePriceRange(snap);
    updateOrderbook();
    dirty = true;
  }

  function onTrades(msg) {
    const trades = msg.trades || [];
    if (!W || !H || midPrice === null) return;
    trades.forEach(t => {
      const price = parseFloat(t.px);
      const size  = parseFloat(t.sz);
      const y = priceToY(price);
      if (y < 0 || y > H) return;
      const r = Math.min(cfg.maxBubble, Math.max(3, Math.sqrt(size) * 2));
      bubbles.push({ x: W - cfg.colWidth * 2, y, r, side: t.side, alpha: 0.85 });
      if (bubbles.length > 500) bubbles.splice(0, bubbles.length - 500);
    });
    dirty = true;
  }

  function updatePriceRange(snap) {
    const allPx = [...snap.bids.map(b => b.px), ...snap.asks.map(a => a.px)];
    if (!allPx.length) return;
    const lo = Math.min(...allPx);
    const hi = Math.max(...allPx);
    // Use a wider adaptive range — only expand, never contract (bookmap-style)
    if (priceMin === null || lo < priceMin) priceMin = lo;
    if (priceMax === null || hi > priceMax) priceMax = hi;
  }

  // ── Orderbook panel renderer ──────────────────────────────
  function updateOrderbook() {
    const asksEl = document.getElementById('bm-ob-asks');
    const bidsEl = document.getElementById('bm-ob-bids');
    const midEl  = document.getElementById('bm-ob-mid');
    if (!asksEl || !bidsEl) return;

    const ROWS = 20;
    const asks = latestAsks.slice(0, ROWS);
    const bids = latestBids.slice(0, ROWS);

    // max size for depth bars
    const allSz = [...asks.map(a => parseFloat(a.sz)), ...bids.map(b => parseFloat(b.sz))];
    const maxSz = allSz.length ? Math.max(...allSz) : 1;

    asksEl.innerHTML = asks.map(a => {
      const sz   = parseFloat(a.sz);
      const pct  = Math.round((sz / maxSz) * 100);
      return `<div class="ob-row ask">
        <div class="ob-bar" style="width:${pct}%"></div>
        <span class="ob-px">${parseFloat(a.px).toFixed(midPrice > 100 ? 1 : 4)}</span>
        <span class="ob-sz">${sz.toFixed(3)}</span>
      </div>`;
    }).join('');

    bidsEl.innerHTML = bids.map(b => {
      const sz  = parseFloat(b.sz);
      const pct = Math.round((sz / maxSz) * 100);
      return `<div class="ob-row bid">
        <div class="ob-bar" style="width:${pct}%"></div>
        <span class="ob-px">${parseFloat(b.px).toFixed(midPrice > 100 ? 1 : 4)}</span>
        <span class="ob-sz">${sz.toFixed(3)}</span>
      </div>`;
    }).join('');

    if (midEl && midPrice !== null)
      midEl.textContent = midPrice.toFixed(midPrice > 100 ? 1 : 4);
  }

  function resetState() {
    colBuf.length = 0;
    bubbles.length = 0;
    midPrice = null; priceMin = null; priceMax = null; tickSize = null;
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

  // ── Coordinate ─────────────────────────────────────────────
  function priceToY(price) {
    if (priceMin === null || priceMax === null || priceMax === priceMin) return H / 2;
    const padding = (priceMax - priceMin) * 0.05; // tighter padding = more levels visible
    const lo = priceMin - padding;
    const hi = priceMax + padding;
    return H - ((price - lo) / (hi - lo)) * H;
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

    const numCols = colBuf.length;
    if (numCols === 0) return;

    const visibleCols = Math.floor(W / cfg.colWidth);
    const startIdx    = Math.max(0, numCols - visibleCols);

    // Normalize across visible window
    let maxSz = 0;
    for (let i = startIdx; i < numCols; i++) {
      const s = colBuf[i];
      s.bids.forEach(b => { if (b.sz > maxSz) maxSz = b.sz; });
      s.asks.forEach(a => { if (a.sz > maxSz) maxSz = a.sz; });
    }
    if (maxSz === 0) return;

    const threshold = contrast * maxSz; // contrast filter cutoff

    for (let col = 0; col < visibleCols; col++) {
      const snapIdx = startIdx + col;
      if (snapIdx >= numCols) break;
      const snap = colBuf[snapIdx];
      const x = col * cfg.colWidth;

      snap.bids.forEach(b => {
        if (b.sz < threshold) return; // contrast filter
        const y    = priceToY(b.px);
        const norm = b.sz / maxSz;
        ctx.fillStyle = bidColor(norm);
        ctx.fillRect(x, y - cfg.colWidth * 0.5, cfg.colWidth, cfg.colWidth);
      });

      snap.asks.forEach(a => {
        if (a.sz < threshold) return; // contrast filter
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
      ctx.lineWidth   = 1;
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
      ctx.fillStyle   = b.side === 'B' ? `rgba(166,227,161,${b.alpha.toFixed(2)})` : `rgba(239,83,80,${b.alpha.toFixed(2)})`;
      ctx.strokeStyle = b.side === 'B' ? 'rgba(166,227,161,0.9)' : 'rgba(239,83,80,0.9)';
      ctx.lineWidth   = 1;
      ctx.fill();
      ctx.stroke();
      b.alpha -= 0.004;
    }
    if (bubbles.length > 0) dirty = true;
  }

  function drawPriceAxis() {
    if (priceMin === null || priceMax === null) return;
    const padding = (priceMax - priceMin) * 0.05;
    const lo = priceMin - padding;
    const hi = priceMax + padding;
    const range = hi - lo;
    if (range <= 0) return;

    const steps = 10;
    ctx.font      = '10px Inter, monospace';
    ctx.fillStyle = 'rgba(108,112,134,0.7)';
    ctx.textAlign = 'right';
    // Draw tick lines
    ctx.strokeStyle = 'rgba(30,30,48,0.6)';
    ctx.lineWidth   = 1;

    for (let i = 0; i <= steps; i++) {
      const price = lo + (range / steps) * i;
      const y     = H - (i / steps) * H;
      // subtle grid line
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), W - 6, y - 2);
    }
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
    resetState();
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
    setEl('bm-coin-badge', cfg.coin + '-PERP');
    setEl('ov-coin',  cfg.coin);
    setEl('ov-levels', cfg.levels);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected, onDisconnected, updateCfg, getCfg: () => ({ ...cfg }) };
})();
