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
    conn = sqlite3.connect(DB_PATH)
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

    # Active Booked Tickets only (exclude ABORTED_UNPLACED drafts)
    cursor.execute("SELECT ticket_id, ticket_number, title, stake, total_odds, multi_bet_bonus_pct, potential_payout, status, booking_code, cashout_value FROM syndicate_tickets WHERE status != 'ABORTED_UNPLACED' ORDER BY ticket_number ASC")
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
            "code": t[8] or "PENDING", "cashout": t[9] or 0.0,
            "legs": legs
        })

    # Active CodeHub Bullets (IN_PROGRESS first, showing booking_code)
    cursor.execute("SELECT bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code FROM syndicate_codehub_bullets WHERE status='IN_PROGRESS' ORDER BY potential_payout DESC")
    bullet_rows = cursor.fetchall()
    bullets = []
    for b in bullet_rows:
        b_code = b[7] or "N/A"
        cursor.execute("""
            SELECT match_name, selection, kickoff_gmt, GROUP_CONCAT(creator_name || ' (' || source_code || ')', ', '), status
            FROM syndicate_creator_anchor_ledger
            WHERE booking_code=?
            GROUP BY match_name, selection, kickoff_gmt
            ORDER BY kickoff_gmt ASC
        """, (b_code,))
        b_legs = [{
            "match": r[0], "selection": r[1], "kickoff": r[2], "creators": r[3] or "Consensus", "status": r[4]
        } for r in cursor.fetchall()]
        bullets.append({
            "id": b[0], "source_code": b[1], "stake": b[2], "odds": b[3],
            "payout": b[4], "legs": b[5], "status": b[6], "code": b_code,
            "leg_details": b_legs
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

    conn.close()

    heuristics = {}
    if os.path.exists(HEURISTICS_PATH):
        with open(HEURISTICS_PATH, 'r') as f:
            heuristics = json.load(f)

    return wallet, cycle, tickets, scouts, bullets, creators, correlations, heuristics


def generate_html():
    wallet, cycle, tickets, scouts, bullets, creators, correlations, heuristics = load_data()

    total_active_exposure = cycle["exposure"] + sum(b["stake"] for b in bullets)
    exposure_pct = (total_active_exposure / wallet["balance"]) * 100 if wallet["balance"] > 0 else 0
    core_returns = sum(t["payout"] for t in tickets)
    bullet_returns = sum(b["payout"] for b in bullets)
    total_potential_returns = core_returns + bullet_returns

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

    <!-- Top Key Metrics -->
    <div class="grid-stats">
        <div class="stat-card">
            <div class="stat-label">Telecel Liquid Wallet</div>
            <div class="stat-value">{wallet["balance"]:.2f} {wallet["currency"]}</div>
            <div class="stat-sub">Untouched Cash Reserve After 22.00 GHS Active Stakes</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Active Portfolio Exposure</div>
            <div class="stat-value">{total_active_exposure:.2f} GHS</div>
            <div class="stat-sub">4 Core Tickets (20 GHS) + 1 Monster 20-Fold (2 GHS)</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Aggregate Return Potential</div>
            <div class="stat-value" style="color: var(--accent-green);">{total_potential_returns:,.2f} GHS</div>
            <div class="stat-sub">Core: {core_returns:.2f} GHS + Monster D8WJHX: {bullet_returns:,.2f} GHS</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Creator Trust & Correlation</div>
            <div class="stat-value" style="color: var(--accent-cyan);">24 CREATORS</div>
            <div class="stat-sub">5 Elite Alpha (2.0x) // 5 Verified Sharp // 8 Faded Traps</div>
        </div>
    </div>

    <!-- Staked CodeHub Monster Accumulator Section -->
    <div class="section-title">Staked CodeHub Monster Accumulator (Live Booked Slip: D8WJHX)</div>
    <div style="margin-bottom: 28px;">
    """

    for b in bullets:
        html += f"""
        <div class="ticket-card" style="border-top: 3px solid var(--accent-gold);">
            <div class="ticket-header">
                <h3>20-Fold CodeHub Consensus Monster Accumulator <span class="code-tag" style="margin-left:8px; background: rgba(251, 191, 36, 0.2); border-color: var(--accent-gold); color: var(--accent-gold);">BOOKED CODE: {b["code"]}</span></h3>
                <span class="ticket-meta">STAKE: {b["stake"]:.2f} GHS | BASE ODDS: {b["odds"]:,.2f}x (+ Win Bonus) | POTENTIAL WIN: <strong style="color: var(--accent-green); font-size: 13px;">{b["payout"]:,.2f} GHS</strong> | STATUS: {b["status"]}</span>
            </div>
            <table class="legs-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Kickoff (GMT)</th>
                        <th>Fixture</th>
                        <th>Selection (1X2)</th>
                        <th>Endorsing CodeHub Creators (Source Slips)</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
        """
        for idx, leg in enumerate(b["leg_details"], 1):
            html += f"""
                    <tr>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{idx}</td>
                        <td style="font-family: var(--mono-font); color: var(--text-muted);">{leg["kickoff"].replace("2026-", "")}</td>
                        <td class="match-cell">{leg["match"]}</td>
                        <td class="selection-cell">{leg["selection"]}</td>
                        <td style="font-family: var(--mono-font); font-size: 10px; color: var(--accent-gold);">{leg["creators"]}</td>
                        <td><span class="anchor-pill">{leg["status"]}</span></td>
                    </tr>
            """
        html += f"""
                </tbody>
            </table>
            <div class="card-footer">
                <div>Booking Code: <strong style="color: var(--accent-gold);">{b["code"]}</strong> // Derived Consensus Cluster: <span style="color: var(--accent-cyan);">{b["source_code"]}</span></div>
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
                        <th>Adopted on D8WJHX</th>
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

    html += """
    </div>

    <!-- Hardened Quantitative Guardrails Matrix -->
    <div class="section-title">Hardened Quantitative Guardrails (Pre-Execution Assertions)</div>
    <div class="guardrails-box">
        <div class="rule-item">
            <span class="rule-badge">HEURISTIC #27</span>
            <div>
                <div class="rule-text">Autonomous Cashout Profit-Lock & Survivor Re-Bullet Protocol</div>
                <div class="rule-desc">Unified 5-minute daemon monitors both Core Tickets and Monster Bullets (D8WJHX). Automatically locks Cashout if Core Ticket equity >= 92% (or >= 100 GHS) or Monster Bullet offer >= 150 GHS (75x stake). If an early leg busts a Monster Bullet while >= 8 clean legs remain, automatically deploys 1 GHS 2.00 Survivor Bullet (max 1/24h, min balance 50 GHS) and updates creator leg-level trust weights.</div>
            </div>
        </div>
        <div class="rule-item">
            <span class="rule-badge">HEURISTIC #26</span>
            <div>
                <div class="rule-text">Creator Trust Weighting & Follower Hype Discount</div>
                <div class="rule-desc">Never rank CodeHub slips by raw follower count (r = -0.40 negative correlation with anchor purity). Weight all harvested anchors by Creator Trust Weight (W_c in 0.05x–2.00x), prioritizing the 50–370 follower Alpha Sweet Spot (81.5% purity) and auto-fading 0% purity lotto bait.</div>
            </div>
        </div>
        <div class="rule-item">
            <span class="rule-badge">HEURISTIC #25</span>
            <div>
                <div class="rule-text">Strict Zero-Correlation Firewall</div>
                <div class="rule-desc">Zero fixture overlap across active slips. Every single ticket in a deployment cycle must contain 100% mutually exclusive matches.</div>
            </div>
        </div>
        <div class="rule-item">
            <span class="rule-badge">HEURISTIC #23</span>
            <div>
                <div class="rule-text">Zero Handicap Stretching</div>
                <div class="rule-desc">Never stretch a handicap deeper (e.g. -5.5 to -10.5 or 0:1 to 0:2) just to manufacture higher odds. If odds fall below value threshold, substitute a clean primary market.</div>
            </div>
        </div>
        <div class="rule-item">
            <span class="rule-badge">HEURISTIC #22</span>
            <div>
                <div class="rule-text">Double-Digit NBA Spread Cap Without Primary Alpha</div>
                <div class="rule-desc">Never lay -10.0 or higher on an NBA favorite missing its #1 franchise scorer. Cap alternate spreads on shorthanded favorites at -5.5 to -7.5.</div>
            </div>
        </div>
        <div class="rule-item">
            <span class="rule-badge">ARBITRAGE MATH</span>
            <div>
                <div class="rule-text">Chronological Staggering & Arbitrage Cashout Protocol</div>
                <div class="rule-desc">When early legs win and final 1-2 legs remain, calculate opposing hedge stake via: Hedge Stake = (Original Stake × Total Parlay Odds) / Live Opposing Odds. Lock Principal Protection or Equalized Arbitrage whenever offer reaches ≥ 5x cycle exposure (≥ GHS 100.00).</div>
            </div>
        </div>
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
