/* =============================================================
   HYPERBOOKMAP — Single Feed + AS Bot Overlay

   - Single l2Book feed (nSigFigs=5)
   - windowHalf = microTickSize * cfg.levels  (always from feed tick)
   - Bot quote lines (bid=blue, ask=red) drawn on canvas
   - Stats overlay: inventory, pnl, spread, sigma
   - Fill bubbles: normal=trade, large=bot fill
   ============================================================= */

window.BookmapPage = (() => {

  let cfg = {
    coin:      localStorage.getItem('bm_coin')    || 'BTC',
    levels:    parseInt(localStorage.getItem('bm_levels') || '60'),
    colWidth:  parseInt(localStorage.getItem('bm_speed')  || '4'),
    maxBubble: 20,
  };

  let contrast = parseFloat(localStorage.getItem('bm_contrast') || '0.05');

  let canvas, ctx, wrap;
  let W = 0, H = 0;
  let dirty = false;

  let midPrice  = null;
  let tickSize  = null;
  let windowHalf = null;

  // Bot state
  let bot = {
    running: false,
    bid_quote: null, ask_quote: null,
    bid_size: 0, ask_size: 0,
    inventory: 0, pnl_total: 0, pnl_realized: 0,
    spread: 0, sigma: 0,
    open_orders: [], recent_fills: [],
  };

  const MAX_COLS = 3000;
  const colBuf  = [];
  const bubbles = [];
  const latest  = { bids: [], asks: [] };

  // PnL history for mini chart in stats
  const pnlHistory = [];
  const MAX_PNL_HIST = 500;

  // ── Colors ───────────────────────────────────────────────────
  const bidColor = n => `rgba(${Math.round(n*40)},${Math.round(n*200)},${Math.round(60+n*150)},${(0.1+n*0.9).toFixed(2)})`;
  const askColor = n => `rgba(${Math.round(60+n*195)},${Math.round(n*80)},${Math.round(n*20)},${(0.1+n*0.9).toFixed(2)})`;

  // ── DOM ──────────────────────────────────────────────────────
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
        <div id="bm-bot-badge" class="bot-badge" id="bm-bot-badge">BOT OFF</div>
        <div id="bm-status">
          <div class="status-dot" id="bm-dot"></div>
          <span id="bm-status-text">Connecting…</span>
        </div>
      </div>

      <div id="bm-body">
        <div id="bm-canvas-wrap">
          <canvas id="bm-canvas"></canvas>

          <!-- Bot stats overlay (top-right) -->
          <div id="bm-bot-overlay" class="hidden">
            <div class="bov-row"><span class="bov-l">PnL</span><span class="bov-v" id="bov-pnl">—</span></div>
            <div class="bov-row"><span class="bov-l">Inventory</span><span class="bov-v" id="bov-inv">—</span></div>
            <div class="bov-row"><span class="bov-l">Spread</span><span class="bov-v" id="bov-spread">—</span></div>
            <div class="bov-row"><span class="bov-l">σ</span><span class="bov-v" id="bov-sigma">—</span></div>
            <div class="bov-row"><span class="bov-l">Bid Q</span><span class="bov-v bid-col" id="bov-bid">—</span></div>
            <div class="bov-row"><span class="bov-l">Ask Q</span><span class="bov-v ask-col" id="bov-ask">—</span></div>
          </div>

          <div id="bm-overlay">
            Range: ±<span id="ov-range">—</span> &nbsp;
            Tick: <span id="ov-tick">—</span> &nbsp;
            Levels: <span id="ov-levels">${cfg.levels}</span>
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

    BackendWS.on('l2Book',     onBook);
    BackendWS.on('trades',     onTrades);
    BackendWS.on('bot_state',  onBotState);
    BackendWS.on('coin_changed', msg => {
      setEl('bm-coin-badge', msg.coin + '-PERP');
      resetState();
    });
  }

  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = W; canvas.height = H;
    dirty = true;
  }

  // ── Window ────────────────────────────────────────────────────
  function computeWindow() {
    if (!tickSize) return;
    windowHalf = tickSize * cfg.levels;
    setEl('ov-range',  windowHalf.toFixed(windowHalf > 100 ? 0 : 2));
    setEl('ov-tick',   'Δ' + tickSize.toFixed(tickSize < 10 ? 2 : 1));
    setEl('ov-levels', cfg.levels);
  }

  function py(price) {
    if (midPrice === null || !windowHalf) return H / 2;
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    return H - ((price - lo) / (hi - lo)) * H;
  }

  // ── Book handler ─────────────────────────────────────────────
  function onBook(msg) {
    const bids = msg.bids || [], asks = msg.asks || [];
    if (!bids.length && !asks.length) return;
    latest.bids = bids; latest.asks = asks;

    // Detect tick once
    if (!tickSize && bids.length >= 2) {
      const t = Math.abs(parseFloat(bids[0].px) - parseFloat(bids[1].px));
      if (t > 0) { tickSize = t; computeWindow(); }
    }

    // Mid
    if (bids.length && asks.length) {
      const bb = parseFloat(bids[0].px), ba = parseFloat(asks[0].px);
      midPrice = (bb + ba) / 2;
      const spread = ba - bb;
      setEl('bm-price', midPrice.toFixed(midPrice > 100 ? 1 : 4));
      const se = document.getElementById('bm-spread');
      if (se) se.textContent = 'sprd ' + spread.toFixed(spread < 1 ? 4 : 1);
    }

    // Push column
    if (midPrice !== null && windowHalf !== null) {
      const snap = {
        mid:  midPrice,
        bids: bids.slice(0, cfg.levels).map(b => ({ px: parseFloat(b.px), sz: parseFloat(b.sz) })),
        asks: asks.slice(0, cfg.levels).map(a => ({ px: parseFloat(a.px), sz: parseFloat(a.sz) })),
      };
      colBuf.push(snap);
      if (colBuf.length > MAX_COLS) colBuf.shift();
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
      bubbles.push({ x: newestX, y, r, side: t.side, alpha: 0.9, bot: false });
    }
    if (bubbles.length > 600) bubbles.splice(0, bubbles.length - 600);
    dirty = true;
  }

  // ── Bot state handler ─────────────────────────────────────────
  function onBotState(msg) {
    bot.running     = msg.running || false;
    bot.bid_quote   = msg.bid_quote   ?? null;
    bot.ask_quote   = msg.ask_quote   ?? null;
    bot.bid_size    = msg.bid_size    ?? 0;
    bot.ask_size    = msg.ask_size    ?? 0;
    bot.inventory   = msg.inventory   ?? 0;
    bot.pnl_total   = msg.pnl_total   ?? 0;
    bot.pnl_realized = msg.pnl_realized ?? 0;
    bot.spread      = msg.spread      ?? 0;
    bot.sigma       = msg.sigma       ?? 0;
    bot.open_orders  = msg.open_orders  || [];
    bot.recent_fills = msg.recent_fills || [];

    // PnL history
    pnlHistory.push(bot.pnl_total);
    if (pnlHistory.length > MAX_PNL_HIST) pnlHistory.shift();

    // Update overlay
    const ov = document.getElementById('bm-bot-overlay');
    const badge = document.getElementById('bm-bot-badge');
    if (bot.running) {
      ov?.classList.remove('hidden');
      if (badge) { badge.textContent = 'BOT LIVE'; badge.classList.add('live'); }
    } else {
      ov?.classList.add('hidden');
      if (badge) { badge.textContent = 'BOT OFF'; badge.classList.remove('live'); }
    }

    const fmt = (v, d=4) => v?.toFixed(d) ?? '—';
    const pnlSign = bot.pnl_total >= 0 ? '+' : '';
    setEl('bov-pnl',    pnlSign + fmt(bot.pnl_total, 2) + ' USD');
    setEl('bov-inv',    fmt(bot.inventory, 6) + ' ' + (cfg.coin || 'BTC'));
    setEl('bov-spread', fmt(bot.spread, 4));
    setEl('bov-sigma',  fmt(bot.sigma, 6));
    setEl('bov-bid',    fmt(bot.bid_quote, midPrice > 100 ? 1 : 4));
    setEl('bov-ask',    fmt(bot.ask_quote, midPrice > 100 ? 1 : 4));

    // Bot fill bubbles at their quote price
    if (msg.recent_fills?.length) {
      const newestX = Math.floor((W - 58) * 0.85);
      for (const f of msg.recent_fills.slice(0, 3)) {
        if (!f.price) continue;
        const y = py(f.price);
        if (y < 0 || y > H) continue;
        bubbles.push({
          x: newestX, y, r: 10,
          side: f.side === 'bid' ? 'B' : 'A',
          alpha: 1.0, bot: true,
        });
      }
    }

    dirty = true;
  }

  // ── Orderbook panel ───────────────────────────────────────────
  function updateOrderbook() {
    const asksEl = document.getElementById('bm-ob-asks');
    const bidsEl = document.getElementById('bm-ob-bids');
    const midEl  = document.getElementById('bm-ob-mid');
    if (!asksEl || !bidsEl) return;
    const asks = latest.asks.slice(0, 20);
    const bids = latest.bids.slice(0, 20);
    if (!asks.length && !bids.length) return;
    const maxSz = Math.max(...[...asks, ...bids].map(x => parseFloat(x.sz)), 1);
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
    midPrice = null; tickSize = null; windowHalf = null;
    latest.bids = []; latest.asks = [];
    setEl('bm-price', '—'); setEl('ov-range', '—'); setEl('ov-tick', '—');
    ['bm-ob-asks','bm-ob-bids'].forEach(id => { const e = document.getElementById(id); if(e) e.innerHTML=''; });
    setEl('bm-ob-mid', '—');
  }

  // ── Render loop ───────────────────────────────────────────────
  function startLoop() {
    (function loop() { if (dirty) { render(); dirty = false; } requestAnimationFrame(loop); })();
  }

  function render() {
    if (!ctx || !W || !H) return;
    ctx.clearRect(0, 0, W, H);
    if (!colBuf.length || !windowHalf || midPrice === null) return;

    const AXIS_W  = 58;
    const HEAT_W  = W - AXIS_W;
    const newestX = Math.floor(HEAT_W * 0.85);
    const numCols = colBuf.length;
    const visCols = Math.floor(newestX / cfg.colWidth) + 1;
    const startIdx = Math.max(0, numCols - visCols);

    // Normalise
    let maxSz = 0;
    for (let i = startIdx; i < numCols; i++) {
      const s = colBuf[i];
      for (const b of s.bids) b.sz > maxSz && (maxSz = b.sz);
      for (const a of s.asks) a.sz > maxSz && (maxSz = a.sz);
    }
    if (!maxSz) maxSz = 1;
    const thr = contrast * maxSz;
    const rh  = Math.max(1, (H / (windowHalf * 2)) * (tickSize || 1));

    // Grid
    ctx.strokeStyle = 'rgba(30,30,50,0.5)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const y = Math.round((i/10)*H);
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(HEAT_W,y); ctx.stroke();
    }

    // Heatmap columns
    for (let col = 0; col < visCols; col++) {
      const si = startIdx + col;
      if (si >= numCols) break;
      const snap = colBuf[si];
      const x = newestX - (numCols - 1 - si) * cfg.colWidth;
      if (x + cfg.colWidth < 0) continue;
      for (const b of snap.bids) {
        if (b.sz < thr) continue;
        ctx.fillStyle = bidColor(b.sz / maxSz);
        ctx.fillRect(x, py(b.px) - rh*0.5, cfg.colWidth, rh);
      }
      for (const a of snap.asks) {
        if (a.sz < thr) continue;
        ctx.fillStyle = askColor(a.sz / maxSz);
        ctx.fillRect(x, py(a.px) - rh*0.5, cfg.colWidth, rh);
      }
    }

    // Mid line
    const midY = py(midPrice);
    ctx.beginPath(); ctx.strokeStyle='rgba(122,162,247,0.9)';
    ctx.lineWidth=1; ctx.setLineDash([4,4]);
    ctx.moveTo(0,midY); ctx.lineTo(newestX+cfg.colWidth,midY);
    ctx.stroke(); ctx.setLineDash([]);

    // ── Bot quote lines ──────────────────────────────────────────
    if (bot.running && bot.bid_quote !== null) {
      const bidY = py(bot.bid_quote);
      const askY = py(bot.ask_quote);

      // Bid line (cyan)
      ctx.beginPath(); ctx.strokeStyle='rgba(0,210,180,0.85)';
      ctx.lineWidth=1.5; ctx.setLineDash([6,3]);
      ctx.moveTo(0, bidY); ctx.lineTo(newestX+cfg.colWidth, bidY); ctx.stroke();

      // Ask line (orange-red)
      ctx.beginPath(); ctx.strokeStyle='rgba(255,120,80,0.85)';
      ctx.moveTo(0, askY); ctx.lineTo(newestX+cfg.colWidth, askY); ctx.stroke();
      ctx.setLineDash([]);

      // Labels
      ctx.font = '10px Inter, monospace'; ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(0,210,180,1)';
      ctx.fillText('BID ' + bot.bid_quote.toFixed(midPrice > 100 ? 1 : 4), newestX-4, bidY-3);
      ctx.fillStyle = 'rgba(255,120,80,1)';
      ctx.fillText('ASK ' + bot.ask_quote.toFixed(midPrice > 100 ? 1 : 4), newestX-4, askY-3);
      ctx.textAlign = 'left';
    }

    // Price axis
    ctx.fillStyle = 'rgba(10,10,20,0.7)';
    ctx.fillRect(HEAT_W, 0, AXIS_W, H);
    ctx.beginPath(); ctx.strokeStyle='rgba(30,30,50,0.8)'; ctx.lineWidth=1;
    ctx.moveTo(HEAT_W,0); ctx.lineTo(HEAT_W,H); ctx.stroke();

    const lo    = midPrice - windowHalf;
    const range = windowHalf * 2;
    ctx.font = '10px Inter, monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 12; i++) {
      const price = lo + (range/12)*i;
      const y     = H - (i/12)*H;
      ctx.fillStyle = 'rgba(108,112,134,0.9)';
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), HEAT_W+4, y+3);
    }
    ctx.fillStyle='rgba(122,162,247,1)'; ctx.font='11px Inter, monospace';
    ctx.fillText(midPrice.toFixed(midPrice > 100 ? 1 : 4), HEAT_W+4, midY+4);

    // Bubbles
    for (let i = bubbles.length-1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i,1); continue; }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
      const base = b.side==='B' ? '166,227,161' : '239,83,80';
      ctx.fillStyle   = `rgba(${base},${b.alpha.toFixed(2)})`;
      ctx.strokeStyle = `rgba(${base},0.9)`;
      ctx.lineWidth = b.bot ? 2.5 : 1;
      ctx.fill(); ctx.stroke();
      b.alpha -= b.bot ? 0.006 : 0.003;
    }
    if (bubbles.length) dirty = true;
  }

  // ── Public ────────────────────────────────────────────────────
  function onShow()  { resize(); dirty = true; }

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
    computeWindow();
    resetState();
    BackendWS.send({ type: 'set_coin', coin: cfg.coin });
    setEl('bm-coin-badge', cfg.coin + '-PERP');
  }

  function getBotState() { return { ...bot }; }

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected, onDisconnected, updateCfg, getCfg: () => ({...cfg}), getBotState };
})();
