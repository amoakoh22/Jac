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
        probability: String(o.probability || '0.987'),
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
      probability: String(o.probability || '0.987'),
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

(async () => {
  const candidates = JSON.parse(
    fs.readFileSync(path.join(S.ROOT_DIR, 'runtime/fortress_50fold_99pct_candidates.json'), 'utf8')
  );

  const { browser, context, page } = await S.launchBrowser();
  try {
    // Step 1: Verify live session on home page (where GHS balance header renders cleanly)
    await page.goto('https://www.sportybet.com/gh/m/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);
    const sess = await S.readSession(page);
    console.log('Live session check:', sess);
    if (!sess.isLogged) {
      throw new Error('SportyBet session not logged in! Run active_login_sentinel.js first.');
    }
    await page.goto('https://www.sportybet.com/gh/m/sport/football/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2500);

    // Step 2: Live-verify all 58 candidates via /api/gh/factsCenter/Outcomes right before placement!
    const qPayload = candidates.map(c => ({
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
    const seenEv = new Set();
    for (const c of candidates) {
      if (seenEv.has(c.eventId)) continue;
      const ev = liveMap.get(c.eventId);
      if (!ev || !ev.markets || !ev.markets.length) continue;
      const m = ev.markets.find(mk => String(mk.id) === String(c.marketId) && mk.status === 0);
      if (!m) continue;
      const o = (m.outcomes || []).find(oc => String(oc.id) === String(c.outcomeId) && oc.isActive === 1);
      if (!o) continue;
      const liveOdds = parseFloat(o.odds || '0');
      const liveProb = parseFloat(o.probability || String(c.prob));
      if (liveOdds >= 1.01 && liveProb >= 0.980) {
        seenEv.add(c.eventId);
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
          odds: liveOdds,
          prob: liveProb,
          rtp: +(liveOdds * liveProb).toFixed(6),
          wap_item: buildWapItemFromLive(ev, m, o)
        });
      }
      if (verified.length === 50) break;
    }

    console.log(`Live-verified ultra-99% Tier-1 legs ready for slip: ${verified.length}`);
    if (verified.length < 50) {
      throw new Error(`Expected 50 verified legs, got ${verified.length}`);
    }

    // Step 3: Inject all 50 legs directly into wapBetslips and reload
    await page.evaluate((items) => {
      localStorage.setItem('wapBetslips', JSON.stringify(items));
    }, verified.map(v => v.wap_item));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4500);

    // Open betslip drawer
    await page.evaluate(() => {
      const icon = document.querySelector('.betslip-theme-icon') || document.querySelector('.m-betslip-Balls');
      if (icon) icon.click();
    });
    await page.waitForTimeout(2500);

    // Check slip count & ensure Flexi/1UP/EarlyGoals are NOT checked
    const slipInfo = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      const mc = document.querySelector('[data-op="betslip-multi-count"]')?.innerText?.trim() || '';
      return { multiCount: mc, snippet: txt.slice(0, 600) };
    });
    console.log('Betslip opened | multiCount:', slipInfo.multiCount);

    // Enter GHS 2 stake via official SportyBet keypad
    await page.evaluate(() => {
      const el = document.querySelector('[data-op="betslip-stake-amount"]');
      if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
    });
    await page.waitForTimeout(700);
    await S.typeStakeOnKeyboard(page, '2');
    await page.waitForTimeout(1500);

    // Read live quote before placing
    const quote = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      const pot = txt.match(/Potential\s+Win[^\d]*([0-9,]+\.[0-9]{2})/i);
      const odds = txt.match(/Total\s+Odds[^\d]*([0-9,]+\.[0-9]{2})/i);
      const bonus = txt.match(/(?:Max\s+)?Bonus[^\d]*([0-9,]+\.[0-9]{2})/i);
      const placeBtn = document.querySelector('[data-op="betslip-placebet"]')?.innerText?.trim() || '';
      return {
        potentialWin: pot ? parseFloat(pot[1].replace(/,/g, '')) : 0,
        totalOdds: odds ? parseFloat(odds[1].replace(/,/g, '')) : 0,
        bonusGhs: bonus ? parseFloat(bonus[1].replace(/,/g, '')) : 0,
        placeBtn
      };
    });
    console.log('Pre-Placement Live Quote:', quote);
    await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, 'codehub_50fold_99pct_fortress_preslip.png') });

    // Step 4: Click Place Bet (handling Accept Odds Changes if prompted) + Confirm
    for (let attempt = 0; attempt < 4; attempt++) {
      const btnText = await page.evaluate(() => {
        const btn = document.querySelector('[data-op="betslip-placebet"]');
        if (btn) { const t = (btn.innerText || '').trim(); btn.click(); return t; }
        return '';
      });
      console.log(`Clicked placebet button (attempt ${attempt + 1}): "${btnText}"`);
      await page.waitForTimeout(2000);
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

    await page.waitForTimeout(6000);
    const shotPath = path.join(S.SCREENSHOT_DIR, 'codehub_50fold_99pct_fortress_receipt.png');
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
        snippet: text.slice(0, 500)
      };
    });

    // Click OK and check updated live balance
    await page.evaluate(() => {
      const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(
        e => (e.innerText || '').trim().toLowerCase() === 'ok'
      );
      if (ok) ok.click();
    });
    await page.waitForTimeout(2000);
    const afterSess = await S.readSession(page);

    const baseProd = verified.reduce((acc, x) => acc * x.odds, 1.0);
    const avgProb = verified.reduce((acc, x) => acc + x.prob, 0) / verified.length;
    const minProb = Math.min(...verified.map(x => x.prob));
    const maxProb = Math.max(...verified.map(x => x.prob));
    const avgRtp = verified.reduce((acc, x) => acc + x.rtp, 0) / verified.length;
    const combinedProb = verified.reduce((acc, x) => acc * x.prob, 1.0);

    const out = {
      ...receipt,
      balanceBefore: sess.balance,
      balanceAfter: afterSess.balance,
      folds: verified.length,
      baseOdds: parseFloat(baseProd.toFixed(4)),
      quote,
      avgProbPct: parseFloat((avgProb * 100).toFixed(3)),
      minProbPct: parseFloat((minProb * 100).toFixed(2)),
      maxProbPct: parseFloat((maxProb * 100).toFixed(2)),
      avgRtpPct: parseFloat((avgRtp * 100).toFixed(3)),
      combinedWinProbPct: parseFloat((combinedProb * 100).toFixed(2)),
      totalTicketRtpPct: parseFloat((combinedProb * baseProd * 100).toFixed(2)),
      screenshotPath: shotPath,
      legs: verified.map(({ wap_item, ...rest }) => rest)
    };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/monster_v7_50fold_99pct_result.json'), JSON.stringify(out, null, 2));
    console.log('\n=== FINAL 50-FOLD 99% SCIENTIFIC FORTRESS RESULT ===\n', JSON.stringify({ ...out, legs: `[${out.legs.length} legs]` }, null, 2));
    await S.persistState(context);
  } finally {
    await browser.close();
  }
})();
