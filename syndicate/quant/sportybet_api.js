'use strict';

const BASE_URL = 'https://www.sportybet.com';

const HEADERS = Object.freeze({
  'accept': '*/*',
  'accept-language': 'en',
  'clientid': 'wap',
  'content-type': 'application/json;charset=UTF-8',
  'operid': '3',
  'platform': 'wap',
  'referer': 'https://www.sportybet.com/gh/m/sport/football/?sort=0',
  'sourcescenario': 'Betslip-View-Model-Fetch-Outcome-Data:open',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
});

const SPORTS = Object.freeze({
  FOOTBALL: 'sr:sport:1',
  BASKETBALL: 'sr:sport:2',
  BASEBALL: 'sr:sport:3',
  ICE_HOCKEY: 'sr:sport:4',
  TENNIS: 'sr:sport:5',
  HANDBALL: 'sr:sport:6',
  RUGBY: 'sr:sport:12',
  AMERICAN_FOOTBALL: 'sr:sport:16',
  TABLE_TENNIS: 'sr:sport:20',
  CRICKET: 'sr:sport:21',
  VOLLEYBALL: 'sr:sport:23'
});

const FULL_BONUS_SPORTS = Object.freeze([
  SPORTS.BASKETBALL,
  SPORTS.TENNIS,
  SPORTS.ICE_HOCKEY,
  SPORTS.TABLE_TENNIS
]);

const VIRTUAL_SPORT_IDS = new Set([
  'sr:sport:137', // eSoccer
  'sr:sport:153', // eBasketball
  'sr:sport:195', // eIce Hockey
  'sr:sport:109', // CS GO
  'sr:sport:110', // LoL
  'sr:sport:111'  // Dota2
]);

const SRL_PATTERN = /\b(srl|simulated reality|simulated|virtual|esoccer|ebasketball|e-soccer|e-basketball)\b/i;

const SPORT_ICONS = Object.freeze({
  'sr:sport:1': 'm-icon-football',
  'sr:sport:2': 'm-icon-basketball',
  'sr:sport:4': 'm-icon-icehockey',
  'sr:sport:5': 'm-icon-tennis',
  'sr:sport:20': 'm-icon-tabletennis'
});

function isSrlOrVirtual(eventLike, tournamentName = '', categoryName = '') {
  if (!eventLike) return true;
  const sportId = eventLike.sportId || eventLike.sport?.id || '';
  if (VIRTUAL_SPORT_IDS.has(String(sportId))) return true;

  const home = eventLike.homeTeamName || eventLike.home || '';
  const away = eventLike.awayTeamName || eventLike.away || '';
  const league = tournamentName || eventLike.league || eventLike.sport?.category?.tournament?.name || '';
  const country = categoryName || eventLike.country || eventLike.sport?.category?.name || '';
  const combined = `${home} ${away} ${league} ${country}`;
  return SRL_PATTERN.test(combined);
}

async function fetchBonusPlans(request) {
  const url = `${BASE_URL}/api/gh/promotion/v2/bonus/plans/valid?_t=${Date.now()}`;
  const res = await request.get(url, { headers: HEADERS });
  if (res && typeof res.ok === 'function' && !res.ok()) {
    throw new Error(`fetchBonusPlans HTTP ${res.status()}`);
  }
  return res.json();
}

async function fetchEventsByOrder(request, opts = {}) {
  const {
    sportId = SPORTS.FOOTBALL,
    productId = 3,
    order = 0,
    maxPages = 15,
    pageSize = 30,
    minStartOffsetMs = 0,
    withTwoUpMarket = sportId === SPORTS.FOOTBALL,
    withOneUpMarket = false,
    excludeSrl = true
  } = opts;

  const now = Date.now();
  const minStart = now + minStartOffsetMs;
  const evMap = new Map();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const res = await request.post(`${BASE_URL}/api/gh/factsCenter/wapConfigurableEventsByOrder`, {
      headers: HEADERS,
      data: {
        productId,
        sportId,
        order,
        pageNum,
        pageSize,
        withTwoUpMarket,
        withOneUpMarket
      }
    });
    const json = await res.json();
    const tournaments = json?.data?.tournaments || [];
    if (!tournaments.length) break;

    for (const t of tournaments) {
      const catName = t.categoryName || '';
      const tournName = t.name || '';
      for (const ev of (t.events || [])) {
        if (!ev?.eventId || ev.status !== 0) continue;
        if (minStartOffsetMs > 0 && (ev.estimateStartTime || 0) <= minStart) continue;
        if (excludeSrl && isSrlOrVirtual(ev, tournName, catName)) continue;
        if (evMap.has(ev.eventId)) continue;

        evMap.set(ev.eventId, {
          eventId: ev.eventId,
          gameId: ev.gameId || '',
          home: ev.homeTeamName || '',
          away: ev.awayTeamName || '',
          match: `${ev.homeTeamName || ''} vs ${ev.awayTeamName || ''}`.trim(),
          startTime: ev.estimateStartTime || 0,
          sportId: ev.sport?.id || sportId,
          sportName: ev.sport?.name || '',
          categoryId: ev.sport?.category?.id || t.categoryId || '',
          country: catName || ev.sport?.category?.name || '',
          tournamentId: t.id || ev.sport?.category?.tournament?.id || '',
          league: tournName || ev.sport?.category?.tournament?.name || ''
        });
      }
    }
  }

  return Array.from(evMap.values());
}

async function fetchTournamentEvents(request, tournamentIds, sportId = SPORTS.FOOTBALL, opts = {}) {
  const {
    marketId = '1',
    minStartOffsetMs = 0,
    excludeSrl = true
  } = opts;

  const minStart = Date.now() + minStartOffsetMs;
  const evMap = new Map();

  for (const tid of (tournamentIds || [])) {
    const res = await request.post(`${BASE_URL}/api/gh/factsCenter/pcEvents`, {
      headers: HEADERS,
      data: [{ sportId, marketId: String(marketId), tournamentId: [[tid]] }]
    });
    const json = await res.json();
    for (const t of (json?.data || [])) {
      const catName = t.categoryName || '';
      const tournName = t.name || '';
      for (const ev of (t.events || [])) {
        if (!ev?.eventId || ev.status !== 0) continue;
        if (minStartOffsetMs > 0 && (ev.estimateStartTime || 0) <= minStart) continue;
        if (excludeSrl && isSrlOrVirtual(ev, tournName, catName)) continue;
        if (evMap.has(ev.eventId)) continue;

        evMap.set(ev.eventId, {
          eventId: ev.eventId,
          gameId: ev.gameId || '',
          home: ev.homeTeamName || '',
          away: ev.awayTeamName || '',
          match: `${ev.homeTeamName || ''} vs ${ev.awayTeamName || ''}`.trim(),
          startTime: ev.estimateStartTime || 0,
          sportId: ev.sport?.id || sportId,
          sportName: ev.sport?.name || '',
          categoryId: ev.sport?.category?.id || t.categoryId || '',
          country: catName || ev.sport?.category?.name || '',
          tournamentId: t.id || ev.sport?.category?.tournament?.id || tid,
          league: tournName || ev.sport?.category?.tournament?.name || ''
        });
      }
    }
  }

  return Array.from(evMap.values());
}

async function fetchEventDetails(request, eventId, productId = 3) {
  const url = `${BASE_URL}/api/gh/factsCenter/event?eventId=${encodeURIComponent(eventId)}&productId=${productId}&_t=${Date.now()}`;
  const res = await request.get(url, { headers: HEADERS });
  const json = await res.json();
  const ev = json?.data;
  if (!ev || ev.status !== 0 || isSrlOrVirtual(ev)) return null;

  const activeMarkets = (ev.markets || [])
    .filter(m => m && m.status === 0)
    .map(m => ({
      ...m,
      outcomes: (m.outcomes || []).filter(o => o && o.isActive === 1)
    }))
    .filter(m => m.outcomes.length > 0);

  return {
    ...ev,
    markets: activeMarkets
  };
}

async function fetchOutcomesBatch(request, items, batchSize = 150) {
  const results = [];
  const seen = new Set();

  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize).map(item => ({
      eventId: item.eventId,
      marketId: String(item.marketId),
      outcomeId: String(item.outcomeId),
      specifier: item.specifier ? String(item.specifier) : null
    }));

    const res = await request.post(`${BASE_URL}/api/gh/factsCenter/Outcomes`, {
      headers: HEADERS,
      data: chunk
    });
    const json = await res.json();
    const events = Array.isArray(json?.data) ? json.data : [];

    for (const ev of events) {
      if (!ev || ev.status !== 0) continue;
      if (isSrlOrVirtual(ev)) continue;

      for (const m of (ev.markets || [])) {
        if (!m || m.status !== 0) continue;
        for (const o of (m.outcomes || [])) {
          if (!o || o.isActive !== 1) continue;

          const odds = Number.parseFloat(o.odds || '0');
          const prob = Number.parseFloat(o.probability || '0');
          if (!Number.isFinite(odds) || odds <= 1.0) continue;

          const spec = m.specifier || '';
          const dedupKey = `${ev.eventId}|${m.id}|${spec}|${o.id}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          const rtp = Number.isFinite(prob) && prob > 0 ? +(odds * prob).toFixed(6) : 0;
          const sportId = ev.sport?.id || SPORTS.FOOTBALL;

          results.push({
            eventId: ev.eventId,
            gameId: ev.gameId || '',
            home: ev.homeTeamName || '',
            away: ev.awayTeamName || '',
            match: `${ev.homeTeamName || ''} vs ${ev.awayTeamName || ''}`.trim(),
            startTime: ev.estimateStartTime || 0,
            sportId,
            sportName: ev.sport?.name || 'Football',
            categoryId: ev.sport?.category?.id || '',
            country: ev.sport?.category?.name || '',
            tournamentId: ev.sport?.category?.tournament?.id || '',
            league: ev.sport?.category?.tournament?.name || '',
            marketId: String(m.id),
            specifier: spec,
            product: m.product || 3,
            group: m.group || 'Main',
            marketDesc: m.desc || '',
            outcomeId: String(o.id),
            outcomeDesc: o.desc || '',
            odds,
            prob: Number.isFinite(prob) ? prob : 0,
            voidProbability: o.voidProbability || '0E-10',
            rtp,
            isActive: o.isActive === 1,
            wap_item: buildWapItemFromLive(ev, m, o)
          });
        }
      }
    }
  }

  return results;
}

function buildWapItemFromLive(evOrLeg, m, o) {
  let ev, market, outcome;

  if (m && o) {
    ev = {
      eventId: evOrLeg.eventId,
      gameId: evOrLeg.gameId || '10000',
      home: evOrLeg.homeTeamName || evOrLeg.home || '',
      away: evOrLeg.awayTeamName || evOrLeg.away || '',
      startTime: evOrLeg.estimateStartTime || evOrLeg.startTime || 0,
      sportId: evOrLeg.sport?.id || evOrLeg.sportId || SPORTS.FOOTBALL,
      sportName: evOrLeg.sport?.name || evOrLeg.sportName || 'Football',
      categoryId: evOrLeg.sport?.category?.id || evOrLeg.categoryId || 'sr:category:1',
      country: evOrLeg.sport?.category?.name || evOrLeg.country || 'International',
      tournamentId: evOrLeg.sport?.category?.tournament?.id || evOrLeg.tournamentId || 'sr:tournament:1',
      league: evOrLeg.sport?.category?.tournament?.name || evOrLeg.league || ''
    };
    market = {
      id: String(m.id),
      specifier: m.specifier || '',
      product: m.product || 3,
      desc: m.desc || '',
      group: m.group || 'Main'
    };
    outcome = {
      id: String(o.id),
      odds: String(o.odds),
      probability: String(o.probability || '0.80'),
      voidProbability: String(o.voidProbability || '0E-10'),
      desc: o.desc || ''
    };
  } else {
    const leg = evOrLeg || {};
    if (leg.wap_item && leg.wap_item.key && leg.wap_item.marketInfo && leg.wap_item.outcomeInfo) {
      return leg.wap_item;
    }
    const [parsedHome, parsedAway] = (leg.match || '').split(/\s+vs\.?\s+/i);
    ev = {
      eventId: leg.eventId || '',
      gameId: leg.gameId || '10000',
      home: leg.home || parsedHome || '',
      away: leg.away || parsedAway || '',
      startTime: leg.estimateStartTime || leg.startTime || 0,
      sportId: leg.sportId || SPORTS.FOOTBALL,
      sportName: leg.sportName || 'Football',
      categoryId: leg.categoryId || 'sr:category:1',
      country: leg.country || 'International',
      tournamentId: leg.tournamentId || 'sr:tournament:1',
      league: leg.league || ''
    };
    market = {
      id: String(leg.marketId || '1'),
      specifier: leg.specifier || '',
      product: leg.product || 3,
      desc: leg.marketDesc || leg.label || '',
      group: leg.group || 'Main'
    };
    outcome = {
      id: String(leg.outcomeId || '1'),
      odds: String(leg.odds ?? ''),
      probability: String(leg.prob ?? leg.probability ?? '0.80'),
      voidProbability: String(leg.voidProbability || '0E-10'),
      desc: leg.outcomeDesc || ''
    };
  }

  const spec = market.specifier || '';
  const mIdStr = String(market.id);
  const fullMId = spec ? `${mIdStr}?${spec}` : mIdStr;
  const oIdStr = String(outcome.id);
  const sportNum = String(ev.sportId).split(':').pop() || '1';

  const outcomePayload = {
    id: oIdStr,
    odds: outcome.odds,
    probability: outcome.probability,
    voidProbability: outcome.voidProbability,
    isActive: 1,
    desc: outcome.desc,
    statusDesc: '',
    showOdds: true
  };

  return {
    away: ev.away,
    categoryId: ev.categoryId,
    categoryName: ev.country,
    eventId: ev.eventId,
    estimateStartTime: ev.startTime,
    gameId: ev.gameId,
    home: ev.home,
    sportId: ev.sportId,
    sportName: ev.sportName,
    key: `${ev.sportId}_${ev.eventId}_${fullMId}_${oIdStr}`,
    tournamentId: ev.tournamentId,
    tournamentName: ev.league,
    isFinish: false,
    isInterrupted: false,
    topic: `${sportNum}^1^${ev.tournamentId}^${ev.eventId}^~^${mIdStr}^${spec || '~'}`,
    marketInfo: {
      id: fullMId,
      marketId: mIdStr,
      specifier: spec || undefined,
      product: market.product,
      desc: market.desc,
      status: 0,
      group: market.group,
      outcomes: [outcomePayload],
      banned: false
    },
    outcomeInfo: { ...outcomePayload },
    icon: SPORT_ICONS[ev.sportId] || 'm-icon-football',
    simInvalid: null,
    pushTime: Date.now()
  };
}

module.exports = {
  BASE_URL,
  HEADERS,
  SPORTS,
  FULL_BONUS_SPORTS,
  isSrlOrVirtual,
  fetchBonusPlans,
  fetchEventsByOrder,
  fetchTournamentEvents,
  fetchEventDetails,
  fetchOutcomesBatch,
  buildWapItemFromLive
};
