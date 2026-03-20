/* =============================================================
   BOT CONFIG + STATS PAGE
   Controls the AS engine: start/stop, parameter sliders,
   live stats, fill log.
   ============================================================= */

window.BotPage = (() => {

  let params = {
    gamma:           parseFloat(localStorage.getItem('bot_gamma')  || '0.1'),
    kappa:           parseFloat(localStorage.getItem('bot_kappa')  || '1.5'),
    eta:             parseFloat(localStorage.getItem('bot_eta')    || '0.005'),
    base_order_size: parseFloat(localStorage.getItem('bot_size')   || '0.001'),
    T_hours:         parseFloat(localStorage.getItem('bot_thours') || '8.0'),
  };

  let running = false;
  const pnlHistory = [];
  const invHistory = [];
  const MAX_H = 300;

  const sliders = [
    { key: 'gamma', label: 'γ (risk aversion)', min: 0.01, max: 1.0,  step: 0.01 },
    { key: 'kappa', label: 'κ (order depth)',   min: 0.1,  max: 10.0, step: 0.1  },
    { key: 'eta',   label: 'η (inv skew)',       min: 0.001,max: 0.1,  step: 0.001 },
    { key: 'base_order_size', label: 'Order size', min: 0.0001, max: 0.1, step: 0.0001 },
    { key: 'T_hours', label: 'Horizon T (h)',   min: 0.5,  max: 24.0, step: 0.5  },
  ];

  function init() {
    const page = document.getElementById('page-bot');
    page.innerHTML = `
      <div id="bot-wrap">
        <div id="bot-controls">
          <h2>AS Bot — Paper Trading</h2>
          <div id="bot-sliders"></div>
          <div id="bot-actions">
            <button id="bot-start" class="btn-primary">▶ Start</button>
            <button id="bot-stop"  class="btn-danger"  disabled>■ Stop</button>
            <button id="bot-reset" class="btn-ghost">↺ Reset Stats</button>
          </div>
          <div id="bot-status-row">
            <span id="bot-status-badge" class="bot-status-off">STOPPED</span>
            <span id="bot-fills-count" style="color:var(--faint);font-size:11px"></span>
          </div>
        </div>

        <div id="bot-stats">
          <div class="stat-card">
            <div class="stat-label">Total PnL</div>
            <div class="stat-value" id="st-pnl">$ —</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Realized</div>
            <div class="stat-value" id="st-realized">$ —</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Unrealized</div>
            <div class="stat-value" id="st-unrealized">$ —</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Inventory</div>
            <div class="stat-value" id="st-inventory">—</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Quoted Spread</div>
            <div class="stat-value" id="st-spread">—</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Volatility σ</div>
            <div class="stat-value" id="st-sigma">—</div>
          </div>
        </div>

        <div id="bot-charts">
          <div class="chart-section">
            <div class="chart-title">PnL over time</div>
            <canvas id="pnl-chart" height="100"></canvas>
          </div>
          <div class="chart-section">
            <div class="chart-title">Inventory over time</div>
            <canvas id="inv-chart" height="100"></canvas>
          </div>
        </div>

        <div id="bot-fills">
          <div class="fills-title">Recent Fills</div>
          <table id="fills-table">
            <thead><tr><th>Side</th><th>Price</th><th>Size</th><th>Time</th></tr></thead>
            <tbody id="fills-body"></tbody>
          </table>
        </div>
      </div>
    `;

    buildSliders();
    bindButtons();
    BackendWS.on('bot_state', onBotState);
  }

  function buildSliders() {
    const container = document.getElementById('bot-sliders');
    container.innerHTML = sliders.map(s => `
      <div class="slider-row">
        <label class="slider-label">${s.label}</label>
        <input type="range" id="sl-${s.key}"
          min="${s.min}" max="${s.max}" step="${s.step}"
          value="${params[s.key]}">
        <input type="number" id="inp-${s.key}"
          min="${s.min}" max="${s.max}" step="${s.step}"
          value="${params[s.key]}" class="slider-num">
      </div>
    `).join('');

    sliders.forEach(s => {
      const sl  = document.getElementById('sl-'  + s.key);
      const inp = document.getElementById('inp-' + s.key);
      sl.addEventListener('input',  () => { params[s.key] = parseFloat(sl.value);  inp.value = sl.value;  saveParam(s.key, sl.value); });
      inp.addEventListener('change', () => { params[s.key] = parseFloat(inp.value); sl.value  = inp.value; saveParam(s.key, inp.value); });
    });
  }

  function saveParam(key, val) {
    const map = { gamma:'bot_gamma', kappa:'bot_kappa', eta:'bot_eta', base_order_size:'bot_size', T_hours:'bot_thours' };
    if (map[key]) localStorage.setItem(map[key], val);
  }

  function bindButtons() {
    document.getElementById('bot-start').addEventListener('click', () => {
      BackendWS.send({ type: 'set_bot', action: 'start', ...params });
    });
    document.getElementById('bot-stop').addEventListener('click', () => {
      BackendWS.send({ type: 'set_bot', action: 'stop' });
    });
    document.getElementById('bot-reset').addEventListener('click', () => {
      BackendWS.send({ type: 'set_bot', action: 'stop' });
      setTimeout(() => BackendWS.send({ type: 'set_bot', action: 'start', ...params }), 300);
    });
  }

  function onBotState(msg) {
    running = msg.running || false;
    const badge = document.getElementById('bot-status-badge');
    const startBtn = document.getElementById('bot-start');
    const stopBtn  = document.getElementById('bot-stop');

    if (badge) {
      badge.textContent = running ? 'RUNNING' : 'STOPPED';
      badge.className = running ? 'bot-status-on' : 'bot-status-off';
    }
    if (startBtn) startBtn.disabled = running;
    if (stopBtn)  stopBtn.disabled  = !running;

    if (!running) return;

    const f2 = v => typeof v === 'number' ? v.toFixed(2) : '—';
    const f4 = v => typeof v === 'number' ? v.toFixed(4) : '—';
    const f6 = v => typeof v === 'number' ? v.toFixed(6) : '—';

    const sign = (v) => (v >= 0 ? '+' : '') + f2(v);
    setEl('st-pnl',       '$ ' + sign(msg.pnl_total));
    setEl('st-realized',  '$ ' + sign(msg.pnl_realized));
    setEl('st-unrealized','$ ' + sign(msg.pnl_unrealized));
    setEl('st-inventory', f6(msg.inventory));
    setEl('st-spread',    f4(msg.spread));
    setEl('st-sigma',     f6(msg.sigma));

    // Colour PnL
    const pnlEl = document.getElementById('st-pnl');
    if (pnlEl) pnlEl.style.color = msg.pnl_total >= 0 ? '#a6e3a1' : '#f38ba8';

    // History
    pnlHistory.push(msg.pnl_total || 0);
    invHistory.push(msg.inventory || 0);
    if (pnlHistory.length > MAX_H) pnlHistory.shift();
    if (invHistory.length > MAX_H) invHistory.shift();

    drawLineChart('pnl-chart', pnlHistory, '#a6e3a1', '#f38ba8');
    drawLineChart('inv-chart',  invHistory, 'rgba(122,162,247,0.8)', 'rgba(122,162,247,0.8)');

    // Fill log
    const fills = msg.recent_fills || [];
    setEl('bot-fills-count', fills.length + ' fills');
    const tbody = document.getElementById('fills-body');
    if (tbody) {
      tbody.innerHTML = fills.map(f => `
        <tr class="fill-${f.side}">
          <td class="${f.side === 'bid' ? 'bid-col' : 'ask-col'}">${f.side.toUpperCase()}</td>
          <td>${f.price?.toFixed(2) ?? '—'}</td>
          <td>${f.size?.toFixed(6) ?? '—'}</td>
          <td>${f.ts ? new Date(f.ts*1000).toLocaleTimeString() : '—'}</td>
        </tr>
      `).join('');
    }
  }

  // ── Mini line chart ───────────────────────────────────────────
  function drawLineChart(canvasId, data, colorPos, colorNeg) {
    const cv = document.getElementById(canvasId);
    if (!cv || data.length < 2) return;
    const cx = cv.getContext('2d');
    const w = cv.offsetWidth || cv.width;
    const h = cv.height;
    cv.width = w;
    cx.clearRect(0,0,w,h);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const xStep = w / (data.length - 1);

    cx.beginPath();
    data.forEach((v,i) => {
      const x = i * xStep;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      i === 0 ? cx.moveTo(x,y) : cx.lineTo(x,y);
    });
    const lastVal = data[data.length-1];
    cx.strokeStyle = lastVal >= 0 ? colorPos : colorNeg;
    cx.lineWidth = 1.5;
    cx.stroke();

    // Zero line if data crosses zero
    if (min < 0 && max > 0) {
      const zy = h - ((0 - min) / range) * (h - 4) - 2;
      cx.beginPath(); cx.strokeStyle = 'rgba(108,112,134,0.4)';
      cx.lineWidth = 1; cx.setLineDash([3,3]);
      cx.moveTo(0,zy); cx.lineTo(w,zy); cx.stroke(); cx.setLineDash([]);
    }
  }

  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  function onShow() {}

  document.addEventListener('DOMContentLoaded', init);
  return { onShow };
})();
