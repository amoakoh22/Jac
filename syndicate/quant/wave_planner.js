'use strict';

/**
 * Jac Syndicate v4.0 — Chronological Wave & Principal-Recovery Cashout Planner
 *
 * Solves "Simultaneous Kickoff Wipeout" by partitioning accumulator legs into
 * clean kickoff waves (W1 -> W2 -> W3 -> W4) with a guaranteed inter-wave
 * cashout gap (>= 135 minutes between W1's latest kickoff and W2's earliest kickoff)
 * so ZERO matches are in-play when Wave 1 finishes.
 *
 * Empirically calibrated to SportyBet Ghana's live cashout pricing law (proven on 9121S3):
 *   Cashout(W1) ~= 0.84 * Stake * prod_{i in W1}(odds_i)   (when 0 legs are live)
 */

const CASHOUT_ETA = 0.84;

function buildWavePlan(legs, stake = 3.0, opts = {}) {
  const {
    minWave1GapMinutes = 135,
    pairTotalStake = 0
  } = opts;

  const sorted = (legs || []).slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  if (sorted.length === 0) {
    return { waves: [], horizonHours: 0, wave1CleanWindowMinutes: 0, wave1ExpectedCashoutGhs: 0 };
  }

  const gapMs = minWave1GapMinutes * 60 * 1000;
  const waves = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevStart = current[current.length - 1].startTime || 0;
    const curStart = sorted[i].startTime || 0;
    const minLegsInWave = waves.length === 0 ? Math.min(4, sorted.length) : 2;
    if (current.length >= minLegsInWave && curStart - prevStart >= gapMs && waves.length < 3) {
      waves.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  if (current.length > 0) waves.push(current);

  let cumOdds = 1.0;
  let cumNonLossProb = 1.0;
  const waveSummaries = waves.map((wLegs, idx) => {
    const wOdds = wLegs.reduce((acc, l) => acc * Number(l.odds || 1), 1.0);
    const wSurv = wLegs.reduce((acc, l) => acc * Number(l.nonLossProb ?? l.prob ?? 0.8), 1.0);
    cumOdds *= wOdds;
    cumNonLossProb *= wSurv;
    const firstKo = wLegs[0].startTime || 0;
    const lastKo = wLegs[wLegs.length - 1].startTime || 0;
    const nextWaveKo = idx + 1 < waves.length ? (waves[idx + 1][0].startTime || 0) : 0;
    const gapToNextMin = nextWaveKo > lastKo ? Math.round((nextWaveKo - lastKo) / 60000) : 0;
    const expectedCashoutGhs = +(CASHOUT_ETA * Number(stake) * cumOdds).toFixed(2);

    let directive = 'HOLD_FOR_JACKPOT';
    if (idx === 0 && pairTotalStake > 0 && expectedCashoutGhs >= pairTotalStake * 1.02) {
      directive = `HARVESTER_PRINCIPAL_LOCK (>= GHS ${(pairTotalStake * 1.02).toFixed(2)})`;
    } else if (idx === 0) {
      directive = `WAVE1_CHECKPOINT (Est. Cashout GHS ${expectedCashoutGhs.toFixed(2)})`;
    } else if (idx === waves.length - 1) {
      directive = 'FINAL_WAVE_JACKPOT_RIDE';
    }

    return {
      waveIndex: idx + 1,
      legCount: wLegs.length,
      waveOddsProduct: +wOdds.toFixed(4),
      cumulativeOddsProduct: +cumOdds.toFixed(4),
      waveSurvivalProb: +wSurv.toFixed(4),
      cumulativeSurvivalProb: +cumNonLossProb.toFixed(4),
      startWindowGmt: firstKo ? new Date(firstKo).toISOString().slice(0, 16).replace('T', ' ') : '',
      lastKickoffGmt: lastKo ? new Date(lastKo).toISOString().slice(0, 16).replace('T', ' ') : '',
      gapToNextWaveMinutes: gapToNextMin,
      expectedCashoutGhs,
      directive
    };
  });

  const minT = sorted[0].startTime || 0;
  const maxT = sorted[sorted.length - 1].startTime || 0;
  const horizonHours = minT > 0 ? +((maxT - minT) / 3600000).toFixed(1) : 0;

  return {
    waveCount: waveSummaries.length,
    horizonHours,
    wave1CleanWindowMinutes: waveSummaries[0]?.gapToNextWaveMinutes || 0,
    wave1SurvivalProb: waveSummaries[0]?.waveSurvivalProb || 0,
    wave1ExpectedCashoutGhs: waveSummaries[0]?.expectedCashoutGhs || 0,
    waves: waveSummaries
  };
}

/**
 * Select a 4-wave staggered subset of legs from a candidate pool so that:
 *   1. Wave 1 has 4-6 high-survival legs (cumulative base odds >= targetWave1Odds, e.g., 2.55x)
 *   2. Wave 2 starts >= minWave1GapMinutes (135m+) after Wave 1's last kickoff!
 *   3. Remaining legs come strictly from Wave 2+ (>= Wave 1 end + gap), ranked by score.
 */
function selectWaveStaggeredSubset(candidates, targetCount, opts = {}) {
  const {
    minWave1Legs = 4,
    maxWave1Legs = 6,
    targetWave1Odds = 2.50,
    minWave1GapMinutes = 135
  } = opts;

  const byTime = (candidates || []).slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  if (byTime.length < targetCount) return null;

  const gapMs = minWave1GapMinutes * 60 * 1000;

  // Try candidate Wave-1 cutoff timestamps among the earliest 18 events
  let bestCombo = null;
  const maxW1Search = Math.min(20, byTime.length - (targetCount - minWave1Legs));

  for (let endIdx = minWave1Legs - 1; endIdx < maxW1Search; endIdx++) {
    const cutoffTime = byTime[endIdx].startTime || 0;
    const earlyPool = byTime.slice(0, endIdx + 1).sort((a, b) =>
      ((b.nonLossProb ?? b.prob ?? 0) - (a.nonLossProb ?? a.prob ?? 0)) || ((b.adjustedScore ?? 0) - (a.adjustedScore ?? 0))
    );
    const laterPool = byTime.filter(x => (x.startTime || 0) >= cutoffTime + gapMs).sort((a, b) =>
      ((b.adjustedScore ?? b.singleRtp ?? b.rtp ?? 0) - (a.adjustedScore ?? a.singleRtp ?? a.rtp ?? 0))
    );

    for (let w1Count = minWave1Legs; w1Count <= Math.min(maxWave1Legs, earlyPool.length); w1Count++) {
      const remNeeded = targetCount - w1Count;
      if (laterPool.length < remNeeded) continue;

      const w1 = earlyPool.slice(0, w1Count);
      const w1Odds = w1.reduce((acc, x) => acc * Number(x.odds || 1), 1.0);
      if (w1Odds < targetWave1Odds) continue;

      const rest = laterPool.slice(0, remNeeded);
      const combined = w1.concat(rest);
      const avgScore = combined.reduce((s, x) => s + Number(x.adjustedScore ?? x.singleRtp ?? x.rtp ?? 0), 0) / combined.length;
      const w1Surv = w1.reduce((acc, x) => acc * Number(x.nonLossProb ?? x.prob ?? 0.8), 1.0);
      const rankMetric = avgScore + 0.15 * w1Surv;

      if (!bestCombo || rankMetric > bestCombo.rankMetric) {
        bestCombo = { legs: combined, w1Count, w1Odds, w1Surv, rankMetric };
      }
    }
  }

  return bestCombo ? bestCombo.legs : null;
}

module.exports = {
  CASHOUT_ETA,
  buildWavePlan,
  selectWaveStaggeredSubset
};
