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

// Self-learning closed-loop post-mortem & heuristics calibration
run('python3', ['syndicate/closed_loop_learner.py']);

run('node', ['syndicate/scrape_codehub.js']);
console.log('[Cron] Hermes Syndicate single-pass cycle complete.');
