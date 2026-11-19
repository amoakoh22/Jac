const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

function buildWapItemFromLive(ev, m, o) {
  const spec = m.specifier || '';
  const mIdStr = String(m.id);
  const fullMId = spec ? `${mIdStr}?${spec}` : mIdStr;
  const oIdStr = String(o.id);
  const tournId = ev.sport?.category?.tournament?.id || 'sr:tournament:1';
  return {
    away: ev.awayTeamName,
    categoryId: ev.sport?.category?.id || 'sr:category:1',
    categoryName: ev.sport?.category?.name || 'International',
    eventId: ev.eventId,
    estimateStartTime: ev.estimateStartTime,
    gameId: ev.gameId || '10000',
    home: ev.homeTeamName,
    sportId: ev.sport?.id || 'sr:sport:1',
    sportName: ev.sport?.name || 'Football',
    key: `${ev.sport?.id || 'sr:sport:1'}_${ev.eventId}_${fullMId}_${oIdStr}`,
    tournamentId: tournId,
    tournamentName: ev.sport?.category?.tournament?.name || '',
    isFinish: false,
    isInterrupted: false,
    topic: `1^1^${tournId}^${ev.eventId}^~^${mIdStr}^${spec || '~'}`,
    marketInfo: {
      id: fullMId,
      marketId: mIdStr,
      specifier: spec || undefined,
      product: m.product || 3,
      desc: m.desc,
      status: 0,
      group: m.group || 'Main',
      outcomes: [{
        id: oIdStr,
        odds: String(o.odds),
        probability: String(o.probability || '0.80'),
        voidProbability: '0E-10',
        isActive: 1,
        desc: o.desc,
        statusDesc: '',
        showOdds: true
      }],
      banned: false
    },
    outcomeInfo: {
      id: oIdStr,
      odds: String(o.odds),
      probability: String(o.probability || '0.80'),
      voidProbability: '0E-10',
      isActive: 1,
      desc: o.desc,
      statusDesc: '',
      showOdds: true
    },
    icon: 'm-icon-football',
    simInvalid: null,
    pushTime: Date.now()
  };
}

(async () => {
  const candidates = JSON.parse(
    fs.readFileSync(path.join(S.ROOT_DIR, 'runtime/top45_max_rtp_candidates.json'), 'utf8')
  );
  const { browser, context, page } = await S.launchBrowser();
  const liveOutcomesMap = new Map();

  page.on('response', async (res) => {
    if (res.url().includes('/api/gh/factsCenter/Outcomes')) {
      try {
        const j = await res.json();
        if (Array.isArray(j?.data)) {
          for (const ev of j.data) {
            if (ev?.eventId) liveOutcomesMap.set(ev.eventId, ev);
          }
        }
      } catch {}
    }
  });

  try {
    await page.goto('https://www.sportybet.com/gh/m/sport/football/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2500);

    // Hydrate all 45 candidates to pull live SportyBet odds & Betradar probabilities
    await page.evaluate((items) => {
      localStorage.setItem('wapBetslips', JSON.stringify(items));
    }, candidates.map(c => c.wap_item));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Filter strictly for LIVE active selections with odds >= 1.20 (100% Multi-Bet Win Bonus qualifying!)
    const verifiedPool = [];
    for (const cand of candidates) {
      const ev = liveOutcomesMap.get(cand.eventId);
      if (!ev || !ev.markets || !ev.markets.length) continue;
      const m = ev.markets[0];
      const o = (m.outcomes || [])[0];
      if (!o || o.isActive !== 1) continue;
      const liveOdds = parseFloat(o.odds || '0');
      const liveProb = parseFloat(o.probability || String(cand.prob));
      if (liveOdds >= 1.20 && liveOdds <= 1.38 && liveProb >= 0.70) {
        const liveRtp = liveOdds * liveProb;
        verifiedPool.push({
          ...cand,
          odds: liveOdds,
          prob: liveProb,
          rtp: liveRtp,
          market: m.desc || cand.market,
          outcome: o.desc || cand.outcome,
          startTime: ev.estimateStartTime || cand.startTime,
          league: `${ev.sport?.category?.name || ''} - ${ev.sport?.category?.tournament?.name || ''}`,
          wap_item: buildWapItemFromLive(ev, m, o)
        });
      }
    }

    verifiedPool.sort((a, b) => (b.rtp * 130 + b.prob * 25) - (a.rtp * 130 + a.prob * 25));
    console.log(`Live verified qualifying (>=1.20) zero-vig pool: ${verifiedPool.length} legs`);

    // Probe minimum N legs whose live Potential Win for GHS 2.00 is >= GHS 4,000.00 (2,000x!)
    let chosenN = null;
    let chosenQuote = null;
    for (const n of [30, 32, 34, 35, 36, 37, 38, 39, 40]) {
      if (n > verifiedPool.length) break;
      const slice = verifiedPool.slice(0, n);
      await page.evaluate((items) => {
        localStorage.setItem('wapBetslips', JSON.stringify(items));
      }, slice.map(x => x.wap_item));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3200);

      await page.evaluate(() => {
        const icon = document.querySelector('.betslip-theme-icon') || document.querySelector('.m-betslip-Balls');
        if (icon) icon.click();
      });
      await page.waitForTimeout(2000);

      await page.evaluate(() => {
        const el = document.querySelector('[data-op="betslip-stake-amount"]');
        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
      });
      await page.waitForTimeout(600);
      await S.typeStakeOnKeyboard(page, '2');
      await page.waitForTimeout(1000);

      const quote = await page.evaluate(() => {
        const txt = document.body ? document.body.innerText : '';
        const pot = txt.match(/Potential\s+Win[^\d]*([0-9,]+\.[0-9]{2})/i);
        const odds = txt.match(/Total\s+Odds[^\d]*([0-9,]+\.[0-9]{2})/i);
        const bonus = txt.match(/(?:Max\s+)?Bonus[^\d]*([0-9,]+\.[0-9]{2})/i);
        const bonusPct = txt.match(/([0-9]+)%\s*(?:Max\s*)?Bonus/i);
        return {
          potentialWin: pot ? parseFloat(pot[1].replace(/,/g, '')) : 0,
          totalOdds: odds ? parseFloat(odds[1].replace(/,/g, '')) : 0,
          bonusGhs: bonus ? parseFloat(bonus[1].replace(/,/g, '')) : 0,
          bonusPct: bonusPct ? parseInt(bonusPct[1], 10) : 0
        };
      });
      console.log(`Probe N=${n}: TotalOdds=${quote.totalOdds} | Bonus=${quote.bonusGhs} (${quote.bonusPct}%) | PotentialWin=GHS ${quote.potentialWin}`);
      if (quote.potentialWin >= 4000.0) {
        chosenN = n;
        chosenQuote = quote;
        break;
      }
    }

    if (!chosenN) {
      chosenN = Math.min(verifiedPool.length, 40);
      console.log(`Using max verified qualifying N=${chosenN}`);
    }

    const finalLegs = verifiedPool.slice(0, chosenN);
    // The betslip is already open with chosenN legs and stake = 2! Place bet immediately!
    for (let attempt = 0; attempt < 3; attempt++) {
      const btnText = await page.evaluate(() => {
        const btn = document.querySelector('[data-op="betslip-placebet"]');
        if (btn) { const t = (btn.innerText || '').trim(); btn.click(); return t; }
        return '';
      });
      console.log(`Clicked placebet button (attempt ${attempt + 1}): "${btnText}"`);
      await page.waitForTimeout(1800);
      const hasConfirm = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, div, span, a')).some(
          e => (e.innerText || '').trim().toLowerCase() === 'confirm'
        )
      );
      if (hasConfirm) break;
    }

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div, span, a')).filter(
        e => (e.innerText || '').trim().toLowerCase() === 'confirm'
      );
      if (btns.length) btns[btns.length - 1].click();
    });

    await page.waitForTimeout(5500);
    const shotPath = path.join(S.SCREENSHOT_DIR, 'codehub_2000x_bonus_arb_receipt.png');
    await page.screenshot({ path: shotPath });

    const res = await page.evaluate(() => {
      const full = document.body ? document.body.innerText : '';
      const idx = full.indexOf('Bet Successful');
      const text = idx >= 0 ? full.slice(idx) : full;
      const code = text.match(/\b([A-Z0-9]{6})\b/) || full.match(/([A-Z0-9]{6})\s*Custom Code/i);
      const stake = text.match(/Total Stake[\s\S]*?([0-9,]+\.[0-9]{2})/i);
      const potWin = text.match(/Potential Win[\s\S]*?([0-9,]+\.[0-9]{2})/i);
      return {
        success: full.includes('Bet Successful') || full.includes('Successful') || full.includes('Bet Placed'),
        code: code ? code[1] : null,
        stake: stake ? stake[1].replace(/,/g, '') : null,
        potentialWin: potWin ? potWin[1].replace(/,/g, '') : null,
        snippet: text.slice(0, 400)
      };
    });

    const baseProd = finalLegs.reduce((acc, x) => acc * x.odds, 1.0);
    const avgProb = finalLegs.reduce((acc, x) => acc + x.prob, 0) / finalLegs.length;
    const avgRtp = finalLegs.reduce((acc, x) => acc + x.rtp, 0) / finalLegs.length;
    const combinedProb = finalLegs.reduce((acc, x) => acc * x.prob, 1.0);

    const out = {
      ...res,
      folds: finalLegs.length,
      baseOdds: parseFloat(baseProd.toFixed(2)),
      chosenQuote,
      avgProbPct: parseFloat((avgProb * 100).toFixed(2)),
      avgRtpPct: parseFloat((avgRtp * 100).toFixed(2)),
      combinedWinProbPct: parseFloat((combinedProb * 100).toFixed(5)),
      screenshotPath: shotPath,
      legs: finalLegs.map(({ wap_item, ...rest }) => rest)
    };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/monster_v6_2000x_result.json'), JSON.stringify(out, null, 2));
    console.log('\n=== FINAL 2,000x BONUS-ARB MONSTER RESULT ===\n', JSON.stringify({ ...out, legs: `[${out.legs.length} legs]` }, null, 2));
    await S.persistState(context);
  } finally {
    await browser.close();
  }
})();
