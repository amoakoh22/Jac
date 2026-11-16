/**
 * Hermes Syndicate - Live Fixture Harvester (read-only)
 * Loads SportyBet Ghana lobby pages with the stored session and extracts
 * real rows (.m-table-row.m-sports-table / .m-event-sport.m-sports-row, SRL excluded)
 * with their visible outcome odds. Output: runtime/live_fixtures.json
 */
const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

const PAGES = (process.env.HARVEST_URLS || [
  'https://www.sportybet.com/gh/m/sport/football/today',
  'https://www.sportybet.com/gh/m/sport/basketball/sr:category:15/sr:tournament:132'
].join(',')).split(',');

(async () => {
  const { browser, context, page } = await S.launchBrowser();
  const out = [];
  for (const url of PAGES) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(4500);
    const seen = new Map();
    for (let i = 0; i < 25; i++) {
      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.m-table-row.m-sports-table, .m-event-sport.m-sports-row')).map(r => {
          const t = r.innerText || '';
          const outs = Array.from(r.querySelectorAll('.m-outcome')).map(o => o.innerText.trim());
          let league = '';
          let p = r.previousElementSibling;
          for (let k = 0; k < 40 && p; k++, p = p.previousElementSibling) {
            if (/league|title|tournament/i.test(p.className || '')) { league = (p.innerText || '').split('\n')[0]; break; }
          }
          return { text: t.replace(/\n+/g, ' | '), outcomes: outs, srl: t.includes('SRL'), league };
        }).filter(x => !x.srl && x.outcomes.length >= 2 && x.outcomes.length <= 6);
      });
      rows.forEach(r => seen.set(r.text.slice(0, 80), { url, ...r }));
      const atEnd = await page.evaluate(() => { const y = window.scrollY; window.scrollBy(0, 900); return window.scrollY === y; });
      await page.waitForTimeout(700);
      if (atEnd) break;
    }
    out.push(...seen.values());
    console.log(`[Harvest] ${url} -> ${seen.size} rows`);
  }
  await S.persistState(context);
  fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'live_fixtures.json'), JSON.stringify(out, null, 2));
  await browser.close();
})();
