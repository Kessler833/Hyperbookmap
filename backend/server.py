"""
Hyperbookmap Backend — Dual Feed

Two parallel Hyperliquid WebSocket connections per coin:
  FEED_MICRO : nSigFigs=5  — $1/tick,   ±50 range   (precise near mid)
  FEED_WIDE  : nSigFigs=3  — $100/tick, ±5000 range (walls far from mid)

Frontend receives both streams tagged with {feed: 'micro'} or {feed: 'wide'}.
The frontend blends them: micro has priority near mid, wide fills the rest.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("hyperbookmap")

HL_WS_URL = "wss://api.hyperliquid.xyz/ws"

clients: set[WebSocket] = set()
current_coin: str = "BTC"
coin_lock = asyncio.Lock()

FEEDS = {
    "micro": 5,   # nSigFigs=5: tight, precise
    "wide":  3,   # nSigFigs=3: far walls
}


async def broadcast(msg: dict):
    dead = set()
    for ws in list(clients):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)


async def hl_feed(feed_name: str, n_sig_figs: int):
    """One persistent feed connection. Reconnects on coin change or error."""
    global current_coin

    while True:
        coin = current_coin
        log.info(f"[{feed_name}] Connecting: coin={coin} nSigFigs={n_sig_figs}")
        try:
            async with websockets.connect(HL_WS_URL, ping_interval=20) as ws:
                await ws.send(json.dumps({
                    "method": "subscribe",
                    "subscription": {
                        "type": "l2Book",
                        "coin": coin,
                        "nSigFigs": n_sig_figs
                    }
                }))
                # Only micro feed subscribes to trades (avoid duplicate trade events)
                if feed_name == "micro":
                    await ws.send(json.dumps({
                        "method": "subscribe",
                        "subscription": {"type": "trades", "coin": coin}
                    }))

                log.info(f"[{feed_name}] Subscribed l2Book(nSigFigs={n_sig_figs}) for {coin}")

                while True:
                    if current_coin != coin:
                        log.info(f"[{feed_name}] Coin changed, reconnecting...")
                        break

                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue

                    data    = json.loads(raw)
                    channel = data.get("channel", "")

                    if channel == "l2Book":
                        book_data = data.get("data", {})
                        levels    = book_data.get("levels", [[], []])
                        bids      = levels[0] if len(levels) > 0 else []
                        asks      = levels[1] if len(levels) > 1 else []
                        await broadcast({
                            "type":  "l2Book",
                            "feed":  feed_name,   # <-- tagged!
                            "coin":  coin,
                            "bids":  bids,
                            "asks":  asks,
                            "time":  book_data.get("time", 0),
                        })

                    elif channel == "trades" and feed_name == "micro":
                        trades = data.get("data", [])
                        if trades:
                            await broadcast({"type": "trades", "coin": coin, "trades": trades})

        except Exception as e:
            log.error(f"[{feed_name}] Error: {e}. Reconnecting in 3s...")
            await asyncio.sleep(3)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Launch both feeds concurrently
    for feed_name, n_sig_figs in FEEDS.items():
        asyncio.create_task(hl_feed(feed_name, n_sig_figs))
    yield


app = FastAPI(title="Hyperbookmap Backend", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.websocket("/ws")
async def frontend_ws(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    log.info(f"Frontend connected. Clients: {len(clients)}")
    try:
        while True:
            msg  = await ws.receive_text()
            data = json.loads(msg)
            if data.get("type") == "set_coin":
                new_coin = data.get("coin", "BTC").upper().strip()
                async with coin_lock:
                    global current_coin
                    current_coin = new_coin
                log.info(f"Coin set to: {new_coin}")
                await broadcast({"type": "coin_changed", "coin": new_coin})
    except WebSocketDisconnect:
        clients.discard(ws)
        log.info(f"Frontend disconnected. Clients: {len(clients)}")
    except Exception as e:
        clients.discard(ws)
        log.error(f"WS error: {e}")


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)
