/**
 * Hermes Syndicate Heuristics & Quantitative Risk Engine
 * Implements Hardened Rules #22–#25, CodeHub Trap Filtering, and Arbitrage Hedge Mathematics.
 * Completely isolated in data/syndicate_heuristics.json
 */

const fs = require('fs');
const path = require('path');

const HEURISTICS_FILE = path.resolve(__dirname, '..', 'data', 'syndicate_heuristics.json');

const DEFAULT_SYNDICATE_HEURISTICS = {
  version: '2.0.0-syndicate',
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
      min_payout_multiplier_trigger: 5.0, // 5x cycle exposure (e.g. >= GHS 100 on GHS 20 deployment)
      cashout_equity_ratio_trigger: 0.92, // 92% of mathematical equity
      active: true
    }
  },
  dynamic_weights: {
    road_b2b_penalty: 0.15,
    home_court_boost: 1.08,
    post_international_break_away_penalty: 0.12
  },
  calibration_log: []
};

class SyndicateHeuristicsEngine {
  constructor() {
    this.heuristics = this.load();
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
}

module.exports = new SyndicateHeuristicsEngine();
