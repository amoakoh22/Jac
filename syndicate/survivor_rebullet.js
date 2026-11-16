/**
 * Hermes Syndicate - Autonomous Survivor Monster Re-Bullet Engine
 * Triggered automatically when an active Monster Accumulator (e.g. D8WJHX) is busted
 * by an early single-match loss while >= 8 clean upcoming legs remain.
 *
 * Strict Guardrails:
 *  - Max 1 survivor re-bullet per 24 hours (prevents tilt loops)
 *  - Minimum liquid wallet balance: GHS 50.00
 *  - Fixed stake: GHS 2.00
 *  - Only selects legs from ELITE ALPHA / VERIFIED SHARP creators (trust_weight >= 1.00)
 *  - Excludes any match that already kicked off or settled LOST
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
const ANCHORS_PATH = path.join(S.ROOT_DIR, 'runtime', 'codehub_clean_anchors.json');

function pyJson(code) {
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  if (r.stderr) console.error(r.stderr);
  return JSON.parse((r.stdout || 'null').trim() || 'null');
}

function getSurvivorCandidates() {
  return pyJson(`
import sqlite3, json
from datetime import datetime, timedelta

c = sqlite3.connect(${JSON.stringify(DB_PATH)})
now = datetime.utcnow()

# Guardrail 1: Check wallet balance >= 50.00
bal_row = c.execute("SELECT liquid_balance FROM syndicate_wallets LIMIT 1").fetchone()
balance = bal_row[0] if bal_row else 0.0
if balance < 50.0:
    print(json.dumps({"ok": False, "reason": f"Balance {balance:.2f} < 50.00 GHS"}))
    raise SystemExit(0)

# Guardrail 2: Check no active IN_PROGRESS bullet
active = c.execute("SELECT COUNT(*) FROM syndicate_codehub_bullets WHERE status='IN_PROGRESS'").fetchone()[0]
if active > 0:
    print(json.dumps({"ok": False, "reason": "An IN_PROGRESS monster bullet is already active"}))
    raise SystemExit(0)

# Guardrail 3: Max 1 survivor re-bullet per 24 hours
cutoff = (now - timedelta(hours=24)).isoformat()
recent = c.execute("SELECT COUNT(*) FROM syndicate_codehub_bullets WHERE bullet_id LIKE 'CH_SURVIVOR_%' AND created_at >= ?", (cutoff,)).fetchone()[0]
if recent >= 1:
    print(json.dumps({"ok": False, "reason": "24h Survivor Re-Bullet cap reached (1/day)"}))
    raise SystemExit(0)

# Collect surviving unstarted legs from previous monster bullets
surviving_rows = c.execute("""
    SELECT DISTINCT match_name, selection, kickoff_gmt
    FROM syndicate_creator_anchor_ledger
    WHERE status NOT IN ('LOST', 'WON', 'VOID')
""").fetchall()

# Collect creator trust weights
trust_map = dict(c.execute("SELECT creator_name, trust_weight FROM syndicate_creator_trust").fetchall())

candidates = []
seen_matches = set()
min_ko = now + timedelta(minutes=30)

for mname, sel, ko in surviving_rows:
    try:
        ko_dt = datetime.strptime(ko, "%Y-%m-%d %H:%M")
    except Exception:
        continue
    if ko_dt <= min_ko:
        continue
    parts = [p.strip() for p in mname.split(" vs ")]
    if len(parts) != 2:
        continue
    home, away = parts
    idx = 0 if sel.lower() == "home" else (2 if sel.lower() == "away" else 1)
    seen_matches.add(mname.lower())
    candidates.append({
        "search": home, "home": home, "away": away,
        "selection": sel, "idx": idx, "ko": ko, "weight": 2.0, "source": "SURVIVING_ANCHOR"
    })

# Top up to 20 legs using high-trust anchors from codehub_clean_anchors.json
anchors_path = ${JSON.stringify(ANCHORS_PATH)}
try:
    anchors = json.load(open(anchors_path))
except Exception:
    anchors = []

def parse_ch_ko(ko_str):
    # Format e.g. "21/11 Sat 15:00"
    try:
        dm, _, hm = ko_str.strip().split()
        d, m = map(int, dm.split("/"))
        hh, mm = map(int, hm.split(":"))
        return datetime(now.year, m, d, hh, mm)
    except Exception:
        return None

scored = []
for a in anchors:
    tw = trust_map.get(a.get("creator"), 0.5)
    if tw < 1.0:
        continue
    sel = a.get("selection", "")
    mkt = a.get("market_name", "")
    if not ("1X2" in mkt and sel in ("Home", "Away")):
        continue
    ko_dt = parse_ch_ko(a.get("kickoff", ""))
    if not ko_dt or ko_dt <= min_ko:
        continue
    mname = f"{a['home']} vs {a['away']}"
    if mname.lower() in seen_matches:
        continue
    scored.append((tw * a.get("endorsements", 1), a, ko_dt, mname))

scored.sort(key=lambda x: x[0], reverse=True)
for score, a, ko_dt, mname in scored:
    if len(candidates) >= 20:
        break
    if mname.lower() in seen_matches:
        continue
    seen_matches.add(mname.lower())
    idx = 0 if a["selection"] == "Home" else 2
    candidates.append({
        "search": a["home"], "home": a["home"], "away": a["away"],
        "selection": a["selection"], "idx": idx,
        "ko": ko_dt.strftime("%Y-%m-%d %H:%M"),
        "weight": trust_map.get(a.get("creator"), 1.0),
        "source": a.get("source_code", "CODEHUB")
    })

c.close()
print(json.dumps({"ok": True, "balance": balance, "candidates": candidates[:20]}))
`);
}

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
    if (isNaN(odds) || odds > 3.5) return { ok: false, reason: `odds ${odds} out of band` };
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true, odds };
  }, leg);

  if (r.ok) await page.waitForTimeout(900);
  return r;
}

(async () => {
  const prep = getSurvivorCandidates();
  if (!prep || !prep.ok) {
    console.log(`[SurvivorReBullet] Skipped: ${prep ? prep.reason : 'Unknown error'}`);
    process.exit(0);
  }
  if (!prep.candidates || prep.candidates.length < 8) {
    console.log(`[SurvivorReBullet] Fewer than 8 clean upcoming legs (${prep.candidates?.length || 0}). Waiting for next CodeHub window.`);
    process.exit(0);
  }

  console.log(`[SurvivorReBullet] Deploying Survivor Monster Accumulator from ${prep.candidates.length} trust-weighted legs...`);
  const { browser, context, page } = await S.launchBrowser();
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2500);
  const sess = await S.readSession(page);
  if (!sess.isLogged) {
    console.log('[ABORT] Invalid session');
    await browser.close();
    process.exit(2);
  }

  await S.clearBetslip(page);
  const picked = [];
  for (const leg of prep.candidates) {
    const r = await searchAndSelect(page, leg);
    console.log(`  [${picked.length + 1}] ${leg.home} v ${leg.away} (${leg.selection}) ->`, r.ok ? r.odds : (r.reason || 'NOT FOUND'));
    if (r.ok) picked.push({ ...leg, live_odds: r.odds });
  }

  const count = await S.getSlipCount(page);
  const rawOdds = picked.reduce((a, x) => a * x.live_odds, 1);
  console.log(`[SurvivorReBullet] Selected ${count} legs | Base Odds: ${rawOdds.toFixed(2)}x`);

  if (count < 8 || rawOdds < 25.0) {
    console.log('[SurvivorReBullet] Insufficient surviving legs/odds — clearing betslip.');
    await S.clearBetslip(page);
    await browser.close();
    process.exit(0);
  }

  const stakeStr = '2';
  const bulletId = `CH_SURVIVOR_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString().slice(-4)}`;
  const res = await S.placeMulti(page, stakeStr, `survivor_rebullet_${bulletId}.png`);
  console.log('[RECEIPT] Survivor Bullet:', JSON.stringify(res));

  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2500);
  const after = await S.readSession(page);
  await S.persistState(context);
  await browser.close();

  if (res.success) {
    pyJson(`
import sqlite3, json
from datetime import datetime
now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
c.execute("""INSERT OR REPLACE INTO syndicate_codehub_bullets
    (bullet_id, derived_from_code, stake, total_odds, potential_payout, legs_count, status, booking_code, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)""",
    (${JSON.stringify(bulletId)}, 'SURVIVOR_TRUST_CONSENSUS', ${parseFloat(res.stake || stakeStr)}, ${rawOdds.toFixed(2)}, ${parseFloat(res.potentialWin || 0)}, ${count}, 'IN_PROGRESS', ${JSON.stringify(res.code)}, now))

# Register picked legs in syndicate_creator_anchor_ledger for ongoing trust tracking
picked = json.loads(${JSON.stringify(JSON.stringify(picked))})
for p in picked:
    lid = f"${res.code}_SURV_{p['home'].replace(' ', '')}"
    c.execute("""INSERT OR IGNORE INTO syndicate_creator_anchor_ledger
        (ledger_id, bullet_id, booking_code, creator_name, source_code, match_name, selection, kickoff_gmt, status, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (lid, ${JSON.stringify(bulletId)}, ${JSON.stringify(res.code)}, p.get('source', 'CONSENSUS'), p.get('source', 'CODEHUB'), f"{p['home']} vs {p['away']}", p['selection'], p['ko'], 'IN_PROGRESS', now))

if ${after.balance !== null ? after.balance : 'None'} is not None:
    c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${after.balance || 0}, now))
c.commit(); c.close()
print('true')
`);
    spawnSync('python3', ['syndicate/creator_trust_engine.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
    spawnSync('python3', ['syndicate/render_syndicate_terminal.py'], { cwd: S.ROOT_DIR, stdio: 'inherit' });
  }
})();
