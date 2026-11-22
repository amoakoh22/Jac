'use strict';

// Exact verified fallback snapshot from SportyBet Ghana /api/gh/promotion/v2/bonus/plans/valid
// Extracted verbatim from runtime/all_open_bets_apis.json
const FALLBACK_BONUS_PLAN_RAW = Object.freeze({
  bizCode: 10000,
  data: {
    entityList: [
      {
        qualifyingOddsLimit: 12000,
        factor: 10000,
        bonusRatios: [
          { qualifyingSelections: 2, min: 0, max: 300 },
          { qualifyingSelections: 3, min: 0, max: 500 },
          { qualifyingSelections: 4, min: 0, max: 800 },
          { qualifyingSelections: 5, min: 500, max: 1200 },
          { qualifyingSelections: 6, min: 700, max: 1600 },
          { qualifyingSelections: 7, min: 700, max: 2000 },
          { qualifyingSelections: 8, min: 1000, max: 2500 },
          { qualifyingSelections: 9, min: 1000, max: 3000 },
          { qualifyingSelections: 10, min: 1000, max: 3300 },
          { qualifyingSelections: 11, min: 1500, max: 3500 },
          { qualifyingSelections: 12, min: 1500, max: 3700 },
          { qualifyingSelections: 13, min: 1500, max: 4000 },
          { qualifyingSelections: 14, min: 1500, max: 4200 },
          { qualifyingSelections: 15, min: 1500, max: 4500 },
          { qualifyingSelections: 16, min: 2500, max: 5000 },
          { qualifyingSelections: 17, min: 2500, max: 5500 },
          { qualifyingSelections: 18, min: 3000, max: 6000 },
          { qualifyingSelections: 19, min: 3000, max: 6500 },
          { qualifyingSelections: 20, min: 3000, max: 7000 },
          { qualifyingSelections: 21, min: 3500, max: 7500 },
          { qualifyingSelections: 22, min: 3500, max: 8000 },
          { qualifyingSelections: 23, min: 3500, max: 8500 },
          { qualifyingSelections: 24, min: 4000, max: 9000 },
          { qualifyingSelections: 25, min: 4000, max: 9500 },
          { qualifyingSelections: 26, min: 4000, max: 10000 },
          { qualifyingSelections: 27, min: 4500, max: 11000 },
          { qualifyingSelections: 28, min: 4500, max: 12000 },
          { qualifyingSelections: 29, min: 5000, max: 13000 },
          { qualifyingSelections: 30, min: 5000, max: 16000 },
          { qualifyingSelections: 31, min: 5000, max: 18000 },
          { qualifyingSelections: 32, min: 5500, max: 19000 },
          { qualifyingSelections: 33, min: 5500, max: 20000 },
          { qualifyingSelections: 34, min: 6000, max: 21000 },
          { qualifyingSelections: 35, min: 6000, max: 22000 },
          { qualifyingSelections: 36, min: 6000, max: 23000 },
          { qualifyingSelections: 37, min: 6500, max: 24000 },
          { qualifyingSelections: 38, min: 6500, max: 25000 },
          { qualifyingSelections: 39, min: 7000, max: 26000 },
          { qualifyingSelections: 40, min: 7000, max: 27000 },
          { qualifyingSelections: 41, min: 7000, max: 28000 },
          { qualifyingSelections: 42, min: 7500, max: 29000 },
          { qualifyingSelections: 43, min: 7500, max: 30000 },
          { qualifyingSelections: 44, min: 8000, max: 30000 },
          { qualifyingSelections: 45, min: 8000, max: 30000 },
          { qualifyingSelections: 46, min: 8500, max: 30000 },
          { qualifyingSelections: 47, min: 8500, max: 30000 },
          { qualifyingSelections: 48, min: 9000, max: 30000 },
          { qualifyingSelections: 49, min: 9000, max: 30000 },
          { qualifyingSelections: 50, min: 10000, max: 30000 }
        ]
      }
    ],
    bonusFactorVOList: [
      { sportId: 'sr:sport:1', sportName: 'Football', tournamentId: '', bonusFactor: 5000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:2', sportName: 'BasketBall', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:5', sportName: 'Tennis', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:12', sportName: 'Rugby', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:16', sportName: 'American Football', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:21', sportName: 'Cricket', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:6', sportName: 'Handball', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:4', sportName: 'Ice Hockey', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:23', sportName: 'Volleyball', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:34', sportName: 'Beach Volley', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:22', sportName: 'Darts', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:31', sportName: 'Badminton', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:20', sportName: 'Table Tennis', tournamentId: '', bonusFactor: 10000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:3', sportName: 'Baseball', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:109', sportName: 'CS GO', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:110', sportName: 'LoL', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:111', sportName: 'Dota2', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:117', sportName: 'MMA', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:29', sportName: 'Futsal', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:137', sportName: 'eSoccer', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:153', sportName: 'eBasketball', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:195', sportName: 'eIce Hockey', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:10', sportName: 'Boxing', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:19', sportName: 'Snooker', tournamentId: '', bonusFactor: 7500, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:1', sportName: '', tournamentId: 'sr:tournament:2112', bonusFactor: 5000, isEnabled: true, isDel: false },
      { sportId: 'sr:sport:1', sportName: '', tournamentId: 'sr:tournament:1191', bonusFactor: 5000, isEnabled: true, isDel: false }
    ]
  }
});

function parseBonusPlan(apiResponse) {
  if (apiResponse && apiResponse.ratiosByN instanceof Map && apiResponse.sportFactors instanceof Map) {
    return apiResponse;
  }

  const root = apiResponse?.data?.entityList
    ? apiResponse.data
    : (apiResponse?.entityList ? apiResponse : FALLBACK_BONUS_PLAN_RAW.data);

  const entity = Array.isArray(root.entityList) && root.entityList.length > 0
    ? root.entityList[0]
    : FALLBACK_BONUS_PLAN_RAW.data.entityList[0];

  const factor = Number(entity.factor || 10000);
  const qualifyingOdds = Number(entity.qualifyingOddsLimit || 12000) / factor;

  const ratiosByN = new Map();
  let maxSelectionsKey = 0;
  for (const row of (entity.bonusRatios || [])) {
    const n = Number(row.qualifyingSelections);
    if (!Number.isFinite(n)) continue;
    ratiosByN.set(n, {
      min: Number(row.min || 0) / factor,
      max: Number(row.max || 0) / factor
    });
    if (n > maxSelectionsKey) maxSelectionsKey = n;
  }

  const sportFactors = new Map();
  const tournamentFactors = new Map();
  for (const item of (root.bonusFactorVOList || [])) {
    if (item.isEnabled === false || item.isDel === true) continue;
    const f = Number(item.bonusFactor || 0) / factor;
    if (item.tournamentId) {
      tournamentFactors.set(String(item.tournamentId), f);
    } else if (item.sportId) {
      sportFactors.set(String(item.sportId), f);
    }
  }

  return {
    qualifyingOdds,
    factor,
    maxSelectionsKey,
    ratiosByN,
    sportFactors,
    tournamentFactors
  };
}

let cachedDefaultPlan = null;
function getDefaultBonusPlan() {
  if (!cachedDefaultPlan) {
    cachedDefaultPlan = parseBonusPlan(FALLBACK_BONUS_PLAN_RAW);
  }
  return cachedDefaultPlan;
}

function getSportFactor(sportId, tournamentId, plan = getDefaultBonusPlan()) {
  const p = parseBonusPlan(plan);
  if (tournamentId && p.tournamentFactors.has(String(tournamentId))) {
    return p.tournamentFactors.get(String(tournamentId));
  }
  const sid = String(sportId || 'sr:sport:1');
  if (p.sportFactors.has(sid)) {
    return p.sportFactors.get(sid);
  }
  return 0.50;
}

function computeBonusPct(legs, plan = getDefaultBonusPlan()) {
  const p = parseBonusPlan(plan);
  const list = Array.isArray(legs) ? legs : [];
  const qualifyingLegs = list.filter(leg => Number(leg?.odds || 0) >= p.qualifyingOdds - 1e-9);
  const qualifyingCount = qualifyingLegs.length;

  if (qualifyingCount < 2) {
    return {
      qualifyingCount,
      maxRatio: 0,
      effectiveFactor: 0,
      bonusPct: 0
    };
  }

  const lookupKey = Math.min(qualifyingCount, p.maxSelectionsKey || 50);
  const ratioEntry = p.ratiosByN.get(lookupKey) || { min: 0, max: 0 };
  const maxRatio = ratioEntry.max;

  const factors = qualifyingLegs.map(leg => getSportFactor(leg.sportId, leg.tournamentId, p));
  // Conservative lower bound for mixed sports so EV is never overestimated
  const effectiveFactor = factors.length > 0 ? Math.min(...factors) : 0.50;
  const bonusPct = +(maxRatio * effectiveFactor).toFixed(6);

  return {
    qualifyingCount,
    maxRatio,
    effectiveFactor,
    bonusPct
  };
}

function evaluateTicketMath(legs, plan = getDefaultBonusPlan(), stake = 1.0) {
  const list = Array.isArray(legs) ? legs : [];
  const folds = list.length;
  const numericStake = Number(stake);

  if (folds === 0) {
    return {
      folds: 0,
      qualifyingCount: 0,
      baseOdds: 0,
      bonusPct: 0,
      effectiveMultiplier: 0,
      potentialPayout: 0,
      combinedWinProb: 0,
      geometricMeanRtp: 0,
      trueExpectedRtp: 0,
      expectedValueGhs: 0,
      isPositiveEv: false
    };
  }

  let baseOdds = 1.0;
  let combinedWinProb = 1.0;
  let rtpProduct = 1.0;

  for (const leg of list) {
    const od = Number(leg.odds);
    const pr = Number(leg.prob);
    const legRtp = (Number.isFinite(od) && od > 0 && Number.isFinite(pr) && pr > 0)
      ? od * pr
      : (Number.isFinite(Number(leg.rtp)) && Number(leg.rtp) > 0 ? Number(leg.rtp) : 0);
    baseOdds *= od;
    combinedWinProb *= pr;
    rtpProduct *= legRtp;
  }

  const { qualifyingCount, bonusPct } = computeBonusPct(list, plan);
  const effectiveMultiplier = baseOdds * (1 + bonusPct);
  const potentialPayout = numericStake * effectiveMultiplier;
  const geometricMeanRtp = Math.pow(rtpProduct, 1 / folds);
  const trueExpectedRtp = rtpProduct * (1 + bonusPct);
  const expectedValueGhs = numericStake * (trueExpectedRtp - 1);

  return {
    folds,
    qualifyingCount,
    baseOdds: +baseOdds.toFixed(6),
    bonusPct: +bonusPct.toFixed(6),
    effectiveMultiplier: +effectiveMultiplier.toFixed(6),
    potentialPayout: +potentialPayout.toFixed(2),
    combinedWinProb: +combinedWinProb.toFixed(8),
    geometricMeanRtp: +geometricMeanRtp.toFixed(6),
    trueExpectedRtp: +trueExpectedRtp.toFixed(6),
    expectedValueGhs: +expectedValueGhs.toFixed(4),
    isPositiveEv: trueExpectedRtp > 1.0
  };
}

function breakEvenRtp(n, bonusPct) {
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  return +Math.pow(1 + Number(bonusPct || 0), -1 / n).toFixed(6);
}

function quarterKellyStake(trueExpectedRtp, effectiveMultiplier, bankroll, opts = {}) {
  const {
    kellyFraction = 0.25,
    minStake = 2.0,
    maxStake = 3.0,
    maxBankrollPct = 0.03
  } = opts;

  if (
    !Number.isFinite(trueExpectedRtp) ||
    !Number.isFinite(effectiveMultiplier) ||
    !Number.isFinite(bankroll) ||
    trueExpectedRtp <= 1.0 ||
    effectiveMultiplier <= 1.0 ||
    bankroll <= 0
  ) {
    return 0;
  }

  const fullKellyFraction = (trueExpectedRtp - 1) / (effectiveMultiplier - 1);
  const rawStake = kellyFraction * fullKellyFraction * bankroll;
  const effectiveMax = Math.min(maxStake, bankroll * maxBankrollPct);
  if (effectiveMax <= 0) return 0;

  if (effectiveMax < minStake) {
    return +Math.min(rawStake, effectiveMax).toFixed(2);
  }

  const bounded = Math.max(minStake, Math.min(effectiveMax, rawStake));
  return +bounded.toFixed(2);
}

module.exports = {
  FALLBACK_BONUS_PLAN_RAW,
  parseBonusPlan,
  getDefaultBonusPlan,
  getSportFactor,
  computeBonusPct,
  evaluateTicketMath,
  breakEvenRtp,
  quarterKellyStake
};
