import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
RES_PATH = os.path.join(BASE_DIR, "runtime", "monster_v12_v13_v14_results.json")
ARTIFACT_DIR = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/4d8d83ff-7ad4-4751-88d8-a6f121d7868e"

with open(RES_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

now_iso = datetime.now(timezone.utc).isoformat()
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

recorded = []
for t in data.get("tickets", []):
    if not t.get("success") or not t.get("code"):
        print(f"[WARN] Ticket {t.get('key')} not confirmed: {t.get('snippet')}")
        continue
    code = t["code"]
    bullet_id = t["bulletId"]
    stake = float(t.get("stake") or 3.00)
    pot_win = float(t.get("potentialWin") or t.get("chosenQuote", {}).get("potentialWin") or 0.0)
    base_odds = float(t.get("chosenQuote", {}).get("totalOdds") or t.get("baseOdds") or 0.0)
    folds = int(t["folds"])
    source_tag = f"{t['sourceTag']}_{folds}F"

    cur.execute("""
        INSERT OR REPLACE INTO syndicate_codehub_bullets
        (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at, settled_at, realized_pnl, cashout_value)
        VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, NULL, 0.0, ?)
    """, (bullet_id, source_tag, stake, base_odds, pot_win, folds, code, now_iso, stake))

    cur.execute("DELETE FROM syndicate_creator_anchor_ledger WHERE bullet_id=?", (bullet_id,))
    for idx, leg in enumerate(t["legs"], 1):
        dt_gmt = datetime.fromtimestamp(leg["startTime"] / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        match_name = f"{leg['home']} vs {leg['away']}"
        sel_str = f"{leg['marketDesc']}: {leg['outcomeDesc']} @{leg['odds']:.2f} (Prob {leg['prob']*100:.1f}%, RTP {leg['rtp']*100:.1f}%)"
        lid = f"{bullet_id}_L{idx:02d}"
        cur.execute("""
            INSERT OR REPLACE INTO syndicate_creator_anchor_ledger
            (ledger_id, bullet_id, booking_code, creator_name, source_code, match_name, selection, kickoff_gmt, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?)
        """, (lid, bullet_id, code, f"Hermes-PostMortem ({leg['label']})", f"{leg['country']} - {leg['league']}", match_name, sel_str, dt_gmt, now_iso))

    src_shot = t.get("screenshotPath")
    if src_shot and os.path.exists(src_shot):
        dst_shot = os.path.join(ARTIFACT_DIR, os.path.basename(src_shot))
        shutil.copyfile(src_shot, dst_shot)
    recorded.append((code, folds, stake, base_odds, pot_win, t.get("effectiveMultiplier"), t.get("trueExpectedRtpPct")))

if data.get("balanceAfter") is not None:
    cur.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE id=1", (float(data["balanceAfter"]), now_iso))

conn.commit()
new_bal = cur.execute("SELECT liquid_balance FROM syndicate_wallets WHERE id=1").fetchone()[0]
conn.close()

print(f"Recorded {len(recorded)} new Sunday+UCL x100+ tickets | New Liquid Balance: GHS {new_bal:.2f}")
for r in recorded:
    print(" ", r)
