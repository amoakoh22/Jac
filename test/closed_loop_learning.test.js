const test = require('node:test');
const assert = require('node:assert/strict');
const heuristicsEngine = require('../syndicate/heuristics_engine');

test('heuristics_engine loads v3.0.0 rules and banned sets', () => {
  const h = heuristicsEngine.reload();
  assert.equal(h.version, '3.0.0');
  assert.ok(Array.isArray(h.rules.rule_28_friday_postmortem_market_ban.banned_markets));
  assert.ok(Array.isArray(h.rules.rule_28_friday_postmortem_market_ban.banned_market_league_pairs));
  assert.equal(h.rules.rule_29_zero_vig_bonus_sweet_spot.min_betradar_rtp, 0.98);
});

test('validateLegAgainstHeuristics rejects Rule #28 banned markets', () => {
  const bannedCases = [
    { name: '1H_GG_NG_NO', leg: { market_name: '1st Half - GG/NG', selection: 'No', league: 'Ligue 2', odds: 1.24, prob: 0.80 } },
    { name: 'HCP_0_1_FAV', leg: { market_name: 'Handicap 0:1', selection: 'Home (0:1)', league: 'Bundesliga', odds: 1.27, prob: 0.78 } },
    { name: '2H_OVER_0_5', leg: { market_name: '2nd Half - Over/Under', selection: 'Over 0.5', league: 'Premier League', odds: 1.23, prob: 0.80 } },
    { name: '1H_UNDER_2_5', leg: { market_name: '1st Half - Over/Under', selection: 'Under 2.5', league: 'Ligue 1', odds: 1.22, prob: 0.81 } },
    { name: 'PLAIN_1X2_FAV_ACCUM', leg: { market_name: '1X2', selection: 'Home', league: 'LaLiga', odds: 1.30, prob: 0.76 } }
  ];

  for (const tc of bannedCases) {
    const res = heuristicsEngine.validateLegAgainstHeuristics(tc.leg, 'bonus_arb_ev');
    assert.equal(res.allowed, false, `Expected ${tc.name} to be rejected`);
    assert.ok(res.reasons.length > 0, `Expected rejection reasons for ${tc.name}`);
  }
});

test('validateLegAgainstHeuristics rejects banned market-league pairs', () => {
  const pairCases = [
    {
      name: 'Eerste Divisie OVER_2_0',
      leg: { market_name: 'Over/Under', selection: 'Over 2.0', league: 'Netherlands Eerste Divisie', odds: 1.25, prob: 0.79 }
    },
    {
      name: 'Scottish Premiership UNDER_4_5',
      leg: { market_name: 'Over/Under', selection: 'Under 4.5', league: 'Scottish Premiership', odds: 1.22, prob: 0.81 }
    },
    {
      name: 'Championship OVER_1_5',
      leg: { market_name: 'Over/Under', selection: 'Over 1.5', league: 'England Championship', odds: 1.24, prob: 0.80 }
    }
  ];

  for (const tc of pairCases) {
    const res = heuristicsEngine.validateLegAgainstHeuristics(tc.leg, 'bonus_arb_ev');
    assert.equal(res.allowed, false, `Expected ${tc.name} to be rejected`);
    assert.ok(
      res.reasons.some(r => r.includes('Rule #28')),
      `Expected Rule #28 reason for ${tc.name}, got: ${res.reasons.join('; ')}`
    );
  }
});

test('validateLegAgainstHeuristics enforces Rule #29 RTP >= 0.980 and odds band for bonus_arb_ev', () => {
  const lowRtpLeg = {
    market_name: 'Double Chance',
    selection: 'Home or Draw (1X)',
    league: 'Serie A',
    odds: 1.25,
    prob: 0.77, // RTP = 0.9625 < 0.980
    rtp: 0.9625
  };
  const r1 = heuristicsEngine.validateLegAgainstHeuristics(lowRtpLeg, 'bonus_arb_ev');
  assert.equal(r1.allowed, false);
  assert.ok(r1.reasons.some(r => r.includes('RTP')));

  const lowOddsLeg = {
    market_name: 'Double Chance',
    selection: 'Home or Draw (1X)',
    league: 'Serie A',
    odds: 1.15,
    prob: 0.86,
    rtp: 0.989
  };
  const r2 = heuristicsEngine.validateLegAgainstHeuristics(lowOddsLeg, 'bonus_arb_ev');
  assert.equal(r2.allowed, false);
  assert.ok(r2.reasons.some(r => r.includes('below bonus_arb_ev floor')));
});

test('validateLegAgainstHeuristics passes clean bonus_arb_ev and fortress_98pct legs', () => {
  const cleanBonusLeg = {
    market_name: 'Double Chance',
    selection: 'Home or Draw (1X)',
    league: 'Serie A',
    odds: 1.26,
    prob: 0.785,
    rtp: 0.9891
  };
  const res1 = heuristicsEngine.validateLegAgainstHeuristics(cleanBonusLeg, 'bonus_arb_ev');
  assert.equal(res1.allowed, true, `Expected clean Double Chance leg to pass, got: ${res1.reasons.join('; ')}`);
  assert.equal(res1.reasons.length, 0);
  assert.equal(typeof res1.penalty, 'number');

  const cleanOver15NonChamp = {
    market_name: 'Over/Under',
    selection: 'Over 1.5',
    league: 'Bundesliga',
    odds: 1.24,
    prob: 0.80,
    rtp: 0.992
  };
  const res2 = heuristicsEngine.validateLegAgainstHeuristics(cleanOver15NonChamp, 'bonus_arb_ev');
  assert.equal(res2.allowed, true, `Expected Bundesliga Over 1.5 leg to pass, got: ${res2.reasons.join('; ')}`);

  const cleanFortressLeg = {
    market_name: 'Double Chance',
    selection: '1X',
    league: 'LaLiga',
    odds: 1.04,
    prob: 0.96,
    rtp: 0.9984
  };
  const res3 = heuristicsEngine.validateLegAgainstHeuristics(cleanFortressLeg, 'fortress_98pct');
  assert.equal(res3.allowed, true, `Expected fortress_98pct leg to pass, got: ${res3.reasons.join('; ')}`);
});

test('validateLegAgainstHeuristics blocks shorthand aliases and non-canonical marketKey strings', () => {
  const bypassCases = [
    { name: 'shorthand 1H NG', leg: { market_name: '1H NG', selection: 'No', league: 'Ligue 1', odds: 1.25, rtp: 0.985 } },
    { name: 'shorthand Hcp 0:1', leg: { market_name: 'Hcp 0:1', selection: 'Home', league: 'Bundesliga', odds: 1.25, rtp: 0.985 } },
    { name: 'shorthand 2H O0.5', leg: { market_name: '2H O0.5', selection: 'Over', league: 'Premier League', odds: 1.25, rtp: 0.985 } },
    { name: 'non-canonical marketKey', leg: { marketKey: '1H GG/NG: No', league: 'Serie A', odds: 1.25, rtp: 0.985 } }
  ];

  for (const tc of bypassCases) {
    const res = heuristicsEngine.validateLegAgainstHeuristics(tc.leg, 'bonus_arb_ev');
    assert.equal(res.allowed, false, `Expected ${tc.name} to be rejected, got marketKey=${res.marketKey}`);
  }

  assert.equal(heuristicsEngine.canonicalizeMarketKey({ market_name: 'Over/Under', selection: 'Over 3.5' }), 'OVER_3_5');
  assert.equal(heuristicsEngine.canonicalizeMarketKey({ market_name: 'Over/Under', selection: 'Over 2' }), 'OVER_2_0');
  assert.equal(heuristicsEngine.canonicalizeMarketKey({ market_name: 'Over/Under', selection: 'Under 2.5' }), 'UNDER_2_5');
});
