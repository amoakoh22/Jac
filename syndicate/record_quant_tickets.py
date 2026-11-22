#!/usr/bin/env python3
"""
Jac Syndicate — Quant v11 Live Ticket Recorder, Learner Trigger & Artifact Sync (M3)

Reads runtime/quant_live_placement_latest.json and:
  1. Idempotently records every confirmed ticket (valid 6-char booking_code) into
     syndicate_codehub_bullets and syndicate_creator_anchor_ledger via db_manager.get_connection().
  2. Copies receipt PNGs to ARTIFACT_DIR using shutil.copyfile() (never copy2).
  3. Updates syndicate_wallets.liquid_balance and last_synced from live postBalanceGhs.
  4. Runs syndicate/closed_loop_learner.py and syndicate/render_syndicate_terminal.py.
  5. Syncs syndicate/syndicate_terminal.html -> index.html and docs/index.html, and
     verifies byte-identical SHA-256 parity with ARTIFACT_DIR/syndicate_kpi_terminal.html.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from syndicate.db_manager import get_connection, ensure_schema_upgrades

RES_PATH = os.path.join(BASE_DIR, "runtime", "quant_live_placement_latest.json")
TERMINAL_SRC = os.path.join(BASE_DIR, "syndicate", "syndicate_terminal.html")
INDEX_DST = os.path.join(BASE_DIR, "index.html")
DOCS_INDEX_DST = os.path.join(BASE_DIR, "docs", "index.html")
ARTIFACT_DIR = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/4d8d83ff-7ad4-4751-88d8-a6f121d7868e"
ARTIFACT_TERMINAL = os.path.join(ARTIFACT_DIR, "syndicate_kpi_terminal.html")

BOOKING_CODE_RE = re.compile(r"^[A-Z0-9]{6}$")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def format_kickoff_gmt(start_time_ms):
    try:
        ts = float(start_time_ms or 0) / 1000.0
        if ts > 0:
            return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError, OSError):
        pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")


def record_quant_tickets(res_path=RES_PATH, db_path=None, run_post_steps=True):
    if not os.path.exists(res_path):
        raise FileNotFoundError(f"Placement results file not found: {res_path}")

    with open(res_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    now_iso = datetime.now(timezone.utc).isoformat()
    date_tag = datetime.now(timezone.utc).strftime("%Y%m%d")

    conn = get_connection(db_path)
    ensure_schema_upgrades(conn)
    cur = conn.cursor()

    recorded = []
    copied_receipts = []

    for idx, t in enumerate(data.get("tickets", []), 1):
        code = str(t.get("booking_code") or "").strip().upper()
        if not t.get("success") or not BOOKING_CODE_RE.match(code):
            print(f"[WARN] Skipping unconfirmed ticket #{idx}: id={t.get('id')} code={code!r} err={t.get('error')}")
            continue

        mode = str(t.get("mode") or "")
        strategy_tag = t.get("strategyTag") or (
            "QUANT_V11_X100_PLUSEV" if mode == "x100_plus_ev" else "QUANT_V11_FORTRESS_98PCT"
        )
        stake = float(t.get("stake") or 0.0)
        pot_win = float(t.get("potentialWin") or 0.0)
        base_odds = float(t.get("baseOdds") or 0.0)
        folds = int(t.get("folds") or len(t.get("legs") or []))
        bonus_pct = round(float(t.get("bonusPct") or 0.0) * 100.0, 1)
        true_rtp_pct = round(float(t.get("trueExpectedRtp") or 0.0) * 100.0, 2)
        comb_prob_pct = round(float(t.get("combinedWinProb") or 0.0) * 100.0, 4)

        derived_tag = f"{strategy_tag}_{folds}F_RTP{true_rtp_pct}PCT_B{bonus_pct}PCT"

        # Idempotent lookup by booking_code so re-runs never duplicate rows
        existing = cur.execute(
            "SELECT bullet_id FROM syndicate_codehub_bullets WHERE booking_code = ?",
            (code,),
        ).fetchone()
        bullet_id = existing[0] if existing else f"CH_{strategy_tag}_{date_tag}_{code}"

        if existing:
            cur.execute(
                """
                UPDATE syndicate_codehub_bullets
                SET derived_from_code = ?, stake = ?, total_odds = ?, potential_payout = ?,
                    legs_count = ?, status = 'IN_PROGRESS', cashout_value = ?
                WHERE booking_code = ?
                """,
                (derived_tag, stake, base_odds, pot_win, folds, stake, code),
            )
        else:
            cur.execute(
                """
                INSERT INTO syndicate_codehub_bullets
                (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count,
                 status, booking_code, created_at, settled_at, realized_pnl, cashout_value)
                VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, NULL, 0.0, ?)
                """,
                (bullet_id, derived_tag, stake, base_odds, pot_win, folds, code, now_iso, stake),
            )

        # Idempotently replace anchor legs for this booking_code
        cur.execute("DELETE FROM syndicate_creator_anchor_ledger WHERE booking_code = ?", (code,))
        for leg_idx, leg in enumerate(t.get("legs", []), 1):
            match_name = leg.get("match") or f"{leg.get('home', '')} vs {leg.get('away', '')}".strip()
            market_desc = leg.get("marketDesc") or leg.get("marketKey") or "Market"
            outcome_desc = leg.get("outcomeDesc") or ""
            odds_val = float(leg.get("odds") or 0.0)
            prob_val = float(leg.get("prob") or 0.0)
            rtp_val = float(leg.get("rtp") or (odds_val * prob_val))
            sel_str = (
                f"{market_desc}: {outcome_desc} @{odds_val:.2f} "
                f"(Prob {prob_val * 100:.2f}%, RTP {rtp_val * 100:.2f}%)"
            )
            dt_gmt = format_kickoff_gmt(leg.get("startTime"))
            country = leg.get("country") or leg.get("sportName") or "International"
            league = leg.get("league") or ""
            source_code = f"{country} - {league}".strip(" -")
            ledger_id = f"{bullet_id}_L{leg_idx:02d}"

            cur.execute(
                """
                INSERT OR REPLACE INTO syndicate_creator_anchor_ledger
                (ledger_id, bullet_id, booking_code, creator_name, source_code, match_name,
                 selection, kickoff_gmt, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?)
                """,
                (
                    ledger_id,
                    bullet_id,
                    code,
                    strategy_tag,
                    source_code,
                    match_name,
                    sel_str,
                    dt_gmt,
                    now_iso,
                ),
            )

        # Copy receipt PNG to ARTIFACT_DIR using shutil.copyfile (never copy2)
        src_shot = t.get("screenshotPath")
        if src_shot and os.path.exists(src_shot) and os.path.isdir(ARTIFACT_DIR):
            dst_shot = os.path.join(ARTIFACT_DIR, os.path.basename(src_shot))
            shutil.copyfile(src_shot, dst_shot)
            copied_receipts.append((src_shot, dst_shot))

        recorded.append(
            {
                "booking_code": code,
                "bullet_id": bullet_id,
                "strategy_tag": strategy_tag,
                "folds": folds,
                "stake": stake,
                "base_odds": base_odds,
                "potential_win": pot_win,
                "true_rtp_pct": true_rtp_pct,
                "comb_prob_pct": comb_prob_pct,
            }
        )

    post_bal = data.get("postBalanceGhs")
    if post_bal is not None:
        cur.execute(
            "UPDATE syndicate_wallets SET liquid_balance = ?, last_synced = ? WHERE id = 1",
            (float(post_bal), now_iso),
        )

    conn.commit()
    new_bal_row = cur.execute("SELECT liquid_balance FROM syndicate_wallets WHERE id = 1").fetchone()
    new_bal = float(new_bal_row[0]) if new_bal_row else 0.0
    conn.close()

    print(f"[RecordQuant] Recorded {len(recorded)} confirmed ticket(s) | Liquid Balance: GHS {new_bal:.2f}")
    for r in recorded:
        print(f"  - {r['booking_code']} ({r['strategy_tag']}): {r['folds']}F | Stake GHS {r['stake']:.2f} -> PotWin GHS {r['potential_win']:.2f} | TrueRTP {r['true_rtp_pct']}% | CombProb {r['comb_prob_pct']}%")
    for src, dst in copied_receipts:
        print(f"  - Receipt synced: {src} -> {dst}")

    if run_post_steps:
        print("[RecordQuant] Running syndicate/closed_loop_learner.py ...")
        subprocess.run([sys.executable, os.path.join(BASE_DIR, "syndicate", "closed_loop_learner.py")], cwd=BASE_DIR, check=True)

        print("[RecordQuant] Running syndicate/render_syndicate_terminal.py ...")
        subprocess.run([sys.executable, os.path.join(BASE_DIR, "syndicate", "render_syndicate_terminal.py")], cwd=BASE_DIR, check=True)

        os.makedirs(os.path.dirname(DOCS_INDEX_DST), exist_ok=True)
        shutil.copyfile(TERMINAL_SRC, INDEX_DST)
        shutil.copyfile(TERMINAL_SRC, DOCS_INDEX_DST)

        hashes = {
            "syndicate_terminal.html": sha256_file(TERMINAL_SRC),
            "index.html": sha256_file(INDEX_DST),
            "docs/index.html": sha256_file(DOCS_INDEX_DST),
        }
        if os.path.exists(ARTIFACT_TERMINAL):
            hashes["artifact/syndicate_kpi_terminal.html"] = sha256_file(ARTIFACT_TERMINAL)
        else:
            shutil.copyfile(TERMINAL_SRC, ARTIFACT_TERMINAL)
            hashes["artifact/syndicate_kpi_terminal.html"] = sha256_file(ARTIFACT_TERMINAL)

        unique_hashes = set(hashes.values())
        if len(unique_hashes) != 1:
            raise RuntimeError(f"Terminal HTML parity mismatch: {hashes}")
        print(f"[RecordQuant] Terminal HTML byte-identical parity verified (SHA-256: {next(iter(unique_hashes))[:16]}...)")

    return {
        "recorded": recorded,
        "copied_receipts": copied_receipts,
        "liquid_balance": new_bal,
    }


if __name__ == "__main__":
    record_quant_tickets()
