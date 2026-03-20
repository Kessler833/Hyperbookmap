window.ConfigPage = (() => {
  let inited = false;

  function init() {
    if (inited) return;
    const page = document.getElementById('page-config');
    const cur  = window.BookmapPage ? BookmapPage.getCfg() : {
      coin:     localStorage.getItem('bm_coin')      || 'BTC',
      levels:   localStorage.getItem('bm_levels')    || '80',
      colWidth: localStorage.getItem('bm_speed')     || '4',
      nSigFigs: localStorage.getItem('bm_nsigfigs')  || '4',
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
            <label class="cfg-label">Depth Mode (nSigFigs)</label>
            <span class="cfg-hint">Controls tick aggregation and visible price range</span>
            <select id="cfg-nsigfigs" class="cfg-select">
              <option value="2" ${cur.nSigFigs==2?'selected':''}>2 — Ultra Wide&nbsp; (~$1000/tick BTC, ±$50k range)</option>
              <option value="3" ${cur.nSigFigs==3?'selected':''}>3 — Wide&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; (~$100/tick BTC,  ±$5k range)</option>
              <option value="4" ${cur.nSigFigs==4?'selected':''}>4 — Balanced&nbsp;&nbsp; (~$10/tick BTC,   ±$500 range) ✦ recommended</option>
              <option value="5" ${cur.nSigFigs==5?'selected':''}>5 — Precision&nbsp; (~$1/tick BTC,    ±$50 range)</option>
            </select>
            <div id="cfg-depth-info" style="
              margin-top:8px;
              padding:10px 12px;
              background:var(--surface2);
              border:1px solid var(--border);
              border-radius:6px;
              font-size:11px;
              color:var(--muted);
              line-height:1.8;
            ">
              ${depthInfoHtml(cur.nSigFigs)}
            </div>
          </div>

          <div class="cfg-row">
            <label class="cfg-label">Depth Levels</label>
            <span class="cfg-hint">How many levels above/below mid to render (10–200)</span>
            <input id="cfg-levels" class="cfg-input" type="number"
              value="${cur.levels}" min="10" max="200" step="10">
          </div>

          <div class="cfg-row">
            <label class="cfg-label">Scroll Speed (px / column)</label>
            <span class="cfg-hint">Column width in pixels — smaller = denser history</span>
            <select id="cfg-speed" class="cfg-select">
              <option value="2" ${cur.colWidth==2?'selected':''}>2 — Dense</option>
              <option value="4" ${cur.colWidth==4?'selected':''}>4 — Normal</option>
              <option value="6" ${cur.colWidth==6?'selected':''}>6 — Fast</option>
              <option value="8" ${cur.colWidth==8?'selected':''}>8 — Very Fast</option>
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

    document.getElementById('cfg-nsigfigs').addEventListener('change', e => {
      document.getElementById('cfg-depth-info').innerHTML = depthInfoHtml(e.target.value);
    });

    document.getElementById('cfg-save-btn').addEventListener('click', () => {
      const coin     = (document.getElementById('cfg-coin').value.trim().toUpperCase() || 'BTC');
      const levels   = Math.min(200, Math.max(10, parseInt(document.getElementById('cfg-levels').value) || 80));
      const speed    = parseInt(document.getElementById('cfg-speed').value) || 4;
      const nSigFigs = parseInt(document.getElementById('cfg-nsigfigs').value) || 4;

      if (window.BookmapPage) {
        BookmapPage.updateCfg({ coin, levels, colWidth: speed, nSigFigs });
      } else {
        localStorage.setItem('bm_coin',     coin);
        localStorage.setItem('bm_levels',   levels);
        localStorage.setItem('bm_speed',    speed);
        localStorage.setItem('bm_nsigfigs', nSigFigs);
      }

      const msgEl = document.getElementById('cfg-saved-msg');
      if (msgEl) { msgEl.classList.add('show'); setTimeout(() => msgEl.classList.remove('show'), 2000); }
    });

    inited = true;
  }

  function depthInfoHtml(val) {
    const info = {
      2: { tick: '~$1,000', range: '±$50,000', use: 'Macro structure, huge walls only', color: 'var(--purple)' },
      3: { tick: '~$100',   range: '±$5,000',  use: 'Swing levels, daily S/R',         color: 'var(--yellow)' },
      4: { tick: '~$10',    range: '±$500',     use: '<b style="color:var(--green)">Recommended</b> — intraday walls &amp; liquidity clusters', color: 'var(--green)' },
      5: { tick: '~$1',     range: '±$50',      use: 'Scalping, tight spread analysis', color: 'var(--cyan)' },
    };
    const d = info[val] || info[4];
    return `
      Tick size (BTC): <span style="color:${d.color};font-weight:600">${d.tick}</span><br>
      Visible range:  <span style="color:var(--text);font-weight:600">${d.range}</span><br>
      Best for: ${d.use}
    `;
  }

  function onShow() { init(); }
  document.addEventListener('DOMContentLoaded', init);
  return { onShow };
})();
