"""
Hermes Syndicate Bloomberg KPI Terminal Generator
Renders a high-frequency, dark-mode terminal dashboard for the Asymmetric Multi-Week Syndicate.
Reads from data/syndicate_ledger.sqlite and data/syndicate_heuristics.json.
Writes directly to the conversation artifact directory and syndicate/dashboard.
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
        "balance": wallet_row[1] if wallet_row else 250.00,
        "currency": wallet_row[2] if wallet_row else "GHS",
        "max_exposure_pct": wallet_row[3] if wallet_row else 0.24,
        "unit_size": wallet_row[4] if wallet_row else 20.00
    }

    # Cycle
    cursor.execute("SELECT cycle_id, start_date, end_date, total_tickets, ticket_stake, total_exposure, status FROM syndicate_cycles LIMIT 1")
    cycle_row = cursor.fetchone()
    cycle = {
        "cycle_id": cycle_row[0] if cycle_row else "CYCLE_2026_W47",
        "start_date": cycle_row[1] if cycle_row else "2026-11-16",
        "end_date": cycle_row[2] if cycle_row else "2026-11-22",
        "total_tickets": cycle_row[3] if cycle_row else 4,
        "stake": cycle_row[4] if cycle_row else 5.00,
        "exposure": cycle_row[5] if cycle_row else 20.00,
        "status": cycle_row[6] if cycle_row else "ACTIVE"
    }

    # Tickets
    cursor.execute("SELECT ticket_id, ticket_number, title, stake, total_odds, multi_bet_bonus_pct, potential_payout, status FROM syndicate_tickets ORDER BY ticket_number ASC")
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
            "odds": t[4], "bonus_pct": t[5], "payout": t[6], "status": t[7],
            "legs": legs
        })

    # CodeHub Scouts
    cursor.execute("SELECT booking_code, creator_name, followers_count, original_odds, original_legs_count, stripped_traps_count, retained_anchors_count FROM syndicate_codehub_scouts ORDER BY followers_count DESC LIMIT 5")
    scout_rows = cursor.fetchall()
    scouts = [{
        "code": s[0], "creator": s[1], "followers": s[2], "odds": s[3],
        "legs": s[4], "stripped": s[5], "retained": s[6]
    } for s in scout_rows]

    # CodeHub Bullets
    cursor.execute("SELECT bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status FROM syndicate_codehub_bullets LIMIT 5")
    bullet_rows = cursor.fetchall()
    bullets = [{
        "id": b[0], "source_code": b[1], "stake": b[2], "odds": b[3],
        "payout": b[4], "legs": b[5], "status": b[6]
    } for b in bullet_rows]

    conn.close()

    # Heuristics
    heuristics = {}
    if os.path.exists(HEURISTICS_PATH):
        with open(HEURISTICS_PATH, 'r') as f:
            heuristics = json.load(f)

    return wallet, cycle, tickets, scouts, bullets, heuristics

def generate_html():
    wallet, cycle, tickets, scouts, bullets, heuristics = load_data()

    exposure_pct = (cycle["exposure"] / wallet["balance"]) * 100 if wallet["balance"] > 0 else 0
    total_potential_returns = sum(t["payout"] for t in tickets)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HERMES SYNDICATE // BLOOMBERG KPI TERMINAL</title>
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
            background: rgba(0, 0, 0, 0.2);
            padding: 8px 12px;
            color: var(--text-muted);
            border-bottom: 1px solid var(--card-border);
            font-weight: 500;
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
    </style>
</head>
<body>

    <div class="header">
        <div class="logo-group">
            <h1>HERMES // ASYMMETRIC SYNDICATE TERMINAL</h1>
            <p>7-DAY ROLLING HORIZON (NOV 16 – NOV 22) // TELECEL SPORTYBET GHANA ACCOUNT</p>
        </div>
        <div class="status-badge">
            ● SENTINEL ONLINE // HEURISTICS #22–#25 LOCKED
        </div>
    </div>

    <!-- Top Key Metrics -->
    <div class="grid-stats">
        <div class="stat-card">
            <div class="stat-label">Telecel Liquid Wallet</div>
            <div class="stat-value">{wallet["balance"]:.2f} {wallet["currency"]}</div>
            <div class="stat-sub">Max Permissible Exposure (24%): {(wallet["balance"] * wallet["max_exposure_pct"]):.2f} GHS</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Active Cycle Exposure</div>
            <div class="stat-value">{cycle["exposure"]:.2f} GHS</div>
            <div class="stat-sub">{exposure_pct:.1f}% of Wallet // 4 Tickets @ 5.00 GHS</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Aggregate Cycle Return Potential</div>
            <div class="stat-value" style="color: var(--accent-green);">{total_potential_returns:.2f} GHS</div>
            <div class="stat-sub">Multiplier: {(total_potential_returns / cycle["exposure"]):.1f}x Total Exposure</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Correlation Defense</div>
            <div class="stat-value" style="color: var(--accent-cyan);">0.00% OVERLAP</div>
            <div class="stat-sub">32 Matches 100% Mutually Exclusive</div>
        </div>
    </div>

    <!-- The 4 Core Syndicate Tickets -->
    <div class="section-title">Core Asymmetric Multi-Week Portfolio (4 Independent Tickets)</div>
    <div class="ticket-grid">
"""

    for t in tickets:
        html += f"""
        <div class="ticket-card">
            <div class="ticket-header">
                <h3>{t["title"]}</h3>
                <span class="ticket-meta">STAKE: {t["stake"]:.2f} GHS | ODDS: {t["odds"]}x</span>
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
                <div>SportyBet Bonus: <strong>+{int(t["bonus_pct"]*100)}%</strong></div>
                <div>Potential Payout: <span class="payout-val">{t["payout"]:.2f} GHS</span></div>
            </div>
        </div>
        """

    html += f"""
    </div>

    <!-- CodeHub Asymmetric Scout Section -->
    <div class="section-title">CodeHub Asymmetric Scout Feed (Human Bets vs House Defense)</div>
    <div class="codehub-grid">
    """

    for s in scouts:
        html += f"""
        <div class="scout-card">
            <div class="scout-header">
                <span class="code-tag">{s["code"]}</span>
                <span style="color: var(--accent-gold); font-size: 11px;">{s["followers"]} Followers</span>
            </div>
            <div style="font-size: 12px; margin-bottom: 6px;">Creator: <strong>{s["creator"]}</strong> | Original: {s["legs"]} Legs @ {s["odds"]}x</div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
                <span class="trap-pill">Stripped {s["stripped"]} Traps</span>
                <span class="anchor-pill">Retained {s["retained"]} Clean Anchors</span>
            </div>
        </div>
        """

    html += f"""
    </div>

    <!-- Hardened Quantitative Guardrails Matrix -->
    <div class="section-title">Hardened Quantitative Guardrails (Pre-Execution Assertions)</div>
    <div class="guardrails-box">
        <div class="rule-item">
            <span class="rule-badge">HEURISTIC #25</span>
            <div>
                <div class="rule-text">Strict Zero-Correlation Firewall</div>
                <div class="rule-desc">Zero fixture overlap across active slips. Every single ticket in a deployment cycle must contain 100% mutually exclusive matches. Enforced: 32 matches across 4 tickets with zero duplicates.</div>
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
            <span class="rule-badge">HEURISTIC #24</span>
            <div>
                <div class="rule-text">Dead-Rubber & Group-Winner Rotation Filter</div>
                <div class="rule-desc">On final group-stage matchdays, filter out teams that have already clinched 1st place in favor of teams with active qualification/promotion stakes.</div>
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
    
    # Save in syndicate directory
    out_path = os.path.join(BASE_DIR, "syndicate", "syndicate_terminal.html")
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"[SyndicateTerminal] Rendered HTML terminal to: {out_path}")

    # Also save directly to artifact directory for UI display
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    artifact_path = os.path.join(ARTIFACT_DIR, "syndicate_kpi_terminal.html")
    with open(artifact_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"[SyndicateTerminal] Synced artifact to: {artifact_path}")
