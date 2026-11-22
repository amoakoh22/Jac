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
  const r = spawnSync('python3', ['syndicate/closed_loop_learner.py'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 120000
  });
  if (r.status !== 0) {
    log(`[WARN] closed_loop_learner.py exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-300)}`);
  } else if (r.stdout) {
    log(`[LearningLoop] ${r.stdout.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
  }
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
      // 1. Live Open/Settled Bets + Balance + Auto-Cashout + Survivor Re-Bullet + Leg-Level Learning
      //    (monitor_syndicate_bets.js already invokes closed_loop_learner.py, creator_trust_engine.py, and render_syndicate_terminal.py)
      let monOut = runScript('syndicate/monitor_syndicate_bets.js', { AUTO_CASHOUT: '1', AUTO_REBULLET: '1' });
      if (monOut.includes('Stored session invalid')) {
        log('[SessionSelfHeal] Stored session expired — running active_login_sentinel.js...');
        const authOut = runScript('syndicate/active_login_sentinel.js');
        if (authOut.includes('AUTHENTICATED')) {
          log('[SessionSelfHeal] Re-authenticated cleanly — retrying monitor pass...');
          monOut = runScript('syndicate/monitor_syndicate_bets.js', { AUTO_CASHOUT: '1', AUTO_REBULLET: '1' });
        }
      }
      const balMatch = monOut.match(/Live Balance:\s*GHS\s*([0-9,.]+)/i);
      if (balMatch) log(`[Telemetry] Wallet: GHS ${balMatch[1]}`);

      // 2. Ensure closed-loop learning runs even if monitor had 0 active items
      if (monOut.includes('No IN_PROGRESS syndicate tickets')) {
        runLearningLoop();
        spawnSync('python3', ['syndicate/render_syndicate_terminal.py'], { cwd: ROOT_DIR, encoding: 'utf8' });
      }

      // 3. Sync sanitized Syndicate Terminal to root index.html & docs/index.html inside Jac repo
      const termSrc = path.join(ROOT_DIR, 'syndicate', 'syndicate_terminal.html');
      if (fs.existsSync(termSrc)) {
        fs.copyFileSync(termSrc, path.join(ROOT_DIR, 'index.html'));
        fs.mkdirSync(path.join(ROOT_DIR, 'docs'), { recursive: true });
        fs.copyFileSync(termSrc, path.join(ROOT_DIR, 'docs', 'index.html'));
        spawnSync('bash', ['-c', 'git add index.html docs/index.html syndicate/syndicate_terminal.html data/syndicate_ledger.sqlite && ! git diff --staged --quiet && git commit -m "chore(jac-daemon): live terminal & ledger telemetry sync" && git pull --rebase origin main && git push origin main'], { cwd: ROOT_DIR, timeout: 30000 });
      }

      // 4. Intelligent 3x Daily Pre-Slate CodeHub Scout Windows (06:00, 14:00, 20:00 GMT)
      const now = new Date();
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      if ([6, 14, 20].includes(utcH) && utcM >= 0 && utcM < 6) {
        log(`[CodeHub Window ${utcH}:00 GMT] Running scheduled pre-slate CodeHub intelligence & creator trust audit...`);
        runScript('syndicate/scrape_codehub.js');
      }

      // 5. Daily 05:30 GMT: Refresh live fixtures cache for next cycle
      if (utcH === 5 && utcM >= 30 && utcM < 36) {
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
