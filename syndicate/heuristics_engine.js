/**
 * Hermes Syndicate Heuristics & Quantitative Risk Engine
 * Implements Hardened Rules #22–#25, CodeHub Trap Filtering, and Arbitrage Hedge Mathematics.
 * Completely isolated in data/syndicate_heuristics.json
 */

const fs = require('fs');
const path = require('path');

const HEURISTICS_FILE = path.resolve(__dirname, '..', 'data', 'syndicate_heuristics.json');

const DEFAULT_SYNDICATE_HEURISTICS = {
  version: '3.0.0',
  name: 'Hermes Asymmetric Multi-Week Syndicate Heuristics Store',
  last_updated: new Date().toISOString(),
  rules: {
    // Rule #22: Double-Digit NBA Spread Cap Without Primary Alpha
    rule_22_nba_spread_cap_missing_alpha: {
      id: 22,
      name: 'Double-Digit NBA Spread Cap Without Primary Alpha',
      description: 'Never lay -10.0 or higher on an NBA favorite missing its #1 franchise scorer. Cap alternate spreads on shorthanded favorites at -5.5 to -7.5.',
      max_spread_without_alpha: -7.5,
      hard_forbidden_threshold: -10.0,
      active: true
    },
    // Rule #23: Zero Handicap Stretching
    rule_23_zero_handicap_stretching: {
      id: 23,
      name: 'Zero Handicap Stretching',
      description: 'Never stretch a handicap deeper (e.g. -5.5 to -10.5 or 0:1 to 0:2) to artificially manufacture higher odds. If odds fall below value threshold, drop match and substitute clean primary market.',
      allow_stretched_handicap: false,
      active: true
    },
    // Rule #24: Dead-Rubber & Group-Winner Rotation Filter
    rule_24_dead_rubber_rotation_filter: {
      id: 24,
      name: 'Dead-Rubber & Group-Winner Rotation Filter',
      description: 'On final group-stage matchdays or end-of-season fixtures, filter out teams that have already clinched 1st place in favor of teams with active qualification/promotion stakes.',
      disallow_clinched_teams: true,
      active: true
    },
    // Rule #25: Strict Zero-Correlation Firewall
    rule_25_zero_correlation_firewall: {
      id: 25,
      name: 'Strict Zero-Correlation Firewall',
      description: 'Zero fixture overlap across active slips. Every single ticket in a deployment cycle must contain 100% mutually exclusive matches.',
      allow_fixture_overlap: false,
      active: true
    },
    // Pricing and Liquidity Filter
    pricing_liquidity_filter: {
      id: 'P1',
      name: 'Market Liquidity & Pricing Filter',
      description: 'Reject dead-money legs below 1.15 on singles or 1.12 on accumulators unless justified by overwhelming statistical dominance.',
      min_accumulator_leg_odds: 1.12,
      min_single_leg_odds: 1.15,
      active: true
    },
    // CodeHub Trap Filter
    codehub_trap_filter: {
      id: 'CH1',
      name: 'CodeHub Asymmetric Scout Trap Filter',
      description: 'Strip 1.02–1.07 3-way handicaps (0:3/2:0), 1st-half under traps, and bloated 40-leg lotteries. Retain only verified Tier-1 anchors.',
      forbidden_handicap_min_odds: 1.02,
      forbidden_handicap_max_odds: 1.07,
      max_codehub_legs: 15,
      disallow_first_half_unders: true,
      max_bullets_budget: 5.00,
      bullet_stake: 1.00,
      active: true
    },
    // Cashout and Hedge Arbitrage Thresholds
    arbitrage_hedge_protocol: {
      id: 'ARB1',
      name: 'Chronological Arbitrage & Live Hedge Lock',
      description: 'Trigger Principal Protection or Equalized Arbitrage Lock when potential payout reaches >= 5x cycle exposure.',
      min_payout_multiplier_trigger: 5.0,
      cashout_equity_ratio_trigger: 0.92,
      active: true
    },
    // Rule #28: Post-Mortem Fragile Market & Market-League Ban
    rule_28_friday_postmortem_market_ban: {
      id: 28,
      name: 'Post-Mortem Fragile Market Ban (1H NG / -1 Hcp / 2H O0.5 / 1H U2.5)',
      description: 'Empirically banned markets and market-league traps from closed-loop post-mortem audit.',
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
      ],
      active: true
    },
    // Rule #29: Zero-Vig >= 1.20 Multi-Bet Bonus Sweet Spot
    rule_29_zero_vig_bonus_sweet_spot: {
      id: 29,
      name: 'Zero-Vig >=1.20 Multi-Bet Bonus Sweet Spot (20-35 Folds for 100x+ +EV)',
      description: 'Target 20-35 disjoint legs @ 1.20-1.45 with Betradar RTP >= 98.0% and true ticket EV >= 1.02 via SportyBet Multi-Bet Win Bonus.',
      min_leg_odds: 1.20,
      max_leg_odds: 1.45,
      min_betradar_rtp: 0.980,
      min_ticket_ev: 1.02,
      active: true
    }
  },
  dynamic_weights: {
    road_b2b_penalty: 0.15,
    home_court_boost: 1.08,
    post_international_break_away_penalty: 0.12,
    market_risk_weights: {}
  },
  calibration_log: []
};

class SyndicateHeuristicsEngine {
  constructor() {
    this.heuristics = this.load();
  }

  reload() {
    this.heuristics = this.load();
    return this.heuristics;
  }

  load() {
    if (fs.existsSync(HEURISTICS_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(HEURISTICS_FILE, 'utf8'));
      } catch (err) {
        console.error('[SyndicateHeuristics] Error reading heuristics file. Restoring defaults.', err.message);
      }
    }
    this.save(DEFAULT_SYNDICATE_HEURISTICS);
    return DEFAULT_SYNDICATE_HEURISTICS;
  }

  save(data = this.heuristics) {
    fs.writeFileSync(HEURISTICS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Rule #25 Validation: Strict Zero-Correlation Firewall
   * Validates that all tickets in a cycle have zero overlapping fixtures.
   */
  validateZeroCorrelation(tickets) {
    const seenMatches = new Map();
    const violations = [];

    tickets.forEach((ticket, tIdx) => {
      (ticket.legs || []).forEach((leg, lIdx) => {
        const matchKey = (leg.match_name || '').trim().toLowerCase();
        if (seenMatches.has(matchKey)) {
          const prior = seenMatches.get(matchKey);
          violations.push({
            match: leg.match_name,
            ticket1: prior.ticketNumber,
            ticket2: ticket.ticket_number || tIdx + 1,
            reason: `Heuristic #25 Violation: Match '${leg.match_name}' appears in both Ticket ${prior.ticketNumber} and Ticket ${ticket.ticket_number || tIdx + 1}. All cycle tickets must be 100% mutually exclusive.`
          });
        } else {
          seenMatches.set(matchKey, {
            ticketNumber: ticket.ticket_number || tIdx + 1,
            legIndex: lIdx
          });
        }
      });
    });

    return {
      valid: violations.length === 0,
      violations,
      totalUniqueMatches: seenMatches.size
    };
  }

  /**
   * Rule #22 Validation: Double-Digit NBA Spread Cap Without Primary Alpha
   */
  validateNBASpread(leg) {
    const r22 = this.heuristics.rules.rule_22_nba_spread_cap_missing_alpha;
    if (!r22.active || leg.sport !== 'Basketball' || !leg.league.includes('NBA')) {
      return { valid: true };
    }

    const spreadMatch = (leg.selection || '').match(/-([0-9.]+)/);
    if (spreadMatch) {
      const spreadValue = -parseFloat(spreadMatch[1]);
      const missingPrimaryAlpha = leg.missing_alpha === true || (leg.notes && leg.notes.toLowerCase().includes('missing'));
      
      if (missingPrimaryAlpha && spreadValue <= r22.hard_forbidden_threshold) {
        return {
          valid: false,
          rule: 22,
          reason: `Heuristic #22 Violation: Shorthanded favorite spread ${spreadValue} is <= -10.0. Cap at ${r22.max_spread_without_alpha} or pivot.`
        };
      }
    }
    return { valid: true };
  }

  /**
   * Rule #23 Validation: Zero Handicap Stretching
   */
  validateHandicapStretching(leg) {
    const r23 = this.heuristics.rules.rule_23_zero_handicap_stretching;
    if (!r23.active) return { valid: true };

    if (leg.is_stretched_handicap === true) {
      return {
        valid: false,
        rule: 23,
        reason: `Heuristic #23 Violation: Artificially stretched handicap on '${leg.match_name}'. Drop fixture and pick a clean primary line.`
      };
    }
    return { valid: true };
  }

  /**
   * Rule #24 Validation: Dead-Rubber & Group-Winner Rotation Filter
   */
  validateMotivation(leg) {
    const r24 = this.heuristics.rules.rule_24_dead_rubber_rotation_filter;
    if (!r24.active) return { valid: true };

    if (leg.is_dead_rubber === true || leg.clinched_top_seed === true) {
      return {
        valid: false,
        rule: 24,
        reason: `Heuristic #24 Violation: '${leg.match_name}' involves a team with clinched position and zero stakes. Replace with high-motivation match.`
      };
    }
    return { valid: true };
  }

  /**
   * Pricing & Minimum Odds Filter
   */
  validatePricing(leg, isSingle = false) {
    const p1 = this.heuristics.rules.pricing_liquidity_filter;
    const minOdds = isSingle ? p1.min_single_leg_odds : p1.min_accumulator_leg_odds;
    if (leg.odds < minOdds) {
      return {
        valid: false,
        reason: `Pricing Filter Violation: Odds ${leg.odds} below minimum ${minOdds}. Reject dead money.`
      };
    }
    return { valid: true };
  }

  /**
   * CodeHub Trap Stripper:
   * Cleans community slips from SportyBet CodeHub
   */
  cleanCodeHubSlip(rawSlip) {
    const legs = rawSlip.legs || [];
    const strippedTraps = [];
    const retainedAnchors = [];

    legs.forEach(leg => {
      // 1. Trap: 1.02 - 1.07 3-way handicaps (0:3, 2:0)
      if (leg.odds >= 1.02 && leg.odds <= 1.07 && (leg.market_name || '').toLowerCase().includes('handicap')) {
        strippedTraps.push({ leg, reason: 'High-risk 1.02-1.07 European Handicap Trap' });
        return;
      }

      // 2. Trap: 1st Half Unders
      if ((leg.market_name || '').toLowerCase().includes('1st half') && (leg.selection || '').toLowerCase().includes('under')) {
        strippedTraps.push({ leg, reason: '1st Half Under Volatility Trap' });
        return;
      }

      // 3. Trap: Dead-money sub-1.12 odds
      if (leg.odds < 1.12) {
        strippedTraps.push({ leg, reason: 'Sub-1.12 Dead Money Leg' });
        return;
      }

      // Otherwise retain as potential Tier-1 anchor
      retainedAnchors.push(leg);
    });

    return {
      originalCount: legs.length,
      strippedCount: strippedTraps.length,
      retainedCount: retainedAnchors.length,
      strippedTraps,
      retainedAnchors: retainedAnchors.slice(0, 12) // Cap at max 12 legs
    };
  }

  /**
   * Chronological Wave Staggering & Arbitrage / Cashout Formula
   * Hedge Stake = (Original Stake * Total Parlay Odds) / Live Opposing Odds
   */
  calculateArbitrageHedge({ originalStake, totalParlayOdds, liveOpposingOdds, cycleExposure = 20.00, liveCashoutOffer = 0 }) {
    const totalPotentialReturn = originalStake * totalParlayOdds;
    const hedgeStake = totalPotentialReturn / liveOpposingOdds;
    const netReturnIfOpposingWins = (hedgeStake * liveOpposingOdds) - (originalStake + hedgeStake);
    const netReturnIfParlayWins = totalPotentialReturn - (originalStake + hedgeStake);

    // Multiplier of cycle exposure
    const payoutVsExposure = totalPotentialReturn / cycleExposure;
    const cashoutVsExposure = liveCashoutOffer / cycleExposure;

    let recommendation = 'HOLD';
    let rationale = 'Ticket in progress. Thresholds not yet met.';

    if (payoutVsExposure >= 5.0 || cashoutVsExposure >= 5.0) {
      if (liveCashoutOffer >= (cycleExposure * 5.0)) {
        recommendation = 'EQUALIZED_CASHOUT_LOCK';
        rationale = `Live Cashout offer of GHS ${liveCashoutOffer.toFixed(2)} is >= 5x cycle exposure (${(cashoutVsExposure).toFixed(1)}x). Lock in guaranteed bankroll profit now.`;
      } else {
        recommendation = 'ARBITRAGE_HEDGE_LOCK';
        rationale = `Final leg arbitrage opportunity: Stake GHS ${hedgeStake.toFixed(2)} on opposing outcome @ ${liveOpposingOdds} to guarantee net profit of ~GHS ${netReturnIfParlayWins.toFixed(2)} regardless of outcome.`;
      }
    } else if (payoutVsExposure >= 2.0 && liveCashoutOffer >= cycleExposure) {
      recommendation = 'PRINCIPAL_PROTECTION';
      rationale = `Cashout offer of GHS ${liveCashoutOffer.toFixed(2)} secures original GHS ${cycleExposure.toFixed(2)} cycle exposure. Take principal off the table and let rest ride.`;
    }

    return {
      originalStake,
      totalParlayOdds,
      totalPotentialReturn: parseFloat(totalPotentialReturn.toFixed(2)),
      liveOpposingOdds,
      calculatedHedgeStake: parseFloat(hedgeStake.toFixed(2)),
      guaranteedNetProfit: parseFloat(netReturnIfParlayWins.toFixed(2)),
      liveCashoutOffer,
      payoutMultiplierVsExposure: parseFloat(payoutVsExposure.toFixed(2)),
      recommendation,
      rationale
    };
  }

  /**
   * Normalize a leg object (from scanner, API, or DB) into a canonical market tag
   * matching data/syndicate_heuristics.json v3.0.0.
   */
  canonicalizeMarketKey(leg = {}) {
    const explicitRaw = String(leg.marketKey || leg.market_key || '').trim();
    const explicit = explicitRaw.toUpperCase();
    if (explicit && /^[A-Z0-9_]+$/.test(explicit)) return explicit;

    const marketId = String(leg.marketId || leg.market_id || '');
    const specifier = String(leg.specifier || '').toLowerCase();
    const outcomeId = String(leg.outcomeId || leg.outcome_id || '');
    const raw = `${explicitRaw} ${leg.market_name || leg.marketName || ''} ${leg.selection || leg.outcomeDesc || ''}`.trim();
    const low = raw.toLowerCase();

    // Exact SportyBet marketId/specifier/outcomeId shortcuts
    if (marketId === '75' && (low.includes('no') || outcomeId === '76')) return '1H_GG_NG_NO';
    if (marketId === '14' && (specifier.includes('hcp=0:1') || specifier.includes('hcp=1:0'))) return 'HCP_0_1_FAV';
    if (marketId === '90' && specifier.includes('total=0.5') && (outcomeId === '12' || low.includes('over'))) return '2H_OVER_0_5';
    if (marketId === '68' && specifier.includes('total=2.5') && (outcomeId === '13' || low.includes('under'))) return '1H_UNDER_2_5';

    // Text-based canonicalization (including shorthand aliases)
    if (
      ((low.includes('1st half') || low.includes('1h')) && (low.includes('gg/ng') || low.includes('btts')) && low.includes('no')) ||
      /\b1h\b.*\bng\b/.test(low)
    ) {
      return '1H_GG_NG_NO';
    }
    if (
      (low.includes('handicap') && (low.includes('0:1') || low.includes('1:0') || low.includes('-1'))) ||
      /\bhcp\b.*(0:1|1:0|-1)/.test(low)
    ) {
      return 'HCP_0_1_FAV';
    }
    if (
      ((low.includes('2nd half') || low.includes('2h')) && low.includes('over 0.5')) ||
      /\b2h\b.*\bo\s*0\.5/.test(low)
    ) {
      return '2H_OVER_0_5';
    }
    if ((low.includes('1st half') || low.includes('1h')) && low.includes('under 2.5')) {
      return '1H_UNDER_2_5';
    }
    if ((low.includes('1st half') || low.includes('1h')) && low.includes('under')) {
      return '1H_UNDER';
    }
    const mOu = low.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/);
    if (mOu) {
      const dir = mOu[1].toUpperCase();
      const numStr = mOu[2];
      const line = numStr.includes('.') ? numStr.replace('.', '_') : `${numStr}_0`;
      return `${dir}_${line}`;
    }
    if (low.includes('2up')) return '1X2_2UP';
    if (low.includes('1up')) return '1X2_1UP';
    if (low.includes('double chance') || /\b(1x|x2|12)\b/.test(low)) return 'DOUBLE_CHANCE';
    if (low === 'home' || low === 'away' || low === 'draw' || low.includes('1x2') || marketId === '1') {
      return 'PLAIN_1X2_FAV_ACCUM';
    }
    return 'OTHER_MARKET';
  }

  /**
   * Unified Pre-Execution Leg Validator (v3.0.0)
   * Enforces Rules #22-#24, CH1, Rule #28 (banned_markets + banned_market_league_pairs),
   * Rule #29 (odds band & Betradar RTP floor for bonus_arb_ev), and dynamic market_risk_weights.
   *
   * @param {object} leg
   * @param {'bonus_arb_ev'|'fortress_98pct'|'single'} [profile='bonus_arb_ev']
   * @returns {{ allowed: boolean, reasons: string[], penalty: number, marketKey: string }}
   */
  validateLegAgainstHeuristics(leg = {}, profile = 'bonus_arb_ev') {
    const reasons = [];
    let penalty = 0.0;

    const rules = (this.heuristics && this.heuristics.rules) || DEFAULT_SYNDICATE_HEURISTICS.rules;
    const dynWeights = (this.heuristics && this.heuristics.dynamic_weights) || {};
    const marketRiskWeights = dynWeights.market_risk_weights || {};

    const marketKey = this.canonicalizeMarketKey(leg);
    const league = String(leg.league || '');
    const leagueLow = league.toLowerCase();
    const odds = typeof leg.odds === 'number' ? leg.odds : parseFloat(leg.odds);
    const prob = typeof leg.prob === 'number' ? leg.prob : (leg.betradar_prob != null ? parseFloat(leg.betradar_prob) : null);
    const rtp = typeof leg.rtp === 'number'
      ? leg.rtp
      : (Number.isFinite(odds) && Number.isFinite(prob) && prob > 0 ? odds * prob : null);

    // 1. Rules #22, #23, #24
    const r22Res = this.validateNBASpread({ ...leg, league });
    if (!r22Res.valid) reasons.push(r22Res.reason);

    const r23Res = this.validateHandicapStretching(leg);
    if (!r23Res.valid) reasons.push(r23Res.reason);

    const r24Res = this.validateMotivation(leg);
    if (!r24Res.valid) reasons.push(r24Res.reason);

    // 2. CH1 First-Half Under ban
    const ch1 = rules.codehub_trap_filter;
    if (ch1 && ch1.active && ch1.disallow_first_half_unders) {
      if (marketKey === '1H_UNDER_2_5' || marketKey === '1H_UNDER') {
        reasons.push(`CH1 Violation: First-half under market (${marketKey}) is disallowed.`);
      }
    }

    // 3. Rule #28: Banned Markets & Banned Market-League Pairs
    const r28 = rules.rule_28_friday_postmortem_market_ban;
    if (r28 && r28.active) {
      const bannedMarkets = new Set((r28.banned_markets || []).map(m => String(m).toUpperCase()));
      if (bannedMarkets.has(marketKey)) {
        reasons.push(`Rule #28 Violation: Market '${marketKey}' is in banned_markets.`);
      }
      if (marketKey === 'OVER_2_0' && leagueLow.includes('eerste divisie') && bannedMarkets.has('EERSTE_DIVISIE_OVER_2')) {
        reasons.push(`Rule #28 Violation: Eerste Divisie Over 2.0 is banned (EERSTE_DIVISIE_OVER_2).`);
      }

      const bannedPairs = r28.banned_market_league_pairs || [];
      for (const pair of bannedPairs) {
        const pairMkt = String(pair.market || '').toUpperCase();
        const pairLeaguePat = String(pair.league_pattern || '').toLowerCase();
        if (pairMkt === marketKey && pairLeaguePat && leagueLow.includes(pairLeaguePat)) {
          reasons.push(
            `Rule #28 Market-League Ban: '${marketKey}' in '${league}' matches banned pair (${pair.market} @ ${pair.league_pattern}: ${pair.reason || 'historical loss'}).`
          );
        }
      }
    }

    // 4. Dynamic empirical market_risk_weights penalty & auto-ban check
    const weightInfo = marketRiskWeights[marketKey];
    if (weightInfo) {
      if (typeof weightInfo.penalty === 'number') {
        penalty = Number((penalty + weightInfo.penalty).toFixed(4));
      }
      if (weightInfo.banned === true && !reasons.some(r => r.includes(marketKey))) {
        reasons.push(`Empirical Auto-Ban: Market '${marketKey}' is flagged banned in market_risk_weights.`);
      }
    }

    // 5. Rule #29: Zero-Vig Bonus Sweet Spot (for bonus_arb_ev profile)
    const r29 = rules.rule_29_zero_vig_bonus_sweet_spot;
    if (profile === 'bonus_arb_ev' && r29 && r29.active) {
      const minOdds = r29.min_leg_odds != null ? r29.min_leg_odds : 1.20;
      const maxOdds = r29.max_leg_odds != null ? r29.max_leg_odds : 1.45;
      const minRtp = r29.min_betradar_rtp != null ? r29.min_betradar_rtp : 0.980;

      if (Number.isFinite(odds)) {
        if (odds < minOdds) {
          reasons.push(`Rule #29 Violation: Odds ${odds} below bonus_arb_ev floor ${minOdds}.`);
        }
        if (odds > maxOdds) {
          reasons.push(`Rule #29 Violation: Odds ${odds} above bonus_arb_ev ceiling ${maxOdds}.`);
        }
      } else {
        reasons.push('Rule #29 Violation: Missing or invalid numeric leg odds.');
      }

      if (rtp !== null && Number.isFinite(rtp)) {
        if (rtp < minRtp) {
          reasons.push(`Rule #29 Violation: Betradar RTP ${rtp.toFixed(4)} below floor ${minRtp.toFixed(3)}.`);
        }
      } else {
        reasons.push(`Rule #29 Violation: Missing Betradar RTP / probability (required >= ${minRtp.toFixed(3)} for bonus_arb_ev).`);
      }
    } else if (profile === 'fortress_98pct') {
      if (!Number.isFinite(odds) || odds < 1.01) {
        reasons.push(`Fortress Profile Violation: Invalid leg odds ${leg.odds}.`);
      }
    } else if (profile === 'single') {
      const pRes = this.validatePricing(leg, true);
      if (!pRes.valid) reasons.push(pRes.reason);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      penalty,
      marketKey
    };
  }
}

const instance = new SyndicateHeuristicsEngine();
instance.SyndicateHeuristicsEngine = SyndicateHeuristicsEngine;
module.exports = instance;

