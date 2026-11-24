'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getDefaultBonusPlan,
  parseBonusPlan,
  getSportFactor,
  computeBonusPct,
  evaluateTicketMath,
  breakEvenRtp,
  quarterKellyStake
} = require('../syndicate/quant/bonus_model');

function makeLegs(count, odds = 1.25, sportId = 'sr:sport:1', prob = 0.788) {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `sr:match:${1000 + i}`,
    sportId,
    odds,
    prob,
    rtp: +(odds * prob).toFixed(6)
  }));
}

describe('bonus_model — SportyBet Ghana exact Multi-Bet Bonus ladder', () => {
  const plan = getDefaultBonusPlan();

  it('matches all 6 historical pure-football receipts within 0.05%', () => {
    const historicalReceipts = [
      { code: 'BD8Y44', folds: 7, basePay: 85.35, actualBonusRatio: (93.88 - 85.35) / 85.35 },
      { code: 'D8WJHX', folds: 20, basePay: 7798.52, actualBonusRatio: (10528.00 - 7798.52) / 7798.52 },
      { code: '808QK6', folds: 22, basePay: 272.64, actualBonusRatio: 109.06 / 272.64 },
      { code: 'BKJ0JX', folds: 23, basePay: 282.39, actualBonusRatio: 120.01 / 282.39 },
      { code: '9121S3', folds: 25, basePay: 457.26, actualBonusRatio: 217.19 / 457.26 },
      { code: 'CMYT2L', folds: 35, basePay: 2132.30, actualBonusRatio: 2345.54 / 2132.30 }
    ];

    for (const r of historicalReceipts) {
      const legs = makeLegs(r.folds, 1.25, 'sr:sport:1');
      const res = computeBonusPct(legs, plan);
      const diff = Math.abs(res.bonusPct - r.actualBonusRatio);
      assert.ok(
        diff <= 0.0005,
        `${r.code} (${r.folds}F): expected ${res.bonusPct.toFixed(5)} within 0.05% of actual ${r.actualBonusRatio.toFixed(5)} (diff=${diff.toFixed(6)})`
      );
      assert.equal(res.qualifyingCount, r.folds);
      assert.equal(res.effectiveFactor, 0.5);
    }
  });

  it('excludes legs below qualifyingOddsLimit (1.20) from bonus count', () => {
    const legs = [
      ...makeLegs(20, 1.22, 'sr:sport:1'),
      ...makeLegs(5, 1.19, 'sr:sport:1')
    ];
    const res = computeBonusPct(legs, plan);
    assert.equal(res.qualifyingCount, 20);
    assert.equal(res.bonusPct, 0.35);
  });

  it('applies 1.00x bonus factor for Basketball, Tennis, Ice Hockey, and Table Tennis', () => {
    for (const sportId of ['sr:sport:2', 'sr:sport:5', 'sr:sport:4', 'sr:sport:20']) {
      assert.equal(getSportFactor(sportId, '', plan), 1.0);
      const res20 = computeBonusPct(makeLegs(20, 1.25, sportId), plan);
      assert.equal(res20.effectiveFactor, 1.0);
      assert.equal(res20.bonusPct, 0.70);
    }
    assert.equal(getSportFactor('sr:sport:6', '', plan), 0.75); // Handball
    assert.equal(getSportFactor('sr:sport:1', '', plan), 0.50); // Football
  });

  it('uses conservative min(factor_i) for mixed-sport slips so EV is never overestimated', () => {
    const mixed = [
      ...makeLegs(15, 1.25, 'sr:sport:2'), // Basketball 1.00x
      ...makeLegs(5, 1.25, 'sr:sport:1')   // Football 0.50x
    ];
    const res = computeBonusPct(mixed, plan);
    assert.equal(res.qualifyingCount, 20);
    assert.equal(res.effectiveFactor, 0.50);
    assert.equal(res.bonusPct, 0.35);
  });

  it('computes exact breakEvenRtp for key fold counts and sport factors', () => {
    // Pure Football N=25 (bonus 47.5%): 1.475^(-1/25) = 0.984569
    assert.ok(Math.abs(breakEvenRtp(25, 0.475) - 0.984569) < 0.0001);
    // Pure Football N=30 (bonus 80.0%): 1.800^(-1/30) = 0.980597
    assert.ok(Math.abs(breakEvenRtp(30, 0.80) - 0.980597) < 0.0001);
    // Pure Football N=35 (bonus 110.0%): 2.100^(-1/35) = 0.979025
    assert.ok(Math.abs(breakEvenRtp(35, 1.10) - 0.979025) < 0.0001);
    // 1.00x Sport N=20 (bonus 70.0%): 1.700^(-1/20) = 0.973818
    assert.ok(Math.abs(breakEvenRtp(20, 0.70) - 0.973818) < 0.0001);
  });

  it('evaluates full ticket math and quarter-Kelly stake bounds accurately', () => {
    // 30F Football at 1.22 odds, 0.807 prob => rtp=0.98454; 0.98454^30 * 1.80 = 1.1277 (+12.77% EV)
    const legs = makeLegs(30, 1.22, 'sr:sport:1', 0.807);
    const m = evaluateTicketMath(legs, plan, 2.0);
    assert.equal(m.folds, 30);
    assert.equal(m.qualifyingCount, 30);
    assert.equal(m.bonusPct, 0.80);
    assert.ok(m.effectiveMultiplier > 100);
    assert.equal(m.isPositiveEv, true);
    assert.ok(m.trueExpectedRtp > 1.10);
    assert.ok(m.expectedValueGhs > 0.20);

    const stake = quarterKellyStake(m.trueExpectedRtp, m.effectiveMultiplier, 187.67, {
      minStake: 2.0,
      maxStake: 3.0
    });
    assert.ok(stake >= 2.0 && stake <= 3.0);

    // Negative EV must yield 0 stake
    assert.equal(quarterKellyStake(0.95, 134.13, 187.67), 0);
  });

  it('parses custom live API bonus plan payload cleanly', () => {
    const customApi = {
      data: {
        entityList: [{
          qualifyingOddsLimit: 12500,
          factor: 10000,
          bonusRatios: [{ qualifyingSelections: 3, min: 100, max: 1000 }]
        }],
        bonusFactorVOList: [
          { sportId: 'sr:sport:1', bonusFactor: 6000, isEnabled: true, isDel: false }
        ]
      }
    };
    const parsed = parseBonusPlan(customApi);
    assert.equal(parsed.qualifyingOdds, 1.25);
    const res = computeBonusPct(makeLegs(3, 1.26, 'sr:sport:1'), parsed);
    assert.equal(res.bonusPct, 0.06);
  });

  it('ignores stale contradictory leg.rtp when both odds and prob are finite positive numbers', () => {
    const legs = [{ eventId: 'sr:match:stale1', sportId: 'sr:sport:1', odds: 1.25, prob: 0.78, rtp: 0.995 }];
    const m = evaluateTicketMath(legs, plan, 2.0);
    assert.ok(Math.abs(m.trueExpectedRtp - 0.975) < 1e-6);
    assert.ok(Math.abs(m.trueExpectedRtp - (m.combinedWinProb * m.effectiveMultiplier)) < 1e-6);
    assert.equal(m.isPositiveEv, false);
  });
});
