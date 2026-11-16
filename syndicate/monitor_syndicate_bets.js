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
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
# Ensure cashout_value column exists on syndicate_codehub_bullets
cols = [r[1] for r in c.execute("PRAGMA table_info(syndicate_codehub_bullets)").fetchall()]
if 'cashout_value' not in cols:
    c.execute("ALTER TABLE syndicate_codehub_bullets ADD COLUMN cashout_value REAL DEFAULT 0.0")
    c.commit()

tickets = c.execute("""
    SELECT ticket_id, ticket_number, booking_code, stake, total_odds, potential_payout
    FROM syndicate_tickets WHERE status='IN_PROGRESS'
""").fetchall()

bullets = c.execute("""
    SELECT bullet_id, booking_code, stake, total_odds, potential_payout, legs_count
    FROM syndicate_codehub_bullets WHERE status='IN_PROGRESS'
""").fetchall()

print(json.dumps({
    "tickets": [dict(kind="TICKET", id=r[0], number=r[1], code=r[2], stake=r[3], total_odds=r[4], potential_payout=r[5]) for r in tickets],
    "bullets": [dict(kind="BULLET", id=r[0], number=r[5], code=r[1], stake=r[2], total_odds=r[3], potential_payout=r[4]) for r in bullets]
}))
`);
  return JSON.parse(out.trim() || '{"tickets":[],"bullets":[]}');
}

async function scrapeBetCards(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const mid = document.querySelector('.m-main-mid') || document.scrollingElement;
      if (mid) mid.scrollTop += 600;
      window.scrollBy(0, 600);
    });
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => {
    const mid = document.querySelector('.m-main-mid');
    if (mid) mid.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);

  return page.evaluate(() => {
    const selectors = '.m-order-card, .order-item, [class*="order-card"], [class*="bet-card"], [class*="bet-list-item"]';
    let cards = Array.from(document.querySelectorAll(selectors));
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('div, li')).filter(el => {
        const t = el.innerText || '';
        return t.length > 30 && t.length < 2500 && (t.includes('Stake') || t.includes('Cashout') || t.includes('Won') || t.includes('Lost')) && el.querySelectorAll('div').length < 50;
      });
    }
    const bodyText = document.body ? document.body.innerText : '';
    return {
      cards: cards.map((c, idx) => ({
        idx,
        text: (c.innerText || '').replace(/\s+/g, ' ').trim(),
        rawLines: (c.innerText || '').split('\n').map(s => s.trim()).filter(Boolean),
        hasCashoutBtn: !!c.querySelector('[data-op*="cashout"], [class*="cashout"]')
      })),
      bodyText: bodyText.slice(0, 8000)
    };
  });
}

async function extractBulletLegOutcomes(page, bookingCode) {
  // Click into the matching bet card to inspect individual leg statuses (Won / Lost / Void)
  const clicked = await page.evaluate((code) => {
    const els = Array.from(document.querySelectorAll('.m-order-card, .order-item, [class*="order-card"], [class*="bet-card"], div, li'));
    const target = els.find(el => {
      const t = el.innerText || '';
      return t.includes(code) && t.length < 2500 && el.querySelectorAll('div').length < 50;
    });
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    }
    return false;
  }, bookingCode);

  if (!clicked) return [];
  await page.waitForTimeout(2500);

  const legLines = await page.evaluate(() => {
    return (document.body ? document.body.innerText : '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  });

  // Parse leg blocks: look for match strings ("Home vs Away" or "Home v Away") paired with Won/Lost/Void nearby
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

async function executeCashoutOnPage(page, bookingCode) {
  const clicked = await page.evaluate((code) => {
    const els = Array.from(document.querySelectorAll('.m-order-card, .order-item, [class*="order-card"], [class*="bet-card"], div, li'));
    const card = els.find(el => {
      const t = el.innerText || '';
      return t.includes(code) && t.length < 2500 && el.querySelectorAll('div').length < 50;
    });
    if (!card) return false;
    const btn = card.querySelector('[data-op*="cashout"], [class*="cashout"], button');
    if (btn && /cashout/i.test(btn.innerText || '')) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }
    return false;
  }, bookingCode);

  if (!clicked) return false;
  await page.waitForTimeout(1500);

  // Confirm cashout dialog if present
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
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);
  const sess = await S.readSession(page);
  if (!sess.isLogged) {
    console.log('[ABORT] Stored session invalid — run node syndicate/active_login_sentinel.js');
    await browser.close();
    process.exit(2);
  }
  console.log(`[Wallet] Live Balance: GHS ${sess.balance.toFixed(2)}`);

  const openData = await scrapeBetCards(page, 'https://www.sportybet.com/gh/m/my_accounts/open_bets');
  await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, 'monitor_open_bets.png'), fullPage: true });
  console.log(`[OpenBets] Extracted ${openData.cards.length} card elements.`);

  const settledData = await scrapeBetCards(page, 'https://www.sportybet.com/gh/m/my_accounts/settled_bets');
  await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, 'monitor_settled_bets.png'), fullPage: true });
  console.log(`[SettledBets] Extracted ${settledData.cards.length} card elements.`);

  const updates = [];
  const legOutcomeUpdates = [];
  let bustedBulletDetected = false;

  for (const item of allItems) {
    const code = item.code || '';
    const openMatch = openData.cards.find(c => code && c.text.includes(code));
    const settledMatch = settledData.cards.find(c => code && c.text.includes(code));

    let status = 'IN_PROGRESS';
    let cashoutOffer = 0.0;
    let realizedReturn = 0.0;
    let notes = 'Active in Open Bets';

    if (openMatch) {
      const co = openMatch.text.match(/Cashout\s*(?:GHS)?\s*([0-9,]+\.[0-9]{2})/i);
      if (co) cashoutOffer = parseFloat(co[1].replace(/,/g, ''));
      const equity = item.potential_payout > 0 ? cashoutOffer / item.potential_payout : 0;

      // Autonomous Cashout Profit-Lock Check
      const triggerCashout = AUTO_CASHOUT && cashoutOffer > 0 && (
        (item.kind === 'TICKET' && (equity >= 0.92 || cashoutOffer >= 100.0)) ||
        (item.kind === 'BULLET' && cashoutOffer >= 150.0)
      );

      if (triggerCashout) {
        console.log(`[AUTO-CASHOUT TRIGGERED] ${item.kind} ${code} offering GHS ${cashoutOffer.toFixed(2)} (${(equity * 100).toFixed(1)}% equity)!`);
        await page.goto('https://www.sportybet.com/gh/m/my_accounts/open_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(3000);
        const ok = await executeCashoutOnPage(page, code);
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

      if (item.kind === 'BULLET') {
        if (status === 'LOST') bustedBulletDetected = true;
        // Extract per-leg WON / LOST / VOID statuses for creator trust attribution
        await page.goto('https://www.sportybet.com/gh/m/my_accounts/settled_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2500);
        const legResults = await extractBulletLegOutcomes(page, code);
        console.log(`  [LegAudit | ${code}] Extracted ${legResults.length} individual leg outcomes.`);
        for (const lr of legResults) {
          legOutcomeUpdates.push({ booking_code: code, ...lr });
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
import sqlite3, json
from datetime import datetime
now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${sess.balance}, now))

for u in json.loads(${JSON.stringify(JSON.stringify(updates))}):
    if u['kind'] == 'TICKET':
        if u['status'] in ('WON', 'LOST', 'CASHED_OUT'):
            c.execute("UPDATE syndicate_tickets SET status=?, cashout_value=?, realized_pnl=?, settled_at=? WHERE ticket_id=?",
                      (u['status'], u['cashout_value'], u['realized_pnl'], now, u['id']))
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

# Apply per-leg WON/LOST/VOID outcomes to syndicate_creator_anchor_ledger
for lr in json.loads(${JSON.stringify(JSON.stringify(legOutcomeUpdates))}):
    m_txt = lr['matchText'].lower()
    rows = c.execute("SELECT ledger_id, match_name FROM syndicate_creator_anchor_ledger WHERE booking_code=?", (lr['booking_code'],)).fetchall()
    for lid, mname in rows:
        parts = [p.strip().lower() for p in mname.split(' vs ')]
        if any(len(p) >= 4 and p in m_txt for p in parts):
            c.execute("UPDATE syndicate_creator_anchor_ledger SET status=?, updated_at=? WHERE ledger_id=?", (lr['status'], now, lid))

c.commit(); c.close()
print('[Monitor] Unified ledger synced.')
`);

  if (bustedBulletDetected && AUTO_REBULLET) {
    console.log('[Monitor] Monster Bullet busted — invoking Autonomous Survivor Re-Bullet Engine...');
    spawnSync('node', ['syndicate/survivor_rebullet.js'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  }

  spawnSync('python3', ['syndicate/creator_trust_engine.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  spawnSync('python3', ['syndicate/render_syndicate_terminal.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
})();
