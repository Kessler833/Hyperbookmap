"""
core/model.py — Avellaneda-Stoikov (AS) model equations.

Reservation price:  r(s,t) = s − q · γ · σ² · (T − t)
Optimal spread:     δ*(t)  = γ · σ² · (T−t) + (2/γ) · ln(1 + γ/κ)
Bid quote:          b = r − δ*/2
Ask quote:          a = r + δ*/2
"""
from __future__ import annotations
import numpy as np
from collections import deque
from dataclasses import dataclass


@dataclass
class QuoteResult:
    mid: float
    reservation: float
    bid: float
    ask: float
    spread: float
    sigma: float
    time_remaining: float


class ASModel:
    def __init__(self, gamma=0.1, kappa=1.5, sigma_window=100, T_hours=8.0):
        self.gamma = gamma
        self.kappa = kappa
        self.sigma_window = sigma_window
        self.T_seconds = T_hours * 3600.0
        self._prices: deque[float] = deque(maxlen=sigma_window)
        self._window_start = 0.0
        self._current_time = 0.0

    def update(self, mid: float, epoch_sec: float | None = None):
        import time as _t
        if epoch_sec is None:
            epoch_sec = _t.time()
        self._prices.append(mid)
        self._current_time = epoch_sec
        if epoch_sec - self._window_start >= self.T_seconds:
            self._window_start = epoch_sec

    def reconfigure(self, gamma=None, kappa=None, sigma_window=None, T_hours=None):
        if gamma is not None:        self.gamma = gamma
        if kappa is not None:        self.kappa = kappa
        if T_hours is not None:      self.T_seconds = T_hours * 3600.0
        if sigma_window is not None:
            self.sigma_window = sigma_window
            self._prices = deque(list(self._prices)[-sigma_window:], maxlen=sigma_window)

    @property
    def sigma(self) -> float:
        if len(self._prices) < 2:
            return 1e-6
        arr = np.array(self._prices)
        rets = np.diff(arr) / arr[:-1]
        return float(np.std(rets)) if len(rets) > 0 else 1e-6

    @property
    def time_remaining(self) -> float:
        elapsed = self._current_time - self._window_start
        return max(0.0, self.T_seconds - elapsed)

    def quotes(self, mid: float, inventory: float) -> QuoteResult:
        q = inventory
        g = self.gamma
        s2 = self.sigma ** 2
        Tt = self.time_remaining
        r = mid - q * g * s2 * Tt
        delta = max(g * s2 * Tt + (2.0 / g) * np.log(1.0 + g / self.kappa), 1e-8)
        return QuoteResult(
            mid=mid, reservation=r,
            bid=r - delta / 2.0, ask=r + delta / 2.0,
            spread=delta, sigma=self.sigma, time_remaining=Tt,
        )
