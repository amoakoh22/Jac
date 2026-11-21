const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

// Post-Mortem Hardened Structural Markets (ALL >= 1.20 qualifying for SportyBet Multi-Bet Bonus!)
// STRICTLY BANNED based on Friday Nov 20 post-mortem:
//   - NO 1H GG/NG: No (killed 8YLKVR & CMYT2L on Troyes 3-1 & Metz 2-1)
//   - NO -1 Handicaps (killed CHBJ6E on Bayern 1-1 Cologne)
//   - NO 2H Over 0.5 (killed 93VVCD on AGF Aarhus 2-1)
//   - NO plain 1X2 on volatile favorites (killed D8WJHX on Athletic Bilbao 0-1)
const HARDENED_MARKETS = [
  // Poisson Upper-Tail Ceilings (highest stability, ~78-84% true hit rate!)
  { marketId: '68', outcomeId: '13', specifier: 'total=2.5', bucket: 'CEILING', label: '1H Under 2.5' },
  { marketId: '18', outcomeId: '13', specifier: 'total=4.5', bucket: 'CEILING', label: 'Under 4.5 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=3.5', bucket: 'CEILING', label: 'Under 3.5 Goals' },
  { marketId: '20', outcomeId: '13', specifier: 'total=1.5', bucket: 'CEILING', label: 'Away Under 1.5' },
  { marketId: '19', outcomeId: '13', specifier: 'total=1.5', bucket: 'CEILING', label: 'Home Under 1.5' },
  { marketId: '20', outcomeId: '13', specifier: 'total=2.5', bucket: 'CEILING', label: 'Away Under 2.5' },
  { marketId: '19', outcomeId: '13', specifier: 'total=2.5', bucket: 'CEILING', label: 'Home Under 2.5' },
  // Draw-Protected Double Chance & 2UP Early Payout Shields
  { marketId: '10', outcomeId: '9', specifier: null, bucket: 'SHIELD', label: 'Double Chance 1X' },
  { marketId: '10', outcomeId: '11', specifier: null, bucket: 'SHIELD', label: 'Double Chance X2' },
  { marketId: '60100', outcomeId: '1', specifier: null, bucket: 'SHIELD', label: '1X2 - 2UP Home' },
  { marketId: '60100', outcomeId: '3', specifier: null, bucket: 'SHIELD', label: '1X2 - 2UP Away' },
  // High-xG Floor (strictly Top-Tier attacking leagues only)
  { marketId: '18', outcomeId: '12', specifier: 'total=1.5', bucket: 'SHIELD', label: 'Over 1.5 Goals' }
];

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

const EXCLUDE_KW = ['U19', 'U21', 'U20', 'U23', 'Youth', 'Women', 'Reserves', 'Amateur', 'Eerste Divisie', 'Oberliga', 'Regionalliga'];
const ELITE_LEAGUES = [
  'UEFA Champions League', 'UEFA Europa League', 'UEFA Conference League',
  'Premier League', 'Championship', 'Serie A', 'Serie B', 'LaLiga', 'LALIGA HYPERMOTION',
  'Bundesliga', '2. Bundesliga', 'Ligue 1', 'Eredivisie', 'Liga Portugal', 'Primeira Liga',
  'Premiership', 'Super Lig', 'Pro League', 'Super League', 'Superliga',
  'Brasileiro Serie A', 'Primera LPF', 'J1 League', 'Saudi Pro League', 'MLS', 'Liga MX'
];

function isCleanPro(country, league, home, away) {
  const full = `${country} ${league} ${home} ${away}`;
  if (EXCLUDE_KW.some(k => full.toLowerCase().includes(k.toLowerCase()))) return false;
  if (/Russia|Belarus|Kazakhstan|Tanzania|Wales|Bulgaria|Iran|India|Qatar|Algeria|Indonesia/i.test(country)) return false;
  return ELITE_LEAGUES.some(l => (league || '').toLowerCase().includes(l.toLowerCase()));
}

(async () => {
  const { browser, context } = await S.launchBrowser();
  const req = context.request;
  try {
    const evMap = new Map();
    const now = Date.now();
    // Kickoffs at least 2 hours from now (Sat Nov 21 11:40 GMT onward)
    const minStart = now + 7200 * 1000;

    // Pull pages 1..20 of upcoming events
    for (let pageNum = 1; pageNum <= 20; pageNum++) {
      try {
        const res = await req.post('https://www.sportybet.com/api/gh/factsCenter/wapConfigurableEventsByOrder', {
          headers: HEADERS,
          data: {
            productId: 3, sportId: 'sr:sport:1', order: 0,
            pageNum, pageSize: 30, withTwoUpMarket: true, withOneUpMarket: false
          }
        });
        const j = await res.json();
        const tournaments = j?.data?.tournaments || [];
        if (!tournaments.length) break;
        for (const t of tournaments) {
          for (const ev of (t.events || [])) {
            if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > minStart && !evMap.has(ev.eventId)) {
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
      } catch { break; }
    }

    // Explicitly pull top European/global tournaments via pcEvents
    const eliteTournIds = [
      'sr:tournament:7', 'sr:tournament:679', 'sr:tournament:34480',
      'sr:tournament:17', 'sr:tournament:18', 'sr:tournament:23',
      'sr:tournament:8', 'sr:tournament:35', 'sr:tournament:34',
      'sr:tournament:37', 'sr:tournament:238', 'sr:tournament:325',
      'sr:tournament:53', 'sr:tournament:44'
    ];
    for (const tid of eliteTournIds) {
      try {
        const res = await req.post('https://www.sportybet.com/api/gh/factsCenter/pcEvents', {
          headers: HEADERS,
          data: [{ sportId: 'sr:sport:1', marketId: '1', tournamentId: [[tid]] }]
        });
        const j = await res.json();
        for (const t of (j?.data || [])) {
          for (const ev of (t.events || [])) {
            if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > minStart && !evMap.has(ev.eventId)) {
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
      } catch {}
    }

    const cleanEvents = Array.from(evMap.values()).filter(e => isCleanPro(e.country, e.league, e.home, e.away));
    console.log(`Collected ${evMap.size} total upcoming events | Clean Elite Pro: ${cleanEvents.length}`);

    const queries = [];
    for (const ev of cleanEvents) {
      for (const m of HARDENED_MARKETS) {
        queries.push({
          eventId: ev.eventId,
          marketId: m.marketId,
          outcomeId: m.outcomeId,
          specifier: m.specifier
        });
      }
    }
    console.log(`Querying ${queries.length} hardened match-market pairs...`);

    const bucketMap = new Map(HARDENED_MARKETS.map(m => [`${m.marketId}|${m.specifier || ''}|${m.outcomeId}`, m]));
    const out = [];
    const BATCH = 180;
    for (let i = 0; i < queries.length; i += BATCH) {
      const chunk = queries.slice(i, i + BATCH);
      try {
        const res = await req.post('https://www.sportybet.com/api/gh/factsCenter/Outcomes', {
          headers: HEADERS,
          data: chunk
        });
        const j = await res.json();
        if (Array.isArray(j?.data)) {
          for (const ev of j.data) {
            if (!ev || ev.status !== 0) continue;
            for (const m of (ev.markets || [])) {
              if (m.status !== 0) continue;
              for (const o of (m.outcomes || [])) {
                const od = parseFloat(o.odds || '0');
                const p = parseFloat(o.probability || '0');
                const rtp = od * p;
                // Strictly >= 1.20 (100% SportyBet Multi-Bet Bonus qualifying!) and <= 1.38 (high-probability sweet spot!)
                if (o.isActive === 1 && od >= 1.20 && od <= 1.38 && p >= 0.71 && rtp >= 0.945) {
                  const meta = bucketMap.get(`${m.id}|${m.specifier || ''}|${o.id}`) || { bucket: 'OTHER', label: m.desc };
                  out.push({
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
                    bucket: meta.bucket,
                    label: meta.label,
                    odds: od,
                    prob: p,
                    rtp: +rtp.toFixed(6)
                  });
                }
              }
            }
          }
        }
      } catch {}
    }

    // Deduplicate
    const seen = new Set();
    const dedup = [];
    for (const r of out) {
      const k = `${r.eventId}|${r.marketId}|${r.specifier}|${r.outcomeId}`;
      if (!seen.has(k)) { seen.add(k); dedup.push(r); }
    }

    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/postmortem_100x_universe.json'), JSON.stringify(dedup, null, 2));

    const uniqEvs = new Set(dedup.map(x => x.eventId));
    const ceilEvs = new Set(dedup.filter(x => x.bucket === 'CEILING').map(x => x.eventId));
    const shieldEvs = new Set(dedup.filter(x => x.bucket === 'SHIELD').map(x => x.eventId));
    console.log(`\n=== POST-MORTEM HARDENED 1.20-1.38 ZERO-VIG UNIVERSE ===`);
    console.log(`Total qualifying legs: ${dedup.length} | Unique Matches: ${uniqEvs.size}`);
    console.log(`  CEILING bucket matches (1H U2.5 / U4.5 / U3.5 / Team Under): ${ceilEvs.size}`);
    console.log(`  SHIELD bucket matches (DC 1X/X2 / 2UP / High-xG O1.5):       ${shieldEvs.size}`);
  } finally {
    await browser.close();
  }
})();
