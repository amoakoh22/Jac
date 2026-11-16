/**
 * Hermes Syndicate - CodeHub Micro-Bullets Placer (5 x GHS 1.00 = GHS 5.00)
 * Synthesizes 5 mutually exclusive 5-leg multi-week bullets (Nov 20 - Nov 25)
 * from trap-purged CodeHub consensus anchors, finds each fixture via /gh/m/search
 * (SRL excluded), stakes GHS 1.00 via keypad, records real receipts in
 * syndicate_codehub_bullets, updates wallet, and re-renders syndicate_kpi_terminal.html.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');

const BULLETS = [
  {
    bullet: 1,
    source_code: 'D30CM5',
    stake: '1',
    legs: [
      { search: 'Athletic Bilbao', home: 'Athletic Bilbao', away: 'Espanyol', idx: 0, ko: '20/11 20:00' },
      { search: 'Como 1907', home: 'Como 1907', away: 'Cagliari', idx: 0, ko: '21/11 14:00' },
      { search: 'Parma Calcio', home: 'Parma Calcio', away: 'Roma', idx: 2, ko: '21/11 17:00' },
      { search: 'Real Madrid', home: 'Real Madrid', away: 'Celta', idx: 0, ko: '21/11 20:00' },
      { search: 'Barcelona', home: 'Barcelona', away: 'Villarreal', idx: 0, ko: '22/11 13:00' }
    ]
  },
  {
    bullet: 2,
    source_code: 'B10A53',
    stake: '1',
    legs: [
      { search: 'Lazio', home: 'Lazio', away: 'Lecce', idx: 0, ko: '21/11 14:00' },
      { search: 'RB Leipzig', home: 'Union Berlin', away: 'RB Leipzig', idx: 2, ko: '21/11 14:30' },
      { search: 'Nice', home: 'Nice', away: 'PSG', idx: 2, ko: '21/11 16:15' },
      { search: 'Chelsea', home: 'Chelsea', away: 'Leeds United', idx: 0, ko: '21/11 15:00' },
      { search: 'Bayer Leverkusen', home: 'Bayer Leverkusen', away: 'Paderborn', idx: 0, ko: '21/11 14:30' }
    ]
  },
  {
    bullet: 3,
    source_code: '807N0V',
    stake: '1',
    legs: [
      { search: 'Galatasaray', home: 'Galatasaray', away: 'Samsunspor', idx: 0, ko: '21/11 13:00' },
      { search: 'Aston Villa', home: 'Aston Villa', away: 'Sunderland', idx: 0, ko: '21/11 15:00' },
      { search: 'Tottenham', home: 'Tottenham', away: 'Ipswich', idx: 0, ko: '21/11 15:00' },
      { search: 'Napoli', home: 'Napoli', away: 'Torino', idx: 0, ko: '21/11 19:45' },
      { search: 'Bayern Munich', home: 'Lille', away: 'Bayern Munich', idx: 2, ko: '25/11 20:00' }
    ]
  },
  {
    bullet: 4,
    source_code: 'DASQJ1',
    stake: '1',
    legs: [
      { search: 'Man City', home: 'Man City', away: 'Fulham', idx: 0, ko: '21/11 12:30' },
      { search: 'Fenerbahce', home: 'Kocaelispor', away: 'Fenerbahce', idx: 2, ko: '21/11 16:00' },
      { search: 'Arsenal', home: 'Newcastle', away: 'Arsenal', idx: 2, ko: '21/11 17:30' },
      { search: 'PSV Eindhoven', home: 'NEC Nijmegen', away: 'PSV Eindhoven', idx: 2, ko: '21/11 15:30' },
      { search: 'Eintracht Frankfurt', home: 'Eintracht Frankfurt', away: 'Hoffenheim', idx: 0, ko: '21/11 14:30' }
    ]
  },
  {
    bullet: 5,
    source_code: 'FMCVFG',
    stake: '1',
    legs: [
      { search: 'Borussia Dortmund', home: 'Borussia', away: 'Borussia Dortmund', idx: 2, ko: '21/11 14:30' },
      { search: 'Feyenoord', home: 'Feyenoord', away: 'Excelsior', idx: 0, ko: '21/11 17:45' },
      { search: 'Ajax', home: 'Ajax', away: 'ADO Den Haag', idx: 0, ko: '22/11 13:30' },
      { search: 'Bodoe/Glimt', home: 'Molde', away: 'Bodoe/Glimt', idx: 2, ko: '20/11 18:00' },
      { search: 'Lyon', home: 'Lille', away: 'Lyon', idx: 2, ko: '21/11 19:45' }
    ]
  }
];

async function searchAndSelect(page, leg) {
  await page.goto('https://www.sportybet.com/gh/m/search', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2000);
  const inp = page.locator('input').first();
  await inp.fill(leg.search);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2800);

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
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true, odds: parseFloat(target.innerText.trim()) };
  }, leg);

  if (r.ok) await page.waitForTimeout(1000);
  return r;
}

(async () => {
  // Zero-correlation check across all 5 bullets
  const allKeys = BULLETS.flatMap(b => b.legs.map(l => `${l.home}|${l.away}`));
  if (new Set(allKeys).size !== allKeys.length) throw new Error('Duplicate fixture in CodeHub bullets!');

  const { browser, context, page } = await S.launchBrowser();
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2500);
  const sess = await S.readSession(page);
  if (!sess.isLogged) { console.log('[ABORT] Invalid session'); await browser.close(); process.exit(2); }
  console.log(`[Wallet] Starting Balance: GHS ${sess.balance.toFixed(2)}`);

  const results = [];
  for (const b of BULLETS) {
    console.log(`\n=== CODEHUB BULLET ${b.bullet} (from ${b.source_code}, GHS ${b.stake}.00) ===`);
    await S.clearBetslip(page);
    const picked = [];
    let missing = null;
    for (const leg of b.legs) {
      const r = await searchAndSelect(page, leg);
      console.log(`  ${leg.home} v ${leg.away} [${leg.idx}] ->`, r.ok ? r.odds : 'NOT FOUND');
      if (!r.ok) { missing = `${leg.home} v ${leg.away}`; break; }
      picked.push({ ...leg, live_odds: r.odds });
    }
    const count = await S.getSlipCount(page);
    if (missing || count !== b.legs.length) {
      console.log(`[SKIP] Bullet ${b.bullet} not placed (missing: ${missing || 'none'}, count ${count}/${b.legs.length})`);
      await S.clearBetslip(page);
      results.push({ bullet: b.bullet, placed: false, reason: missing || `count ${count}` });
      continue;
    }
    const totalOdds = picked.reduce((a, x) => a * x.live_odds, 1);
    const res = await S.placeMulti(page, b.stake, `codehub_bullet_${b.bullet}_receipt.png`);
    console.log(`[RECEIPT] Bullet ${b.bullet}:`, JSON.stringify(res));
    results.push({ bullet: b.bullet, source_code: b.source_code, placed: res.success, ...res, totalOdds, legsCount: picked.length });
  }

  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);
  const after = await S.readSession(page);
  await S.persistState(context);
  await browser.close();

  spawnSync('python3', ['-c', `
import sqlite3, json
from datetime import datetime
now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
for r in json.loads(${JSON.stringify(JSON.stringify(results))}):
    if not r.get('placed'): continue
    bid = 'CH_BULLET_20261116_%d' % r['bullet']
    pw = float(r['potentialWin']) if r.get('potentialWin') else None
    c.execute("""INSERT OR REPLACE INTO syndicate_codehub_bullets
        (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)""",
        (bid, r['source_code'], float(r.get('stake') or 1.0), round(r['totalOdds'], 2), pw, r['legsCount'], 'IN_PROGRESS', r.get('code'), now))
if ${after.balance !== null ? after.balance : 'None'} is not None:
    c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${after.balance || 0}, now))
c.commit(); c.close()
`]);
  spawnSync('python3', ['render_syndicate_terminal.py'], { cwd: __dirname, stdio: 'inherit' });

  console.log('\n=== CODEHUB BULLETS SUMMARY ===');
  console.log(JSON.stringify({ before: sess.balance, after: after.balance, results }, null, 2));
})();
