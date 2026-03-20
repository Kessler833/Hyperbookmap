"""
Hyperbookmap Backend — Single Feed + AS Paper Trading Engine

Message types → frontend:
  l2Book      orderbook snapshot
  trades      trade ticks
  bot_state   AS engine state (quotes, inventory, pnl, fills)
  coin_changed

Messages ← frontend:
  set_coin    change subscribed coin
  set_bot     {action: start|stop|update, gamma, kappa, eta, base_order_size, T_hours}
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, str(Path(__file__).parent.parent))
from core.model import ASModel
from core.inventory import InventoryManager
from core.pnl import PnLState, Fill
from core.paper_executor import PaperExecutor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("hyperbookmap")

HL_WS_URL = "wss://api.hyperliquid.xyz/ws"

# ─ Globals ───────────────────────────────────────────────────────────────
clients:      set[WebSocket] = set()
current_coin: str            = "BTC"
coin_lock = asyncio.Lock()

# Bot config (shared, protected by bot_lock)
bot_cfg: dict = dict(
    running=False,
    gamma=0.1, kappa=1.5, eta=0.005,
    base_order_size=0.001, T_hours=8.0, sigma_window=100,
    tick_interval=1.0,
)
bot_lock = threading.Lock()

# Live objects — created/replaced on each start
_executor: PaperExecutor    | None = None
_pnl:      PnLState         | None = None
_bot_thread: threading.Thread | None = None

# Mid price updated by feed coroutine
_mid_price: float | None = None
_mid_lock = threading.Lock()

# The running asyncio event loop (set in lifespan)
_loop: asyncio.AbstractEventLoop | None = None


# ─ Broadcast ─────────────────────────────────────────────────────────────
async def broadcast(msg: dict):
    dead = set()
    for ws in list(clients):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)


# ─ Bot worker (daemon thread) ─────────────────────────────────────────────
def _bot_worker():
    """
    Runs in a daemon thread.
    Uses asyncio.run_coroutine_threadsafe to push bot_state to frontend.
    The global _loop must be set before this thread starts.
    """
    global _executor, _pnl

    with bot_lock:
        cfg = dict(bot_cfg)

    model    = ASModel(gamma=cfg['gamma'], kappa=cfg['kappa'],
                       sigma_window=cfg['sigma_window'], T_hours=cfg['T_hours'])
    inv_mgr  = InventoryManager(eta=cfg['eta'],
                                base_order_size=cfg['base_order_size'])
    executor = PaperExecutor(base_order_size=cfg['base_order_size'])
    pnl      = PnLState()

    with bot_lock:
        _executor = executor
        _pnl      = pnl

    bid_id:      str   | None = None
    ask_id:      str   | None = None
    one_side_ts: float | None = None
    WAIT = 5.0

    log.info("[bot] AS engine started")

    while True:
        with bot_lock:
            if not bot_cfg['running']:
                break
            cfg = dict(bot_cfg)

        with _mid_lock:
            mid = _mid_price

        if mid is None:
            time.sleep(0.5)
            continue

        now = time.time()
        model.update(mid, now)
        pnl.mid_history.append(mid)
        pnl.equity_curve.append(pnl.total)

        quote = model.quotes(mid, pnl.inventory)
        sized = inv_mgr.size_orders(quote.bid, quote.ask, pnl.inventory)

        # Check fills
        bid_fill = executor.get_fill(bid_id) if bid_id else None
        ask_fill = executor.get_fill(ask_id) if ask_id else None

        if bid_fill:
            pnl.record_fill(Fill('bid', bid_fill[0], bid_fill[1], now,
                                 pnl.inventory + bid_fill[1]))
            executor.cancel(bid_id)
            bid_id = None
            if ask_id and one_side_ts is None:
                one_side_ts = now

        if ask_fill:
            if len(pnl.fills) >= 2 and pnl.fills[-2].side == 'bid':
                sp = ask_fill[0] - pnl.fills[-2].price
                if sp > 0:
                    pnl.spread_captured.append(sp)
            pnl.record_fill(Fill('ask', ask_fill[0], ask_fill[1], now,
                                 pnl.inventory - ask_fill[1]))
            executor.cancel(ask_id)
            ask_id = None
            if bid_id and one_side_ts is None:
                one_side_ts = now

        # Requote
        if bid_id is None and ask_id is None:
            one_side_ts = None
            bid_id = executor.post_bid(sized.bid_price, sized.bid_size)
            ask_id = executor.post_ask(sized.ask_price, sized.ask_size)
        elif one_side_ts and (now - one_side_ts) >= WAIT:
            for oid in [bid_id, ask_id]:
                if oid:
                    executor.cancel(oid)
            bid_id = ask_id = one_side_ts = None
            bid_id = executor.post_bid(sized.bid_price, sized.bid_size)
            ask_id = executor.post_ask(sized.ask_price, sized.ask_size)

        # Broadcast to frontend via the asyncio loop
        state_msg = {
            'type':           'bot_state',
            'running':        True,
            'bid_quote':      round(sized.bid_price, 4),
            'ask_quote':      round(sized.ask_price, 4),
            'bid_size':       sized.bid_size,
            'ask_size':       sized.ask_size,
            'inventory':      round(pnl.inventory,    6),
            'pnl_realized':   round(pnl.realized,     4),
            'pnl_unrealized': round(pnl.unrealized,   4),
            'pnl_total':      round(pnl.total,        4),
            'spread':         round(quote.spread,     4),
            'sigma':          round(quote.sigma,      8),
            'reservation':    round(quote.reservation,4),
            'open_orders':    executor.open_orders(),
            'recent_fills':   executor.recent_fills(10),
        }

        if _loop and not _loop.is_closed():
            asyncio.run_coroutine_threadsafe(broadcast(state_msg), _loop)

        time.sleep(cfg.get('tick_interval', 1.0))

    log.info("[bot] AS engine stopped")
    if _loop and not _loop.is_closed():
        asyncio.run_coroutine_threadsafe(
            broadcast({'type': 'bot_state', 'running': False}), _loop
        )


def _start_bot():
    global _bot_thread
    if _bot_thread and _bot_thread.is_alive():
        log.info("[bot] already running")
        return
    with bot_lock:
        bot_cfg['running'] = True
    _bot_thread = threading.Thread(target=_bot_worker, daemon=True, name="as-engine")
    _bot_thread.start()
    log.info("[bot] thread started")


def _stop_bot():
    with bot_lock:
        bot_cfg['running'] = False
    log.info("[bot] stop signal sent")


# ─ HL Feed ────────────────────────────────────────────────────────────────
async def hl_feed():
    global current_coin, _mid_price

    while True:
        coin = current_coin
        log.info(f"[feed] Connecting: {coin}")
        try:
            async with websockets.connect(HL_WS_URL, ping_interval=20) as ws:
                await ws.send(json.dumps({
                    'method': 'subscribe',
                    'subscription': {'type': 'l2Book', 'coin': coin, 'nSigFigs': 5}
                }))
                await ws.send(json.dumps({
                    'method': 'subscribe',
                    'subscription': {'type': 'trades', 'coin': coin}
                }))
                log.info(f"[feed] Subscribed l2Book+trades for {coin}")

                while True:
                    if current_coin != coin:
                        break
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue

                    data    = json.loads(raw)
                    channel = data.get('channel', '')

                    if channel == 'l2Book':
                        book   = data.get('data', {})
                        levels = book.get('levels', [[], []])
                        bids   = levels[0] if len(levels) > 0 else []
                        asks   = levels[1] if len(levels) > 1 else []

                        if bids and asks:
                            with _mid_lock:
                                _mid_price = (float(bids[0]['px']) + float(asks[0]['px'])) / 2

                        await broadcast({
                            'type': 'l2Book', 'coin': coin,
                            'bids': bids, 'asks': asks,
                            'time': book.get('time', 0),
                        })

                    elif channel == 'trades':
                        trades = data.get('data', [])
                        if trades:
                            with bot_lock:
                                exec_ref = _executor
                            if exec_ref:
                                for t in trades:
                                    try:
                                        exec_ref.notify_trade(
                                            float(t['px']),
                                            t.get('side', 'B'),
                                            float(t['sz']),
                                        )
                                    except Exception:
                                        pass
                            await broadcast({'type': 'trades', 'coin': coin, 'trades': trades})

        except Exception as e:
            log.error(f"[feed] {e}. Reconnecting in 3s...")
            await asyncio.sleep(3)


# ─ FastAPI ───────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app_: FastAPI):
    global _loop
    _loop = asyncio.get_event_loop()     # capture the running loop FIRST
    asyncio.create_task(hl_feed())
    yield


app = FastAPI(title="Hyperbookmap", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['*'],
                   allow_methods=['*'], allow_headers=['*'])


@app.get('/health')
async def health():
    return {'status': 'ok'}


@app.websocket('/ws')
async def frontend_ws(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    log.info(f'[ws] Client connected ({len(clients)} total)')
    try:
        while True:
            raw  = await ws.receive_text()
            data = json.loads(raw)
            t    = data.get('type')

            if t == 'set_coin':
                new_coin = data.get('coin', 'BTC').upper().strip()
                async with coin_lock:
                    global current_coin
                    current_coin = new_coin
                log.info(f'[ws] Coin → {new_coin}')
                await broadcast({'type': 'coin_changed', 'coin': new_coin})

            elif t == 'set_bot':
                action = data.get('action', 'update')
                with bot_lock:
                    for k in ('gamma','kappa','eta','base_order_size','T_hours','sigma_window'):
                        if k in data:
                            bot_cfg[k] = float(data[k])

                if action == 'start':
                    _start_bot()
                elif action == 'stop':
                    _stop_bot()

                with bot_lock:
                    ack = dict(bot_cfg)
                ack['type'] = 'bot_cfg_ack'
                await ws.send_text(json.dumps(ack))

    except WebSocketDisconnect:
        clients.discard(ws)
        log.info(f'[ws] Client disconnected ({len(clients)} total)')
    except Exception as e:
        clients.discard(ws)
        log.error(f'[ws] Error: {e}')


if __name__ == '__main__':
    uvicorn.run('server:app', host='127.0.0.1', port=8765, reload=False)
