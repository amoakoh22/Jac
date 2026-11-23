const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

const HEADERS = {
  'accept': '*/*',
  'accept-language': 'en',
  'clientid': 'wap',
  'content-type': 'application/json;charset=UTF-8',
  'operid': '3',
  'platform': 'wap',
  'referer': 'https://www.sportybet.com/gh/m/sport/football/?sort=0',
  'sourcescenario': 'Betslip-View-Model-Fetch-Outcome-Data:open',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
};

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

async function placeOneTicket(context, page, cfg, pool) {
  console.log(`\n======================================================`);
  console.log(`  PLACING ${cfg.title} | Stake: GHS ${cfg.stakeStr} | Min Target Win: GHS ${cfg.minPotWin}`);
  console.log(`======================================================`);

  const qPayload = pool.map(c => ({
    eventId: c.eventId,
    marketId: String(c.marketId),
    outcomeId: String(c.outcomeId),
    specifier: c.specifier ? c.specifier : null
  }));
  const resApi = await context.request.post('https://www.sportybet.com/api/gh/factsCenter/Outcomes', {
    headers: HEADERS,
    data: qPayload
  });
  const jApi = await resApi.json();
  const liveMap = new Map();
  for (const ev of (jApi?.data || [])) {
    if (ev?.eventId && ev.status === 0) liveMap.set(ev.eventId, ev);
  }

  const verified = [];
  const seen = new Set();
  for (const c of pool) {
    if (seen.has(c.eventId)) continue;
    const ev = liveMap.get(c.eventId);
    if (!ev || !ev.markets) continue;
    const m = ev.markets.find(mk => String(mk.id) === String(c.marketId) && mk.status === 0);
    if (!m) continue;
    const o = (m.outcomes || []).find(oc => String(oc.id) === String(c.outcomeId) && oc.isActive === 1);
    if (!o) continue;
    const od = parseFloat(o.odds || '0');
    const p = parseFloat(o.probability || String(c.prob));
    if (od >= 1.20 && od <= 1.42 && p >= 0.72) {
      seen.add(c.eventId);
      verified.push({
        eventId: ev.eventId,
        gameId: ev.gameId,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        startTime: ev.estimateStartTime,
        country: ev.sport?.category?.name || c.country,
        league: ev.sport?.category?.tournament?.name || c.league,
        marketId: String(m.id),
        specifier: m.specifier || '',
        marketDesc: m.desc,
        outcomeId: String(o.id),
        outcomeDesc: o.desc,
        label: c.label,
        odds: od,
        prob: p,
        rtp: +(od * p).toFixed(6),
        wap_item: buildWapItemFromLive(ev, m, o)
      });
    }
  }
  console.log(`Live verified qualifying (>=1.20) legs in pool ${cfg.key}: ${verified.length}`);
  if (verified.length < 18) {
    throw new Error(`Insufficient verified legs in pool ${cfg.key}: ${verified.length}`);
  }

  let chosenN = null;
  let chosenQuote = null;
  for (const n of cfg.probeNs) {
    if (n > verified.length) break;
    const slice = verified.slice(0, n);
    await page.evaluate((items) => {
      localStorage.setItem('wapBetslips', JSON.stringify(items));
    }, slice.map(x => x.wap_item));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

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
    await S.typeStakeOnKeyboard(page, cfg.stakeStr);
    await page.waitForTimeout(1200);

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
    console.log(`  Probe N=${n}: BaseOdds=${quote.totalOdds}x | Bonus=GHS ${quote.bonusGhs} | PotentialWin=GHS ${quote.potentialWin}`);
    chosenN = n;
    chosenQuote = quote;
    if (quote.potentialWin >= cfg.minPotWin) break;
  }

  const finalLegs = verified.slice(0, chosenN);

  for (let attempt = 0; attempt < 4; attempt++) {
    const btnText = await page.evaluate(() => {
      const btn = document.querySelector('[data-op="betslip-placebet"]');
      if (btn) { const t = (btn.innerText || '').trim(); btn.click(); return t; }
      return '';
    });
    console.log(`  Clicked placebet (attempt ${attempt + 1}): "${btnText}"`);
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
  const shotPath = path.join(S.SCREENSHOT_DIR, cfg.shotName);
  await page.screenshot({ path: shotPath });

  const receipt = await page.evaluate(() => {
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
      snippet: text.slice(0, 350)
    };
  });

  await page.evaluate(() => {
    const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(
      e => (e.innerText || '').trim().toLowerCase() === 'ok'
    );
    if (ok) ok.click();
  });
  await page.waitForTimeout(1800);

  const baseProd = finalLegs.reduce((a, x) => a * x.odds, 1.0);
  const avgProb = finalLegs.reduce((a, x) => a + x.prob, 0) / finalLegs.length;
  const avgRtp = finalLegs.reduce((a, x) => a + x.rtp, 0) / finalLegs.length;
  const combProb = finalLegs.reduce((a, x) => a * x.prob, 1.0);
  const effMult = (parseFloat(receipt.potentialWin || chosenQuote?.potentialWin || 0)) / parseFloat(cfg.stakeStr);

  const result = {
    key: cfg.key,
    bulletId: cfg.bulletId,
    sourceTag: cfg.sourceTag,
    title: cfg.title,
    ...receipt,
    folds: finalLegs.length,
    baseOdds: +baseProd.toFixed(2),
    effectiveMultiplier: +effMult.toFixed(2),
    chosenQuote,
    avgProbPct: +(avgProb * 100).toFixed(2),
    avgRtpPct: +(avgRtp * 100).toFixed(2),
    combinedWinProbPct: +(combProb * 100).toFixed(4),
    trueExpectedRtpPct: +(combProb * effMult * 100).toFixed(2),
    screenshotPath: shotPath,
    legs: finalLegs.map(({ wap_item, ...rest }) => rest)
  };
  console.log(`  RESULT [${cfg.key}]: success=${result.success} | Code=${result.code} | ${result.folds}F | Stake=GHS ${result.stake} | PotWin=GHS ${result.potentialWin} (${result.effectiveMultiplier}x) | TrueProb=${result.combinedWinProbPct}% | TrueRTP=${result.trueExpectedRtpPct}%`);
  return result;
}

(async () => {
  const pools = JSON.parse(fs.readFileSync(path.join(S.ROOT_DIR, 'runtime/ucl_midweek_100x_3pools.json'), 'utf8'));
  const configs = [
    {
      key: 'POOL_A_CEILING',
      bulletId: 'CH_MONSTER_20261123_V15_UCL_CEILING_135X',
      sourceTag: 'UCL_MIDWEEK_POISSON_CEILING_135X',
      title: 'Monster #15 — UCL/Europe Poisson Ceiling (v3.1 Hardened, 135x+)',
      stakeStr: '3',
      minPotWin: 380.0,
      probeNs: [22, 23, 24, 25],
      shotName: 'codehub_v15_ucl_ceiling_receipt.png'
    },
    {
      key: 'POOL_B_SHIELD',
      bulletId: 'CH_MONSTER_20261123_V16_UCL_SHIELD_130X',
      sourceTag: 'UCL_MIDWEEK_2UP_DC_SHIELD_130X',
      title: 'Monster #16 — UCL/Europe 2UP & DC Shield (v3.1 Hardened, 130x+)',
      stakeStr: '3',
      minPotWin: 360.0,
      probeNs: [21, 22, 23, 24],
      shotName: 'codehub_v16_ucl_shield_receipt.png'
    },
    {
      key: 'POOL_C_HYBRID',
      bulletId: 'CH_MONSTER_20261123_V17_UCL_HYBRID_200X',
      sourceTag: 'UCL_MIDWEEK_ZERO_VIG_HYBRID_200X',
      title: 'Monster #17 — UCL/Europe Zero-Vig Hybrid (v3.1 Hardened, 200x+)',
      stakeStr: '3',
      minPotWin: 600.0,
      probeNs: [23, 24, 25, 26],
      shotName: 'codehub_v17_ucl_hybrid_receipt.png'
    }
  ];

  const { browser, context, page } = await S.launchBrowser();
  try {
    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const sess = await S.readSession(page);
    console.log('Pre-Placement Session:', sess);
    if (!sess.isLogged) throw new Error('Not logged in!');

    await page.goto('https://www.sportybet.com/gh/m/sport/football/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    const results = [];
    for (const cfg of configs) {
      const r = await placeOneTicket(context, page, cfg, pools[cfg.key]);
      results.push(r);
    }

    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const afterSess = await S.readSession(page);
    console.log('\nPost-Placement Balance:', afterSess.balance);

    const summary = {
      balanceBefore: sess.balance,
      balanceAfter: afterSess.balance,
      tickets: results
    };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/monster_v15_v16_v17_results.json'), JSON.stringify(summary, null, 2));
    await S.persistState(context);
    console.log('\nSaved all 3 UCL/Europe x100+ results to runtime/monster_v15_v16_v17_results.json');
  } finally {
    await browser.close();
  }
})();
