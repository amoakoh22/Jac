'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getDefaultBonusPlan,
  evaluatePushAwareTicketMath,
  sportAwareMinLegRtp
} = require('../syndicate/quant/bonus_model');
const { buildWavePlan, selectWaveStaggeredSubset } = require('../syndicate/quant/wave_planner');

test('evaluatePushAwareTicketMath matches exact brute-force 2^N win/push enumeration', () => {
  const plan = getDefaultBonusPlan();
  const legs = [
    { odds: 1.25, pWin: 0.66, pPush: 0.16, sportId: 'sr:sport:1' },
    { odds: 1.22, pWin: 0.65, pPush: 0.19, sportId: 'sr:sport:1' },
    { odds: 1.30, pWin: 0.62, pPush: 0.17, sportId: 'sr:sport:1' },
    { odds: 1.24, pWin: 0.79, pPush: 0.00, sportId: 'sr:sport:1' },
    { odds: 1.28, pWin: 0.64, pPush: 0.16, sportId: 'sr:sport:1' },
    { odds: 1.21, pWin: 0.67, pPush: 0.17, sportId: 'sr:sport:1' }
  ];

  // Brute-force all 2^6 win/push states (any loss gives 0)
  let bruteExpected = 0;
  const n = legs.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    let prob = 1.0;
    let baseProd = 1.0;
    let qualWins = 0;
    for (let i = 0; i < n; i++) {
      const win = (mask >> i) & 1;
      if (win) {
        prob *= legs[i].pWin;
        baseProd *= legs[i].odds;
        if (legs[i].odds >= 1.20) qualWins++;
      } else {
        prob *= legs[i].pPush;
      }
    }
    const maxR = qualWins >= 2 ? (plan.ratiosByN.get(qualWins)?.max || 0) : 0;
    const bonusPct = maxR * 0.50; // Football 0.50x
    bruteExpected += prob * baseProd * (1 + bonusPct);
  }

  const dpRes = evaluatePushAwareTicketMath(legs, plan, 3.0);
  assert.ok(Math.abs(dpRes.trueExpectedRtp - bruteExpected) < 1e-5, `DP=${dpRes.trueExpectedRtp} vs brute=${bruteExpected}`);
  assert.ok(dpRes.combinedNonLossProb > dpRes.combinedWinProb);
});

test('sportAwareMinLegRtp unlocks 1.00x bonus sports while keeping Football strict', () => {
  assert.equal(sportAwareMinLegRtp('sr:sport:2', ''), 0.972); // Basketball 1.00x
  assert.equal(sportAwareMinLegRtp('sr:sport:5', ''), 0.972); // Tennis 1.00x
  assert.equal(sportAwareMinLegRtp('sr:sport:1', ''), 0.978); // Football 0.50x
});

test('wave_planner enforces >= 135m clean inter-wave cashout window and computes Harvester principal lock', () => {
  const base = Date.now();
  const pool = [];
  // 5 Wave-1 legs around T+2h
  for (let i = 0; i < 5; i++) {
    pool.push({ eventId: `w1_${i}`, odds: 1.24, prob: 0.80, nonLossProb: 0.84, adjustedScore: 0.98, startTime: base + (120 + i * 15) * 60000 });
  }
  // 16 Wave-2+ legs starting T+7h (gap > 240m)
  for (let i = 0; i < 16; i++) {
    pool.push({ eventId: `w2_${i}`, odds: 1.25, prob: 0.79, nonLossProb: 0.79, adjustedScore: 0.98, startTime: base + (420 + i * 20) * 60000 });
  }

  const sub = selectWaveStaggeredSubset(pool, 20, { minWave1Legs: 5, maxWave1Legs: 5, targetWave1Odds: 2.50, minWave1GapMinutes: 135 });
  assert.ok(sub && sub.length === 20);
  const wp = buildWavePlan(sub, 3.0, { minWave1GapMinutes: 135, pairTotalStake: 5.0 });
  assert.ok(wp.wave1CleanWindowMinutes >= 135);
  assert.ok(wp.wave1ExpectedCashoutGhs >= 5.10, `Expected Harvester W1 cashout >= 5.10, got ${wp.wave1ExpectedCashoutGhs}`);
});
