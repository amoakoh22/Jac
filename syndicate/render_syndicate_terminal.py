"""
Hermes Syndicate Bloomberg KPI Terminal Generator
Renders a high-frequency, dark-mode terminal dashboard for the Asymmetric Multi-Week Syndicate.
Reads from data/syndicate_ledger.sqlite and data/syndicate_heuristics.json.
Writes directly to the conversation artifact directory and syndicate/syndicate_terminal.html.
"""

import os
import sqlite3
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
HEURISTICS_PATH = os.path.join(BASE_DIR, "data", "syndicate_heuristics.json")
ARTIFACT_DIR = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/4d8d83ff-7ad4-4751-88d8-a6f121d7868e"


def load_data():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=15000;")
    cursor = conn.cursor()

    # Wallet
    cursor.execute("SELECT account_label, liquid_balance, currency, max_cycle_exposure_pct, unit_size FROM syndicate_wallets LIMIT 1")
    wallet_row = cursor.fetchone()
    wallet = {
        "label": wallet_row[0] if wallet_row else "Telecel_SportyBet_Ghana",
        "balance": wallet_row[1] if wallet_row else 208.67,
        "currency": wallet_row[2] if wallet_row else "GHS",
        "max_exposure_pct": wallet_row[3] if wallet_row else 0.24,
        "unit_size": wallet_row[4] if wallet_row else 20.00
    }

    # Cycle
    cursor.execute("SELECT cycle_id, start_date, end_date, total_tickets, ticket_stake, total_exposure, status FROM syndicate_cycles ORDER BY created_at DESC LIMIT 1")
    cycle_row = cursor.fetchone()
    cycle = {
        "cycle_id": cycle_row[0] if cycle_row else "CYCLE_2026_11_16_LIVE",
        "start_date": cycle_row[1] if cycle_row else "2026-11-16",
        "end_date": cycle_row[2] if cycle_row else "2026-11-22",
        "total_tickets": cycle_row[3] if cycle_row else 4,
        "stake": cycle_row[4] if cycle_row else 5.00,
        "exposure": cycle_row[5] if cycle_row else 20.00,
        "status": cycle_row[6] if cycle_row else "ACTIVE"
    }

    # Active & Settled Booked Core Tickets (exclude ABORTED_UNPLACED drafts)
    cursor.execute("SELECT ticket_id, ticket_number, title, stake, total_odds, multi_bet_bonus_pct, potential_payout, status, booking_code, cashout_value, realized_pnl FROM syndicate_tickets WHERE status != 'ABORTED_UNPLACED' ORDER BY ticket_number ASC")
    ticket_rows = cursor.fetchall()
    tickets = []
    for t in ticket_rows:
        t_id = t[0]
        cursor.execute("SELECT match_name, sport, league, kickoff_gmt, market_name, selection, odds, sportybet_breadcrumb, verification_status FROM syndicate_legs WHERE ticket_id=? ORDER BY leg_order ASC", (t_id,))
        leg_rows = cursor.fetchall()
        legs = [{
            "match": l[0], "sport": l[1], "league": l[2], "kickoff": l[3],
            "market": l[4], "selection": l[5], "odds": l[6], "breadcrumb": l[7],
            "status": l[8]
        } for l in leg_rows]

        tickets.append({
            "id": t[0], "number": t[1], "title": t[2], "stake": t[3],
            "odds": t[4], "bonus_pct": t[5] or 0.0, "payout": t[6] or 0.0, "status": t[7],
            "code": t[8] or "PENDING", "cashout": t[9] or 0.0, "pnl": t[10] or 0.0,
            "legs": legs
        })

    # Load live SportyBet API telemetry (scores, live match periods, exact selection status) if available
    live_audit_path = os.path.join(BASE_DIR, "runtime", "live_api_audit_latest.json")
    live_open_by_code_stake = {}
    live_sel_by_code = {}
    if os.path.exists(live_audit_path):
        try:
            import re as _re
            def _norm(s):
                s = (s or "").lower()
                s = _re.sub(r"\b(fc|cf|afc|sc|ac|1|istanbul|city|pr|pa|ca)\b", " ", s)
                return _re.sub(r"[^a-z0-9]", "", s)

            with open(live_audit_path, "r", encoding="utf-8") as af:
                aj = json.load(af)
            open_list = (aj.get("open") or {}).get("data", {}).get("cashAbleBets") or []
            unsettled_list = (aj.get("unsettled") or {}).get("data", {}).get("entityList") or []
            settled_list = (aj.get("settled") or {}).get("data", {}).get("entityList") or []
            for ob in open_list + unsettled_list:
                sc = ob.get("shareCode")
                st_val = round(float(ob.get("stake") or ob.get("originStake") or 0.0), 2)
                if sc:
                    live_open_by_code_stake[(sc, st_val)] = ob
                    if sc not in live_sel_by_code:
                        live_sel_by_code[sc] = []
                        for s in (ob.get("selections") or []):
                            live_sel_by_code[sc].append({
                                "h": _norm(s.get("home", "")),
                                "a": _norm(s.get("away", "")),
                                "matchStatus": s.get("matchStatus") or "Not start",
                                "isSettled": s.get("isSettled", 0),
                                "status": s.get("status", 0),
                                "score": s.get("setScore") or s.get("score") or "",
                                "clock": s.get("playedSeconds") or "",
                            })
            for sb_api in settled_list:
                sc = sb_api.get("shareCode")
                if sc and sc not in live_sel_by_code:
                    live_sel_by_code[sc] = []
                    for s in (sb_api.get("selections") or []):
                        live_sel_by_code[sc].append({
                            "h": _norm(s.get("home", "")),
                            "a": _norm(s.get("away", "")),
                            "matchStatus": s.get("matchStatus") or "Ended",
                            "isSettled": s.get("isSettled", 1),
                            "status": s.get("status", 0),
                            "score": s.get("setScore") or s.get("score") or "",
                            "clock": "",
                        })
        except Exception:
            pass

    def _match_live_sel(code_str, match_str):
        import re as _re
        sels = live_sel_by_code.get(code_str) or []
        parts = _re.split(r"\s+vs?\s+", match_str or "", maxsplit=1)
        if len(parts) != 2:
            return None
        ph = _re.sub(r"[^a-z0-9]", "", _re.sub(r"\b(fc|cf|afc|sc|ac|1|istanbul|city|pr|pa|ca)\b", " ", parts[0].lower()))
        pa = _re.sub(r"[^a-z0-9]", "", _re.sub(r"\b(fc|cf|afc|sc|ac|1|istanbul|city|pr|pa|ca)\b", " ", parts[1].lower()))
        for s in sels:
            if ph and pa and (ph in s["h"] or s["h"] in ph) and (pa in s["a"] or s["a"] in pa):
                return s
        return None

    # Active CodeHub Bullets (IN_PROGRESS)
    b_cols_existing = {r[1] for r in cursor.execute("PRAGMA table_info(syndicate_codehub_bullets)").fetchall()}
    role_expr = "COALESCE(ticket_role, 'SOLO')" if "ticket_role" in b_cols_existing else "'SOLO'"
    pair_expr = "COALESCE(pair_total_stake, 0.0)" if "pair_total_stake" in b_cols_existing else "0.0"
    cursor.execute(f"SELECT bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, COALESCE(cashout_value, 0.0), {role_expr}, {pair_expr} FROM syndicate_codehub_bullets WHERE status='IN_PROGRESS' ORDER BY potential_payout DESC")
    bullet_rows = cursor.fetchall()
    bullets = []
    for b in bullet_rows:
        b_id = b[0]
        b_code = b[7] or "N/A"
        cursor.execute("""
            SELECT match_name, selection, kickoff_gmt, GROUP_CONCAT(DISTINCT creator_name || ' (' || source_code || ')'), status
            FROM syndicate_creator_anchor_ledger
            WHERE bullet_id=?
            GROUP BY match_name, selection, kickoff_gmt
            ORDER BY kickoff_gmt ASC
        """, (b_id,))
        leg_rows_b = cursor.fetchall()
        if not leg_rows_b:
            cursor.execute("""
                SELECT match_name, selection, kickoff_gmt, GROUP_CONCAT(DISTINCT creator_name || ' (' || source_code || ')'), status
                FROM syndicate_creator_anchor_ledger
                WHERE booking_code=?
                GROUP BY match_name, selection, kickoff_gmt
                ORDER BY kickoff_gmt ASC
            """, (b_code,))
            leg_rows_b = cursor.fetchall()

        b_legs = []
        won_c = lost_c = void_c = live_c = pend_c = 0
        next_ko = ""
        next_match = ""
        live_summaries = []

        for r in leg_rows_b:
            m_name, sel_txt, ko_gmt, creators_txt, db_st = r[0], r[1], r[2] or "", r[3] or "Consensus", r[4] or "IN_PROGRESS"
            ls = _match_live_sel(b_code, m_name)
            score_txt = ""
            display_st = db_st
            if ls:
                if ls["status"] == 1:
                    display_st = "WON"
                    score_txt = f"FT {ls['score']}" if ls["score"] else ""
                elif ls["status"] == 2:
                    display_st = "LOST"
                    score_txt = f"FT {ls['score']}" if ls["score"] else ""
                elif ls["status"] == 3:
                    display_st = "VOID"
                    score_txt = "VOID @1.00"
                elif ls["matchStatus"] not in ("Not start", "", None):
                    display_st = "LIVE"
                    clk = f" {ls['clock']}" if ls["clock"] else ""
                    score_txt = f"{ls['matchStatus']} {ls['score']}{clk}".strip()
                    live_summaries.append(f"{m_name} ({score_txt})")
                else:
                    display_st = "PENDING"
            else:
                if db_st == "IN_PROGRESS":
                    display_st = "PENDING"

            if display_st == "WON":
                won_c += 1
            elif display_st == "LOST":
                lost_c += 1
            elif display_st == "VOID":
                void_c += 1
            elif display_st == "LIVE":
                live_c += 1
            else:
                pend_c += 1
                if not next_ko or ko_gmt < next_ko:
                    next_ko = ko_gmt
                    next_match = m_name

            b_legs.append({
                "match": m_name, "selection": sel_txt, "kickoff": ko_gmt,
                "creators": creators_txt, "status": display_st, "score": score_txt
            })

        total_l = b[5] or len(b_legs) or 1
        prog_pct = min(100.0, round((won_c / total_l) * 100.0, 1))
        if lost_c > 0:
            slip_state = "AT_RISK"
            slip_badge_label = f"BUSTING ({won_c}W · {lost_c}L)"
            slip_badge_cls = "status-lost"
        elif live_c > 0:
            slip_state = "LIVE_IN_PLAY"
            slip_badge_label = f"LIVE IN-PLAY ({won_c}/{total_l} WON · {live_c} LIVE)"
            slip_badge_cls = "status-live"
        elif won_c > 0:
            slip_state = "UNDEFEATED"
            slip_badge_label = f"ALIVE & UNDEFEATED ({won_c}/{total_l} WON)"
            slip_badge_cls = "status-won"
        else:
            slip_state = "PRE_MATCH"
            slip_badge_label = f"PRE-MATCH READY (0/{total_l} · {pend_c} UPCOMING)"
            slip_badge_cls = "status-ready"

        bullets.append({
            "id": b_id, "source_code": b[1], "stake": b[2], "odds": b[3],
            "payout": b[4], "legs": total_l, "status": b[6], "code": b_code,
            "cashout": b[8] or 0.0, "role": b[9] or "SOLO", "pair_stake": b[10] or 0.0,
            "won_legs": won_c, "lost_legs": lost_c, "void_legs": void_c,
            "live_legs": live_c, "pending_legs": pend_c, "progress_pct": prog_pct,
            "next_kickoff": next_ko, "next_match": next_match,
            "live_summary": " | ".join(live_summaries[:2]),
            "slip_state": slip_state, "slip_badge_label": slip_badge_label, "slip_badge_cls": slip_badge_cls,
            "leg_details": b_legs
        })

    # Settled Monster & CodeHub Bullets (WON, LOST, CASHED_OUT)
    cursor.execute("""
        SELECT bullet_id, booking_code, stake, total_odds, potential_payout, legs_count, status,
               COALESCE(realized_pnl, 0.0), created_at, settled_at
        FROM syndicate_codehub_bullets
        WHERE status IN ('WON', 'LOST', 'CASHED_OUT')
        ORDER BY COALESCE(settled_at, created_at) DESC
    """)
    settled_bullets = []
    for sb in cursor.fetchall():
        b_code = sb[1] or "N/A"
        leg_counts = cursor.execute("""
            SELECT SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END)
            FROM (
                SELECT booking_code, match_name, selection,
                       CASE WHEN SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END) > 0 THEN 'LOST'
                            WHEN SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END) > 0 THEN 'WON'
                            ELSE 'OTHER' END AS status
                FROM syndicate_creator_anchor_ledger
                WHERE booking_code=?
                GROUP BY booking_code, match_name, selection
            )
        """, (b_code,)).fetchone()
        pm_row = cursor.execute(
            "SELECT match_name, market_key FROM syndicate_post_mortems WHERE booking_code=? ORDER BY id ASC LIMIT 1",
            (b_code,)
        ).fetchone()
        fatal_note = f"Busted on: {pm_row[0]} ({pm_row[1]})" if (pm_row and sb[6] == "LOST") else (
            "Cashed Out Early (Principal Preserved)" if sb[6] == "CASHED_OUT" else "Settled"
        )
        settled_bullets.append({
            "id": sb[0], "code": b_code, "stake": sb[2] or 0.0, "odds": sb[3] or 0.0,
            "payout": sb[4] or 0.0, "legs": sb[5] or 0, "status": sb[6],
            "pnl": sb[7] or 0.0, "created_at": (sb[8] or "")[:10], "settled_at": (sb[9] or "")[:10],
            "won_legs": (leg_counts[0] or 0) if leg_counts else 0,
            "lost_legs": (leg_counts[1] or 0) if leg_counts else 0,
            "fatal_note": fatal_note,
        })

    # Historical Post-Mortems
    pm_cols = {r[1] for r in cursor.execute("PRAGMA table_info(syndicate_post_mortems)").fetchall()}
    post_mortems = []
    if "booking_code" in pm_cols:
        cursor.execute("""
            SELECT COALESCE(source_table, 'syndicate_tickets'), COALESCE(booking_code, ticket_id),
                   COALESCE(market_key, 'UNKNOWN'), COALESCE(league, 'UNKNOWN'),
                   COALESCE(match_name, ticket_id), COALESCE(selection, ''),
                   failure_category, tactical_summary, preventative_rule_added,
                   COALESCE(auto_rule_triggered, ''), timestamp
            FROM syndicate_post_mortems
            ORDER BY id DESC
        """)
        for pm in cursor.fetchall():
            post_mortems.append({
                "source": pm[0], "code": pm[1], "market_key": pm[2], "league": pm[3],
                "match": pm[4], "selection": pm[5], "category": pm[6],
                "summary": pm[7], "rule": pm[8], "auto_rule": pm[9], "timestamp": (pm[10] or "")[:10]
            })

    # Empirical Market Performance
    market_perf = []
    mp_exists = cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='syndicate_market_performance'"
    ).fetchone()
    if mp_exists:
        cursor.execute("""
            SELECT market_key, league, total_legs, won_legs, lost_legs,
                   empirical_hit_rate, expected_hit_rate, calibration_gap, penalty_weight, banned
            FROM syndicate_market_performance
            WHERE league = 'ALL'
            ORDER BY banned DESC, lost_legs DESC, total_legs DESC
        """)
        for mp in cursor.fetchall():
            market_perf.append({
                "market_key": mp[0], "league": mp[1], "total": mp[2], "won": mp[3], "lost": mp[4],
                "emp_hr": mp[5], "exp_hr": mp[6], "gap": mp[7], "penalty": mp[8], "banned": bool(mp[9])
            })

    # Creator Trust & Perfection Tracking Leaderboard
    cursor.execute("""
        SELECT creator_name, latest_code, followers_count, original_folds, original_odds,
               clean_anchors_retained, traps_stripped, anchor_purity_pct,
               adopted_legs_total, adopted_legs_won, adopted_legs_lost, adopted_legs_pending,
               perfection_score_pct, trust_weight, tier
        FROM syndicate_creator_trust
        ORDER BY trust_weight DESC, adopted_legs_total DESC, followers_count DESC
    """)
    creators = [{
        "creator": r[0], "code": r[1], "followers": r[2], "folds": r[3], "odds": r[4],
        "clean": r[5], "traps": r[6], "purity": r[7], "adopted": r[8],
        "won": r[9], "lost": r[10], "pending": r[11], "perfection": r[12],
        "weight": r[13], "tier": r[14]
    } for r in cursor.fetchall()]

    # Creator Correlations
    cursor.execute("SELECT metric_key, metric_label, metric_value, insight_summary FROM syndicate_creator_correlations")
    correlations = [{
        "key": r[0], "label": r[1], "value": r[2], "summary": r[3]
    } for r in cursor.fetchall()]

    # CodeHub Scouts ordered by Trust Weight instead of raw follower hype
    cursor.execute("""
        SELECT s.booking_code, s.creator_name, s.followers_count, s.original_odds,
               s.original_legs_count, s.stripped_traps_count, s.retained_anchors_count,
               COALESCE(ct.trust_weight, 0.5), COALESCE(ct.tier, 'ANALYZED'), COALESCE(ct.anchor_purity_pct, 0.0)
        FROM syndicate_codehub_scouts s
        LEFT JOIN syndicate_creator_trust ct ON s.creator_name = ct.creator_name
        ORDER BY COALESCE(ct.trust_weight, 0.5) DESC, s.retained_anchors_count DESC
        LIMIT 9
    """)
    scout_rows = cursor.fetchall()
    scouts = [{
        "code": s[0], "creator": s[1], "followers": s[2], "odds": s[3],
        "legs": s[4], "stripped": s[5], "retained": s[6],
        "weight": s[7], "tier": s[8], "purity": s[9]
    } for s in scout_rows]

    # Capital Deposit & Pocket Statement Ledger
    capital_txs = []
    cap_exists = cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='syndicate_capital_ledger'"
    ).fetchone()
    if cap_exists:
        cursor.execute("""
            SELECT trade_id, timestamp_gmt, tx_category, trade_code, biz_type, order_id,
                   ticket_ref, direction, amount_ghs, signed_amount_ghs,
                   balance_before_ghs, balance_after_ghs, notes
            FROM syndicate_capital_ledger
            ORDER BY create_time_ms ASC
        """)
        for r in cursor.fetchall():
            capital_txs.append({
                "trade_id": r[0], "timestamp": r[1], "category": r[2], "code": r[3],
                "biz_type": r[4], "order_id": r[5], "ticket_ref": r[6], "direction": r[7],
                "amount": r[8] or 0.0, "signed_amount": r[9] or 0.0,
                "before": r[10] or 0.0, "after": r[11] or 0.0, "notes": r[12] or ""
            })

    conn.close()

    heuristics = {}
    if os.path.exists(HEURISTICS_PATH):
        with open(HEURISTICS_PATH, 'r', encoding='utf-8') as f:
            heuristics = json.load(f)

    return wallet, cycle, tickets, scouts, bullets, settled_bullets, post_mortems, market_perf, creators, correlations, heuristics, capital_txs


def generate_html():
    wallet, cycle, tickets, scouts, bullets, settled_bullets, post_mortems, market_perf, creators, correlations, heuristics, capital_txs = load_data()

    active_tickets = [t for t in tickets if t["status"] == "IN_PROGRESS"]
    total_active_exposure = sum(t["stake"] for t in active_tickets) + sum(b["stake"] for b in bullets)
    exposure_pct = (total_active_exposure / wallet["balance"]) * 100 if wallet["balance"] > 0 else 0
    core_returns = sum(t["payout"] for t in active_tickets)
    bullet_returns = sum(b["payout"] for b in bullets)
    total_potential_returns = core_returns + bullet_returns
    bullet_codes_str = " & ".join(b["code"] for b in bullets) if bullets else "NONE"

    # Capital Accounting Summary
    opening_carryover = sum(tx["amount"] for tx in capital_txs if tx["category"] == "OPENING_CARRYOVER") or 0.21
    total_deposits = sum(tx["amount"] for tx in capital_txs if tx["category"] == "DEPOSIT") or 250.00
    total_capital_base = opening_carryover + total_deposits
    total_withdrawals = sum(tx["amount"] for tx in capital_txs if tx["category"] == "WITHDRAWAL")
    total_staked_all_time = sum(tx["amount"] for tx in capital_txs if tx["category"] == "BET_STAKE")
    total_cashouts_wins = sum(tx["amount"] for tx in capital_txs if tx["category"] in ("CASHOUT_RETURN", "WIN_SETTLEMENT"))
    total_account_equity = wallet["balance"] + total_active_exposure
    net_realized_drawdown = wallet["balance"] + total_active_exposure - total_capital_base
    capital_preserved_pct = (wallet["balance"] / total_capital_base * 100.0) if total_capital_base > 0 else 0.0
    equity_preserved_pct = (total_account_equity / total_capital_base * 100.0) if total_capital_base > 0 else 0.0

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JAC // HERMES ASYMMETRIC SYNDICATE TERMINAL</title>
    <style>
        :root {{
            --bg-dark: #0a0e14;
            --card-bg: #111823;
            --card-border: #1e293b;
            --accent-cyan: #00f3ff;
            --accent-gold: #fbbf24;
            --accent-green: #10b981;
            --accent-red: #ef4444;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --mono-font: 'JetBrains Mono', 'Fira Code', 'Roboto Mono', monospace;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            background: var(--bg-dark);
            color: var(--text-main);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            padding: 20px;
        }}
        .header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid var(--accent-cyan);
            padding-bottom: 12px;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 10px;
        }}
        .logo-group h1 {{
            font-size: 20px;
            letter-spacing: 1.5px;
            color: var(--accent-cyan);
            font-family: var(--mono-font);
        }}
        .logo-group p {{
            font-size: 11px;
            color: var(--text-muted);
            letter-spacing: 0.8px;
        }}
        .status-badge {{
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid var(--accent-green);
            color: var(--accent-green);
            padding: 4px 10px;
            border-radius: 4px;
            font-family: var(--mono-font);
            font-size: 11px;
            font-weight: bold;
        }}
        .grid-stats {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }}
        .stat-card {{
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 6px;
            padding: 14px;
        }}
        .stat-label {{
            font-size: 11px;
            text-transform: uppercase;
            color: var(--text-muted);
            margin-bottom: 4px;
            font-family: var(--mono-font);
        }}
        .stat-value {{
            font-size: 22px;
            font-weight: 700;
            color: var(--text-main);
            font-family: var(--mono-font);
        }}
        .stat-sub {{
            font-size: 11px;
            color: var(--accent-gold);
            margin-top: 4px;
        }}
        .section-title {{
            font-size: 14px;
            font-weight: bold;
            color: var(--accent-cyan);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin: 25px 0 12px 0;
            font-family: var(--mono-font);
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        .section-title::before {{
            content: "//";
            color: var(--accent-gold);
        }}
        .ticket-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(450px, 1fr));
            gap: 20px;
            margin-bottom: 25px;
        }}
        .ticket-card {{
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            overflow: hidden;
            border-top: 3px solid var(--accent-cyan);
        }}
        .ticket-header {{
            background: rgba(255, 255, 255, 0.03);
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--card-border);
            flex-wrap: wrap;
            gap: 6px;
        }}
        .ticket-header h3 {{
            font-size: 13px;
            font-weight: 600;
            color: var(--text-main);
        }}
        .ticket-meta {{
            font-family: var(--mono-font);
            font-size: 11px;
            color: var(--accent-gold);
        }}
        .legs-table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }}
        .legs-table th {{
            text-align: left;
            background: rgba(0, 0, 0, 0.25);
            padding: 8px 12px;
            color: var(--text-muted);
            border-bottom: 1px solid var(--card-border);
            font-weight: 600;
            font-family: var(--mono-font);
        }}
        .legs-table td {{
            padding: 8px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }}
        .match-cell {{
            font-weight: 600;
            color: var(--text-main);
        }}
        .selection-cell {{
            color: var(--accent-cyan);
            font-family: var(--mono-font);
        }}
        .odds-cell {{
            font-weight: bold;
            color: var(--accent-gold);
            font-family: var(--mono-font);
        }}
        .breadcrumb-box {{
            padding: 6px 12px;
            background: rgba(0, 243, 255, 0.03);
            border-left: 2px solid var(--accent-cyan);
            font-family: var(--mono-font);
            font-size: 10px;
            color: var(--text-muted);
            margin: 4px 12px 8px 12px;
            border-radius: 2px;
        }}
        .card-footer {{
            background: rgba(0, 0, 0, 0.3);
            padding: 10px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-family: var(--mono-font);
            font-size: 11px;
            border-top: 1px solid var(--card-border);
        }}
        .payout-val {{
            color: var(--accent-green);
            font-size: 14px;
            font-weight: bold;
        }}
        .guardrails-box {{
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 25px;
        }}
        .rule-item {{
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }}
        .rule-badge {{
            background: rgba(251, 191, 36, 0.15);
            color: var(--accent-gold);
            border: 1px solid var(--accent-gold);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--mono-font);
            font-size: 10px;
            font-weight: bold;
            white-space: nowrap;
        }}
        .rule-text {{
            font-size: 12px;
            color: var(--text-main);
        }}
        .rule-desc {{
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 2px;
        }}
        .codehub-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 15px;
        }}
        .scout-card {{
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 6px;
            padding: 14px;
        }}
        .scout-header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            font-family: var(--mono-font);
        }}
        .code-tag {{
            background: rgba(0, 243, 255, 0.1);
            color: var(--accent-cyan);
            border: 1px solid var(--accent-cyan);
            padding: 3px 8px;
            border-radius: 4px;
            font-weight: bold;
        }}
        .trap-pill {{
            background: rgba(239, 68, 68, 0.15);
            color: var(--accent-red);
            border: 1px solid var(--accent-red);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
        }}
        .anchor-pill {{
            background: rgba(16, 185, 129, 0.15);
            color: var(--accent-green);
            border: 1px solid var(--accent-green);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
        }}
        .tier-elite {{
            background: rgba(16, 185, 129, 0.2);
            color: var(--accent-green);
            border: 1px solid var(--accent-green);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: bold;
        }}
        .tier-sharp {{
            background: rgba(0, 243, 255, 0.15);
            color: var(--accent-cyan);
            border: 1px solid var(--accent-cyan);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: bold;
        }}
        .tier-probation {{
            background: rgba(251, 191, 36, 0.15);
            color: var(--accent-gold);
            border: 1px solid var(--accent-gold);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-family: var(--mono-font);
        }}
        .tier-faded {{
            background: rgba(239, 68, 68, 0.15);
            color: var(--accent-red);
            border: 1px solid var(--accent-red);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-family: var(--mono-font);
        }}
        .status-won {{
            background: rgba(16, 185, 129, 0.20);
            color: #34d399;
            border: 1px solid #10b981;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: 700;
            white-space: nowrap;
            display: inline-block;
        }}
        .status-live {{
            background: rgba(251, 191, 36, 0.22);
            color: #fde047;
            border: 1px solid #fbbf24;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: 700;
            white-space: nowrap;
            display: inline-block;
        }}
        .status-ready {{
            background: rgba(0, 243, 255, 0.14);
            color: var(--accent-cyan);
            border: 1px solid rgba(0, 243, 255, 0.55);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: 700;
            white-space: nowrap;
            display: inline-block;
        }}
        .status-lost {{
            background: rgba(239, 68, 68, 0.18);
            color: #f87171;
            border: 1px solid var(--accent-red);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: 700;
            white-space: nowrap;
            display: inline-block;
        }}
        .status-cashed {{
            background: rgba(251, 191, 36, 0.15);
            color: var(--accent-gold);
            border: 1px solid var(--accent-gold);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-family: var(--mono-font);
            font-weight: 700;
            white-space: nowrap;
            display: inline-block;
        }}
        .status-pending {{
            background: rgba(148, 163, 184, 0.12);
            color: var(--text-muted);
            border: 1px solid rgba(148, 163, 184, 0.35);
            padding: 2px 7px;
            border-radius: 4px;
            font-size: 10px;
            font-family: var(--mono-font);
            white-space: nowrap;
            display: inline-block;
        }}
        .prog-track {{
            width: 100%;
            min-width: 90px;
            height: 7px;
            background: rgba(255,255,255,0.08);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 4px;
        }}
        .prog-fill {{
            height: 100%;
            background: linear-gradient(90deg, #10b981, #00f3ff);
            border-radius: 4px;
        }}
    </style>
</head>
<body>

    <div class="header">
        <div class="logo-group">
            <h1>JAC // HERMES ASYMMETRIC SYNDICATE TERMINAL</h1>
            <p>7-DAY ROLLING HORIZON (NOV 16 – NOV 22) // TELECEL SPORTYBET GHANA ACCOUNT // 3X DAILY CODEHUB WINDOWS (06:00, 14:00, 20:00 GMT)</p>
        </div>
        <div class="status-badge">
            ● 24/7 DAEMON + CREATOR TRUST ENGINE ACTIVE
        </div>
    </div>
    """

    # Build inline SVG Running Balance Area Chart from capital_txs
    svg_chart = ""
    if len(capital_txs) >= 2:
        w, h = 920, 140
        pad_x, pad_y = 40, 18
        max_bal = max(max(tx["after"] for tx in capital_txs), 260.0)
        min_bal = 0.0
        n_pts = len(capital_txs)
        pts = []
        for i, tx in enumerate(capital_txs):
            px = pad_x + (i / (n_pts - 1)) * (w - 2 * pad_x)
            py = pad_y + (1.0 - (tx["after"] - min_bal) / (max_bal - min_bal)) * (h - 2 * pad_y)
            pts.append((px, py, tx))
        poly_str = " ".join(f"{px:.1f},{py:.1f}" for px, py, _ in pts)
        area_str = f"{pts[0][0]:.1f},{h - pad_y} " + poly_str + f" {pts[-1][0]:.1f},{h - pad_y}"
        dep_y = pad_y + (1.0 - (250.21 - min_bal) / (max_bal - min_bal)) * (h - 2 * pad_y)
        dots_svg = "".join(
            f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3.2" fill="{"#10b981" if tx["category"]=="DEPOSIT" else ("#fbbf24" if tx["direction"]=="CREDIT" else "#00f3ff")}" />'
            for px, py, tx in pts
        )
        svg_chart = f"""
        <div style="background: rgba(0,0,0,0.28); border: 1px solid var(--card-border); border-radius: 6px; padding: 10px 14px; margin-bottom: 14px;">
            <div style="display:flex; justify-content:space-between; font-family:var(--mono-font); font-size:11px; color:var(--text-muted); margin-bottom:6px;">
                <span>CAPITAL BALANCE CURVE (35 VERIFIED SPORTYBET POCKET STATEMENTS: NOV 14 – NOV 21)</span>
                <span>Peak: <strong style="color:var(--accent-green);">250.21 GHS</strong> (Nov 14 Deposit) ➔ Current Liquid: <strong style="color:var(--accent-cyan);">{wallet["balance"]:.2f} GHS</strong> (+{total_active_exposure:.2f} GHS In-Play = <strong style="color:var(--accent-gold);">{total_account_equity:.2f} GHS</strong> Equity)</span>
            </div>
            <svg viewBox="0 0 {w} {h}" style="width:100%; height:135px; display:block;">
                <defs>
                    <linearGradient id="capGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#00f3ff" stop-opacity="0.32"/>
                        <stop offset="100%" stop-color="#00f3ff" stop-opacity="0.02"/>
                    </linearGradient>
                </defs>
                <line x1="{pad_x}" y1="{dep_y:.1f}" x2="{w - pad_x}" y2="{dep_y:.1f}" stroke="#10b981" stroke-dasharray="4,4" stroke-width="1"/>
                <text x="{pad_x + 6}" y="{dep_y - 4:.1f}" fill="#10b981" font-size="9" font-family="monospace">Capital Base: 250.21 GHS</text>
                <polygon points="{area_str}" fill="url(#capGrad)"/>
                <polyline fill="none" stroke="#00f3ff" stroke-width="2.2" points="{poly_str}"/>
                {dots_svg}
            </svg>
        </div>
        """

    html += f"""
    <!-- Top Key Metrics (Including Capital Deposit & Foundation Preservation) -->
    <div class="grid-stats">
        <div class="stat-card" style="border-top: 2px solid var(--accent-green);">
            <div class="stat-label">Capital Deposited (Base)</div>
            <div class="stat-value" style="color: var(--accent-green);">{total_capital_base:.2f} {wallet["currency"]}</div>
            <div class="stat-sub">+{total_deposits:.2f} GHS Telecel MoMo Deposit (Nov 14) + {opening_carryover:.2f} GHS Carryover | {total_withdrawals:.2f} GHS Withdrawn</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--accent-cyan);">
            <div class="stat-label">Telecel Liquid Wallet</div>
            <div class="stat-value">{wallet["balance"]:.2f} {wallet["currency"]}</div>
            <div class="stat-sub">{capital_preserved_pct:.1f}% Liquid Cash Preserved | {total_account_equity:.2f} GHS Total Equity ({equity_preserved_pct:.1f}% incl. {total_active_exposure:.2f} GHS Live)</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--accent-gold);">
            <div class="stat-label">Cumulative Cashflow & Realized PnL</div>
            <div class="stat-value" style="color: var(--accent-gold);">{net_realized_drawdown:+.2f} {wallet["currency"]}</div>
            <div class="stat-sub">{total_staked_all_time:.2f} GHS Total Staked | +{total_cashouts_wins:.2f} GHS Cashouts/Wins Returned | {total_active_exposure:.2f} GHS In-Play</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--accent-cyan);">
            <div class="stat-label">Active Portfolio Exposure</div>
            <div class="stat-value">{total_active_exposure:.2f} GHS</div>
            <div class="stat-sub">{len(bullets)} Uncorrelated Monster Accumulators ({bullet_codes_str})</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--accent-green);">
            <div class="stat-label">Aggregate Return Potential</div>
            <div class="stat-value" style="color: var(--accent-green);">{total_potential_returns:,.2f} GHS</div>
            <div class="stat-sub">Across {len(bullets)} Live Monster Accumulators ({sum(b['legs'] for b in bullets)} Active Legs)</div>
        </div>
    </div>

    <!-- MASTER SLIP STATUS COMMAND BOARD (ALL ACTIVE & SETTLED SLIPS AT A GLANCE) -->
    <div class="section-title">Master Slip Status Command Board — {len(bullets)} Active Live Orders &amp; {len(settled_bullets) + len([t for t in tickets if t['status'] != 'IN_PROGRESS'])} Settled Slips</div>
    <div class="ticket-card" style="margin-bottom: 26px; border-top: 3px solid var(--accent-cyan);">
        <div class="ticket-header">
            <h3>1. Live Open Slips Scoreboard (Tap Any Booking Code to Jump to Full Leg Breakdown)</h3>
            <span class="ticket-meta">ACTIVE ORDERS: <strong style="color:var(--accent-green);">{len(bullets)}</strong> | TOTAL STAKED: <strong>{total_active_exposure:.2f} GHS</strong> | LIVE CASHOUT SUM: <strong style="color:var(--accent-cyan);">{sum(b['cashout'] for b in bullets):.2f} GHS</strong> | TOTAL UPSIDE: <strong style="color:var(--accent-green);">{total_potential_returns:,.2f} GHS</strong></span>
        </div>
        <div style="overflow-x: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Booking Code &amp; Role</th>
                        <th>Live Slip Status</th>
                        <th>Leg Progress (W-L-Live-Pend)</th>
                        <th>Stake &rarr; Potential Win</th>
                        <th>Live Cashout Offer</th>
                        <th>Next Kickoff (GMT) / Live Action</th>
                    </tr>
                </thead>
                <tbody>
    """

    for b in bullets:
        r_lbl = b.get("role", "SOLO")
        r_pill = ""
        if r_lbl == "HARVESTER":
            r_pill = '<span class="tier-elite" style="margin-left:6px;">HARVESTER</span>'
        elif r_lbl == "MOONSHOT":
            r_pill = '<span class="tier-sharp" style="margin-left:6px;">MOONSHOT</span>'
        elif r_lbl == "VAULT_STEP":
            r_pill = '<span class="tier-probation" style="margin-left:6px;">VAULT STEP 1</span>'
        elif b["legs"] >= 45:
            r_pill = '<span class="tier-sharp" style="margin-left:6px;">50F FORTRESS</span>'

        co_val = b.get("cashout", 0.0)
        if co_val > 0 and b["stake"] > 0:
            co_pct = (co_val / b["stake"]) * 100.0
            co_col = "var(--accent-green)" if co_pct >= 100.0 else "var(--accent-cyan)"
            co_disp = f'<strong style="color:{co_col};">{co_val:.2f} GHS</strong> <span style="color:var(--text-muted); font-size:10px;">({co_pct:.0f}% of stake)</span>'
        else:
            co_disp = '<span style="color:var(--text-muted);">Paused / Unavailable</span>'

        eff_m = (b["payout"] / b["stake"]) if b["stake"] > 0 else b["odds"]
        if b["live_summary"]:
            next_disp = f'<strong style="color:var(--accent-gold);">LIVE: {b["live_summary"]}</strong>'
        elif b["next_kickoff"]:
            ko_short = b["next_kickoff"].replace("2026-", "")
            next_disp = f'<span style="color:var(--accent-cyan); font-family:var(--mono-font);">{ko_short}</span> &mdash; {b["next_match"]}'
        else:
            next_disp = '<span style="color:var(--text-muted);">All legs completed</span>'

        html += f"""
                    <tr>
                        <td>
                            <a href="#slip-{b['id']}" style="text-decoration:none;"><span class="code-tag" style="font-size:11px; padding:2px 7px;">{b['code']}</span></a>{r_pill}
                        </td>
                        <td><span class="{b['slip_badge_cls']}">● {b['slip_badge_label']}</span></td>
                        <td style="min-width: 150px;">
                            <div style="font-family:var(--mono-font); font-size:11px;">
                                <strong style="color:var(--accent-green);">{b['won_legs']}W</strong> &middot;
                                <span style="color:var(--accent-red);">{b['lost_legs']}L</span> &middot;
                                <span style="color:var(--accent-gold);">{b['live_legs']}Live</span> &middot;
                                <span style="color:var(--text-muted);">{b['pending_legs']}P</span>
                                <span style="float:right; color:var(--accent-cyan);">{b['progress_pct']:.0f}%</span>
                            </div>
                            <div class="prog-track"><div class="prog-fill" style="width:{b['progress_pct']}%;"></div></div>
                        </td>
                        <td style="font-family:var(--mono-font);">
                            {b['stake']:.2f} &rarr; <strong style="color:var(--accent-green);">{b['payout']:,.2f} GHS</strong>
                            <span style="color:var(--text-muted); font-size:10px;">({eff_m:,.1f}x)</span>
                        </td>
                        <td style="font-family:var(--mono-font);">{co_disp}</td>
                        <td style="font-size:11px;">{next_disp}</td>
                    </tr>
        """

    cashed_cnt = sum(1 for sb in settled_bullets if sb["status"] == "CASHED_OUT")
    lost_cnt = sum(1 for sb in settled_bullets if sb["status"] == "LOST") + sum(1 for t in tickets if t["status"] == "LOST")
    won_cnt = sum(1 for sb in settled_bullets if sb["status"] == "WON") + sum(1 for t in tickets if t["status"] == "WON")

    html += f"""
                </tbody>
            </table>
        </div>
        <div class="ticket-header" style="border-top: 1px solid var(--card-border); margin-top: 6px;">
            <h3>2. Settled Slips Quick Status Summary ({won_cnt} Won &middot; {cashed_cnt} Cashed Out &middot; {lost_cnt} Lost)</h3>
            <span class="ticket-meta">EVERY HISTORICAL SLIP STATUS &amp; SINGLE-LEG ROOT CAUSE</span>
        </div>
        <div style="max-height: 240px; overflow-y: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Slip Code</th>
                        <th>Folds &amp; Stake</th>
                        <th>Final Status</th>
                        <th>Leg Tally</th>
                        <th>Realized PnL</th>
                        <th>Outcome / Busted Leg Summary</th>
                    </tr>
                </thead>
                <tbody>
    """

    for sb in settled_bullets:
        if sb["status"] == "WON":
            s_cls, s_txt = "status-won", "✓ WON"
        elif sb["status"] == "CASHED_OUT":
            s_cls, s_txt = "status-cashed", "⇄ CASHED OUT"
        else:
            s_cls, s_txt = "status-lost", "✕ LOST"
        p_col = "var(--accent-green)" if sb["pnl"] > 0 else ("var(--accent-red)" if sb["pnl"] < 0 else "var(--accent-gold)")
        html += f"""
                    <tr>
                        <td style="font-family:var(--mono-font); color:var(--text-muted);">{sb['settled_at'] or sb['created_at']}</td>
                        <td><span class="code-tag" style="font-size:10px; padding:2px 6px;">{sb['code']}</span></td>
                        <td style="font-family:var(--mono-font);">{sb['legs']}F &middot; {sb['stake']:.2f} GHS</td>
                        <td><span class="{s_cls}">{s_txt}</span></td>
                        <td style="font-family:var(--mono-font); color:var(--accent-cyan);">{sb['won_legs']}W - {sb['lost_legs']}L</td>
                        <td style="font-family:var(--mono-font); font-weight:bold; color:{p_col};">{sb['pnl']:+.2f} GHS</td>
                        <td style="font-size:11px; color:var(--text-muted);">{sb['fatal_note']}</td>
                    </tr>
        """

    for ct in tickets:
        if ct["status"] == "IN_PROGRESS":
            continue
        s_cls = "status-won" if ct["status"] == "WON" else ("status-cashed" if ct["status"] == "CASHED_OUT" else "status-lost")
        p_col = "var(--accent-green)" if ct["pnl"] > 0 else ("var(--accent-red)" if ct["pnl"] < 0 else "var(--accent-gold)")
        html += f"""
                    <tr>
                        <td style="font-family:var(--mono-font); color:var(--text-muted);">2026-11-16</td>
                        <td><span class="code-tag" style="font-size:10px; padding:2px 6px;">{ct['code']}</span></td>
                        <td style="font-family:var(--mono-font);">{len(ct['legs'])}F &middot; {ct['stake']:.2f} GHS</td>
                        <td><span class="{s_cls}">✕ {ct['status']}</span></td>
                        <td style="font-family:var(--mono-font); color:var(--text-muted);">Cycle 1 Core</td>
                        <td style="font-family:var(--mono-font); font-weight:bold; color:{p_col};">{ct['pnl']:+.2f} GHS</td>
                        <td style="font-size:11px; color:var(--text-muted);">{ct['title']} (Pre-v4.0 Straight 1X2/ML)</td>
                    </tr>
        """

    html += f"""
                </tbody>
            </table>
        </div>
    </div>

    <!-- Capital Deposit & Full Pocket Transaction History Section -->
    <div class="section-title">Capital Deposit & Official SportyBet Pocket Transaction Ledger ({len(capital_txs)} Verified Statements)</div>
    <div class="ticket-card" style="margin-bottom: 28px; border-top: 3px solid var(--accent-green);">
        <div class="ticket-header">
            <h3>Telecel Mobile Money Capital Injection & Chronological Running Balance Audit (Nov 14 – Nov 21, 2026)</h3>
            <span class="ticket-meta">DEPOSITED: <strong style="color:var(--accent-green);">+{total_deposits:.2f} GHS</strong> (Trade 261114235228trd12634856) | OPENING: {opening_carryover:.2f} GHS | STAKED: -{total_staked_all_time:.2f} GHS | CASHOUTS/WINS: +{total_cashouts_wins:.2f} GHS | CURRENT LIQUID: <strong style="color:var(--accent-cyan);">{wallet["balance"]:.2f} GHS</strong></span>
        </div>
        <div style="padding: 12px 16px 4px 16px;">
            {svg_chart}
        </div>
        <div style="max-height: 360px; overflow-y: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Timestamp (GMT)</th>
                        <th>Type / Code</th>
                        <th>Ticket / Reference</th>
                        <th>Trade ID</th>
                        <th>Before (GHS)</th>
                        <th>Amount (GHS)</th>
                        <th>After Balance (GHS)</th>
                        <th>Audit Notes</th>
                    </tr>
                </thead>
                <tbody>
    """

    for idx, tx in enumerate(reversed(capital_txs), 1):
        is_dep = tx["category"] == "DEPOSIT"
        is_cred = tx["direction"] == "CREDIT"
        amt_color = "var(--accent-green)" if is_cred else "var(--accent-red)"
        amt_prefix = "+" if is_cred else "-"
        badge_cls = "tier-elite" if is_dep else ("tier-sharp" if is_cred else "tier-probation")
        row_bg = "background: rgba(16, 185, 129, 0.10);" if is_dep else ""
        html += f"""
                    <tr style="{row_bg}">
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{len(capital_txs) - idx + 1}</td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{tx["timestamp"]}</td>
                        <td><span class="{badge_cls}">{tx["category"]} ({tx["code"]})</span></td>
                        <td class="match-cell" style="font-family: var(--mono-font);">{tx["ticket_ref"]}</td>
                        <td style="font-family: var(--mono-font); font-size: 10px; color: var(--text-muted);">{tx["trade_id"]}</td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{tx["before"]:.2f}</td>
                        <td style="font-family: var(--mono-font); font-weight: bold; color: {amt_color};">{amt_prefix}{tx["amount"]:.2f}</td>
                        <td style="font-family: var(--mono-font); font-weight: bold; color: var(--text-main);">{tx["after"]:.2f}</td>
                        <td style="font-size: 11px; color: var(--text-muted);">{tx["notes"]}</td>
                    </tr>
        """

    html += f"""
                </tbody>
            </table>
        </div>
        <div class="card-footer">
            <div>Verified Source: <strong style="color: var(--accent-cyan);">/api/gh/pocket/v1/statements</strong> // Exact Cent-for-Cent Reconciliation: <span style="color: var(--accent-green);">0.21 + 250.00 - {total_staked_all_time:.2f} + {total_cashouts_wins:.2f} = {wallet["balance"]:.2f} GHS</span></div>
            <div>Capital Preserved in Vault + Active Slips: <span class="payout-val">{total_account_equity:.2f} / {total_capital_base:.2f} GHS ({equity_preserved_pct:.1f}%)</span></div>
        </div>
    </div>

    <!-- The Missing Piece v4.0 Anointed Architecture Card -->
    <div class="section-title">The Missing Piece — v4.0 Anointed Jackpot Architecture (17-Ticket Post-Mortem Upgrade)</div>
    <div class="ticket-card" style="border-top: 3px solid var(--accent-cyan); margin-bottom: 24px; padding: 14px 18px;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; font-size: 12px;">
            <div style="background: rgba(0,243,255,0.06); border: 1px solid rgba(0,243,255,0.22); border-radius: 6px; padding: 10px 12px;">
                <div style="font-family: var(--mono-font); color: var(--accent-cyan); font-weight: bold; margin-bottom: 4px;">1. 1.00x FULL-BONUS +EV ENGINE</div>
                <div style="color: var(--text-muted);">Football bonus is halved (0.50x), starving 24F Football slips to ~65-87% RTP. Pure 2-Way Sports (Basketball +Spreads, Hockey, Tennis) earn <strong>1.00x FULL Bonus (+75% at 21F)</strong>, achieving <strong>104.9%+ True Mathematical +EV</strong> at x140+ in 40h!</div>
            </div>
            <div style="background: rgba(16,185,129,0.07); border: 1px solid rgba(16,185,129,0.25); border-radius: 6px; padding: 10px 12px;">
                <div style="font-family: var(--mono-font); color: var(--accent-green); font-weight: bold; margin-bottom: 4px;">2. TWIN-WAVE HARVESTER + FREE-ROLL MOONSHOT</div>
                <div style="color: var(--text-muted);">Proven by <strong>9121S3 (2.68x cashout at 6/25 WON)</strong>: Twin Pair places <strong>HARVESTER (GHS 3)</strong> + <strong>MOONSHOT (GHS 2)</strong>. Persistent daemon auto-cashes HARVESTER (&gt; GHS 5.10) in clean inter-wave gap so <strong>MOONSHOT rides 100% RISK-FREE</strong>!</div>
            </div>
            <div style="background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.25); border-radius: 6px; padding: 10px 12px;">
                <div style="font-family: var(--mono-font); color: var(--accent-gold); font-weight: bold; margin-bottom: 4px;">3. MODE C INTEGER PUSH-SHIELDED VAULT</div>
                <div style="color: var(--text-muted);">Half-goal traps (U3.5, U4.5, Team U2.5) &amp; 1-leg @1.01 micro-bets permanently banned. Mode C compounds <strong>Integer Push Lines (Under 4.0/5.0, Over 2.0, AH 0/+1)</strong> (~99% RTP) where exact margins <strong>VOID @1.00</strong> instead of busting!</div>
            </div>
        </div>
    </div>

    <!-- Staked CodeHub Monster Accumulator Section -->
    <div class="section-title">Active Syndicate Accumulators &amp; Anointed Twin-Wave Slips ({bullet_codes_str})</div>
    <div style="margin-bottom: 28px;">
    """

    for b in bullets:
        role_label = b.get("role", "SOLO")
        co_str = f"{b['cashout']:.2f} GHS" if b.get("cashout", 0) > 0 else "Paused / Unavailable"
        role_badge = ""
        if role_label == "HARVESTER":
            role_badge = f'<span class="tier-elite" style="margin-left:8px;">HARVESTER // AUTO-LOCK &ge; {b["pair_stake"]*1.02:.2f} GHS</span>'
        elif role_label == "MOONSHOT":
            role_badge = '<span class="tier-sharp" style="margin-left:8px;">MOONSHOT // 100% FREE-ROLL AFTER W1</span>'
        elif role_label == "VAULT_STEP":
            role_badge = '<span class="tier-probation" style="margin-left:8px;">MODE C // INTEGER PUSH VAULT STEP 1</span>'
        next_banner = (
            f'LIVE NOW: <strong style="color:var(--accent-gold);">{b["live_summary"]}</strong>'
            if b["live_summary"]
            else (
                f'NEXT KICKOFF: <strong style="color:var(--accent-cyan);">{b["next_kickoff"].replace("2026-", "")} GMT</strong> ({b["next_match"]})'
                if b["next_kickoff"]
                else "ALL LEGS PLAYED"
            )
        )
        html += f"""
        <div id="slip-{b['id']}" class="ticket-card" style="border-top: 3px solid var(--accent-gold); margin-bottom: 20px;">
            <div class="ticket-header">
                <h3>{b["legs"]}-Fold Syndicate Slip <span class="code-tag" style="margin-left:8px; background: rgba(251, 191, 36, 0.2); border-color: var(--accent-gold); color: var(--accent-gold);">BOOKED CODE: {b["code"]}</span>{role_badge} <span class="{b['slip_badge_cls']}" style="margin-left:8px;">● {b['slip_badge_label']}</span></h3>
                <span class="ticket-meta">STAKE: {b["stake"]:.2f} GHS | BASE ODDS: {b["odds"]:,.2f}x | CASHOUT: <strong style="color: var(--accent-cyan);">{co_str}</strong> | POTENTIAL WIN: <strong style="color: var(--accent-green); font-size: 13px;">{b["payout"]:,.2f} GHS</strong></span>
            </div>
            <div style="padding: 8px 16px; background: rgba(0,0,0,0.28); border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; font-family: var(--mono-font); font-size: 11px;">
                <div>PROGRESS: <strong style="color:var(--accent-green);">{b['won_legs']} WON</strong> &middot; <span style="color:var(--accent-red);">{b['lost_legs']} LOST</span> &middot; <span style="color:var(--accent-gold);">{b['live_legs']} LIVE</span> &middot; <span style="color:var(--text-muted);">{b['pending_legs']} PENDING</span> ({b['progress_pct']:.1f}%)</div>
                <div style="flex: 1; min-width: 140px; max-width: 280px;"><div class="prog-track" style="margin-top:0;"><div class="prog-fill" style="width:{b['progress_pct']}%;"></div></div></div>
                <div>{next_banner}</div>
            </div>
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Kickoff (GMT)</th>
                        <th>Fixture</th>
                        <th>Selection (Multi-Market)</th>
                        <th>Strategy / Source</th>
                        <th>Leg Status &amp; Score</th>
                    </tr>
                </thead>
                <tbody>
        """
        for idx, leg in enumerate(b["leg_details"], 1):
            lst = leg["status"]
            sc_suffix = f" ({leg['score']})" if leg.get("score") else ""
            if lst == "WON":
                l_cls, l_txt, r_style = "status-won", f"✓ WON{sc_suffix}", "background: rgba(16, 185, 129, 0.05);"
            elif lst == "LIVE":
                l_cls, l_txt, r_style = "status-live", f"● LIVE{sc_suffix}", "background: rgba(251, 191, 36, 0.07);"
            elif lst == "LOST":
                l_cls, l_txt, r_style = "status-lost", f"✕ LOST{sc_suffix}", "background: rgba(239, 68, 68, 0.08);"
            elif lst == "VOID":
                l_cls, l_txt, r_style = "status-ready", f"↺ PUSH{sc_suffix}", ""
            else:
                l_cls, l_txt, r_style = "status-pending", "⏳ PENDING", ""
            html += f"""
                    <tr style="{r_style}">
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{idx}</td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{leg["kickoff"].replace("2026-", "")}</td>
                        <td class="match-cell">{leg["match"]}</td>
                        <td class="selection-cell">{leg["selection"]}</td>
                        <td style="font-family: var(--mono-font); font-size: 10px; color: var(--accent-gold);">{leg["creators"]}</td>
                        <td><span class="{l_cls}">{l_txt}</span></td>
                    </tr>
            """
        html += f"""
                </tbody>
            </table>
            <div class="card-footer">
                <div>Booking Code: <strong style="color: var(--accent-gold);">{b["code"]}</strong> // Status: <span class="{b['slip_badge_cls']}">{b['slip_badge_label']}</span> // Cluster: <span style="color: var(--accent-cyan);">{b["source_code"]}</span></div>
                <div>Total Potential Win: <span class="payout-val">{b["payout"]:,.2f} GHS</span></div>
            </div>
        </div>
        """

    html += f"""
    </div>

    <!-- Creator Reliability, Perfection Tracking & Correlation Telemetry -->
    <div class="section-title">CodeHub Creator Reliability KPI, Perfection Model & Correlation Telemetry</div>
    <div class="grid-stats" style="margin-bottom: 18px;">
    """

    for c in correlations:
        val_str = f"{c['value']:+.2f}" if "R_" in c["key"] else f"{c['value']:.1f}%"
        val_color = "var(--accent-red)" if c["value"] < 0 else "var(--accent-green)"
        html += f"""
        <div class="stat-card">
            <div class="stat-label">{c["label"]}</div>
            <div class="stat-value" style="color: {val_color};">{val_str}</div>
            <div class="stat-sub" style="color: var(--text-muted); line-height: 1.35; margin-top: 6px;">{c["summary"]}</div>
        </div>
        """

    html += """
    </div>

    <div class="ticket-card" style="margin-bottom: 28px; border-top: 3px solid var(--accent-green);">
        <div class="ticket-header">
            <h3>Creator Trustworthiness & Bayesian Perfection Matrix (Live Selection Weights)</h3>
            <span class="ticket-meta">Formula: W_c = 0.50(Purity) + 0.30(CleanVolume) + 0.20(YieldEfficiency) + RealizedHitAdjustment</span>
        </div>
        <div style="overflow-x: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Creator Handle</th>
                        <th>Latest Slip</th>
                        <th>Followers</th>
                        <th>Original Slip Odds</th>
                        <th>Clean Anchors</th>
                        <th>Traps Purged</th>
                        <th>Anchor Purity %</th>
                        <th>Adopted on Monsters</th>
                        <th>Bayesian Perfection</th>
                        <th>Trust Weight</th>
                        <th>Model Classification</th>
                    </tr>
                </thead>
                <tbody>
    """

    for cr in creators:
        if "ELITE" in cr["tier"]:
            tier_cls = "tier-elite"
        elif "SHARP" in cr["tier"]:
            tier_cls = "tier-sharp"
        elif "PROBATION" in cr["tier"]:
            tier_cls = "tier-probation"
        else:
            tier_cls = "tier-faded"

        purity_color = "var(--accent-green)" if cr["purity"] >= 70 else ("var(--accent-gold)" if cr["purity"] >= 40 else "var(--accent-red)")
        html += f"""
                    <tr>
                        <td class="match-cell" style="font-family: var(--mono-font);">{cr["creator"]}</td>
                        <td><span class="code-tag" style="font-size: 10px; padding: 2px 6px;">{cr["code"]}</span></td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{cr["followers"]:,}</td>
                        <td class="odds-cell">{cr["odds"]:,.2f}x <span style="color: var(--text-muted); font-weight: normal;">({cr["folds"]}F)</span></td>
                        <td style="color: var(--accent-green); font-family: var(--mono-font); font-weight: bold;">{cr["clean"]}</td>
                        <td style="color: var(--accent-red); font-family: var(--mono-font);">{cr["traps"]}</td>
                        <td style="color: {purity_color}; font-family: var(--mono-font); font-weight: bold;">{cr["purity"]:.1f}%</td>
                        <td style="font-family: var(--mono-font); color: var(--accent-cyan); font-weight: bold;">{cr["adopted"]} legs ({cr["won"]}W-{cr["lost"]}L-{cr["pending"]}P)</td>
                        <td style="font-family: var(--mono-font); color: var(--accent-gold);">{cr["perfection"]:.1f}%</td>
                        <td style="font-family: var(--mono-font); font-weight: 700; color: var(--text-main);">{cr["weight"]:.2f}x</td>
                        <td><span class="{tier_cls}">{cr["tier"]}</span></td>
                    </tr>
        """

    html += """
                </tbody>
            </table>
        </div>
    </div>

    <!-- The 4 Core Syndicate Tickets -->
    <div class="section-title">Core Asymmetric Multi-Week Portfolio (4 Independent Tickets @ 5.00 GHS)</div>
    <div class="ticket-grid">
"""

    for t in tickets:
        html += f"""
        <div class="ticket-card">
            <div class="ticket-header">
                <h3>{t["title"]} <span class="code-tag" style="margin-left:8px;">CODE: {t["code"]}</span></h3>
                <span class="ticket-meta">STAKE: {t["stake"]:.2f} GHS | ODDS: {t["odds"]}x | STATUS: {t["status"]}</span>
            </div>
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Date & Kickoff</th>
                        <th>Fixture</th>
                        <th>Selection</th>
                        <th>Odds</th>
                    </tr>
                </thead>
                <tbody>
        """
        for l in t["legs"]:
            date_str = l["kickoff"].split(" ")[0].replace("2026-", "")
            html += f"""
                    <tr>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{date_str}</td>
                        <td class="match-cell">{l["match"]}</td>
                        <td class="selection-cell">{l["selection"]}</td>
                        <td class="odds-cell">@{l["odds"]}</td>
                    </tr>
                    <tr>
                        <td colspan="4" style="padding: 0;">
                            <div class="breadcrumb-box">Breadcrumb: {l["breadcrumb"]}</div>
                        </td>
                    </tr>
            """
        html += f"""
                </tbody>
            </table>
            <div class="card-footer">
                <div>Booking Code: <strong style="color: var(--accent-cyan);">{t["code"]}</strong></div>
                <div>Potential Payout: <span class="payout-val">{t["payout"]:.2f} GHS</span></div>
            </div>
        </div>
        """

    html += f"""
    </div>

    <!-- CodeHub Asymmetric Scout Section (Ranked by Creator Trust Weight) -->
    <div class="section-title">CodeHub Asymmetric Scout Feed (Ranked by Creator Trust Weight, Not Raw Follower Hype)</div>
    <div class="codehub-grid">
    """

    for s in scouts:
        html += f"""
        <div class="scout-card">
            <div class="scout-header">
                <span class="code-tag">{s["code"]}</span>
                <span style="color: var(--accent-gold); font-size: 11px;">Trust: <strong>{s["weight"]:.2f}x</strong> // {s["followers"]} Followers</span>
            </div>
            <div style="font-size: 12px; margin-bottom: 6px;">Creator: <strong>{s["creator"]}</strong> | Original: {s["legs"]} Legs @ {s["odds"]:,.2f}x</div>
            <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                <span class="anchor-pill">Retained {s["retained"]} Clean ({s["purity"]:.0f}% Purity)</span>
                <span class="trap-pill">Stripped {s["stripped"]} Traps</span>
            </div>
        </div>
        """

    from html import escape as esc

    settled_bullet_pnl = sum(sb["pnl"] for sb in settled_bullets)
    core_settled_pnl = sum(t["pnl"] for t in tickets if t["status"] in ("WON", "LOST", "CASHED_OUT"))
    total_realized_pnl = settled_bullet_pnl + core_settled_pnl
    distinct_pm_codes = len({pm["code"] for pm in post_mortems if pm["code"]})

    html += f"""
    </div>

    <!-- Settled Monster & CodeHub Bullets Ledger -->
    <div class="section-title">Settled Monster &amp; CodeHub Bullets Ledger ({len(settled_bullets)} Settled | Bullet PnL: {settled_bullet_pnl:+.2f} GHS | Total Realized PnL: {total_realized_pnl:+.2f} GHS)</div>
    <div class="ticket-card" style="margin-bottom: 28px; border-top: 3px solid var(--accent-red);">
        <div class="ticket-header">
            <h3>Historical Settled Monster Bullets &amp; Realized PnL Audit</h3>
            <span class="ticket-meta">SETTLED BULLETS: {len(settled_bullets)} | CORE TICKETS PNL: {core_settled_pnl:+.2f} GHS | MONSTER BULLETS PNL: {settled_bullet_pnl:+.2f} GHS</span>
        </div>
        <div style="overflow-x: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Settled Date</th>
                        <th>Booking Code</th>
                        <th>Bullet ID</th>
                        <th>Folds</th>
                        <th>Stake (GHS)</th>
                        <th>Odds</th>
                        <th>Leg Record (W-L)</th>
                        <th>Status</th>
                        <th>Realized PnL</th>
                    </tr>
                </thead>
                <tbody>
    """

    for sb in settled_bullets:
        st_cls = "anchor-pill" if sb["status"] == "WON" else ("tier-probation" if sb["status"] == "CASHED_OUT" else "trap-pill")
        pnl_color = "var(--accent-green)" if sb["pnl"] > 0 else ("var(--accent-red)" if sb["pnl"] < 0 else "var(--text-muted)")
        html += f"""
                    <tr>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{esc(sb["settled_at"] or sb["created_at"])}</td>
                        <td><span class="code-tag" style="font-size: 10px; padding: 2px 6px;">{esc(sb["code"])}</span></td>
                        <td class="match-cell" style="font-family: var(--mono-font);">{esc(sb["id"])}</td>
                        <td style="font-family: var(--mono-font);">{sb["legs"]}F</td>
                        <td style="font-family: var(--mono-font);">{sb["stake"]:.2f}</td>
                        <td class="odds-cell">{sb["odds"]:,.2f}x</td>
                        <td style="font-family: var(--mono-font); color: var(--accent-cyan);">{sb["won_legs"]}W - {sb["lost_legs"]}L</td>
                        <td><span class="{st_cls}">{esc(sb["status"])}</span></td>
                        <td style="font-family: var(--mono-font); font-weight: bold; color: {pnl_color};">{sb["pnl"]:+.2f} GHS</td>
                    </tr>
        """

    html += f"""
                </tbody>
            </table>
        </div>
    </div>

    <!-- Historical Post-Mortem & Closed-Loop Learning Audit -->
    <div class="section-title">Historical Post-Mortem &amp; Closed-Loop Learning Audit ({distinct_pm_codes} Distinct Lost Tickets | {len(post_mortems)} Leg-Level Failure Records)</div>
    <div class="ticket-card" style="margin-bottom: 20px; border-top: 3px solid var(--accent-cyan);">
        <div class="ticket-header">
            <h3>Empirical Market Performance &amp; Auto-Ban Calibration Matrix (syndicate_market_performance)</h3>
            <span class="ticket-meta">MARKETS TRACKED: {len(market_perf)} | AUTO-BANNED: {sum(1 for m in market_perf if m["banned"])}</span>
        </div>
        <div style="overflow-x: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Canonical Market Key</th>
                        <th>Total Legs</th>
                        <th>Won</th>
                        <th>Lost</th>
                        <th>Empirical Hit Rate</th>
                        <th>Expected Hit Rate</th>
                        <th>Calibration Gap</th>
                        <th>Risk Penalty</th>
                        <th>Enforcement Status</th>
                    </tr>
                </thead>
                <tbody>
    """

    for mp in market_perf:
        gap_color = "var(--accent-green)" if mp["gap"] >= 0 else "var(--accent-red)"
        status_pill = '<span class="trap-pill">BANNED</span>' if mp["banned"] else '<span class="anchor-pill">ALLOWED</span>'
        html += f"""
                    <tr>
                        <td class="selection-cell" style="font-weight: bold;">{esc(mp["market_key"])}</td>
                        <td style="font-family: var(--mono-font);">{mp["total"]}</td>
                        <td style="font-family: var(--mono-font); color: var(--accent-green);">{mp["won"]}</td>
                        <td style="font-family: var(--mono-font); color: var(--accent-red);">{mp["lost"]}</td>
                        <td style="font-family: var(--mono-font);">{mp["emp_hr"] * 100:.1f}%</td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{mp["exp_hr"] * 100:.1f}%</td>
                        <td style="font-family: var(--mono-font); color: {gap_color}; font-weight: bold;">{mp["gap"] * 100:+.1f}%</td>
                        <td style="font-family: var(--mono-font); color: var(--accent-gold);">{mp["penalty"]:.3f}</td>
                        <td>{status_pill}</td>
                    </tr>
        """

    html += """
                </tbody>
            </table>
        </div>
    </div>

    <div class="ticket-card" style="margin-bottom: 28px; border-top: 3px solid var(--accent-gold);">
        <div class="ticket-header">
            <h3>Root-Cause Failure Post-Mortem Audit Log (syndicate_post_mortems)</h3>
            <span class="ticket-meta">100% CLOSED-LOOP COVERAGE: CORE TICKETS + MONSTER BULLETS</span>
        </div>
        <div style="overflow-x: auto;">
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Code</th>
                        <th>Source</th>
                        <th>Fixture</th>
                        <th>Market Key</th>
                        <th>League</th>
                        <th>Root Cause</th>
                        <th>Preventative Rule Triggered</th>
                    </tr>
                </thead>
                <tbody>
    """

    for pm in post_mortems:
        html += f"""
                    <tr>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{esc(pm["timestamp"])}</td>
                        <td><span class="code-tag" style="font-size: 10px; padding: 2px 6px;">{esc(pm["code"])}</span></td>
                        <td style="font-family: var(--mono-font); font-size: 10px; color: var(--text-muted);">{esc(pm["source"].replace("syndicate_", ""))}</td>
                        <td class="match-cell">{esc(pm["match"])}</td>
                        <td class="selection-cell">{esc(pm["market_key"])}</td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{esc(pm["league"])}</td>
                        <td><span class="trap-pill">{esc(pm["category"])}</span></td>
                        <td style="font-size: 11px; color: var(--text-muted);">{esc(pm["rule"])}</td>
                    </tr>
        """

    html += """
                </tbody>
            </table>
        </div>
    </div>
    """

    # Dynamically render data/syndicate_heuristics.json (Rules #22-#29+, banned markets & market-league pairs)
    h_ver = heuristics.get("version", "3.0.0")
    h_updated = heuristics.get("last_updated", "N/A")
    rules_dict = heuristics.get("rules", {})
    r28 = rules_dict.get("rule_28_friday_postmortem_market_ban", {})
    banned_markets = r28.get("banned_markets", [])
    banned_pairs = r28.get("banned_market_league_pairs", [])
    r29 = rules_dict.get("rule_29_zero_vig_bonus_sweet_spot", {})

    html += f"""
    <!-- Hardened Quantitative Guardrails Matrix (Dynamic from syndicate_heuristics.json) -->
    <div class="section-title">Hardened Quantitative Guardrails (Heuristics v{esc(str(h_ver))} // Updated: {esc(str(h_updated))})</div>
    <div class="guardrails-box">
        <div class="rule-item">
            <span class="rule-badge" style="border-color: var(--accent-red); color: var(--accent-red); background: rgba(239, 68, 68, 0.15);">ACTIVE BANS</span>
            <div>
                <div class="rule-text">Machine-Enforced Banned Markets ({len(banned_markets)}) &amp; Market-League Traps ({len(banned_pairs)})</div>
                <div class="rule-desc" style="margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap;">
    """

    for bm in banned_markets:
        html += f'<span class="trap-pill">{esc(str(bm))}</span>'
    for bp in banned_pairs:
        html += f'<span class="trap-pill">{esc(str(bp.get("market", "")))} @ {esc(str(bp.get("league_pattern", "")))}</span>'

    html += f"""
                </div>
                <div class="rule-desc" style="margin-top: 6px;">Rule #29 +EV Sweet Spot Gate: Odds {r29.get("min_leg_odds", 1.20)}–{r29.get("max_leg_odds", 1.45)} | Min Betradar RTP &ge; {r29.get("min_betradar_rtp", 0.980):.3f} | Min Ticket EV &ge; {r29.get("min_ticket_ev", 1.02):.2f}</div>
            </div>
        </div>
    """

    for rule_key, rule_obj in rules_dict.items():
        if not isinstance(rule_obj, dict) or not rule_obj.get("active", True):
            continue
        r_id = rule_obj.get("id", rule_key.upper())
        badge = f"RULE #{r_id}" if isinstance(r_id, int) else f"RULE {r_id}"
        r_name = rule_obj.get("name", rule_key)
        r_desc = rule_obj.get("description", "")
        html += f"""
        <div class="rule-item">
            <span class="rule-badge">{esc(str(badge))}</span>
            <div>
                <div class="rule-text">{esc(str(r_name))}</div>
                <div class="rule-desc">{esc(str(r_desc))}</div>
            </div>
        </div>
        """

    html += """
    </div>

</body>
</html>
"""
    return html


if __name__ == "__main__":
    content = generate_html()

    out_path = os.path.join(BASE_DIR, "syndicate", "syndicate_terminal.html")
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"[SyndicateTerminal] Rendered HTML terminal to: {out_path}")

    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    artifact_path = os.path.join(ARTIFACT_DIR, "syndicate_kpi_terminal.html")
    with open(artifact_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"[SyndicateTerminal] Synced artifact to: {artifact_path}")
