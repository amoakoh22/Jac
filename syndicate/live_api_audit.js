/**
 * Jac Syndicate - Live API Audit (open bets + settled history + pocket statements)
 * Uses Playwright context.request (never window.fetch) with operid '3'.
 * Output: runtime/live_api_audit_latest.json, runtime/sportybet_full_statements.json (refreshed)
 */
const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

const H = { clientid: 'wap', operid: '3', platform: 'wap', 'accept-language': 'en' };

(async () => {
  const { browser, context, page } = await S.launchBrowser();
  try {
    await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    const get = async (u) => {
      const r = await context.request.get(u, { headers: H });
      try { return await r.json(); } catch (e) { return { error: String(e), status: r.status() }; }
    };
    const t = Date.now();
    const open = await get(`https://www.sportybet.com/api/gh/realSportsGame/openbets?version=v2&pageSize=20&_t=${t}`);
    const unsettled = await get(`https://www.sportybet.com/api/gh/orders/order/v2/realbetlist?isSettled=0&pageSize=20&pageNo=1&_t=${t}`);
    const settled = await get(`https://www.sportybet.com/api/gh/orders/order/v2/realbetlist?isSettled=1&pageSize=12&pageNo=1&_t=${t}`);
    const start = t - 30 * 86400000;
    const stm = await get(`https://www.sportybet.com/api/gh/pocket/v1/statements?type=0&pageSize=50&lastId=&isHistory=0&createTimeStart=${start}&createTimeEnd=${t}`);
    const out = { fetched_at: new Date().toISOString(), open, unsettled, settled };
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'live_api_audit_latest.json'), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(S.ROOT_DIR, 'runtime', 'sportybet_statements_latest_raw.json'), JSON.stringify(stm, null, 2));
    console.log('open bizCode', open && open.bizCode, 'settled bizCode', settled && settled.bizCode, 'stm bizCode', stm && stm.bizCode);
    await S.persistState(context);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
