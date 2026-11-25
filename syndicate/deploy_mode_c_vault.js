'use strict';

/**
 * Jac Syndicate — Mode C Integer Push Vault Standalone Deployer (Step 2+)
 * Reproduces the ELVXWA winning formula:
 *   - 3F Tier-1 Football Integer Push-Shielded lines (Under 4.0 / 5.0, Over 1.0 / 2.0, AH 0/+1/+2, DNB)
 *   - Strict pPush >= 0.08, singleRtp >= 0.980 (min_betradar_rtp), nonLossProb >= 0.81
 *   - Leg odds [1.18, 1.36], effective multiplier >= 1.75x (strictly no @1.01 rule_30)
 *   - 0% overlap with all open tickets (live_api_audit_latest.json)
 *   - Flexi / 1UP / EarlyGoals verified UNCHECKED before Confirm
 *
 * Usage:
 *   node syndicate/deploy_mode_c_vault.js --step=2 --stake=2.90 --dry-run
 *   node syndicate/deploy_mode_c_vault.js --step=2 --stake=2.90 --live
 */
const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');
const sportybetApi = require('./quant/sportybet_api');
const bonusModel = require('./quant/bonus_model');
const wavePlanner = require('./quant/wave_planner');
const { assertBetslipCheckboxesUnchecked, scrapeBetslipQuote } = require('./quant/place_quant_tickets');

function getArg(name, fallback) {
  const pref = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

const LIVE = process.argv.includes('--live');
const STEP = parseInt(getArg('step', '2'), 10);
const STAKE = parseFloat(getArg('stake', '2.90'));
const LEGS_COUNT = parseInt(getArg('legs', '3'), 10);

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

function selectModeCVaultLegs(activeIds) {
  const cachedPath = path.join(S.ROOT_DIR, 'runtime', 'anointed_72h_universe.json');
  if (!fs.existsSync(cachedPath)) {
    throw new Error('Missing runtime/anointed_72h_universe.json — run node syndicate/probe_anointed_universe.js first.');
  }
  const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
  const now = Date.now();
  const minOffset = 40 * 60 * 1000;
  const allPush = (cached.fbPushProtected || []).concat(cached.fbVaultCatalysts || []);

  const bestByEvent = new Map();
  for (const c of allPush) {
    if (!c || activeIds.has(c.eventId) || c.startTime <= now + minOffset) continue;
    if ((c.pPush || 0) < 0.08) continue;
    if (c.odds < 1.18 || c.odds > 1.36 || c.singleRtp < 0.980 || c.nonLossProb < 0.81) continue;
    const score = +(c.singleRtp * 0.65 + c.nonLossProb * 0.35).toFixed(6);
    const prev = bestByEvent.get(c.eventId);
    if (!prev || score > prev.adjustedScore) {
      bestByEvent.set(c.eventId, {
        ...c,
        adjustedScore: score,
        wap_item: sportybetApi.buildWapItemFromLive(c)
      });
    }
  }

  const ranked = Array.from(bestByEvent.values()).sort(
    (a, b) => (b.singleRtp - a.singleRtp) || (b.nonLossProb - a.nonLossProb)
  );
  // Prefer odds >= 1.22 first (like ELVXWA: 1.23, 1.27, 1.23) so 3F hits >= 1.80x
  const sweet = ranked.filter(l => l.odds >= 1.22);
  const chosen = (sweet.length >= LEGS_COUNT ? sweet.slice(0, LEGS_COUNT) : ranked.slice(0, LEGS_COUNT))
    .sort((a, b) => a.startTime - b.startTime);

  return { chosen, totalQualified: ranked.length, sweetCount: sweet.length };
}

(async () => {
  const activeIds = loadActiveEventIds();
  const { chosen, totalQualified, sweetCount } = selectModeCVaultLegs(activeIds);

  if (chosen.length < LEGS_COUNT) {
    throw new Error(`INSUFFICIENT_MODE_C_CANDIDATES: found ${chosen.length}, need ${LEGS_COUNT}`);
  }

  const { browser, context, page } = await S.launchBrowser();
  try {
    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    const preSess = await S.readSession(page);
    if (!preSess.isLogged) throw new Error('SESSION_NOT_LOGGED_IN');

    let bonusPlan;
    try {
      bonusPlan = bonusModel.parseBonusPlan(await sportybetApi.fetchBonusPlans(context.request));
    } catch (_) {
      bonusPlan = bonusModel.getDefaultBonusPlan();
    }

    // Re-verify exact live odds & active status before math / placement
    const queries = chosen.map(l => ({
      eventId: l.eventId,
      marketId: l.marketId,
      specifier: l.specifier || null,
      outcomeId: l.outcomeId
    }));
    const freshList = await sportybetApi.fetchOutcomesBatch(context.request, queries, 150);
    const byKey = new Map();
    for (const f of freshList) {
      byKey.set(`${f.eventId}|${f.marketId}|${f.specifier || ''}|${f.outcomeId}`, f);
    }

    const verified = [];
    for (const orig of chosen) {
      const k = `${orig.eventId}|${orig.marketId}|${orig.specifier || ''}|${orig.outcomeId}`;
      const fresh = byKey.get(k);
      if (!fresh || !fresh.isActive) throw new Error(`LEG_INACTIVE: ${orig.match} (${k})`);
      const pPush = orig.pPush || 0;
      const pWin = +(fresh.prob * (1 - pPush)).toFixed(6);
      const singleRtp = +(fresh.odds * pWin + pPush).toFixed(6);
      if (singleRtp < 0.980) throw new Error(`RTP_BELOW_0.98: ${orig.match} singleRtp=${singleRtp}`);
      verified.push({
        ...orig,
        odds: fresh.odds,
        prob: fresh.prob,
        pWin,
        pPush,
        nonLossProb: +(pWin + pPush).toFixed(6),
        rtp: fresh.rtp,
        singleRtp,
        wap_item: fresh.wap_item
      });
    }

    const math = bonusModel.evaluatePushAwareTicketMath(verified, bonusPlan, STAKE);
    console.log(`\n=== MODE C INTEGER PUSH VAULT — STEP ${STEP} (${LIVE ? 'LIVE' : 'DRY-RUN'}) ===`);
    console.log(`Wallet Balance: GHS ${preSess.balance.toFixed(2)} | Qualified Pool: ${totalQualified} (Sweet >=1.22: ${sweetCount}) | Excluded Open Fixtures: ${activeIds.size}`);
    console.log(`Stake: GHS ${STAKE.toFixed(2)} | BaseOdds: ${math.baseOdds.toFixed(2)}x | Bonus: +${(math.bonusPct * 100).toFixed(0)}% | EffMult: ${math.effectiveMultiplier.toFixed(2)}x | PotWin: GHS ${math.potentialPayout}`);
    console.log(`NonLossSurvival: ${(math.combinedNonLossProb * 100).toFixed(2)}% | GeoSingleRTP: ${(math.geometricMeanRtp * 100).toFixed(2)}% | TrueTicketRTP: ${(math.trueExpectedRtp * 100).toFixed(2)}%`);
    for (const l of verified) {
      const ko = new Date(l.startTime).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  - [${ko} UTC] ${l.match} (${l.league}) | ${l.marketDesc}: ${l.outcomeDesc} @ ${l.odds.toFixed(2)} | NonLoss ${(l.nonLossProb * 100).toFixed(1)}% | Push ${(l.pPush * 100).toFixed(0)}% | RTP ${(l.singleRtp * 100).toFixed(2)}%`);
    }

    if (math.effectiveMultiplier < 1.75) {
      throw new Error(`MULTIPLIER_TOO_LOW: effMult=${math.effectiveMultiplier} < 1.75`);
    }

    if (!LIVE) {
      fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'mode_c_vault_dryrun.json'), JSON.stringify({
        step: STEP, stake: STAKE, math, legs: verified
      }, null, 2));
      console.log('\n[DryRun] Saved to runtime/mode_c_vault_dryrun.json — zero bets placed.');
      return;
    }

    // LIVE PLACEMENT
    await page.goto('https://www.sportybet.com/gh/m/sport/football/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

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

    await assertBetslipCheckboxesUnchecked(page);
    const slipCount = await S.getSlipCount(page);
    if (slipCount > 0 && slipCount !== verified.length) {
      throw new Error(`SLIP_COUNT_MISMATCH: got ${slipCount}, expected ${verified.length}`);
    }

    await page.evaluate(() => {
      const el = document.querySelector('[data-op="betslip-stake-amount"]')
        || document.querySelector('.m-stake-input, .stake-input, [data-op*="stake-amount"]');
      if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
    });
    await page.waitForTimeout(700);
    await S.typeStakeOnKeyboard(page, STAKE.toFixed(2));
    await page.waitForTimeout(1400);

    const quote = await scrapeBetslipQuote(page);
    console.log(`[Live Quote] Stake=GHS ${quote.totalStake} | BaseOdds=${quote.totalOdds}x | Bonus=GHS ${quote.bonusGhs} (${quote.bonusPct}%) | PotWin=GHS ${quote.potentialWin}`);
    if (quote.potentialWin < STAKE * 1.70) {
      throw new Error(`LIVE_QUOTE_TOO_LOW: potWin=${quote.potentialWin}`);
    }

    let confirmVisible = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const btnText = await page.evaluate(() => {
        const btn = document.querySelector('[data-op="betslip-placebet"]');
        if (btn) { const t = (btn.innerText || '').trim(); btn.click(); return t; }
        return '';
      });
      console.log(`[PlaceBet #${attempt}] "${btnText}"`);
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
    const shotName = `mode_c_vault_step${STEP}_receipt.png`;
    const shotPath = path.join(S.SCREENSHOT_DIR, shotName);
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

    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const postSess = await S.readSession(page);
    await S.persistState(context);

    const finalStake = receipt.stake || STAKE;
    const finalPotWin = receipt.potential_win || quote.potentialWin;
    const finalEffMult = +(finalPotWin / finalStake).toFixed(2);
    const wp = wavePlanner.buildWavePlan(verified, finalStake, { minWave1GapMinutes: 120, pairTotalStake: 0 });
    const bulletId = `CH_ANOINTED_V${19 + STEP}_VAULT_STEP${STEP}`;

    const out = {
      executedAt: new Date().toISOString(),
      balanceBefore: preSess.balance,
      balanceAfter: postSess.balance,
      tickets: [{
        bulletId,
        sourceTag: `MODE_C_INTEGER_PUSH_VAULT_STEP${STEP}`,
        title: `Anointed Mode C Integer Push Vault — Step ${STEP} (House-Money Ratchet)`,
        role: 'VAULT_STEP',
        waveGroupId: 'VAULT_LADDER_V1',
        pairTotalStake: 0,
        success: Boolean(receipt.success && receipt.booking_code),
        booking_code: receipt.booking_code,
        folds: verified.length,
        stake: finalStake,
        baseOdds: quote.totalOdds || +math.baseOdds.toFixed(2),
        bonusPct: quote.bonusPct || Math.round(math.bonusPct * 100),
        potentialWin: finalPotWin,
        effectiveMultiplier: finalEffMult,
        trueExpectedRtp: math.trueExpectedRtp,
        wavePlan: wp,
        screenshotPath: shotPath,
        legs: verified
      }]
    };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'anointed_v4_live_results.json'), JSON.stringify(out, null, 2));
    console.log(`\n[CONFIRMED] Code=${receipt.booking_code} | Step ${STEP} | ${verified.length}F | Stake=GHS ${finalStake} -> PotWin=GHS ${finalPotWin} (${finalEffMult}x) | Balance: GHS ${preSess.balance} -> GHS ${postSess.balance}`);
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error('[FATAL]', e.message || e);
  process.exit(1);
});
