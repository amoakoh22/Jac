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


def evaluate(now_utc: dt.datetime, event_name: str = "schedule"):
    if event_name == "workflow_dispatch":
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

    age_min = last_sync_age_minutes(now_utc)
    next_win = upcoming[0][0].strftime("%Y-%m-%dT%H:%MZ") if upcoming else None
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
    args = ap.parse_args()

    now_utc = (
        dt.datetime.strptime(args.at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        if args.at
        else dt.datetime.now(dt.timezone.utc)
    )
    should_run, reason, detail, next_win = evaluate(now_utc, args.event)
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
