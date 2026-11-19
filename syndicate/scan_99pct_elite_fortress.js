const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

// The proven 98.5%-99.0% SportyBet Ghana structural tail markets + their exact mirrors
const ULTRA_99_MARKETS = [
  // Symmetric Half-Goal Impossibility Ceilings (Team scoring 3+ goals in a SINGLE 45-min half!)
  { marketId: '69', outcomeId: '13', specifier: 'total=2.5', tag: '1H_Home_Under_2.5' },
  { marketId: '70', outcomeId: '13', specifier: 'total=2.5', tag: '1H_Away_Under_2.5' },
  { marketId: '91', outcomeId: '13', specifier: 'total=2.5', tag: '2H_Home_Under_2.5' },
  { marketId: '92', outcomeId: '13', specifier: 'total=2.5', tag: '2H_Away_Under_2.5' },
  // Symmetric Full-Time 4+ Goal Team Ceiling (Team scoring 4+ goals in 90 mins!)
  { marketId: '19', outcomeId: '13', specifier: 'total=3.5', tag: 'FT_Home_Under_3.5' },
  { marketId: '20', outcomeId: '13', specifier: 'total=3.5', tag: 'FT_Away_Under_3.5' },
  // Asymmetric Both-Halves Dominance Impossibility (Underdog winning BOTH 1H and 2H separately!)
  { marketId: '49', outcomeId: '76', specifier: null, tag: 'Away_WinBothHalves_No' },
  { marketId: '48', outcomeId: '76', specifier: null, tag: 'Home_WinBothHalves_No' },
  // Asymmetric +3 Goal European Handicap Shield (Favorite not losing by 4+ goals!)
  { marketId: '14', outcomeId: '1713', specifier: 'hcp=0:3', tag: 'Hcp_0_3_Away' },
  { marketId: '14', outcomeId: '1711', specifier: 'hcp=3:0', tag: 'Hcp_3_0_Home' },
  // Extreme Match Poisson Tail Ceilings
  { marketId: '18', outcomeId: '13', specifier: 'total=6.5', tag: 'Match_Under_6.5' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5.5', tag: 'Match_Under_5.5' },
  { marketId: '68', outcomeId: '13', specifier: 'total=3.5', tag: '1H_Match_Under_3.5' },
  { marketId: '90', outcomeId: '13', specifier: 'total=3.5', tag: '2H_Match_Under_3.5' },
  // Extreme 2-Goal Lead Impossibility & BTTS Both Halves
  { marketId: '60307', outcomeId: '76', specifier: null, tag: 'Away_LeadBy2_No' },
  { marketId: '60306', outcomeId: '76', specifier: null, tag: 'Home_LeadBy2_No' },
  { marketId: '900027', outcomeId: '76', specifier: null, tag: 'BTTS_BothHalves_No' },
  { marketId: '57', outcomeId: '76', specifier: null, tag: 'Away_ScoreBothHalves_No' },
  { marketId: '56', outcomeId: '76', specifier: null, tag: 'Home_ScoreBothHalves_No' }
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

// Elite & Verified Top-Tier Global Pro Leagues (Strict historical Poisson stability; zero youth/amateur/regional variance)
const ELITE_LEAGUES = [
  'UEFA Champions League', 'UEFA Europa League', 'UEFA Conference League',
  'Premier League', 'Championship', 'League One', 'FA Cup',
  'Serie A', 'Serie B', 'LaLiga', 'LALIGA 2', 'LaLiga 2', 'LALIGA HYPERMOTION',
  'Bundesliga', '2. Bundesliga', 'Ligue 1', 'Ligue 2',
  'Eredivisie', 'Liga Portugal', 'Primeira Liga', 'Liga Portugal 2',
  'Premiership', 'Super Lig', 'Süper Lig', 'Pro League', 'First Division A',
  'Super League', 'Superliga', 'Allsvenskan', 'Eliteserien', 'Ekstraklasa',
  'Brasileiro Serie A', 'Primera LPF', 'Liga Profesional', 'Liga MX', 'MLS',
  'J1 League', 'K League 1', 'A-League', 'Saudi Pro League', '1. Liga'
];

const EXCLUDE_KW = ['U19', 'U21', 'U20', 'U23', 'Youth', 'Women', 'Reserves', 'Amateur', 'II', 'Jong', 'B ', 'Tanzania', 'Wales', 'Bulgaria', 'Iran', 'India', 'Qatar', 'Algeria', 'Egypt', 'Morocco', 'Tunisia'];

function isElitePro(country, league, home, away) {
  const full = `${country} ${league} ${home} ${away}`;
  if (EXCLUDE_KW.some(k => full.toLowerCase().includes(k.toLowerCase()))) return false;
  // Also exclude Russian / lower regional leagues to stay strictly in top audited football ecosystems
  if (/Russia|Belarus|Kazakhstan|Armenia|Azerbaijan|Georgia|Uzbekistan/i.test(country)) return false;
  return ELITE_LEAGUES.some(l => (league || '').toLowerCase().includes(l.toLowerCase()));
}

(async () => {
  const { browser, context } = await S.launchBrowser();
  const req = context.request;
  try {
    const evMap = new Map();
    const now = Date.now();

    // Pull pages 1..22 of upcoming events + also fetch specifically top European/Global tournaments from catalog!
    for (let pageNum = 1; pageNum <= 22; pageNum++) {
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
      } catch (e) { break; }
    }

    // Also merge cached events (Champions League, Weekend Top-5 leagues, etc.)
    for (const fpath of ['runtime/ultra_99pct_markets_scan.json', 'runtime/betradar_10min_probabilities.json']) {
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(S.ROOT_DIR, fpath), 'utf8'));
        for (const ev of arr) {
          const eid = ev?.eventId;
          const st = ev?.estimateStartTime || ev?.startTime || 0;
          if (eid && st > now + 5400 * 1000 && !evMap.has(eid)) {
            evMap.set(eid, {
              eventId: eid,
              home: ev.homeTeamName || ev.home,
              away: ev.awayTeamName || ev.away,
              startTime: st,
              country: ev.sport?.category?.name || ev.country || '',
              league: ev.sport?.category?.tournament?.name || ev.league || ''
            });
          }
        }
      } catch {}
    }

    // Also pull Top-15 elite tournaments explicitly via tournamentId filter if available!
    const eliteTournIds = [
      'sr:tournament:7',   // UEFA Champions League
      'sr:tournament:679', // UEFA Europa League
      'sr:tournament:34480', // UEFA Conference League
      'sr:tournament:17',  // Premier League
      'sr:tournament:18',  // Championship
      'sr:tournament:23',  // Serie A
      'sr:tournament:8',   // LaLiga
      'sr:tournament:35',  // Bundesliga
      'sr:tournament:34',  // Ligue 1
      'sr:tournament:37',  // Eredivisie
      'sr:tournament:238', // Liga Portugal
      'sr:tournament:325', // Brasileiro Serie A
      'sr:tournament:53',  // Serie B
      'sr:tournament:44',  // 2. Bundesliga
      'sr:tournament:182'  // Ligue 2
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
            if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > now + 5400 * 1000 && !evMap.has(ev.eventId)) {
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

    const allEvents = Array.from(evMap.values());
    const eliteEvents = allEvents.filter(e => isElitePro(e.country, e.league, e.home, e.away));
    console.log(`Total upcoming matches: ${allEvents.length} | Verified ELITE PRO matches: ${eliteEvents.length}`);

    // Query all 19 symmetric ultra-99% markets across all elite pro matches!
    const queries = [];
    for (const ev of eliteEvents) {
      for (const m of ULTRA_99_MARKETS) {
        queries.push({
          eventId: ev.eventId,
          marketId: m.marketId,
          outcomeId: m.outcomeId,
          specifier: m.specifier
        });
      }
    }
    console.log(`Querying ${queries.length} elite match-market pairs...`);

    const results = [];
    const BATCH = 180;
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
                if (o.isActive === 1 && od >= 1.01 && p >= 0.980) {
                  results.push({
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
      } catch {}
    }

    // Deduplicate
    const seen = new Set();
    const dedup = [];
    for (const r of results) {
      const k = `${r.eventId}|${r.marketId}|${r.specifier}|${r.outcomeId}`;
      if (!seen.has(k)) { seen.add(k); dedup.push(r); }
    }

    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/ultra_99pct_elite_universe.json'), JSON.stringify(dedup, null, 2));

    // Select best single structural outcome per unique ELITE match!
    const byEv = new Map();
    for (const r of dedup) {
      const prev = byEv.get(r.eventId);
      if (!prev || r.prob > prev.prob || (Math.abs(r.prob - prev.prob) < 1e-5 && r.odds > prev.odds)) {
        byEv.set(r.eventId, r);
      }
    }
    const ranked = Array.from(byEv.values()).sort((a,b) => b.prob - a.prob || b.odds - a.odds);
    console.log(`\n=== ELITE PRO 98.0%-99.0% UNIVERSE ===`);
    console.log(`Total active elite outcomes >= 98.0%: ${dedup.length}`);
    console.log(`Unique ELITE matches >= 98.0%: ${ranked.length}`);
    console.log(`Unique ELITE matches >= 98.5%: ${ranked.filter(x => x.prob >= 0.985).length}`);
    console.log(`Unique ELITE matches >= 98.6%: ${ranked.filter(x => x.prob >= 0.986).length}`);
    console.log(`Unique ELITE matches >= 98.8%: ${ranked.filter(x => x.prob >= 0.988).length}`);

    if (ranked.length >= 50) {
      const top50 = ranked.slice(0, 50);
      const combProb = top50.reduce((a, x) => a * x.prob, 1.0);
      const combOdds = top50.reduce((a, x) => a * x.odds, 1.0);
      const avgProb = top50.reduce((a, x) => a + x.prob, 0) / 50;
      const avgRtp = top50.reduce((a, x) => a + x.rtp, 0) / 50;
      console.log(`\n>>> TOP 50 ELITE FORTRESS PROJECTION <<<`);
      console.log(`Avg Per-Leg Prob: ${(avgProb*100).toFixed(3)}% | Min Leg Prob: ${(Math.min(...top50.map(x=>x.prob))*100).toFixed(2)}% | Max Leg Prob: ${(Math.max(...top50.map(x=>x.prob))*100).toFixed(2)}%`);
      console.log(`Avg Per-Leg Betradar RTP: ${(avgRtp*100).toFixed(3)}% (House edge: ${((1-avgRtp)*100).toFixed(3)}%/leg)`);
      console.log(`Combined 50-Fold True Win Probability: ${(combProb*100).toFixed(2)}%!!`);
      console.log(`Combined 50-Fold Odds: ${combOdds.toFixed(4)}x (GHS 2.00 -> GHS ${(2*combOdds).toFixed(2)}) | Total Ticket RTP: ${(combProb*combOdds*100).toFixed(2)}%`);
    }

    console.log('\n--- TOP 60 ELITE MATCHES ---');
    ranked.slice(0, 60).forEach((r, idx) => {
      const dt = new Date(r.startTime).toISOString().slice(5, 16).replace('T', ' ');
      console.log(`${String(idx+1).padStart(2)}. [${dt}] ${r.home} vs ${r.away} (${r.country} - ${r.league}) | ${r.marketDesc} [${r.specifier||'-'}] -> ${r.outcomeDesc} @ ${r.odds.toFixed(2)} | Prob=${(r.prob*100).toFixed(2)}% | RTP=${(r.rtp*100).toFixed(2)}%`);
    });
  } finally {
    await browser.close();
  }
})();
