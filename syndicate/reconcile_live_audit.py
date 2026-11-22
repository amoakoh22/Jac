"""
Jac Syndicate - Reconcile live API audit (runtime/live_api_audit_latest.json) into SQLite.
Marks settled-won legs (selection status==1) as WON, lost (status==2) as LOST,
stores live cashout offers on syndicate_codehub_bullets.
"""
import json, os, re, sqlite3, datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, "data", "syndicate_ledger.sqlite")
AUDIT = os.path.join(BASE, "runtime", "live_api_audit_latest.json")


def norm(s):
    s = s.lower()
    s = re.sub(r"\b(fc|cf|afc|sc|ac|1|istanbul|city)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def main():
    d = json.load(open(AUDIT))
    bets = d["open"]["data"]["cashAbleBets"]
    c = sqlite3.connect(DB, timeout=15.0)
    c.execute("PRAGMA busy_timeout=15000;")
    now = datetime.datetime.utcnow().isoformat()
    for b in bets:
        code = b.get("shareCode")
        co = (b.get("cashOut") or {}).get("maxCashOutAmount")
        if co is not None:
            c.execute("UPDATE syndicate_codehub_bullets SET cashout_value=? WHERE booking_code=?", (float(co), code))
        rows = c.execute(
            "SELECT ledger_id, match_name FROM syndicate_creator_anchor_ledger WHERE booking_code=?", (code,)
        ).fetchall()
        for x in b["selections"]:
            if x.get("isSettled") != 1:
                continue
            st = {1: "WON", 2: "LOST", 3: "VOID"}.get(x.get("status"))
            if not st:
                continue
            h, a = norm(x["home"]), norm(x["away"])
            for lid, mn in rows:
                parts = re.split(r"\s+vs?\s+", mn, maxsplit=1)
                if len(parts) != 2:
                    continue
                ph, pa = norm(parts[0]), norm(parts[1])
                if (ph in h or h in ph) and (pa in a or a in pa):
                    c.execute("UPDATE syndicate_creator_anchor_ledger SET status=?, updated_at=? WHERE ledger_id=?", (st, now, lid))
                    break
    c.commit()
    for r in c.execute(
        "SELECT booking_code, status, COUNT(*) FROM syndicate_creator_anchor_ledger WHERE booking_code IN "
        "('9121S3','EPVDTJ','D40MWN','F4JQ4M','C36TTY','C3GCWW') GROUP BY 1,2"
    ):
        print(r)


if __name__ == "__main__":
    main()
