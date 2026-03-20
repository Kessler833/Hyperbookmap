"""
core/paper_executor.py — Simulated fills against the live Hyperliquid feed.

Fill logic (realistic):
  BID filled  when a SELL trade crosses at or below our bid price.
  ASK filled  when a BUY  trade crosses at or above our ask price.

No Binance Testnet needed — we use real HL trade flow as fill triggers.
"""
from __future__ import annotations
import threading
import time
import uuid
from typing import Dict, Optional, Tuple


class PaperExecutor:
    """
    Thread-safe paper executor.
    The AS engine calls post_bid / post_ask / cancel / get_fill.
    The backend feed calls notify_trade() on every incoming HL trade.
    """

    def __init__(self, base_order_size: float = 0.001):
        self.base_order_size = base_order_size
        self._lock = threading.Lock()
        # order_id -> {side, price, size, filled_price, filled_qty, ts}
        self._orders: Dict[str, dict] = {}

    # ── Engine interface ──────────────────────────────────────────────────

    def post_bid(self, price: float, size: float) -> str:
        oid = str(uuid.uuid4())[:8]
        with self._lock:
            self._orders[oid] = dict(side='bid', price=price, size=size,
                                     filled_price=None, filled_qty=None, ts=time.time())
        return oid

    def post_ask(self, price: float, size: float) -> str:
        oid = str(uuid.uuid4())[:8]
        with self._lock:
            self._orders[oid] = dict(side='ask', price=price, size=size,
                                     filled_price=None, filled_qty=None, ts=time.time())
        return oid

    def cancel(self, order_id: str):
        with self._lock:
            self._orders.pop(order_id, None)

    def get_fill(self, order_id: str) -> Optional[Tuple[float, float]]:
        with self._lock:
            o = self._orders.get(order_id)
            if o and o['filled_price'] is not None:
                return (o['filled_price'], o['filled_qty'])
        return None

    # ── Feed interface ────────────────────────────────────────────────────

    def notify_trade(self, trade_px: float, trade_side: str, trade_qty: float):
        """
        Called by backend on every incoming HL trade.
        trade_side: 'B' = buyer aggressive (price rising), 'A' = seller aggressive.
        """
        with self._lock:
            for oid, o in list(self._orders.items()):
                if o['filled_price'] is not None:
                    continue
                # BID fills when seller hits down through our bid
                if o['side'] == 'bid' and trade_side == 'A' and trade_px <= o['price']:
                    o['filled_price'] = o['price']
                    o['filled_qty']   = o['size']
                # ASK fills when buyer lifts up through our ask
                elif o['side'] == 'ask' and trade_side == 'B' and trade_px >= o['price']:
                    o['filled_price'] = o['price']
                    o['filled_qty']   = o['size']

    def open_orders(self) -> list:
        """Snapshot of all open (unfilled) orders for UI display."""
        with self._lock:
            return [
                {'id': oid, 'side': o['side'], 'price': o['price'], 'size': o['size']}
                for oid, o in self._orders.items()
                if o['filled_price'] is None
            ]

    def recent_fills(self, n=20) -> list:
        """Last N filled orders for the fill log UI."""
        with self._lock:
            filled = [
                {'id': oid, 'side': o['side'], 'price': o['filled_price'],
                 'size': o['filled_qty'], 'ts': o['ts']}
                for oid, o in self._orders.items()
                if o['filled_price'] is not None
            ]
        filled.sort(key=lambda x: x['ts'], reverse=True)
        return filled[:n]
