"""
core/inventory.py — Exponential inventory skew.
  bid_size = base * exp(-η * max(q,  0))
  ask_size = base * exp(-η * max(-q, 0))
"""
from __future__ import annotations
import numpy as np
from dataclasses import dataclass


@dataclass
class SizedQuote:
    bid_price: float
    ask_price: float
    bid_size: float
    ask_size: float
    inventory_skew: float


class InventoryManager:
    def __init__(self, eta=0.005, base_order_size=0.001):
        self.eta = eta
        self.base_order_size = base_order_size

    def reconfigure(self, eta=None, base_order_size=None):
        if eta is not None:             self.eta = eta
        if base_order_size is not None: self.base_order_size = base_order_size

    def size_orders(self, bid_price, ask_price, inventory) -> SizedQuote:
        q = inventory
        b_sz = max(self.base_order_size * np.exp(-self.eta * max(q,  0.0)), 1e-8)
        a_sz = max(self.base_order_size * np.exp(-self.eta * max(-q, 0.0)), 1e-8)
        return SizedQuote(
            bid_price=bid_price, ask_price=ask_price,
            bid_size=round(b_sz, 8), ask_size=round(a_sz, 8),
            inventory_skew=float(np.clip(q * self.eta, -5.0, 5.0)),
        )
