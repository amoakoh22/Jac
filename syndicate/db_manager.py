"""
Hermes Syndicate Persistent Database Engine
Manages the isolated Telecel SportyBet Ghana account ledger, multi-week tickets,
legs, cashout/hedge telemetry, and root-cause post-mortem logs.
Zero interference with the primary Bermesi ledger.
"""

import sqlite3
import os
import json
from datetime import datetime

SYNDICATE_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(SYNDICATE_DATA_DIR, "syndicate_ledger.sqlite")

def get_connection():
    os.makedirs(SYNDICATE_DATA_DIR, exist_ok=True)
    return sqlite3.connect(DB_PATH)

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    # 1. Syndicate Account & Wallets (Telecel SportyBet)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_label TEXT DEFAULT 'Telecel_SportyBet_Ghana',
        liquid_balance REAL DEFAULT 0.0,
        currency TEXT DEFAULT 'GHS',
        max_cycle_exposure_pct REAL DEFAULT 0.24,
        unit_size REAL DEFAULT 20.00,
        last_synced TEXT
    )
    """)

    # 2. Multi-Week Deployment Cycles
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_cycles (
        cycle_id TEXT PRIMARY KEY,
        start_date TEXT,
        end_date TEXT,
        total_tickets INTEGER DEFAULT 4,
        ticket_stake REAL DEFAULT 5.00,
        total_exposure REAL DEFAULT 20.00,
        status TEXT DEFAULT 'ACTIVE', -- ACTIVE, WON, LOST, CASHED_OUT
        realized_pnl REAL DEFAULT 0.0,
        created_at TEXT
    )
    """)

    # 3. Independent Tickets within Cycles
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_tickets (
        ticket_id TEXT PRIMARY KEY,
        cycle_id TEXT,
        ticket_number INTEGER, -- 1 to 4
        title TEXT,
        stake REAL DEFAULT 5.00,
        total_odds REAL,
        multi_bet_bonus_pct REAL DEFAULT 0.0,
        potential_payout REAL,
        status TEXT DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, WON, LOST, CASHED_OUT, HEDGED
        cashout_value REAL DEFAULT 0.0,
        realized_pnl REAL DEFAULT 0.0,
        booking_code TEXT,
        placed_at TEXT,
        settled_at TEXT,
        FOREIGN KEY(cycle_id) REFERENCES syndicate_cycles(cycle_id)
    )
    """)

    # 4. Individual Match Legs
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        leg_order INTEGER,
        match_name TEXT,
        sport TEXT,
        league TEXT,
        kickoff_gmt TEXT,
        market_category TEXT,
        market_name TEXT,
        selection TEXT,
        odds REAL,
        sportybet_breadcrumb TEXT,
        verification_status TEXT DEFAULT 'CONFIRMED', -- CONFIRMED, UPGRADE, DOWNGRADE_PROTECT, ABORT
        outcome TEXT DEFAULT 'PENDING', -- PENDING, WON, LOST, VOID, CANCELLED
        clv_odds REAL,
        FOREIGN KEY(ticket_id) REFERENCES syndicate_tickets(ticket_id)
    )
    """)

    # 5. Live Cashout & Equalized Arbitrage Hedge Ledger
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_hedges_cashouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        timestamp TEXT,
        early_legs_won INTEGER,
        remaining_legs INTEGER,
        settled_equity REAL,
        sportybet_cashout_offer REAL,
        hedge_market TEXT,
        opposing_odds REAL,
        calculated_hedge_stake REAL,
        action_taken TEXT, -- PRINCIPAL_PROTECTION, ARBITRAGE_LOCK, HOLD, CASHED_OUT
        realized_return REAL,
        notes TEXT,
        FOREIGN KEY(ticket_id) REFERENCES syndicate_tickets(ticket_id)
    )
    """)

    # 6. Post-Mortem Audit & Root-Cause Failure Store
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_post_mortems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        leg_id INTEGER,
        timestamp TEXT,
        failure_category TEXT, -- TACTICAL_PACE_READ_ERROR, LINEUP_INJURY_SURPRISE, PURE_VARIANCE
        tactical_summary TEXT,
        preventative_rule_added TEXT,
        FOREIGN KEY(ticket_id) REFERENCES syndicate_tickets(ticket_id),
        FOREIGN KEY(leg_id) REFERENCES syndicate_legs(id)
    )
    """)

    # 7. CodeHub Scraped Slips & Community Intelligence
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_codehub_scouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_code TEXT UNIQUE,
        creator_name TEXT,
        followers_count INTEGER,
        original_odds REAL,
        original_legs_count INTEGER,
        scraped_at TEXT,
        raw_slip_json TEXT,
        stripped_traps_count INTEGER DEFAULT 0,
        retained_anchors_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'ANALYZED' -- ANALYZED, REJECTED, USED_IN_BULLET
    )
    """)

    # 8. Refined GHS 1.00 Micro-Bullets (Scout Moonshots)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_codehub_bullets (
        bullet_id TEXT PRIMARY KEY,
        derived_from_code TEXT,
        stake REAL DEFAULT 1.00,
        total_odds REAL,
        potential_payout REAL,
        legs_count INTEGER,
        status TEXT DEFAULT 'PENDING',
        booking_code TEXT,
        created_at TEXT,
        settled_at TEXT,
        realized_pnl REAL DEFAULT 0.0
    )
    """)

    # 9. Daily Performance & Balance Ledger
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_daily_performance (
        date TEXT PRIMARY KEY,
        stakes REAL DEFAULT 0.0,
        returns REAL DEFAULT 0.0,
        net_pnl REAL DEFAULT 0.0,
        roi_percent REAL DEFAULT 0.0,
        wallet_balance REAL DEFAULT 0.0,
        active_tickets_count INTEGER DEFAULT 0
    )
    """)

    # Seed Initial Wallet if empty
    cursor.execute("SELECT COUNT(*) FROM syndicate_wallets")
    if cursor.fetchone()[0] == 0:
        cursor.execute("""
        INSERT INTO syndicate_wallets (account_label, liquid_balance, currency, max_cycle_exposure_pct, unit_size, last_synced)
        VALUES ('Telecel_SportyBet_Ghana', 250.00, 'GHS', 0.24, 20.00, ?)
        """, (datetime.utcnow().isoformat(),))

    conn.commit()
    conn.close()
    return DB_PATH

def save_cycle_and_tickets(cycle_info, tickets):
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
    INSERT OR REPLACE INTO syndicate_cycles 
    (cycle_id, start_date, end_date, total_tickets, ticket_stake, total_exposure, status, realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    """, (
        cycle_info["cycle_id"],
        cycle_info["start_date"],
        cycle_info["end_date"],
        cycle_info.get("total_tickets", 4),
        cycle_info.get("ticket_stake", 5.00),
        cycle_info.get("total_exposure", 20.00),
        cycle_info.get("status", "ACTIVE"),
        cycle_info.get("realized_pnl", 0.0)
    ))

    for t in tickets:
        cursor.execute("""
        INSERT OR REPLACE INTO syndicate_tickets
        (ticket_id, cycle_id, ticket_number, title, stake, total_odds, multi_bet_bonus_pct, potential_payout, status, cashout_value, realized_pnl, booking_code, placed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """, (
            t["ticket_id"],
            cycle_info["cycle_id"],
            t["ticket_number"],
            t["title"],
            t.get("stake", 5.00),
            t["total_odds"],
            t.get("multi_bet_bonus_pct", 0.0),
            t["potential_payout"],
            t.get("status", "PENDING"),
            t.get("cashout_value", 0.0),
            t.get("realized_pnl", 0.0),
            t.get("booking_code", "")
        ))

        for idx, leg in enumerate(t.get("legs", [])):
            cursor.execute("""
            INSERT INTO syndicate_legs
            (ticket_id, leg_order, match_name, sport, league, kickoff_gmt, market_category, market_name, selection, odds, sportybet_breadcrumb, verification_status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                t["ticket_id"],
                idx + 1,
                leg["match_name"],
                leg.get("sport", "Football"),
                leg.get("league", ""),
                leg.get("kickoff_gmt", ""),
                leg.get("market_category", "Main"),
                leg.get("market_name", ""),
                leg.get("selection", ""),
                leg.get("odds", 1.0),
                leg.get("sportybet_breadcrumb", ""),
                leg.get("verification_status", "CONFIRMED"),
                leg.get("outcome", "PENDING")
            ))

    conn.commit()
    conn.close()

def save_codehub_scout(item, stripped_count, retained_count):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT OR REPLACE INTO syndicate_codehub_scouts 
    (booking_code, creator_name, followers_count, original_odds, original_legs_count, scraped_at, raw_slip_json, stripped_traps_count, retained_anchors_count, status)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 'ANALYZED')
    """, (
        item["booking_code"],
        item.get("creator_name", "Community"),
        item.get("followers", 0),
        item.get("odds", 0.0) if isinstance(item.get("odds"), (int, float)) else 0.0,
        len(item.get("legs", [])) or item.get("folds", 0),
        json.dumps(item),
        stripped_count,
        retained_count
    ))
    conn.commit()
    conn.close()

def save_codehub_bullet(bullet):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT OR REPLACE INTO syndicate_codehub_bullets
    (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at)
    VALUES (?, ?, 1.00, ?, ?, ?, 'PENDING', ?, datetime('now'))
    """, (
        bullet["bullet_id"],
        bullet["derived_from_code"],
        bullet["total_odds"],
        bullet["potential_payout"],
        bullet["legs_count"],
        bullet.get("booking_code", bullet["derived_from_code"])
    ))
    conn.commit()
    conn.close()

def get_current_state():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT liquid_balance, currency, unit_size FROM syndicate_wallets LIMIT 1")
    wallet = cursor.fetchone()
    
    cursor.execute("SELECT * FROM syndicate_cycles WHERE status='ACTIVE' ORDER BY rowid DESC LIMIT 1")
    cycle = cursor.fetchone()

    cursor.execute("SELECT COUNT(*) FROM syndicate_tickets WHERE status='PENDING' OR status='IN_PROGRESS'")
    active_tickets = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM syndicate_codehub_bullets WHERE status='PENDING'")
    active_bullets = cursor.fetchone()[0]

    conn.close()
    return {
        "wallet_balance": wallet[0] if wallet else 0.0,
        "currency": wallet[1] if wallet else "GHS",
        "unit_size": wallet[2] if wallet else 20.00,
        "has_active_cycle": cycle is not None,
        "active_cycle": cycle,
        "active_tickets_count": active_tickets,
        "active_bullets_count": active_bullets
    }

if __name__ == "__main__":
    import sys
    path = init_db()
    print(f"[SyndicateDB] Initialized persistent SQLite ledger at: {path}")
    state = get_current_state()
    print(f"[SyndicateDB] Current Wallet: {state['wallet_balance']} {state['currency']} | Active Tickets: {state['active_tickets_count']}")
