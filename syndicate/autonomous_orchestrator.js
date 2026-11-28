'use strict';

/**
 * Jac Syndicate — 24/7 Autonomous Research, Learning & Staking Orchestrator
 *
 * Runs automatically after monitor + reconcile + closed_loop_learner in both
 * GitHub Actions (`syndicate_24_7_cron.yml`) and the local daemon.
 *
 * Two Autonomous Profit Engines:
 *   1. Mode C Vault Ratchet (House-Money Compounder):
 *      - When the active Vault step settles WON, advances to Step N+1 using pure
 *        realized profit (house money, capped at VAULT_MAX_STAKE_GHS).
 *      - When the active Vault step settles LOST, resets to Step 1 (GHS 2.00 seed)
 *        after a 12h cooldown.
 *   2. Mode A x100+ +EV Jackpot Replenisher:
 *      - Maintains X100_TARGET_ACTIVE_SLOTS (2) concurrent disjoint x100+ +EV slips.
 *      - Uses Hermes `learning_filter.js` + `mode_a_x100_builder.js` + `place_quant_tickets.js`
 *        (strictly v3.0.0 heuristics, min_betradar_rtp >= 0.98, no @1.01 rule_30, 0% overlap,
 *        Flexi/1UP/EarlyGoals verified UNCHECKED).
 *
 * Hard Immutable Safety Rails:
 *   - Bankroll Foundation Floor: never auto-stakes if liquid_balance < GHS 120.00
 *   - Daily Auto-Stake Cap: max GHS 10.00 auto-staked per UTC day
 *   - Idempotent SQLite Lock (`syndicate_auto_deployments`): prevents duplicate bets
 *
 * Usage:
 *   node syndicate/autonomous_orchestrator.js --dry-run
 *   AUTO_DEPLOY=1 node syndicate/autonomous_orchestrator.js --live
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
const UNIVERSE_PATH = path.join(ROOT_DIR, 'runtime', 'anointed_72h_universe.json');
const RESULTS_PATH = path.join(ROOT_DIR, 'runtime', 'anointed_v4_live_results.json');

const CONFIG = Object.freeze({
  MIN_BANKROLL_FLOOR_GHS: 120.0,
  MAX_DAILY_AUTO_STAKE_GHS: 10.0,
  VAULT_SEED_STAKE_GHS: 2.0,
  VAULT_MAX_STAKE_GHS: 15.0,
  VAULT_LOSS_COOLDOWN_HOURS: 12,
  X100_TARGET_ACTIVE_SLOTS: 2,
  X100_MIN_ODDS_CLASS: 25.0,
  X100_STAKE_GHS: 2.0,
  X100_MIN_MULTIPLIER: 100.0,
  X100_FALLBACK_MULTIPLIER: 25.0,
  X100_EV_THRESHOLD: 1.02,
  SKIP_RETRY_COOLDOWN_HOURS: 3,
  PROBE_MAX_AGE_MINUTES: 120,
});

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function utcDateStr(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function ensureAutoDeployTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS syndicate_auto_deployments (
      deploy_key TEXT PRIMARY KEY,
      utc_date TEXT NOT NULL,
      strategy TEXT NOT NULL,
      step_num INTEGER DEFAULT 0,
      stake_ghs REAL DEFAULT 0.0,
      booking_code TEXT DEFAULT '',
      status TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
}

function evaluatePortfolioPlan(db, now = new Date()) {
  ensureAutoDeployTable(db);
  const today = utcDateStr(now);

  const walletRow = db.prepare('SELECT liquid_balance FROM syndicate_wallets WHERE id = 1').get();
  const balance = walletRow ? Number(walletRow.liquid_balance || 0) : 0;

  const dailyRow = db.prepare(
    `SELECT COALESCE(SUM(stake_ghs), 0) AS spent
     FROM syndicate_auto_deployments
     WHERE utc_date = ? AND status IN ('PLACED', 'PENDING')`
  ).get(today);
  const dailySpent = Number(dailyRow?.spent || 0);
  const dailyRemaining = round2(Math.max(0, CONFIG.MAX_DAILY_AUTO_STAKE_GHS - dailySpent));

  const actions = [];
  const holds = [];

  if (balance < CONFIG.MIN_BANKROLL_FLOOR_GHS) {
    holds.push(`BANKROLL_FLOOR: liquid GHS ${balance.toFixed(2)} < floor GHS ${CONFIG.MIN_BANKROLL_FLOOR_GHS.toFixed(2)}`);
    return { balance, dailySpent, dailyRemaining, actions, holds };
  }

  // --- Engine 1: Mode C Vault Ratchet ---
  const ladder = db.prepare("SELECT * FROM syndicate_vault_ladders WHERE ladder_id = 'VAULT_LADDER_V1'").get();
  if (ladder) {
    const activeCode = ladder.active_booking_code || '';
    const bullet = activeCode
      ? db.prepare('SELECT bullet_id, status, stake, realized_pnl, potential_payout, settled_at FROM syndicate_codehub_bullets WHERE booking_code = ? ORDER BY rowid DESC LIMIT 1').get(activeCode)
      : null;

    if (!bullet || bullet.status === 'IN_PROGRESS' || bullet.status === 'PENDING') {
      holds.push(`VAULT_ACTIVE: Step ${ladder.current_step} (${activeCode || 'none'}) is still IN_PROGRESS`);
    } else if (bullet.status === 'WON') {
      const nextStep = Number(ladder.current_step || 1) + 1;
      const profit = Number(bullet.realized_pnl || 0) > 0
        ? Number(bullet.realized_pnl)
        : Math.max(CONFIG.VAULT_SEED_STAKE_GHS, Number(bullet.potential_payout || 0) - Number(bullet.stake || 0));
      const nextStake = round2(Math.min(CONFIG.VAULT_MAX_STAKE_GHS, Math.max(CONFIG.VAULT_SEED_STAKE_GHS, profit)));
      const deployKey = `VAULT_STEP_${nextStep}_AFTER_${activeCode}`;
      const existing = db.prepare('SELECT status FROM syndicate_auto_deployments WHERE deploy_key = ?').get(deployKey);

      if (existing) {
        holds.push(`VAULT_LOCKED: ${deployKey} already recorded (${existing.status})`);
      } else if (nextStake > dailyRemaining) {
        holds.push(`VAULT_CAP: Step ${nextStep} needs GHS ${nextStake.toFixed(2)} > daily remaining GHS ${dailyRemaining.toFixed(2)}`);
      } else {
        actions.push({
          strategy: 'MODE_C_VAULT',
          deployKey,
          step: nextStep,
          stake: nextStake,
          reason: `Step ${ladder.current_step} (${activeCode}) WON; ratcheting house money to Step ${nextStep}`,
        });
      }
    } else if (bullet.status === 'LOST' || bullet.status === 'CASHED_OUT') {
      const settledMs = bullet.settled_at ? Date.parse(bullet.settled_at) : 0;
      const hoursSince = settledMs ? (now.getTime() - settledMs) / 3600000 : CONFIG.VAULT_LOSS_COOLDOWN_HOURS;
      const deployKey = `VAULT_RESET_STEP1_AFTER_${activeCode}`;
      const existing = db.prepare('SELECT status FROM syndicate_auto_deployments WHERE deploy_key = ?').get(deployKey);

      if (existing) {
        holds.push(`VAULT_RESET_LOCKED: ${deployKey} already recorded (${existing.status})`);
      } else if (hoursSince < CONFIG.VAULT_LOSS_COOLDOWN_HOURS) {
        holds.push(`VAULT_COOLDOWN: ${activeCode} ${bullet.status} ${hoursSince.toFixed(1)}h ago (< ${CONFIG.VAULT_LOSS_COOLDOWN_HOURS}h)`);
      } else if (CONFIG.VAULT_SEED_STAKE_GHS > dailyRemaining) {
        holds.push(`VAULT_RESET_CAP: daily remaining GHS ${dailyRemaining.toFixed(2)} < GHS ${CONFIG.VAULT_SEED_STAKE_GHS.toFixed(2)}`);
      } else {
        actions.push({
          strategy: 'MODE_C_VAULT',
          deployKey,
          step: 1,
          stake: CONFIG.VAULT_SEED_STAKE_GHS,
          reason: `Previous Vault (${activeCode}) ${bullet.status}; resetting cleanly to Step 1 seed`,
        });
      }
    }
  }

  // --- Engine 2: Mode A x100+ +EV Jackpot Replenisher ---
  const activeX100 = db.prepare(
    `SELECT booking_code, total_odds FROM syndicate_codehub_bullets
     WHERE status = 'IN_PROGRESS' AND total_odds >= ?`
  ).all(CONFIG.X100_MIN_ODDS_CLASS);

  const plannedSpend = actions.reduce((acc, a) => acc + a.stake, 0);
  const remAfterVault = round2(Math.max(0, dailyRemaining - plannedSpend));

  if (activeX100.length >= CONFIG.X100_TARGET_ACTIVE_SLOTS) {
    holds.push(`X100_SLOTS_FULL: ${activeX100.length}/${CONFIG.X100_TARGET_ACTIVE_SLOTS} active (${activeX100.map(r => r.booking_code).join(', ')})`);
  } else {
    const slotNum = activeX100.length + 1;
    const deployKey = `X100_${today}_SLOT_${slotNum}`;
    const existing = db.prepare('SELECT status, created_at FROM syndicate_auto_deployments WHERE deploy_key = ?').get(deployKey);
    const isLocked = existing && (existing.status === 'PLACED' || existing.status === 'PENDING');
    const hoursSinceSkip = existing && existing.created_at
      ? (now.getTime() - Date.parse(existing.created_at)) / 3600000
      : CONFIG.SKIP_RETRY_COOLDOWN_HOURS;

    if (isLocked) {
      holds.push(`X100_LOCKED: ${deployKey} already ${existing.status}`);
    } else if (existing && hoursSinceSkip < CONFIG.SKIP_RETRY_COOLDOWN_HOURS) {
      holds.push(`X100_COOLDOWN: ${deployKey} (${existing.status}) ${hoursSinceSkip.toFixed(1)}h ago (< ${CONFIG.SKIP_RETRY_COOLDOWN_HOURS}h)`);
    } else if (CONFIG.X100_STAKE_GHS > remAfterVault) {
      holds.push(`X100_CAP: needs GHS ${CONFIG.X100_STAKE_GHS.toFixed(2)} > remaining GHS ${remAfterVault.toFixed(2)}`);
    } else {
      actions.push({
        strategy: 'MODE_A_X100',
        deployKey,
        step: slotNum,
        stake: CONFIG.X100_STAKE_GHS,
        reason: `Active jackpot slots ${activeX100.length}/${CONFIG.X100_TARGET_ACTIVE_SLOTS}; scanning 100x+ (or 25x+ Sweet-Spot) +EV slip`,
      });
    }
  }

  return { balance, dailySpent, dailyRemaining, actions, holds };
}

function runCmd(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 240000,
  });
  return res;
}

function ensureFreshUniverse() {
  let fresh = false;
  if (fs.existsSync(UNIVERSE_PATH)) {
    const ageMin = (Date.now() - fs.statSync(UNIVERSE_PATH).mtimeMs) / 60000;
    if (ageMin <= CONFIG.PROBE_MAX_AGE_MINUTES) fresh = true;
  }
  if (!fresh) {
    console.log('[Orchestrator] Probing fresh 72h SportyBet fixture universe...');
    const r = runCmd('node', ['syndicate/probe_anointed_universe.js']);
    if (r.status !== 0) {
      throw new Error(`probe_anointed_universe.js failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 300)}`);
    }
  }
}

function recordDeployRow(db, action, status, bookingCode = '', reason = '') {
  db.prepare(
    `INSERT OR REPLACE INTO syndicate_auto_deployments
     (deploy_key, utc_date, strategy, step_num, stake_ghs, booking_code, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    action.deployKey,
    utcDateStr(),
    action.strategy,
    action.step,
    action.stake,
    bookingCode,
    status,
    reason || action.reason,
    new Date().toISOString()
  );
}

async function deployModeAX100(action, isLive) {
  const S = require('./sportybet_session');
  const sportybetApi = require('./quant/sportybet_api');
  const bonusModel = require('./quant/bonus_model');
  const learningFilter = require('./quant/learning_filter');
  const modeA = require('./quant/mode_a_x100_builder');
  const { scanMultiSportCandidates, verifyAndPlaceTicket } = require('./quant/place_quant_tickets');

  const learningCtx = learningFilter.loadLearningContext({ dbPath: DB_PATH });
  const { browser, context, page } = await S.launchBrowser();
  try {
    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2000);
    const sess = await S.readSession(page);
    if (!sess || !sess.isLogged) throw new Error('SportyBet session unauthenticated during Mode A auto-deploy');

    let bonusPlan = bonusModel.getDefaultBonusPlan();
    try {
      const rawPlans = await sportybetApi.fetchBonusPlans(context.request);
      const parsed = bonusModel.parseBonusPlan(rawPlans);
      if (parsed) bonusPlan = parsed;
    } catch (_) {}

    const scanRes = await scanMultiSportCandidates(context.request, { maxEventsPerSport: 60, maxHoursAhead: 72 });
    const candidates = Array.isArray(scanRes) ? scanRes : (scanRes?.modeACandidates || scanRes?.candidates || []);
    let tierLabel = 'x100+ Mega-Jackpot';
    let builtRes = modeA.buildX100PlusEvTicket(candidates, bonusPlan, learningCtx, {
      minMultiplier: CONFIG.X100_MIN_MULTIPLIER,
      minTicketEv: CONFIG.X100_EV_THRESHOLD,
      minStake: action.stake,
      maxStake: action.stake,
    });

    // Near-miss re-engineering: if 100x+ pool is thin, build a 25x+ Sweet-Spot Mid-Jackpot (10-18F, much higher hit rate)
    if (!builtRes || !builtRes.ok || !builtRes.ticket) {
      tierLabel = '25x+ Sweet-Spot Mid-Jackpot';
      builtRes = modeA.buildX100PlusEvTicket(candidates, bonusPlan, learningCtx, {
        minMultiplier: CONFIG.X100_FALLBACK_MULTIPLIER,
        minFolds: 10,
        maxFolds: 18,
        minTicketEv: CONFIG.X100_EV_THRESHOLD,
        minStake: action.stake,
        maxStake: action.stake,
      });
    }

    if (!builtRes || !builtRes.ok || !builtRes.ticket || !builtRes.ticket.legs || builtRes.ticket.legs.length < 3) {
      const diag = builtRes?.diagnostics ? ` diag=${JSON.stringify(builtRes.diagnostics).slice(0, 140)}` : '';
      return { placed: false, reason: `No qualifying >=25x +EV ticket met Hermes learning & RTP>=0.98 filters (scanned ${candidates.length} candidates${diag})` };
    }

    const builtTicket = {
      ...builtRes.ticket,
      recommendedStakeGhs: action.stake,
      name: `Autonomous ${tierLabel} (${utcDateStr()})`,
    };
    const mp = builtTicket.mathProof || {};

    if (!isLive) {
      return {
        placed: false,
        dryRun: true,
        reason: `DRY-RUN qualified ${tierLabel} ${builtTicket.legs.length}F @ ${Number(mp.effectiveMultiplier || 0).toFixed(2)}x (EV=${Number(mp.trueExpectedRtp || 0).toFixed(3)})`,
      };
    }

    const receipt = await verifyAndPlaceTicket(context, page, builtTicket, bonusPlan, 1);
    const balAfter = (await S.readSession(page))?.balance ?? null;
    await S.persistState(context);

    if (!receipt || !receipt.success || !receipt.booking_code) {
      return { placed: false, reason: `Placement returned unconfirmed receipt: ${JSON.stringify(receipt || {}).slice(0, 200)}` };
    }

    const bulletId = `CH_AUTO_X100_${utcDateStr().replace(/-/g, '')}_S${action.step}`;
    fs.writeFileSync(RESULTS_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      balanceAfter: balAfter,
      tickets: [{
        title: builtTicket.name,
        bulletId,
        role: 'SOLO',
        waveGroupId: '',
        stake: receipt.stake || action.stake,
        legs: receipt.legs || builtTicket.legs,
        baseOdds: receipt.baseOdds || mp.baseOdds || 0,
        effectiveMultiplier: receipt.effectiveMultiplier || mp.effectiveMultiplier || 0,
        trueExpectedRtp: receipt.trueExpectedRtp || mp.trueExpectedRtp || 0,
        success: true,
        booking_code: receipt.booking_code,
        potentialWin: receipt.potentialWin || round2(action.stake * (receipt.effectiveMultiplier || mp.effectiveMultiplier || 25)),
        folds: receipt.folds || builtTicket.legs.length,
        screenshotPath: receipt.screenshotPath || '',
      }],
    }, null, 2));

    const rec = runCmd('python3', ['syndicate/record_anointed_v4.py']);
    if (rec.status !== 0) {
      console.warn('[Orchestrator] record_anointed_v4.py warning:', rec.stderr || rec.stdout);
    }
    return {
      placed: true,
      bookingCode: receipt.booking_code,
      reason: `Placed ${tierLabel} ${receipt.folds || builtTicket.legs.length}F (${receipt.booking_code}) @ ${Number(receipt.effectiveMultiplier || mp.effectiveMultiplier || 0).toFixed(2)}x`,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const isLive = process.argv.includes('--live') && process.env.AUTO_DEPLOY === '1';
  const modeLabel = isLive ? 'LIVE (AUTO_DEPLOY=1)' : 'DRY-RUN';

  // Always refresh Hermes closed-loop learner first so new lessons gate every candidate
  const lrn = runCmd('python3', ['syndicate/closed_loop_learner.py']);
  if (lrn.status !== 0) {
    console.warn('[Orchestrator] closed_loop_learner warning:', (lrn.stderr || '').slice(0, 200));
  }

  const db = new DatabaseSync(DB_PATH);
  try {
    const plan = evaluatePortfolioPlan(db, new Date());
    console.log(`[Orchestrator | ${modeLabel}] Balance: GHS ${plan.balance.toFixed(2)} | Daily Auto-Spent: GHS ${plan.dailySpent.toFixed(2)}/${CONFIG.MAX_DAILY_AUTO_STAKE_GHS.toFixed(2)} | Actions: ${plan.actions.length}`);
    for (const h of plan.holds) console.log(`  [HOLD] ${h}`);

    for (const action of plan.actions) {
      console.log(`  [ACTION] ${action.strategy} (${action.deployKey}) stake=GHS ${action.stake.toFixed(2)} — ${action.reason}`);
      if (!isLive) {
        console.log(`  [DRY-RUN] Would execute ${action.strategy} now (pass --live with AUTO_DEPLOY=1 to place).`);
        continue;
      }

      // Atomic idempotent lock BEFORE touching SportyBet
      recordDeployRow(db, action, 'PENDING', '', `In-flight: ${action.reason}`);

      try {
        if (action.strategy === 'MODE_C_VAULT') {
          ensureFreshUniverse();
          const dep = runCmd('node', [
            'syndicate/deploy_mode_c_vault.js',
            `--step=${action.step}`,
            `--stake=${action.stake.toFixed(2)}`,
            '--live',
          ]);
          if (dep.status !== 0) {
            recordDeployRow(db, action, 'FAILED', '', `deploy_mode_c_vault exit ${dep.status}: ${(dep.stderr || dep.stdout || '').slice(0, 240)}`);
            console.error(`  [ERROR] Mode C Vault failed:`, (dep.stderr || dep.stdout || '').slice(0, 300));
            continue;
          }
          let code = '';
          if (fs.existsSync(RESULTS_PATH)) {
            const res = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
            code = res?.tickets?.[0]?.booking_code || '';
          }
          if (code) {
            runCmd('python3', ['syndicate/record_anointed_v4.py']);
            recordDeployRow(db, action, 'PLACED', code, `Placed Vault Step ${action.step} (${code})`);
            console.log(`  [PLACED] Mode C Vault Step ${action.step}: ${code}`);
          } else {
            recordDeployRow(db, action, 'SKIPPED_NO_CANDIDATE', '', 'No qualifying Mode C 3F integer-push candidate found');
            console.log('  [SKIP] No qualifying Mode C Vault candidate met strict RTP/push filters.');
          }
        } else if (action.strategy === 'MODE_A_X100') {
          const out = await deployModeAX100(action, true);
          if (out.placed) {
            recordDeployRow(db, action, 'PLACED', out.bookingCode, out.reason);
            console.log(`  [PLACED] Mode A x100+: ${out.bookingCode}`);
          } else {
            recordDeployRow(db, action, 'SKIPPED_NO_CANDIDATE', '', out.reason);
            console.log(`  [SKIP] Mode A x100+: ${out.reason}`);
          }
        }
      } catch (err) {
        recordDeployRow(db, action, 'FAILED', '', String(err.message || err).slice(0, 240));
        console.error(`  [ERROR] ${action.deployKey}:`, err.message || err);
      }
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Orchestrator FATAL]', err);
    process.exit(1);
  });
}

module.exports = { CONFIG, ensureAutoDeployTable, evaluatePortfolioPlan, round2 };
