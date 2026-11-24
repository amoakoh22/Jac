'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getDefaultBonusPlan } = require('../syndicate/quant/bonus_model');
const { buildFortress98Ticket } = require('../syndicate/quant/mode_b_fortress_builder');

function makeFortressLeg(idx, {
  odds = 1.01,
  prob = 0.995,
  marketId = '49',
  specifier = '',
  outcomeId = '76',
  marketDesc = 'Away Team to Win Both Halves',
  outcomeDesc = 'No'
} = {}) {
  return {
    eventId: `sr:match:f_${idx}`,
    sportId: 'sr:sport:1',
    home: `FortHome_${idx}`,
    away: `FortAway_${idx}`,
    league: 'Eredivisie',
    marketId,
    specifier,
    marketDesc,
    outcomeId,
    outcomeDesc,
    odds,
    prob,
    rtp: +(odds * prob).toFixed(6),
    isActive: true
  };
}

describe('mode_b_fortress_builder — Mode B 98%+ Combined-Prob Tail-Risk Fortress', () => {
  const plan = getDefaultBonusPlan();

  it('enforces TRUE combinedWinProb >= 0.980 and never builds C36TTY-style 50F 51.99% slips', () => {
    // 50 legs each at 0.987 prob (like C36TTY where 0.987^50 = 51.99%!)
    // Since 0.987 * 0.987 = 0.974169 < 0.980, Mode B MUST stop at 1 leg (98.7% >= 98.0%)!
    const c36Pool = Array.from({ length: 50 }, (_, i) => makeFortressLeg(i, { odds: 1.01, prob: 0.987 }));
    const res = buildFortress98Ticket(c36Pool, plan, null, { bankroll: 187.67 });
    assert.equal(res.ok, true);
    assert.equal(res.ticket.legs.length, 1);
    assert.ok(res.ticket.mathProof.combinedWinProb >= 0.980);
    assert.ok(res.ticket.recommendedStakeGhs >= 2.0 && res.ticket.recommendedStakeGhs <= 5.0);
  });

  it('rejects pools where no leg can reach 98.0% combined win probability', () => {
    const weakPool = Array.from({ length: 20 }, (_, i) => makeFortressLeg(i, { odds: 1.03, prob: 0.965 }));
    const res = buildFortress98Ticket(weakPool, plan, null, { bankroll: 187.67 });
    assert.equal(res.ok, false);
    assert.equal(res.ticket, null);
  });

  it('strictly excludes Under 4.5 and banned fragile markets even if high probability', () => {
    const fragilePool = [
      makeFortressLeg(1, { marketId: '18', specifier: 'total=4.5', outcomeId: '13', marketDesc: 'Over/Under', outcomeDesc: 'Under 4.5', prob: 0.994 }),
      makeFortressLeg(2, { marketId: '68', specifier: 'total=2.5', outcomeId: '13', marketDesc: '1st Half - Over/Under', outcomeDesc: 'Under 2.5', prob: 0.995 }),
      makeFortressLeg(3, { marketId: '75', outcomeId: '76', marketDesc: '1st Half - GG/NG', outcomeDesc: 'No', prob: 0.996 }),
      makeFortressLeg(4, { marketId: '90', specifier: 'total=0.5', outcomeId: '12', marketDesc: '2nd Half - Over/Under', outcomeDesc: 'Over 0.5', prob: 0.995 }),
      makeFortressLeg(5, { marketId: '14', specifier: 'hcp=0:1', outcomeId: '1', marketDesc: 'Handicap', outcomeDesc: 'Home', prob: 0.995 })
    ];
    const res = buildFortress98Ticket(fragilePool, plan, null, { bankroll: 187.67 });
    assert.equal(res.ok, false);
    assert.equal(res.ticket, null);
    assert.equal(res.diagnostics.bannedMarketRejected, 5);
  });

  it('detects and stacks individually +EV 1.01 @ 0.995 legs while keeping combinedWinProb >= 0.980', () => {
    // 0.995^4 = 0.980149 >= 0.980; 0.995^5 = 0.975248 < 0.980 => must pick 4 legs!
    // Each leg: 1.01 * 0.995 = 1.00495 (+0.495% EV) => 4 legs = +1.995% EV!
    const posEvPool = Array.from({ length: 8 }, (_, i) => makeFortressLeg(i, { odds: 1.01, prob: 0.995 }));
    const res = buildFortress98Ticket(posEvPool, plan, null, { bankroll: 187.67 });
    assert.equal(res.ok, true);
    assert.equal(res.ticket.legs.length, 4);
    assert.ok(res.ticket.mathProof.combinedWinProb >= 0.980);
    assert.equal(res.ticket.mathProof.isPositiveEv, true);
    assert.ok(res.ticket.mathProof.trueExpectedRtp > 1.015);
    assert.ok(res.ticket.recommendedStakeGhs >= 2.0 && res.ticket.recommendedStakeGhs <= 5.0);
    assert.ok(res.ticket.recommendedStakeGhs <= +(187.67 * 0.027).toFixed(2) + 0.01);
  });
});
