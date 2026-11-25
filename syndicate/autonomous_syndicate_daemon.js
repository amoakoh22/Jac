/**
 * Hermes Syndicate - Autonomous 24/7 Loop & Self-Learning Engine
 * Runs continuously without user prompting:
 *  1. Every 5m: monitor_syndicate_bets.js (AUTO_CASHOUT=1) + live_api_audit.js + reconcile_live_audit.py
 *  2. Every 5m: closed_loop_learner.py + capital_ledger.py + update_status.py + render_syndicate_terminal.py
 *  3. Every 5m: Sync index.html, docs/index.html, status.json, docs/status.json, sqlite & commit+push to origin/main
 *  4. 3x Daily (06:00, 14:00, 20:00 GMT): CodeHub scout (scrape_codehub.js)
 *  5. Daily 05:30 GMT: Harvest live fixtures cache
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT_DIR, 'runtime', 'logs', 'syndicate_daemon.log');
const CYCLE_SLEEP_MS = parseInt(process.env.JAC_CYCLE_SLEEP_MS || String(5 * 60 * 1000), 10);

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function runCmd(bin, args, envExtra = {}, timeout = 180000) {
  const res = spawnSync(bin, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...envExtra }
  });
  if (res.status !== 0) {
    log(`[WARN] ${bin} ${args.join(' ')} exited ${res.status}: ${(res.stderr || res.stdout || '').slice(-300)}`);
  }
  return res;
}

function syncAndPush() {
  const termSrc = path.join(ROOT_DIR, 'syndicate', 'syndicate_terminal.html');
  const statusSrc = path.join(ROOT_DIR, 'status.json');
  fs.mkdirSync(path.join(ROOT_DIR, 'docs'), { recursive: true });
  if (fs.existsSync(termSrc)) {
    fs.copyFileSync(termSrc, path.join(ROOT_DIR, 'index.html'));
    fs.copyFileSync(termSrc, path.join(ROOT_DIR, 'docs', 'index.html'));
  }
  if (fs.existsSync(statusSrc)) {
    fs.copyFileSync(statusSrc, path.join(ROOT_DIR, 'docs', 'status.json'));
  }

  const files = [
    'index.html', 'docs/index.html', 'status.json', 'docs/status.json',
    'syndicate/syndicate_terminal.html', 'data/syndicate_ledger.sqlite', 'data/syndicate_heuristics.json'
  ].filter(f => fs.existsSync(path.join(ROOT_DIR, f)));

  runCmd('git', ['add', ...files], {}, 30000);
  const diffCheck = spawnSync('git', ['diff', '--staged', '--quiet'], { cwd: ROOT_DIR, timeout: 15000 });
  if (diffCheck.status === 0) {
    log('[GitSync] No staged changes to push.');
    return;
  }
  const c = runCmd('git', ['commit', '-m', 'chore(jac-daemon): live terminal, status & ledger telemetry sync'], {}, 30000);
  if (c.status !== 0) return;
  const rb = runCmd('git', ['pull', '--rebase', '--autostash', 'origin', 'main'], {}, 45000);
  if (rb.status !== 0) return;
  const p = runCmd('git', ['push', 'origin', 'main'], {}, 45000);
  if (p.status === 0) {
    const sha = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).stdout || '').trim();
    log(`[GitSync] Pushed ${sha} to origin/main.`);
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
      // 1. Live Open/Settled Bets + Balance + Auto-Cashout + Survivor Re-Bullet
      let mon = runCmd('node', ['syndicate/monitor_syndicate_bets.js'], { AUTO_CASHOUT: '1', AUTO_REBULLET: '1' });
      let monOut = mon.stdout || '';
      if (monOut.includes('Stored session invalid')) {
        log('[SessionSelfHeal] Stored session expired — running active_login_sentinel.js (short non-interactive check)...');
        const auth = runCmd('node', ['syndicate/active_login_sentinel.js'], { SENTINEL_WAIT: '10' }, 60000);
        if ((auth.stdout || '').includes('AUTHENTICATED')) {
          log('[SessionSelfHeal] Re-authenticated cleanly — retrying monitor pass...');
          mon = runCmd('node', ['syndicate/monitor_syndicate_bets.js'], { AUTO_CASHOUT: '1', AUTO_REBULLET: '1' });
          monOut = mon.stdout || '';
        }
      }
      const balMatch = monOut.match(/Live Balance:\s*GHS\s*([0-9,.]+)/i);
      if (balMatch) log(`[Telemetry] Wallet: GHS ${balMatch[1]}`);

      // 2. Direct API Audit + Twin-aware Reconciler + Closed-Loop Learner + Capital Ledger
      runCmd('node', ['syndicate/live_api_audit.js']);
      runCmd('python3', ['syndicate/reconcile_live_audit.py']);
      const learn = runCmd('python3', ['syndicate/closed_loop_learner.py']);
      if (learn.stdout) log(`[LearningLoop] ${learn.stdout.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
      runCmd('python3', ['syndicate/capital_ledger.py']);

      // 3. Update status.json (liveness timestamp) & Render KPI Terminal
      runCmd('python3', ['syndicate/update_status.py', '--source', 'local_daemon', '--cloud-result', 'unchanged']);
      runCmd('python3', ['syndicate/render_syndicate_terminal.py']);

      // 4. Sync index.html / docs/index.html / status.json and commit+push to origin/main every cycle
      syncAndPush();

      // 5. Intelligent 3x Daily Pre-Slate CodeHub Scout Windows (06:00, 14:00, 20:00 GMT)
      const now = new Date();
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      if ([6, 14, 20].includes(utcH) && utcM >= 0 && utcM < 6) {
        log(`[CodeHub Window ${utcH}:00 GMT] Running scheduled pre-slate CodeHub intelligence & creator trust audit...`);
        runCmd('node', ['syndicate/scrape_codehub.js']);
      }

      // 6. Daily 05:30 GMT: Refresh live fixtures cache for next cycle
      if (utcH === 5 && utcM >= 30 && utcM < 36) {
        log('[05:30 GMT Gate] Harvesting fresh daily fixtures...');
        runCmd('node', ['syndicate/harvest_live_fixtures.js']);
      }
    } catch (e) {
      log(`[ERROR] Cycle #${tick}: ${e.message}`);
    }

    log(`--- Cycle #${tick} complete. Sleeping ${Math.round(CYCLE_SLEEP_MS / 1000)}s... ---`);
    await new Promise(r => setTimeout(r, CYCLE_SLEEP_MS));
  }
})();
