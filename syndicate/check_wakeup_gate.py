"""
Jac Syndicate - Dynamic Kickoff-Window Wakeup Gate (Zero-Chromium Pre-Flight)

Evaluates whether any active slip/leg is within its pre-kickoff, live in-play,
or post-match settlement window [-25m, +150m] around kickoff_gmt.
During dead hours (no legs in window), skips heavy Chromium/SportyBet runs
unless the 4-hour heartbeat floor is exceeded or manually dispatched.
"""
import argparse
import datetime as dt
import json
import os
import re
import sqlite3

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, "data", "syndicate_ledger.sqlite")
STATUS_FILE = os.path.join(BASE, "status.json")

PRE_KICKOFF_MIN = 25
POST_KICKOFF_MIN = 150
HEARTBEAT_MAX_AGE_MIN = 240


def parse_kickoff_utc(raw: str):
    if not raw:
        return None
    s = raw.strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            pass
    m = re.match(r"^(\d{2})/(\d{2})\s+(\d{2}):(\d{2})", s)
    if m:
        day, mon, hh, mm = map(int, m.groups())
        now_y = dt.datetime.now(dt.timezone.utc).year
        try:
            return dt.datetime(now_y, mon, day, hh, mm, tzinfo=dt.timezone.utc)
        except ValueError:
            return None
    return None


def collect_active_kickoffs():
    events = []
    if not os.path.exists(DB):
        return events
    conn = sqlite3.connect(DB, timeout=10.0)
    cur = conn.cursor()
    try:
        rows = cur.execute(
            """
            SELECT b.booking_code, l.match_name, l.kickoff_gmt
            FROM syndicate_codehub_bullets b
            JOIN syndicate_creator_anchor_ledger l ON l.booking_code = b.booking_code
            WHERE b.status = 'IN_PROGRESS'
              AND l.status IN ('IN_PROGRESS', 'OPEN', 'PENDING')
            """
        ).fetchall()
        for code, match_name, ko_raw in rows:
            ko = parse_kickoff_utc(ko_raw)
            if ko:
                events.append((ko, code, match_name))
    except sqlite3.Error:
        pass
    try:
        rows2 = cur.execute(
            """
            SELECT t.ticket_id, g.match_name, g.kickoff_gmt
            FROM syndicate_tickets t
            JOIN syndicate_legs g ON g.ticket_id = t.ticket_id
            WHERE t.status IN ('IN_PROGRESS', 'OPEN', 'PENDING')
              AND g.outcome = 'PENDING'
            """
        ).fetchall()
        for tid, match_name, ko_raw in rows2:
            ko = parse_kickoff_utc(ko_raw)
            if ko:
                events.append((ko, tid, match_name))
    except sqlite3.Error:
        pass
    conn.close()
    events.sort(key=lambda x: x[0])
    return events


def last_sync_age_minutes(now_utc: dt.datetime):
    if not os.path.exists(STATUS_FILE):
        return None
    try:
        st = json.load(open(STATUS_FILE, encoding="utf-8"))
        ts = st.get("last_synced_utc")
        if not ts:
            return None
        last = dt.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        return (now_utc - last).total_seconds() / 60.0
    except Exception:
        return None


def needs_portfolio_replenish(now_utc: dt.datetime):
    if not os.path.exists(DB):
        return False, ""
    try:
        conn = sqlite3.connect(DB, timeout=10.0)
        cur = conn.cursor()
        bal_row = cur.execute("SELECT liquid_balance FROM syndicate_wallets WHERE id = 1").fetchone()
        bal = float(bal_row[0]) if bal_row and bal_row[0] is not None else 0.0
        if bal < 120.0:
            conn.close()
            return False, ""

        reasons = []
        ladder = cur.execute(
            "SELECT current_step, active_booking_code FROM syndicate_vault_ladders WHERE ladder_id = 'VAULT_LADDER_V1'"
        ).fetchone()
        if ladder and ladder[1]:
            b = cur.execute(
                "SELECT status FROM syndicate_codehub_bullets WHERE booking_code = ? ORDER BY rowid DESC LIMIT 1",
                (ladder[1],),
            ).fetchone()
            if b and b[0] == "WON":
                reasons.append(("MODE_C_VAULT", f"Vault Step {ladder[0]} ({ladder[1]}) WON -> advance to Step {int(ladder[0]) + 1}"))

        x100_cnt = cur.execute(
            "SELECT COUNT(*) FROM syndicate_codehub_bullets WHERE status = 'IN_PROGRESS' AND total_odds >= 50.0"
        ).fetchone()[0]
        if x100_cnt < 2:
            reasons.append(("MODE_A_X100", f"x100+ active slots {x100_cnt}/2"))

        if reasons:
            # Respect 3h cooldown per strategy if that strategy already attempted recently
            tbl = cur.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='syndicate_auto_deployments'"
            ).fetchone()
            filtered_reasons = []
            if tbl:
                for strat, msg in reasons:
                    recent = cur.execute(
                        "SELECT created_at FROM syndicate_auto_deployments WHERE strategy = ? ORDER BY created_at DESC LIMIT 1",
                        (strat,),
                    ).fetchone()
                    if recent and recent[0]:
                        last_dt = dt.datetime.fromisoformat(recent[0].replace("Z", "+00:00"))
                        if (now_utc - last_dt).total_seconds() < 10800:
                            continue
                    filtered_reasons.append(msg)
            else:
                filtered_reasons = [msg for _, msg in reasons]

            conn.close()
            if filtered_reasons:
                return True, "; ".join(filtered_reasons)
            return False, ""
        conn.close()
    except Exception:
        pass
    return False, ""


def evaluate(now_utc: dt.datetime, event_name: str = "schedule", respect_gate: bool = False):
    if event_name == "workflow_dispatch" and not respect_gate:
        return True, "MANUAL_DISPATCH", "Triggered manually via workflow_dispatch", None

    events = collect_active_kickoffs()
    active_hits = []
    upcoming = []
    for ko, code, match_name in events:
        win_start = ko - dt.timedelta(minutes=PRE_KICKOFF_MIN)
        win_end = ko + dt.timedelta(minutes=POST_KICKOFF_MIN)
        if win_start <= now_utc <= win_end:
            active_hits.append((ko, code, match_name))
        elif win_start > now_utc:
            upcoming.append((win_start, ko, code, match_name))

    if active_hits:
        codes = sorted({c for _, c, _ in active_hits})
        ko0, c0, m0 = active_hits[0]
        return (
            True,
            "ACTIVE_WINDOW",
            f"{len(active_hits)} leg(s) in [-{PRE_KICKOFF_MIN}m,+{POST_KICKOFF_MIN}m] window across {','.join(codes)} (e.g. {c0} {m0} @ {ko0.strftime('%Y-%m-%d %H:%MZ')})",
            upcoming[0][0].strftime("%Y-%m-%dT%H:%MZ") if upcoming else None,
        )

    rep_needed, rep_reason = needs_portfolio_replenish(now_utc)
    next_win = upcoming[0][0].strftime("%Y-%m-%dT%H:%MZ") if upcoming else None
    if rep_needed:
        return True, "REPLENISH_READY", f"Autonomous opportunity open: {rep_reason}", next_win

    age_min = last_sync_age_minutes(now_utc)
    next_desc = f"{upcoming[0][2]} {upcoming[0][3]} (window opens {next_win})" if upcoming else "none"

    if age_min is None or age_min >= HEARTBEAT_MAX_AGE_MIN:
        age_str = "unknown" if age_min is None else f"{age_min:.0f}m"
        return True, "HEARTBEAT_4H", f"Last sync age {age_str} >= {HEARTBEAT_MAX_AGE_MIN}m; next match window: {next_desc}", next_win

    return (
        False,
        "SLEEP_DEAD_HOURS",
        f"No active legs in window; last sync {age_min:.0f}m ago (<{HEARTBEAT_MAX_AGE_MIN}m). Next window: {next_desc}",
        next_win,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--at", help="Override UTC ISO timestamp for testing (YYYY-MM-DDTHH:MM:SSZ)")
    ap.add_argument("--event", default=os.environ.get("GITHUB_EVENT_NAME", "schedule"))
    ap.add_argument("--respect-gate", action="store_true", default=os.environ.get("RESPECT_GATE", "").lower() == "true")
    args = ap.parse_args()

    now_utc = (
        dt.datetime.strptime(args.at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        if args.at
        else dt.datetime.now(dt.timezone.utc)
    )
    should_run, reason, detail, next_win = evaluate(now_utc, args.event, args.respect_gate)
    print(f"[WakeupGate] {now_utc.strftime('%Y-%m-%dT%H:%MZ')} | should_run={should_run} | reason={reason} | {detail}")

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"should_run={'true' if should_run else 'false'}\n")
            f.write(f"reason={reason}\n")
            if next_win:
                f.write(f"next_window={next_win}\n")


if __name__ == "__main__":
    main()
