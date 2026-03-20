# Hyperbookmap — AS Market Making on Hyperliquid

Lightweight Electron + FastAPI app combining a live Hyperliquid orderbook heatmap
with an Avellaneda-Stoikov paper-trading engine.

## Quick Start

```bash
# 1. Install Python deps
pip install -r requirements.txt

# 2. Install Node deps
npm install

# 3. Start backend
python backend/server.py

# 4. Start Electron (in a second terminal)
npm start
```

## Tabs

| Tab | What it does |
|-----|--------------|
| 🌡️ Bookmap | Live HL orderbook heatmap. When bot is running, shows **cyan bid line** and **orange ask line** for current AS quotes. Bot fill bubbles appear as larger circles. |
| 🤖 AS Bot  | Start/stop the Avellaneda-Stoikov paper engine. Tune γ, κ, η, order size, horizon. Live PnL/inventory charts + fill log. |
| ⚙️ Config  | Change coin/market and bookmap display settings. |

## AS Model

The **Avellaneda-Stoikov** model computes optimal bid/ask quotes:

```
Reservation price:  r = mid − q · γ · σ² · (T − t)
Optimal spread:     δ = γ · σ² · (T−t) + (2/γ) · ln(1 + γ/κ)
Bid quote:          b = r − δ/2
Ask quote:          a = r + δ/2
```

### Parameters

| Param | Default | Effect |
|-------|---------|--------|
| γ (gamma) | 0.1 | Risk aversion — higher = tighter spread, faster rebalance |
| κ (kappa) | 1.5 | Order book depth — higher = tighter spread |
| η (eta)   | 0.005 | Inventory skew — higher = stronger size reduction on heavy side |
| Order size | 0.001 BTC | Base fill size |
| T horizon  | 8h | Rolling window for time-decay term |

### Paper Fill Logic

Fills are simulated against the **live Hyperliquid trade feed**:
- Bid filled when a sell trade crosses at or below our bid quote
- Ask filled when a buy trade crosses at or above our ask quote

No API key needed — entirely paper/simulated.

## Architecture

```
backend/server.py      FastAPI + WS server
  ├─ hl_feed()         Hyperliquid WS (l2Book + trades)
  ├─ _bot_worker()     AS engine thread (ticks every 1s)
  └─ PaperExecutor     Simulates fills against live trades

core/
  ├─ model.py          Avellaneda-Stoikov equations
  ├─ inventory.py      Exponential size skew
  ├─ pnl.py            PnL tracker
  └─ paper_executor.py Fill simulation

frontend/
  ├─ pages/bookmap/    Canvas heatmap + bot overlays
  ├─ pages/bot/        Controls + stats + charts
  └─ pages/config/     Market + display settings
```
