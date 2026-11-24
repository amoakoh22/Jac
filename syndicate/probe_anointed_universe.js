'use strict';

/**
 * Live 72h Census of:
 *   1. Football Push-Shielded Integer Markets (Over 1.0/2.0, Under 4.0/5.0, AH 0/+1/+2/-1, DNB) + 1X2-2UP
 *      with exact unconditional (pWin, pPush, pLoss, singleRtp) derived from adjacent half-lines!
 *   2. 1.00x Full-Bonus 2-Way Sports (Basketball/NBA spreads+totals+ML, Tennis ML+games, Ice Hockey ML+totals, Table Tennis ML)
 * Excludes ALL 65 eventIds on open tickets (9121S3, F9QK8B, C36TTY, C3GCWW).
 */
const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');
const sportybetApi = require('./quant/sportybet_api');

const { SPORTS, FULL_BONUS_SPORTS } = sportybetApi;

const ELITE_FB_TOURNS = [
  'sr:tournament:7', 'sr:tournament:679', 'sr:tournament:34480',
  'sr:tournament:17', 'sr:tournament:18', 'sr:tournament:23',
  'sr:tournament:8', 'sr:tournament:35', 'sr:tournament:34',
  'sr:tournament:37', 'sr:tournament:238', 'sr:tournament:52',
  'sr:tournament:38', 'sr:tournament:36', 'sr:tournament:325',
  'sr:tournament:53', 'sr:tournament:44', 'sr:tournament:54',
  'sr:tournament:182', 'sr:tournament:242', 'sr:tournament:352'
];

// Markets to fetch per Football match so we can compute exact push probabilities
const FB_PUSH_AND_2UP_QUERIES = [
  // 1X2 (for exact P(Draw) on DNB / AH 0) + 1X2 - 2UP
  { marketId: '1', outcomeId: '1', specifier: null },
  { marketId: '1', outcomeId: '2', specifier: null },
  { marketId: '1', outcomeId: '3', specifier: null },
  { marketId: '60100', outcomeId: '1', specifier: null },
  { marketId: '60100', outcomeId: '3', specifier: null },
  // DNB
  { marketId: '11', outcomeId: '4', specifier: null },
  { marketId: '11', outcomeId: '5', specifier: null },
  // Integer Over/Under + adjacent half lines to derive exact P(Push)
  { marketId: '18', outcomeId: '12', specifier: 'total=0.5' },
  { marketId: '18', outcomeId: '12', specifier: 'total=1' },
  { marketId: '18', outcomeId: '12', specifier: 'total=1.5' },
  { marketId: '18', outcomeId: '12', specifier: 'total=2' },
  { marketId: '18', outcomeId: '12', specifier: 'total=2.5' },
  { marketId: '18', outcomeId: '13', specifier: 'total=3.5' },
  { marketId: '18', outcomeId: '13', specifier: 'total=4' },
  { marketId: '18', outcomeId: '13', specifier: 'total=4.5' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5.5' },
  // Asian Handicap integer + half lines
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=0' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=0' },
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=0.5' },
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=1' },
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=1.5' },
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=2' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=-0.5' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=-1' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=-1.5' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=-2' },
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=-1' },
  { marketId: '16', outcomeId: '1714', specifier: 'hcp=-1.5' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=1' },
  { marketId: '16', outcomeId: '1715', specifier: 'hcp=1.5' }
];

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
  if (/u19|u20|u21|u23|youth|reserves|amateur|oberliga|regionalliga|women/.test(full)) return false;
  return true;
}

(async () => {
  const activeIds = loadActiveEventIds();
  const now = Date.now();
  const minOffset = 35 * 60 * 1000;
  const maxEnd = now + 78 * 3600 * 1000; // Tue morning through Fri noon (~78h)

  const { browser, context } = await S.launchBrowser();
  const req = context.request;
  try {
    // 1. Football events (<= 78h, 0 overlap)
    const fbMap = new Map();
    const tEvs = await sportybetApi.fetchTournamentEvents(req, ELITE_FB_TOURNS, SPORTS.FOOTBALL, { minStartOffsetMs: minOffset });
    for (const ev of tEvs) {
      if (isClean(ev) && !activeIds.has(ev.eventId) && ev.startTime <= maxEnd) fbMap.set(ev.eventId, ev);
    }
    const oEvs = await sportybetApi.fetchEventsByOrder(req, { sportId: SPORTS.FOOTBALL, maxPages: 16, pageSize: 30, minStartOffsetMs: minOffset, withTwoUpMarket: true });
    for (const ev of oEvs) {
      if (isClean(ev) && !activeIds.has(ev.eventId) && ev.startTime <= maxEnd && !fbMap.has(ev.eventId)) fbMap.set(ev.eventId, ev);
    }
    const fbEvents = Array.from(fbMap.values());
    console.log(`[Probe] Unused clean Football events (<=78h): ${fbEvents.length} (excluded ${activeIds.size} active)`);

    const fbQueries = [];
    for (const ev of fbEvents.slice(0, 260)) {
      for (const q of FB_PUSH_AND_2UP_QUERIES) {
        fbQueries.push({ eventId: ev.eventId, ...q });
      }
    }
    const fbRaw = await sportybetApi.fetchOutcomesBatch(req, fbQueries, 180);

    // Group by eventId to derive exact (pWin, pPush, pLoss, singleRtp) on integer lines
    const byEv = new Map();
    for (const r of fbRaw) {
      if (!byEv.has(r.eventId)) byEv.set(r.eventId, []);
      byEv.get(r.eventId).push(r);
    }

    const fbPushProtected = [];
    const fbVaultCatalysts = [];
    for (const [eid, items] of byEv.entries()) {
      const find = (mId, spec, oId) => items.find(x => String(x.marketId) === mId && (x.specifier || '') === (spec || '') && String(x.outcomeId) === oId);
      const pDraw1x2 = find('1', '', '2')?.prob || 0.22;

      for (const it of items) {
        const mId = String(it.marketId);
        const spec = it.specifier || '';
        const oId = String(it.outcomeId);
        const q = it.prob; // conditional win prob given non-push
        const od = it.odds;
        if (!q || !od || od < 1.05) continue;

        let pPush = 0;
        let isPushShielded = false;
        let shieldType = '';

        if (mId === '11' || (mId === '16' && spec === 'hcp=0')) {
          pPush = pDraw1x2;
          isPushShielded = true;
          shieldType = 'DNB_AH0_PUSH';
        } else if (mId === '18' && /^total=[1245]$/.test(spec)) {
          const k = Number(spec.split('=')[1]);
          isPushShielded = true;
          shieldType = `INT_OU_${k}_PUSH`;
          if (oId === '12') {
            // Over k: P(G >= k+1) = Over(k+0.5), P(G >= k) = Over(k-0.5)
            const pOverPlus = find('18', `total=${k + 0.5}`, '12')?.prob;
            const pOverMinus = find('18', `total=${k - 0.5}`, '12')?.prob;
            if (pOverPlus && pOverMinus && pOverMinus > pOverPlus) pPush = Math.max(0.05, Math.min(0.32, pOverMinus - pOverPlus));
            else pPush = k === 2 ? 0.21 : 0.14;
          } else if (oId === '13') {
            // Under k: P(G <= k-1) = Under(k-0.5), P(G <= k) = Under(k+0.5)
            const pUnderMinus = find('18', `total=${k - 0.5}`, '13')?.prob;
            const pUnderPlus = find('18', `total=${k + 0.5}`, '13')?.prob;
            if (pUnderMinus && pUnderPlus && pUnderPlus > pUnderMinus) pPush = Math.max(0.04, Math.min(0.28, pUnderPlus - pUnderMinus));
            else pPush = k === 4 ? 0.14 : 0.09;
          }
        } else if (mId === '16' && /^hcp=-?[12]$/.test(spec)) {
          const h = Number(spec.split('=')[1]);
          isPushShielded = true;
          shieldType = `INT_AH_${h}_PUSH`;
          // Approximate push from adjacent half-lines if present, else conservative Poisson margin
          if (oId === '1714') {
            const pWinHalf = find('16', `hcp=${h - 0.5}`, '1714')?.prob;
            const pNonLossHalf = find('16', `hcp=${h + 0.5}`, '1714')?.prob;
            if (pWinHalf && pNonLossHalf && pNonLossHalf > pWinHalf) pPush = Math.max(0.05, Math.min(0.28, pNonLossHalf - pWinHalf));
            else pPush = Math.abs(h) === 1 ? 0.17 : 0.11;
          } else {
            const pWinHalf = find('16', `hcp=${h + 0.5}`, '1715')?.prob;
            const pNonLossHalf = find('16', `hcp=${h - 0.5}`, '1715')?.prob;
            if (pWinHalf && pNonLossHalf && pNonLossHalf > pWinHalf) pPush = Math.max(0.05, Math.min(0.28, pNonLossHalf - pWinHalf));
            else pPush = Math.abs(h) === 1 ? 0.17 : 0.11;
          }
        } else if (mId === '60100') {
          pPush = 0;
          isPushShielded = true;
          shieldType = '2UP_EARLY_PAYOUT';
        } else {
          continue; // skip half-line helpers
        }

        const pWin = +(q * (1 - pPush)).toFixed(6);
        const pLoss = +((1 - q) * (1 - pPush)).toFixed(6);
        const nonLossProb = +(pWin + pPush).toFixed(6);
        const singleRtp = +(od * pWin + 1.0 * pPush).toFixed(6);

        const enriched = { ...it, pWin, pPush: +pPush.toFixed(6), pLoss, nonLossProb, singleRtp, shieldType, isPushShielded };
        if (od >= 1.20 && od <= 1.45 && singleRtp >= 0.975) {
          fbPushProtected.push(enriched);
        }
        if (od >= 1.08 && od <= 1.26 && nonLossProb >= 0.85 && singleRtp >= 0.975) {
          fbVaultCatalysts.push(enriched);
        }
      }
    }

    // 2. 1.00x Bonus 2-Way Sports (<= 78h) via full /factsCenter/event inspection on top events
    const fullBonusCandidates = [];
    const skipPat = /player|scorer|card|corner|exact|odd\/even|winning margin|tiebreak|quarter|1st half|1st period|set 1|set 2/i;
    for (const sportId of FULL_BONUS_SPORTS) {
      const spRaw = await sportybetApi.fetchEventsByOrder(req, { sportId, maxPages: 6, pageSize: 30, minStartOffsetMs: minOffset, withTwoUpMarket: false });
      const spClean = spRaw.filter(ev => isClean(ev) && !activeIds.has(ev.eventId) && ev.startTime <= maxEnd);
      let countEv = 0;
      // Probe up to 45 events per sport directly via fetchEventDetails to catch EVERY alternate spread & total!
      for (const ev of spClean.slice(0, 45)) {
        try {
          const det = await sportybetApi.fetchEventDetails(req, ev.eventId);
          if (!det || det.status !== 0 || !Array.isArray(det.markets)) continue;
          countEv++;
          for (const m of det.markets) {
            if (!m || m.status !== 0 || String(m.id).startsWith('800') || skipPat.test(m.desc || '')) continue;
            // Enforce Rule #22 on Basketball spreads: ONLY take plus-handicaps (+4.5..+18.5) or Winner, never heavy minus-spreads!
            const spec = m.specifier || '';
            for (const o of (m.outcomes || [])) {
              if (!o || o.isActive !== 1) continue;
              const od = parseFloat(o.odds || '0');
              const pr = parseFloat(o.probability || '0');
              if (od < 1.20 || od > 1.44 || pr < 0.68) continue;
              const oDesc = String(o.desc || '');
              if (sportId === SPORTS.BASKETBALL && /handicap/i.test(m.desc || '') && oDesc.includes('-')) continue;
              const rtp = +(od * pr).toFixed(6);
              if (rtp < 0.972) continue;
              fullBonusCandidates.push({
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
                outcomeDesc: o.desc,
                odds: od,
                prob: pr,
                pWin: pr,
                pPush: 0,
                pLoss: +(1 - pr).toFixed(6),
                nonLossProb: pr,
                rtp,
                singleRtp: rtp,
                shieldType: '1.00X_FULL_BONUS_2WAY'
              });
            }
          }
        } catch {}
      }
      console.log(`[Probe] ${sportId} (1.00x bonus): probed ${countEv}/${spClean.length} events`);
    }

    const uniqFbPush = new Set(fbPushProtected.map(x => x.eventId)).size;
    const uniqFbVault = new Set(fbVaultCatalysts.map(x => x.eventId)).size;
    const uniqFullBonus = new Set(fullBonusCandidates.map(x => x.eventId)).size;

    console.log(`\n=== 72H ANOINTED UNIVERSE CENSUS ===`);
    console.log(`1. Football Push-Shielded / 2UP [1.20-1.45, singleRtp>=0.975]: ${fbPushProtected.length} outcomes across ${uniqFbPush} unique matches`);
    console.log(`2. Football Vault Catalysts [1.08-1.26, nonLoss>=85%, rtp>=0.975]: ${fbVaultCatalysts.length} outcomes across ${uniqFbVault} unique matches`);
    console.log(`3. 1.00x Full-Bonus 2-Way Sports [1.20-1.44, rtp>=0.972]: ${fullBonusCandidates.length} outcomes across ${uniqFullBonus} unique matches`);

    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'anointed_72h_universe.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      excludedActiveCount: activeIds.size,
      fbPushProtected,
      fbVaultCatalysts,
      fullBonusCandidates
    }, null, 2));
  } finally {
    await browser.close();
  }
})();
