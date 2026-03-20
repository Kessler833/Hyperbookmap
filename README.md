# Hyperbookmap

Hyperliquid real-time Bookmap — Liquidity Heatmap, Trade Bubbles & Live Price.

## Stack
- **Frontend**: Electron + Vanilla JS + Canvas
- **Backend**: Python (FastAPI + WebSocket bridge to Hyperliquid)

## Setup

### 1. Backend
```bash
cd backend
pip install -r requirements.txt
python server.py
```

### 2. Frontend (Electron)
```bash
npm install
npm start
```

## Usage
1. Start the Python backend first (`python backend/server.py`)
2. Launch Electron: `npm start`
3. Go to **Config** → enter your coin (e.g. `BTC`, `ETH`, `SOL`)
4. Go to **Bookmap** — heatmap starts immediately

## Features
- 🌡️ Liquidity Heatmap (bid/ask depth over time via Canvas)
- 🔴🟢 Trade Bubbles (aggressor side colored, size = bubble radius)
- 📈 Live mid-price dashed line
- ⚙️ Configurable coin, depth levels, scroll speed

## Notes
- No API key needed — uses Hyperliquid public WebSocket
- Backend runs on `ws://127.0.0.1:8765/ws`
