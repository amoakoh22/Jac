/**
 * Hermes Syndicate - Autonomous 24/7 Loop & Self-Learning Engine
 * Runs continuously without user prompting:
 *  1. Every 5m: Live Open/Settled Bets audit (monitor_syndicate_bets.js) + Cashout/Equity check + Terminal sync
 *  2. On Settlement: Self-learning post-mortem audit (syndicate_post_mortems + runtime/syndicate_experience.json)
 *  3. Every 60m: Session keep-alive (persist sportybet_authenticated_state.json) + CodeHub scout (scrape_codehub.js)
 *  4. Daily 05:30 GMT: Harvests live fixtures & prepares next uncorrelated cycle if exposure < 24%
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
const EXP_FILE = path.join(ROOT_DIR, 'runtime', 'syndicate_experience.json');
const LOG_FILE = path.join(ROOT_DIR, 'runtime', 'logs', 'syndicate_daemon.log');

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function runScript(relPath, envExtra = {}) {
  const res = spawnSync('node', [path.join(ROOT_DIR, relPath)], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ...envExtra }
  });
  if (res.status !== 0) {
    log(`[WARN] ${relPath} exited ${res.status}: ${(res.stderr || res.stdout || '').slice(-300)}`);
  }
  return res.stdout || '';
}

function runLearningLoop() {
  const pyCode = `
import sqlite3, json, os
from datetime import datetime
db = ${JSON.stringify(DB_PATH)}
exp_path = ${JSON.stringify(EXP_FILE)}
c = sqlite3.connect(db)
settled = c.execute("""
    SELECT ticket_id, booking_code, stake, total_odds, potential_payout, status, realized_pnl
    FROM syndicate_tickets WHERE status IN ('WON', 'LOST')
""").fetchall()
already = set(r[0] for r in c.execute("SELECT DISTINCT ticket_id FROM syndicate_post_mortems").fetchall())
new_audits = 0
for tid, code, stake, odds, pw, st, pnl in settled:
    if tid in already:
        continue
    cat = 'EDGE_REALIZED' if st == 'WON' else 'VARIANCE_OR_TACTICAL_MISS'
    summary = f"Ticket {tid} ({code}) settled {st} | Stake {stake} | Odds {odds} | PnL {pnl}"
    rule = "Maintain uncorrelated multi-sport spread" if st == 'WON' else "Audit losing leg odds band and market type"
    c.execute("INSERT INTO syndicate_post_mortems (ticket_id, timestamp, failure_category, tactical_summary, preventative_rule_added) VALUES (?,?,?,?,?)",
              (tid, datetime.utcnow().isoformat(), cat, summary, rule))
    new_audits += 1

stats = c.execute("""
    SELECT COUNT(*),
           SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END),
           SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END),
           SUM(CASE WHEN status='IN_PROGRESS' THEN 1 ELSE 0 END),
           COALESCE(SUM(realized_pnl), 0)
    FROM syndicate_tickets WHERE status IN ('WON','LOST','IN_PROGRESS')
""").fetchone()
c.commit(); c.close()

exp = {
    "updated_at": datetime.utcnow().isoformat(),
    "total_tracked": stats[0],
    "won": stats[1] or 0,
    "lost": stats[2] or 0,
    "in_progress": stats[3] or 0,
    "realized_pnl_ghs": round(stats[4] or 0.0, 2),
    "new_post_mortems_logged": new_audits
}
with open(exp_path, 'w') as f:
    json.dump(exp, f, indent=2)
print(json.dumps(exp))
`;
  const r = spawnSync('python3', ['-c', pyCode], { encoding: 'utf8' });
  if (r.stdout) log(`[LearningLoop] ${r.stdout.trim()}`);
}

(async () => {
  log('========================================================');
  log('  HERMES SYNDICATE 24/7 AUTONOMOUS LOOP & LEARNING ENGINE');
  log('========================================================');

  let tick = 0;
  while (true) {
    tick++;
    log(`--- Cycle #${tick} starting ---`);
    try {
      // 1. Live Open/Settled Bets + Balance + Cashout Audit + Terminal Sync
      const monOut = runScript('syndicate/monitor_syndicate_bets.js');
      const balMatch = monOut.match(/Live Balance:\s*GHS\s*([0-9,.]+)/i);
      if (balMatch) log(`[Telemetry] Wallet: GHS ${balMatch[1]}`);

      // 2. Self-Learning Post-Mortem & Experience Calibration
      runLearningLoop();

      // 3. Sync sanitized Syndicate Terminal to root index.html & docs/index.html inside Jac repo
      const termSrc = path.join(ROOT_DIR, 'syndicate', 'syndicate_terminal.html');
      if (fs.existsSync(termSrc)) {
        fs.copyFileSync(termSrc, path.join(ROOT_DIR, 'index.html'));
        fs.mkdirSync(path.join(ROOT_DIR, 'docs'), { recursive: true });
        fs.copyFileSync(termSrc, path.join(ROOT_DIR, 'docs', 'index.html'));
        spawnSync('bash', ['-c', 'git add index.html docs/index.html syndicate/syndicate_terminal.html data/syndicate_ledger.sqlite && ! git diff --staged --quiet && git commit -m "chore(jac-daemon): live terminal & ledger telemetry sync" && git pull --rebase origin main && git push origin main'], { cwd: ROOT_DIR, timeout: 30000 });
      }

      // 4. Every 12 ticks (~60 mins): CodeHub Fresh Scout & Session Keep-Alive
      if (tick === 1 || tick % 12 === 0) {
        log('[CodeHub] Running hourly live CodeHub intelligence & trap-purge...');
        runScript('syndicate/scrape_codehub.js');
      }

      // 4. Daily 05:30 GMT: Refresh live fixtures cache for next cycle
      const now = new Date();
      if (now.getUTCHours() === 5 && now.getUTCMinutes() >= 30 && now.getUTCMinutes() < 36) {
        log('[05:30 GMT Gate] Harvesting fresh daily fixtures...');
        runScript('syndicate/harvest_live_fixtures.js');
      }
    } catch (e) {
      log(`[ERROR] Cycle #${tick}: ${e.message}`);
    }

    log(`--- Cycle #${tick} complete. Sleeping 5 minutes... ---`);
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
  }
})();
