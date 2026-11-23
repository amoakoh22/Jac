/**
 * Jac Syndicate - Zero-Overlap Midweek UCL/UEL + Europe x100+ 3-Pool Scanner (v3.1)
 * - Strictly excludes ALL eventIds currently on active open tickets (9121S3, C36TTY, C3GCWW)
 * - Applies Sun Nov 22 post-mortem tightened thresholds:
 *     * Under 4.5:   prob >= 0.810
 *     * 1H Under 2.5: prob >= 0.815
 *     * DC 1X / X2:  prob >= 0.775
 *     * All legs:    odds in [1.20, 1.38], rtp >= 0.950
 * - Outputs 3 completely disjoint candidate pools to runtime/ucl_midweek_100x_3pools.json
 */
const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

const HARDENED_MARKETS = [
  { marketId: '68', outcomeId: '13', specifier: 'total=2.5', bucket: 'CEILING', label: '1H Under 2.5', minProb: 0.815 },
  { marketId: '18', outcomeId: '13', specifier: 'total=4.5', bucket: 'CEILING', label: 'Under 4.5 Goals', minProb: 0.810 },
  { marketId: '18', outcomeId: '13', specifier: 'total=3.5', bucket: 'CEILING', label: 'Under 3.5 Goals', minProb: 0.770 },
  { marketId: '20', outcomeId: '13', specifier: 'total=1.5', bucket: 'CEILING', label: 'Away Under 1.5', minProb: 0.765 },
  { marketId: '19', outcomeId: '13', specifier: 'total=1.5', bucket: 'CEILING', label: 'Home Under 1.5', minProb: 0.765 },
  { marketId: '20', outcomeId: '13', specifier: 'total=2.5', bucket: 'CEILING', label: 'Away Under 2.5', minProb: 0.795 },
  { marketId: '19', outcomeId: '13', specifier: 'total=2.5', bucket: 'CEILING', label: 'Home Under 2.5', minProb: 0.795 },
  { marketId: '10', outcomeId: '9',  specifier: null,        bucket: 'SHIELD',  label: 'Double Chance 1X', minProb: 0.775 },
  { marketId: '10', outcomeId: '11', specifier: null,        bucket: 'SHIELD',  label: 'Double Chance X2', minProb: 0.775 },
  { marketId: '60100', outcomeId: '1', specifier: null,      bucket: 'SHIELD',  label: '1X2 - 2UP Home', minProb: 0.750 },
  { marketId: '60100', outcomeId: '3', specifier: null,      bucket: 'SHIELD',  label: '1X2 - 2UP Away', minProb: 0.750 },
  { marketId: '18', outcomeId: '12', specifier: 'total=1.5', bucket: 'SHIELD',  label: 'Over 1.5 Goals', minProb: 0.765 }
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
  'Premier League', 'Championship', 'League One', 'Serie A', 'Serie B', 'LaLiga', 'LALIGA HYPERMOTION',
  'Bundesliga', '2. Bundesliga', 'Ligue 1', 'Ligue 2', 'Eredivisie', 'Liga Portugal', 'Primeira Liga',
  'Premiership', 'Super Lig', 'Pro League', 'Super League', 'Superliga', 'Allsvenskan', 'Eliteserien',
  'Brasileiro Serie A', 'Primera LPF', 'J1 League', 'Saudi Pro League', 'MLS', 'Liga MX', 'AFC Champions League'
];

function isCleanPro(country, league, home, away) {
  const full = `${country} ${league} ${home} ${away}`;
  if (EXCLUDE_KW.some(k => full.toLowerCase().includes(k.toLowerCase()))) return false;
  if (/Russia|Belarus|Kazakhstan|Tanzania|Wales|Bulgaria|Iran|India|Qatar|Algeria|Indonesia/i.test(country)) return false;
  return ELITE_LEAGUES.some(l => (league || '').toLowerCase().includes(l.toLowerCase()));
}

function loadActiveEventIds() {
  const active = new Set();
  const auditPath = path.join(S.ROOT_DIR, 'runtime', 'live_api_audit_latest.json');
  if (fs.existsSync(auditPath)) {
    const d = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    for (const b of (d?.open?.data?.cashAbleBets || [])) {
      for (const s of (b.selections || [])) {
        if (s.eventId) active.add(s.eventId);
      }
    }
  }
  return active;
}

(async () => {
  const activeIds = loadActiveEventIds();
  console.log(`Excluding ${activeIds.size} eventIds already on active open tickets (9121S3, C36TTY, C3GCWW)...`);

  const { browser, context } = await S.launchBrowser();
  const req = context.request;
  try {
    const evMap = new Map();
    const now = Date.now();
    const minStart = now + 3600 * 1000;

    for (let pageNum = 1; pageNum <= 25; pageNum++) {
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
            if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > minStart && !activeIds.has(ev.eventId) && !evMap.has(ev.eventId)) {
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

    const eliteTournIds = [
      'sr:tournament:7', 'sr:tournament:679', 'sr:tournament:34480',
      'sr:tournament:17', 'sr:tournament:18', 'sr:tournament:24', 'sr:tournament:23',
      'sr:tournament:8', 'sr:tournament:35', 'sr:tournament:34', 'sr:tournament:182',
      'sr:tournament:37', 'sr:tournament:238', 'sr:tournament:325',
      'sr:tournament:53', 'sr:tournament:44', 'sr:tournament:38', 'sr:tournament:52'
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
            if (ev?.eventId && ev.status === 0 && (ev.estimateStartTime || 0) > minStart && !activeIds.has(ev.eventId) && !evMap.has(ev.eventId)) {
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
    console.log(`Collected ${evMap.size} unused upcoming events | Clean Elite Pro (0 overlap): ${cleanEvents.length}`);

    const queries = [];
    for (const ev of cleanEvents) {
      for (const m of HARDENED_MARKETS) {
        queries.push({ eventId: ev.eventId, marketId: m.marketId, outcomeId: m.outcomeId, specifier: m.specifier });
      }
    }

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
            if (!ev || ev.status !== 0 || activeIds.has(ev.eventId)) continue;
            for (const m of (ev.markets || [])) {
              if (m.status !== 0) continue;
              for (const o of (m.outcomes || [])) {
                const meta = bucketMap.get(`${m.id}|${m.specifier || ''}|${o.id}`);
                if (!meta) continue;
                const od = parseFloat(o.odds || '0');
                const p = parseFloat(o.probability || '0');
                const rtp = od * p;
                if (o.isActive === 1 && od >= 1.20 && od <= 1.38 && p >= meta.minProb && rtp >= 0.950) {
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
                    rtp: +rtp.toFixed(6),
                    score: +(p * 0.65 + rtp * 0.35).toFixed(6)
                  });
                }
              }
            }
          }
        }
      } catch {}
    }

    // Pick best single market per eventId per bucket
    const bestByEvent = new Map();
    const bestCeilByEvent = new Map();
    const bestShieldByEvent = new Map();
    for (const r of out) {
      if (!bestByEvent.has(r.eventId) || r.score > bestByEvent.get(r.eventId).score) bestByEvent.set(r.eventId, r);
      if (r.bucket === 'CEILING' && (!bestCeilByEvent.has(r.eventId) || r.score > bestCeilByEvent.get(r.eventId).score)) bestCeilByEvent.set(r.eventId, r);
      if (r.bucket === 'SHIELD' && (!bestShieldByEvent.has(r.eventId) || r.score > bestShieldByEvent.get(r.eventId).score)) bestShieldByEvent.set(r.eventId, r);
    }

    const ceilAll = Array.from(bestCeilByEvent.values()).sort((a, b) => b.score - a.score);
    const shieldAll = Array.from(bestShieldByEvent.values()).sort((a, b) => b.score - a.score);
    const hybridAll = Array.from(bestByEvent.values()).sort((a, b) => b.score - a.score);

    // Strictly disjoint allocation across 3 pools (round-robin / bucket-aware so all 3 pools get elite quality)
    const used = new Set();
    const poolA = []; // CEILING (28 candidates)
    const poolB = []; // SHIELD (28 candidates)
    const poolC = []; // HYBRID (30 candidates)

    // Interleave A and B first so neither starves the other
    let ci = 0, si = 0;
    while (poolA.length < 28 || poolB.length < 28) {
      let progressed = false;
      if (poolA.length < 28) {
        while (ci < ceilAll.length && used.has(ceilAll[ci].eventId)) ci++;
        if (ci < ceilAll.length) { used.add(ceilAll[ci].eventId); poolA.push(ceilAll[ci++]); progressed = true; }
      }
      if (poolB.length < 28) {
        while (si < shieldAll.length && used.has(shieldAll[si].eventId)) si++;
        if (si < shieldAll.length) { used.add(shieldAll[si].eventId); poolB.push(shieldAll[si++]); progressed = true; }
      }
      if (!progressed) break;
    }

    for (const r of hybridAll) {
      if (poolC.length >= 30) break;
      if (!used.has(r.eventId)) { used.add(r.eventId); poolC.push(r); }
    }

    const pools = {
      generated_at: new Date().toISOString(),
      excluded_active_events: activeIds.size,
      total_unique_unused_matches: bestByEvent.size,
      POOL_A_CEILING: poolA,
      POOL_B_SHIELD: poolB,
      POOL_C_HYBRID: poolC
    };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime/ucl_midweek_100x_3pools.json'), JSON.stringify(pools, null, 2));

    console.log(`\n=== ZERO-OVERLAP MIDWEEK UCL/EUROPE 3-POOL SUMMARY ===`);
    console.log(`Total unique unused qualifying matches: ${bestByEvent.size}`);
    console.log(`  POOL_A_CEILING: ${poolA.length} matches | avg prob ${(poolA.reduce((s,x)=>s+x.prob,0)/(poolA.length||1)*100).toFixed(2)}% | avg rtp ${(poolA.reduce((s,x)=>s+x.rtp,0)/(poolA.length||1)*100).toFixed(2)}%`);
    console.log(`  POOL_B_SHIELD:  ${poolB.length} matches | avg prob ${(poolB.reduce((s,x)=>s+x.prob,0)/(poolB.length||1)*100).toFixed(2)}% | avg rtp ${(poolB.reduce((s,x)=>s+x.rtp,0)/(poolB.length||1)*100).toFixed(2)}%`);
    console.log(`  POOL_C_HYBRID:  ${poolC.length} matches | avg prob ${(poolC.reduce((s,x)=>s+x.prob,0)/(poolC.length||1)*100).toFixed(2)}% | avg rtp ${(poolC.reduce((s,x)=>s+x.rtp,0)/(poolC.length||1)*100).toFixed(2)}%`);
  } finally {
    await browser.close();
  }
})();
