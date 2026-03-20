"""
core/pnl.py — PnL tracker (extracted from engine for standalone import).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import List
import numpy as np


@dataclass
class Fill:
    side: str        # 'bid' | 'ask'
    price: float
    qty: float
    epoch: float
    inventory_after: float


@dataclass
class PnLState:
    realized: float = 0.0
    inventory: float = 0.0
    avg_cost: float = 0.0
    fills: List[Fill] = field(default_factory=list)
    spread_captured: List[float] = field(default_factory=list)
    equity_curve: List[float] = field(default_factory=list)
    mid_history: List[float] = field(default_factory=list)

    @property
    def unrealized(self) -> float:
        if not self.mid_history:
            return 0.0
        return self.inventory * (self.mid_history[-1] - self.avg_cost)

    @property
    def total(self) -> float:
        return self.realized + self.unrealized

    def record_fill(self, fill: Fill):
        self.fills.append(fill)
        q, p = fill.qty, fill.price
        if fill.side == 'bid':
            old = self.inventory
            self.inventory += q
            self.avg_cost = (old * self.avg_cost + q * p) / self.inventory if self.inventory else 0.0
        else:
            self.realized += (p - self.avg_cost) * q
            self.inventory -= q
            if abs(self.inventory) < 1e-10:
                self.avg_cost = 0.0
                self.inventory = 0.0

    def metrics(self) -> dict:
        ec = self.equity_curve
        if len(ec) < 2:
            sharpe, max_dd = 0.0, 0.0
        else:
            arr  = np.array(ec)
            rets = np.diff(arr)
            sharpe  = float(np.mean(rets) / (np.std(rets) + 1e-10) * np.sqrt(len(rets)))
            peak    = np.maximum.accumulate(arr)
            max_dd  = float(np.min((arr - peak) / (peak + 1e-10)))
        fills_sell = [f for f in self.fills if f.side == 'ask']
        wins = sum(1 for f in fills_sell if f.price > self.avg_cost)
        return dict(
            realized=self.realized, unrealized=self.unrealized, total=self.total,
            inventory=self.inventory, sharpe=sharpe, max_drawdown=max_dd,
            fill_count=len(self.fills), win_rate=wins / max(len(fills_sell), 1),
            spread_captured=sum(self.spread_captured),
            avg_spread=float(np.mean(self.spread_captured)) if self.spread_captured else 0.0,
        )
