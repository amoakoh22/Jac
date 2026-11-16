/**
 * Hermes Syndicate - 20-Fold Monster CodeHub Accumulator (500x - 5,000x+ Target)
 * Combines 20 clean, trap-purged CodeHub consensus anchors (Nov 20 - Nov 25)
 * onto a single 20-fold accumulator to maximize SportyBet Multi-Bet Win Bonus.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');

const MONSTER_LEGS = [
  { search: 'Athletic Bilbao', home: 'Athletic Bilbao', away: 'Espanyol', idx: 0, ko: '20/11 20:00' },
  { search: 'Bodoe/Glimt', home: 'Molde', away: 'Bodoe/Glimt', idx: 2, ko: '20/11 18:00' },
  { search: 'Como 1907', home: 'Como 1907', away: 'Cagliari', idx: 0, ko: '21/11 14:00' },
  { search: 'Parma Calcio', home: 'Parma Calcio', away: 'Roma', idx: 2, ko: '21/11 17:00' },
  { search: 'Real Madrid', home: 'Real Madrid', away: 'Celta', idx: 0, ko: '21/11 20:00' },
  { search: 'Lazio', home: 'Lazio', away: 'Lecce', idx: 0, ko: '21/11 14:00' },
  { search: 'RB Leipzig', home: 'Union Berlin', away: 'RB Leipzig', idx: 2, ko: '21/11 14:30' },
  { search: 'Nice', home: 'Nice', away: 'PSG', idx: 2, ko: '21/11 16:15' },
  { search: 'Chelsea', home: 'Chelsea', away: 'Leeds United', idx: 0, ko: '21/11 15:00' },
  { search: 'Galatasaray', home: 'Galatasaray', away: 'Samsunspor', idx: 0, ko: '21/11 13:00' },
  { search: 'Aston Villa', home: 'Aston Villa', away: 'Sunderland', idx: 0, ko: '21/11 15:00' },
  { search: 'Tottenham', home: 'Tottenham', away: 'Ipswich', idx: 0, ko: '21/11 15:00' },
  { search: 'Napoli', home: 'Napoli', away: 'Torino', idx: 0, ko: '21/11 19:45' },
  { search: 'Man City', home: 'Man City', away: 'Fulham', idx: 0, ko: '21/11 12:30' },
  { search: 'Fenerbahce', home: 'Kocaelispor', away: 'Fenerbahce', idx: 2, ko: '21/11 16:00' },
  { search: 'Arsenal', home: 'Newcastle', away: 'Arsenal', idx: 2, ko: '21/11 17:30' },
  { search: 'PSV Eindhoven', home: 'NEC Nijmegen', away: 'PSV Eindhoven', idx: 2, ko: '21/11 15:30' },
  { search: 'Eintracht Frankfurt', home: 'Eintracht Frankfurt', away: 'Hoffenheim', idx: 0, ko: '21/11 14:30' },
  { search: 'Feyenoord', home: 'Feyenoord', away: 'Excelsior', idx: 0, ko: '21/11 17:45' },
  { search: 'Barcelona', home: 'Barcelona', away: 'Villarreal', idx: 0, ko: '22/11 13:00' }
];

async function searchAndSelect(page, leg) {
  await page.goto('https://www.sportybet.com/gh/m/search', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(1800);
  const inp = page.locator('input').first();
  await inp.fill(leg.search);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2600);

  const r = await page.evaluate(({ home, away, idx }) => {
    const rows = Array.from(document.querySelectorAll('.m-table-row.m-sports-table, .m-event-sport.m-sports-row'));
    const row = rows.find(x => {
      const t = x.innerText || '';
      const n = x.querySelectorAll('.m-outcome').length;
      return t.includes(home) && t.includes(away) && !t.includes('SRL') && n >= 2 && n <= 6;
    });
    if (!row) return { ok: false };
    const target = Array.from(row.querySelectorAll('.m-outcome'))[idx];
    if (!target) return { ok: false };
    const odds = parseFloat(target.innerText.trim());
    if (isNaN(odds) || odds > 3.5) return { ok: false, reason: `odds ${odds} out of favorite band` };
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true, odds };
  }, leg);

  if (r.ok) await page.waitForTimeout(900);
  return r;
}

(async () => {
  const { browser, context, page } = await S.launchBrowser();
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2500);
  const sess = await S.readSession(page);
  if (!sess.isLogged) { console.log('[ABORT] Invalid session'); await browser.close(); process.exit(2); }
  console.log(`[Wallet] Starting Balance: GHS ${sess.balance.toFixed(2)}`);

  await S.clearBetslip(page);
  const picked = [];
  for (const leg of MONSTER_LEGS) {
    const r = await searchAndSelect(page, leg);
    console.log(`  [${picked.length + 1}] ${leg.home} v ${leg.away} [${leg.idx}] ->`, r.ok ? r.odds : (r.reason || 'NOT FOUND'));
    if (r.ok) picked.push({ ...leg, live_odds: r.odds });
  }

  const count = await S.getSlipCount(page);
  const rawOdds = picked.reduce((a, x) => a * x.live_odds, 1);
  console.log(`[Monster] Selected ${count}/${MONSTER_LEGS.length} legs | Base Odds: ${rawOdds.toFixed(2)}x`);

  if (count < 15) {
    console.log('[ABORT] Fewer than 15 legs selected — clearing betslip.');
    await S.clearBetslip(page);
    await browser.close();
    process.exit(1);
  }

  const stakeStr = '2';
  const res = await S.placeMulti(page, stakeStr, 'codehub_monster_20fold_receipt.png');
  console.log('[RECEIPT] Monster 20-Fold:', JSON.stringify(res));

  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);
  const after = await S.readSession(page);
  await S.persistState(context);
  await browser.close();

  if (res.success) {
    spawnSync('python3', ['-c', `
import sqlite3
from datetime import datetime
now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
c.execute("""INSERT OR REPLACE INTO syndicate_codehub_bullets
    (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)""",
    ('CH_MONSTER_20261116_20F', 'D30CM5+B10A53+807N0V', ${parseFloat(res.stake || stakeStr)}, ${rawOdds.toFixed(2)}, ${parseFloat(res.potentialWin || 0)}, ${count}, 'IN_PROGRESS', ${JSON.stringify(res.code)}, now))
if ${after.balance !== null ? after.balance : 'None'} is not None:
    c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${after.balance || 0}, now))
c.commit(); c.close()
`]);
    spawnSync('python3', ['syndicate/render_syndicate_terminal.py'], { stdio: 'inherit' });
  }
  console.log('[Monster] Complete:', JSON.stringify({ before: sess.balance, after: after.balance, code: res.code, stake: res.stake, potentialWin: res.potentialWin, legs: count, baseOdds: +rawOdds.toFixed(2) }));
})();
