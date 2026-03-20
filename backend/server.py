"""
Hyperbookmap Backend
nSigFigs is configurable via frontend message {type: set_coin, coin, nSigFigs}
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
current_sig_figs: int = 4          # default: wide mode
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
    global current_coin, current_sig_figs

    while True:
        coin     = current_coin
        sig_figs = current_sig_figs
        log.info(f"Connecting: coin={coin} nSigFigs={sig_figs}")
        try:
            async with websockets.connect(HL_WS_URL, ping_interval=20) as ws:
                await ws.send(json.dumps({
                    "method": "subscribe",
                    "subscription": {
                        "type": "l2Book",
                        "coin": coin,
                        "nSigFigs": sig_figs
                    }
                }))
                await ws.send(json.dumps({
                    "method": "subscribe",
                    "subscription": {"type": "trades", "coin": coin}
                }))
                log.info(f"Subscribed l2Book(nSigFigs={sig_figs}) + trades for {coin}")

                while True:
                    # Reconnect if coin or sig_figs changed
                    if current_coin != coin or current_sig_figs != sig_figs:
                        log.info("Settings changed, reconnecting...")
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
                            "type":   "l2Book",
                            "coin":   coin,
                            "bids":   bids,
                            "asks":   asks,
                            "time":   book_data.get("time", 0),
                        })

                    elif channel == "trades":
                        trades = data.get("data", [])
                        if trades:
                            await broadcast({"type": "trades", "coin": coin, "trades": trades})

        except Exception as e:
            log.error(f"HL WebSocket error: {e}. Reconnecting in 3s...")
            await asyncio.sleep(3)


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(hl_feed())
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
                new_coin     = data.get("coin", "BTC").upper().strip()
                new_sig_figs = int(data.get("nSigFigs", 4))
                new_sig_figs = max(2, min(5, new_sig_figs))  # clamp 2-5
                async with coin_lock:
                    global current_coin, current_sig_figs
                    current_coin     = new_coin
                    current_sig_figs = new_sig_figs
                log.info(f"Set coin={new_coin} nSigFigs={new_sig_figs}")
                await broadcast({"type": "coin_changed", "coin": new_coin, "nSigFigs": new_sig_figs})
    except WebSocketDisconnect:
        clients.discard(ws)
        log.info(f"Frontend disconnected. Clients: {len(clients)}")
    except Exception as e:
        clients.discard(ws)
        log.error(f"Frontend WS error: {e}")


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)
