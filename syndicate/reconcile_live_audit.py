"""
Jac Syndicate - Reconcile live API audit (runtime/live_api_audit_latest.json) into SQLite.
Handles BOTH:
  - Open bets: updates settled leg statuses (WON/LOST/VOID) + live cashout offers.
  - Settled bets: marks bullet status (LOST/WON), settled_at, realized_pnl, cashout_value=0,
    and updates all settled legs (WON/LOST/VOID) in syndicate_creator_anchor_ledger so
    closed_loop_learner.py immediately ingests every busted leg.
"""
import json, os, re, sqlite3, datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, "data", "syndicate_ledger.sqlite")
AUDIT = os.path.join(BASE, "runtime", "live_api_audit_latest.json")


def norm(s):
    s = s.lower()
    s = re.sub(r"\b(fc|cf|afc|sc|ac|1|istanbul|city|pr|pa|ca)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def update_legs(c, code, selections, now):
    rows = c.execute(
        "SELECT ledger_id, match_name FROM syndicate_creator_anchor_ledger WHERE booking_code=?", (code,)
    ).fetchall()
    for x in selections or []:
        st = {1: "WON", 2: "LOST", 3: "VOID"}.get(x.get("status"))
        if not st:
            continue
        h, a = norm(x.get("home", "")), norm(x.get("away", ""))
        for lid, mn in rows:
            parts = re.split(r"\s+vs?\s+", mn, maxsplit=1)
            if len(parts) != 2:
                continue
            ph, pa = norm(parts[0]), norm(parts[1])
            if (ph in h or h in ph) and (pa in a or a in pa):
                c.execute(
                    "UPDATE syndicate_creator_anchor_ledger SET status=?, updated_at=? WHERE ledger_id=?",
                    (st, now, lid),
                )
                break


def main():
    d = json.load(open(AUDIT))
    c = sqlite3.connect(DB, timeout=15.0)
    c.execute("PRAGMA busy_timeout=15000;")
    now = datetime.datetime.utcnow().isoformat()

    # 1. Open bets
    open_bets = (d.get("open") or {}).get("data", {}).get("cashAbleBets") or []
    for b in open_bets:
        code = b.get("shareCode")
        if not code:
            continue
        co = (b.get("cashOut") or {}).get("maxCashOutAmount")
        b_stake = float(b.get("stake") or b.get("originStake") or 0.0)
        if co is not None:
            if b_stake > 0:
                c.execute(
                    "UPDATE syndicate_codehub_bullets SET cashout_value=? WHERE booking_code=? AND ABS(stake - ?) < 0.05",
                    (float(co), code, b_stake),
                )
            else:
                c.execute("UPDATE syndicate_codehub_bullets SET cashout_value=? WHERE booking_code=?", (float(co), code))
        update_legs(c, code, b.get("selections"), now)

    # 2. Settled bets
    settled_bets = (d.get("settled") or {}).get("data", {}).get("entityList") or []
    for s in settled_bets:
        code = s.get("shareCode")
        if not code:
            continue
        row = c.execute(
            "SELECT bullet_id, stake, status FROM syndicate_codehub_bullets WHERE booking_code=?", (code,)
        ).fetchone()
        if not row:
            continue
        bid, stake, cur_status = row
        ws = s.get("winningStatus")
        # SportyBet winningStatus: 20 = WON, 30 = LOST, 40 = VOID/CASHED
        new_status = {20: "WON", 30: "LOST"}.get(ws)
        if new_status and cur_status == "IN_PROGRESS":
            win_amt = float(s.get("totalWinnings") or 0.0)
            pnl = round(win_amt - float(stake or 0.0), 2)
            c.execute(
                "UPDATE syndicate_codehub_bullets SET status=?, settled_at=?, realized_pnl=?, cashout_value=0.0 WHERE booking_code=?",
                (new_status, now, pnl, code),
            )
            print(f"[SETTLED] {code} ({bid}) -> {new_status} | PnL: {pnl:+.2f} GHS")
        update_legs(c, code, s.get("selections"), now)

    c.commit()
    print("\n--- Active / Recently Updated Tickets ---")
    for r in c.execute(
        "SELECT b.booking_code, b.status, b.cashout_value, b.realized_pnl, "
        "SUM(CASE WHEN l.status='WON' THEN 1 ELSE 0 END) as w, "
        "SUM(CASE WHEN l.status='LOST' THEN 1 ELSE 0 END) as l, "
        "SUM(CASE WHEN l.status='IN_PROGRESS' THEN 1 ELSE 0 END) as p "
        "FROM syndicate_codehub_bullets b "
        "LEFT JOIN syndicate_creator_anchor_ledger l ON b.booking_code = l.booking_code "
        "WHERE b.booking_code IN ('9121S3','EPVDTJ','D40MWN','F4JQ4M','C36TTY','C3GCWW') "
        "GROUP BY b.booking_code"
    ):
        print(r)


if __name__ == "__main__":
    main()
