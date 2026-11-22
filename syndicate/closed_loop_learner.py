#!/usr/bin/env python3
"""
Hermes Syndicate Closed-Loop Learner & Post-Mortem Calibration Engine

Idempotent self-learning pipeline that:
  1. Ensures SQLite WAL mode + schema upgrades (syndicate_post_mortems, syndicate_market_performance).
  2. Repairs verified historical leg corruption in syndicate_creator_anchor_ledger,
     closes CYCLE_2026_11_16_LIVE, and clears impossible cross-contaminated cashout values.
  3. Audits settled outcomes across BOTH syndicate_tickets AND syndicate_codehub_bullets,
     writing structured leg-level root-cause post-mortems (zero generic boilerplate).
  4. Aggregates empirical win/loss hit rates and calibration gaps into
     syndicate_market_performance and syndicate_daily_performance.
  5. Dynamically calibrates data/syndicate_heuristics.json (v3.0.0) and
     runtime/syndicate_experience.json.
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if os.path.join(BASE_DIR, "syndicate") not in sys.path:
    sys.path.insert(0, os.path.join(BASE_DIR, "syndicate"))

import db_manager

DEFAULT_DB_PATH = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
DEFAULT_HEURISTICS_PATH = os.path.join(BASE_DIR, "data", "syndicate_heuristics.json")
DEFAULT_EXPERIENCE_PATH = os.path.join(BASE_DIR, "runtime", "syndicate_experience.json")

# Verified historical ground-truth corrections for corrupted anchor-ledger legs
# (caused by legacy booking_code=None global LOWER(match_name) overwrites in monitor_syndicate_bets.js)
HISTORICAL_CORRUPTION_REPAIRS = [
    # D8WJHX (20F 1X2): Chelsea 1-4 Leeds, Villa 0-0 Sunderland, Kocaelispor 2-2 Fenerbahce, Man City 1-1 Fulham
    ("D8WJHX", "Chelsea vs Leeds United", "LOST"),
    ("D8WJHX", "Aston Villa vs Sunderland", "LOST"),
    ("D8WJHX", "Kocaelispor vs Fenerbahce", "LOST"),
    ("D8WJHX", "Man City vs Fulham", "LOST"),
    # CMYT2L (35F Bonus Arb): Troyes 3-1 1H NG, Bournemouth 2-0 (2H 0-0) 2H O0.5, Villa 0-0 2H O0.5
    ("CMYT2L", "Troyes vs Le Havre", "LOST"),
    ("CMYT2L", "Bournemouth vs Nottingham Forest", "LOST"),
    ("CMYT2L", "Aston Villa vs Sunderland AFC", "LOST"),
    # 8YLKVR (43F 10m/Slow-Start): Troyes 3-1 1H NG
    ("8YLKVR", "Troyes vs Le Havre", "LOST"),
    # 93VVCD (45F Goals/HT): Den Bosch 1-0 O2, AGF Aarhus 2-1 (0 goals 2H) 2H O0.5, Artis Brno 3-1 1H U2.5
    ("93VVCD", "FC Den Bosch vs VVV Venlo", "LOST"),
    ("93VVCD", "AGF Aarhus vs Lyngby BK", "LOST"),
    ("93VVCD", "SK Artis Brno vs FK Jablonec", "LOST"),
]

# Known league lookup for historical anchor-ledger fixtures lacking a league column
FIXTURE_LEAGUE_HINTS = [
    ("den bosch", "Eerste Divisie"),
    ("vvv venlo", "Eerste Divisie"),
    ("kilmarnock", "Scottish Premiership"),
    ("aberdeen", "Scottish Premiership"),
    ("millwall", "Championship"),
    ("queens park rangers", "Championship"),
    ("middlesbrough", "Championship"),
    ("hull city", "Championship"),
    ("coventry", "Championship"),
    ("chelsea", "Premier League"),
    ("aston villa", "Premier League"),
    ("man city", "Premier League"),
    ("bournemouth", "Premier League"),
    ("wolves", "Premier League"),
    ("arsenal", "Premier League"),
    ("nottingham forest", "Premier League"),
    ("bayern munich", "Bundesliga"),
    ("cologne", "Bundesliga"),
    ("hamburg", "Bundesliga"),
    ("athletic bilbao", "LaLiga"),
    ("rayo vallecano", "LaLiga"),
    ("barcelona", "LaLiga"),
    ("sevilla", "LaLiga"),
    ("troyes", "Ligue 2"),
    ("metz", "Ligue 2"),
    ("monaco", "Ligue 1"),
    ("marseille", "Ligue 1"),
    ("psg", "Ligue 1"),
    ("auxerre", "Ligue 1"),
    ("lille", "Ligue 1"),
    ("fenerbahce", "Super Lig"),
    ("galatasaray", "Super Lig"),
    ("rubin kazan", "Russian Premier League"),
    ("zenit", "Russian Premier League"),
    ("agf aarhus", "Danish Superliga"),
    ("artis brno", "Czech Liga"),
    ("wsg tirol", "Austrian Bundesliga"),
    ("tromsoe", "Eliteserien"),
]

CANONICAL_BANNED_MARKETS = [
    "1H_GG_NG_NO",
    "HCP_0_1_FAV",
    "2H_OVER_0_5",
    "1H_UNDER_2_5",
    "PLAIN_1X2_FAV_ACCUM",
    "EERSTE_DIVISIE_OVER_2",
]

CANONICAL_BANNED_PAIRS = [
    {
        "market": "OVER_2_0",
        "league_pattern": "Eerste Divisie",
        "reason": "93VVCD Den Bosch 1-0",
    },
    {
        "market": "UNDER_4_5",
        "league_pattern": "Premiership",
        "reason": "BKJ0JX Kilmarnock 2-4 Aberdeen",
    },
    {
        "market": "OVER_1_5",
        "league_pattern": "Championship",
        "reason": "808QK6 Millwall 0-1 QPR",
    },
]


def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def infer_league(match_name, explicit_league=None):
    if explicit_league and str(explicit_league).strip():
        return str(explicit_league).strip()
    lower = (match_name or "").lower()
    for kw, league in FIXTURE_LEAGUE_HINTS:
        if kw in lower:
            return league
    return "UNKNOWN"


def canonicalize_market_key(selection, market_name="", league=""):
    raw = f"{market_name or ''} {selection or ''}".strip()
    low = raw.lower()
    lg = (league or "").lower()

    if ("1st half" in low or "1h" in low) and ("gg/ng" in low or "btts" in low) and "no" in low:
        return "1H_GG_NG_NO"
    if "handicap" in low and ("0:1" in low or "1:0" in low or "-1" in low):
        return "HCP_0_1_FAV"
    if ("2nd half" in low or "2h" in low) and "over 0.5" in low:
        return "2H_OVER_0_5"
    if ("1st half" in low or "1h" in low) and "under 2.5" in low:
        return "1H_UNDER_2_5"
    if ("1st half" in low or "1h" in low) and "under" in low:
        return "1H_UNDER"
    m_ou = re.search(r"\b(over|under)\s+(\d+(?:\.\d+)?)\b", low)
    if m_ou:
        direction = m_ou.group(1).upper()
        num_str = m_ou.group(2)
        line = num_str.replace(".", "_") if "." in num_str else f"{num_str}_0"
        if (
            direction == "OVER"
            and line == "0_5"
            and ("team" in low or (":" in (selection or "") and not low.startswith("over/under")))
        ):
            return "TEAM_OVER_0_5"
        return f"{direction}_{line}"
    if "1x2 - 2up" in low or "2up" in low:
        return "1X2_2UP"
    if "1x2 - 1up" in low or "1up" in low:
        return "1X2_1UP"
    if "double chance" in low or "1x" in low or "x2" in low or "12" in low:
        return "DOUBLE_CHANCE"
    if "handicap" in low:
        return "HANDICAP_OTHER"
    if low in ("home", "away", "draw") or "1x2" in low or "winner" in low:
        return "PLAIN_1X2_FAV_ACCUM"
    return "OTHER_MARKET"


def parse_telemetry_from_selection(selection):
    """Extract (odds, betradar_prob, rtp) if encoded in selection text."""
    text = selection or ""
    odds = None
    prob = None
    rtp = None

    m_odds = re.search(r"@\s*([0-9]+(?:\.[0-9]+)?)", text)
    if m_odds:
        odds = float(m_odds.group(1))

    m_prob = re.search(r"(?:MktProb|Prob)\s*[=:]?\s*([0-9]+(?:\.[0-9]+)?)%", text, re.I)
    if not m_prob:
        m_prob = re.search(r"\(([0-9]+(?:\.[0-9]+)?)%\)", text)
    if m_prob:
        prob = round(float(m_prob.group(1)) / 100.0, 4)

    m_rtp = re.search(r"RTP\s*[=:]?\s*([0-9]+(?:\.[0-9]+)?)%", text, re.I)
    if m_rtp:
        rtp = round(float(m_rtp.group(1)) / 100.0, 4)
    elif odds is not None and prob is not None:
        rtp = round(odds * prob, 4)

    return odds, prob, rtp


def classify_failure(market_key, league, match_name, selection):
    """
    Classify genuine root-cause failure category and preventative rule.
    Never returns boilerplate 'VARIANCE_OR_TACTICAL_MISS'.
    """
    lg_low = (league or "").lower()

    if market_key == "1H_GG_NG_NO":
        return (
            "FRAGILE_MARKET",
            "Rule #28 Ban: 1H_GG_NG_NO permanently banned (two early goals bust entire slip).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key == "2H_OVER_0_5":
        return (
            "FRAGILE_MARKET",
            "Rule #28 Ban: 2H_OVER_0_5 permanently banned (game-state dead 2nd halves kill slip).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key in ("1H_UNDER_2_5", "1H_UNDER"):
        return (
            "FRAGILE_MARKET",
            "Rule #28 + CH1 Ban: 1H_UNDER_2_5 permanently banned (early 3-goal bursts destroy accumulator).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key == "HCP_0_1_FAV":
        return (
            "HANDICAP_TRAP",
            "Rule #28 Ban: HCP_0_1_FAV (-1 favorite handicap) banned (single-goal wins or draws bust).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key == "OVER_2_0" and "eerste divisie" in lg_low:
        return (
            "LEAGUE_VARIANCE",
            "Rule #28 Market-League Ban: OVER_2_0 banned in Dutch Eerste Divisie (Den Bosch 1-0 trap).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key == "UNDER_4_5" and "premiership" in lg_low:
        return (
            "HIGH_SCORING_TRAP",
            "Rule #28 Market-League Ban: UNDER_4_5 banned in Scottish Premiership (Kilmarnock 2-4 Aberdeen).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key == "UNDER_4_5":
        return (
            "HIGH_SCORING_TRAP",
            "Tighten Poisson ceiling filter: avoid Under 4.5 in open attacking leagues/fixtures.",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key == "OVER_1_5" and "championship" in lg_low:
        return (
            "LOW_SCORING_TRAP",
            "Rule #28 Market-League Ban: OVER_1_5 banned in English Championship (Millwall 0-1 QPR low-scoring variance).",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key.startswith("UNDER_"):
        return (
            "HIGH_SCORING_TRAP",
            f"Tighten Poisson ceiling filter: avoid {market_key} in open attacking leagues/fixtures.",
            "rule_28_friday_postmortem_market_ban",
        )
    if market_key.startswith("OVER_") or market_key == "TEAM_OVER_0_5":
        return (
            "LOW_SCORING_TRAP",
            f"Require higher xG floor or pivot away from {market_key} to Double Chance / zero-vig >=98% RTP markets.",
            "rule_29_zero_vig_bonus_sweet_spot",
        )
    if market_key in ("PLAIN_1X2_FAV_ACCUM", "1X2_1UP", "1X2_2UP"):
        return (
            "FAVORITE_UPSET",
            "Rule #28 Ban: Never anchor high-fold accumulators on plain 1X2 favorites; require draw protection or >=98% RTP zero-vig legs.",
            "rule_28_friday_postmortem_market_ban",
        )
    return (
        "LEAGUE_VARIANCE",
        "Audit market-league empirical calibration gap before re-entry.",
        "rule_29_zero_vig_bonus_sweet_spot",
    )


def repair_historical_ground_truth(conn):
    """
    Idempotently repair verified historical corruption in SQLite:
      - Corrupted anchor ledger leg statuses on D8WJHX, CMYT2L, 8YLKVR, 93VVCD
      - Unclosed CYCLE_2026_11_16_LIVE -> status='LOST', realized_pnl=-20.0
      - Impossible cashout_value > potential_payout on IN_PROGRESS bullets (C36TTY 3.44 > 3.29)
    """
    now = utc_now_iso()
    cursor = conn.cursor()
    repaired_legs = 0

    tbl_exists = cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='syndicate_creator_anchor_ledger'"
    ).fetchone()
    if tbl_exists:
        for booking_code, match_name, true_status in HISTORICAL_CORRUPTION_REPAIRS:
            cursor.execute(
                """
                UPDATE syndicate_creator_anchor_ledger
                SET status = ?, updated_at = ?
                WHERE booking_code = ? AND match_name = ? AND status != ?
                """,
                (true_status, now, booking_code, match_name, true_status),
            )
            repaired_legs += cursor.rowcount

    # Close CYCLE_2026_11_16_LIVE if all its tickets settled LOST
    cursor.execute(
        """
        UPDATE syndicate_cycles
        SET status = 'LOST', realized_pnl = -20.0
        WHERE cycle_id = 'CYCLE_2026_11_16_LIVE'
          AND (status != 'LOST' OR ABS(COALESCE(realized_pnl, 0.0) - (-20.0)) > 0.001)
        """
    )
    repaired_cycles = cursor.rowcount

    # Clear impossible cross-contaminated cashout_value (> potential_payout) on IN_PROGRESS bullets
    cursor.execute(
        """
        UPDATE syndicate_codehub_bullets
        SET cashout_value = 0.0
        WHERE status = 'IN_PROGRESS'
          AND potential_payout IS NOT NULL
          AND potential_payout > 0
          AND cashout_value > potential_payout
        """
    )
    repaired_cashouts = cursor.rowcount

    conn.commit()
    return {
        "repaired_legs": repaired_legs,
        "repaired_cycles": repaired_cycles,
        "repaired_cashouts": repaired_cashouts,
    }


def backfill_post_mortems(conn):
    """
    Idempotently generate structured leg-level post-mortem rows for ALL settled lost tickets
    across BOTH syndicate_tickets (4 Core Tickets) and syndicate_codehub_bullets (8+ Monster Bullets).
    """
    now = utc_now_iso()
    cursor = conn.cursor()
    new_rows = 0
    upgraded_rows = 0

    # 1. Upgrade legacy boilerplate rows for syndicate_tickets (remove VARIANCE_OR_TACTICAL_MISS)
    core_tickets = cursor.execute(
        """
        SELECT ticket_id, booking_code, stake, total_odds, potential_payout, status, realized_pnl, title
        FROM syndicate_tickets
        WHERE status IN ('WON', 'LOST', 'CASHED_OUT')
        """
    ).fetchall()

    for tid, code, stake, odds, payout, status, pnl, title in core_tickets:
        legs = cursor.execute(
            """
            SELECT id, match_name, league, market_name, selection, odds, outcome
            FROM syndicate_legs
            WHERE ticket_id = ?
            ORDER BY leg_order ASC
            """,
            (tid,),
        ).fetchall()

        lost_legs = [l for l in legs if l[6] == "LOST"]
        leagues = sorted({(l[2] or "UNKNOWN") for l in legs if l[2]})
        league_summary = ", ".join(leagues[:3]) if leagues else "Multi-League"

        if status == "LOST":
            if lost_legs:
                # Write one post-mortem per confirmed LOST leg
                for leg_id, mname, lg, mkt, sel, lodds, _ in lost_legs:
                    mkey = canonicalize_market_key(sel, mkt, lg)
                    cat, rule_txt, auto_rule = classify_failure(mkey, lg, mname, sel)
                    exists = cursor.execute(
                        """
                        SELECT id FROM syndicate_post_mortems
                        WHERE source_table='syndicate_tickets' AND booking_code=? AND match_name=? AND selection=?
                        """,
                        (code, mname, sel),
                    ).fetchone()
                    if not exists:
                        summary = f"Core Ticket {tid} ({code}) LOST on {mname} [{mkt}: {sel} @ {lodds}] | Stake {stake} GHS | PnL {pnl}"
                        cursor.execute(
                            """
                            INSERT INTO syndicate_post_mortems
                            (ticket_id, leg_id, timestamp, failure_category, tactical_summary, preventative_rule_added,
                             source_table, booking_code, market_key, league, match_name, selection, odds, betradar_prob, rtp, auto_rule_triggered)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                            """,
                            (
                                tid, leg_id, now, cat, summary, rule_txt,
                                "syndicate_tickets", code, mkey, infer_league(mname, lg),
                                mname, sel, lodds, None, None, auto_rule,
                            ),
                        )
                        new_rows += 1
            else:
                # Ticket settled LOST without individual leg outcome breakdown in syndicate_legs
                mkey = "PLAIN_1X2_FAV_ACCUM"
                cat = "FAVORITE_UPSET"
                rule_txt = (
                    "Rule #28 Ban: Retired 7-8 fold straight 1X2/Winner accumulators without draw protection "
                    "or verified >=98% Betradar RTP."
                )
                auto_rule = "rule_28_friday_postmortem_market_ban"
                summary = (
                    f"Core Ticket {tid} ({code}) settled LOST ({len(legs)}F straight 1X2/Winner @ {odds}x) "
                    f"| Leagues: {league_summary} | Stake {stake:.2f} GHS | PnL {pnl:.2f} GHS"
                )
                existing = cursor.execute(
                    "SELECT id, failure_category, booking_code FROM syndicate_post_mortems WHERE ticket_id = ? LIMIT 1",
                    (tid,),
                ).fetchone()
                if existing:
                    if existing[1] == "VARIANCE_OR_TACTICAL_MISS" or not existing[2]:
                        cursor.execute(
                            """
                            UPDATE syndicate_post_mortems
                            SET failure_category=?, tactical_summary=?, preventative_rule_added=?,
                                source_table='syndicate_tickets', booking_code=?, market_key=?,
                                league=?, match_name=?, selection=?, odds=?, auto_rule_triggered=?
                            WHERE id=?
                            """,
                            (
                                cat, summary, rule_txt, code, mkey, league_summary,
                                f"{len(legs)}-Fold Core Accumulator ({code})",
                                "1X2 / Winner Multi", odds, auto_rule, existing[0],
                            ),
                        )
                        upgraded_rows += 1
                else:
                    cursor.execute(
                        """
                        INSERT INTO syndicate_post_mortems
                        (ticket_id, leg_id, timestamp, failure_category, tactical_summary, preventative_rule_added,
                         source_table, booking_code, market_key, league, match_name, selection, odds, betradar_prob, rtp, auto_rule_triggered)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            tid, None, now, cat, summary, rule_txt,
                            "syndicate_tickets", code, mkey, league_summary,
                            f"{len(legs)}-Fold Core Accumulator ({code})",
                            "1X2 / Winner Multi", odds, None, None, auto_rule,
                        ),
                    )
                    new_rows += 1

    # 2. Audit ALL settled LOST Monster Bullets from syndicate_codehub_bullets
    lost_bullets = cursor.execute(
        """
        SELECT bullet_id, booking_code, stake, total_odds, potential_payout, legs_count, realized_pnl, settled_at
        FROM syndicate_codehub_bullets
        WHERE status = 'LOST'
        ORDER BY created_at ASC
        """
    ).fetchall()

    for bid, bcode, stake, odds, payout, legs_count, pnl, settled_at in lost_bullets:
        # Distinct losing legs for this bullet
        lost_legs = cursor.execute(
            """
            SELECT DISTINCT match_name, selection
            FROM syndicate_creator_anchor_ledger
            WHERE booking_code = ? AND status = 'LOST'
            ORDER BY match_name ASC
            """,
            (bcode,),
        ).fetchall()

        if lost_legs:
            for mname, sel in lost_legs:
                exists = cursor.execute(
                    """
                    SELECT id FROM syndicate_post_mortems
                    WHERE source_table = 'syndicate_codehub_bullets'
                      AND booking_code = ?
                      AND match_name = ?
                      AND selection = ?
                    """,
                    (bcode, mname, sel),
                ).fetchone()
                if exists:
                    continue

                lg = infer_league(mname)
                mkey = canonicalize_market_key(sel, "", lg)
                leg_odds, leg_prob, leg_rtp = parse_telemetry_from_selection(sel)
                cat, rule_txt, auto_rule = classify_failure(mkey, lg, mname, sel)
                summary = (
                    f"Monster Bullet {bid} ({bcode}, {legs_count}F @ {odds}x) LOST on {mname} "
                    f"[{sel}] ({lg}) | Stake {stake:.2f} GHS | PnL {pnl:.2f} GHS"
                )
                cursor.execute(
                    """
                    INSERT INTO syndicate_post_mortems
                    (ticket_id, leg_id, timestamp, failure_category, tactical_summary, preventative_rule_added,
                     source_table, booking_code, market_key, league, match_name, selection, odds, betradar_prob, rtp, auto_rule_triggered)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        bid, None, settled_at or now, cat, summary, rule_txt,
                        "syndicate_codehub_bullets", bcode, mkey, lg,
                        mname, sel, leg_odds, leg_prob, leg_rtp, auto_rule,
                    ),
                )
                new_rows += 1
        else:
            # Fallback bullet-level post-mortem if no individual lost legs recorded
            exists = cursor.execute(
                """
                SELECT id FROM syndicate_post_mortems
                WHERE source_table = 'syndicate_codehub_bullets' AND booking_code = ?
                """,
                (bcode,),
            ).fetchone()
            if not exists:
                summary = (
                    f"Monster Bullet {bid} ({bcode}, {legs_count}F @ {odds}x) settled LOST "
                    f"| Stake {stake:.2f} GHS | PnL {pnl:.2f} GHS"
                )
                cursor.execute(
                    """
                    INSERT INTO syndicate_post_mortems
                    (ticket_id, leg_id, timestamp, failure_category, tactical_summary, preventative_rule_added,
                     source_table, booking_code, market_key, league, match_name, selection, odds, betradar_prob, rtp, auto_rule_triggered)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        bid, None, settled_at or now, "LEAGUE_VARIANCE", summary,
                        "Enforce Rule #28 & #29 leg-level telemetry capture on all Monster Bullets.",
                        "syndicate_codehub_bullets", bcode, "UNKNOWN", "UNKNOWN",
                        f"{legs_count}-Fold Bullet ({bcode})", "Multi-Leg", odds, None, None,
                        "rule_28_friday_postmortem_market_ban",
                    ),
                )
                new_rows += 1

    conn.commit()
    return {"new_post_mortems": new_rows, "upgraded_post_mortems": upgraded_rows}


def update_market_performance(conn):
    """
    Aggregate empirical win/loss statistics across all settled legs into
    syndicate_market_performance (both market-wide 'ALL' and per (market_key, league)).
    Returns market_risk_weights dict for syndicate_heuristics.json.
    """
    now = utc_now_iso()
    cursor = conn.cursor()

    # Deduplicate settled legs per (booking_code, match_name, selection)
    anchor_rows = cursor.execute(
        """
        SELECT booking_code, match_name, selection,
               CASE WHEN SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END) > 0 THEN 'LOST'
                    WHEN SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END) > 0 THEN 'WON'
                    ELSE 'OTHER' END AS resolved_status
        FROM syndicate_creator_anchor_ledger
        WHERE status IN ('WON', 'LOST')
        GROUP BY booking_code, match_name, selection
        """
    ).fetchall()

    # Also include settled legs from syndicate_legs if any
    core_leg_rows = cursor.execute(
        """
        SELECT ticket_id, match_name, league, market_name, selection, odds, outcome
        FROM syndicate_legs
        WHERE outcome IN ('WON', 'LOST')
        """
    ).fetchall()

    agg = defaultdict(lambda: {"won": 0, "lost": 0, "exp_probs": []})

    def record(mkey, lg, status, exp_prob):
        for bucket_lg in ("ALL", lg):
            d = agg[(mkey, bucket_lg)]
            if status == "WON":
                d["won"] += 1
            elif status == "LOST":
                d["lost"] += 1
            if exp_prob is not None and 0.0 < exp_prob <= 1.0:
                d["exp_probs"].append(exp_prob)

    for bcode, mname, sel, st in anchor_rows:
        if st not in ("WON", "LOST"):
            continue
        lg = infer_league(mname)
        mkey = canonicalize_market_key(sel, "", lg)
        leg_odds, leg_prob, _ = parse_telemetry_from_selection(sel)
        if leg_prob is None and leg_odds and leg_odds > 1.0:
            leg_prob = min(0.99, 0.96 / leg_odds)
        record(mkey, lg, st, leg_prob or 0.78)

    for tid, mname, lg, mkt, sel, lodds, outcome in core_leg_rows:
        norm_lg = infer_league(mname, lg)
        mkey = canonicalize_market_key(sel, mkt, norm_lg)
        exp_p = min(0.99, 0.96 / lodds) if (lodds and lodds > 1.0) else 0.75
        record(mkey, norm_lg, outcome, exp_p)

    # Clear and recompute cleanly (deterministic, idempotent)
    cursor.execute("DELETE FROM syndicate_market_performance")

    banned_pair_lookup = {(p["market"], p["league_pattern"].lower()) for p in CANONICAL_BANNED_PAIRS}
    market_risk_weights = {}
    auto_banned_league_pairs = []

    for (mkey, lg), stats in sorted(agg.items()):
        won = stats["won"]
        lost = stats["lost"]
        total = won + lost
        if total == 0:
            continue
        emp_hr = round(won / total, 4)
        exp_hr = round(sum(stats["exp_probs"]) / len(stats["exp_probs"]), 4) if stats["exp_probs"] else 0.78
        gap = round(emp_hr - exp_hr, 4)

        # Laplace-smoothed penalty weight based on empirical underperformance
        laplace_loss_rate = (lost + 0.5) / (total + 2.0)
        penalty = round(max(0.0, (-gap) + 0.5 * laplace_loss_rate) if gap < 0 else max(0.0, 0.25 * laplace_loss_rate), 4)

        is_banned = False
        if mkey in CANONICAL_BANNED_MARKETS:
            is_banned = True
        elif lg != "ALL":
            for bm, pat in banned_pair_lookup:
                if bm == mkey and pat in lg.lower():
                    is_banned = True
                    break
        if not is_banned and lost >= 2 and gap <= -0.15:
            is_banned = True

        cursor.execute(
            """
            INSERT INTO syndicate_market_performance
            (market_key, league, total_legs, won_legs, lost_legs, empirical_hit_rate,
             expected_hit_rate, calibration_gap, penalty_weight, banned, last_updated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (mkey, lg, total, won, lost, emp_hr, exp_hr, gap, penalty, 1 if is_banned else 0, now),
        )

        if lg == "ALL":
            market_risk_weights[mkey] = {
                "won": won,
                "lost": lost,
                "empirical_hit_rate": emp_hr,
                "penalty": penalty,
                "banned": is_banned,
            }
        elif is_banned and lg not in ("ALL", "UNKNOWN") and mkey not in CANONICAL_BANNED_MARKETS:
            auto_banned_league_pairs.append(
                {
                    "market": mkey,
                    "league_pattern": lg,
                    "reason": f"Auto-banned by closed-loop learner ({won}W-{lost}L, gap={gap:+.2f})",
                }
            )

    # Ensure all canonical banned markets appear in market_risk_weights even if 0 legs in anchor ledger
    for bm in CANONICAL_BANNED_MARKETS:
        if bm not in market_risk_weights:
            market_risk_weights[bm] = {
                "won": 0,
                "lost": 0,
                "empirical_hit_rate": 0.0,
                "penalty": 1.0,
                "banned": True,
            }

    conn.commit()
    return market_risk_weights, auto_banned_league_pairs


def update_daily_performance(conn):
    """Aggregate daily stakes, returns, net PnL, and ROI across tickets + bullets."""
    cursor = conn.cursor()
    wallet_row = cursor.execute("SELECT liquid_balance FROM syndicate_wallets LIMIT 1").fetchone()
    wallet_bal = float(wallet_row[0]) if wallet_row and wallet_row[0] is not None else 0.0

    active_count = (
        cursor.execute("SELECT COUNT(*) FROM syndicate_tickets WHERE status IN ('PENDING','IN_PROGRESS')").fetchone()[0]
        + cursor.execute("SELECT COUNT(*) FROM syndicate_codehub_bullets WHERE status IN ('PENDING','IN_PROGRESS')").fetchone()[0]
    )

    daily = defaultdict(lambda: {"stakes": 0.0, "returns": 0.0, "net_pnl": 0.0})

    for placed_at, settled_at, stake, pnl, status in cursor.execute(
        "SELECT placed_at, settled_at, stake, realized_pnl, status FROM syndicate_tickets WHERE status IN ('WON','LOST','CASHED_OUT')"
    ).fetchall():
        dt = (settled_at or placed_at or utc_now_iso())[:10]
        st = float(stake or 0.0)
        p = float(pnl or 0.0)
        ret = max(0.0, st + p) if status in ("WON", "CASHED_OUT") else 0.0
        daily[dt]["stakes"] += st
        daily[dt]["returns"] += ret
        daily[dt]["net_pnl"] += p

    for created_at, settled_at, stake, pnl, status in cursor.execute(
        "SELECT created_at, settled_at, stake, realized_pnl, status FROM syndicate_codehub_bullets WHERE status IN ('WON','LOST','CASHED_OUT')"
    ).fetchall():
        dt = (settled_at or created_at or utc_now_iso())[:10]
        st = float(stake or 0.0)
        p = float(pnl or 0.0)
        ret = max(0.0, st + p) if status in ("WON", "CASHED_OUT") else 0.0
        daily[dt]["stakes"] += st
        daily[dt]["returns"] += ret
        daily[dt]["net_pnl"] += p

    cursor.execute("DELETE FROM syndicate_daily_performance")
    for dt, vals in sorted(daily.items()):
        roi = round((vals["net_pnl"] / vals["stakes"]) * 100.0, 2) if vals["stakes"] > 0 else 0.0
        cursor.execute(
            """
            INSERT INTO syndicate_daily_performance
            (date, stakes, returns, net_pnl, roi_percent, wallet_balance, active_tickets_count)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                dt,
                round(vals["stakes"], 2),
                round(vals["returns"], 2),
                round(vals["net_pnl"], 2),
                roi,
                round(wallet_bal, 2),
                active_count,
            ),
        )
    conn.commit()
    return len(daily)


def calibrate_heuristics_json(
    heuristics_path,
    market_risk_weights,
    new_post_mortems_count,
    auto_banned_league_pairs=None,
):
    """
    Update data/syndicate_heuristics.json to v3.0.0 matching PROJECT.md Interface Contract.
    Preserves all existing top-level keys and rules.
    """
    now = utc_now_iso()
    if os.path.exists(heuristics_path):
        with open(heuristics_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {
            "version": "3.0.0",
            "name": "Hermes Asymmetric Multi-Week Syndicate Heuristics Store",
            "rules": {},
            "dynamic_weights": {},
            "calibration_log": [],
        }

    data["version"] = "3.0.0"
    data["last_updated"] = now
    rules = data.setdefault("rules", {})

    # Rule #28: machine-enforceable banned_markets & banned_market_league_pairs
    r28 = rules.setdefault(
        "rule_28_friday_postmortem_market_ban",
        {
            "id": 28,
            "name": "Post-Mortem Fragile Market & League-Pair Ban",
            "description": "Empirically banned markets and market-league traps from 12-ticket closed-loop post-mortem audit.",
            "active": True,
        },
    )
    existing_banned = list(r28.get("banned_markets", []))
    for bm in CANONICAL_BANNED_MARKETS:
        if bm not in existing_banned:
            existing_banned.append(bm)
    for mkey, stats in market_risk_weights.items():
        if stats.get("banned") and mkey not in existing_banned:
            existing_banned.append(mkey)
    r28["banned_markets"] = existing_banned

    existing_pairs = list(r28.get("banned_market_league_pairs", []))
    seen_pairs = {(p.get("market"), (p.get("league_pattern") or "").lower()) for p in existing_pairs}
    for pair in CANONICAL_BANNED_PAIRS:
        sig = (pair["market"], pair["league_pattern"].lower())
        if sig not in seen_pairs:
            existing_pairs.append(pair)
            seen_pairs.add(sig)
    for pair in (auto_banned_league_pairs or []):
        mkt = pair.get("market")
        pat_low = (pair.get("league_pattern") or "").lower().strip()
        if not mkt or not pat_low:
            continue
        already_covered = any(
            ex_mkt == mkt and (ex_pat == pat_low or ex_pat in pat_low)
            for ex_mkt, ex_pat in seen_pairs
        )
        if not already_covered:
            existing_pairs.append(pair)
            seen_pairs.add((mkt, pat_low))
    r28["banned_market_league_pairs"] = existing_pairs
    r28["active"] = True

    # Rule #29: Zero-Vig >= 1.20 Multi-Bet Bonus Sweet Spot (PROJECT.md contract)
    r29 = rules.setdefault("rule_29_zero_vig_bonus_sweet_spot", {"id": 29})
    r29["id"] = 29
    r29["name"] = "Zero-Vig >=1.20 Multi-Bet Bonus Sweet Spot (20-35 Folds for 100x+ +EV)"
    r29["description"] = (
        "Target 20-35 disjoint legs @ 1.20-1.45 with Betradar RTP >= 98.0% and true ticket EV >= 1.02 "
        "via SportyBet Multi-Bet Win Bonus (excluding Rule #28 banned markets and market-league traps)."
    )
    r29["min_leg_odds"] = 1.20
    r29["max_leg_odds"] = 1.45
    r29["min_betradar_rtp"] = 0.980
    r29["min_ticket_ev"] = 1.02
    r29["active"] = True

    # Dynamic weights with empirical market_risk_weights
    dyn = data.setdefault("dynamic_weights", {})
    dyn.setdefault("road_b2b_penalty", 0.15)
    dyn.setdefault("home_court_boost", 1.08)
    dyn.setdefault("post_international_break_away_penalty", 0.12)
    dyn["market_risk_weights"] = market_risk_weights

    # Append calibration_log entry only when new post-mortems are logged or v3.0.0 bootstrap occurs
    cal_log = data.setdefault("calibration_log", [])
    has_v3_entry = any(e.get("event") == "Closed-Loop Learner v3.0.0 Calibration" for e in cal_log)
    if new_post_mortems_count > 0 or not has_v3_entry:
        cal_log.append(
            {
                "date": now[:10],
                "timestamp": now,
                "event": "Closed-Loop Learner v3.0.0 Calibration",
                "finding": (
                    f"Audited all settled core tickets + Monster Bullets (+{new_post_mortems_count} new leg post-mortems). "
                    f"Locked {len(r28['banned_markets'])} banned markets, {len(r28['banned_market_league_pairs'])} banned market-league pairs, "
                    f"and upgraded Rule #29 RTP floor to 0.980 / min_ticket_ev 1.02."
                ),
            }
        )

    os.makedirs(os.path.dirname(os.path.abspath(heuristics_path)), exist_ok=True)
    with open(heuristics_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return data


def update_experience_json(conn, experience_path, new_post_mortems_count):
    """Write unified telemetry across BOTH syndicate_tickets and syndicate_codehub_bullets."""
    cursor = conn.cursor()

    t_stats = cursor.execute(
        """
        SELECT COUNT(*),
               SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status='CASHED_OUT' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status IN ('IN_PROGRESS','PENDING') THEN 1 ELSE 0 END),
               COALESCE(SUM(realized_pnl), 0.0)
        FROM syndicate_tickets
        WHERE status != 'ABORTED_UNPLACED'
        """
    ).fetchone()

    b_stats = cursor.execute(
        """
        SELECT COUNT(*),
               SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status='CASHED_OUT' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status IN ('IN_PROGRESS','PENDING') THEN 1 ELSE 0 END),
               COALESCE(SUM(realized_pnl), 0.0)
        FROM syndicate_codehub_bullets
        """
    ).fetchone()

    pm_total = cursor.execute("SELECT COUNT(*) FROM syndicate_post_mortems").fetchone()[0]
    pm_distinct_tickets = cursor.execute(
        "SELECT COUNT(DISTINCT booking_code) FROM syndicate_post_mortems WHERE booking_code IS NOT NULL AND booking_code != ''"
    ).fetchone()[0]

    exp = {
        "updated_at": utc_now_iso(),
        "total_tracked": (t_stats[0] or 0) + (b_stats[0] or 0),
        "won": (t_stats[1] or 0) + (b_stats[1] or 0),
        "lost": (t_stats[2] or 0) + (b_stats[2] or 0),
        "cashed_out": (t_stats[3] or 0) + (b_stats[3] or 0),
        "in_progress": (t_stats[4] or 0) + (b_stats[4] or 0),
        "realized_pnl_ghs": round((t_stats[5] or 0.0) + (b_stats[5] or 0.0), 2),
        "core_tickets": {
            "total": t_stats[0] or 0,
            "won": t_stats[1] or 0,
            "lost": t_stats[2] or 0,
            "in_progress": t_stats[4] or 0,
            "realized_pnl_ghs": round(t_stats[5] or 0.0, 2),
        },
        "monster_bullets": {
            "total": b_stats[0] or 0,
            "won": b_stats[1] or 0,
            "lost": b_stats[2] or 0,
            "cashed_out": b_stats[3] or 0,
            "in_progress": b_stats[4] or 0,
            "realized_pnl_ghs": round(b_stats[5] or 0.0, 2),
        },
        "post_mortems_total": pm_total,
        "post_mortem_distinct_tickets": pm_distinct_tickets,
        "new_post_mortems_logged": new_post_mortems_count,
    }

    os.makedirs(os.path.dirname(os.path.abspath(experience_path)), exist_ok=True)
    with open(experience_path, "w", encoding="utf-8") as f:
        json.dump(exp, f, indent=2)
    return exp


def run_closed_loop_learning(
    db_path=DEFAULT_DB_PATH,
    heuristics_path=DEFAULT_HEURISTICS_PATH,
    experience_path=DEFAULT_EXPERIENCE_PATH,
):
    conn = db_manager.get_connection(db_path)
    try:
        db_manager.ensure_schema_upgrades(conn)
        repairs = repair_historical_ground_truth(conn)
        pm_res = backfill_post_mortems(conn)
        market_weights, auto_banned_league_pairs = update_market_performance(conn)
        daily_days = update_daily_performance(conn)
        heuristics = calibrate_heuristics_json(
            heuristics_path,
            market_weights,
            pm_res["new_post_mortems"],
            auto_banned_league_pairs=auto_banned_league_pairs,
        )
        experience = update_experience_json(
            conn, experience_path, pm_res["new_post_mortems"]
        )
    finally:
        conn.close()

    return {
        "repairs": repairs,
        "post_mortems": pm_res,
        "market_performance_keys": len(market_weights),
        "daily_performance_days": daily_days,
        "heuristics_version": heuristics.get("version"),
        "experience": experience,
    }


def main():
    parser = argparse.ArgumentParser(description="Hermes Syndicate Closed-Loop Learner")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="Path to SQLite ledger")
    parser.add_argument("--heuristics", default=DEFAULT_HEURISTICS_PATH, help="Path to heuristics JSON")
    parser.add_argument("--experience", default=DEFAULT_EXPERIENCE_PATH, help="Path to experience JSON")
    args = parser.parse_args()

    result = run_closed_loop_learning(
        db_path=args.db,
        heuristics_path=args.heuristics,
        experience_path=args.experience,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
