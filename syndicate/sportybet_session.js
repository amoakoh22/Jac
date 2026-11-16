/**
 * Hermes Syndicate - SportyBet Session & Betslip Helpers
 * Ported from the proven Bermesi harness (bin/execute_monday_slate.js, bin/github_cron_staker.js)
 * per SPORTYBET_STABILITY_PLAYBOOK.md:
 *  1. chromium.launch + newContext({ ignoreHTTPSErrors: true }) and --ignore-certificate-errors
 *  2. Reuse + persist runtime/sportybet_authenticated_state.json (trusted-device session)
 *  3. Rows: .m-table-row.m-sports-table / .m-event-sport.m-sports-row, excluding SRL
 *  4. Stake entry ONLY via .m-keyboard-key[data-op="betslip-keyboard-*"] keypad (never .fill())
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT_DIR, 'runtime', 'jack_authenticated_state.json');
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'runtime', 'logs', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function browserExecutable() {
  for (const p of ['/usr/bin/chromium', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return undefined;
}

async function launchBrowser() {
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors']
  };
  const exe = browserExecutable();
  if (exe) launchOpts.executablePath = exe;
  if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY };

  const browser = await chromium.launch(launchOpts);
  const contextOpts = { viewport: { width: 420, height: 850 }, ignoreHTTPSErrors: true };
  if (fs.existsSync(STATE_PATH)) contextOpts.storageState = STATE_PATH;
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { browser, context, page };
}

async function persistState(context) {
  const state = await context.storageState();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function readSession(page) {
  return page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    const m = text.match(/GHS\s*([0-9,]+\.[0-9]{2})/i);
    const loginVisible = !!document.querySelector('.m-btn-login, [data-op="nav-login"]');
    return {
      isLogged: !!m && !loginVisible,
      balance: m ? parseFloat(m[1].replace(/,/g, '')) : null,
      captcha: text.includes('Solve Question') || text.includes('missing number'),
      captchaRejected: text.includes('Captcha is incorrect'),
      twoFactor: text.includes('2 Factor Auth') || text.includes('Verification Code')
    };
  }).catch(() => ({ isLogged: false, balance: null }));
}

async function getSlipCount(page) {
  return page.evaluate(() => {
    if (document.querySelector('.betslip-theme-icon__inner--empty')) return 0;
    const mc = document.querySelector('[data-op="betslip-multi-count"]');
    if (mc) return parseInt(mc.innerText.trim(), 10) || 0;
    const lines = (document.querySelector('.betslip-theme-icon')?.innerText || '').trim().split(/\s+/);
    const last = lines[lines.length - 1];
    return parseInt(last, 10) || 0;
  }).catch(() => 0);
}

async function clearBetslip(page) {
  await page.evaluate(() => document.querySelector('[data-op="betslip-close"]')?.click());
  await page.waitForTimeout(400);
  const count = await getSlipCount(page);
  if (count > 0) {
    await page.evaluate(() => document.querySelector('.betslip-theme-icon')?.click());
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const rm = document.querySelector('[data-op="betslip-remove-all"], .remove-all');
      if (rm) rm.click();
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, .es-dialog-btn, .m-btn'))
        .filter(e => e.offsetParent !== null && ['ok', 'confirm', 'yes'].includes((e.innerText || '').trim().toLowerCase()));
      if (btns.length > 0) btns[btns.length - 1].click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.querySelector('[data-op="betslip-close"]')?.click());
    await page.waitForTimeout(400);
  }
}

async function selectTeamOutcome(page, teamKeyword, outcomeIndex) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await page.evaluate(({ team, idx }) => {
      const rows = Array.from(document.querySelectorAll('.m-table-row.m-sports-table, .m-event-sport.m-sports-row'));
      const row = rows.find(x => {
        const t = x.innerText || '';
        const n = x.querySelectorAll('.m-outcome').length;
        return t.includes(team) && !t.includes('SRL') && n >= 2 && n <= 6;
      });
      if (!row) return { ok: false, reason: 'Row not found for ' + team };
      const target = Array.from(row.querySelectorAll('.m-outcome'))[idx];
      if (!target) return { ok: false, reason: `Outcome idx ${idx} missing` };
      target.scrollIntoView({ block: 'center' });
      target.click();
      return { ok: true, odds: target.innerText.trim(), matchText: row.innerText.replace(/\n+/g, ' | ').slice(0, 90) };
    }, { team: teamKeyword, idx: outcomeIndex });
    if (r.ok) { await page.waitForTimeout(1500); return r; }
    await page.evaluate(() => window.scrollBy(0, 700));
    await page.waitForTimeout(1000);
  }
  return { ok: false, reason: 'Row not found for ' + teamKeyword };
}

async function typeStakeOnKeyboard(page, stakeStr) {
  await page.evaluate(() => document.querySelector('.m-keyboard-key[data-key="clear"]')?.click());
  await page.waitForTimeout(300);
  for (const ch of stakeStr.split('')) {
    await page.evaluate((k) => {
      const keyEl = document.querySelector(`.m-keyboard-key[data-op="betslip-keyboard-${k}"]`)
        || document.querySelector(`.m-keyboard-key[data-key="${k}"]`);
      if (keyEl) keyEl.click();
    }, ch);
    await page.waitForTimeout(220);
  }
  await page.evaluate(() => document.querySelector('[data-key="done"]')?.click());
  await page.waitForTimeout(800);
}

async function placeMulti(page, stakeStr, screenshotName) {
  await page.evaluate(() => document.querySelector('.betslip-theme-icon')?.click());
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const el = document.querySelector('[data-op="betslip-stake-amount"]');
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
  });
  await page.waitForTimeout(800);
  await typeStakeOnKeyboard(page, stakeStr);

  await page.evaluate(() => document.querySelector('[data-op="betslip-placebet"]')?.click());
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, div, span, a')).filter(e => (e.innerText || '').trim().toLowerCase() === 'confirm');
    if (btns.length) btns[btns.length - 1].click();
  });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, screenshotName) });

  const res = await page.evaluate(() => {
    const full = document.body ? document.body.innerText : '';
    const idx = full.indexOf('Bet Successful');
    const text = idx >= 0 ? full.slice(idx) : full;
    const code = text.match(/\b([A-Z0-9]{6})\b/) || full.match(/([A-Z0-9]{6})\s*Custom Code/i);
    const stake = text.match(/Total Stake[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    const potWin = text.match(/Potential Win[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    return {
      success: full.includes('Bet Successful') || full.includes('Successful') || full.includes('Bet Placed'),
      code: code ? code[1] : null,
      stake: stake ? stake[1].replace(/,/g, '') : null,
      potentialWin: potWin ? potWin[1].replace(/,/g, '') : null
    };
  });
  await page.evaluate(() => {
    const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(e => (e.innerText || '').trim().toLowerCase() === 'ok');
    if (ok) ok.click();
  });
  await page.waitForTimeout(1500);
  return res;
}

module.exports = {
  ROOT_DIR, STATE_PATH, SCREENSHOT_DIR,
  launchBrowser, persistState, readSession,
  clearBetslip, getSlipCount, selectTeamOutcome, typeStakeOnKeyboard, placeMulti
};
