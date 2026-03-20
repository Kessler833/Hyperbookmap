/* =============================================================
   HYPERBOOKMAP — Bookmap

   Features:
   - Threshold contrast: slider sets min order size to show.
     Orders above threshold get full colour, below = invisible.
     No single giant order dims the rest.
   - Live area: red top (asks) / green bottom (bids) — same as before
   - Historical area (left of newest-x): desaturated hue-shifted
     colours so history is visually distinct from live
   - Delta column: rightmost column shows bid−ask size delta per
     price level as cyan (bid>ask) or magenta (ask>bid) bars
   - Y-axis drag: drag UP=zoom in, DOWN=zoom out on price range
   - X-axis scroll (mouse wheel in chart area): scroll UP=zoom in
     (fewer columns), scroll DOWN=zoom out (more columns)
   - Timestamps on bottom of chart
   - Auto-fit default: windowHalf fits all live OB levels
   ============================================================= */

window.BookmapPage = (() => {

  // ─ Config ──────────────────────────────────────────────────
  let cfg = {
    coin:      localStorage.getItem('bm_coin')  || 'BTC',
    levels:    500,
    colWidth:  parseInt(localStorage.getItem('bm_speed') || '4'),
    maxBubble: 20,
  };

  // Contrast = absolute size threshold (not relative to max)
  // Stored as fraction of a reference; default 0 = show all
  // UI slider maps 0–100 → 0–maxSz*0.5 dynamically
  let contrastFrac = parseFloat(localStorage.getItem('bm_contrast') || '0.05');

  // ─ Zoom state ───────────────────────────────────────────────
  let windowHalf     = null;  // Y-zoom: price range half
  let windowHalfAuto = null;
  let userZoomY      = false;
  let tickSize       = null;

  // X-zoom: colWidth multiplier (1 = cfg.colWidth, >1 = zoomed out)
  // Wheel UP → xZoom decreases (fewer px per col = zoom IN on time)
  // Wheel DOWN → xZoom increases (more px per col = zoom OUT on time)
  let xZoomMul = 1.0;   // multiplied with cfg.colWidth

  // Axis drag
  let axisDragging    = false;
  let axisDragStartY  = 0;
  let axisDragStartH  = 0;

  let canvas, ctx, wrap;
  let W = 0, H = 0;
  let dirty = false;

  let midPrice = null;

  let bot = {
    running: false,
    bid_quote: null, ask_quote: null,
    inventory: 0, pnl_total: 0,
    spread: 0, sigma: 0,
  };

  const MAX_COLS = 6000;
  const colBuf   = [];   // { mid, bids:[{px,sz}], asks:[{px,sz}], ts }
  const bubbles  = [];
  const latest   = { bids: [], asks: [] };

  const TS_BAR_H = 18;   // px reserved for timestamp bar at bottom

  // ─ Colour helpers ──────────────────────────────────────────────
  // LIVE colours (bright, saturated)
  //   bids (below mid) → green
  //   asks (above mid) → red
  const liveBidColor = n => `rgba(${Math.round(n*40)},${Math.round(100+n*155)},${Math.round(60+n*80)},${(0.15+n*0.85).toFixed(2)})`;
  const liveAskColor = n => `rgba(${Math.round(120+n*135)},${Math.round(n*60)},${Math.round(n*20)},${(0.15+n*0.85).toFixed(2)})`;

  // HISTORICAL colours (muted, shifted hue so clearly distinct)
  //   hist bids → teal-ish blue-green
  //   hist asks → orange-magenta
  const histBidColor = n => `rgba(${Math.round(20+n*40)},${Math.round(80+n*100)},${Math.round(80+n*120)},${(0.12+n*0.6).toFixed(2)})`;
  const histAskColor = n => `rgba(${Math.round(100+n*100)},${Math.round(40+n*60)},${Math.round(60+n*80)},${(0.12+n*0.6).toFixed(2)})`;

  // DELTA colours
  const deltaBidCol = a => `rgba(0,200,200,${a.toFixed(2)})`;
  const deltaAskCol = a => `rgba(200,0,200,${a.toFixed(2)})`;

  // ─ DOM ────────────────────────────────────────────────────────
  function init() {
    const page = document.getElementById('page-bookmap');
    page.innerHTML = `
      <div id="bm-header">
        <span style="color:var(--accent);font-weight:700;letter-spacing:.3px">Hyperbookmap</span>
        <span id="bm-coin-badge">${cfg.coin}-PERP</span>
        <span id="bm-price">—</span>
        <span id="bm-spread"></span>

        <div class="bm-ctl-group">
          <label>Coin</label>
          <input id="bm-coin-input" class="bm-input" type="text"
            value="${cfg.coin}" maxlength="10" placeholder="BTC"
            style="text-transform:uppercase;width:52px">
          <button id="bm-coin-go" class="bm-btn">Go</button>
        </div>

        <div class="bm-ctl-group" title="Threshold: orders below this size are hidden. Prevents one huge order from dimming everything.">
          <label>Threshold</label>
          <input id="bm-contrast" type="range" min="0" max="0.5" step="0.005"
            value="${contrastFrac}" style="width:70px;accent-color:var(--accent)">
          <span id="bm-contrast-val" style="color:var(--text);min-width:28px">${Math.round(contrastFrac*100)}%</span>
        </div>

        <div class="bm-ctl-group">
          <label>Speed</label>
          <select id="bm-speed" class="bm-select">
            <option value="2" ${cfg.colWidth==2?'selected':''}>Dense</option>
            <option value="4" ${cfg.colWidth==4?'selected':''}>Normal</option>
            <option value="6" ${cfg.colWidth==6?'selected':''}>Fast</option>
            <option value="8" ${cfg.colWidth==8?'selected':''}>Faster</option>
          </select>
        </div>

        <div id="bm-bot-badge" class="bot-badge">BOT OFF</div>

        <div id="bm-status">
          <div class="status-dot" id="bm-dot"></div>
          <span id="bm-status-text">Connecting…</span>
        </div>
      </div>

      <div id="bm-body">
        <div id="bm-canvas-wrap">
          <canvas id="bm-canvas"></canvas>

          <div id="bm-axis-drag"></div>
          <div id="bm-zoom-hint">↕ drag<br>to zoom</div>

          <div id="bm-bot-overlay" class="hidden">
            <div class="bov-row"><span class="bov-l">PnL</span>   <span class="bov-v" id="bov-pnl">—</span></div>
            <div class="bov-row"><span class="bov-l">Inv</span>    <span class="bov-v" id="bov-inv">—</span></div>
            <div class="bov-row"><span class="bov-l">Spread</span> <span class="bov-v" id="bov-spread">—</span></div>
            <div class="bov-row"><span class="bov-l">σ</span>      <span class="bov-v" id="bov-sigma">—</span></div>
            <div class="bov-row"><span class="bov-l">Bid</span>    <span class="bov-v bid-col" id="bov-bid">—</span></div>
            <div class="bov-row"><span class="bov-l">Ask</span>    <span class="bov-v ask-col" id="bov-ask">—</span></div>
          </div>

          <div id="bm-overlay">
            Tick: <span id="ov-tick">—</span> &nbsp; Range: ±<span id="ov-range">—</span>
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
    bindAxisDrag();
    bindScrollZoom();

    document.getElementById('bm-contrast').addEventListener('input', e => {
      contrastFrac = parseFloat(e.target.value);
      localStorage.setItem('bm_contrast', contrastFrac);
      document.getElementById('bm-contrast-val').textContent = Math.round(contrastFrac * 100) + '%';
      dirty = true;
    });

    const coinIn = document.getElementById('bm-coin-input');
    const goBtn  = document.getElementById('bm-coin-go');
    coinIn.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
    const applyCoin = () => {
      const c = coinIn.value.trim().toUpperCase() || 'BTC';
      cfg.coin = c;
      localStorage.setItem('bm_coin', c);
      setEl('bm-coin-badge', c + '-PERP');
      resetState();
      BackendWS.send({ type: 'set_coin', coin: c });
    };
    goBtn.addEventListener('click', applyCoin);
    coinIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyCoin(); });

    document.getElementById('bm-speed').addEventListener('change', e => {
      cfg.colWidth = parseInt(e.target.value);
      localStorage.setItem('bm_speed', cfg.colWidth);
      dirty = true;
    });

    BackendWS.on('l2Book',       onBook);
    BackendWS.on('trades',       onTrades);
    BackendWS.on('bot_state',    onBotState);
    BackendWS.on('coin_changed', msg => {
      setEl('bm-coin-badge', msg.coin + '-PERP');
      resetState();
    });
  }

  // ─ Y-axis drag ─────────────────────────────────────────────────
  function bindAxisDrag() {
    const strip = document.getElementById('bm-axis-drag');
    if (!strip) return;
    strip.addEventListener('mousedown', e => {
      e.preventDefault();
      axisDragging   = true;
      axisDragStartY = e.clientY;
      axisDragStartH = windowHalf ?? windowHalfAuto ?? (tickSize ? tickSize * cfg.levels : 500);
      strip.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!axisDragging) return;
      const dy   = e.clientY - axisDragStartY;
      const sens = axisDragStartH / 150;
      const newH = Math.max(tickSize ? tickSize * 5 : 1, axisDragStartH + dy * sens);
      windowHalf = newH;
      userZoomY  = true;
      setEl('ov-range', newH.toFixed(newH > 100 ? 0 : 2));
      dirty = true;
    });
    window.addEventListener('mouseup', () => {
      if (!axisDragging) return;
      axisDragging = false;
      document.getElementById('bm-axis-drag')?.classList.remove('dragging');
    });
    strip.addEventListener('dblclick', () => {
      userZoomY  = false;
      windowHalf = windowHalfAuto;
      dirty      = true;
    });
  }

  // ─ X-axis scroll zoom ───────────────────────────────────────────
  //   wheelUp   → xZoomMul ↓ → narrower cols → more history visible
  //   wheelDown → xZoomMul ↑ → wider  cols → less history (zoom in)
  function bindScrollZoom() {
    if (!wrap) return;
    wrap.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;   // down=out, up=in
      xZoomMul = Math.max(0.2, Math.min(8, xZoomMul * factor));
      dirty = true;
    }, { passive: false });
  }

  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = W; canvas.height = H;
    dirty = true;
  }

  // ─ Auto-fit Y window ──────────────────────────────────────────
  function fitWindow(bids, asks) {
    if (!bids.length || !asks.length || !midPrice) return;
    const lowestBid  = parseFloat(bids[bids.length - 1].px);
    const highestAsk = parseFloat(asks[asks.length - 1].px);
    const half = Math.max(midPrice - lowestBid, highestAsk - midPrice) * 1.05;
    windowHalfAuto = half;
    if (!userZoomY) {
      windowHalf = half;
      setEl('ov-range', half.toFixed(half > 100 ? 0 : 2));
    }
  }

  function py(price) {
    if (midPrice === null || !windowHalf) return H / 2;
    const lo = midPrice - windowHalf;
    const hi = midPrice + windowHalf;
    return (H - TS_BAR_H) - ((price - lo) / (hi - lo)) * (H - TS_BAR_H);
  }

  // ─ Book handler ───────────────────────────────────────────────
  function onBook(msg) {
    const bids = msg.bids || [], asks = msg.asks || [];
    if (!bids.length && !asks.length) return;
    latest.bids = bids; latest.asks = asks;

    if (!tickSize && bids.length >= 2) {
      const t = Math.abs(parseFloat(bids[0].px) - parseFloat(bids[1].px));
      if (t > 0) { tickSize = t; setEl('ov-tick', 'Δ' + tickSize.toFixed(tickSize < 10 ? 2 : 1)); }
    }

    if (bids.length && asks.length) {
      const bb = parseFloat(bids[0].px), ba = parseFloat(asks[0].px);
      midPrice = (bb + ba) / 2;
      setEl('bm-price', midPrice.toFixed(midPrice > 100 ? 1 : 4));
      const se = document.getElementById('bm-spread');
      if (se) se.textContent = 'sprd ' + (ba - bb).toFixed((ba - bb) < 1 ? 4 : 1);
    }

    fitWindow(bids, asks);

    if (midPrice !== null && windowHalf !== null) {
      colBuf.push({
        mid:  midPrice,
        ts:   Date.now(),
        bids: bids.slice(0, cfg.levels).map(b => ({ px: parseFloat(b.px), sz: parseFloat(b.sz) })),
        asks: asks.slice(0, cfg.levels).map(a => ({ px: parseFloat(a.px), sz: parseFloat(a.sz) })),
      });
      if (colBuf.length > MAX_COLS) colBuf.shift();
    }

    updateOrderbook();
    dirty = true;
  }

  function onTrades(msg) {
    if (!W || !H || midPrice === null) return;
    const AXIS_W = 58;
    const nx = Math.floor((W - AXIS_W) * 0.85);
    for (const t of (msg.trades || [])) {
      const y = py(parseFloat(t.px));
      if (y < 0 || y > H - TS_BAR_H) continue;
      const r = Math.min(cfg.maxBubble, Math.max(3, Math.sqrt(parseFloat(t.sz)) * 2));
      bubbles.push({ x: nx, y, r, side: t.side, alpha: 0.9, bot: false });
    }
    if (bubbles.length > 600) bubbles.splice(0, bubbles.length - 600);
    dirty = true;
  }

  // ─ Bot state ──────────────────────────────────────────────────
  function onBotState(msg) {
    bot.running   = msg.running   || false;
    bot.bid_quote = msg.bid_quote ?? null;
    bot.ask_quote = msg.ask_quote ?? null;
    bot.inventory = msg.inventory ?? 0;
    bot.pnl_total = msg.pnl_total ?? 0;
    bot.spread    = msg.spread    ?? 0;
    bot.sigma     = msg.sigma     ?? 0;

    const ov    = document.getElementById('bm-bot-overlay');
    const badge = document.getElementById('bm-bot-badge');
    if (bot.running) {
      ov?.classList.remove('hidden');
      if (badge) { badge.textContent = 'BOT LIVE'; badge.classList.add('live'); }
    } else {
      ov?.classList.add('hidden');
      if (badge) { badge.textContent = 'BOT OFF'; badge.classList.remove('live'); }
    }

    const f = (v, d) => typeof v === 'number' ? v.toFixed(d) : '—';
    const sign = v => (v >= 0 ? '+' : '') + f(v, 2);
    setEl('bov-pnl',    sign(bot.pnl_total) + ' USD');
    setEl('bov-inv',    f(bot.inventory, 6));
    setEl('bov-spread', f(bot.spread, 4));
    setEl('bov-sigma',  f(bot.sigma, 6));
    setEl('bov-bid',    f(bot.bid_quote, midPrice > 100 ? 1 : 4));
    setEl('bov-ask',    f(bot.ask_quote, midPrice > 100 ? 1 : 4));

    if (msg.recent_fills?.length) {
      const AXIS_W = 58;
      const nx = Math.floor((W - AXIS_W) * 0.85);
      for (const fi of msg.recent_fills.slice(0, 2)) {
        if (!fi.price) continue;
        const y = py(fi.price);
        if (y < 0 || y > H - TS_BAR_H) continue;
        bubbles.push({ x: nx, y, r: 12, side: fi.side === 'bid' ? 'B' : 'A', alpha: 1.0, bot: true });
      }
    }
    dirty = true;
  }

  // ─ Orderbook panel ────────────────────────────────────────────
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
    midPrice = null; tickSize = null;
    windowHalf = null; windowHalfAuto = null; userZoomY = false;
    xZoomMul = 1.0;
    latest.bids = []; latest.asks = [];
    setEl('bm-price', '—'); setEl('ov-tick', '—'); setEl('ov-range', '—');
    ['bm-ob-asks','bm-ob-bids'].forEach(id => { const e = document.getElementById(id); if(e) e.innerHTML = ''; });
    setEl('bm-ob-mid', '—');
  }

  // ─ Render loop ───────────────────────────────────────────────
  function startLoop() {
    (function loop() { if (dirty) { render(); dirty = false; } requestAnimationFrame(loop); })();
  }

  // Timestamp formatter
  function fmtTime(ms) {
    const d = new Date(ms);
    return d.getHours().toString().padStart(2,'0') + ':'
         + d.getMinutes().toString().padStart(2,'0') + ':'
         + d.getSeconds().toString().padStart(2,'0');
  }

  function render() {
    if (!ctx || !W || !H) return;
    ctx.clearRect(0, 0, W, H);
    if (!colBuf.length || !windowHalf || midPrice === null) return;

    const AXIS_W   = 58;
    const HEAT_W   = W - AXIS_W;
    const CHART_H  = H - TS_BAR_H;
    const newestX  = Math.floor(HEAT_W * 0.85);   // live line position
    const colPx    = Math.max(1, Math.round(cfg.colWidth * xZoomMul));
    const numCols  = colBuf.length;
    const visCols  = Math.floor(newestX / colPx) + 1;
    const startIdx = Math.max(0, numCols - visCols);

    // Compute max size ONLY among visible columns for threshold
    // Threshold = contrastFrac * p90 size (so outliers don’t squash the rest)
    const allSizes = [];
    for (let i = startIdx; i < numCols; i++) {
      const s = colBuf[i];
      for (const b of s.bids) allSizes.push(b.sz);
      for (const a of s.asks) allSizes.push(a.sz);
    }
    let p90 = 1;
    if (allSizes.length) {
      allSizes.sort((a, b) => a - b);
      p90 = allSizes[Math.floor(allSizes.length * 0.9)] || 1;
    }
    const threshold = contrastFrac * p90;   // absolute size cutoff
    const normRef   = p90;                   // normalise colours to p90

    const rh = Math.max(1, (CHART_H / (windowHalf * 2)) * (tickSize || 1));

    // ─ Grid lines ───────────────────────────────────────────
    ctx.strokeStyle = 'rgba(30,30,50,0.5)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const y = Math.round((i / 10) * CHART_H);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(HEAT_W, y); ctx.stroke();
    }

    // ─ Heatmap columns ──────────────────────────────────────
    for (let col = 0; col < visCols; col++) {
      const si   = startIdx + col;
      if (si >= numCols) break;
      const snap = colBuf[si];
      const x    = newestX - (numCols - 1 - si) * colPx;
      if (x + colPx < 0) continue;

      const isLive = (si === numCols - 1);

      for (const b of snap.bids) {
        if (b.sz < threshold) continue;
        const n = Math.min(1, b.sz / normRef);
        ctx.fillStyle = isLive ? liveBidColor(n) : histBidColor(n);
        ctx.fillRect(x, py(b.px) - rh * 0.5, colPx, rh);
      }
      for (const a of snap.asks) {
        if (a.sz < threshold) continue;
        const n = Math.min(1, a.sz / normRef);
        ctx.fillStyle = isLive ? liveAskColor(n) : histAskColor(n);
        ctx.fillRect(x, py(a.px) - rh * 0.5, colPx, rh);
      }
    }

    // ─ Delta column (rightmost, after newestX) ───────────────
    // For each price level in the live snapshot: delta = bidSz − askSz
    if (numCols > 0) {
      const snap    = colBuf[numCols - 1];
      const deltaX  = newestX + colPx + 2;
      const deltaW  = Math.min(14, AXIS_W - 4);

      // Build map by price level
      const bidMap = new Map();
      for (const b of snap.bids) bidMap.set(b.px, b.sz);
      const askMap = new Map();
      for (const a of snap.asks) askMap.set(a.px, a.sz);

      // All unique prices
      const prices = [...new Set([...bidMap.keys(), ...askMap.keys()])];
      let maxDelta = 0;
      for (const px of prices) {
        const d = Math.abs((bidMap.get(px) || 0) - (askMap.get(px) || 0));
        if (d > maxDelta) maxDelta = d;
      }
      if (maxDelta > 0) {
        for (const px of prices) {
          const bidSz = bidMap.get(px) || 0;
          const askSz = askMap.get(px) || 0;
          const delta = bidSz - askSz;
          if (Math.abs(delta) < threshold) continue;
          const n  = Math.abs(delta) / maxDelta;
          const y  = py(px);
          if (y < 0 || y > CHART_H) continue;
          ctx.fillStyle = delta > 0 ? deltaBidCol(0.3 + n * 0.7) : deltaAskCol(0.3 + n * 0.7);
          ctx.fillRect(deltaX, y - rh * 0.5, deltaW * n, rh);
        }
      }
    }

    // ─ Mid price line ────────────────────────────────────────
    const midY = py(midPrice);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(122,162,247,0.9)';
    ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.moveTo(0, midY); ctx.lineTo(newestX + colPx, midY);
    ctx.stroke(); ctx.setLineDash([]);

    // ─ Bot quote lines ─────────────────────────────────────
    if (bot.running && bot.bid_quote !== null && bot.ask_quote !== null) {
      const bidY = py(bot.bid_quote), askY = py(bot.ask_quote);
      ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.strokeStyle = 'rgba(0,210,180,0.9)';
      ctx.moveTo(0, bidY); ctx.lineTo(newestX + colPx, bidY); ctx.stroke();
      ctx.beginPath(); ctx.strokeStyle = 'rgba(255,120,80,0.9)';
      ctx.moveTo(0, askY); ctx.lineTo(newestX + colPx, askY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '10px Inter,monospace'; ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(0,210,180,1)';
      ctx.fillText('BID ' + bot.bid_quote.toFixed(midPrice > 100 ? 1 : 4), newestX - 4, bidY - 3);
      ctx.fillStyle = 'rgba(255,120,80,1)';
      ctx.fillText('ASK ' + bot.ask_quote.toFixed(midPrice > 100 ? 1 : 4), newestX - 4, askY - 3);
      ctx.textAlign = 'left';
    }

    // ─ Timestamp bar ────────────────────────────────────────
    ctx.fillStyle = 'rgba(13,13,30,0.9)';
    ctx.fillRect(0, CHART_H, HEAT_W, TS_BAR_H);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(30,30,50,0.8)'; ctx.lineWidth = 1;
    ctx.moveTo(0, CHART_H); ctx.lineTo(HEAT_W, CHART_H); ctx.stroke();

    // Draw timestamps every ~120px
    const tsInterval = Math.max(1, Math.round(120 / colPx));
    ctx.font = '9px Inter,monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(108,112,134,0.9)';
    for (let col = 0; col < visCols; col += tsInterval) {
      const si = startIdx + col;
      if (si >= numCols) break;
      const x = newestX - (numCols - 1 - si) * colPx;
      if (x < 30 || x > HEAT_W - 10) continue;
      ctx.fillText(fmtTime(colBuf[si].ts), x, CHART_H + 13);
      // Tick mark
      ctx.beginPath(); ctx.strokeStyle = 'rgba(60,60,80,0.6)';
      ctx.moveTo(x, CHART_H); ctx.lineTo(x, CHART_H + 4); ctx.stroke();
    }

    // ─ Price axis ───────────────────────────────────────────
    ctx.fillStyle = 'rgba(10,10,20,0.8)';
    ctx.fillRect(HEAT_W, 0, AXIS_W, H);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(30,30,50,0.9)'; ctx.lineWidth = 1;
    ctx.moveTo(HEAT_W, 0); ctx.lineTo(HEAT_W, H); ctx.stroke();

    const lo    = midPrice - windowHalf;
    const range = windowHalf * 2;
    ctx.font = '10px Inter,monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 12; i++) {
      const price = lo + (range / 12) * i;
      const y     = CHART_H - (i / 12) * CHART_H;
      ctx.fillStyle = 'rgba(108,112,134,0.9)';
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), HEAT_W + 4, y + 3);
    }
    ctx.fillStyle = 'rgba(122,162,247,1)'; ctx.font = '11px Inter,monospace';
    ctx.fillText(midPrice.toFixed(midPrice > 100 ? 1 : 4), HEAT_W + 4, midY + 4);

    // Axis drag highlight
    if (axisDragging) {
      ctx.fillStyle = 'rgba(122,162,247,0.12)';
      ctx.fillRect(HEAT_W, 0, AXIS_W, CHART_H);
    }

    // ─ Trade bubbles ─────────────────────────────────────────
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      const rgb = b.side === 'B' ? '166,227,161' : '239,83,80';
      ctx.fillStyle   = `rgba(${rgb},${b.alpha.toFixed(2)})`;
      ctx.strokeStyle = `rgba(${rgb},0.9)`;
      ctx.lineWidth   = b.bot ? 2.5 : 1;
      ctx.fill(); ctx.stroke();
      b.alpha -= b.bot ? 0.005 : 0.003;
    }
    if (bubbles.length) dirty = true;
  }

  // ─ Public ────────────────────────────────────────────────────
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

  document.addEventListener('DOMContentLoaded', init);
  return { onShow, onConnected, onDisconnected, getCfg: () => ({ ...cfg }) };
})();
