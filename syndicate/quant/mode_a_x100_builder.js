'use strict';

const {
  getDefaultBonusPlan,
  getSportFactor,
  evaluateTicketMath,
  quarterKellyStake
} = require('./bonus_model');
const { filterAndScoreCandidate } = require('./learning_filter');
const { buildWapItemFromLive } = require('./sportybet_api');

const DEFAULT_OPTS = Object.freeze({
  minMultiplier: 100.0,
  minFolds: 20,
  maxFolds: 35,
  minLegOdds: 1.20,
  maxLegOdds: 1.45,
  minLegRtp: 0.980,
  minTicketEv: 1.02,
  hardEvFloor: 1.00,
  bankroll: 187.67,
  minStake: 2.0,
  maxStake: 3.0,
  maxBankrollPct: 0.03,
  preferHighestWinProb: false
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

function tryBuildSubsetForN(poolSortedByScore, n, bonusPlan, minMultiplier, evThreshold) {
  if (poolSortedByScore.length < n) return null;

  const selected = poolSortedByScore.slice(0, n);
  const remaining = poolSortedByScore.slice(n);
  let math = evaluateTicketMath(selected, bonusPlan, 1.0);

  // If top-score legs pass EV but fall slightly short of minMultiplier, greedily swap
  // lowest-odds selected leg with highest-score remaining leg that increases odds while preserving EV.
  if (math.effectiveMultiplier < minMultiplier && remaining.length > 0) {
    const working = selected.slice();
    const bench = remaining.slice().sort((a, b) => (b.odds * b.adjustedScore) - (a.odds * a.adjustedScore));

    for (let iter = 0; iter < Math.min(n, bench.length); iter++) {
      math = evaluateTicketMath(working, bonusPlan, 1.0);
      if (math.effectiveMultiplier >= minMultiplier) break;

      // Find lowest-odds leg in working
      let minIdx = 0;
      for (let i = 1; i < working.length; i++) {
        if (working[i].odds < working[minIdx].odds) minIdx = i;
      }

      // Find best bench leg with higher odds that keeps trueExpectedRtp >= evThreshold
      let bestBenchIdx = -1;
      let bestCandidateEv = -Infinity;
      for (let j = 0; j < bench.length; j++) {
        if (bench[j].odds <= working[minIdx].odds + 1e-6) continue;
        const trial = working.slice();
        trial[minIdx] = bench[j];
        const trialMath = evaluateTicketMath(trial, bonusPlan, 1.0);
        if (trialMath.trueExpectedRtp >= evThreshold && trialMath.trueExpectedRtp > bestCandidateEv) {
          bestCandidateEv = trialMath.trueExpectedRtp;
          bestBenchIdx = j;
        }
      }

      if (bestBenchIdx === -1) break;
      working[minIdx] = bench[bestBenchIdx];
      bench.splice(bestBenchIdx, 1);
    }

    math = evaluateTicketMath(working, bonusPlan, 1.0);
    if (math.effectiveMultiplier >= minMultiplier && math.trueExpectedRtp >= evThreshold && math.trueExpectedRtp > 1.0) {
      return { legs: working, math };
    }
    return null;
  }

  if (math.effectiveMultiplier >= minMultiplier && math.trueExpectedRtp >= evThreshold && math.trueExpectedRtp > 1.0) {
    return { legs: selected, math };
  }
  return null;
}

function buildX100PlusEvTicket(candidates, bonusPlan = getDefaultBonusPlan(), learningCtx = null, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const excludeEventIds = cfg.excludeEventIds instanceof Set
    ? cfg.excludeEventIds
    : new Set(cfg.excludeEventIds || []);
  const evThreshold = Math.max(cfg.minTicketEv, cfg.hardEvFloor);

  const rejectedCounts = {
    inactive: 0,
    excludedEvent: 0,
    oddsOutOfRange: 0,
    invalidProb: 0,
    lowRtp: 0,
    learningFilter: 0
  };
  let activeOverlapRejected = 0;
  let bannedMarketRejected = 0;

  // 1. Filter and deduplicate to best qualifying leg per eventId
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
    if (!Number.isFinite(odds) || odds < cfg.minLegOdds - 1e-9 || odds > cfg.maxLegOdds + 1e-9) {
      rejectedCounts.oddsOutOfRange += 1;
      continue;
    }
    if (!Number.isFinite(prob) || prob <= 0 || prob > 1) {
      rejectedCounts.invalidProb += 1;
      continue;
    }

    const rtp = (Number.isFinite(odds) && odds > 0 && Number.isFinite(prob) && prob > 0)
      ? +(odds * prob).toFixed(6)
      : (Number.isFinite(Number(cand.rtp)) && Number(cand.rtp) > 0 ? Number(cand.rtp) : 0);
    if (rtp < cfg.minLegRtp - 1e-9) {
      rejectedCounts.lowRtp += 1;
      continue;
    }

    const filterResult = filterAndScoreCandidate(cand, learningCtx, 'x100_plus_ev');
    if (!filterResult.allowed) {
      rejectedCounts.learningFilter += 1;
      if (filterResult.reasons.some(r => r.startsWith('ACTIVE_FIXTURE_OVERLAP'))) activeOverlapRejected += 1;
      if (filterResult.reasons.some(r => r.startsWith('BANNED_') || r.startsWith('EMPIRICAL_LOSS_BAN'))) bannedMarketRejected += 1;
      continue;
    }

    const leg = normalizeLeg(cand, filterResult);
    const prev = bestByEvent.get(leg.eventId);
    if (
      !prev ||
      leg.adjustedScore > prev.adjustedScore + 1e-9 ||
      (Math.abs(leg.adjustedScore - prev.adjustedScore) <= 1e-9 && leg.rtp > prev.rtp + 1e-9) ||
      (Math.abs(leg.adjustedScore - prev.adjustedScore) <= 1e-9 && Math.abs(leg.rtp - prev.rtp) <= 1e-9 && leg.prob > prev.prob)
    ) {
      bestByEvent.set(leg.eventId, leg);
    }
  }

  const allUniqueLegs = Array.from(bestByEvent.values());
  const sortByScore = arr => arr.slice().sort((a, b) =>
    (b.adjustedScore - a.adjustedScore) || (b.rtp - a.rtp) || (b.prob - a.prob)
  );

  // 2. Partition into candidate pools:
  //    - Full-bonus (1.00x) sports pool (Basketball/Tennis/Ice Hockey/Table Tennis)
  //    - Pure individual sport pools (e.g., pure Football 0.50x)
  //    - Mixed-sport pool (conservative min factor)
  const pools = [];
  const fullBonusLegs = allUniqueLegs.filter(l => getSportFactor(l.sportId, l.tournamentId, bonusPlan) >= 0.999);
  if (fullBonusLegs.length >= cfg.minFolds) {
    pools.push({ name: '1.00x_full_bonus_sports', legs: sortByScore(fullBonusLegs) });
  }

  const bySport = new Map();
  for (const leg of allUniqueLegs) {
    if (!bySport.has(leg.sportId)) bySport.set(leg.sportId, []);
    bySport.get(leg.sportId).push(leg);
  }
  for (const [sportId, legs] of bySport.entries()) {
    if (legs.length >= cfg.minFolds) {
      pools.push({ name: `pure_${sportId}`, legs: sortByScore(legs) });
    }
  }

  if (allUniqueLegs.length >= cfg.minFolds && bySport.size > 1) {
    pools.push({ name: 'mixed_sports', legs: sortByScore(allUniqueLegs) });
  }

  // 3. Sweep N in [minFolds, maxFolds] across every eligible pool
  let bestSolution = null;
  let bestNearMiss = null;

  for (const pool of pools) {
    const upperN = Math.min(cfg.maxFolds, pool.legs.length);
    for (let n = cfg.minFolds; n <= upperN; n++) {
      const attempt = tryBuildSubsetForN(pool.legs, n, bonusPlan, cfg.minMultiplier, evThreshold);
      if (attempt) {
        if (!bestSolution) {
          bestSolution = { ...attempt, poolName: pool.name };
        } else {
          const better = cfg.preferHighestWinProb
            ? (attempt.math.combinedWinProb > bestSolution.math.combinedWinProb)
            : (attempt.math.trueExpectedRtp > bestSolution.math.trueExpectedRtp + 1e-6 ||
              (Math.abs(attempt.math.trueExpectedRtp - bestSolution.math.trueExpectedRtp) <= 1e-6 &&
                attempt.math.combinedWinProb > bestSolution.math.combinedWinProb));
          if (better) {
            bestSolution = { ...attempt, poolName: pool.name };
          }
        }
      } else {
        const rawMath = evaluateTicketMath(pool.legs.slice(0, n), bonusPlan, 1.0);
        if (!bestNearMiss || rawMath.trueExpectedRtp > bestNearMiss.trueExpectedRtp) {
          bestNearMiss = { poolName: pool.name, n, ...rawMath };
        }
      }
    }
  }

  if (!bestSolution) {
    return {
      ok: false,
      ticket: null,
      diagnostics: {
        reason: allUniqueLegs.length < cfg.minFolds
          ? `INSUFFICIENT_QUALIFYING_EVENTS:${allUniqueLegs.length}<${cfg.minFolds}`
          : 'NO_POSITIVE_EV_X100_SOLUTION',
        uniqueQualifyingEvents: allUniqueLegs.length,
        rejectedCounts,
        activeOverlapRejected,
        bannedMarketRejected,
        bestNearMiss
      }
    };
  }

  const stake = quarterKellyStake(
    bestSolution.math.trueExpectedRtp,
    bestSolution.math.effectiveMultiplier,
    cfg.bankroll,
    {
      minStake: cfg.minStake,
      maxStake: cfg.maxStake,
      maxBankrollPct: cfg.maxBankrollPct
    }
  );
  const finalMath = evaluateTicketMath(bestSolution.legs, bonusPlan, stake);

  // Double-check strict mathematical invariants before emitting
  if (!finalMath.isPositiveEv || finalMath.trueExpectedRtp <= 1.0 || finalMath.effectiveMultiplier < cfg.minMultiplier) {
    return {
      ok: false,
      ticket: null,
      diagnostics: {
        reason: 'POST_CHECK_INVARIANT_FAILED',
        finalMath
      }
    };
  }

  const uniqueEventCount = new Set(bestSolution.legs.map(l => l.eventId)).size;
  const ticket = {
    id: `QUANT_X100_${bestSolution.legs.length}F_${Date.now()}`,
    mode: 'x100_plus_ev',
    name: `Mode A x100+ +EV Zero-Vig Bonus Arb (${bestSolution.legs.length}F ${bestSolution.poolName})`,
    poolName: bestSolution.poolName,
    recommendedStakeGhs: stake,
    mathProof: finalMath,
    guardrailAudit: {
      zeroCorrelationPassed: uniqueEventCount === bestSolution.legs.length,
      activeOverlapCount: 0,
      bannedMarketViolations: 0
    },
    legs: bestSolution.legs
  };

  return {
    ok: true,
    ticket,
    diagnostics: {
      uniqueQualifyingEvents: allUniqueLegs.length,
      rejectedCounts,
      activeOverlapRejected,
      bannedMarketRejected,
      selectedPool: bestSolution.poolName,
      selectedFolds: bestSolution.legs.length
    }
  };
}

function buildDisjointX100Tickets(candidates, bonusPlan = getDefaultBonusPlan(), learningCtx = null, count = 2, opts = {}) {
  const tickets = [];
  const diagnostics = [];
  const usedEventIds = new Set(opts.excludeEventIds || []);

  for (let i = 0; i < count; i++) {
    const res = buildX100PlusEvTicket(candidates, bonusPlan, learningCtx, {
      ...opts,
      excludeEventIds: usedEventIds
    });
    diagnostics.push(res.diagnostics);
    if (!res.ok || !res.ticket) break;

    res.ticket.id = `QUANT_X100_${i + 1}_${res.ticket.legs.length}F_${Date.now()}`;
    tickets.push(res.ticket);
    for (const leg of res.ticket.legs) {
      usedEventIds.add(leg.eventId);
    }
  }

  return {
    ok: tickets.length > 0,
    tickets,
    diagnostics
  };
}

module.exports = {
  DEFAULT_OPTS,
  buildX100PlusEvTicket,
  buildDisjointX100Tickets
};
