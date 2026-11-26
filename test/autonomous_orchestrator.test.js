'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { CONFIG, evaluatePortfolioPlan } = require('../syndicate/autonomous_orchestrator');

function makeMemDb({ balance = 162.67, vaultStatus = 'IN_PROGRESS', vaultStep = 2, vaultCode = 'C2P3EB', vaultPnl = 0, x100Count = 2 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE syndicate_wallets (id INTEGER PRIMARY KEY, liquid_balance REAL);
    CREATE TABLE syndicate_vault_ladders (
      ladder_id TEXT PRIMARY KEY, seed_stake REAL, current_equity REAL, banked_profit REAL,
      current_step INTEGER, target_multiplier REAL, active_booking_code TEXT, status TEXT, updated_at TEXT
    );
    CREATE TABLE syndicate_codehub_bullets (
      bullet_id TEXT PRIMARY KEY, booking_code TEXT, stake REAL, total_odds REAL,
      potential_payout REAL, status TEXT, realized_pnl REAL, settled_at TEXT
    );
  `);
  db.prepare('INSERT INTO syndicate_wallets VALUES (1, ?)').run(balance);
  db.prepare(
    "INSERT INTO syndicate_vault_ladders VALUES ('VAULT_LADDER_V1', 3.0, 2.9, 3.0, ?, 100.0, ?, 'ACTIVE', '2026-11-25T17:38:00Z')"
  ).run(vaultStep, vaultCode);
  db.prepare(
    'INSERT INTO syndicate_codehub_bullets VALUES (?, ?, 2.90, 1.99, 5.78, ?, ?, ?)'
  ).run('VAULT_B1', vaultCode, vaultStatus, vaultPnl, vaultStatus === 'IN_PROGRESS' ? null : '2026-11-26T22:00:00Z');

  for (let i = 1; i <= x100Count; i++) {
    db.prepare(
      'INSERT INTO syndicate_codehub_bullets VALUES (?, ?, 3.0, 120.0, 360.0, ?, 0.0, NULL)'
    ).run(`X100_${i}`, `CODE${i}`, 'IN_PROGRESS');
  }
  return db;
}

test('holds everything when all slots are active', () => {
  const db = makeMemDb({ balance: 162.67, vaultStatus: 'IN_PROGRESS', x100Count: 2 });
  const plan = evaluatePortfolioPlan(db, new Date('2026-11-26T10:00:00Z'));
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.holds.some(h => h.startsWith('VAULT_ACTIVE')));
  assert.ok(plan.holds.some(h => h.startsWith('X100_SLOTS_FULL')));
  db.close();
});

test('enforces bankroll foundation floor (< GHS 120)', () => {
  const db = makeMemDb({ balance: 119.5, vaultStatus: 'WON', vaultPnl: 2.88, x100Count: 0 });
  const plan = evaluatePortfolioPlan(db, new Date('2026-11-26T23:00:00Z'));
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.holds[0].startsWith('BANKROLL_FLOOR'));
  db.close();
});

test('ratchets Mode C Vault on WON using pure house-money profit and replenishes open x100 slot', () => {
  const db = makeMemDb({ balance: 168.45, vaultStatus: 'WON', vaultStep: 2, vaultCode: 'C2P3EB', vaultPnl: 2.88, x100Count: 1 });
  const plan = evaluatePortfolioPlan(db, new Date('2026-11-26T23:00:00Z'));
  assert.equal(plan.actions.length, 2);
  const vaultAct = plan.actions.find(a => a.strategy === 'MODE_C_VAULT');
  const x100Act = plan.actions.find(a => a.strategy === 'MODE_A_X100');
  assert.equal(vaultAct.step, 3);
  assert.equal(vaultAct.stake, 2.88);
  assert.equal(x100Act.stake, CONFIG.X100_STAKE_GHS);
  db.close();
});

test('idempotent SQLite lock prevents duplicate auto-deployments', () => {
  const db = makeMemDb({ balance: 168.45, vaultStatus: 'WON', vaultStep: 2, vaultCode: 'C2P3EB', vaultPnl: 2.88, x100Count: 2 });
  const plan1 = evaluatePortfolioPlan(db, new Date('2026-11-26T23:00:00Z'));
  assert.equal(plan1.actions.length, 1);
  db.prepare(
    "INSERT INTO syndicate_auto_deployments VALUES (?, '2026-11-26', 'MODE_C_VAULT', 3, 2.88, 'NEW123', 'PLACED', 'ok', '2026-11-26T23:00:00Z')"
  ).run(plan1.actions[0].deployKey);
  const plan2 = evaluatePortfolioPlan(db, new Date('2026-11-26T23:15:00Z'));
  assert.equal(plan2.actions.length, 0);
  assert.ok(plan2.holds.some(h => h.startsWith('VAULT_LOCKED')));
  db.close();
});
