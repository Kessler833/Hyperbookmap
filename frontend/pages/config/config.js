window.ConfigPage = (() => {
  let inited = false;

  function init() {
    if (inited) return;
    const page = document.getElementById('page-config');
    const cur  = window.BookmapPage ? BookmapPage.getCfg() : {
      coin:     localStorage.getItem('bm_coin')   || 'BTC',
      levels:   localStorage.getItem('bm_levels') || '80',
      colWidth: localStorage.getItem('bm_speed')  || '4',
    };

    page.innerHTML = `
      <div class="panel-header">
        <span>⚙️</span> Config
      </div>
      <div id="config-body">
        <div>
          <div class="cfg-section-title">Bookmap Settings</div>

          <div class="cfg-row">
            <label class="cfg-label">Coin / Market</label>
            <span class="cfg-hint">Any Hyperliquid perpetual — e.g. BTC, ETH, SOL, HYPE</span>
            <input id="cfg-coin" class="cfg-input" type="text"
              value="${cur.coin}" placeholder="BTC" maxlength="10"
              style="text-transform:uppercase">
          </div>

          <div class="cfg-row">
            <label class="cfg-label">Depth Levels</label>
            <span class="cfg-hint">Price levels above/below mid (10–200). Higher = wider price range visible.</span>
            <input id="cfg-levels" class="cfg-input" type="number"
              value="${cur.levels}" min="10" max="200" step="10">
          </div>

          <div class="cfg-row">
            <label class="cfg-label">Scroll Speed (px / column)</label>
            <span class="cfg-hint">Column width in pixels — smaller = denser history</span>
            <select id="cfg-speed" class="cfg-select">
              <option value="2"  ${cur.colWidth==2?'selected':''}>2 — Dense</option>
              <option value="4"  ${cur.colWidth==4?'selected':''}>4 — Normal</option>
              <option value="6"  ${cur.colWidth==6?'selected':''}>6 — Fast</option>
              <option value="8"  ${cur.colWidth==8?'selected':''}>8 — Very Fast</option>
            </select>
          </div>

          <button id="cfg-save-btn" class="btn btn-primary">Apply &amp; Save</button>
          <span id="cfg-saved-msg">✓ Applied!</span>
        </div>

        <div>
          <div class="cfg-section-title">Backend</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.9">
            Start the Python backend before launching:<br>
            <code style="color:var(--accent);font-size:11px">cd backend &amp;&amp; python server.py</code><br><br>
            WebSocket: <code style="color:var(--cyan)">ws://127.0.0.1:8765/ws</code><br>
            No API key needed — Hyperliquid public feed.
          </div>
        </div>
      </div>
    `;

    document.getElementById('cfg-coin').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase();
    });

    document.getElementById('cfg-save-btn').addEventListener('click', () => {
      const coin   = (document.getElementById('cfg-coin').value.trim().toUpperCase() || 'BTC');
      const levels = Math.min(200, Math.max(10, parseInt(document.getElementById('cfg-levels').value) || 80));
      const speed  = parseInt(document.getElementById('cfg-speed').value) || 4;
      if (window.BookmapPage) {
        BookmapPage.updateCfg({ coin, levels, colWidth: speed });
      } else {
        localStorage.setItem('bm_coin',   coin);
        localStorage.setItem('bm_levels', levels);
        localStorage.setItem('bm_speed',  speed);
      }
      const msgEl = document.getElementById('cfg-saved-msg');
      if (msgEl) { msgEl.classList.add('show'); setTimeout(() => msgEl.classList.remove('show'), 2000); }
    });

    inited = true;
  }

  function onShow() { init(); }
  document.addEventListener('DOMContentLoaded', init);
  return { onShow };
})();
