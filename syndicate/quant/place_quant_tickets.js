'use strict';

/**
 * Jac Syndicate — Live +EV Quant Scanner, Builder & Safe Placement Pipeline (M3)
 *
 * Strictly powered by:
 *   - syndicate/sportybet_session.js (Playwright Chromium + keypad stake entry)
 *   - syndicate/quant/sportybet_api.js (live events, Outcomes, bonus plans)
 *   - syndicate/quant/bonus_model.js (official SportyBet Ghana bonus ladder)
 *   - syndicate/quant/learning_filter.js (Heuristics v3.0.0 + SQLite firewall)
 *   - syndicate/quant/mode_a_x100_builder.js (Mode A: x100+ +EV Zero-Vig Bonus Arb)
 *   - syndicate/quant/mode_b_fortress_builder.js (Mode B: 98%+ Combined-Prob Tail Fortress)
 *   - syndicate/quant/ticket_exporter.js (schema validation + export)
 *
 * Hard Integrity Invariants:
 *   - NEVER relax Mode A (effectiveMultiplier >= 100.0, trueExpectedRtp > 1.00, minLegRtp >= 0.980)
 *   - NEVER relax Mode B (combinedWinProb >= 0.980)
 *   - ALWAYS assert Flexi, 1UP, and EarlyGoals checkboxes are UNCHECKED in betslip DOM
 *   - ALWAYS assert exact leg count, exact stake, and live payout EV before Confirm
 *   - Wave stake cap <= GHS 15.00 total new stakes
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const S = require('../sportybet_session');
const sportybetApi = require('./sportybet_api');
const bonusModel = require('./bonus_model');
const learningFilter = require('./learning_filter');
const modeA = require('./mode_a_x100_builder');
const modeB = require('./mode_b_fortress_builder');
const exporter = require('./ticket_exporter');

const { SPORTS, FULL_BONUS_SPORTS } = sportybetApi;

const OUT_PLACEMENT_PATH = path.join(S.ROOT_DIR, 'runtime', 'quant_live_placement_latest.json');
const OUT_PLAN_PATH = path.join(S.ROOT_DIR, 'runtime', 'quant_live_plan_latest.json');

// High-liquidity Football markets for Mode A (1.20 - 1.45 band)
// All candidates are additionally filtered through learning_filter.js (Rule #28/#29 + SQLite bans)
const FOOTBALL_MODE_A_MARKETS = [
  { marketId: '10', outcomeId: '9', specifier: null, label: 'Double Chance 1X' },
  { marketId: '10', outcomeId: '11', specifier: null, label: 'Double Chance X2' },
  { marketId: '60100', outcomeId: '1', specifier: null, label: '1X2 - 2UP Home' },
  { marketId: '60100', outcomeId: '3', specifier: null, label: '1X2 - 2UP Away' },
  { marketId: '11', outcomeId: '4', specifier: null, label: 'Draw No Bet Home' },
  { marketId: '11', outcomeId: '5', specifier: null, label: 'Draw No Bet Away' },
  { marketId: '18', outcomeId: '12', specifier: 'total=1.5', label: 'Over 1.5 Goals' },
  { marketId: '18', outcomeId: '12', specifier: 'total=2.5', label: 'Over 2.5 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=3.5', label: 'Under 3.5 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=4', label: 'Under 4 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5', label: 'Under 5 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5.5', label: 'Under 5.5 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=6', label: 'Under 6 Goals' },
  { marketId: '29', outcomeId: '74', specifier: null, label: 'GG/NG: Yes' },
  { marketId: '29', outcomeId: '76', specifier: null, label: 'GG/NG: No' },
  { marketId: '19', outcomeId: '12', specifier: 'total=0.5', label: 'Home Over 0.5' },
  { marketId: '20', outcomeId: '12', specifier: 'total=0.5', label: 'Away Over 0.5' },
  { marketId: '19', outcomeId: '13', specifier: 'total=1.5', label: 'Home Under 1.5' },
  { marketId: '20', outcomeId: '13', specifier: 'total=1.5', label: 'Away Under 1.5' },
  { marketId: '19', outcomeId: '13', specifier: 'total=2.5', label: 'Home Under 2.5' },
  { marketId: '20', outcomeId: '13', specifier: 'total=2.5', label: 'Away Under 2.5' }
];

// Ultra-high-probability structural Football tail markets for Mode B (>= 98.0% combined prob)
// Strictly excludes Under 4.5, Under 3.5, 1H Under 2.5, 1H GG/NG: No, and player/card props
const FOOTBALL_MODE_B_MARKETS = [
  { marketId: '18', outcomeId: '13', specifier: 'total=6.5', label: 'Under 6.5 Goals' },
  { marketId: '18', outcomeId: '13', specifier: 'total=5.5', label: 'Under 5.5 Goals' },
  { marketId: '68', outcomeId: '13', specifier: 'total=3.5', label: '1H Under 3.5 Goals' },
  { marketId: '90', outcomeId: '13', specifier: 'total=3.5', label: '2H Under 3.5 Goals' },
  { marketId: '49', outcomeId: '76', specifier: null, label: 'Away Win Both Halves: No' },
  { marketId: '48', outcomeId: '76', specifier: null, label: 'Home Win Both Halves: No' },
  { marketId: '900027', outcomeId: '76', specifier: null, label: 'BTTS Both Halves: No' },
  { marketId: '60307', outcomeId: '76', specifier: null, label: 'Away Lead By 2: No' },
  { marketId: '60306', outcomeId: '76', specifier: null, label: 'Home Lead By 2: No' },
  { marketId: '70', outcomeId: '13', specifier: 'total=1.5', label: '1H Away Under 1.5' },
  { marketId: '69', outcomeId: '13', specifier: 'total=1.5', label: '1H Home Under 1.5' },
  { marketId: '20', outcomeId: '13', specifier: 'total=2.5', label: 'Away Under 2.5' },
  { marketId: '19', outcomeId: '13', specifier: 'total=2.5', label: 'Home Under 2.5' }
];

const ELITE_FOOTBALL_TOURNAMENTS = [
  'sr:tournament:7',     // UEFA Champions League
  'sr:tournament:679',   // UEFA Europa League
  'sr:tournament:34480', // UEFA Conference League
  'sr:tournament:17',    // Premier League
  'sr:tournament:18',    // Championship
  'sr:tournament:23',    // Serie A
  'sr:tournament:8',     // LaLiga
  'sr:tournament:35',    // Bundesliga
  'sr:tournament:34',    // Ligue 1
  'sr:tournament:37',    // Eredivisie
  'sr:tournament:238',   // Liga Portugal
  'sr:tournament:52',    // Super Lig
  'sr:tournament:38',    // Belgian Pro League
  'sr:tournament:36',    // Scottish Premiership
  'sr:tournament:325',   // Brasileiro Serie A
  'sr:tournament:53',    // Serie B
  'sr:tournament:44',    // 2. Bundesliga
  'sr:tournament:54',    // LaLiga 2
  'sr:tournament:182',   // Ligue 2
  'sr:tournament:155',   // Liga Profesional Argentina
  'sr:tournament:242',   // MLS
  'sr:tournament:352'    // Liga MX
];

const EXCLUDE_LEAGUE_KW = [
  'u19', 'u20', 'u21', 'u23', 'youth', 'reserves', 'amateur', 'oberliga', 'regionalliga'
];

function isCleanEvent(ev) {
  if (!ev || !ev.eventId) return false;
  if (sportybetApi.isSrlOrVirtual(ev, ev.league, ev.country)) return false;
  const full = `${ev.country || ''} ${ev.league || ''} ${ev.home || ''} ${ev.away || ''}`.toLowerCase();
  if (EXCLUDE_LEAGUE_KW.some(k => full.includes(k))) return false;
  return true;
}

function parseCliArgs(argv) {
  const args = {
    dryRun: false,
    maxWaveStake: 15.0,
    x100Count: 2,
    minStartMinutes: 45
  };
  for (const tok of argv) {
    if (tok === '--dry-run') args.dryRun = true;
    else if (tok.startsWith('--max-wave-stake=')) args.maxWaveStake = Number(tok.slice('--max-wave-stake='.length));
    else if (tok.startsWith('--x100-count=')) args.x100Count = Number(tok.slice('--x100-count='.length));
    else if (tok.startsWith('--min-start-minutes=')) args.minStartMinutes = Number(tok.slice('--min-start-minutes='.length));
  }
  return args;
}

/**
 * Dynamically discover active market/outcome tuples for a given sport by inspecting
 * sample events via /api/gh/factsCenter/event, skipping player/prop/correct-score noise.
 */
async function discoverSportMarkets(request, events, opts = {}) {
  const {
    sampleCount = 4,
    minOdds = 1.18,
    maxOdds = 1.50,
    minRtp = 0.965,
    maxTemplates = 18,
    tailMinProb = 0.985
  } = opts;

  const modeATemplates = [];
  const modeBTemplates = [];
  const seenA = new Set();
  const seenB = new Set();
  const skipPattern = /player|scorer|card|corner|booking|penalty|own goal|correct score|exact|odd\/even|winning margin|tiebreak/i;

  for (const ev of events.slice(0, sampleCount)) {
    try {
      const detail = await sportybetApi.fetchEventDetails(request, ev.eventId);
      if (!detail || !Array.isArray(detail.markets)) continue;
      for (const m of detail.markets) {
        if (!m || m.status !== 0) continue;
        const mId = String(m.id);
        if (mId.startsWith('800')) continue;
        if (skipPattern.test(m.desc || '')) continue;
        const spec = m.specifier || null;

        for (const o of (m.outcomes || [])) {
          if (!o || o.isActive !== 1) continue;
          const od = Number.parseFloat(o.odds || '0');
          const pr = Number.parseFloat(o.probability || '0');
          if (!Number.isFinite(od) || !Number.isFinite(pr) || pr <= 0) continue;
          const rtp = od * pr;
          const key = `${mId}|${spec || ''}|${o.id}`;

          if (od >= minOdds && od <= maxOdds && rtp >= minRtp && !seenA.has(key) && modeATemplates.length < maxTemplates) {
            seenA.add(key);
            modeATemplates.push({
              marketId: mId,
              outcomeId: String(o.id),
              specifier: spec,
              label: `${m.desc}: ${o.desc}`
            });
          }
          if (od >= 1.01 && pr >= tailMinProb && !seenB.has(key) && modeBTemplates.length < maxTemplates) {
            seenB.add(key);
            modeBTemplates.push({
              marketId: mId,
              outcomeId: String(o.id),
              specifier: spec,
              label: `${m.desc}: ${o.desc}`
            });
          }
        }
      }
    } catch {
      // ignore individual sample error
    }
  }

  return { modeATemplates, modeBTemplates };
}

/**
 * Scan live upcoming markets across Football (0.50x bonus) and 1.00x-bonus sports
 * (Basketball, Tennis, Ice Hockey, Table Tennis) using SportyBet Ghana's official API.
 */
async function scanMultiSportCandidates(request, opts = {}) {
  const minStartOffsetMs = (opts.minStartMinutes || 45) * 60 * 1000;
  const modeACandidates = [];
  const modeBCandidates = [];
  const scanStats = {
    footballEvents: 0,
    fullBonusSportEvents: {},
    modeARawOutcomes: 0,
    modeBRawOutcomes: 0
  };

  // 1. Football events (elite tournaments FIRST for lowest vig, then general order feed)
  const fbMap = new Map();
  try {
    const tournEvents = await sportybetApi.fetchTournamentEvents(
      request,
      ELITE_FOOTBALL_TOURNAMENTS,
      SPORTS.FOOTBALL,
      { minStartOffsetMs }
    );
    for (const ev of tournEvents) {
      if (isCleanEvent(ev) && !fbMap.has(ev.eventId)) fbMap.set(ev.eventId, ev);
    }
  } catch (e) {
    console.warn(`[Scan] Football tournament feed error: ${e.message}`);
  }

  try {
    const orderEvents = await sportybetApi.fetchEventsByOrder(request, {
      sportId: SPORTS.FOOTBALL,
      maxPages: 16,
      pageSize: 30,
      minStartOffsetMs,
      withTwoUpMarket: true
    });
    for (const ev of orderEvents) {
      if (isCleanEvent(ev) && !fbMap.has(ev.eventId)) fbMap.set(ev.eventId, ev);
    }
  } catch (e) {
    console.warn(`[Scan] Football order feed error: ${e.message}`);
  }

  const fbEvents = Array.from(fbMap.values());
  scanStats.footballEvents = fbEvents.length;
  console.log(`[Scan] Football upcoming clean events: ${fbEvents.length}`);

  // Query Mode A Football markets in batches
  if (fbEvents.length > 0) {
    const fbModeAQueries = [];
    for (const ev of fbEvents.slice(0, 420)) {
      for (const mk of FOOTBALL_MODE_A_MARKETS) {
        fbModeAQueries.push({
          eventId: ev.eventId,
          marketId: mk.marketId,
          outcomeId: mk.outcomeId,
          specifier: mk.specifier
        });
      }
    }
    const fbModeARes = await sportybetApi.fetchOutcomesBatch(request, fbModeAQueries, 150);
    for (const item of fbModeARes) {
      if (item.odds >= 1.20 && item.odds <= 1.45 && item.prob > 0) {
        modeACandidates.push(item);
      }
    }
    console.log(`[Scan] Football Mode A outcomes in [1.20, 1.45]: ${modeACandidates.length}`);

    // Query Mode B Football tail markets (first 300 upcoming events, elite first)
    const fbModeBQueries = [];
    for (const ev of fbEvents.slice(0, 300)) {
      for (const mk of FOOTBALL_MODE_B_MARKETS) {
        fbModeBQueries.push({
          eventId: ev.eventId,
          marketId: mk.marketId,
          outcomeId: mk.outcomeId,
          specifier: mk.specifier
        });
      }
    }
    const fbModeBRes = await sportybetApi.fetchOutcomesBatch(request, fbModeBQueries, 150);
    for (const item of fbModeBRes) {
      if (item.odds >= 1.01 && item.prob >= 0.980) {
        modeBCandidates.push(item);
      }
    }
    console.log(`[Scan] Football Mode B tail outcomes (prob >= 0.980): ${modeBCandidates.length}`);
  }

  // 2. 1.00x-Bonus Sports (Basketball, Tennis, Ice Hockey, Table Tennis)
  for (const sportId of FULL_BONUS_SPORTS) {
    try {
      const spEventsRaw = await sportybetApi.fetchEventsByOrder(request, {
        sportId,
        maxPages: 6,
        pageSize: 30,
        minStartOffsetMs,
        withTwoUpMarket: false
      });
      const spEvents = spEventsRaw.filter(isCleanEvent);
      scanStats.fullBonusSportEvents[sportId] = spEvents.length;
      if (spEvents.length === 0) continue;

      const { modeATemplates, modeBTemplates } = await discoverSportMarkets(request, spEvents, {
        sampleCount: 4,
        minOdds: 1.18,
        maxOdds: 1.50,
        minRtp: 0.960,
        maxTemplates: 14,
        tailMinProb: 0.985
      });

      // Fallback core Winner/Moneyline markets if sample events had narrow lines
      if (sportId === SPORTS.BASKETBALL && modeATemplates.length < 4) {
        modeATemplates.push(
          { marketId: '219', outcomeId: '4', specifier: null, label: 'Winner (incl. OT) Home' },
          { marketId: '219', outcomeId: '5', specifier: null, label: 'Winner (incl. OT) Away' }
        );
      } else if ((sportId === SPORTS.TENNIS || sportId === SPORTS.TABLE_TENNIS) && modeATemplates.length < 4) {
        modeATemplates.push(
          { marketId: '186', outcomeId: '4', specifier: null, label: 'Winner Home' },
          { marketId: '186', outcomeId: '5', specifier: null, label: 'Winner Away' }
        );
      } else if (sportId === SPORTS.ICE_HOCKEY && modeATemplates.length < 4) {
        modeATemplates.push(
          { marketId: '406', outcomeId: '4', specifier: null, label: 'Winner (incl. OT) Home' },
          { marketId: '406', outcomeId: '5', specifier: null, label: 'Winner (incl. OT) Away' },
          { marketId: '10', outcomeId: '9', specifier: null, label: 'Double Chance 1X' },
          { marketId: '10', outcomeId: '11', specifier: null, label: 'Double Chance X2' }
        );
      }

      if (modeATemplates.length > 0) {
        const queriesA = [];
        for (const ev of spEvents.slice(0, 120)) {
          for (const mk of modeATemplates) {
            queriesA.push({
              eventId: ev.eventId,
              marketId: mk.marketId,
              outcomeId: mk.outcomeId,
              specifier: mk.specifier
            });
          }
        }
        const resA = await sportybetApi.fetchOutcomesBatch(request, queriesA, 150);
        let addedA = 0;
        for (const item of resA) {
          if (item.odds >= 1.20 && item.odds <= 1.45 && item.prob > 0) {
            modeACandidates.push(item);
            addedA += 1;
          }
        }
        console.log(`[Scan] ${sportId} (1.00x bonus): ${spEvents.length} events, ${modeATemplates.length} templates -> ${addedA} Mode A outcomes`);
      }

      if (modeBTemplates.length > 0) {
        const queriesB = [];
        for (const ev of spEvents.slice(0, 60)) {
          for (const mk of modeBTemplates) {
            queriesB.push({
              eventId: ev.eventId,
              marketId: mk.marketId,
              outcomeId: mk.outcomeId,
              specifier: mk.specifier
            });
          }
        }
        const resB = await sportybetApi.fetchOutcomesBatch(request, queriesB, 150);
        let addedB = 0;
        for (const item of resB) {
          if (item.odds >= 1.01 && item.prob >= 0.980) {
            modeBCandidates.push(item);
            addedB += 1;
          }
        }
        if (addedB > 0) {
          console.log(`[Scan] ${sportId}: ${addedB} Mode B tail outcomes`);
        }
      }
    } catch (e) {
      console.warn(`[Scan] ${sportId} scan error: ${e.message}`);
    }
  }

  scanStats.modeARawOutcomes = modeACandidates.length;
  scanStats.modeBRawOutcomes = modeBCandidates.length;
  return { modeACandidates, modeBCandidates, scanStats };
}

/**
 * Programmatically inspect the SportyBet betslip DOM for Flexi, 1UP, and EarlyGoals
 * checkboxes/toggles and assert ALL are UNCHECKED. If any is checked, attempt to uncheck
 * and re-verify; throw if any remains checked.
 */
async function assertBetslipCheckboxesUnchecked(page) {
  const inspect = async () => page.evaluate(() => {
    const result = {
      flexiChecked: false,
      oneUpChecked: false,
      earlyGoalsChecked: false,
      controlsFound: []
    };

    const isElementChecked = (el) => {
      if (!el) return false;
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        return Boolean(el.checked);
      }
      if (el.getAttribute('aria-checked') === 'true') return true;
      const cls = String(el.className || '').toLowerCase();
      if (/\b(is-checked|checked|active|selected|on)\b/.test(cls) && !/\b(unchecked|inactive|off)\b/.test(cls)) {
        return true;
      }
      const nestedInput = el.querySelector('input[type="checkbox"]');
      if (nestedInput && nestedInput.checked) return true;
      return false;
    };

    const candidates = Array.from(document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], [role="switch"], .m-checkbox, .af-checkbox, .m-switch, .flexi-bet, [data-op*="flexi"], [data-op*="1up"], [data-op*="early"]'
    ));

    for (const el of candidates) {
      if (el.offsetParent === null && el.tagName !== 'INPUT') continue;
      const container = el.closest('label, li, .m-betslip-item, .m-flexi, .m-bet-option, div') || el.parentElement;
      const text = `${el.getAttribute('data-op') || ''} ${el.getAttribute('aria-label') || ''} ${container ? container.innerText : ''}`.toLowerCase();
      const checked = isElementChecked(el);

      let tag = null;
      if (/\bflexi\b/.test(text)) {
        tag = 'flexi';
        if (checked) result.flexiChecked = true;
      } else if (/\b1\s*up\b|\bone\s*up\b/.test(text)) {
        tag = '1up';
        if (checked) result.oneUpChecked = true;
      } else if (/early\s*goal|earlygoals/.test(text)) {
        tag = 'earlyGoals';
        if (checked) result.earlyGoalsChecked = true;
      }

      if (tag) {
        result.controlsFound.push({
          tag,
          checked,
          dataOp: el.getAttribute('data-op') || '',
          snippet: text.replace(/\s+/g, ' ').trim().slice(0, 80)
        });
      }
    }

    return result;
  });

  let state = await inspect();

  // Attempt to uncheck if any prohibited toggle is checked
  if (state.flexiChecked || state.oneUpChecked || state.earlyGoalsChecked) {
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'input[type="checkbox"], [role="checkbox"], [role="switch"], .m-checkbox, .af-checkbox, .m-switch, [data-op*="flexi"], [data-op*="1up"], [data-op*="early"]'
      ));
      for (const el of candidates) {
        const container = el.closest('label, li, .m-betslip-item, .m-flexi, .m-bet-option, div') || el.parentElement;
        const text = `${el.getAttribute('data-op') || ''} ${container ? container.innerText : ''}`.toLowerCase();
        if (!/\bflexi\b|\b1\s*up\b|early\s*goal|earlygoals/.test(text)) continue;
        const checked = el.checked || el.getAttribute('aria-checked') === 'true' ||
          /\b(is-checked|checked|active|selected|on)\b/.test(String(el.className || '').toLowerCase());
        if (checked) el.click();
      }
    });
    await page.waitForTimeout(800);
    state = await inspect();
  }

  if (state.flexiChecked || state.oneUpChecked || state.earlyGoalsChecked) {
    throw new Error(`DOM_CHECKBOX_ASSERTION_FAILED: ${JSON.stringify(state)}`);
  }

  return state;
}

async function scrapeBetslipQuote(page) {
  return page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    const pot = txt.match(/Potential\s+Win[^\d]*([0-9,]+\.[0-9]{2})/i);
    const odds = txt.match(/Total\s+Odds[^\d]*([0-9,]+\.[0-9]{2})/i);
    const totalStake = txt.match(/Total\s+Stake[^\d]*([0-9,]+\.[0-9]{2})/i);
    const bonus = txt.match(/(?:Max\s+)?Bonus[^\d]*([0-9,]+\.[0-9]{2})/i);
    const bonusPct = txt.match(/([0-9]+)%\s*(?:Max\s*)?Bonus/i);
    const placeBtn = document.querySelector('[data-op="betslip-placebet"]')?.innerText?.trim() || '';
    const multiCount = document.querySelector('[data-op="betslip-multi-count"]')?.innerText?.trim() || '';
    return {
      potentialWin: pot ? Number.parseFloat(pot[1].replace(/,/g, '')) : 0,
      totalOdds: odds ? Number.parseFloat(odds[1].replace(/,/g, '')) : 0,
      totalStake: totalStake ? Number.parseFloat(totalStake[1].replace(/,/g, '')) : 0,
      bonusGhs: bonus ? Number.parseFloat(bonus[1].replace(/,/g, '')) : 0,
      bonusPct: bonusPct ? Number.parseInt(bonusPct[1], 10) : 0,
      placeBtn,
      multiCount
    };
  });
}

/**
 * Re-verify every leg immediately pre-placement via /api/gh/factsCenter/Outcomes,
 * assert hard EV/prob gates, inject into wapBetslips, assert DOM checkboxes + leg count
 * + stake + live payout EV, then click Place Bet + Confirm and capture receipt PNG.
 */
async function verifyAndPlaceTicket(context, page, ticket, bonusPlan, ticketIndex) {
  const stake = Number(ticket.recommendedStakeGhs);
  const stakeStr = Number.isInteger(stake) ? String(stake) : stake.toFixed(2);
  const shotName = `quant_v11_${ticket.mode}_${ticketIndex}_receipt.png`;
  const shotPath = path.join(S.SCREENSHOT_DIR, shotName);

  console.log(`\n============================================================`);
  console.log(`  PLACING [${ticketIndex}] ${ticket.name}`);
  console.log(`  Mode: ${ticket.mode} | Folds: ${ticket.legs.length} | Stake: GHS ${stakeStr}`);
  console.log(`============================================================`);

  // 1. Live Pre-Placement Outcomes Re-Verification
  const liveLegsRaw = await sportybetApi.fetchOutcomesBatch(
    context.request,
    ticket.legs.map(l => ({
      eventId: l.eventId,
      marketId: l.marketId,
      outcomeId: l.outcomeId,
      specifier: l.specifier || null
    })),
    150
  );

  const liveByKey = new Map();
  for (const item of liveLegsRaw) {
    const k = `${item.eventId}|${item.marketId}|${item.specifier || ''}|${item.outcomeId}`;
    liveByKey.set(k, item);
  }

  const verifiedLegs = [];
  for (const orig of ticket.legs) {
    const k = `${orig.eventId}|${orig.marketId}|${orig.specifier || ''}|${orig.outcomeId}`;
    const fresh = liveByKey.get(k);
    if (!fresh || !fresh.isActive) {
      throw new Error(`PRE_PLACE_LEG_INACTIVE: ${orig.match} (${k})`);
    }
    verifiedLegs.push({
      ...orig,
      home: fresh.home || orig.home,
      away: fresh.away || orig.away,
      match: fresh.match || orig.match,
      startTime: fresh.startTime || orig.startTime || 0,
      country: fresh.country || orig.country || '',
      league: fresh.league || orig.league || '',
      marketDesc: fresh.marketDesc || orig.marketDesc || orig.marketKey,
      outcomeDesc: fresh.outcomeDesc || orig.outcomeDesc || '',
      odds: fresh.odds,
      prob: fresh.prob,
      rtp: fresh.rtp,
      wap_item: fresh.wap_item
    });
  }

  if (verifiedLegs.length !== ticket.legs.length) {
    throw new Error(`PRE_PLACE_LEG_COUNT_MISMATCH: expected ${ticket.legs.length}, got ${verifiedLegs.length}`);
  }

  // Recompute mathematical proof on exact live odds/probs
  const liveMath = bonusModel.evaluateTicketMath(verifiedLegs, bonusPlan, stake);
  console.log(`  [Pre-Place Math] BaseOdds=${liveMath.baseOdds.toFixed(2)}x | Bonus=${(liveMath.bonusPct * 100).toFixed(1)}% | EffMult=${liveMath.effectiveMultiplier.toFixed(2)}x | CombProb=${(liveMath.combinedWinProb * 100).toFixed(4)}% | TrueRTP=${(liveMath.trueExpectedRtp * 100).toFixed(2)}%`);

  if (ticket.mode === 'x100_plus_ev') {
    if (!liveMath.isPositiveEv || liveMath.trueExpectedRtp <= 1.00) {
      throw new Error(`MODE_A_EV_GATE_FAILED_PRE_PLACE: trueExpectedRtp=${liveMath.trueExpectedRtp}`);
    }
    if (liveMath.effectiveMultiplier < 100.0) {
      throw new Error(`MODE_A_MULTIPLIER_GATE_FAILED_PRE_PLACE: effectiveMultiplier=${liveMath.effectiveMultiplier}`);
    }
  } else if (ticket.mode === 'fortress_98pct') {
    if (liveMath.combinedWinProb < 0.980 - 1e-9) {
      throw new Error(`MODE_B_PROB_GATE_FAILED_PRE_PLACE: combinedWinProb=${liveMath.combinedWinProb}`);
    }
  }

  // 2. Inject into wapBetslips + reload + open betslip
  await page.evaluate((items) => {
    localStorage.setItem('wapBetslips', JSON.stringify(items));
  }, verifiedLegs.map(l => l.wap_item));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  await page.evaluate(() => {
    const icon = document.querySelector('.betslip-theme-icon') || document.querySelector('.m-betslip-Balls');
    if (icon) icon.click();
  });
  await page.waitForTimeout(2200);

  // 3. DOM Checkbox Assertion: Flexi, 1UP, EarlyGoals MUST be UNCHECKED
  const checkboxAudit = await assertBetslipCheckboxesUnchecked(page);
  console.log(`  [DOM Checkbox Audit] flexi=${checkboxAudit.flexiChecked}, 1up=${checkboxAudit.oneUpChecked}, earlyGoals=${checkboxAudit.earlyGoalsChecked} (controls=${checkboxAudit.controlsFound.length})`);

  // 4. Leg Count Assertion
  const slipCount = await S.getSlipCount(page);
  const domItemCount = await page.evaluate(() => {
    const mc = document.querySelector('[data-op="betslip-multi-count"]')?.innerText?.trim() || '';
    const parsedMc = Number.parseInt(mc, 10);
    if (Number.isFinite(parsedMc) && parsedMc > 0) return parsedMc;
    const rows = document.querySelectorAll('.m-betslip-item, .m-list-item, [data-op="betslip-item"]');
    return rows.length;
  });
  const effectiveVisibleCount = slipCount > 0 ? slipCount : domItemCount;
  console.log(`  [DOM Leg Count] slipCount=${slipCount}, domItemCount=${domItemCount}, expected=${verifiedLegs.length}`);
  if (effectiveVisibleCount !== verifiedLegs.length) {
    throw new Error(`DOM_LEG_COUNT_MISMATCH: visible=${effectiveVisibleCount}, expected=${verifiedLegs.length}`);
  }

  // 5. Type stake via official SportyBet keypad & verify quote
  await page.evaluate(() => {
    const el = document.querySelector('[data-op="betslip-stake-amount"]')
      || document.querySelector('[data-op="betslip-single-stake-amount"]')
      || document.querySelector('.m-stake-input, .stake-input, [data-op*="stake-amount"]');
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
  });
  await page.waitForTimeout(700);
  await S.typeStakeOnKeyboard(page, stakeStr);
  await page.waitForTimeout(1500);

  let quote = await scrapeBetslipQuote(page);
  console.log(`  [Live Betslip Quote] TotalStake=${quote.totalStake} | TotalOdds=${quote.totalOdds}x | Bonus=GHS ${quote.bonusGhs} (${quote.bonusPct}%) | PotentialWin=GHS ${quote.potentialWin}`);

  if (quote.totalStake > 0 && Math.abs(quote.totalStake - stake) > 0.01) {
    throw new Error(`DOM_STAKE_MISMATCH: scraped=${quote.totalStake}, expected=${stake}`);
  }
  if (quote.potentialWin <= 0) {
    throw new Error(`DOM_QUOTE_MISSING_POTENTIAL_WIN: ${JSON.stringify(quote)}`);
  }

  const verifyLiveQuoteEv = (q) => {
    const liveEffMult = q.potentialWin / stake;
    const liveTrueRtp = liveMath.combinedWinProb * liveEffMult;
    if (ticket.mode === 'x100_plus_ev') {
      if (liveTrueRtp <= 1.00) {
        throw new Error(`LIVE_QUOTE_EV_GATE_FAILED: liveTrueRtp=${liveTrueRtp.toFixed(4)} <= 1.00 (potWin=${q.potentialWin})`);
      }
      if (liveEffMult < 100.0) {
        throw new Error(`LIVE_QUOTE_MULT_GATE_FAILED: liveEffMult=${liveEffMult.toFixed(2)} < 100.0`);
      }
    } else if (ticket.mode === 'fortress_98pct') {
      if (liveMath.combinedWinProb < 0.980 - 1e-9) {
        throw new Error(`LIVE_QUOTE_PROB_GATE_FAILED: combinedWinProb=${liveMath.combinedWinProb}`);
      }
      if (q.potentialWin <= stake) {
        throw new Error(`LIVE_QUOTE_PAYOUT_TOO_LOW: potWin=${q.potentialWin} <= stake=${stake}`);
      }
    }
    return { liveEffMult, liveTrueRtp };
  };

  let liveEvCheck = verifyLiveQuoteEv(quote);
  console.log(`  [Live EV Verified] liveEffMult=${liveEvCheck.liveEffMult.toFixed(2)}x | liveTrueRtp=${(liveEvCheck.liveTrueRtp * 100).toFixed(2)}%`);

  // 6. Click Place Bet (up to 4 retries for "Accept Odds Changes", re-checking EV before Confirm)
  let confirmVisible = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const btnText = await page.evaluate(() => {
      const btn = document.querySelector('[data-op="betslip-placebet"]');
      if (btn) {
        const t = (btn.innerText || '').trim();
        btn.click();
        return t;
      }
      return '';
    });
    console.log(`  [PlaceBet attempt ${attempt}] clicked: "${btnText}"`);
    await page.waitForTimeout(2000);

    if (/accept/i.test(btnText)) {
      quote = await scrapeBetslipQuote(page);
      liveEvCheck = verifyLiveQuoteEv(quote);
      console.log(`  [Post-Odds-Change EV Re-Verified] PotWin=GHS ${quote.potentialWin} | liveTrueRtp=${(liveEvCheck.liveTrueRtp * 100).toFixed(2)}%`);
    }

    confirmVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, div, span, a')).some(
        e => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === 'confirm'
      )
    );
    if (confirmVisible) break;
  }

  if (!confirmVisible) {
    await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, `quant_v11_${ticket.mode}_${ticketIndex}_noconfirm.png`) });
    throw new Error('CONFIRM_BUTTON_NOT_VISIBLE_AFTER_4_ATTEMPTS');
  }

  // Re-assert checkboxes right before final Confirm
  await assertBetslipCheckboxesUnchecked(page);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, div, span, a')).filter(
      e => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === 'confirm'
    );
    if (btns.length) btns[btns.length - 1].click();
  });

  await page.waitForTimeout(6000);
  await page.screenshot({ path: shotPath, fullPage: true });

  const receipt = await page.evaluate(() => {
    const full = document.body ? document.body.innerText : '';
    const idx = full.indexOf('Bet Successful');
    const text = idx >= 0 ? full.slice(idx) : full;
    const codeMatch = text.match(/Booking\s+Code[\s\S]{0,40}?\b([A-Z0-9]{6})\b/i)
      || text.match(/\b([A-Z0-9]{6})\b/)
      || full.match(/([A-Z0-9]{6})\s*Custom Code/i);
    const stakeMatch = text.match(/Total\s+Stake[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    const potWinMatch = text.match(/Potential\s+Win[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    return {
      success: full.includes('Bet Successful') || full.includes('Successful') || full.includes('Bet Placed'),
      booking_code: codeMatch ? codeMatch[1] : null,
      stake: stakeMatch ? Number.parseFloat(stakeMatch[1].replace(/,/g, '')) : null,
      potential_win: potWinMatch ? Number.parseFloat(potWinMatch[1].replace(/,/g, '')) : null,
      snippet: text.slice(0, 400)
    };
  });

  // Dismiss receipt modal cleanly
  await page.evaluate(() => {
    const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(
      e => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === 'ok'
    );
    if (ok) ok.click();
  });
  await page.waitForTimeout(1800);

  const finalStake = receipt.stake || stake;
  const finalPotWin = receipt.potential_win || quote.potentialWin;
  const finalEffMult = finalStake > 0 ? +(finalPotWin / finalStake).toFixed(4) : liveMath.effectiveMultiplier;
  const finalTrueRtp = +(liveMath.combinedWinProb * finalEffMult).toFixed(6);

  const result = {
    id: ticket.id,
    mode: ticket.mode,
    name: ticket.name,
    strategyTag: ticket.mode === 'x100_plus_ev' ? 'QUANT_V11_X100_PLUSEV' : 'QUANT_V11_FORTRESS_98PCT',
    success: Boolean(receipt.success && receipt.booking_code && /^[A-Z0-9]{6}$/.test(receipt.booking_code)),
    booking_code: receipt.booking_code,
    folds: verifiedLegs.length,
    stake: finalStake,
    baseOdds: quote.totalOdds || liveMath.baseOdds,
    bonusPct: quote.bonusPct ? +(quote.bonusPct / 100).toFixed(4) : liveMath.bonusPct,
    bonusGhs: quote.bonusGhs || 0,
    potentialWin: finalPotWin,
    effectiveMultiplier: finalEffMult,
    combinedWinProb: liveMath.combinedWinProb,
    geometricMeanRtp: liveMath.geometricMeanRtp,
    trueExpectedRtp: finalTrueRtp,
    expectedValueGhs: +(finalStake * (finalTrueRtp - 1)).toFixed(4),
    isPositiveEv: finalTrueRtp > 1.0,
    checkboxAudit,
    quote,
    screenshotPath: shotPath,
    receiptSnippet: receipt.snippet,
    legs: verifiedLegs.map(({ wap_item, ...rest }) => rest)
  };

  console.log(`  [RESULT] success=${result.success} | Code=${result.booking_code} | ${result.folds}F | Stake=GHS ${result.stake} | PotWin=GHS ${result.potentialWin} (${result.effectiveMultiplier}x) | CombProb=${(result.combinedWinProb * 100).toFixed(4)}% | TrueRTP=${(result.trueExpectedRtp * 100).toFixed(2)}%`);
  return result;
}

async function ensureAuthenticatedSession() {
  let sessionObj = await S.launchBrowser();
  await sessionObj.page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sessionObj.page.waitForTimeout(2500);
  let sess = await S.readSession(sessionObj.page);
  console.log('[Session] Initial check:', sess);

  if (!sess.isLogged) {
    console.log('[Session] Not logged in — running syndicate/active_login_sentinel.js to auto-heal...');
    await sessionObj.browser.close();
    execFileSync('node', [path.join(S.ROOT_DIR, 'syndicate', 'active_login_sentinel.js')], {
      cwd: S.ROOT_DIR,
      stdio: 'inherit'
    });
    sessionObj = await S.launchBrowser();
    await sessionObj.page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sessionObj.page.waitForTimeout(2500);
    sess = await S.readSession(sessionObj.page);
    console.log('[Session] Post-sentinel check:', sess);
    if (!sess.isLogged) {
      await sessionObj.browser.close();
      throw new Error('SportyBet Ghana session could not be authenticated!');
    }
  }

  return { ...sessionObj, preBalanceGhs: sess.balance };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  console.log(`[QuantExec] Starting live +EV pipeline | dryRun=${args.dryRun} | maxWaveStake=GHS ${args.maxWaveStake}`);

  const { browser, context, page, preBalanceGhs } = await ensureAuthenticatedSession();

  try {
    // 1. Fetch live SportyBet Ghana bonus plan (fallback only on error)
    let bonusPlan;
    let bonusPlanSource = 'live_api';
    try {
      const rawPlan = await sportybetApi.fetchBonusPlans(context.request);
      bonusPlan = bonusModel.parseBonusPlan(rawPlan);
      console.log(`[BonusPlan] Loaded LIVE plan | qualifyingOdds=${bonusPlan.qualifyingOdds} | maxN=${bonusPlan.maxSelectionsKey}`);
    } catch (e) {
      bonusPlanSource = 'verified_fallback';
      bonusPlan = bonusModel.getDefaultBonusPlan();
      console.warn(`[BonusPlan] Live endpoint error (${e.message}), using verified fallback snapshot.`);
    }

    // 2. Scan live multi-sport markets
    const { modeACandidates, modeBCandidates, scanStats } = await scanMultiSportCandidates(context.request, {
      minStartMinutes: args.minStartMinutes
    });

    // 3. Load closed-loop learning context (Heuristics v3.0.0 + SQLite active firewall & loss bans)
    const learningCtx = learningFilter.loadLearningContext();
    console.log(`[LearningCtx] heuristics=v${learningCtx.heuristicsVersion} | activeMatches=${learningCtx.activeMatches.length} | bannedMarkets=${learningCtx.bannedMarkets.size}`);

    // 4. Construct Mode A (up to 2 disjoint x100+ +EV) & Mode B (1 true 98%+ Fortress)
    const bankroll = Number.isFinite(preBalanceGhs) && preBalanceGhs > 0 ? preBalanceGhs : 187.67;
    const resA = modeA.buildDisjointX100Tickets(modeACandidates, bonusPlan, learningCtx, args.x100Count, {
      bankroll,
      minMultiplier: 100.0,
      minLegRtp: 0.980,
      minTicketEv: 1.02,
      hardEvFloor: 1.00,
      minStake: 2.0,
      maxStake: 3.0
    });

    const usedEventIds = new Set();
    const plannedTickets = [];
    for (const t of resA.tickets) {
      plannedTickets.push(t);
      for (const l of t.legs) usedEventIds.add(l.eventId);
    }
    console.log(`[Mode A] Built ${resA.tickets.length} disjoint x100+ +EV ticket(s) | diagnostics:`, JSON.stringify(resA.diagnostics));

    const resB = modeB.buildFortress98Ticket(modeBCandidates, bonusPlan, learningCtx, {
      bankroll,
      excludeEventIds: usedEventIds,
      minCombinedProb: 0.980,
      minTicketRtp: 0.985,
      minStake: 2.0,
      maxStake: 5.0
    });
    if (resB.ok && resB.ticket) {
      // Enforce dispatch sizing guidance: GHS 5.00 if +EV, GHS 2.00-3.00 if near-zero-vig >= 0.99 RTP
      if (resB.ticket.mathProof.isPositiveEv) {
        resB.ticket.recommendedStakeGhs = Math.min(5.0, Math.max(2.0, resB.ticket.recommendedStakeGhs));
      } else {
        resB.ticket.recommendedStakeGhs = 2.0;
      }
      resB.ticket.mathProof = bonusModel.evaluateTicketMath(resB.ticket.legs, bonusPlan, resB.ticket.recommendedStakeGhs);
      plannedTickets.push(resB.ticket);
    }
    console.log(`[Mode B] Built ${resB.ok ? 1 : 0} Fortress 98%+ ticket | diagnostics:`, JSON.stringify(resB.diagnostics));

    // 5. Enforce strict Wave Stake Cap <= GHS 15.00
    const selectedTickets = [];
    let waveStake = 0;
    for (const t of plannedTickets) {
      const s = Number(t.recommendedStakeGhs || 0);
      if (s <= 0) continue;
      if (waveStake + s <= args.maxWaveStake + 1e-9) {
        selectedTickets.push(t);
        waveStake += s;
      }
    }

    const planPayload = exporter.buildExportPayload(selectedTickets, {
      bankrollGhs: bankroll,
      heuristicsVersion: learningCtx.heuristicsVersion
    });
    const planValidation = exporter.validateExportPayload(planPayload);
    if (!planValidation.valid) {
      throw new Error(`EXPORT_PAYLOAD_INVALID: ${planValidation.errors.join('; ')}`);
    }
    exporter.exportTicketsToFile(planPayload, OUT_PLAN_PATH);
    console.log(`[Plan] Exported ${selectedTickets.length} verified ticket(s) (Wave Stake: GHS ${waveStake.toFixed(2)} <= GHS ${args.maxWaveStake.toFixed(2)}) to ${OUT_PLAN_PATH}`);

    if (args.dryRun) {
      console.log('[DryRun] Exiting without placing live bets.');
      return;
    }

    if (selectedTickets.length === 0) {
      const emptySummary = {
        executedAt: new Date().toISOString(),
        startedAt,
        bonusPlanSource,
        scanStats,
        preBalanceGhs,
        postBalanceGhs: preBalanceGhs,
        totalStakedGhs: 0,
        ticketsPlacedCount: 0,
        modeADiagnostics: resA.diagnostics,
        modeBDiagnostics: resB.diagnostics,
        tickets: []
      };
      fs.writeFileSync(OUT_PLACEMENT_PATH, JSON.stringify(emptySummary, null, 2) + '\n', 'utf8');
      console.log('[QuantExec] No tickets passed strict +EV / 98%+ mathematical gates. Zero bets placed.');
      return;
    }

    // 6. Navigate to football page (stable betslip context) and execute placements
    await page.goto('https://www.sportybet.com/gh/m/sport/football/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    const placedResults = [];
    for (let i = 0; i < selectedTickets.length; i++) {
      const ticket = selectedTickets[i];
      try {
        const res = await verifyAndPlaceTicket(context, page, ticket, bonusPlan, i + 1);
        placedResults.push(res);
      } catch (err) {
        console.error(`[QuantExec] Aborted ticket ${ticket.id}: ${err.message}`);
        placedResults.push({
          id: ticket.id,
          mode: ticket.mode,
          name: ticket.name,
          success: false,
          booking_code: null,
          error: err.message
        });
      }
    }

    // 7. Read live post-placement balance and persist authenticated session
    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const postSess = await S.readSession(page);
    const postBalanceGhs = postSess.balance;
    await S.persistState(context);

    const confirmed = placedResults.filter(r => r.success && r.booking_code);
    const totalStakedGhs = +confirmed.reduce((acc, r) => acc + Number(r.stake || 0), 0).toFixed(2);

    const summary = {
      executedAt: new Date().toISOString(),
      startedAt,
      bonusPlanSource,
      heuristicsVersion: learningCtx.heuristicsVersion,
      scanStats,
      preBalanceGhs,
      postBalanceGhs,
      totalStakedGhs,
      ticketsPlacedCount: confirmed.length,
      modeADiagnostics: resA.diagnostics,
      modeBDiagnostics: resB.diagnostics,
      tickets: placedResults
    };

    fs.writeFileSync(OUT_PLACEMENT_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`\n[QuantExec] DONE | Placed=${confirmed.length}/${selectedTickets.length} | Staked=GHS ${totalStakedGhs.toFixed(2)} | Balance: GHS ${preBalanceGhs} -> GHS ${postBalanceGhs}`);
    console.log(`[QuantExec] Results written to ${OUT_PLACEMENT_PATH}`);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[QuantExec] FATAL:', err);
    process.exit(1);
  });
}

module.exports = {
  parseCliArgs,
  isCleanEvent,
  assertBetslipCheckboxesUnchecked,
  scrapeBetslipQuote,
  scanMultiSportCandidates,
  verifyAndPlaceTicket
};
