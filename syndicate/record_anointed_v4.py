"""
Jac Syndicate — Record Anointed v4.0 Live Placements into SQLite & Artifact Dir.
Records:
  - Twin-Wave HARVESTER + MOONSHOT (with wave_group_id, ticket_role, pair_total_stake, wave_plan_json)
  - Disjoint Solo 1.00x +EV Wave Jackpot
  - Mode C Integer Push-Shielded Vault Step 1 (into syndicate_vault_ladders + bullets)
"""
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
RES_PATH = os.path.join(BASE_DIR, "runtime", "anointed_v4_live_results.json")
ARTIFACT_DIR = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/4d8d83ff-7ad4-4751-88d8-a6f121d7868e"

import sys
sys.path.insert(0, os.path.join(BASE_DIR, "syndicate"))
import db_manager


def main():
    with open(RES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    now_iso = datetime.now(timezone.utc).isoformat()
    conn = db_manager.get_connection(DB_PATH)
    db_manager.ensure_schema_upgrades(conn)
    cur = conn.cursor()

    recorded = []
    for t in data.get("tickets", []):
        if not t.get("success") or not t.get("booking_code"):
            print(f"[WARN] Skipping unconfirmed slip: {t.get('title')}")
            continue
        code = t["booking_code"]
        bullet_id = t["bulletId"]
        stake = float(t.get("stake") or 3.0)
        pot_win = float(t.get("potentialWin") or 0.0)
        base_odds = float(t.get("baseOdds") or 0.0)
        folds = int(t["folds"])
        role = str(t.get("role") or "SOLO")
        wave_group_id = str(t.get("waveGroupId") or "")
        pair_stake = float(t.get("pairTotalStake") or 0.0)
        wp_json = json.dumps(t.get("wavePlan") or {})
        source_tag = f"{t['sourceTag']}_{folds}F"

        cur.execute(
            """
            INSERT OR REPLACE INTO syndicate_codehub_bullets
            (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status,
             booking_code, created_at, settled_at, realized_pnl, cashout_value,
             wave_group_id, ticket_role, pair_total_stake, wave_plan_json)
            VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, NULL, 0.0, ?, ?, ?, ?, ?)
            """,
            (
                bullet_id, source_tag, stake, base_odds, pot_win, folds,
                code, now_iso, stake, wave_group_id, role, pair_stake, wp_json
            ),
        )

        cur.execute("DELETE FROM syndicate_creator_anchor_ledger WHERE bullet_id=?", (bullet_id,))
        for idx, leg in enumerate(t["legs"], 1):
            dt_gmt = datetime.fromtimestamp(leg["startTime"] / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
            match_name = leg.get("match") or f"{leg.get('home','')} vs {leg.get('away','')}"
            push_note = f", Push {leg['pPush']*100:.0f}%" if (leg.get("pPush") or 0) > 0 else ""
            sel_str = (
                f"[{leg.get('sportName','Sport')}] {leg.get('marketDesc','')}: {leg.get('outcomeDesc','')} "
                f"@{leg['odds']:.2f} (Surv {leg.get('nonLossProb', leg['prob'])*100:.1f}%{push_note}, RTP {leg.get('singleRtp', leg['rtp'])*100:.1f}%)"
            )
            lid = f"{bullet_id}_L{idx:02d}"
            cur.execute(
                """
                INSERT OR REPLACE INTO syndicate_creator_anchor_ledger
                (ledger_id, bullet_id, booking_code, creator_name, source_code, match_name, selection, kickoff_gmt, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?)
                """,
                (
                    lid, bullet_id, code,
                    f"Anointed-v4.0 ({role})",
                    f"{leg.get('country','')} - {leg.get('league','')}",
                    match_name, sel_str, dt_gmt, now_iso
                ),
            )

        if role == "VAULT_STEP":
            import re as _re
            m_step = _re.search(r"STEP(\d+)", bullet_id or "", _re.I)
            step_num = int(m_step.group(1)) if m_step else 1
            banked = 3.0 if step_num >= 2 else 0.0
            cur.execute(
                """
                INSERT OR REPLACE INTO syndicate_vault_ladders
                (ladder_id, seed_stake, current_equity, banked_profit, current_step, target_multiplier, active_booking_code, status, updated_at)
                VALUES (?, 3.0, ?, ?, ?, 100.0, ?, 'ACTIVE', ?)
                """,
                (wave_group_id or "VAULT_LADDER_V1", stake, banked, step_num, code, now_iso),
            )

        src_shot = t.get("screenshotPath")
        if src_shot and os.path.exists(src_shot):
            try:
                os.makedirs(ARTIFACT_DIR, exist_ok=True)
                dst_shot = os.path.join(ARTIFACT_DIR, os.path.basename(src_shot))
                shutil.copyfile(src_shot, dst_shot)
            except OSError:
                pass

        recorded.append((code, role, folds, stake, pot_win, t.get("effectiveMultiplier"), round(t.get("trueExpectedRtp", 0) * 100, 2)))

    if data.get("balanceAfter") is not None:
        cur.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE id=1", (float(data["balanceAfter"]), now_iso))

    conn.commit()
    new_bal = cur.execute("SELECT liquid_balance FROM syndicate_wallets WHERE id=1").fetchone()[0]
    conn.close()

    print(f"[Recorded] {len(recorded)} Anointed v4.0 slips | Liquid Balance: GHS {new_bal:.2f}")
    for r in recorded:
        print(" ", r)


if __name__ == "__main__":
    main()
