'use strict';

const {
  getDefaultBonusPlan,
  evaluateTicketMath
} = require('./bonus_model');
const { filterAndScoreCandidate } = require('./learning_filter');
const { buildWapItemFromLive } = require('./sportybet_api');

const DEFAULT_OPTS = Object.freeze({
  minCombinedProb: 0.980,
  minLegProb: 0.985,
  singleLegMinProb: 0.980,
  maxLegs: 10,
  minTicketRtp: 0.985,
  bankroll: 187.67,
  minStake: 2.0,
  maxStake: 5.0,
  maxBankrollPct: 0.027,
  excludeEventIds: []
});

function normalizeLeg(candidate, filterResult) {
  const odds = Number(candidate.odds);
  const prob = Number(candidate.prob);
  const rtp = (Number.isFinite(odds) && odds > 0 && Number.isFinite(prob) && prob > 0)
    ? +(odds * prob).toFixed(6)
    : (Number.isFinite(Number(candidate.rtp)) && Number(candidate.rtp) > 0 ? Number(candidate.rtp) : 0);
  const match = candidate.match || `${candidate.home || ''} vs ${candidate.away || ''}`.trim();

  return {
    ...candidate,
    match,
    sportId: candidate.sportId || 'sr:sport:1',
    odds,
    prob,
    rtp,
    marketKey: filterResult.canonicalMarket,
    learningPenalty: filterResult.penalty,
    adjustedScore: filterResult.adjustedScore,
    wap_item: buildWapItemFromLive(candidate)
  };
}

function computeFortressStake(math, bankroll, opts) {
  const cap = Math.min(opts.maxStake, +(bankroll * opts.maxBankrollPct).toFixed(2));
  if (cap <= 0) return 0;
  if (cap < opts.minStake) return +cap.toFixed(2);
  // Deploy higher end of disciplined range when ticket is individually +EV, else conservative minStake
  if (math.isPositiveEv && math.trueExpectedRtp >= 1.005) {
    return +cap.toFixed(2);
  }
  if (math.isPositiveEv) {
    const mid = (opts.minStake + cap) / 2;
    return +Math.min(cap, Math.max(opts.minStake, mid)).toFixed(2);
  }
  return +opts.minStake.toFixed(2);
}

function buildFortress98Ticket(candidates, bonusPlan = getDefaultBonusPlan(), learningCtx = null, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const excludeEventIds = cfg.excludeEventIds instanceof Set
    ? cfg.excludeEventIds
    : new Set(cfg.excludeEventIds || []);

  const rejectedCounts = {
    inactive: 0,
    excludedEvent: 0,
    invalidOdds: 0,
    lowProb: 0,
    learningFilter: 0
  };
  let activeOverlapRejected = 0;
  let bannedMarketRejected = 0;

  const probFloor = Math.min(cfg.minLegProb, cfg.singleLegMinProb, cfg.minCombinedProb);
  const bestByEvent = new Map();

  for (const cand of (candidates || [])) {
    if (!cand || !cand.eventId) continue;
    if (cand.isActive === false || cand.isActive === 0) {
      rejectedCounts.inactive += 1;
      continue;
    }
    if (excludeEventIds.has(cand.eventId)) {
      rejectedCounts.excludedEvent += 1;
      continue;
    }

    const odds = Number(cand.odds);
    const prob = Number(cand.prob);
    if (!Number.isFinite(odds) || odds < 1.01) {
      rejectedCounts.invalidOdds += 1;
      continue;
    }
    if (!Number.isFinite(prob) || prob < probFloor - 1e-9 || prob > 1.0) {
      rejectedCounts.lowProb += 1;
      continue;
    }

    const filterResult = filterAndScoreCandidate(cand, learningCtx, 'fortress_98pct');
    if (!filterResult.allowed) {
      rejectedCounts.learningFilter += 1;
      if (filterResult.reasons.some(r => r.startsWith('ACTIVE_FIXTURE_OVERLAP'))) activeOverlapRejected += 1;
      if (filterResult.reasons.some(r => r.startsWith('BANNED_') || r.startsWith('FORTRESS_FRAGILE_') || r.startsWith('EMPIRICAL_LOSS_BAN'))) {
        bannedMarketRejected += 1;
      }
      continue;
    }

    const leg = normalizeLeg(cand, filterResult);
    const prev = bestByEvent.get(leg.eventId);
    if (!prev) {
      bestByEvent.set(leg.eventId, leg);
    } else {
      const legPosEv = leg.rtp >= 1.0;
      const prevPosEv = prev.rtp >= 1.0;
      // Prefer individually +EV leg if both meet minLegProb, else highest prob, tie-break highest rtp
      const better =
        (legPosEv !== prevPosEv && leg.prob >= cfg.minLegProb && prev.prob >= cfg.minLegProb)
          ? legPosEv
          : (leg.prob > prev.prob + 1e-9 ||
            (Math.abs(leg.prob - prev.prob) <= 1e-9 && leg.rtp > prev.rtp + 1e-9));
      if (better) {
        bestByEvent.set(leg.eventId, leg);
      }
    }
  }

  const uniqueLegs = Array.from(bestByEvent.values());
  if (uniqueLegs.length === 0) {
    return {
      ok: false,
      ticket: null,
      diagnostics: {
        reason: 'NO_QUALIFYING_FORTRESS_LEGS',
        uniqueQualifyingEvents: 0,
        rejectedCounts,
        activeOverlapRejected,
        bannedMarketRejected
      }
    };
  }

  // Sort: individually +EV legs first (prob desc, rtp desc), then non-+EV legs (prob desc, rtp desc)
  const ordered = uniqueLegs.slice().sort((a, b) => {
    const aPos = a.rtp >= 1.0 ? 1 : 0;
    const bPos = b.rtp >= 1.0 ? 1 : 0;
    if (aPos !== bPos) return bPos - aPos;
    if (Math.abs(b.prob - a.prob) > 1e-9) return b.prob - a.prob;
    return (b.rtp - a.rtp) || (b.adjustedScore - a.adjustedScore);
  });

  // Greedily stack disjoint legs while maintaining true combinedWinProb >= minCombinedProb
  const selected = [];
  let combinedProb = 1.0;

  for (const leg of ordered) {
    if (selected.length >= cfg.maxLegs) break;

    if (selected.length === 0) {
      if (leg.prob < Math.max(cfg.minCombinedProb, cfg.singleLegMinProb) - 1e-9) continue;
      const trialMath = evaluateTicketMath([leg], bonusPlan, 1.0);
      if (trialMath.trueExpectedRtp < cfg.minTicketRtp - 1e-9) continue;
      selected.push(leg);
      combinedProb = leg.prob;
      continue;
    }

    if (leg.prob < cfg.minLegProb - 1e-9) continue;
    const nextCombinedProb = combinedProb * leg.prob;
    if (nextCombinedProb < cfg.minCombinedProb - 1e-9) continue;

    const currentMath = evaluateTicketMath(selected, bonusPlan, 1.0);
    const nextMath = evaluateTicketMath([...selected, leg], bonusPlan, 1.0);

    if (nextMath.trueExpectedRtp < cfg.minTicketRtp - 1e-9) continue;
    // Do not dilute an already +EV fortress into negative EV
    if (currentMath.isPositiveEv && !nextMath.isPositiveEv) continue;

    selected.push(leg);
    combinedProb = nextCombinedProb;
  }

  if (selected.length === 0) {
    return {
      ok: false,
      ticket: null,
      diagnostics: {
        reason: 'CANNOT_MEET_COMBINED_PROB_OR_RTP_GATE',
        uniqueQualifyingEvents: uniqueLegs.length,
        maxLegProb: Math.max(...uniqueLegs.map(l => l.prob)),
        rejectedCounts,
        activeOverlapRejected,
        bannedMarketRejected
      }
    };
  }

  const probeMath = evaluateTicketMath(selected, bonusPlan, 1.0);
  const stake = computeFortressStake(probeMath, cfg.bankroll, cfg);
  const finalMath = evaluateTicketMath(selected, bonusPlan, stake);

  // Hard gate assertions
  if (
    finalMath.combinedWinProb < cfg.minCombinedProb - 1e-9 ||
    finalMath.trueExpectedRtp < cfg.minTicketRtp - 1e-9
  ) {
    return {
      ok: false,
      ticket: null,
      diagnostics: {
        reason: 'FORTRESS_HARD_GATE_FAILED',
        finalMath
      }
    };
  }

  const uniqueEventCount = new Set(selected.map(l => l.eventId)).size;
  const ticket = {
    id: `QUANT_FORTRESS_${selected.length}F_${Date.now()}`,
    mode: 'fortress_98pct',
    name: `Mode B 98%+ Combined-Prob Tail-Risk Fortress (${selected.length}F, ${(finalMath.combinedWinProb * 100).toFixed(2)}% Win Prob)`,
    recommendedStakeGhs: stake,
    mathProof: finalMath,
    guardrailAudit: {
      zeroCorrelationPassed: uniqueEventCount === selected.length,
      activeOverlapCount: 0,
      bannedMarketViolations: 0
    },
    legs: selected
  };

  return {
    ok: true,
    ticket,
    diagnostics: {
      uniqueQualifyingEvents: uniqueLegs.length,
      selectedFolds: selected.length,
      combinedWinProb: finalMath.combinedWinProb,
      isPositiveEv: finalMath.isPositiveEv,
      rejectedCounts,
      activeOverlapRejected,
      bannedMarketRejected
    }
  };
}

module.exports = {
  DEFAULT_OPTS,
  buildFortress98Ticket
};
