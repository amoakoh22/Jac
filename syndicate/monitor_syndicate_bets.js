/**
 * Hermes Syndicate - Unified Live Settlement, Leg-Level Learning & Auto-Cashout/Survivor Watcher
 * Uses syndicate/sportybet_session.js (storageState, ignoreHTTPSErrors).
 *
 * Tracks BOTH:
 *   1. Core Syndicate Tickets (`syndicate_tickets`: C6QSSB, D2X3PV, BD8Y44, ASL92A)
 *   2. CodeHub Monster Bullets (`syndicate_codehub_bullets`: D8WJHX + any Survivor Bullets)
 *
 * Autonomous Capabilities:
 *   - Extracts live Cashout offers & executes Profit-Lock Cashout when equity >= 92% or offer >= threshold
 *   - Extracts per-leg WON / LOST / VOID outcomes for Monster Bullets into `syndicate_creator_anchor_ledger`
 *     so only the creator(s) of a busted leg are penalized (-0.28x) while winning-leg creators earn (+0.12x)
 *   - Triggers `syndicate/survivor_rebullet.js` if a Monster Bullet busts early while >= 8 clean legs remain
 *
 * Usage:
 *   AUTO_CASHOUT=1 AUTO_REBULLET=1 node syndicate/monitor_syndicate_bets.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
const AUTO_CASHOUT = process.env.AUTO_CASHOUT === '1';
const AUTO_REBULLET = process.env.AUTO_REBULLET === '1';

function py(code) {
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  if (r.stderr) console.error(r.stderr);
  return r.stdout;
}

function getActivePortfolio() {
  const out = py(`
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=15.0)
c.execute("PRAGMA journal_mode=WAL;")
c.execute("PRAGMA busy_timeout=15000;")
# Ensure cashout_value column exists on syndicate_codehub_bullets
cols = [r[1] for r in c.execute("PRAGMA table_info(syndicate_codehub_bullets)").fetchall()]
for cname, cdef in [('cashout_value','REAL DEFAULT 0.0'),('wave_group_id',"TEXT DEFAULT ''"),('ticket_role',"TEXT DEFAULT 'SOLO'"),('pair_total_stake','REAL DEFAULT 0.0'),('wave_plan_json',"TEXT DEFAULT ''")]:
    if cname not in cols:
        c.execute(f"ALTER TABLE syndicate_codehub_bullets ADD COLUMN {cname} {cdef}")
c.commit()

tickets = c.execute("""
    SELECT ticket_id, ticket_number, booking_code, stake, total_odds, potential_payout
    FROM syndicate_tickets WHERE status='IN_PROGRESS'
""").fetchall()
t_list = []
for r in tickets:
    legs = [x[0] for x in c.execute("SELECT match_name FROM syndicate_legs WHERE ticket_id=?", (r[0],)).fetchall()]
    t_list.append(dict(kind="TICKET", id=r[0], number=r[1], code=r[2], stake=r[3], total_odds=r[4], potential_payout=r[5], role="SOLO", pair_total_stake=0.0, matches=legs))

bullets = c.execute("""
    SELECT bullet_id, booking_code, stake, total_odds, potential_payout, legs_count, COALESCE(ticket_role,'SOLO'), COALESCE(pair_total_stake,0.0), COALESCE(wave_group_id,'')
    FROM syndicate_codehub_bullets WHERE status='IN_PROGRESS'
""").fetchall()
b_list = []
for r in bullets:
    legs = [x[0] for x in c.execute("SELECT DISTINCT match_name FROM syndicate_creator_anchor_ledger WHERE booking_code=?", (r[1],)).fetchall()]
    b_list.append(dict(kind="BULLET", id=r[0], number=r[5], code=r[1], stake=r[2], total_odds=r[3], potential_payout=r[4], role=r[6], pair_total_stake=r[7], wave_group_id=r[8], matches=legs))

print(json.dumps({"tickets": t_list, "bullets": b_list}))
`);
  return JSON.parse(out.trim() || '{"tickets":[],"bullets":[]}');
}

function normalizeMatchName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ac|as|us|fk|sk|bk|ca|cd|ud|sd|u21|u23|1\.)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSidesOverlap(normA, normB) {
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const partsA = normA.split(/\s+v(?:s)?\s+/);
  const partsB = normB.split(/\s+v(?:s)?\s+/);
  if (partsA.length !== 2 || partsB.length !== 2) return false;
  const sideMatch = (a, b) => a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
  return sideMatch(partsA[0], partsB[0]) && sideMatch(partsA[1], partsB[1]);
}

async function scrapeBetCards(page, mode) {
  if (mode === 'OPEN') {
    await page.goto('https://www.sportybet.com/gh/m/my_accounts/open_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3500);
  } else {
    // Click the "Bet History" tab on the Open Bets page (/settled_bets is 404)
    await page.goto('https://www.sportybet.com/gh/m/my_accounts/open_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll('div, span, a, li')).find(e => (e.innerText || '').trim() === 'Bet History');
      if (tab) tab.click();
    });
    await page.waitForTimeout(4000);
  }

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const mid = document.querySelector('.m-main-mid') || document.scrollingElement;
      if (mid) mid.scrollTop += 600;
      window.scrollBy(0, 600);
    });
    await page.waitForTimeout(450);
  }
  await page.evaluate(() => {
    const mid = document.querySelector('.m-main-mid');
    if (mid) mid.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);

  return page.evaluate(() => {
    const selectors = '.m-order-card, .order-item, [class*="order-card"], [class*="bet-card"], [class*="bet-list-item"]';
    let rawCards = Array.from(document.querySelectorAll(selectors));
    if (rawCards.length === 0) {
      rawCards = Array.from(document.querySelectorAll('div, li')).filter(el => {
        const t = el.innerText || '';
        return t.length > 30 && t.length < 1800 && (t.includes('Stake') || t.includes('Cashout') || t.includes('Won') || t.includes('Lost')) && el.querySelectorAll('div').length < 35;
      });
    }
    // Keep ONLY leaf bet-card elements (exclude wrapper containers holding nested cards)
    const leafCards = rawCards.filter(el => !rawCards.some(other => other !== el && el.contains(other)));
    const bodyText = document.body ? document.body.innerText : '';
    return {
      cards: leafCards.map((c, idx) => ({
        idx,
        text: (c.innerText || '').replace(/\s+/g, ' ').trim(),
        rawLines: (c.innerText || '').split('\n').map(s => s.trim()).filter(Boolean),
        hasCashoutBtn: !!c.querySelector('[data-op*="cashout"], [class*="cashout"]')
      })),
      bodyText: bodyText.slice(0, 8000)
    };
  });
}

function findMatchingCard(cards, item) {
  const code = item.code || '';
  // 1. Direct booking code match if visible (prefer smallest leaf card)
  if (code) {
    const byCode = cards
      .filter(c => c.text.includes(code))
      .sort((a, b) => a.text.length - b.text.length);
    if (byCode.length > 0) return byCode[0];
  }
  // 2. Match by exact Stake + at least 2 distinct match team hits (or 1 if single-leg), preferring smallest leaf card
  const stakeStr = item.stake.toFixed(2);
  const payoutStr = item.potential_payout ? item.potential_payout.toFixed(2) : '';
  const matchKeywords = [];
  for (const m of (item.matches || [])) {
    const sides = m.split(/\s+vs\s+/i)
      .map(s => s.replace(/\b(FC|CF|AFC|SC|U21|CA|1\.|de|la)\b/gi, '').trim())
      .filter(s => s.length >= 4);
    if (sides.length > 0) matchKeywords.push(sides);
  }
  const minHits = matchKeywords.length >= 2 ? 2 : 1;
  const candidates = cards
    .filter(c => {
      if (!c.text.includes(stakeStr)) return false;
      if (payoutStr && c.text.includes(payoutStr)) return true;
      let hits = 0;
      for (const sides of matchKeywords) {
        if (sides.some(kw => c.text.includes(kw))) hits++;
      }
      return hits >= minHits;
    })
    .sort((a, b) => a.text.length - b.text.length);
  return candidates[0] || null;
}

function findMatchingApiOrder(liveOpenBetsApi, item) {
  if (!Array.isArray(liveOpenBetsApi) || liveOpenBetsApi.length === 0) return null;
  const code = (item.code || '').toUpperCase();
  if (code) {
    const byCodeAndStake = liveOpenBetsApi.find(ob => {
      const sc = String(ob.bookingCode || ob.shareCode || ob.shortId || '').toUpperCase();
      const obStake = parseFloat(ob.totalStake || ob.stake || ob.originStake || 0);
      return sc === code && (obStake <= 0 || Math.abs(obStake - item.stake) <= 0.05);
    });
    if (byCodeAndStake) return byCodeAndStake;
    const direct = liveOpenBetsApi.find(ob =>
      String(ob.bookingCode || ob.shareCode || ob.shortId || '').toUpperCase() === code
    );
    if (direct) return direct;
  }
  const itemNormMatches = (item.matches || []).map(normalizeMatchName).filter(Boolean);
  let best = null;
  let bestOverlap = 0;
  for (const ob of liveOpenBetsApi) {
    const obStake = parseFloat(ob.totalStake || ob.stake || ob.originStake || 0);
    if (obStake > 0 && Math.abs(obStake - item.stake) > 0.05) continue;
    const sels = ob.selections || [];
    const obMatches = sels.map(s => normalizeMatchName(`${s.home || ''} vs ${s.away || ''}`));
    let overlap = 0;
    for (const om of obMatches) {
      if (itemNormMatches.some(im => matchSidesOverlap(im, om))) overlap++;
    }
    const minRequired = Math.min(2, Math.max(1, itemNormMatches.length));
    if (overlap >= minRequired && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = ob;
    }
  }
  return best;
}

async function extractBulletLegOutcomes(page, item) {
  const stakeStr = item.stake.toFixed(2);
  const keywords = (item.matches || []).slice(0, 3).map(m => m.split(/\s+vs\s+/i)[0].trim()).filter(Boolean);
  const clicked = await page.evaluate(({ code, stakeStr, keywords }) => {
    const els = Array.from(document.querySelectorAll('.m-order-card, .order-item, [class*="order-card"], [class*="bet-card"], div, li'));
    const target = els.find(el => {
      const t = el.innerText || '';
      if (t.length >= 2500 || el.querySelectorAll('div').length >= 50) return false;
      if (code && t.includes(code) && t.includes(stakeStr)) return true;
      return t.includes(stakeStr) && keywords.some(k => t.includes(k));
    });
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    }
    return false;
  }, { code: item.code || '', stakeStr, keywords });

  if (!clicked) return [];
  await page.waitForTimeout(2500);

  const legLines = await page.evaluate(() => {
    return (document.body ? document.body.innerText : '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  });

  const outcomes = [];
  for (let i = 0; i < legLines.length; i++) {
    const line = legLines[i];
    if (/\s+v(?:s)?\.?\s+/i.test(line) && line.length < 80) {
      const windowText = legLines.slice(Math.max(0, i - 2), Math.min(legLines.length, i + 5)).join(' | ');
      let st = null;
      if (/\bLost\b/i.test(windowText)) st = 'LOST';
      else if (/\bWon\b/i.test(windowText)) st = 'WON';
      else if (/\bVoid\b|\bCancelled\b|\bRefund\b/i.test(windowText)) st = 'VOID';
      if (st) outcomes.push({ matchText: line, status: st });
    }
  }
  return outcomes;
}

async function executeCashoutOnPage(page, item) {
  const stakeStr = item.stake.toFixed(2);
  const keywords = (item.matches || []).slice(0, 3).map(m => m.split(/\s+vs\s+/i)[0].trim()).filter(Boolean);
  const clicked = await page.evaluate(({ code, stakeStr, keywords }) => {
    const els = Array.from(document.querySelectorAll('.m-order-card, .order-item, [class*="order-card"], [class*="bet-card"], div, li'));
    const card = els.find(el => {
      const t = el.innerText || '';
      if (t.length >= 2500 || el.querySelectorAll('div').length >= 50) return false;
      if (code && t.includes(code) && t.includes(stakeStr)) return true;
      return t.includes(stakeStr) && keywords.some(k => t.includes(k));
    });
    if (!card) return false;
    const btn = card.querySelector('[data-op*="cashout"], [class*="cashout"], button');
    if (btn && /cashout/i.test(btn.innerText || '')) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }
    return false;
  }, { code: item.code || '', stakeStr, keywords });

  if (!clicked) return false;
  await page.waitForTimeout(1500);

  const confirmed = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, .es-dialog-btn, .m-btn, div'))
      .filter(e => e.offsetParent !== null && /^(confirm|cashout|ok|yes)$/i.test((e.innerText || '').trim()));
    if (btns.length > 0) {
      btns[btns.length - 1].click();
      return true;
    }
    return false;
  });
  await page.waitForTimeout(2500);
  return confirmed;
}

(async () => {
  const portfolio = getActivePortfolio();
  const allItems = [...portfolio.tickets, ...portfolio.bullets];
  if (!allItems.length) {
    console.log('[Monitor] No IN_PROGRESS syndicate tickets or monster bullets to track.');
    process.exit(0);
  }
  console.log(`[Monitor] Tracking ${portfolio.tickets.length} Core Tickets + ${portfolio.bullets.length} Monster Bullets:`, allItems.map(t => t.code).join(', '));

  const { browser, context, page } = await S.launchBrowser();
  const liveOpenBetsApi = [];
  page.on('response', async (res) => {
    if (res.url().includes('/api/gh/realSportsGame/openbets?')) {
      try {
        const j = await res.json();
        const list = j?.data?.cashAbleBets || [];
        if (Array.isArray(list)) liveOpenBetsApi.push(...list);
      } catch {}
    }
  });
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);
  const sess = await S.readSession(page);
  if (!sess.isLogged) {
    console.log('[ABORT] Stored session invalid — run node syndicate/active_login_sentinel.js');
    await browser.close();
    process.exit(2);
  }
  console.log(`[Wallet] Live Balance: GHS ${sess.balance.toFixed(2)}`);

  const openData = await scrapeBetCards(page, 'OPEN');
  await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, 'monitor_open_bets.png'), fullPage: true });
  console.log(`[OpenBets] Extracted ${openData.cards.length} card elements (${liveOpenBetsApi.length} API orders).`);

  const settledData = await scrapeBetCards(page, 'SETTLED');
  await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, 'monitor_settled_bets.png'), fullPage: true });
  console.log(`[SettledBets] Extracted ${settledData.cards.length} card elements.`);

  const updates = [];
  const legOutcomeUpdates = [];
  let bustedBulletDetected = false;

  for (const item of allItems) {
    const code = item.code || '';
    const apiOrder = findMatchingApiOrder(liveOpenBetsApi, item);
    const openMatch = findMatchingCard(openData.cards, item);
    const settledMatch = findMatchingCard(settledData.cards, item);

    // Strictly bind API leg outcomes to this item's exact booking_code / ticket_id (NEVER booking_code: null)
    if (apiOrder && Array.isArray(apiOrder.selections)) {
      for (const s of apiOrder.selections) {
        if (s.isSettled === 1) {
          const st = s.settleStatus === 1 ? 'WON' : (s.settleStatus === 2 ? 'LOST' : 'VOID');
          legOutcomeUpdates.push({
            kind: item.kind,
            id: item.id,
            booking_code: code,
            matchText: `${s.home || ''} vs ${s.away || ''}`.trim(),
            marketText: `${s.marketName || ''} ${s.outcomeDesc || s.desc || ''}`.trim(),
            status: st
          });
        }
      }
    }

    let status = 'IN_PROGRESS';
    let cashoutOffer = 0.0;
    let realizedReturn = 0.0;
    let notes = 'Active in Open Bets';

    if (apiOrder || openMatch) {
      // Prefer exact API order cashout value first; fall back to leaf DOM card only if within sane payout bound
      const apiCo = apiOrder ? parseFloat(apiOrder.cashoutAmount || apiOrder.maxCashOutAmount || apiOrder.cashOutAmount || 0) : 0;
      if (apiCo > 0 && (!item.potential_payout || apiCo <= item.potential_payout * 1.01)) {
        cashoutOffer = apiCo;
      } else if (openMatch) {
        const co = openMatch.text.match(/Cashout\s*(?:GHS)?\s*([0-9,]+\.[0-9]{2})/i);
        if (co) {
          const parsedCo = parseFloat(co[1].replace(/,/g, ''));
          if (!item.potential_payout || parsedCo <= item.potential_payout * 1.01) {
            cashoutOffer = parsedCo;
          }
        }
      }
      const equity = item.potential_payout > 0 ? cashoutOffer / item.potential_payout : 0;
      const anyLiveLeg = apiOrder && Array.isArray(apiOrder.selections)
        ? apiOrder.selections.some(s => s.isSettled === 0 && s.matchStatus && s.matchStatus !== 'Not start')
        : false;
      const role = String(item.role || 'SOLO').toUpperCase();
      const pairTarget = Number(item.pair_total_stake || 0) > 0
        ? Number(item.pair_total_stake) * 1.02
        : Number(item.stake || 3.0) * 1.75;

      // Role-Aware Autonomous Cashout Check:
      //  - HARVESTER: Lock 100%+ of BOTH Twin-Pair stakes + instant profit once Wave 1 clears & 0 legs are live!
      //  - SOLO (high-odds >= 15x): Mid-Flight Profit-Lock at >= 3.5x stake (+250% ROI) when no leg is live
      //    (prevents 9121S3-style 12W/1L heartbreaks where GHS 12.26 cashout rides back to GHS 0.00).
      //  - MOONSHOT: Hold 100% risk-free for x100+ Jackpot unless >= 85% equity or >= GHS 150!
      const stakeVal = Number(item.stake || 0);
      const isSoloMidHarvest = role === 'SOLO' && !anyLiveLeg && stakeVal > 0 && Number(item.total_odds || 0) >= 15 && cashoutOffer >= stakeVal * 3.5;
      const triggerCashout = AUTO_CASHOUT && cashoutOffer > 0 && (
        (item.kind === 'TICKET' && (equity >= 0.92 || cashoutOffer >= 100.0)) ||
        (item.kind === 'BULLET' && role === 'HARVESTER' && !anyLiveLeg && cashoutOffer >= pairTarget) ||
        (item.kind === 'BULLET' && isSoloMidHarvest) ||
        (item.kind === 'BULLET' && role !== 'HARVESTER' && (equity >= 0.85 || cashoutOffer >= 150.0))
      );

      if (triggerCashout) {
        console.log(`[AUTO-CASHOUT TRIGGERED] ${item.kind} ${code} offering GHS ${cashoutOffer.toFixed(2)} (${(equity * 100).toFixed(1)}% equity)!`);
        await page.goto('https://www.sportybet.com/gh/m/my_accounts/open_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(3000);
        const ok = await executeCashoutOnPage(page, item);
        if (ok) {
          status = 'CASHED_OUT';
          realizedReturn = cashoutOffer;
          notes = `AUTO_CASHOUT Locked GHS ${cashoutOffer.toFixed(2)}`;
          await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, `auto_cashout_${code}.png`) });
        } else {
          notes = `Open | Cashout: GHS ${cashoutOffer.toFixed(2)} | Equity: ${(equity * 100).toFixed(1)}% (Cashout click deferred)`;
        }
      } else {
        notes = `Open | Cashout: GHS ${cashoutOffer.toFixed(2)} | Equity: ${(equity * 100).toFixed(1)}%`;
      }
      console.log(`  [${item.kind} | ${code}] ${notes}`);
    } else if (settledMatch) {
      const won = /\bWon\b/i.test(settledMatch.text);
      const lost = /\bLost\b/i.test(settledMatch.text);
      const cashed = /\bCash(?:ed)?\s*Out\b/i.test(settledMatch.text);
      const retMatch = settledMatch.text.match(/(?:Return|Payout|Won|Cashout)\s*(?:GHS)?\s*([0-9,]+\.[0-9]{2})/i);
      realizedReturn = retMatch ? parseFloat(retMatch[1].replace(/,/g, '')) : 0.0;
      status = won ? 'WON' : (cashed ? 'CASHED_OUT' : (lost ? 'LOST' : 'SETTLED'));
      notes = `Settled (${status}) | Return: GHS ${realizedReturn.toFixed(2)}`;
      console.log(`  [${item.kind} | ${code}] ${notes}`);

      if (item.kind === 'BULLET' || item.kind === 'TICKET') {
        if (item.kind === 'BULLET' && status === 'LOST') bustedBulletDetected = true;
        // Extract per-leg WON / LOST / VOID statuses strictly scoped to this booking_code
        await page.goto('https://www.sportybet.com/gh/m/my_accounts/open_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2500);
        await page.evaluate(() => {
          const tab = Array.from(document.querySelectorAll('div, span, a, li')).find(e => (e.innerText || '').trim() === 'Bet History');
          if (tab) tab.click();
        });
        await page.waitForTimeout(3000);
        const legResults = await extractBulletLegOutcomes(page, item);
        console.log(`  [LegAudit | ${code}] Extracted ${legResults.length} individual leg outcomes.`);
        for (const lr of legResults) {
          legOutcomeUpdates.push({ kind: item.kind, id: item.id, booking_code: code, ...lr });
        }
      }
    } else {
      console.log(`  [${item.kind} | ${code}] Active (awaiting match kickoffs/settlement)`);
    }

    const realizedPnl = (status === 'WON' || status === 'CASHED_OUT')
      ? (realizedReturn - item.stake)
      : (status === 'LOST' ? -item.stake : 0.0);

    updates.push({
      kind: item.kind,
      id: item.id,
      status,
      cashout_value: cashoutOffer,
      realized_pnl: realizedPnl,
      realized_return: realizedReturn,
      notes
    });
  }

  await S.persistState(context);
  await browser.close();

  py(`
import sqlite3, json, re
from datetime import datetime

def norm_match(name):
    s = re.sub(r'\\b(fc|cf|afc|sc|ac|as|us|fk|sk|bk|ca|cd|ud|sd|u21|u23|1\\.)\\b', ' ', (name or '').lower())
    s = re.sub(r'[^a-z0-9\\s]', ' ', s)
    return re.sub(r'\\s+', ' ', s).strip()

def matches_both_sides(a, b):
    na, nb = norm_match(a), norm_match(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    pa = re.split(r'\\s+v(?:s)?\\s+', na)
    pb = re.split(r'\\s+v(?:s)?\\s+', nb)
    if len(pa) != 2 or len(pb) != 2:
        return False
    def side_ok(x, y):
        return x == y or (len(x) >= 4 and x in y) or (len(y) >= 4 and y in x)
    return side_ok(pa[0], pb[0]) and side_ok(pa[1], pb[1])

now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=15.0)
c.execute("PRAGMA journal_mode=WAL;")
c.execute("PRAGMA busy_timeout=15000;")
c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${sess.balance}, now))

for u in json.loads(${JSON.stringify(JSON.stringify(updates))}):
    if u['kind'] == 'TICKET':
        if u['status'] in ('WON', 'LOST', 'CASHED_OUT'):
            c.execute("UPDATE syndicate_tickets SET status=?, cashout_value=?, realized_pnl=?, settled_at=? WHERE ticket_id=?",
                      (u['status'], u['cashout_value'], u['realized_pnl'], now, u['id']))
            if u['status'] == 'WON':
                c.execute("UPDATE syndicate_legs SET outcome='WON' WHERE ticket_id=? AND outcome='PENDING'", (u['id'],))
        else:
            c.execute("UPDATE syndicate_tickets SET cashout_value=? WHERE ticket_id=?", (u['cashout_value'], u['id']))
    else:
        if u['status'] in ('WON', 'LOST', 'CASHED_OUT'):
            c.execute("UPDATE syndicate_codehub_bullets SET status=?, cashout_value=?, realized_pnl=?, settled_at=? WHERE bullet_id=?",
                      (u['status'], u['cashout_value'], u['realized_pnl'], now, u['id']))
        else:
            c.execute("UPDATE syndicate_codehub_bullets SET cashout_value=? WHERE bullet_id=?", (u['cashout_value'], u['id']))

    c.execute("INSERT INTO syndicate_hedges_cashouts (ticket_id, timestamp, settled_equity, sportybet_cashout_offer, action_taken, realized_return, notes) VALUES (?,?,?,?,?,?,?)",
              (u['id'], now, u['cashout_value'], u['cashout_value'], 'HOLD' if u['status']=='IN_PROGRESS' else u['status'], u['realized_return'], u['notes']))

# Apply per-leg WON/LOST/VOID outcomes strictly by (booking_code, both-sides normalized match_name, optional market/selection)
# NEVER perform global booking_code=None updates or single-team substring matches.
for lr in json.loads(${JSON.stringify(JSON.stringify(legOutcomeUpdates))}):
    bcode = lr.get('booking_code')
    if not bcode:
        continue
    m_txt = lr.get('matchText') or ''
    mkt_txt = (lr.get('marketText') or '').lower()
    if lr.get('kind') == 'TICKET' and lr.get('id'):
        t_rows = c.execute("SELECT id, match_name, market_name, selection FROM syndicate_legs WHERE ticket_id=?", (lr['id'],)).fetchall()
        for leg_id, mname, mkt, sel in t_rows:
            if matches_both_sides(mname, m_txt):
                c.execute("UPDATE syndicate_legs SET outcome=? WHERE id=?", (lr['status'], leg_id))
    else:
        rows = c.execute("SELECT ledger_id, match_name, selection FROM syndicate_creator_anchor_ledger WHERE booking_code=?", (bcode,)).fetchall()
        matched = [(lid, mname, sel) for lid, mname, sel in rows if matches_both_sides(mname, m_txt)]
        if len(matched) > 1 and mkt_txt:
            refined = [r for r in matched if any(tok in (r[2] or '').lower() for tok in mkt_txt.split() if len(tok) >= 3)]
            if refined:
                matched = refined
        for lid, _, _ in matched:
            c.execute("UPDATE syndicate_creator_anchor_ledger SET status=?, updated_at=? WHERE ledger_id=?", (lr['status'], now, lid))

c.commit(); c.close()
print('[Monitor] Unified ledger synced.')
`);

  if (bustedBulletDetected && AUTO_REBULLET) {
    console.log('[Monitor] Monster Bullet busted — invoking Autonomous Survivor Re-Bullet Engine...');
    spawnSync('node', ['syndicate/survivor_rebullet.js'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  }

  spawnSync('python3', ['syndicate/closed_loop_learner.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  spawnSync('python3', ['syndicate/creator_trust_engine.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  spawnSync('python3', ['syndicate/render_syndicate_terminal.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
})();
