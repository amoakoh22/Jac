/**
 * Hermes Syndicate - GitHub Actions Single-Pass Cron Runner
 * Mirrors bin/github_cron_staker.js for the isolated Telecel Syndicate:
 *  1. Runs monitor_syndicate_bets.js (Open/Settled Bets + Balance + Terminal sync)
 *  2. Runs self-learning post-mortem calibration into syndicate_post_mortems
 *  3. Runs scrape_codehub.js (CodeHub feed scan + trap-purge)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT_DIR, 'data', 'syndicate_ledger.sqlite');

function run(cmd, args) {
  console.log(`[Cron] Running: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT_DIR, stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) console.warn(`[Cron] ${args[0]} exited with code ${r.status}`);
}

run('node', ['syndicate/monitor_syndicate_bets.js']);

// Self-learning post-mortem sync
spawnSync('python3', ['-c', `
import sqlite3
from datetime import datetime
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
settled = c.execute("SELECT ticket_id, booking_code, stake, total_odds, status, realized_pnl FROM syndicate_tickets WHERE status IN ('WON','LOST')").fetchall()
already = set(r[0] for r in c.execute("SELECT DISTINCT ticket_id FROM syndicate_post_mortems").fetchall())
for tid, code, stake, odds, st, pnl in settled:
    if tid in already: continue
    c.execute("INSERT INTO syndicate_post_mortems (ticket_id, timestamp, failure_category, tactical_summary, preventative_rule_added) VALUES (?,?,?,?,?)",
              (tid, datetime.utcnow().isoformat(), 'EDGE_REALIZED' if st=='WON' else 'VARIANCE_OR_TACTICAL_MISS',
               f"Ticket {tid} ({code}) settled {st} | Stake {stake} | Odds {odds} | PnL {pnl}",
               "Maintain uncorrelated multi-sport spread" if st=='WON' else "Audit losing leg odds band"))
c.commit(); c.close()
`], { cwd: ROOT_DIR, stdio: 'inherit' });

run('node', ['syndicate/scrape_codehub.js']);
console.log('[Cron] Hermes Syndicate single-pass cycle complete.');
