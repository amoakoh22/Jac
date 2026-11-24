'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.resolve(__dirname, '../..');
const DEFAULT_HEURISTICS_PATH = path.join(ROOT_DIR, 'data', 'syndicate_heuristics.json');
const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'syndicate_ledger.sqlite');

const TEAM_ALIASES = Object.freeze({
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'psg': 'paris saint germain',
  'paris sg': 'paris saint germain',
  'aj auxerre': 'auxerre',
  'athletic club': 'athletic bilbao',
  'athletic club bilbao': 'athletic bilbao',
  'inter milan': 'inter',
  'fc internazionale': 'inter',
  'fc bayern munchen': 'bayern munich',
  'bayern munchen': 'bayern munich',
  'fc koln': 'cologne',
  '1 fc koln': 'cologne',
  'olympique marseille': 'marseille',
  'olympique de marseille': 'marseille',
  'olympique lyonnais': 'lyon',
  'as monaco': 'monaco',
  'fc metz': 'metz',
  'estac troyes': 'troyes',
  'fc lorient': 'lorient',
  'afc bournemouth': 'bournemouth',
  'wolverhampton wanderers': 'wolves',
  'wolverhampton': 'wolves',
  'qpr': 'queens park rangers',
  'spurs': 'tottenham hotspur',
  'tottenham': 'tottenham hotspur',
  'aston villa': 'aston villa',
  'real sociedad': 'real sociedad',
  'celta vigo': 'celta de vigo'
});

const FORTRESS_FRAGILE_MARKETS = new Set([
  'UNDER_4_5',
  'UNDER_3_5',
  '1H_UNDER_2_5',
  '1H_GG_NG_NO',
  '2H_OVER_0_5',
  'HCP_0_1_FAV',
  'PLAIN_1X2_FAV_ACCUM'
]);

function normalizeTeamName(name) {
  if (!name) return '';
  let s = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (TEAM_ALIASES[s]) return TEAM_ALIASES[s];

  // Strip common prefix/suffix club tags
  const stripped = s
    .replace(/^(fc|cf|sc|ac|as|aj|rc|cd|ud|sd|ca|ss|sv|vfl|vfb|tsg|fk|sk|bk|ik|if|nk|gnk|pfc|cska|us|ogc|estac|afc|rfc)\s+/g, '')
    .replace(/\s+(fc|cf|sc|ac|afc|cf|bc|sv|fk|sk|bk|ik|if|united|utd)$/g, '')
    .trim();

  if (TEAM_ALIASES[stripped]) return TEAM_ALIASES[stripped];
  return stripped || s;
}

function parseMatchTeams(matchNameOrObj) {
  if (!matchNameOrObj) return null;
  if (typeof matchNameOrObj === 'object') {
    const h = matchNameOrObj.home || matchNameOrObj.homeTeamName || '';
    const a = matchNameOrObj.away || matchNameOrObj.awayTeamName || '';
    if (h && a) {
      return {
        home: normalizeTeamName(h),
        away: normalizeTeamName(a),
        raw: `${h} vs ${a}`
      };
    }
    if (matchNameOrObj.match || matchNameOrObj.match_name) {
      return parseMatchTeams(matchNameOrObj.match || matchNameOrObj.match_name);
    }
    return null;
  }

  const str = String(matchNameOrObj).trim();
  const parts = str.split(/\s+(?:vs\.?|v\.?|-)\s+/i);
  if (parts.length >= 2) {
    return {
      home: normalizeTeamName(parts[0]),
      away: normalizeTeamName(parts.slice(1).join(' ')),
      raw: str
    };
  }
  const norm = normalizeTeamName(str);
  return norm ? { home: norm, away: '', raw: str } : null;
}

function teamsRoughlyMatch(t1, t2) {
  if (!t1 || !t2) return false;
  if (t1 === t2) return true;
  if (t1.length >= 4 && t2.length >= 4 && (t1.includes(t2) || t2.includes(t1))) return true;
  const tok1 = t1.split(' ').filter(w => w.length >= 3);
  const tok2 = t2.split(' ').filter(w => w.length >= 3);
  if (tok1.length > 0 && tok2.length > 0) {
    const set2 = new Set(tok2);
    const shared = tok1.filter(w => set2.has(w));
    if (shared.length >= Math.min(tok1.length, tok2.length)) return true;
  }
  return false;
}

function matchesActiveFixture(candidate, activeMatches, activeEventIds) {
  if (!candidate) return false;
  const eventId = candidate.eventId || candidate.event_id;
  if (eventId && activeEventIds && activeEventIds.has(String(eventId))) {
    return true;
  }

  const candTeams = parseMatchTeams(candidate);
  if (!candTeams || !candTeams.home) return false;

  for (const active of (activeMatches || [])) {
    if (!active || !active.home) continue;
    if (candTeams.away && active.away) {
      const direct = teamsRoughlyMatch(candTeams.home, active.home) && teamsRoughlyMatch(candTeams.away, active.away);
      const swapped = teamsRoughlyMatch(candTeams.home, active.away) && teamsRoughlyMatch(candTeams.away, active.home);
      if (direct || swapped) return true;
    } else if (!candTeams.away && !active.away) {
      if (teamsRoughlyMatch(candTeams.home, active.home)) return true;
    }
  }
  return false;
}

function normalizeGoalLine(numStr) {
  const s = String(numStr || '').trim();
  if (!s) return '';
  return s.includes('.') ? s.replace('.', '_') : `${s}_0`;
}

function canonicalizeMarket(candidate) {
  if (!candidate) return 'UNKNOWN';
  if (typeof candidate === 'string') {
    return canonicalizeFromText(candidate);
  }

  // If already explicitly tagged with canonical marketKey and no raw SportyBet IDs override
  const marketId = candidate.marketId !== undefined && candidate.marketId !== null ? String(candidate.marketId) : '';
  const specifier = String(candidate.specifier || '').toLowerCase().trim();
  const outcomeId = candidate.outcomeId !== undefined && candidate.outcomeId !== null ? String(candidate.outcomeId) : '';
  const marketDesc = String(candidate.marketDesc || candidate.market_name || '').toLowerCase();
  const outcomeDesc = String(candidate.outcomeDesc || candidate.selection || '').toLowerCase();
  const label = String(candidate.label || '').toLowerCase();
  const combinedText = `${marketDesc} ${outcomeDesc} ${label}`.trim();

  // Structured SportyBet market IDs first
  if (marketId === '75' && (outcomeId === '76' || outcomeDesc === 'no')) {
    return '1H_GG_NG_NO';
  }
  if (marketId === '14') {
    if (specifier.includes('0:1') || specifier.includes('1:0') || combinedText.includes('0:1') || combinedText.includes('-1')) {
      return 'HCP_0_1_FAV';
    }
    return `HCP_${specifier.replace(/[^a-z0-9]+/g, '_').toUpperCase() || 'OTHER'}`;
  }
  if (marketId === '90') {
    if ((specifier === 'total=0.5' || outcomeDesc.includes('over 0.5')) && (outcomeId === '12' || outcomeDesc.includes('over'))) {
      return '2H_OVER_0_5';
    }
  }
  if (marketId === '68') {
    if ((specifier === 'total=2.5' || outcomeDesc.includes('under 2.5')) && (outcomeId === '13' || outcomeDesc.includes('under'))) {
      return '1H_UNDER_2_5';
    }
    const m = (specifier || outcomeDesc).match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const dir = (outcomeId === '12' || outcomeDesc.includes('over')) ? 'OVER' : 'UNDER';
      return `1H_${dir}_${normalizeGoalLine(m[1])}`;
    }
  }
  if (marketId === '1') {
    return 'PLAIN_1X2_FAV_ACCUM';
  }
  if (marketId === '60100') {
    return '1X2_2UP';
  }
  if (marketId === '60200') {
    return '1X2_1UP';
  }
  if (marketId === '10') {
    if (outcomeId === '9' || outcomeDesc.includes('1x') || outcomeDesc.includes('home or draw')) return 'DOUBLE_CHANCE_1X';
    if (outcomeId === '11' || outcomeDesc.includes('x2') || outcomeDesc.includes('draw or away')) return 'DOUBLE_CHANCE_X2';
    if (outcomeId === '10' || outcomeDesc.includes('12') || outcomeDesc.includes('home or away')) return 'DOUBLE_CHANCE_12';
    return 'DOUBLE_CHANCE';
  }
  if (marketId === '18') {
    const m = (specifier || outcomeDesc).match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const line = normalizeGoalLine(m[1]);
      if (outcomeId === '12' || outcomeDesc.includes('over')) return `OVER_${line}`;
      if (outcomeId === '13' || outcomeDesc.includes('under')) return `UNDER_${line}`;
    }
  }
  if (marketId === '19') {
    const m = (specifier || outcomeDesc).match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const line = normalizeGoalLine(m[1]);
      const dir = (outcomeId === '12' || outcomeDesc.includes('over')) ? 'OVER' : 'UNDER';
      return `HOME_${dir}_${line}`;
    }
  }
  if (marketId === '20') {
    const m = (specifier || outcomeDesc).match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const line = normalizeGoalLine(m[1]);
      const dir = (outcomeId === '12' || outcomeDesc.includes('over')) ? 'OVER' : 'UNDER';
      return `AWAY_${dir}_${line}`;
    }
  }
  if (marketId === '48' && (outcomeId === '76' || outcomeDesc === 'no')) {
    return 'HOME_WIN_BOTH_HALVES_NO';
  }
  if (marketId === '49' && (outcomeId === '76' || outcomeDesc === 'no')) {
    return 'AWAY_WIN_BOTH_HALVES_NO';
  }

  // Text fallback for DB rows or partially structured inputs
  const fromText = canonicalizeFromText(combinedText);
  if (fromText !== 'UNKNOWN') return fromText;

  if (candidate.marketKey) return String(candidate.marketKey).toUpperCase();
  if (marketId) {
    return `MARKET_${marketId}_${specifier.replace(/[^a-z0-9]+/g, '_')}_${outcomeId}`.replace(/_+/g, '_').toUpperCase();
  }
  return 'UNKNOWN';
}

function canonicalizeFromText(rawText) {
  const t = String(rawText || '').toLowerCase().trim();
  if (!t) return 'UNKNOWN';

  if (/(1st\s*half|1h).*?(gg\/ng|both teams to score|ng).*?\b(no|ng)\b/.test(t) || /\b1h\s*ng\b/.test(t)) {
    return '1H_GG_NG_NO';
  }
  if (/(handicap|hcp).*?(0:1|1:0|-1\b)/.test(t) || /\bhcp_0_1/.test(t)) {
    return 'HCP_0_1_FAV';
  }
  if (/(2nd\s*half|2h).*?over\s*0\.5/.test(t) || /\b2h\s*o0\.5\b/.test(t)) {
    return '2H_OVER_0_5';
  }
  if (/(1st\s*half|1h).*?under\s*2\.5/.test(t) || /\b1h\s*u2\.5\b/.test(t)) {
    return '1H_UNDER_2_5';
  }
  if (/1x2\s*-\s*2up|\b2up\b/.test(t)) return '1X2_2UP';
  if (/1x2\s*-\s*1up|\b1up\b/.test(t)) return '1X2_1UP';
  if (/double\s*chance.*\b1x\b|\bdc\s*1x\b/.test(t)) return 'DOUBLE_CHANCE_1X';
  if (/double\s*chance.*\bx2\b|\bdc\s*x2\b/.test(t)) return 'DOUBLE_CHANCE_X2';
  if (/double\s*chance.*\b12\b|\bdc\s*12\b/.test(t)) return 'DOUBLE_CHANCE_12';
  if (/away\s*team\s*to\s*win\s*both\s*halves.*\bno\b/.test(t)) return 'AWAY_WIN_BOTH_HALVES_NO';
  if (/home\s*team\s*to\s*win\s*both\s*halves.*\bno\b/.test(t)) return 'HOME_WIN_BOTH_HALVES_NO';

  const homeTeamOu = t.match(/home.*?(over|under)\s*(\d+(?:\.\d+)?)/);
  if (homeTeamOu) {
    return `HOME_${homeTeamOu[1].toUpperCase()}_${normalizeGoalLine(homeTeamOu[2])}`;
  }
  const awayTeamOu = t.match(/away.*?(over|under)\s*(\d+(?:\.\d+)?)/);
  if (awayTeamOu) {
    return `AWAY_${awayTeamOu[1].toUpperCase()}_${normalizeGoalLine(awayTeamOu[2])}`;
  }

  const ou = t.match(/\b(over|under)\s*(\d+(?:\.\d+)?)\b/);
  if (ou && !t.includes('1st half') && !t.includes('2nd half') && !t.includes('1h') && !t.includes('2h')) {
    return `${ou[1].toUpperCase()}_${normalizeGoalLine(ou[2])}`;
  }

  if (/^(home|away|draw)$/.test(t) || /\b1x2\b/.test(t)) {
    return 'PLAIN_1X2_FAV_ACCUM';
  }

  return 'UNKNOWN';
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
  return Boolean(row);
}

function getTableColumns(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map(r => r.name));
}

function loadLearningContext(opts = {}) {
  const heuristicsPath = opts.heuristicsPath || DEFAULT_HEURISTICS_PATH;
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;

  let heuristics = { version: '0.0.0', rules: {}, dynamic_weights: {} };
  if (heuristicsPath && fs.existsSync(heuristicsPath)) {
    heuristics = JSON.parse(fs.readFileSync(heuristicsPath, 'utf8'));
  }

  const rules = heuristics.rules || {};
  const rule28 = rules.rule_28_friday_postmortem_market_ban || {};
  const rule29 = rules.rule_29_zero_vig_bonus_sweet_spot || {};
  const dynamicWeights = heuristics.dynamic_weights || {};

  const bannedMarkets = new Set(
    (rule28.banned_markets || []).map(m => String(m).toUpperCase().trim())
  );

  const bannedMarketLeaguePairs = Array.isArray(rule28.banned_market_league_pairs)
    ? rule28.banned_market_league_pairs.map(p => ({
        market: String(p.market || '').toUpperCase().trim(),
        leaguePattern: String(p.league_pattern || p.leaguePattern || '').toLowerCase().trim(),
        reason: p.reason || 'Heuristics market-league ban'
      }))
    : [];

  // Backward-compatibility with v2.0.0 tag EERSTE_DIVISIE_OVER_2
  if (bannedMarkets.has('EERSTE_DIVISIE_OVER_2')) {
    const alreadyHas = bannedMarketLeaguePairs.some(
      p => p.market === 'OVER_2_0' && p.leaguePattern.includes('eerste divisie')
    );
    if (!alreadyHas) {
      bannedMarketLeaguePairs.push({
        market: 'OVER_2_0',
        leaguePattern: 'eerste divisie',
        reason: 'Rule #28 Eerste Divisie Over 2.0 ban'
      });
    }
  }

  const marketRiskWeights = new Map();
  if (dynamicWeights.market_risk_weights && typeof dynamicWeights.market_risk_weights === 'object') {
    for (const [k, v] of Object.entries(dynamicWeights.market_risk_weights)) {
      marketRiskWeights.set(String(k).toUpperCase(), {
        won: Number(v.won || 0),
        lost: Number(v.lost || 0),
        empiricalHitRate: Number(v.empirical_hit_rate ?? v.empiricalHitRate ?? 1),
        penalty: Number(v.penalty || 0),
        banned: Boolean(v.banned)
      });
    }
  }

  const activeMatches = [];
  const activeEventIds = new Set();
  const activeBookingCodes = new Set();
  const marketLossStats = new Map();
  const marketLeagueLossStats = new Map();

  if (dbPath && fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 1. Active Fixture Firewall: syndicate_creator_anchor_ledger + syndicate_codehub_bullets
      if (tableExists(db, 'syndicate_creator_anchor_ledger') && tableExists(db, 'syndicate_codehub_bullets')) {
        const anchorCols = getTableColumns(db, 'syndicate_creator_anchor_ledger');
        const hasEventId = anchorCols.has('event_id');
        const selectCols = hasEventId
          ? 'a.booking_code, a.match_name, a.event_id'
          : 'a.booking_code, a.match_name';

        const rows = db.prepare(`
          SELECT ${selectCols}
          FROM syndicate_creator_anchor_ledger a
          INNER JOIN syndicate_codehub_bullets b
            ON a.booking_code = b.booking_code
          WHERE b.status IN ('IN_PROGRESS', 'PENDING')
        `).all();

        for (const r of rows) {
          if (r.booking_code) activeBookingCodes.add(String(r.booking_code));
          if (hasEventId && r.event_id) activeEventIds.add(String(r.event_id));
          const parsed = parseMatchTeams(r.match_name);
          if (parsed) activeMatches.push(parsed);
        }
      }

      // 2. Active Fixture Firewall: syndicate_legs + syndicate_tickets
      if (tableExists(db, 'syndicate_legs') && tableExists(db, 'syndicate_tickets')) {
        const legCols = getTableColumns(db, 'syndicate_legs');
        const hasEventId = legCols.has('event_id');
        const selectCols = hasEventId
          ? 't.booking_code, l.match_name, l.event_id'
          : 't.booking_code, l.match_name';

        const rows = db.prepare(`
          SELECT ${selectCols}
          FROM syndicate_legs l
          INNER JOIN syndicate_tickets t
            ON l.ticket_id = t.ticket_id
          WHERE t.status IN ('IN_PROGRESS', 'PENDING')
        `).all();

        for (const r of rows) {
          if (r.booking_code) activeBookingCodes.add(String(r.booking_code));
          if (hasEventId && r.event_id) activeEventIds.add(String(r.event_id));
          const parsed = parseMatchTeams(r.match_name);
          if (parsed) activeMatches.push(parsed);
        }
      }

      // 2b. Live API Audit Firewall: ingest exact eventIds from runtime/live_api_audit_latest.json
      const liveAuditPath = opts.liveAuditPath || path.join(ROOT_DIR, 'runtime', 'live_api_audit_latest.json');
      if (!opts.dbPath && fs.existsSync(liveAuditPath)) {
        try {
          const auditJson = JSON.parse(fs.readFileSync(liveAuditPath, 'utf8'));
          const openBets = auditJson?.open?.data?.cashAbleBets || [];
          const unsettledBets = auditJson?.unsettled?.data?.entityList || [];
          for (const b of openBets.concat(unsettledBets)) {
            if (b?.shareCode) activeBookingCodes.add(String(b.shareCode));
            for (const s of (b?.selections || [])) {
              if (s?.eventId) activeEventIds.add(String(s.eventId));
            }
          }
        } catch {}
      }

      // 3. Empirical Loss-Rate Model: syndicate_market_performance (preferred if populated)
      let loadedFromPerfTable = false;
      if (tableExists(db, 'syndicate_market_performance')) {
        const perfRows = db.prepare(`
          SELECT market_key, league, total_legs, won_legs, lost_legs, empirical_hit_rate, penalty_weight, banned
          FROM syndicate_market_performance
        `).all();

        if (perfRows.length > 0) {
          loadedFromPerfTable = true;
          const allRows = [];
          const nonAllRows = [];
          const leagueRows = [];

          for (const r of perfRows) {
            const key = String(r.market_key || '').toUpperCase().trim();
            if (!key) continue;
            const leagueRaw = String(r.league || '').trim();
            const leagueUpper = leagueRaw.toUpperCase();
            if (leagueUpper === 'ALL') {
              allRows.push({ ...r, _key: key });
            } else {
              nonAllRows.push({ ...r, _key: key });
              if (leagueUpper && leagueUpper !== 'UNKNOWN') {
                leagueRows.push({ ...r, _key: key, _leagueLower: leagueRaw.toLowerCase() });
              }
            }
          }

          const mergeIntoMap = (targetMap, mapKey, r, extra = {}) => {
            const won = Number(r.won_legs || 0);
            const lost = Number(r.lost_legs || 0);
            const total = Number(r.total_legs || won + lost);
            const empiricalHitRate = total > 0 ? won / total : Number(r.empirical_hit_rate ?? 1);
            const laplaceLossRate = (lost + 1) / (total + 2);
            const hardBanned = Boolean(r.banned) || (lost >= 3 && empiricalHitRate < 0.60);

            const existing = targetMap.get(mapKey);
            if (!existing) {
              targetMap.set(mapKey, {
                ...extra,
                won,
                lost,
                total,
                empiricalHitRate: +empiricalHitRate.toFixed(6),
                laplaceLossRate: +laplaceLossRate.toFixed(6),
                penaltyWeight: Number(r.penalty_weight || 0),
                banned: hardBanned
              });
            } else {
              const nw = existing.won + won;
              const nl = existing.lost + lost;
              const nt = existing.total + total;
              const nhr = nt > 0 ? nw / nt : 1;
              targetMap.set(mapKey, {
                ...existing,
                won: nw,
                lost: nl,
                total: nt,
                empiricalHitRate: +nhr.toFixed(6),
                laplaceLossRate: +((nl + 1) / (nt + 2)).toFixed(6),
                penaltyWeight: Math.max(existing.penaltyWeight, Number(r.penalty_weight || 0)),
                banned: existing.banned || hardBanned || (nl >= 3 && nhr < 0.60)
              });
            }
          };

          // Populate global marketLossStats strictly from league='ALL' rows first
          const keysWithAllRow = new Set();
          for (const r of allRows) {
            keysWithAllRow.add(r._key);
            mergeIntoMap(marketLossStats, r._key, r);
          }

          // Fallback: aggregate non-ALL rows ONLY for market_keys that have NO 'ALL' row
          for (const r of nonAllRows) {
            if (!keysWithAllRow.has(r._key)) {
              mergeIntoMap(marketLossStats, r._key, r);
            }
          }

          // Populate per-league stats strictly in marketLeagueLossStats
          for (const r of leagueRows) {
            const leagueKey = `${r._key}::${r._leagueLower}`;
            mergeIntoMap(marketLeagueLossStats, leagueKey, r, {
              marketKey: r._key,
              league: r._leagueLower
            });
          }
        }
      }

      // 4. Fallback: aggregate WON/LOST directly from syndicate_creator_anchor_ledger (& syndicate_legs)
      if (!loadedFromPerfTable) {
        const agg = new Map();
        const recordOutcome = (marketKey, isWin) => {
          if (!marketKey || marketKey === 'UNKNOWN') return;
          if (!agg.has(marketKey)) agg.set(marketKey, { won: 0, lost: 0 });
          const entry = agg.get(marketKey);
          if (isWin) entry.won += 1;
          else entry.lost += 1;
        };

        if (tableExists(db, 'syndicate_creator_anchor_ledger')) {
          const rows = db.prepare(`
            SELECT selection, status
            FROM syndicate_creator_anchor_ledger
            WHERE status IN ('WON', 'LOST')
          `).all();
          for (const r of rows) {
            const key = canonicalizeFromText(r.selection);
            recordOutcome(key, r.status === 'WON');
          }
        }

        if (tableExists(db, 'syndicate_legs')) {
          const rows = db.prepare(`
            SELECT market_name, selection, outcome
            FROM syndicate_legs
            WHERE outcome IN ('WON', 'LOST')
          `).all();
          for (const r of rows) {
            const key = canonicalizeFromText(`${r.market_name || ''} ${r.selection || ''}`);
            recordOutcome(key, r.outcome === 'WON');
          }
        }

        for (const [key, { won, lost }] of agg.entries()) {
          const total = won + lost;
          const empiricalHitRate = total > 0 ? won / total : 1;
          const laplaceLossRate = (lost + 1) / (total + 2);
          const banned = lost >= 3 && empiricalHitRate < 0.60;
          marketLossStats.set(key, {
            won,
            lost,
            total,
            empiricalHitRate: +empiricalHitRate.toFixed(6),
            laplaceLossRate: +laplaceLossRate.toFixed(6),
            penaltyWeight: lost > 0 ? +(laplaceLossRate * 0.05).toFixed(6) : 0,
            banned
          });
        }
      }
    } finally {
      db.close();
    }
  }

  return {
    heuristicsVersion: heuristics.version || '0.0.0',
    rules,
    rule28,
    rule29,
    bannedMarkets,
    bannedMarketLeaguePairs,
    marketRiskWeights,
    activeMatches,
    activeEventIds,
    activeBookingCodes,
    marketLossStats,
    marketLeagueLossStats
  };
}

function lookupMarketStat(map, canonicalMarket) {
  if (!map || !canonicalMarket) return null;
  const direct = map.get(canonicalMarket);
  if (direct) return direct;
  if (canonicalMarket.startsWith('DOUBLE_CHANCE_')) {
    return map.get('DOUBLE_CHANCE') || null;
  }
  return null;
}

function filterAndScoreCandidate(candidate, ctx, mode = 'x100_plus_ev') {
  const reasons = [];

  const canonicalMarket = canonicalizeMarket(candidate);
  const league = String(candidate?.league || '').toLowerCase().trim();

  // 1. Active Fixture Firewall
  if (ctx && matchesActiveFixture(candidate, ctx.activeMatches, ctx.activeEventIds)) {
    reasons.push('ACTIVE_FIXTURE_OVERLAP');
  }

  // 2. Rule #28 Banned Markets (with DOUBLE_CHANCE parent fallback)
  if (
    ctx?.bannedMarkets?.has(canonicalMarket) ||
    (canonicalMarket.startsWith('DOUBLE_CHANCE_') && ctx?.bannedMarkets?.has('DOUBLE_CHANCE'))
  ) {
    reasons.push(`BANNED_MARKET:${canonicalMarket}`);
  }

  // 3. Rule #28 Banned Market-League Pairs
  for (const pair of (ctx?.bannedMarketLeaguePairs || [])) {
    const marketMatches = pair.market === canonicalMarket ||
      (canonicalMarket.startsWith('DOUBLE_CHANCE_') && pair.market === 'DOUBLE_CHANCE');
    if (marketMatches && pair.leaguePattern && league.includes(pair.leaguePattern)) {
      reasons.push(`BANNED_MARKET_LEAGUE:${canonicalMarket}@${pair.leaguePattern}`);
    }
  }

  // 4. Mode B Fortress fragile-market exclusion
  if (mode === 'fortress_98pct' && FORTRESS_FRAGILE_MARKETS.has(canonicalMarket)) {
    reasons.push(`FORTRESS_FRAGILE_MARKET:${canonicalMarket}`);
  }

  // 5. Dynamic heuristics market_risk_weights (with DOUBLE_CHANCE fallback)
  let riskPenalty = 0;
  const riskWeight = lookupMarketStat(ctx?.marketRiskWeights, canonicalMarket);
  if (riskWeight) {
    if (riskWeight.banned) {
      reasons.push(`HEURISTICS_RISK_BAN:${canonicalMarket}`);
    } else if (riskWeight.penalty > 0) {
      riskPenalty = riskWeight.penalty;
    }
  }

  // 6. Global empirical SQLite loss-rate model (with DOUBLE_CHANCE fallback)
  let empPenalty = 0;
  const empStat = lookupMarketStat(ctx?.marketLossStats, canonicalMarket);
  if (empStat) {
    if (empStat.banned || (empStat.lost >= 3 && empStat.empiricalHitRate < 0.60)) {
      reasons.push(`EMPIRICAL_LOSS_BAN:${canonicalMarket}(${empStat.won}W-${empStat.lost}L)`);
    } else if (empStat.lost > 0) {
      empPenalty = empStat.penaltyWeight > 0
        ? empStat.penaltyWeight
        : +(empStat.laplaceLossRate * 0.04).toFixed(6);
    }
  }

  // 7. Per-league empirical SQLite loss-rate model (applied ONLY when candidate.league matches)
  let leaguePenalty = 0;
  if (league && ctx?.marketLeagueLossStats) {
    for (const entry of ctx.marketLeagueLossStats.values()) {
      const marketMatches = entry.marketKey === canonicalMarket ||
        (canonicalMarket.startsWith('DOUBLE_CHANCE_') && entry.marketKey === 'DOUBLE_CHANCE');
      if (!marketMatches || !entry.league) continue;
      const leagueMatches = league === entry.league ||
        league.includes(entry.league) ||
        (league.length >= 4 && entry.league.includes(league));
      if (!leagueMatches) continue;

      if (entry.banned || (entry.lost >= 3 && entry.empiricalHitRate < 0.60)) {
        reasons.push(`EMPIRICAL_LOSS_BAN_LEAGUE:${canonicalMarket}@${entry.league}(${entry.won}W-${entry.lost}L)`);
      } else if (entry.lost > 0) {
        const lp = entry.penaltyWeight > 0
          ? entry.penaltyWeight
          : +(entry.laplaceLossRate * 0.04).toFixed(6);
        leaguePenalty = Math.max(leaguePenalty, lp);
      }
    }
  }

  // Combine riskWeight, global empirical, and league empirical penalties with Math.max (no double-penalty stacking)
  const penalty = Math.max(riskPenalty, empPenalty, leaguePenalty);

  const oddsNum = Number(candidate?.odds);
  const probNum = Number(candidate?.prob);
  const rtp = (Number.isFinite(oddsNum) && oddsNum > 0 && Number.isFinite(probNum) && probNum > 0)
    ? oddsNum * probNum
    : (Number.isFinite(Number(candidate?.rtp)) ? Number(candidate.rtp) : 0);
  const prob = Number.isFinite(probNum) ? probNum : 0;
  const baseScore = mode === 'fortress_98pct' ? prob : rtp;
  const adjustedScore = +(baseScore - penalty).toFixed(6);

  return {
    allowed: reasons.length === 0,
    canonicalMarket,
    reasons,
    penalty: +penalty.toFixed(6),
    adjustedScore
  };
}

module.exports = {
  DEFAULT_HEURISTICS_PATH,
  DEFAULT_DB_PATH,
  FORTRESS_FRAGILE_MARKETS,
  normalizeTeamName,
  parseMatchTeams,
  matchesActiveFixture,
  canonicalizeMarket,
  loadLearningContext,
  filterAndScoreCandidate
};
