'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getDefaultBonusPlan } = require('../syndicate/quant/bonus_model');
const {
  buildX100PlusEvTicket,
  buildDisjointX100Tickets
} = require('../syndicate/quant/mode_a_x100_builder');

function makePool(count, {
  sportId = 'sr:sport:1',
  odds = 1.22,
  rtp = 0.985,
  marketId = '10',
  outcomeId = '9',
  prefix = 'ev'
} = {}) {
  const prob = +(rtp / odds).toFixed(6);
  return Array.from({ length: count }, (_, i) => ({
    eventId: `sr:match:${prefix}_${i}`,
    sportId,
    sportName: sportId === 'sr:sport:1' ? 'Football' : 'Basketball',
    home: `Home_${prefix}_${i}`,
    away: `Away_${prefix}_${i}`,
    league: 'Premier League',
    marketId,
    specifier: '',
    marketDesc: 'Double Chance',
    outcomeId,
    outcomeDesc: '1X',
    odds,
    prob,
    rtp,
    isActive: true
  }));
}

describe('mode_a_x100_builder — Mode A x100+ +EV Zero-Vig Bonus Arb', () => {
  const plan = getDefaultBonusPlan();

  it('strictly rejects negative-EV pools (V8/V9/V10 style 25F Football with 0.975 RTP)', () => {
    // 25F Football has 47.5% bonus => break-even RTP is 0.9846; 0.975^25 * 1.475 = 0.783 (-21.7% EV)
    const negPool = makePool(25, { sportId: 'sr:sport:1', odds: 1.24, rtp: 0.975 });
    const res = buildX100PlusEvTicket(negPool, plan, null, { minLegRtp: 0.950 });
    assert.equal(res.ok, false);
    assert.equal(res.ticket, null);
  });

  it('accepts and builds a +EV >=100x pure-football 30-35F ticket with strict 1-leg-per-event', () => {
    // Include duplicate events with worse RTP to verify deduplication
    const primary = makePool(34, { sportId: 'sr:sport:1', odds: 1.22, rtp: 0.986, prefix: 'fb' });
    const dupes = primary.slice(0, 10).map(l => ({
      ...l,
      marketId: '60100',
      outcomeId: '1',
      rtp: 0.981,
      prob: +(0.981 / 1.22).toFixed(6)
    }));

    const res = buildX100PlusEvTicket([...primary, ...dupes], plan, null, { bankroll: 187.67 });
    assert.equal(res.ok, true);
    assert.ok(res.ticket);
    const mp = res.ticket.mathProof;
    assert.ok(mp.folds >= 30 && mp.folds <= 35);
    assert.ok(mp.effectiveMultiplier >= 100.0);
    assert.ok(mp.trueExpectedRtp >= 1.02);
    assert.equal(mp.isPositiveEv, true);

    // 1 leg per event & all odds >= 1.20
    const evIds = new Set(res.ticket.legs.map(l => l.eventId));
    assert.equal(evIds.size, res.ticket.legs.length);
    for (const l of res.ticket.legs) {
      assert.ok(l.odds >= 1.20);
    }

    // Quarter-Kelly bounded to [2.00, 3.00]
    assert.ok(res.ticket.recommendedStakeGhs >= 2.0 && res.ticket.recommendedStakeGhs <= 3.0);
  });

  it('exploits 1.00x-bonus sports (Basketball/Tennis) at 20-25F for +EV >=100x', () => {
    // 20F Basketball has 70% bonus => break-even RTP = 0.9738; 0.983^20 * 1.70 = 1.206 (+20.6% EV)
    // 1.24^20 * 1.70 = 125.6x >= 100x!
    const bballPool = makePool(22, { sportId: 'sr:sport:2', odds: 1.24, rtp: 0.983, prefix: 'nba' });
    const res = buildX100PlusEvTicket(bballPool, plan, null, { bankroll: 187.67 });
    assert.equal(res.ok, true);
    assert.ok(res.ticket.mathProof.effectiveMultiplier >= 100.0);
    assert.ok(res.ticket.mathProof.trueExpectedRtp > 1.15);
    assert.equal(res.ticket.mathProof.isPositiveEv, true);
  });

  it('generates multiple disjoint x100+ +EV tickets with zero fixture overlap', () => {
    const bigPool = makePool(46, { sportId: 'sr:sport:2', odds: 1.24, rtp: 0.984, prefix: 'disj' });
    const res = buildDisjointX100Tickets(bigPool, plan, null, 2, {
      minFolds: 20,
      maxFolds: 22,
      bankroll: 187.67
    });
    assert.equal(res.ok, true);
    assert.equal(res.tickets.length, 2);

    const set1 = new Set(res.tickets[0].legs.map(l => l.eventId));
    const set2 = new Set(res.tickets[1].legs.map(l => l.eventId));
    for (const id of set2) {
      assert.equal(set1.has(id), false, `Found overlapping event ${id} between disjoint tickets`);
    }
  });

  it('rejects negative-EV pools even when candidates carry stale inflated leg.rtp = 0.995', () => {
    const stalePool = Array.from({ length: 35 }, (_, i) => ({
      eventId: `sr:match:stale_${i}`,
      sportId: 'sr:sport:1',
      sportName: 'Football',
      home: `Home_${i}`,
      away: `Away_${i}`,
      league: 'Premier League',
      marketId: '10',
      specifier: '',
      marketDesc: 'Double Chance',
      outcomeId: '9',
      outcomeDesc: '1X',
      odds: 1.25,
      prob: 0.78, // true odds * prob = 0.975 (< 0.979 break-even for 35F Football)
      rtp: 0.995, // stale/contradictory rtp must be ignored
      isActive: true
    }));

    const res = buildX100PlusEvTicket(stalePool, plan, null, { minLegRtp: 0.970 });
    assert.equal(res.ok, false);
    assert.equal(res.ticket, null);
  });
});
