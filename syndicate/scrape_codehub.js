/**
 * Hermes Syndicate - Full-Depth CodeHub Scraper & Trap-Purge Pipeline
 * Uses syndicate/sportybet_session.js (storageState, ignoreHTTPSErrors).
 * Scrolls SportyBet Ghana CodeHub (/gh/m/code-hub/codes), extracts full slip metadata
 * and legs (home, away, kickoff, market, selection, odds), purges traps,
 * stores clean anchors in syndicate_codehub_scouts, and outputs runtime/codehub_clean_anchors.json.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const DB_PATH = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');

(async () => {
  const { browser, context, page } = await S.launchBrowser();
  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(2500);
  const sess = await S.readSession(page);
  if (!sess.isLogged) {
    console.log('[ABORT] Stored session invalid — run node syndicate/active_login_sentinel.js');
    await browser.close();
    process.exit(2);
  }

  console.log('[CodeHub] Navigating to https://www.sportybet.com/gh/m/code-hub/codes ...');
  await page.goto('https://www.sportybet.com/gh/m/code-hub/codes', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(4500);

  const slipMap = new Map();
  for (let step = 0; step < 8; step++) {
    const chunk = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      const lines = bodyText.split('\n').map(s => s.trim()).filter(Boolean);
      const items = [];
      for (let i = 0; i < lines.length; i++) {
        const fMatch = lines[i].match(/^([0-9,]+)\s+Followers$/i);
        if (!fMatch) continue;
        const creator = i > 0 ? lines[i - 1] : 'Unknown';
        const followers = parseInt(fMatch[1].replace(/,/g, ''), 10);
        let code = null, folds = 0, odds = 0;
        const legs = [];
        for (let j = i + 1; j < Math.min(lines.length, i + 650); j++) {
          if (/^[0-9,]+\s+Followers$/i.test(lines[j])) break;
          if (!code && /^[A-Z0-9]{6,8}$/.test(lines[j])) code = lines[j];
          const fm = lines[j].match(/^Folds:\s*([0-9]+)/i);
          if (fm) folds = parseInt(fm[1], 10);
          const om = lines[j].match(/^Odds:\s*([0-9.,]+)/i);
          if (om) odds = parseFloat(om[1].replace(/,/g, ''));
          if (lines[j].startsWith('@') && j > 0) {
            const legOdds = parseFloat(lines[j].slice(1));
            const sel = lines[j - 1];
            const market = lines[j + 1] === '|' ? (lines[j + 2] || '') : '';
            // Scan ahead up to 6 lines for "Home \n vs \n Away \n Kickoff"
            let home = '', away = '', kickoff = '';
            for (let k = j + 1; k < Math.min(lines.length, j + 8); k++) {
              if (lines[k] === 'vs' && k > j + 1 && k + 1 < lines.length) {
                home = lines[k - 1];
                away = lines[k + 1];
                kickoff = lines[k + 2] || '';
                break;
              }
            }
            if (home && away) {
              legs.push({ home, away, kickoff, market_name: market, selection: sel, odds: legOdds });
            }
          }
        }
        if (code) items.push({ booking_code: code, creator_name: creator, followers, folds, odds, legs });
      }
      return items;
    });
    chunk.forEach(it => {
      if (!slipMap.has(it.booking_code) || it.legs.length > slipMap.get(it.booking_code).legs.length) {
        slipMap.set(it.booking_code, it);
      }
    });
    await page.evaluate(() => {
      const mid = document.querySelector('.m-main-mid') || document.scrollingElement;
      if (mid) mid.scrollTop += 700;
      window.scrollBy(0, 700);
    });
    await page.waitForTimeout(700);
  }

  const allSlips = Array.from(slipMap.values());
  console.log(`[CodeHub] Extracted ${allSlips.length} unique human slips.`);

  // Strict Trap-Purge Filter
  const cleanAnchors = [];
  const purged = allSlips.map(item => {
    let traps = 0, clean = 0;
    for (const l of item.legs) {
      const m = l.market_name || '';
      const s = l.selection || '';
      const isTrap =
        isNaN(l.odds) || l.odds < 1.15 || l.odds > 2.40 ||
        /Handicap\s*[0-9]:[0-9]/i.test(m) ||
        /Correct Score|HT\/FT|Half Time\/Full Time|1st Half Under|Winning Margin/i.test(m) ||
        /SRL/i.test(l.home + ' ' + l.away);
      const isCleanMarket = /1X2|Double Chance|Over\/Under|GG\/NG|Draw No Bet|Winner/i.test(m);
      if (isTrap || !isCleanMarket) {
        traps++;
      } else {
        clean++;
        cleanAnchors.push({
          source_code: item.booking_code,
          creator: item.creator_name,
          followers: item.followers,
          ...l
        });
      }
    }
    return { ...item, traps, clean };
  });

  // Deduplicate clean anchors by match + market + selection, keeping highest follower endorsement
  const anchorMap = new Map();
  for (const a of cleanAnchors) {
    const key = `${a.home}|${a.away}`;
    const existing = anchorMap.get(key);
    if (!existing) {
      anchorMap.set(key, { ...a, endorsements: 1 });
    } else if (existing.selection === a.selection) {
      existing.endorsements += 1;
      existing.followers += a.followers;
    }
  }
  const uniqueAnchors = Array.from(anchorMap.values()).sort((a, b) => (b.endorsements - a.endorsements) || (b.followers - a.followers));

  fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'codehub_live_snapshot.json'), JSON.stringify(allSlips, null, 2));
  fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'codehub_clean_anchors.json'), JSON.stringify(uniqueAnchors, null, 2));

  console.log(`[CodeHub] Clean unique match anchors after trap-purge: ${uniqueAnchors.length}`);
  console.log('[CodeHub] Top 15 anchors:', JSON.stringify(uniqueAnchors.slice(0, 15).map(a => ({
    match: `${a.home} vs ${a.away}`, ko: a.kickoff, mkt: a.market_name, sel: a.selection, odds: a.odds, src: a.source_code, end: a.endorsements
  })), null, 1));

  if (purged.length > 0) {
    spawnSync('python3', ['-c', `
import sqlite3, json
from datetime import datetime
now = datetime.utcnow().isoformat()
c = sqlite3.connect(${JSON.stringify(DB_PATH)})
for p in json.loads(${JSON.stringify(JSON.stringify(purged))}):
    c.execute("""INSERT OR REPLACE INTO syndicate_codehub_scouts
        (booking_code, creator_name, followers_count, original_odds, original_legs_count, scraped_at, raw_slip_json, stripped_traps_count, retained_anchors_count, status)
        VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (p['booking_code'], p['creator_name'], p['followers'], p['odds'], p['folds'], now, json.dumps(p['legs']), p['traps'], p['clean'], 'ANALYZED'))
c.commit(); c.close()
`]);
  }

  await S.persistState(context);
  await browser.close();
  spawnSync('python3', ['creator_trust_engine.py'], { cwd: __dirname, stdio: 'inherit' });
  spawnSync('python3', ['render_syndicate_terminal.py'], { cwd: __dirname, stdio: 'inherit' });
})();
