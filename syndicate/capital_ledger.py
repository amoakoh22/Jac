"""
Hermes Syndicate - Capital Deposit & Pocket Statement Ledger
Maintains `syndicate_capital_ledger` in `data/syndicate_ledger.sqlite` from SportyBet Ghana's
official `/api/gh/pocket/v1/statements` feed (`runtime/sportybet_full_statements.json`).
Tracks every Deposit (DP0001), Withdrawal (WD0001), Bet Placement (PB0001),
Cashout Return (CB0002), and Winning Settlement (CB0001) with exact pre- and post-transaction
running wallet balances.
"""

import json
import os
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
STMT_PATH = os.path.join(BASE_DIR, "runtime", "sportybet_full_statements.json")

TRADE_LABELS = {
    "DP0001": ("DEPOSIT", "Telecel Mobile Money Capital Deposit"),
    "DP0002": ("DEPOSIT", "Partner Capital Deposit"),
    "WD0001": ("WITHDRAWAL", "Mobile Money Withdrawal"),
    "PB0001": ("BET_STAKE", "SportyBet Order Stake"),
    "CB0002": ("CASHOUT_RETURN", "Early Cashout Settlement Return"),
    "CB0001": ("WIN_SETTLEMENT", "Winning Payout Settlement"),
}

ORDER_TO_CODE = {
    "906162": "C6QSSB (Core Ticket #1 - 4F)",
    "429526": "D2X3PV (Core Ticket #2 - 3F)",
    "959891": "BD8Y44 (Core Ticket #3 - 4F)",
    "344049": "ASL92A (Core Ticket #4 - 4F)",
    "891441": "CLB3UK (5F CodeHub Bullet #1)",
    "556805": "C0RDDH (5F CodeHub Bullet #3)",
    "560803": "DD8GDQ (5F CodeHub Bullet #4)",
    "544511": "EPUVUU (5F CodeHub Bullet #5)",
    "301684": "9A9YK1 (5F CodeHub Bullet #2)",
    "997767": "D8WJHX (Monster #1 - 20F Consensus)",
    "304912": "9MJSC0 (Monster #2 - 21F 1X2 Alpha)",
    "767038": "93VVCD (Monster #3 - 45F Goals/HT)",
    "773777": "CHBJ6E (Monster #4 - 44F DC/Hcp Shield)",
    "129660": "8YLKVR (Monster #5 - 43F 10m Slow-Start)",
    "481879": "CMYT2L (Monster #6 - 35F 2,239x Bonus Arb)",
    "380297": "C36TTY (Monster #7 - 50F 98.7% Tail Fortress)",
    "818476": "BKJ0JX (Monster #8 - 23F 134x Poisson Ceiling)",
    "672740": "808QK6 (Monster #9 - 22F 127x DC/2UP Shield)",
    "489208": "9121S3 (Monster #10 - 25F 225x Zero-Vig Hybrid)",
    "235012": "C3GCWW (Monster #11 - 1F 98.9% Tail Fortress)",
    "848186": "D40MWN (Monster #12 - 23F 135x Sun+UCL Ceiling)",
    "466767": "F4JQ4M (Monster #13 - 22F 127x Sun+UCL Shield)",
    "834008": "EPVDTJ (Monster #14 - 24F 217x Sun+UCL Hybrid)",
    "817406": "Pre-Syndicate Manual Slip #1",
    "408570": "Pre-Syndicate Slip #2 (Cashed Out 100%)",
    "196218": "Pre-Syndicate SportySIM Micro-Slip (+0.46 Won)",
}


def sync_capital_ledger():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=15000;")
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS syndicate_capital_ledger (
        trade_id TEXT PRIMARY KEY,
        timestamp_gmt TEXT,
        create_time_ms INTEGER,
        tx_category TEXT,
        trade_code TEXT,
        biz_type TEXT,
        order_id TEXT,
        ticket_ref TEXT,
        direction TEXT,
        amount_ghs REAL,
        signed_amount_ghs REAL,
        balance_before_ghs REAL,
        balance_after_ghs REAL,
        notes TEXT
    )
    """)

    if not os.path.exists(STMT_PATH):
        conn.commit()
        conn.close()
        return

    with open(STMT_PATH, "r", encoding="utf-8") as f:
        stmts = json.load(f)

    # Seed opening carryover balance row prior to Nov 14 deposit (GHS 0.21)
    cur.execute("""
        INSERT OR REPLACE INTO syndicate_capital_ledger
        (trade_id, timestamp_gmt, create_time_ms, tx_category, trade_code, biz_type, order_id, ticket_ref,
         direction, amount_ghs, signed_amount_ghs, balance_before_ghs, balance_after_ghs, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        "OPENING_BALANCE_20261114", "2026-11-14 23:50:00", 1794700200000,
        "OPENING_CARRYOVER", "INIT", "Wallet", "", "Opening Wallet Carryover",
        "CREDIT", 0.21, 0.21, 0.00, 0.21, "Pre-deposit wallet residual balance"
    ))

    for s in stmts:
        tid = str(s.get("tradeId"))
        ct_ms = int(s.get("createTime") or 0)
        dt_str = datetime.fromtimestamp(ct_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        tcode = str(s.get("tradeCode") or "")
        biz = str(s.get("bizTypeName") or "Wallet")
        oid = str(s.get("orderId") or "")
        amt = round(float(s.get("amount") or 0) / 10000.0, 2)
        after_bal = round(float(s.get("afterBal") or 0) / 10000.0, 2)
        is_credit = int(s.get("amountSign") or 2) == 1
        direction = "CREDIT" if is_credit else "DEBIT"
        signed_amt = amt if is_credit else -amt
        before_bal = round(after_bal - signed_amt, 2)

        cat, default_desc = TRADE_LABELS.get(tcode, ("OTHER", tcode))
        t_ref = ORDER_TO_CODE.get(oid, f"Order #{oid}" if oid else default_desc)

        if tcode == "DP0001":
            notes = "Verified Telecel Mobile Money Capital Injection (+250.00 GHS)"
        elif tcode == "CB0002":
            notes = f"Early Cashout Return on {t_ref}"
        elif tcode == "CB0001":
            notes = f"Settled Winning Payout on {t_ref}"
        else:
            notes = f"Staked on {t_ref}"

        cur.execute("""
            INSERT OR REPLACE INTO syndicate_capital_ledger
            (trade_id, timestamp_gmt, create_time_ms, tx_category, trade_code, biz_type, order_id, ticket_ref,
             direction, amount_ghs, signed_amount_ghs, balance_before_ghs, balance_after_ghs, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            tid, dt_str, ct_ms, cat, tcode, biz, oid, t_ref,
            direction, amt, signed_amt, before_bal, after_bal, notes
        ))

    conn.commit()
    rows = cur.execute("SELECT COUNT(*), SUM(CASE WHEN tx_category='DEPOSIT' THEN amount_ghs ELSE 0 END) FROM syndicate_capital_ledger").fetchone()
    conn.close()
    print(f"[CapitalLedger] Synced {rows[0]} transactions | Total Capital Deposited: GHS {rows[1]:.2f}")


if __name__ == "__main__":
    sync_capital_ledger()
