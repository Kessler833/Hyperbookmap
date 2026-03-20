"""
Hyperbookmap Backend
- Connects to Hyperliquid public WebSocket
- Bridges l2Book snapshots + trades to the Electron frontend
- Serves via FastAPI WebSocket on ws://localhost:8765

Depth notes:
  Hyperliquid l2Book subscription supports `nSigFigs` parameter:
    nSigFigs=2 -> very aggregated (~5 levels)
    nSigFigs=3 -> ~20 levels (default if omitted)
    nSigFigs=4 -> ~50 levels
    nSigFigs=5 -> maximum raw depth (~100 levels per side)
  We use nSigFigs=5 for maximum depth.
  Real tick-level granularity depends on the market.
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


async def broadcast(msg: dict):
    dead = set()
    for ws in list(clients):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)


async def hl_feed():
    global current_coin

    while True:
        coin = current_coin
        log.info(f"Connecting to Hyperliquid for coin: {coin}")
        try:
            async with websockets.connect(HL_WS_URL, ping_interval=20) as ws:

                # nSigFigs=5 = maximum depth (~100 levels per side)
                await ws.send(json.dumps({
                    "method": "subscribe",
                    "subscription": {
                        "type": "l2Book",
                        "coin": coin,
                        "nSigFigs": 5
                    }
                }))
                await ws.send(json.dumps({
                    "method": "subscribe",
                    "subscription": {"type": "trades", "coin": coin}
                }))

                log.info(f"Subscribed l2Book (nSigFigs=5) + trades for {coin}")

                while True:
                    if current_coin != coin:
                        log.info(f"Coin changed to {current_coin}, reconnecting...")
                        break

                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue

                    data = json.loads(raw)
                    channel = data.get("channel", "")

                    if channel == "l2Book":
                        book_data = data.get("data", {})
                        levels = book_data.get("levels", [[], []])
                        bids = levels[0] if len(levels) > 0 else []
                        asks = levels[1] if len(levels) > 1 else []
                        log.debug(f"l2Book: {len(bids)} bids, {len(asks)} asks")

                        await broadcast({
                            "type": "l2Book",
                            "coin": coin,
                            "bids": bids,
                            "asks": asks,
                            "time": book_data.get("time", 0),
                        })

                    elif channel == "trades":
                        trades = data.get("data", [])
                        if trades:
                            await broadcast({
                                "type": "trades",
                                "coin": coin,
                                "trades": trades,
                            })

        except Exception as e:
            log.error(f"HL WebSocket error: {e}. Reconnecting in 3s...")
            await asyncio.sleep(3)


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(hl_feed())
    yield


app = FastAPI(title="Hyperbookmap Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws")
async def frontend_ws(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    log.info(f"Frontend connected. Total clients: {len(clients)}")
    try:
        while True:
            msg = await ws.receive_text()
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
        log.info(f"Frontend disconnected. Total clients: {len(clients)}")
    except Exception as e:
        clients.discard(ws)
        log.error(f"Frontend WS error: {e}")


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)
