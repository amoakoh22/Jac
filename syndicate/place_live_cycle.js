/**
 * Hermes Syndicate - Live Cycle Placement (Playbook-compliant)
 * Reads syndicate/plans/<plan>.json (built only from harvested live SportyBet rows),
 * enforces the zero-correlation firewall, selects legs with two-team row matching
 * (SRL excluded), verifies betslip leg count, stakes via the keypad, parses the real receipt,
 * and records only real booking codes in data/syndicate_ledger.sqlite.
 * A ticket with any missing leg is NOT placed (no partial slips).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const PLAN = process.argv[2] || path.join(__dirname, 'plans', 'cycle_2026_11_16.json');
const CYCLE_ID = process.env.CYCLE_ID || 'CYCLE_2026_11_16_LIVE';
const DRY = process.env.DRY === '1';
const URLS = {
  football: 'https://www.sportybet.com/gh/m/sport/football/today',
  nba: 'https://www.sportybet.com/gh/m/sport/basketball/sr:category:15/sr:tournament:132'
};

async function resetScroll(page) {
  await page.evaluate(() => {
    const mid = document.querySelector('.m-main-mid');
    if (mid) mid.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

async function selectFixture(page, home, away, idx) {
  await resetScroll(page);
  for (let attempt = 0; attempt < 35; attempt++) {
    const r = await page.evaluate(({ home, away, idx }) => {
      const rows = Array.from(document.querySelectorAll('.m-table-row.m-sports-table, .m-event-sport.m-sports-row'));
      const row = rows.find(x => {
        const t = x.innerText || '';
        const n = x.querySelectorAll('.m-outcome').length;
        return t.includes(home) && t.includes(away) && !t.includes('SRL') && n >= 2 && n <= 6;
      });
      if (row) {
        const target = Array.from(row.querySelectorAll('.m-outcome'))[idx];
        if (!target) return { ok: false, reason: 'outcome missing' };
        target.scrollIntoView({ block: 'center' });
        target.click();
        return { ok: true, odds: parseFloat(target.innerText.trim()) };
      }
      const mid = document.querySelector('.m-main-mid') || document.scrollingElement || document.documentElement;
      const before = mid.scrollTop;
      mid.scrollTop += 400;
      window.scrollBy(0, 400);
      const atEnd = mid.scrollTop === before && (mid.scrollTop + mid.clientHeight >= mid.scrollHeight - 10);
      return { ok: false, atEnd };
    }, { home, away, idx });
    if (r.ok) { await page.waitForTimeout(1000); return r; }
    if (r.atEnd) break;
    await page.waitForTimeout(350);
  }
  return { ok: false };
}

async function slipCount(page) {
  return S.getSlipCount(page);
}

function py(code) {
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  if (r.stderr) console.log(r.stderr);
  return r.stdout;
}

(async () => {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));

  // Heuristic #25 firewall
  const keys = plan.flatMap(t => t.legs.map(l => `${l.home}|${l.away}`));
  if (new Set(keys).size !== keys.length) throw new Error('Zero-correlation firewall violated: duplicate fixture');

  const { browser, context, page } = await S.launchBrowser();
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);
  const sess = await S.readSession(page);
  if (!sess.isLogged) { console.log('[ABORT] Stored session invalid - run active_login_sentinel.js'); await browser.close(); process.exit(2); }
  console.log(`[Wallet] GHS ${sess.balance}`);
  const exposure = plan.reduce((a, t) => a + parseFloat(t.stake), 0);
  if (exposure > sess.balance * 0.24) { console.log('[ABORT] Exposure exceeds 24% cap'); await browser.close(); process.exit(3); }

  const results = [];
  for (const t of plan) {
    console.log(`\n=== TICKET ${t.ticket} (${t.legs.length} legs, est ${t.est_odds}x) ===`);
    const picked = [];
    let failed = null;
    for (const pg of ['football', 'nba']) {
      const legs = t.legs.filter(l => l.page === pg);
      if (!legs.length) continue;
      await page.goto(URLS[pg], { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(4000);
      if (!picked.length) await S.clearBetslip(page);
      for (const l of legs) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const r = await selectFixture(page, l.home, l.away, l.idx);
        console.log(`  ${l.home} v ${l.away} [${l.idx}] plan ${l.odds} ->`, r.ok ? r.odds : 'NOT FOUND');
        if (!r.ok) { failed = `${l.home} v ${l.away}`; break; }
        picked.push({ ...l, live_odds: r.odds });
      }
      if (failed) break;
    }
    const count = await slipCount(page);
    if (failed || count !== t.legs.length) {
      console.log(`[SKIP] Ticket ${t.ticket} not placed (missing: ${failed || 'none'}, slip count ${count}/${t.legs.length})`);
      await S.clearBetslip(page);
      results.push({ ticket: t.ticket, placed: false, reason: failed || `count ${count}` });
      continue;
    }
    const liveOdds = picked.reduce((a, l) => a * l.live_odds, 1);
    if (DRY) { results.push({ ticket: t.ticket, placed: false, dry: true, liveOdds }); await S.clearBetslip(page); continue; }

    const res = await S.placeMulti(page, t.stake, `cycle_${CYCLE_ID}_t${t.ticket}_receipt.png`);
    console.log(`[RECEIPT] Ticket ${t.ticket}:`, JSON.stringify(res));
    results.push({ ticket: t.ticket, placed: res.success, ...res, liveOdds, picked });
  }

  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3500);
  const after = await S.readSession(page);
  await page.goto('https://www.sportybet.com/gh/m/my_accounts/open_bets', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(S.SCREENSHOT_DIR, `cycle_${CYCLE_ID}_open_bets.png`), fullPage: true });
  await S.persistState(context);
  await browser.close();

  fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', `cycle_${CYCLE_ID}_results.json`), JSON.stringify({ before: sess.balance, after: after.balance, results }, null, 2));

  if (!DRY) {
    const db = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
    py(`
import sqlite3, json
from datetime import datetime
d = json.load(open(${JSON.stringify(path.join(S.ROOT_DIR, 'runtime', `cycle_${CYCLE_ID}_results.json`))}))
c = sqlite3.connect(${JSON.stringify(db)})
now = datetime.utcnow().isoformat()
c.execute("UPDATE syndicate_tickets SET status='ABORTED_UNPLACED' WHERE status='PENDING' AND (booking_code IS NULL OR booking_code='')")
c.execute("INSERT OR REPLACE INTO syndicate_cycles (cycle_id,start_date,end_date,total_tickets,ticket_stake,total_exposure,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
          ('${CYCLE_ID}','2026-11-16','2026-11-17',4,5.0,sum(5.0 for r in d['results'] if r.get('placed')),'ACTIVE',now))
for r in d['results']:
    if not r.get('placed'): continue
    tid = '${CYCLE_ID}_T%d' % r['ticket']
    stake = float(r.get('stake') or 5)
    pw = float(r['potentialWin']) if r.get('potentialWin') else None
    c.execute("INSERT OR REPLACE INTO syndicate_tickets (ticket_id,cycle_id,ticket_number,title,stake,total_odds,potential_payout,status,booking_code,placed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
              (tid,'${CYCLE_ID}',r['ticket'],'Ticket %d: Live Cross-Sport Accumulator' % r['ticket'],stake,round(r['liveOdds'],2),pw,'IN_PROGRESS',r.get('code'),now))
    c.execute("DELETE FROM syndicate_legs WHERE ticket_id=?", (tid,))
    for i,l in enumerate(r['picked']):
        sel = l['home'] if l['idx']==0 else (l['away'] if (l['page']=='nba' or l['idx']==2) else 'Draw')
        sport = 'Basketball' if l['page']=='nba' else 'Football'
        market = 'Winner' if l['page']=='nba' else '1X2'
        c.execute("INSERT INTO syndicate_legs (ticket_id,leg_order,match_name,sport,league,kickoff_gmt,market_category,market_name,selection,odds,sportybet_breadcrumb) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (tid,i+1,'%s vs %s'%(l['home'],l['away']),sport,l['league'],'2026-11-16 '+l['ko']+' GMT','Main',market,sel,l['live_odds'],'%s > %s > Main > %s: %s @ %.2f'%(sport,l['league'],market,sel,l['live_odds'])))
tot_exp = c.execute("SELECT COALESCE(SUM(stake),0) FROM syndicate_tickets WHERE cycle_id=? AND status='IN_PROGRESS'", ('${CYCLE_ID}',)).fetchone()[0]
c.execute("UPDATE syndicate_cycles SET total_exposure=? WHERE cycle_id=?", (tot_exp, '${CYCLE_ID}'))
if d.get('after') is not None:
    c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (d['after'], now))
c.commit(); c.close()
print('[Ledger] Cycle recorded.')`);
    spawnSync('python3', ['render_syndicate_terminal.py'], { cwd: __dirname, stdio: 'inherit' });
  }
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ before: sess.balance, after: after.balance, results: results.map(r => ({ ticket: r.ticket, placed: r.placed, code: r.code, stake: r.stake, potentialWin: r.potentialWin, liveOdds: r.liveOdds && +r.liveOdds.toFixed(2), reason: r.reason })) }, null, 2));
})();
