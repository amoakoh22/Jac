const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

const MARKETS = [
  { marketId: '49', outcomeId: '76', specifier: null, tag: 'AwayWinBothHalves_No' },
  { marketId: '48', outcomeId: '76', specifier: null, tag: 'HomeWinBothHalves_No' },
  { marketId: '60307', outcomeId: '76', specifier: null, tag: 'AwayLeadBy2_No' },
  { marketId: '60306', outcomeId: '76', specifier: null, tag: 'HomeLeadBy2_No' },
  { marketId: '900027', outcomeId: '76', specifier: null, tag: 'BTTSBothHalves_No' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5.5', tag: 'Under_5.5_Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=6.5', tag: 'Under_6.5_Goals' },
  { marketId: '68', outcomeId: '13', specifier: 'total=3.5', tag: '1H_Under_3.5_Goals' },
  { marketId: '90', outcomeId: '13', specifier: 'total=3.5', tag: '2H_Under_3.5_Goals' },
  { marketId: '20', outcomeId: '13', specifier: 'total=2.5', tag: 'Away_Under_2.5_Goals' },
  { marketId: '19', outcomeId: '13', specifier: 'total=2.5', tag: 'Home_Under_2.5_Goals' },
  { marketId: '70', outcomeId: '13', specifier: 'total=1.5', tag: '1H_Away_Under_1.5' },
  { marketId: '69', outcomeId: '13', specifier: 'total=1.5', tag: '1H_Home_Under_1.5' },
  { marketId: '18', outcomeId: '12', specifier: 'total=0.5', tag: 'Over_0.5_Goals' },
  { marketId: '57', outcomeId: '76', specifier: null, tag: 'AwayScoreBothHalves_No' },
  { marketId: '56', outcomeId: '76', specifier: null, tag: 'HomeScoreBothHalves_No' },
  { marketId: '10', outcomeId: '9', specifier: null, tag: 'DC_1X' },
  { marketId: '10', outcomeId: '11', specifier: null, tag: 'DC_X2' }
];

const HEADERS = {
  'accept': '*/*',
  'accept-language': 'en',
  'clientid': 'wap',
  'content-type': 'application/json;charset=UTF-8',
  'operid': '3',
  'platform': 'wap',
  'referer': 'https://www.sportybet.com/gh/m/sport/football/?sort=0',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
};

(async () => {
  const { browser, context } = await S.launchBrowser();
  const req = context.request;
  try {
    // 1) Discover EVERY active >=97.5% market on 3 diverse matches via /api/gh/factsCenter/event
    const sampleIds = ['sr:match:72036298', 'sr:match:72513320', 'sr:match:72221406'];
    const knownKeys = new Set(MARKETS.map(m => `${m.marketId}|${m.specifier || ''}|${m.outcomeId}`));

    console.log('=== SAMPLE EVENT FULL MARKET DISCOVERY ===');
    for (const eid of sampleIds) {
      try {
        const res = await req.get(
          `https://www.sportybet.com/api/gh/factsCenter/event?eventId=${encodeURIComponent(eid)}&productId=3&_t=${Date.now()}`,
          { headers: HEADERS }
        );
        const j = await res.json();
        const ev = j?.data;
        if (!ev) continue;
        const highs = [];
        for (const m of (ev.markets || [])) {
          if (m.status !== 0) continue;
          for (const o of (m.outcomes || [])) {
            const p = parseFloat(o.probability || '0');
            const od = parseFloat(o.odds || '0');
            if (o.isActive === 1 && od >= 1.01 && p >= 0.975) {
              highs.push({
                mId: String(m.id), spec: m.specifier || '', desc: m.desc,
                oId: String(o.id), oDesc: o.desc, odds: od, prob: p, rtp: +(od * p).toFixed(5)
              });
            }
          }
        }
        highs.sort((a,b) => b.prob - a.prob);
        console.log(`${ev.homeTeamName} vs ${ev.awayTeamName} | Markets=${(ev.markets||[]).length} | Active >=97.5%: ${highs.length}`);
        for (const h of highs.slice(0, 15)) {
          console.log(`  mId=${h.mId} spec=${h.spec || '-'} oId=${h.oId} | ${h.desc} -> ${h.oDesc} @ ${h.odds} | Prob=${(h.prob*100).toFixed(2)}% | RTP=${(h.rtp*100).toFixed(2)}%`);
          // Add clean team/match structural markets (skip player props, cards, corners, exact scores, penalties)
          if (h.mId.startsWith('800')) continue;
          if (/goalscorer|player|card|corner|booking|penalty|own goal|correct score|multiscores|exact/i.test(h.desc)) continue;
          const k = `${h.mId}|${h.spec}|${h.oId}`;
          if (!knownKeys.has(k) && MARKETS.length < 30) {
            knownKeys.add(k);
            MARKETS.push({ marketId: h.mId, outcomeId: h.oId, specifier: h.spec || null, tag: `Auto_${h.mId}` });
          }
        }
      } catch (e) {
        console.log(`Sample ${eid} err:`, e.message);
      }
    }
    console.log(`Total structural tail markets armed for scan: ${MARKETS.length}`);

    // 2) Pull 450+ upcoming football events across SportyBet Ghana via wapConfigurableEventsByOrder
    const evMap = new Map();
    const now = Date.now();
    for (let pageNum = 1; pageNum <= 18; pageNum++) {
      try {
        const res = await req.post('https://www.sportybet.com/api/gh/factsCenter/wapConfigurableEventsByOrder', {
          headers: HEADERS,
          data: {
            productId: 3, sportId: 'sr:sport:1', order: 0,
            pageNum, pageSize: 30, withTwoUpMarket: false, withOneUpMarket: false
          }
        });
        const j = await res.json();
        const tournaments = j?.data?.tournaments || [];
        if (!tournaments.length) break;
        for (const t of tournaments) {
          for (const ev of (t.events || [])) {
            if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > now + 5400 * 1000) {
              if (!evMap.has(ev.eventId)) {
                evMap.set(ev.eventId, {
                  eventId: ev.eventId,
                  home: ev.homeTeamName,
                  away: ev.awayTeamName,
                  startTime: ev.estimateStartTime,
                  country: t.categoryName || ev.sport?.category?.name || '',
                  league: t.name || ev.sport?.category?.tournament?.name || ''
                });
              }
            }
          }
        }
      } catch (e) {
        console.log(`Page ${pageNum} err:`, e.message);
        break;
      }
    }

    // Merge local cached future events (e.g. Champions League, top weekend leagues)
    try {
      const scan1 = JSON.parse(fs.readFileSync(path.join(S.ROOT_DIR, 'runtime/ultra_99pct_markets_scan.json'), 'utf8'));
      for (const ev of scan1) {
        if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > now + 5400 * 1000 && !evMap.has(ev.eventId)) {
          evMap.set(ev.eventId, {
            eventId: ev.eventId,
            home: ev.homeTeamName,
            away: ev.awayTeamName,
            startTime: ev.estimateStartTime,
            country: ev.sport?.category?.name || '',
            league: ev.sport?.category?.tournament?.name || ''
          });
        }
      }
    } catch {}

    const allEvents = Array.from(evMap.values());
    console.log(`Total unique future football matches collected: ${allEvents.length}`);

    // 3) Query /api/gh/factsCenter/Outcomes in fast batches of 150!
    const queries = [];
    for (const ev of allEvents.slice(0, 450)) {
      for (const m of MARKETS) {
        queries.push({
          eventId: ev.eventId,
          marketId: m.marketId,
          outcomeId: m.outcomeId,
          specifier: m.specifier
        });
      }
    }
    console.log(`Querying ${queries.length} match-market pairs in batches of 150...`);

    const allResults = [];
    const BATCH = 150;
    for (let i = 0; i < queries.length; i += BATCH) {
      const chunk = queries.slice(i, i + BATCH);
      try {
        const res = await req.post('https://www.sportybet.com/api/gh/factsCenter/Outcomes', {
          headers: { ...HEADERS, 'sourcescenario': 'Betslip-View-Model-Fetch-Outcome-Data:open' },
          data: chunk
        });
        const j = await res.json();
        if (Array.isArray(j?.data)) {
          for (const ev of j.data) {
            if (!ev || ev.status !== 0) continue;
            for (const m of (ev.markets || [])) {
              if (m.status !== 0) continue;
              for (const o of (m.outcomes || [])) {
                const p = parseFloat(o.probability || '0');
                const od = parseFloat(o.odds || '0');
                if (o.isActive === 1 && od >= 1.01 && p >= 0.978) {
                  allResults.push({
                    eventId: ev.eventId,
                    gameId: ev.gameId,
                    home: ev.homeTeamName,
                    away: ev.awayTeamName,
                    startTime: ev.estimateStartTime,
                    sportId: ev.sport?.id || 'sr:sport:1',
                    sportName: ev.sport?.name || 'Football',
                    categoryId: ev.sport?.category?.id || '',
                    country: ev.sport?.category?.name || '',
                    tournamentId: ev.sport?.category?.tournament?.id || '',
                    league: ev.sport?.category?.tournament?.name || '',
                    marketId: String(m.id),
                    specifier: m.specifier || '',
                    product: m.product || 3,
                    group: m.group || 'Main',
                    marketDesc: m.desc,
                    outcomeId: String(o.id),
                    outcomeDesc: o.desc,
                    odds: od,
                    prob: p,
                    rtp: +(od * p).toFixed(6)
                  });
                }
              }
            }
          }
        }
      } catch (e) {}
    }

    const seen = new Set();
    const dedup = [];
    for (const r of allResults) {
      const k = `${r.eventId}|${r.marketId}|${r.specifier}|${r.outcomeId}`;
      if (!seen.has(k)) { seen.add(k); dedup.push(r); }
    }
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/ultra_99pct_global_universe.json'), JSON.stringify(dedup, null, 2));
    console.log(`\nTotal active >=97.8% structural tail outcomes found: ${dedup.length}`);

    const byEv = new Map();
    for (const r of dedup) {
      const prev = byEv.get(r.eventId);
      if (!prev || r.prob > prev.prob || (Math.abs(r.prob - prev.prob) < 0.0005 && r.odds > prev.odds)) {
        byEv.set(r.eventId, r);
      }
    }
    const ranked = Array.from(byEv.values()).sort((a,b) => b.prob - a.prob || b.odds - a.odds);
    console.log(`Unique matches with prob >= 97.8%: ${ranked.length}`);
    console.log(`Unique matches with prob >= 98.0%: ${ranked.filter(x => x.prob >= 0.980).length}`);
    console.log(`Unique matches with prob >= 98.5%: ${ranked.filter(x => x.prob >= 0.985).length}`);
    console.log(`Unique matches with prob >= 98.8%: ${ranked.filter(x => x.prob >= 0.988).length}`);
    console.log(`Unique matches with prob >= 99.0%: ${ranked.filter(x => x.prob >= 0.990).length}`);

    const mCounts = {};
    for (const r of ranked.slice(0, 60)) {
      const k = `${r.marketId} (${r.marketDesc} -> ${r.outcomeDesc})`;
      mCounts[k] = (mCounts[k] || 0) + 1;
    }
    console.log('\nMarket mix in Top 60:', mCounts);
    console.log('\n--- TOP 65 HIGHEST-PROBABILITY ACTIVE STRUCTURAL LEGS ON SPORTYBET GHANA ---');
    ranked.slice(0, 65).forEach((r, idx) => {
      const dt = new Date(r.startTime).toISOString().slice(5, 16).replace('T', ' ');
      console.log(`${String(idx+1).padStart(2)}. [${dt}] ${r.home} vs ${r.away} (${r.country} - ${r.league}) | ${r.marketDesc} [${r.specifier||'-'}] -> ${r.outcomeDesc} @ ${r.odds.toFixed(2)} | Prob=${(r.prob*100).toFixed(2)}% | RTP=${(r.rtp*100).toFixed(2)}%`);
    });
  } finally {
    await browser.close();
  }
})();
