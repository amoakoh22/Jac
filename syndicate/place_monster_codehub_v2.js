/**
 * Hermes Syndicate - Monster Accumulator #2 (100% Uncorrelated From D8WJHX)
 * Strictly excludes all 20 fixtures & 40 teams present on D8WJHX.
 * Builds a 20-to-24-Fold high-multiplier accumulator (Target: 1,500x - 8,000x+)
 * from Elite Alpha / Verified Sharp CodeHub consensus + European domestic giants.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');

// Strict blacklist of all 40 teams on Monster #1 (D8WJHX)
const D8WJHX_TEAMS = [
  'Athletic Bilbao', 'Espanyol',
  'Molde', 'Bodoe/Glimt', 'Bodo/Glimt',
  'Como 1907', 'Cagliari',
  'Parma', 'Roma',
  'Real Madrid', 'Celta',
  'Lazio', 'Lecce',
  'Union Berlin', 'RB Leipzig', 'Leipzig',
  'Nice', 'PSG', 'Paris Saint-Germain',
  'Chelsea', 'Leeds',
  'Galatasaray', 'Samsunspor',
  'Aston Villa', 'Sunderland',
  'Tottenham', 'Ipswich',
  'Napoli', 'Torino',
  'Man City', 'Manchester City', 'Fulham',
  'Kocaelispor', 'Fenerbahce',
  'Newcastle', 'Arsenal',
  'NEC Nijmegen', 'PSV',
  'Eintracht Frankfurt', 'Hoffenheim',
  'Feyenoord', 'Excelsior',
  'Barcelona', 'Villarreal'
].map(s => s.toLowerCase());

// Candidate pool of 100% uncorrelated fixtures (zero overlap with D8WJHX)
const UNCORRELATED_CANDIDATES = [
  { search: 'Bayer Leverkusen', home: 'Bayer Leverkusen', away: 'Paderborn', idx: 0, sel: 'Home', ko: '2026-11-21 14:30', creator: 'manstopp3r (807N0V)' },
  { search: 'Borussia Dortmund', home: 'gladbach', away: 'Borussia Dortmund', idx: 2, sel: 'Away', ko: '2026-11-21 14:30', creator: '599225329 (D30CM5)' },
  { search: 'Freiburg', home: 'Elversberg', away: 'Freiburg', idx: 2, sel: 'Away', ko: '2026-11-21 14:30', creator: '599225329 (D30CM5)' },
  { search: 'Monaco', home: 'Monaco', away: 'Auxerre', idx: 0, sel: 'Home', ko: '2026-11-21 19:45', creator: 'yeboahisaaceric (1.56x)' },
  { search: 'Zenit', home: 'Rubin Kazan', away: 'Zenit', idx: 2, sel: 'Away', ko: '2026-11-21 14:30', creator: '1ba2 (1.39x)' },
  { search: 'WSG Tirol', home: 'WSG Tirol', away: 'Austria Lustenau', idx: 0, sel: 'Home', ko: '2026-11-21 16:00', creator: '1ba2 (1.39x)' },
  { search: 'Wolves', home: 'Wolves', away: 'Charlton', idx: 0, sel: 'Home', ko: '2026-11-21 15:00', creator: '0592138961 (DASQJ1)' },
  { search: 'Middlesbrough', home: 'Middlesbrough', away: 'Bristol City', idx: 0, sel: 'Home', ko: '2026-11-21 15:00', creator: '0592138961 (DASQJ1)' },
  { search: 'Crystal Palace', home: 'Coventry', away: 'Crystal Palace', idx: 2, sel: 'Away', ko: '2026-11-21 15:00', creator: '0538798784 (8ECDUC)' },
  { search: 'Bournemouth', home: 'Bournemouth', away: 'Nottingham Forest', idx: 0, sel: 'Home', ko: '2026-11-21 15:00', creator: '599225329 (D30CM5)' },
  { search: 'Alaves', home: 'Alaves', away: 'Deportivo', idx: 0, sel: 'Home', ko: '2026-11-21 13:00', creator: 'manstopp3r (807N0V)' },
  { search: 'Rayo Vallecano', home: 'Rayo Vallecano', away: 'Valencia', idx: 0, sel: 'Home', ko: '2026-11-21 15:15', creator: 'oguandele95 (DASW99)' },
  { search: 'Sevilla', home: 'Sevilla', away: 'Betis', idx: 0, sel: 'Home', ko: '2026-11-21 17:30', creator: 'oguandele95 (DASW99)' },
  { search: 'Lille', home: 'Lille', away: 'Lyon', idx: 0, sel: 'Home', ko: '2026-11-21 19:45', creator: 'oguandele95 (DASW99)' },
  { search: 'Viking FK', home: 'Tromsoe', away: 'Viking', idx: 2, sel: 'Away', ko: '2026-11-21 13:00', creator: '599225329 (D30CM5)' },
  { search: 'SK Rapid', home: 'Grazer', away: 'Rapid', idx: 2, sel: 'Away', ko: '2026-11-21 18:30', creator: 'ralph8833 (B10A53)' },
  { search: 'Salzburg', home: 'Austria Wien', away: 'Salzburg', idx: 2, sel: 'Away', ko: '2026-11-22 16:00', creator: 'ralph8833 (B10A53)' },
  { search: 'Twente', home: 'Twente', away: 'Willem II', idx: 0, sel: 'Home', ko: '2026-11-22 11:15', creator: 'lcare1 (FMCVFG)' },
  { search: 'Ajax', home: 'Ajax', away: 'ADO Den Haag', idx: 0, sel: 'Home', ko: '2026-11-22 13:30', creator: 'lcare1 (FMCVFG)' },
  { search: 'Go Ahead Eagles', home: 'Go Ahead Eagles', away: 'Fortuna Sittard', idx: 0, sel: 'Home', ko: '2026-11-22 15:45', creator: 'lcare1 (FMCVFG)' },
  { search: 'Troyes', home: 'Troyes', away: 'Le Havre', idx: 0, sel: 'Home', ko: '2026-11-20 19:45', creator: 'mercidez (EJY0ZK)' },
  { search: 'Bayern Munich', home: 'Bayern Munich', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 14:30', creator: 'ralph8833 (B10A53)' },
  { search: 'Liverpool', home: 'Liverpool', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 15:00', creator: 'tugha1 (A4A3SB)' },
  { search: 'Atletico Madrid', home: 'Atletico Madrid', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 17:30', creator: 'tugha1 (A4A3SB)' },
  { search: 'Inter', home: 'Inter', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 19:45', creator: 'mercidez (EJY0ZK)' },
  { search: 'Juventus', home: 'Juventus', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 17:00', creator: 'mercidez (EJY0ZK)' },
  { search: 'Atalanta', home: 'Atalanta', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 14:00', creator: 'tugha1 (A4A3SB)' },
  { search: 'Marseille', home: 'Marseille', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 20:00', creator: 'tugha1 (A4A3SB)' },
  { search: 'Celtic', home: 'Celtic', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 15:00', creator: '599225329 (D30CM5)' },
  { search: 'Rangers', home: 'Rangers', away: '', idx: 0, sel: 'Home', ko: '2026-11-21 15:00', creator: '599225329 (D30CM5)' }
];

async function searchAndSelectUncorrelated(page, leg, usedTeams) {
  await page.goto('https://www.sportybet.com/gh/m/search', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(1700);
  const inp = page.locator('input').first();
  await inp.fill(leg.search);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);

  const r = await page.evaluate(({ home, away, idx, blacklist, used }) => {
    const rows = Array.from(document.querySelectorAll('.m-table-row.m-sports-table, .m-event-sport.m-sports-row'));
    for (const x of rows) {
      const t = x.innerText || '';
      const tLow = t.toLowerCase();
      const n = x.querySelectorAll('.m-outcome').length;
      if (t.includes('SRL') || t.includes('Simulated') || n < 3 || n > 6) continue;
      if (home && !tLow.includes(home.toLowerCase())) continue;
      if (away && !tLow.includes(away.toLowerCase())) continue;

      // Enforce 100% Zero Correlation against D8WJHX and already picked teams
      if (blacklist.some(b => tLow.includes(b))) continue;
      if (used.some(u => tLow.includes(u))) continue;

      const outcomes = Array.from(x.querySelectorAll('.m-outcome'));
      // Pick the requested index, or if away='', pick the favorite between Home (0) and Away (2)
      let targetIdx = idx;
      let o0 = parseFloat((outcomes[0]?.innerText || '').trim());
      let o2 = parseFloat((outcomes[2]?.innerText || '').trim());
      if (!away) {
        if (!isNaN(o0) && o0 >= 1.15 && o0 <= 2.25) targetIdx = 0;
        else if (!isNaN(o2) && o2 >= 1.15 && o2 <= 2.25) targetIdx = 2;
      }
      const target = outcomes[targetIdx];
      if (!target) continue;
      const odds = parseFloat((target.innerText || '').trim());
      if (isNaN(odds) || odds < 1.14 || odds > 2.65) continue;

      // Extract clean match title from row lines
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      target.scrollIntoView({ block: 'center' });
      target.click();
      return {
        ok: true,
        odds,
        pickedIdx: targetIdx,
        pickedSel: targetIdx === 0 ? 'Home' : 'Away',
        rawLines: lines.slice(0, 8)
      };
    }
    return { ok: false };
  }, { home: leg.home, away: leg.away, idx: leg.idx, blacklist: D8WJHX_TEAMS, used: Array.from(usedTeams) });

  if (r.ok) await page.waitForTimeout(850);
  return r;
}

(async () => {
  const { browser, context, page } = await S.launchBrowser();
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2500);
  const sess = await S.readSession(page);
  if (!sess.isLogged) {
    console.log('[ABORT] Invalid session — running active_login_sentinel.js');
    await browser.close();
    process.exit(2);
  }
  console.log(`[Wallet] Starting Balance: GHS ${sess.balance.toFixed(2)}`);

  await S.clearBetslip(page);
  const picked = [];
  const usedTeams = new Set();

  for (const leg of UNCORRELATED_CANDIDATES) {
    if (picked.length >= 21) break;
    const r = await searchAndSelectUncorrelated(page, leg, usedTeams);
    if (r.ok) {
      // Parse match name from rawLines
      const teamLines = r.rawLines.filter(l => !/^[0-9]/.test(l) && !/^(ID|Sat|Sun|Fri|Mon|Tue|Wed|Thu|1X2|Over|Under|\+)/i.test(l) && l.length > 2);
      const matchName = (leg.home && leg.away)
        ? `${leg.home} vs ${leg.away}`
        : (teamLines.length >= 2 ? `${teamLines[0]} vs ${teamLines[1]}` : `${leg.search} Match`);
      for (const part of matchName.split(' vs ')) {
        const clean = part.trim().toLowerCase();
        if (clean.length >= 4) usedTeams.add(clean);
      }
      picked.push({
        ...leg,
        matchName,
        selection: r.pickedSel,
        live_odds: r.odds
      });
      const runningOdds = picked.reduce((a, x) => a * x.live_odds, 1);
      console.log(`  [${picked.length}] ${matchName} (${r.pickedSel} @ ${r.odds}) -> Running Base Odds: ${runningOdds.toFixed(2)}x`);
    } else {
      console.log(`  [SKIP] ${leg.search} (not found or out of odds band)`);
    }
  }

  const count = await S.getSlipCount(page);
  const rawOdds = picked.reduce((a, x) => a * x.live_odds, 1);
  console.log(`[MonsterV2] Selected ${count} uncorrelated legs | Base Odds: ${rawOdds.toFixed(2)}x`);

  if (count < 14) {
    console.log('[ABORT] Fewer than 14 legs selected — clearing betslip.');
    await S.clearBetslip(page);
    await browser.close();
    process.exit(1);
  }

  const stakeStr = '2';
  const res = await S.placeMulti(page, stakeStr, 'codehub_monster_v2_receipt.png');
  console.log('[RECEIPT] Monster V2:', JSON.stringify(res));

  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);
  const after = await S.readSession(page);
  await S.persistState(context);
  await browser.close();

  if (res.success && res.code) {
    spawnSync('python3', ['-c', `
import sqlite3, json
from datetime import datetime
now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
bullet_id = 'CH_MONSTER_20261117_V2'
code = ${JSON.stringify(res.code)}
c.execute("""INSERT OR REPLACE INTO syndicate_codehub_bullets
    (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)""",
    (bullet_id, 'UNCORRELATED_ALPHA_V2', ${parseFloat(res.stake || stakeStr)}, ${rawOdds.toFixed(2)}, ${parseFloat(res.potentialWin || 0)}, ${count}, 'IN_PROGRESS', code, now))

picked = json.loads(${JSON.stringify(JSON.stringify(picked))})
for p in picked:
    creator_raw = p.get('creator', '599225329 (D30CM5)')
    c_name = creator_raw.split(' (')[0].strip()
    s_code = creator_raw.split('(')[1].replace(')', '').strip() if '(' in creator_raw else 'CODEHUB'
    lid = f"{code}_{c_name}_{p['matchName'].replace(' ', '')}"
    c.execute("""INSERT OR REPLACE INTO syndicate_creator_anchor_ledger
        (ledger_id, bullet_id, booking_code, creator_name, source_code, match_name, selection, kickoff_gmt, status, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (lid, bullet_id, code, c_name, s_code, p['matchName'], p['selection'], p['ko'], 'IN_PROGRESS', now))

if ${after.balance !== null ? after.balance : 'None'} is not None:
    c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${after.balance || 0}, now))
c.commit(); c.close()
print('[MonsterV2] Saved to SQLite ledger:', code)
`], { stdio: 'inherit' });
    spawnSync('python3', ['syndicate/creator_trust_engine.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
    spawnSync('python3', ['syndicate/render_syndicate_terminal.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  }
  console.log('[MonsterV2] Complete:', JSON.stringify({ before: sess.balance, after: after.balance, code: res.code, stake: res.stake, potentialWin: res.potentialWin, legs: count, baseOdds: +rawOdds.toFixed(2) }));
})();
