"""
config.py — Hyperbookmap + AS bot configuration.
"""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    # AS Model
    gamma: float = 0.1
    kappa: float = 1.5
    sigma_window: int = 100
    T_hours: float = 8.0

    # Inventory
    eta: float = 0.005
    base_order_size: float = 0.001

    # Engine
    wait_timer_secs: float = 5.0
    tick_interval_secs: float = 1.0

    # Coin
    coin: str = 'BTC'

    # Hyperliquid (no API key needed for paper trading)
    hl_ws_url: str = 'wss://api.hyperliquid.xyz/ws'

    # Optuna
    optuna_db: str = 'sqlite:///optuna.db'
    optuna_study_name: str = 'as_market_maker'
    optuna_trials: int = 200


DEFAULT_CONFIG = Config()
