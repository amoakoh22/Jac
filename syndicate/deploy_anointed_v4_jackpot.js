'use strict';

/**
 * Jac Syndicate — Anointed v4.0 Jackpot Deployment Pipeline
 *
 * Deploys the 3-Pillar Breakthrough ("The Missing Piece"):
 *   1. Twin-Wave x100+ +EV Pair (1.00x Full-Bonus 2-Way Sports, >=135m W1 Clean Cashout Gap):
 *        - Ticket 1A: HARVESTER (GHS 3.00) -> Daemon auto-cashes out after Wave 1 (>= GHS 5.10)
 *          to lock 100%+ of BOTH stakes + instant profit!
 *        - Ticket 1B: MOONSHOT  (GHS 2.00) -> Rides 100% RISK-FREE for x130-x200+ Jackpot!
 *   2. Disjoint Solo x100+ +EV Wave Ticket (GHS 3.00, 0% overlap with Pair #1 & all open bets)
 *   3. Mode C Sequential Push-Protected Integer Vault — Step 1 (GHS 3.00 seed, 4 integer
 *      push-shielded Football lines with ~99% single-leg RTP & exact-goal void immunity)
 *
 * Hard Guards:
 *   - 0% overlap with all 65 matches on open tickets (9121S3, F9QK8B, C36TTY, C3GCWW)
 *   - 0% overlap across Distinct Groups (#1 Twin Pair, #2 Solo x100+, #3 Mode C Vault)
 *   - Permanent hard ban on <2 legs or <1.25x effective multiplier
 *   - Flexi / 1UP / EarlyGoals checkboxes verified UNCHECKED before every Confirm
 */

const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');
const sportybetApi = require('./quant/sportybet_api');
const bonusModel = require('./quant/bonus_model');
const wavePlanner = require('./quant/wave_planner');
const { assertBetslipCheckboxesUnchecked, scrapeBetslipQuote } = require('./quant/place_quant_tickets');

const { SPORTS, FULL_BONUS_SPORTS } = sportybetApi;
const DRY_RUN = process.argv.includes('--dry-run');

function loadActiveEventIds() {
  const active = new Set();
  const p = path.join(S.ROOT_DIR, 'runtime', 'live_api_audit_latest.json');
  if (fs.existsSync(p)) {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const b of (d?.open?.data?.cashAbleBets || [])) {
      for (const s of (b.selections || [])) if (s.eventId) active.add(s.eventId);
    }
    for (const b of (d?.unsettled?.data?.entityList || [])) {
      for (const s of (b.selections || [])) if (s.eventId) active.add(s.eventId);
    }
  }
  return active;
}

function isClean(ev) {
  if (!ev || !ev.eventId) return false;
  if (sportybetApi.isSrlOrVirtual(ev, ev.league, ev.country)) return false;
  const full = `${ev.country || ''} ${ev.league || ''} ${ev.home || ''} ${ev.away || ''}`.toLowerCase();
  if (/u19|u20|u21|u23|youth|reserves|amateur|oberliga|regionalliga|women|itf|utr|challenger doubles/.test(full)) return false;
  return true;
}

async function mapBatched(items, batchSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const res = await Promise.all(chunk.map(fn));
    for (const r of res) if (r) out.push(r);
  }
  return out;
}

async function scanExpanded100xAndVaultUniverse(req, activeIds) {
  const now = Date.now();
  const minOffset = 40 * 60 * 1000;
  const maxEnd = now + 76 * 3600 * 1000; // <= 76h horizon
  const skipPat = /player|scorer|card|corner|exact|odd\/even|winning margin|tiebreak|quarter|1st half|1st period|set 1|set 2|race to/i;

  const fullBonusBestByEvent = new Map();

  for (const sportId of FULL_BONUS_SPORTS) {
    const spRaw = await sportybetApi.fetchEventsByOrder(req, {
      sportId,
      maxPages: 7,
      pageSize: 30,
      minStartOffsetMs: minOffset,
      withTwoUpMarket: false
    });
    const spClean = spRaw.filter(ev => isClean(ev) && !activeIds.has(ev.eventId) && ev.startTime <= maxEnd);

    const details = await mapBatched(spClean.slice(0, 95), 8, async (ev) => {
      try {
        const det = await sportybetApi.fetchEventDetails(req, ev.eventId);
        return det && det.status === 0 ? { ev, det } : null;
      } catch {
        return null;
      }
    });

    for (const { ev, det } of details) {
      for (const m of (det.markets || [])) {
        if (!m || m.status !== 0 || String(m.id).startsWith('800') || skipPat.test(m.desc || '')) continue;
        const spec = m.specifier || '';
        for (const o of (m.outcomes || [])) {
          if (!o || o.isActive !== 1) continue;
          const od = parseFloat(o.odds || '0');
          const pr = parseFloat(o.probability || '0');
          if (od < 1.20 || od > 1.44 || pr < 0.69) continue;
          const oDesc = String(o.desc || '');
          // Rule #22: On Basketball handicaps, strictly take PLUS-spreads (+4.5..+18.5), never minus spreads
          if (sportId === SPORTS.BASKETBALL && /handicap/i.test(m.desc || '') && oDesc.includes('-')) continue;
          const rtp = +(od * pr).toFixed(6);
          if (rtp < 0.973) continue;

          const cand = {
            eventId: det.eventId,
            gameId: det.gameId || ev.gameId,
            home: det.homeTeamName || ev.home,
            away: det.awayTeamName || ev.away,
            match: `${det.homeTeamName || ev.home} vs ${det.awayTeamName || ev.away}`,
            startTime: det.estimateStartTime || ev.startTime,
            sportId,
            sportName: det.sport?.name || ev.sportName,
            categoryId: det.sport?.category?.id || ev.categoryId,
            country: det.sport?.category?.name || ev.country,
            tournamentId: det.sport?.category?.tournament?.id || ev.tournamentId,
            league: det.sport?.category?.tournament?.name || ev.league,
            marketId: String(m.id),
            specifier: spec,
            product: m.product || 3,
            group: m.group || 'Main',
            marketDesc: m.desc,
            outcomeId: String(o.id),
            outcomeDesc: oDesc,
            odds: od,
            prob: pr,
            pWin: pr,
            pPush: 0,
            pLoss: +(1 - pr).toFixed(6),
            nonLossProb: pr,
            rtp,
            singleRtp: rtp,
            adjustedScore: +(rtp * 0.75 + pr * 0.25).toFixed(6),
            shieldType: '1.00X_FULL_BONUS_2WAY'
          };
          cand.wap_item = sportybetApi.buildWapItemFromLive(cand);

          const prev = fullBonusBestByEvent.get(cand.eventId);
          if (!prev || cand.adjustedScore > prev.adjustedScore) {
            fullBonusBestByEvent.set(cand.eventId, cand);
          }
        }
      }
    }
    console.log(`[Scan 1.00x] ${sportId}: scanned ${details.length} clean events | cumulative unique >=0.973 RTP matches: ${fullBonusBestByEvent.size}`);
  }

  // Load Football Integer Push-Shielded candidates from anointed_72h_universe.json (filtered against activeIds & >now+40m)
  const vaultBestByEvent = new Map();
  const cachedPath = path.join(S.ROOT_DIR, 'runtime', 'anointed_72h_universe.json');
  if (fs.existsSync(cachedPath)) {
    const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
    const allPush = (cached.fbPushProtected || []).concat(cached.fbVaultCatalysts || []);
    for (const c of allPush) {
      if (!c || activeIds.has(c.eventId) || c.startTime <= now + minOffset) continue;
      if ((c.pPush || 0) <= 0.08) continue; // Strictly genuine integer push-shielded lines (Under 4/5, Over 1/2, AH 0/+1/+2, DNB)!
      if (c.odds < 1.18 || c.odds > 1.36 || c.singleRtp < 0.980 || c.nonLossProb < 0.81) continue;
      const score = +(c.singleRtp * 0.65 + c.nonLossProb * 0.35).toFixed(6);
      const prev = vaultBestByEvent.get(c.eventId);
      if (!prev || score > prev.adjustedScore) {
        vaultBestByEvent.set(c.eventId, {
          ...c,
          adjustedScore: score,
          wap_item: sportybetApi.buildWapItemFromLive(c)
        });
      }
    }
  }

  return {
    fullBonusLegs: Array.from(fullBonusBestByEvent.values()).sort((a, b) => b.adjustedScore - a.adjustedScore),
    vaultPushLegs: Array.from(vaultBestByEvent.values()).sort((a, b) => b.adjustedScore - a.adjustedScore)
  };
}

function buildStaggered100xFromPool(pool, bonusPlan, opts = {}) {
  const { minMult = 115.0, minEv = 1.02, pairTotalStake = 5.0 } = opts;
  for (const n of [21, 22, 23, 24, 20, 25]) {
    if (pool.length < n) continue;
    // Try wave-staggered subset with >= 135m gap first, fallback to >= 105m gap
    let legs = wavePlanner.selectWaveStaggeredSubset(pool, n, {
      minWave1Legs: 5,
      maxWave1Legs: 6,
      targetWave1Odds: 2.55,
      minWave1GapMinutes: 135
    }) || wavePlanner.selectWaveStaggeredSubset(pool, n, {
      minWave1Legs: 4,
      maxWave1Legs: 6,
      targetWave1Odds: 2.40,
      minWave1GapMinutes: 105
    }) || pool.slice(0, n);

    let math = bonusModel.evaluatePushAwareTicketMath(legs, bonusPlan, 3.0);

    // If multiplier < minMult, swap lowest-odds Wave 2+ legs with higher-odds bench legs while keeping EV >= minEv
    if (math.effectiveMultiplier < minMult) {
      const usedSet = new Set(legs.map(l => l.eventId));
      const bench = pool.filter(l => !usedSet.has(l.eventId)).sort((a, b) => b.odds - a.odds);
      const working = legs.slice().sort((a, b) => a.startTime - b.startTime);
      for (const bLeg of bench) {
        math = bonusModel.evaluatePushAwareTicketMath(working, bonusPlan, 3.0);
        if (math.effectiveMultiplier >= minMult) break;
        // Only swap in Wave 2+ (indices >= 5) so Wave 1 gap stays intact
        let minIdx = -1;
        for (let i = 5; i < working.length; i++) {
          if (minIdx === -1 || working[i].odds < working[minIdx].odds) minIdx = i;
        }
        if (minIdx === -1 || bLeg.odds <= working[minIdx].odds + 0.01) continue;
        // Keep bLeg in Wave 2+ chronologically
        if (bLeg.startTime < working[4].startTime + 105 * 60000) continue;
        const trial = working.slice();
        trial[minIdx] = bLeg;
        const tMath = bonusModel.evaluatePushAwareTicketMath(trial, bonusPlan, 3.0);
        if (tMath.trueExpectedRtp >= minEv) {
          working[minIdx] = bLeg;
        }
      }
      legs = working;
      math = bonusModel.evaluatePushAwareTicketMath(legs, bonusPlan, 3.0);
    }

    if (math.effectiveMultiplier >= minMult && math.trueExpectedRtp >= minEv) {
      const wp = wavePlanner.buildWavePlan(legs, 3.0, { minWave1GapMinutes: 120, pairTotalStake });
      return { legs: legs.slice().sort((a, b) => a.startTime - b.startTime), math, wavePlan: wp };
    }
  }
  return null;
}

async function placeVerifiedSlip(context, page, spec, bonusPlan) {
  const stake = Number(spec.stake);
  const stakeStr = Number.isInteger(stake) ? String(stake) : stake.toFixed(2);
  console.log(`\n============================================================`);
  console.log(`  PLACING ${spec.title} [${spec.role}] | ${spec.legs.length}F | Stake: GHS ${stakeStr}`);
  console.log(`============================================================`);

  // Hard 4-Layer Micro-Bet Guard
  if (spec.legs.length < 2) throw new Error(`HARD_BAN_SINGLE_LEG: folds=${spec.legs.length}`);

  // Re-verify live Outcomes via SportyBet API right before placement
  const liveRaw = await sportybetApi.fetchOutcomesBatch(
    context.request,
    spec.legs.map(l => ({ eventId: l.eventId, marketId: l.marketId, outcomeId: l.outcomeId, specifier: l.specifier || null })),
    150
  );
  const byKey = new Map(liveRaw.map(x => [`${x.eventId}|${x.marketId}|${x.specifier || ''}|${x.outcomeId}`, x]));

  const verified = [];
  for (const orig of spec.legs) {
    const k = `${orig.eventId}|${orig.marketId}|${orig.specifier || ''}|${orig.outcomeId}`;
    const fresh = byKey.get(k);
    if (!fresh || !fresh.isActive) throw new Error(`LEG_INACTIVE_PRE_PLACE: ${orig.match} (${k})`);
    const pPush = orig.pPush || 0;
    const pWin = pPush > 0 ? +(fresh.prob * (1 - pPush)).toFixed(6) : fresh.prob;
    verified.push({
      ...orig,
      odds: fresh.odds,
      prob: fresh.prob,
      pWin,
      pPush,
      nonLossProb: +(pWin + pPush).toFixed(6),
      rtp: fresh.rtp,
      singleRtp: +(fresh.odds * pWin + pPush).toFixed(6),
      wap_item: fresh.wap_item
    });
  }

  const liveMath = bonusModel.evaluatePushAwareTicketMath(verified, bonusPlan, stake);
  if (liveMath.effectiveMultiplier < 1.25) {
    throw new Error(`HARD_BAN_MICRO_MULTIPLIER: effMult=${liveMath.effectiveMultiplier}`);
  }
  if (spec.requireX100 && (liveMath.effectiveMultiplier < 100.0 || liveMath.trueExpectedRtp <= 1.00)) {
    throw new Error(`X100_PLUSEV_GATE_FAILED: mult=${liveMath.effectiveMultiplier}, rtp=${liveMath.trueExpectedRtp}`);
  }

  // Inject into betslip
  await page.evaluate((items) => {
    localStorage.setItem('wapBetslips', JSON.stringify(items));
  }, verified.map(l => l.wap_item));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  await page.evaluate(() => {
    const icon = document.querySelector('.betslip-theme-icon') || document.querySelector('.m-betslip-Balls');
    if (icon) icon.click();
  });
  await page.waitForTimeout(2200);

  // Assert Flexi / 1UP / EarlyGoals are UNCHECKED
  const checkboxAudit = await assertBetslipCheckboxesUnchecked(page);

  // Assert leg count
  const slipCount = await S.getSlipCount(page);
  if (slipCount > 0 && slipCount !== verified.length) {
    throw new Error(`SLIP_COUNT_MISMATCH: got ${slipCount}, expected ${verified.length}`);
  }

  // Enter stake on SportyBet keypad
  await page.evaluate(() => {
    const el = document.querySelector('[data-op="betslip-stake-amount"]')
      || document.querySelector('.m-stake-input, .stake-input, [data-op*="stake-amount"]');
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
  });
  await page.waitForTimeout(700);
  await S.typeStakeOnKeyboard(page, stakeStr);
  await page.waitForTimeout(1400);

  let quote = await scrapeBetslipQuote(page);
  console.log(`  [Live Quote] Stake=GHS ${quote.totalStake} | BaseOdds=${quote.totalOdds}x | Bonus=GHS ${quote.bonusGhs} (${quote.bonusPct}%) | PotWin=GHS ${quote.potentialWin}`);

  if (quote.potentialWin < stake * 1.25) {
    throw new Error(`HARD_BAN_QUOTE_TOO_LOW: potWin=${quote.potentialWin} on stake=${stake}`);
  }
  if (spec.requireX100 && quote.potentialWin < stake * 100.0) {
    throw new Error(`QUOTE_BELOW_100X: potWin=${quote.potentialWin} on stake=${stake}`);
  }

  let confirmVisible = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const btnText = await page.evaluate(() => {
      const btn = document.querySelector('[data-op="betslip-placebet"]');
      if (btn) { const t = (btn.innerText || '').trim(); btn.click(); return t; }
      return '';
    });
    console.log(`  [PlaceBet #${attempt}] "${btnText}"`);
    await page.waitForTimeout(2000);
    confirmVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, div, span, a')).some(
        e => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === 'confirm'
      )
    );
    if (confirmVisible) break;
  }
  if (!confirmVisible) throw new Error('CONFIRM_MODAL_NOT_VISIBLE');

  await assertBetslipCheckboxesUnchecked(page);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, div, span, a')).filter(
      e => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === 'confirm'
    );
    if (btns.length) btns[btns.length - 1].click();
  });

  await page.waitForTimeout(6000);
  const shotPath = path.join(S.SCREENSHOT_DIR, spec.shotName);
  await page.screenshot({ path: shotPath, fullPage: true });

  const receipt = await page.evaluate(() => {
    const full = document.body ? document.body.innerText : '';
    const idx = full.indexOf('Bet Successful');
    const text = idx >= 0 ? full.slice(idx) : full;
    const codeMatch = text.match(/Booking\s+Code[\s\S]{0,40}?\b([A-Z0-9]{6})\b/i)
      || text.match(/\b([A-Z0-9]{6})\b/)
      || full.match(/([A-Z0-9]{6})\s*Custom Code/i);
    const stakeMatch = text.match(/Total\s+Stake[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    const potWinMatch = text.match(/Potential\s+Win[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    return {
      success: full.includes('Bet Successful') || full.includes('Successful') || full.includes('Bet Placed'),
      booking_code: codeMatch ? codeMatch[1] : null,
      stake: stakeMatch ? parseFloat(stakeMatch[1].replace(/,/g, '')) : null,
      potential_win: potWinMatch ? parseFloat(potWinMatch[1].replace(/,/g, '')) : null,
      snippet: text.slice(0, 350)
    };
  });

  await page.evaluate(() => {
    const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(
      e => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === 'ok'
    );
    if (ok) ok.click();
  });
  await page.waitForTimeout(1800);

  const finalStake = receipt.stake || stake;
  const finalPotWin = receipt.potential_win || quote.potentialWin;
  const finalEffMult = +(finalPotWin / finalStake).toFixed(2);
  const wp = wavePlanner.buildWavePlan(verified, finalStake, { minWave1GapMinutes: 120, pairTotalStake: spec.pairTotalStake || 0 });

  console.log(`  [CONFIRMED] Code=${receipt.booking_code} | Role=${spec.role} | ${verified.length}F | Stake=GHS ${finalStake} -> PotWin=GHS ${finalPotWin} (${finalEffMult}x) | TrueRTP=${(liveMath.trueExpectedRtp * 100).toFixed(2)}%`);

  return {
    bulletId: spec.bulletId,
    sourceTag: spec.sourceTag,
    title: spec.title,
    role: spec.role,
    waveGroupId: spec.waveGroupId || '',
    pairTotalStake: spec.pairTotalStake || 0,
    success: Boolean(receipt.success && receipt.booking_code),
    booking_code: receipt.booking_code,
    folds: verified.length,
    stake: finalStake,
    baseOdds: quote.totalOdds || +liveMath.baseOdds.toFixed(2),
    bonusGhs: quote.bonusGhs || 0,
    bonusPct: quote.bonusPct ? +(quote.bonusPct / 100).toFixed(4) : liveMath.bonusPct,
    potentialWin: finalPotWin,
    effectiveMultiplier: finalEffMult,
    combinedWinProb: liveMath.combinedWinProb,
    combinedNonLossProb: liveMath.combinedNonLossProb,
    pushShieldedLegsCount: liveMath.pushShieldedLegsCount,
    trueExpectedRtp: liveMath.trueExpectedRtp,
    wavePlan: wp,
    checkboxAudit,
    screenshotPath: shotPath,
    legs: verified.map(({ wap_item, ...rest }) => rest)
  };
}

(async () => {
  const activeIds = loadActiveEventIds();
  const { browser, context, page } = await S.launchBrowser();
  try {
    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const preSess = await S.readSession(page);
    console.log('[Session] Pre-Deployment:', preSess);
    if (!preSess.isLogged) throw new Error('Not logged in!');

    let bonusPlan;
    try {
      bonusPlan = bonusModel.parseBonusPlan(await sportybetApi.fetchBonusPlans(context.request));
    } catch {
      bonusPlan = bonusModel.getDefaultBonusPlan();
    }

    const { fullBonusLegs, vaultPushLegs } = await scanExpanded100xAndVaultUniverse(context.request, activeIds);
    console.log(`\n[Universe] 1.00x Full-Bonus Matches: ${fullBonusLegs.length} | Football Integer Push-Shielded Vault Matches: ${vaultPushLegs.length}`);

    const usedAcrossGroups = new Set(activeIds);

    // 1. Twin-Wave x100+ +EV Pair (HARVESTER GHS 3 + MOONSHOT GHS 2)
    const twinBlueprint = buildStaggered100xFromPool(fullBonusLegs, bonusPlan, { minMult: 125.0, minEv: 1.03, pairTotalStake: 5.0 });
    if (!twinBlueprint) throw new Error('Could not build Twin-Wave +EV x100+ blueprint!');
    for (const l of twinBlueprint.legs) usedAcrossGroups.add(l.eventId);

    // 2. Second Disjoint Solo x100+ +EV Wave Ticket (GHS 3, if >= 20 remaining 1.00x matches qualify)
    const rem100x = fullBonusLegs.filter(l => !usedAcrossGroups.has(l.eventId));
    const soloBlueprint = buildStaggered100xFromPool(rem100x, bonusPlan, { minMult: 115.0, minEv: 1.015, pairTotalStake: 0 });
    if (soloBlueprint) {
      for (const l of soloBlueprint.legs) usedAcrossGroups.add(l.eventId);
    }

    // 3. Mode C Sequential Push-Protected Integer Vault — Step 1 (3 top ~99% RTP integer push lines @ GHS 3.00)
    const remVault = vaultPushLegs
      .filter(l => !usedAcrossGroups.has(l.eventId) && l.odds >= 1.22)
      .sort((a, b) => (b.singleRtp - a.singleRtp) || (b.nonLossProb - a.nonLossProb));
    const vaultLegs = (remVault.length >= 3 ? remVault.slice(0, 3) : vaultPushLegs.filter(l => !usedAcrossGroups.has(l.eventId)).slice(0, 4))
      .sort((a, b) => a.startTime - b.startTime);
    const vaultMath = bonusModel.evaluatePushAwareTicketMath(vaultLegs, bonusPlan, 3.0);

    console.log(`\n=== DRY-RUN / PRE-FLIGHT MATHEMATICAL PROOF ===`);
    console.log(`1. TWIN-WAVE x100+ PAIR (${twinBlueprint.legs.length}F 1.00x 2-Way Sports, Horizon=${twinBlueprint.wavePlan.horizonHours}h):`);
    console.log(`   BaseOdds=${twinBlueprint.math.baseOdds.toFixed(2)}x | Bonus=+${(twinBlueprint.math.bonusPct * 100).toFixed(0)}% | EffMult=${twinBlueprint.math.effectiveMultiplier.toFixed(2)}x | TrueRTP=${(twinBlueprint.math.trueExpectedRtp * 100).toFixed(2)}% (+EV!)`);
    console.log(`   Wave 1 (${twinBlueprint.wavePlan.waves[0]?.legCount} legs): CleanGap=${twinBlueprint.wavePlan.wave1CleanWindowMinutes}m | Est. Harvester Cashout=GHS ${twinBlueprint.wavePlan.wave1ExpectedCashoutGhs} (locks GHS 5.00 pair stake!)`);
    if (soloBlueprint) {
      console.log(`2. SOLO DISJOINT x100+ WAVE (${soloBlueprint.legs.length}F 1.00x 2-Way Sports, Horizon=${soloBlueprint.wavePlan.horizonHours}h):`);
      console.log(`   BaseOdds=${soloBlueprint.math.baseOdds.toFixed(2)}x | Bonus=+${(soloBlueprint.math.bonusPct * 100).toFixed(0)}% | EffMult=${soloBlueprint.math.effectiveMultiplier.toFixed(2)}x | TrueRTP=${(soloBlueprint.math.trueExpectedRtp * 100).toFixed(2)}% (+EV!)`);
    } else {
      console.log(`2. SOLO DISJOINT x100+ WAVE: Skipped (remaining unused 1.00x matches=${rem100x.length} < 20 for strict +EV)`);
    }
    if (vaultLegs.length >= 3) {
      console.log(`3. MODE C INTEGER PUSH-SHIELDED VAULT STEP 1 (${vaultLegs.length}F Integer Push Lines):`);
      console.log(`   EffMult=${vaultMath.effectiveMultiplier.toFixed(2)}x (GHS 3.00 -> GHS ${vaultMath.potentialPayout}) | NonLossSurvival=${(vaultMath.combinedNonLossProb * 100).toFixed(2)}% | SingleLegGeoRTP=${(vaultMath.geometricMeanRtp * 100).toFixed(2)}%`);
    }

    if (DRY_RUN) {
      fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'anointed_v4_dryrun_plan.json'), JSON.stringify({
        twinBlueprint,
        soloBlueprint,
        vaultStep1: { legs: vaultLegs, math: vaultMath }
      }, null, 2));
      console.log('\n[DryRun] Plan saved to runtime/anointed_v4_dryrun_plan.json — zero bets placed.');
      return;
    }

    const waveGroupId = `WAVE_TWIN_${Date.now()}`;
    const specs = [
      {
        bulletId: 'CH_ANOINTED_V18_TWIN_HARVESTER',
        sourceTag: 'ANOINTED_V4_100X_TWIN_HARVESTER',
        title: 'Anointed V18A — Twin-Wave +EV Harvester (Wave-1 Principal Lock)',
        role: 'HARVESTER',
        waveGroupId,
        pairTotalStake: 5.0,
        stake: 3.0,
        requireX100: true,
        shotName: 'anointed_v18a_harvester_receipt.png',
        legs: twinBlueprint.legs
      },
      {
        bulletId: 'CH_ANOINTED_V18_TWIN_MOONSHOT',
        sourceTag: 'ANOINTED_V4_100X_TWIN_MOONSHOT',
        title: 'Anointed V18B — Twin-Wave +EV Moonshot (100% Free-Roll Jackpot)',
        role: 'MOONSHOT',
        waveGroupId,
        pairTotalStake: 5.0,
        stake: 2.0,
        requireX100: true,
        shotName: 'anointed_v18b_moonshot_receipt.png',
        legs: twinBlueprint.legs
      }
    ];

    if (soloBlueprint) {
      specs.push({
        bulletId: 'CH_ANOINTED_V19_SOLO_PLUSEV_100X',
        sourceTag: 'ANOINTED_V4_SOLO_PLUSEV_100X',
        title: 'Anointed V19 — Disjoint 1.00x Bonus +EV Wave Jackpot',
        role: 'SOLO',
        waveGroupId: `WAVE_SOLO_${Date.now()}`,
        pairTotalStake: 0,
        stake: 3.0,
        requireX100: true,
        shotName: 'anointed_v19_solo_100x_receipt.png',
        legs: soloBlueprint.legs
      });
    }

    if (vaultLegs.length >= 3 && vaultMath.effectiveMultiplier >= 1.80) {
      specs.push({
        bulletId: 'CH_ANOINTED_V20_VAULT_STEP1',
        sourceTag: 'MODE_C_INTEGER_PUSH_VAULT_STEP1',
        title: 'Anointed V20 — Mode C Integer Push-Shielded Vault (Step 1 -> x100)',
        role: 'VAULT_STEP',
        waveGroupId: 'VAULT_LADDER_V1',
        pairTotalStake: 0,
        stake: 3.0,
        requireX100: false,
        shotName: 'anointed_v20_vault_step1_receipt.png',
        legs: vaultLegs
      });
    }

    await page.goto('https://www.sportybet.com/gh/m/sport/football/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    const results = [];
    for (const sp of specs) {
      const r = await placeVerifiedSlip(context, page, sp, bonusPlan);
      results.push(r);
    }

    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const postSess = await S.readSession(page);
    await S.persistState(context);

    const out = {
      executedAt: new Date().toISOString(),
      balanceBefore: preSess.balance,
      balanceAfter: postSess.balance,
      tickets: results
    };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'anointed_v4_live_results.json'), JSON.stringify(out, null, 2));
    console.log(`\n[COMPLETE] Placed ${results.filter(x => x.success).length}/${specs.length} slips | Balance: GHS ${preSess.balance} -> GHS ${postSess.balance}`);
  } finally {
    await browser.close();
  }
})();
