import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNDICATE_DIR = os.path.join(BASE_DIR, "syndicate")
if SYNDICATE_DIR not in sys.path:
    sys.path.insert(0, SYNDICATE_DIR)

import closed_loop_learner as learner
import db_manager

LIVE_DB = os.path.join(BASE_DIR, "data", "syndicate_ledger.sqlite")
LIVE_HEURISTICS = os.path.join(BASE_DIR, "data", "syndicate_heuristics.json")


class TestClosedLoopLearner(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="jac_cll_test_")
        self.test_db = os.path.join(self.tmpdir, "syndicate_ledger.sqlite")
        self.test_heuristics = os.path.join(self.tmpdir, "syndicate_heuristics.json")
        self.test_experience = os.path.join(self.tmpdir, "syndicate_experience.json")

        # Copy live DB via sqlite3 backup API so WAL state is cleanly snapshotted
        src = sqlite3.connect(LIVE_DB)
        dst = sqlite3.connect(self.test_db)
        src.backup(dst)
        dst.close()
        src.close()

        shutil.copyfile(LIVE_HEURISTICS, self.test_heuristics)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_wal_schema_corruption_repair_and_12_ticket_backfill_idempotent(self):
        # Inject legacy corruption & boilerplate to verify repair + backfill from scratch
        conn = db_manager.get_connection(self.test_db)
        conn.execute(
            "UPDATE syndicate_creator_anchor_ledger SET status='WON' WHERE booking_code='D8WJHX' AND match_name='Chelsea vs Leeds United'"
        )
        conn.execute(
            "UPDATE syndicate_creator_anchor_ledger SET status='WON' WHERE booking_code='CMYT2L' AND match_name='Troyes vs Le Havre'"
        )
        conn.execute(
            "UPDATE syndicate_codehub_bullets SET cashout_value=3.44 WHERE booking_code='C36TTY'"
        )
        conn.execute(
            "UPDATE syndicate_cycles SET status='ACTIVE', realized_pnl=0.0 WHERE cycle_id='CYCLE_2026_11_16_LIVE'"
        )
        conn.execute("DELETE FROM syndicate_post_mortems WHERE source_table='syndicate_codehub_bullets'")
        conn.execute(
            "UPDATE syndicate_post_mortems SET failure_category='VARIANCE_OR_TACTICAL_MISS' WHERE source_table='syndicate_tickets'"
        )
        conn.commit()
        conn.close()

        # First run: repairs corruption, upgrades 4 core PMs, inserts all 8 bullet PMs
        res1 = learner.run_closed_loop_learning(
            db_path=self.test_db,
            heuristics_path=self.test_heuristics,
            experience_path=self.test_experience,
        )
        self.assertGreater(res1["repairs"]["repaired_legs"], 0)
        self.assertEqual(res1["repairs"]["repaired_cycles"], 1)
        self.assertEqual(res1["repairs"]["repaired_cashouts"], 1)
        self.assertGreater(res1["post_mortems"]["new_post_mortems"], 0)
        self.assertEqual(res1["post_mortems"]["upgraded_post_mortems"], 4)
        self.assertEqual(res1["heuristics_version"], "3.0.0")

        # Verify SQLite ground truth
        conn = db_manager.get_connection(self.test_db)
        jmode = conn.execute("PRAGMA journal_mode").fetchone()[0].lower()
        self.assertEqual(jmode, "wal")

        boilerplate = conn.execute(
            "SELECT COUNT(*) FROM syndicate_post_mortems WHERE failure_category='VARIANCE_OR_TACTICAL_MISS'"
        ).fetchone()[0]
        self.assertEqual(boilerplate, 0)

        distinct_codes = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT booking_code FROM syndicate_post_mortems WHERE booking_code IS NOT NULL"
            ).fetchall()
        }
        expected_12 = {
            "C6QSSB", "D2X3PV", "BD8Y44", "ASL92A",
            "D8WJHX", "9MJSC0", "93VVCD", "CHBJ6E",
            "8YLKVR", "CMYT2L", "BKJ0JX", "808QK6",
        }
        self.assertTrue(expected_12.issubset(distinct_codes), f"Missing codes: {expected_12 - distinct_codes}")

        # Verify C36TTY bogus 3.44 cashout cleared & CYCLE_2026_11_16_LIVE closed
        c36_co = conn.execute(
            "SELECT cashout_value FROM syndicate_codehub_bullets WHERE booking_code='C36TTY'"
        ).fetchone()[0]
        self.assertEqual(c36_co, 0.0)

        cyc = conn.execute(
            "SELECT status, realized_pnl FROM syndicate_cycles WHERE cycle_id='CYCLE_2026_11_16_LIVE'"
        ).fetchone()
        self.assertEqual(cyc, ("LOST", -20.0))

        # Verify syndicate_market_performance populated
        mp_count = conn.execute("SELECT COUNT(*) FROM syndicate_market_performance").fetchone()[0]
        self.assertGreater(mp_count, 10)
        pm_count_after_first = conn.execute("SELECT COUNT(*) FROM syndicate_post_mortems").fetchone()[0]
        conn.close()

        # Verify heuristics JSON v3.0.0 contract
        with open(self.test_heuristics, "r", encoding="utf-8") as f:
            h = json.load(f)
        self.assertEqual(h["version"], "3.0.0")
        r28 = h["rules"]["rule_28_friday_postmortem_market_ban"]
        for req_ban in ["1H_GG_NG_NO", "HCP_0_1_FAV", "2H_OVER_0_5", "1H_UNDER_2_5", "PLAIN_1X2_FAV_ACCUM", "EERSTE_DIVISIE_OVER_2"]:
            self.assertIn(req_ban, r28["banned_markets"])
        self.assertGreaterEqual(len(r28["banned_market_league_pairs"]), 3)
        r29 = h["rules"]["rule_29_zero_vig_bonus_sweet_spot"]
        self.assertEqual(r29["min_leg_odds"], 1.20)
        self.assertEqual(r29["max_leg_odds"], 1.45)
        self.assertEqual(r29["min_betradar_rtp"], 0.980)
        self.assertEqual(r29["min_ticket_ev"], 1.02)
        self.assertIn("market_risk_weights", h["dynamic_weights"])

        # Verify unified experience JSON
        with open(self.test_experience, "r", encoding="utf-8") as f:
            exp = json.load(f)
        self.assertGreaterEqual(exp["lost"], 12)
        self.assertEqual(exp["core_tickets"]["lost"], 4)
        self.assertGreaterEqual(exp["monster_bullets"]["lost"], 8)
        self.assertGreaterEqual(exp["post_mortem_distinct_tickets"], 12)

        # Second run: must be strictly idempotent
        res2 = learner.run_closed_loop_learning(
            db_path=self.test_db,
            heuristics_path=self.test_heuristics,
            experience_path=self.test_experience,
        )
        self.assertEqual(res2["repairs"]["repaired_legs"], 0)
        self.assertEqual(res2["post_mortems"]["new_post_mortems"], 0)
        self.assertEqual(res2["post_mortems"]["upgraded_post_mortems"], 0)

        conn = db_manager.get_connection(self.test_db)
        pm_count_after_second = conn.execute("SELECT COUNT(*) FROM syndicate_post_mortems").fetchone()[0]
        conn.close()
        self.assertEqual(pm_count_after_first, pm_count_after_second)

    def test_novel_over_3_5_auto_tracked_and_auto_banned_idempotently(self):
        conn = db_manager.get_connection(self.test_db)
        conn.execute(
            """
            INSERT INTO syndicate_codehub_bullets
            (bullet_id, booking_code, stake, total_odds, potential_payout, legs_count, status, realized_pnl, created_at, settled_at)
            VALUES ('B_TEST_O35', 'TEST_O35', 2.0, 10.0, 20.0, 3, 'LOST', -2.0, '2026-11-21T00:00:00Z', '2026-11-21T01:00:00Z')
            """
        )
        for i in range(1, 4):
            conn.execute(
                """
                INSERT INTO syndicate_creator_anchor_ledger
                (ledger_id, bullet_id, booking_code, match_name, selection, status)
                VALUES (?, 'B_TEST_O35', 'TEST_O35', ?, 'Over/Under: Over 3.5 @ 1.35', 'LOST')
                """,
                (f"L_O35_{i}", f"Test Alpha {i} FC vs Test Beta {i} FC"),
            )
        conn.commit()
        conn.close()

        res1 = learner.run_closed_loop_learning(
            db_path=self.test_db,
            heuristics_path=self.test_heuristics,
            experience_path=self.test_experience,
        )
        self.assertEqual(res1["post_mortems"]["new_post_mortems"], 3)

        conn = db_manager.get_connection(self.test_db)
        pm_keys = [
            r[0]
            for r in conn.execute(
                "SELECT market_key FROM syndicate_post_mortems WHERE booking_code='TEST_O35'"
            ).fetchall()
        ]
        self.assertEqual(pm_keys, ["OVER_3_5", "OVER_3_5", "OVER_3_5"])
        mp_row = conn.execute(
            "SELECT total_legs, won_legs, lost_legs, banned FROM syndicate_market_performance WHERE market_key='OVER_3_5' AND league='ALL'"
        ).fetchone()
        conn.close()
        self.assertIsNotNone(mp_row)
        self.assertEqual(mp_row, (3, 0, 3, 1))

        with open(self.test_heuristics, "r", encoding="utf-8") as f:
            h1 = json.load(f)
        self.assertIn("OVER_3_5", h1["rules"]["rule_28_friday_postmortem_market_ban"]["banned_markets"])
        self.assertTrue(h1["dynamic_weights"]["market_risk_weights"]["OVER_3_5"]["banned"])
        cal_len_1 = len(h1["calibration_log"])

        # Second run must be strictly idempotent
        res2 = learner.run_closed_loop_learning(
            db_path=self.test_db,
            heuristics_path=self.test_heuristics,
            experience_path=self.test_experience,
        )
        self.assertEqual(res2["post_mortems"]["new_post_mortems"], 0)
        with open(self.test_heuristics, "r", encoding="utf-8") as f:
            h2 = json.load(f)
        self.assertEqual(len(h2["calibration_log"]), cal_len_1)

    def test_league_specific_auto_ban_propagates_to_heuristics_idempotently(self):
        conn = db_manager.get_connection(self.test_db)
        conn.execute(
            """
            INSERT INTO syndicate_codehub_bullets
            (bullet_id, booking_code, stake, total_odds, potential_payout, legs_count, status, realized_pnl, created_at, settled_at)
            VALUES ('B_TEST_PLO15', 'TEST_PL_O15', 2.0, 10.0, 20.0, 3, 'LOST', -2.0, '2026-11-21T00:00:00Z', '2026-11-21T01:00:00Z')
            """
        )
        epl_fixtures = [
            "Arsenal vs Chelsea",
            "Liverpool vs Man City",
            "Tottenham vs Aston Villa",
        ]
        for idx, match in enumerate(epl_fixtures, 1):
            conn.execute(
                """
                INSERT INTO syndicate_creator_anchor_ledger
                (ledger_id, bullet_id, booking_code, match_name, selection, status)
                VALUES (?, 'B_TEST_PLO15', 'TEST_PL_O15', ?, 'Over/Under: Over 1.5 @ 1.25', 'LOST')
                """,
                (f"L_PLO15_{idx}", match),
            )
        conn.commit()
        conn.close()

        learner.run_closed_loop_learning(
            db_path=self.test_db,
            heuristics_path=self.test_heuristics,
            experience_path=self.test_experience,
        )
        with open(self.test_heuristics, "r", encoding="utf-8") as f:
            h1 = json.load(f)
        pairs1 = h1["rules"]["rule_28_friday_postmortem_market_ban"]["banned_market_league_pairs"]
        pl_pairs = [
            p for p in pairs1
            if p.get("market") == "OVER_1_5" and (p.get("league_pattern") or "").lower() == "premier league"
        ]
        self.assertEqual(len(pl_pairs), 1)

        # Second run must NOT duplicate the pair
        learner.run_closed_loop_learning(
            db_path=self.test_db,
            heuristics_path=self.test_heuristics,
            experience_path=self.test_experience,
        )
        with open(self.test_heuristics, "r", encoding="utf-8") as f:
            h2 = json.load(f)
        pairs2 = h2["rules"]["rule_28_friday_postmortem_market_ban"]["banned_market_league_pairs"]
        self.assertEqual(len(pairs2), len(pairs1))


if __name__ == "__main__":
    unittest.main()
