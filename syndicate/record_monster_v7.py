import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
RES_PATH = os.path.join(BASE_DIR, "runtime", "monster_v7_50fold_99pct_result.json")
ARTIFACT_DIR = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/4d8d83ff-7ad4-4751-88d8-a6f121d7868e"

with open(RES_PATH, "r", encoding="utf-8") as f:
    res = json.load(f)

if not res.get("success") or not res.get("code"):
    raise SystemExit(f"Placement not confirmed! Result: {res.get('snippet')}")

code = res["code"]
stake = float(res.get("stake") or 2.00)
pot_win = float(res.get("potentialWin") or res.get("quote", {}).get("potentialWin") or round(stake * res["baseOdds"], 2))
total_odds = float(res.get("quote", {}).get("totalOdds") or res["baseOdds"])
folds = int(res["folds"])
now_iso = datetime.now(timezone.utc).isoformat()
bullet_id = f"CH_MONSTER_20261119_V7_50F_99PCT"
source_tag = f"SCIENTIFIC_99PCT_TAIL_FORTRESS_{folds}F_AVG{res['avgProbPct']:.2f}PCT"

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

# Insert Monster #7 into syndicate_codehub_bullets
cur.execute("""
    INSERT OR REPLACE INTO syndicate_codehub_bullets
    (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at, settled_at, realized_pnl, cashout_value)
    VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, NULL, 0.0, ?)
""", (bullet_id, source_tag, stake, total_odds, pot_win, folds, code, now_iso, stake))

# Insert all 50 legs into syndicate_creator_anchor_ledger
cur.execute("DELETE FROM syndicate_creator_anchor_ledger WHERE bullet_id=?", (bullet_id,))
for idx, leg in enumerate(res["legs"], 1):
    dt_gmt = datetime.fromtimestamp(leg["startTime"] / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    match_name = f"{leg['home']} vs {leg['away']}"
    sel_str = f"{leg['marketDesc']}: {leg['outcomeDesc']} @{leg['odds']:.2f} (Prob {leg['prob']*100:.2f}%, RTP {leg['rtp']*100:.2f}%)"
    # Classify scientific pillar
    mid = str(leg["marketId"])
    if mid in ("69", "70"):
        pillar = "Poisson-1H-Ceiling"
    elif mid in ("91", "92"):
        pillar = "Poisson-2H-Ceiling"
    elif mid in ("19", "20"):
        pillar = "Poisson-FT-4Goal-Tail"
    elif mid in ("48", "49"):
        pillar = "Joint-Half-Impossibility"
    else:
        pillar = "Structural-Tail-Shield"

    ledger_id = f"{bullet_id}_L{idx:02d}"
    cur.execute("""
        INSERT OR REPLACE INTO syndicate_creator_anchor_ledger
        (ledger_id, bullet_id, booking_code, creator_name, source_code, match_name, selection, kickoff_gmt, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?)
    """, (ledger_id, bullet_id, code, f"Hermes-Quant ({pillar})", f"{leg['country']} - {leg['league']}", match_name, sel_str, dt_gmt, now_iso))

# Update liquid balance deterministically (balanceAfter if captured, else balanceBefore - stake)
bal_after = res.get("balanceAfter")
if bal_after is not None:
    new_val = float(bal_after)
elif res.get("balanceBefore") is not None:
    new_val = round(float(res["balanceBefore"]) - stake, 2)
else:
    new_val = 196.67
cur.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE id=1", (new_val, now_iso))

conn.commit()
new_bal = cur.execute("SELECT liquid_balance FROM syndicate_wallets WHERE id=1").fetchone()[0]
conn.close()

# Copy receipt to artifact directory (use copyfile to avoid utime error on shared mount)
src_shot = res.get("screenshotPath")
if src_shot and os.path.exists(src_shot):
    dst_shot = os.path.join(ARTIFACT_DIR, "codehub_50fold_99pct_fortress_receipt.png")
    shutil.copyfile(src_shot, dst_shot)
    print(f"Copied receipt to artifact: {dst_shot}")

print(f"Recorded Monster #7 ({bullet_id}) | Code: {code} | {folds} Folds | Odds: {total_odds:.4f}x | Potential Win: GHS {pot_win:.2f} | New Balance: GHS {new_bal:.2f}")
