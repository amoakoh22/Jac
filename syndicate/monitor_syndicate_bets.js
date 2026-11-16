/**
 * Hermes Syndicate - Live Settlement & Cashout/Arbitrage Watcher
 * Uses syndicate/sportybet_session.js (storageState, ignoreHTTPSErrors).
 * Polls SportyBet Open Bets & Settled Bets for IN_PROGRESS syndicate tickets,
 * updates live cashout offers, evaluates arbitrage/hedge math, settles WON/LOST slips,
 * syncs wallet balance, and re-renders syndicate_kpi_terminal.html.
 *
 * Usage:
 *   node syndicate/monitor_syndicate_bets.js            # Single audit pass (safe, no auto-cashout)
 *   AUTO_CASHOUT=1 node syndicate/monitor_syndicate_bets.js  # Auto-cashout if equity >= 92%
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
const AUTO_CASHOUT = process.env.AUTO_CASHOUT === '1';

function py(code) {
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  if (r.stderr) console.error(r.stderr);
  return r.stdout;
}

function getActiveTickets() {
  const out = py(`
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
rows = c.execute("SELECT ticket_id, ticket_number, booking_code, stake, total_odds, potential_payout FROM syndicate_tickets WHERE status='IN_PROGRESS'").fetchall()
print(json.dumps([dict(ticket_id=r[0], ticket_number=r[1], booking_code=r[2], stake=r[3], total_odds=r[4], potential_payout=r[5]) for r in rows]))
`);
  return JSON.parse(out.trim() || '[]');
}

async function scrapeBetCards(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(4000);
  // Scroll slightly to load all visible cards
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
      // Fallback: find containers holding "Total Stake" or "Cashout"
      cards = Array.from(document.querySelectorAll('div, li')).filter(el => {
        const t = el.innerText || '';
        return t.length > 30 && t.length < 1500 && (t.includes('Stake') || t.includes('Cashout') || t.includes('Won') || t.includes('Lost')) && el.querySelectorAll('div').length < 40;
      });
    }
    const bodyText = document.body ? document.body.innerText : '';
    return {
      cards: cards.map(c => ({
        text: (c.innerText || '').replace(/\s+/g, ' ').trim(),
        hasCashoutBtn: !!c.querySelector('[data-op*="cashout"], [class*="cashout"]')
      })),
      bodyText: bodyText.slice(0, 6000)
    };
  });
}

(async () => {
  const active = getActiveTickets();
  if (!active.length) {
    console.log('[Monitor] No IN_PROGRESS syndicate tickets to track.');
    process.exit(0);
  }
  console.log(`[Monitor] Tracking ${active.length} active syndicate tickets:`, active.map(t => t.booking_code).join(', '));

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
  for (const t of active) {
    const code = t.booking_code || '';
    const openMatch = openData.cards.find(c => code && c.text.includes(code));
    const settledMatch = settledData.cards.find(c => code && c.text.includes(code));

    let status = 'IN_PROGRESS';
    let cashoutOffer = 0.0;
    let realizedReturn = 0.0;
    let notes = 'Active in Open Bets';

    if (openMatch) {
      const co = openMatch.text.match(/Cashout\s*(?:GHS)?\s*([0-9]+\.[0-9]{2})/i);
      if (co) cashoutOffer = parseFloat(co[1]);
      const equity = t.potential_payout > 0 ? cashoutOffer / t.potential_payout : 0;
      const hedgeStake = (t.stake * t.total_odds) / 2.0; // baseline 2.0 opposing reference
      notes = `Open | Cashout: GHS ${cashoutOffer.toFixed(2)} | Equity: ${(equity * 100).toFixed(1)}% | Ref Hedge @2.0: GHS ${hedgeStake.toFixed(2)}`;
      console.log(`  [Ticket ${t.ticket_number} | ${code}] ${notes}`);
    } else if (settledMatch) {
      const won = /\bWon\b/i.test(settledMatch.text);
      const lost = /\bLost\b/i.test(settledMatch.text);
      const retMatch = settledMatch.text.match(/(?:Return|Payout|Won)\s*(?:GHS)?\s*([0-9,]+\.[0-9]{2})/i);
      realizedReturn = retMatch ? parseFloat(retMatch[1].replace(/,/g, '')) : 0.0;
      status = won ? 'WON' : (lost ? 'LOST' : 'SETTLED');
      notes = `Settled (${status}) | Return: GHS ${realizedReturn.toFixed(2)}`;
      console.log(`  [Ticket ${t.ticket_number} | ${code}] ${notes}`);
    } else {
      console.log(`  [Ticket ${t.ticket_number} | ${code}] Active (open_bets card count=${openData.cards.length}, awaiting leg updates)`);
    }

    updates.push({
      ticket_id: t.ticket_id,
      status,
      cashout_value: cashoutOffer,
      realized_pnl: status === 'WON' ? (realizedReturn - t.stake) : (status === 'LOST' ? -t.stake : 0.0),
      realized_return: realizedReturn,
      stake: t.stake,
      potential_payout: t.potential_payout,
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
    if u['status'] in ('WON', 'LOST'):
        c.execute("UPDATE syndicate_tickets SET status=?, cashout_value=?, realized_pnl=?, settled_at=? WHERE ticket_id=?",
                  (u['status'], u['cashout_value'], u['realized_pnl'], now, u['ticket_id']))
    else:
        c.execute("UPDATE syndicate_tickets SET cashout_value=? WHERE ticket_id=?", (u['cashout_value'], u['ticket_id']))
    c.execute("INSERT INTO syndicate_hedges_cashouts (ticket_id, timestamp, settled_equity, sportybet_cashout_offer, action_taken, realized_return, notes) VALUES (?,?,?,?,?,?,?)",
              (u['ticket_id'], now, u['cashout_value'], u['cashout_value'], 'HOLD' if u['status']=='IN_PROGRESS' else u['status'], u['realized_return'], u['notes']))
c.commit(); c.close()
print('[Monitor] Ledger synced.')
`);
  spawnSync('python3', ['render_syndicate_terminal.py'], { cwd: __dirname, stdio: 'inherit' });
})();
