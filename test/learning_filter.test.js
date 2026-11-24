'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  canonicalizeMarket,
  loadLearningContext,
  filterAndScoreCandidate
} = require('../syndicate/quant/learning_filter');

describe('learning_filter — heuristics, active fixture firewall & empirical loss model', () => {
  let tmpDir;
  let dbPath;
  let heuristicsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(__dirname, '.tmp-lf-'));
    dbPath = path.join(tmpDir, 'test_ledger.sqlite');
    heuristicsPath = path.join(tmpDir, 'test_heuristics.json');

    const heuristics = {
      version: '3.0.0',
      rules: {
        rule_28_friday_postmortem_market_ban: {
          banned_markets: [
            '1H_GG_NG_NO',
            'HCP_0_1_FAV',
            '2H_OVER_0_5',
            '1H_UNDER_2_5',
            'PLAIN_1X2_FAV_ACCUM',
            'EERSTE_DIVISIE_OVER_2'
          ],
          banned_market_league_pairs: [
            { market: 'OVER_2_0', league_pattern: 'Eerste Divisie', reason: '93VVCD Den Bosch 1-0' },
            { market: 'UNDER_4_5', league_pattern: 'Premiership', reason: 'BKJ0JX Kilmarnock 2-4 Aberdeen' },
            { market: 'OVER_1_5', league_pattern: 'Championship', reason: '808QK6 Millwall 0-1 QPR' }
          ]
        },
        rule_29_zero_vig_bonus_sweet_spot: {
          min_leg_odds: 1.20,
          max_leg_odds: 1.45,
          min_betradar_rtp: 0.980,
          min_ticket_ev: 1.02
        }
      },
      dynamic_weights: {
        market_risk_weights: {
          OVER_1_5: { won: 7, lost: 1, empirical_hit_rate: 0.875, penalty: 0.004, banned: false }
        }
      }
    };
    fs.writeFileSync(heuristicsPath, JSON.stringify(heuristics, null, 2));

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE syndicate_codehub_bullets (
        bullet_id TEXT PRIMARY KEY,
        booking_code TEXT,
        status TEXT
      );
      CREATE TABLE syndicate_creator_anchor_ledger (
        ledger_id TEXT PRIMARY KEY,
        booking_code TEXT,
        match_name TEXT,
        selection TEXT,
        status TEXT
      );
      CREATE TABLE syndicate_tickets (
        ticket_id TEXT PRIMARY KEY,
        booking_code TEXT,
        status TEXT
      );
      CREATE TABLE syndicate_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        match_name TEXT,
        market_name TEXT,
        selection TEXT,
        outcome TEXT
      );
    `);

    // Active tickets C36TTY & 9121S3
    db.prepare("INSERT INTO syndicate_codehub_bullets VALUES ('B1', 'C36TTY', 'IN_PROGRESS')").run();
    db.prepare("INSERT INTO syndicate_codehub_bullets VALUES ('B2', '9121S3', 'IN_PROGRESS')").run();
    db.prepare("INSERT INTO syndicate_codehub_bullets VALUES ('B3', 'BKJ0JX', 'LOST')").run();

    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L1', 'C36TTY', 'Ajax vs ADO Den Haag', 'Away Team to Win Both Halves: No @1.01', 'IN_PROGRESS')").run();
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L2', '9121S3', 'Man City vs Fulham', 'Double Chance 1X @1.22', 'IN_PROGRESS')").run();

    // Historical losses: 4 losses, 1 win on AWAY_UNDER_1_5 (hit rate 20% < 60%, lost >= 3 => empirical ban)
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L3', 'BKJ0JX', 'Team A vs Team B', 'Away Under 1.5 @1.25', 'LOST')").run();
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L4', 'BKJ0JX', 'Team C vs Team D', 'Away Under 1.5 @1.25', 'LOST')").run();
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L5', 'BKJ0JX', 'Team E vs Team F', 'Away Under 1.5 @1.25', 'LOST')").run();
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L6', 'BKJ0JX', 'Team G vs Team H', 'Away Under 1.5 @1.25', 'LOST')").run();
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L7', 'BKJ0JX', 'Team I vs Team J', 'Away Under 1.5 @1.25', 'WON')").run();

    // Moderate loss rate on HOME_UNDER_2_5 (1 loss, 4 wins => soft penalty, not banned)
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L8', 'BKJ0JX', 'Team K vs Team L', 'Home Under 2.5 @1.22', 'LOST')").run();
    for (let i = 0; i < 4; i++) {
      db.prepare(`INSERT INTO syndicate_creator_anchor_ledger VALUES ('L9_${i}', 'BKJ0JX', 'T${i} vs U${i}', 'Home Under 2.5 @1.22', 'WON')`).run();
    }

    // Active ticket in syndicate_tickets
    db.prepare("INSERT INTO syndicate_tickets VALUES ('T_ACTIVE', 'ACT123', 'PENDING')").run();
    db.prepare("INSERT INTO syndicate_legs (ticket_id, match_name, market_name, selection, outcome) VALUES ('T_ACTIVE', 'Arsenal vs Chelsea', 'Double Chance', '1X', 'PENDING')").run();

    db.close();
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('canonicalizes SportyBet market IDs and descriptions accurately', () => {
    assert.equal(canonicalizeMarket({ marketId: '75', outcomeId: '76', outcomeDesc: 'No' }), '1H_GG_NG_NO');
    assert.equal(canonicalizeMarket({ marketId: '14', specifier: 'hcp=0:1', outcomeId: '1' }), 'HCP_0_1_FAV');
    assert.equal(canonicalizeMarket({ marketId: '90', specifier: 'total=0.5', outcomeId: '12' }), '2H_OVER_0_5');
    assert.equal(canonicalizeMarket({ marketId: '68', specifier: 'total=2.5', outcomeId: '13' }), '1H_UNDER_2_5');
    assert.equal(canonicalizeMarket({ marketId: '1', outcomeId: '1' }), 'PLAIN_1X2_FAV_ACCUM');
    assert.equal(canonicalizeMarket({ marketId: '18', specifier: 'total=4.5', outcomeId: '13' }), 'UNDER_4_5');
    assert.equal(canonicalizeMarket({ marketId: '10', outcomeId: '9' }), 'DOUBLE_CHANCE_1X');
  });

  it('blocks Rule #28 banned markets and market-league pairs', () => {
    const ctx = loadLearningContext({ heuristicsPath, dbPath });

    const r1 = filterAndScoreCandidate({
      eventId: 'sr:match:1', home: 'Inter', away: 'Roma', league: 'Serie A',
      marketId: '75', outcomeId: '76', outcomeDesc: 'No', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(r1.allowed, false);
    assert.ok(r1.reasons.some(r => r.includes('BANNED_MARKET:1H_GG_NG_NO')));

    const r2 = filterAndScoreCandidate({
      eventId: 'sr:match:2', home: 'Millwall', away: 'QPR', league: 'Championship',
      marketId: '18', specifier: 'total=1.5', outcomeId: '12', odds: 1.28, prob: 0.77
    }, ctx, 'x100_plus_ev');
    assert.equal(r2.allowed, false);
    assert.ok(r2.reasons.some(r => r.includes('BANNED_MARKET_LEAGUE:OVER_1_5@championship')));

    const r3 = filterAndScoreCandidate({
      eventId: 'sr:match:3', home: 'Kilmarnock', away: 'Aberdeen', league: 'Scottish Premiership',
      marketId: '18', specifier: 'total=4.5', outcomeId: '13', odds: 1.22, prob: 0.81
    }, ctx, 'x100_plus_ev');
    assert.equal(r3.allowed, false);
    assert.ok(r3.reasons.some(r => r.includes('BANNED_MARKET_LEAGUE:UNDER_4_5@premiership')));
  });

  it('blocks candidates overlapping active tickets (C36TTY, 9121S3, and syndicate_tickets)', () => {
    const ctx = loadLearningContext({ heuristicsPath, dbPath });

    const overlap1 = filterAndScoreCandidate({
      eventId: 'sr:match:100', home: 'Manchester City', away: 'Fulham', league: 'Premier League',
      marketId: '10', outcomeId: '9', odds: 1.24, prob: 0.80
    }, ctx, 'x100_plus_ev');
    assert.equal(overlap1.allowed, false);
    assert.ok(overlap1.reasons.includes('ACTIVE_FIXTURE_OVERLAP'));

    const overlap2 = filterAndScoreCandidate({
      eventId: 'sr:match:101', home: 'Ajax', away: 'ADO Den Haag', league: 'Eredivisie',
      marketId: '49', outcomeId: '76', odds: 1.01, prob: 0.992
    }, ctx, 'fortress_98pct');
    assert.equal(overlap2.allowed, false);
    assert.ok(overlap2.reasons.includes('ACTIVE_FIXTURE_OVERLAP'));

    const overlap3 = filterAndScoreCandidate({
      eventId: 'sr:match:102', home: 'Arsenal', away: 'Chelsea', league: 'Premier League',
      marketId: '10', outcomeId: '9', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(overlap3.allowed, false);
    assert.ok(overlap3.reasons.includes('ACTIVE_FIXTURE_OVERLAP'));
  });

  it('enforces empirical SQLite loss-rate hard ban and soft penalty', () => {
    const ctx = loadLearningContext({ heuristicsPath, dbPath });

    // AWAY_UNDER_1_5 has 1W-4L => empirical hard ban
    const bannedRes = filterAndScoreCandidate({
      eventId: 'sr:match:200', home: 'Napoli', away: 'Lazio', league: 'Serie A',
      marketId: '20', specifier: 'total=1.5', outcomeId: '13', odds: 1.24, prob: 0.80
    }, ctx, 'x100_plus_ev');
    assert.equal(bannedRes.allowed, false);
    assert.ok(bannedRes.reasons.some(r => r.startsWith('EMPIRICAL_LOSS_BAN:AWAY_UNDER_1_5')));

    // HOME_UNDER_2_5 has 4W-1L => allowed with soft penalty > 0
    const penalizedRes = filterAndScoreCandidate({
      eventId: 'sr:match:201', home: 'Napoli', away: 'Lazio', league: 'Serie A',
      marketId: '19', specifier: 'total=2.5', outcomeId: '13', odds: 1.24, prob: 0.80
    }, ctx, 'x100_plus_ev');
    assert.equal(penalizedRes.allowed, true);
    assert.ok(penalizedRes.penalty > 0);
    assert.ok(penalizedRes.adjustedScore < 1.24 * 0.80);
  });

  it('prefers populated syndicate_market_performance table when present (v3.0.0 schema)', () => {
    const perfDbPath = path.join(tmpDir, 'perf_ledger.sqlite');
    const pdb = new DatabaseSync(perfDbPath);
    pdb.exec(`
      CREATE TABLE syndicate_market_performance (
        market_key TEXT,
        league TEXT,
        total_legs INTEGER,
        won_legs INTEGER,
        lost_legs INTEGER,
        empirical_hit_rate REAL,
        expected_hit_rate REAL,
        calibration_gap REAL,
        penalty_weight REAL,
        banned INTEGER,
        last_updated TEXT
      );
    `);
    pdb.prepare(`
      INSERT INTO syndicate_market_performance
      VALUES ('DOUBLE_CHANCE_X2', 'ALL', 5, 2, 3, 0.40, 0.78, -0.38, 0.08, 1, '2026-11-21T00:00:00Z')
    `).run();
    pdb.close();

    const ctx = loadLearningContext({ heuristicsPath, dbPath: perfDbPath });
    const res = filterAndScoreCandidate({
      eventId: 'sr:match:300', home: 'Atalanta', away: 'Bologna', league: 'Serie A',
      marketId: '10', outcomeId: '11', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(res.allowed, false);
    assert.ok(res.reasons.some(r => r.startsWith('EMPIRICAL_LOSS_BAN:DOUBLE_CHANCE_X2')));
  });

  it('separates ALL vs per-league rows in syndicate_market_performance without double-counting or leaking bans', () => {
    const splitDbPath = path.join(tmpDir, 'split_perf_ledger.sqlite');
    const sdb = new DatabaseSync(splitDbPath);
    sdb.exec(`
      CREATE TABLE syndicate_market_performance (
        market_key TEXT,
        league TEXT,
        total_legs INTEGER,
        won_legs INTEGER,
        lost_legs INTEGER,
        empirical_hit_rate REAL,
        expected_hit_rate REAL,
        calibration_gap REAL,
        penalty_weight REAL,
        banned INTEGER,
        last_updated TEXT
      );
    `);
    sdb.prepare(`
      INSERT INTO syndicate_market_performance VALUES
        ('OVER_1_5', 'ALL', 9, 8, 1, 0.8889, 0.80, 0.0889, 0.0341, 0, '2026-11-21T00:00:00Z'),
        ('OVER_1_5', 'Championship', 1, 0, 1, 0.0, 0.80, -0.80, 1.037, 1, '2026-11-21T00:00:00Z'),
        ('OVER_1_5', 'Premier League', 3, 3, 0, 1.0, 0.80, 0.20, 0.0, 0, '2026-11-21T00:00:00Z'),
        ('DOUBLE_CHANCE', 'ALL', 5, 1, 4, 0.20, 0.80, -0.60, 0.50, 1, '2026-11-21T00:00:00Z')
    `).run();
    sdb.close();

    const ctx = loadLearningContext({ heuristicsPath, dbPath: splitDbPath });
    const o15 = ctx.marketLossStats.get('OVER_1_5');
    assert.equal(o15.won, 8);
    assert.equal(o15.lost, 1);
    assert.equal(o15.total, 9);
    assert.equal(o15.banned, false);
    assert.equal(o15.penaltyWeight, 0.0341);

    // Premier League & LaLiga Over 1.5 must be ALLOWED with Math.max(riskPenalty=0.004, empPenalty=0.0341) === 0.0341
    const epl = filterAndScoreCandidate({
      eventId: 'sr:match:401', home: 'Arsenal', away: 'Brighton', league: 'Premier League',
      marketId: '18', specifier: 'total=1.5', outcomeId: '12', outcomeDesc: 'Over 1.5', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(epl.allowed, true);
    assert.equal(epl.penalty, 0.0341);

    const laliga = filterAndScoreCandidate({
      eventId: 'sr:match:402', home: 'Real Madrid', away: 'Getafe', league: 'LaLiga',
      marketId: '18', specifier: 'total=1.5', outcomeId: '12', outcomeDesc: 'Over 1.5', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(laliga.allowed, true);
    assert.equal(laliga.penalty, 0.0341);

    // Championship Over 1.5 must be BLOCKED
    const champ = filterAndScoreCandidate({
      eventId: 'sr:match:403', home: 'Leeds', away: 'Bristol', league: 'Championship',
      marketId: '18', specifier: 'total=1.5', outcomeId: '12', outcomeDesc: 'Over 1.5', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(champ.allowed, false);
    assert.ok(champ.reasons.some(r => r.includes('OVER_1_5@championship')));

    // DOUBLE_CHANCE_1X falls back to DOUBLE_CHANCE global ban
    const dc = filterAndScoreCandidate({
      eventId: 'sr:match:404', home: 'Roma', away: 'Torino', league: 'Serie A',
      marketId: '10', outcomeId: '9', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(dc.allowed, false);
    assert.ok(dc.reasons.some(r => r.startsWith('EMPIRICAL_LOSS_BAN:DOUBLE_CHANCE_1X')));
  });

  it('normalizes integer goal lines (total=2 / Over 2 -> OVER_2_0) so Eerste Divisie trap cannot be bypassed', () => {
    assert.equal(canonicalizeMarket({ marketId: '18', specifier: 'total=2', outcomeId: '12' }), 'OVER_2_0');
    assert.equal(canonicalizeMarket('Over/Under Over 2'), 'OVER_2_0');

    const ctx = loadLearningContext({ heuristicsPath, dbPath });
    const res = filterAndScoreCandidate({
      eventId: 'sr:match:500', home: 'Den Bosch', away: 'Jong Ajax', league: 'Eerste Divisie',
      marketId: '18', specifier: 'total=2', outcomeId: '12', odds: 1.25, prob: 0.79
    }, ctx, 'x100_plus_ev');
    assert.equal(res.canonicalMarket, 'OVER_2_0');
    assert.equal(res.allowed, false);
    assert.ok(res.reasons.some(r => r.includes('BANNED_MARKET_LEAGUE:OVER_2_0@eerste divisie')));
  });
});
