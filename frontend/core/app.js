// ─ Router ─────────────────────────────────────────────────────────────
const pages = ['bookmap', 'bot'];

function showPage(name) {
  pages.forEach(p => {
    document.getElementById('page-' + p)?.classList.toggle('active', p === name);
    document.querySelector('.nav-item[data-page="' + p + '"]')?.classList.toggle('active', p === name);
  });
  if (name === 'bookmap' && window.BookmapPage) BookmapPage.onShow();
  if (name === 'bot'     && window.BotPage)     BotPage.onShow();
}

document.querySelectorAll('.nav-item[data-page]').forEach(el => {
  el.addEventListener('click', () => showPage(el.dataset.page));
});

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

// ─ WebSocket ────────────────────────────────────────────────────────────
const WS_URL = 'ws://127.0.0.1:8765/ws';
let _ws = null;
let _reconnectTimer = null;

window.BackendWS = {
  handlers: {},
  on(type, fn)  { this.handlers[type] = fn; },
  send(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN)
      _ws.send(JSON.stringify(obj));
  }
};

function connectBackend() {
  _ws = new WebSocket(WS_URL);
  _ws.onopen    = () => { if (window.BookmapPage) BookmapPage.onConnected(); };
  _ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      const h   = BackendWS.handlers[msg.type];
      if (h) h(msg);
    } catch(e) { /* ignore */ }
  };
  _ws.onclose   = () => {
    if (window.BookmapPage) BookmapPage.onDisconnected();
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connectBackend, 2000);
  };
  _ws.onerror   = () => _ws.close();
}

document.addEventListener('DOMContentLoaded', () => {
  showPage('bookmap');
  connectBackend();
});
