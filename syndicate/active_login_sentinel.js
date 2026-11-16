/**
 * Hermes Syndicate - Login Sentinel (Playbook-compliant)
 *
 * Follows SPORTYBET_STABILITY_PLAYBOOK.md / bin/github_cron_staker.js:
 *  - chromium.launch + newContext({ ignoreHTTPSErrors: true, storageState })
 *  - If runtime/sportybet_authenticated_state.json holds a valid session -> no login at all
 *  - Otherwise one-time login; the human types any challenge answer / 2FA code into
 *    runtime/syndicate_answer.txt (the agent never solves challenges itself)
 *  - On success: persist storage state, sync balance to syndicate ledger. NO fabricated booking codes.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sportybet_session');

const CREDS_FILE = path.join(S.ROOT_DIR, 'runtime', 'jack_vault.json');
const ANSWER_FILE = path.join(S.ROOT_DIR, 'runtime', 'syndicate_answer.txt');
const STATUS_PNG = path.join(S.SCREENSHOT_DIR, 'active_login_status.png');
const WAIT_SECONDS = parseInt(process.env.SENTINEL_WAIT || '1800', 10);

function syncBalance(balance) {
  const db = path.join(S.ROOT_DIR, 'data', 'syndicate_ledger.sqlite');
  spawnSync('python3', ['-c', `
import sqlite3; from datetime import datetime
c = sqlite3.connect(${JSON.stringify(db)})
c.execute("UPDATE syndicate_wallets SET liquid_balance=?, last_synced=? WHERE account_label='Telecel_SportyBet_Ghana'", (${balance}, datetime.utcnow().isoformat()))
c.commit(); c.close()`]);
  spawnSync('python3', ['render_syndicate_terminal.py'], { cwd: __dirname });
}

async function submitCredentials(page, creds) {
  await page.evaluate(() => document.querySelector('.m-btn-login, [data-op="nav-login"]')?.click());
  await page.waitForTimeout(2000);
  const phone = page.locator('input[type="tel"]').first();
  if (!(await phone.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await phone.fill(creds.phone.replace(/^(\+233|0)/, ''));
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, div, span, .m-btn'))
      .find(x => (x.innerText || '').trim().toLowerCase() === 'login' && x.offsetHeight > 30);
    (b || document.querySelector('.m-login-btn, button[type="submit"]'))?.click();
  });
  await page.waitForTimeout(3500);
  return true;
}

async function snapshot(page, tag) {
  await page.screenshot({ path: STATUS_PNG });
  console.log(`[${tag}] Snapshot: ${STATUS_PNG}`);
}

async function finish(context, browser, page) {
  const s = await S.readSession(page);
  await S.persistState(context);
  syncBalance(s.balance);
  console.log(`\n[SUCCESS] AUTHENTICATED. Liquid Balance: GHS ${s.balance.toFixed(2)}`);
  console.log(`[STATE] Persisted ${S.STATE_PATH}`);
  await browser.close();
  process.exit(0);
}

(async () => {
  if (fs.existsSync(ANSWER_FILE)) fs.unlinkSync(ANSWER_FILE);
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const { browser, context, page } = await S.launchBrowser();

  await page.goto('https://www.sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(3000);

  let s = await S.readSession(page);
  if (s.isLogged) return finish(context, browser, page);

  console.log('[Sentinel] No valid stored session. Performing one-time login...');
  await submitCredentials(page, creds);
  s = await S.readSession(page);
  if (s.isLogged) return finish(context, browser, page);

  await snapshot(page, s.twoFactor ? '2FA_ACTIVE' : s.captcha ? 'CHALLENGE_ACTIVE' : 'WAITING');

  for (let i = 0; i < WAIT_SECONDS / 2; i++) {
    await page.waitForTimeout(2000);
    if (!fs.existsSync(ANSWER_FILE)) continue;

    const input = fs.readFileSync(ANSWER_FILE, 'utf8').trim();
    fs.unlinkSync(ANSWER_FILE);
    s = await S.readSession(page);
    console.log(`[Sentinel] Human input received (${input.length} chars).`);

    if (s.twoFactor) {
      try {
        fs.writeFileSync(path.join(S.SCREENSHOT_DIR, '2fa_dom.html'), await page.content());
        const vis = page.locator('input:not([type="checkbox"]):not([type="hidden"]):not([type="radio"]):visible');
        const n = await vis.count();
        console.log(`[2FA] Visible inputs: ${n}`);
        if (n >= 6) {
          await vis.first().click();
          await page.keyboard.type(input, { delay: 180 });
        } else if (n >= 1) {
          await vis.first().click();
          await page.keyboard.type(input, { delay: 180 });
        } else {
          // Custom div boxes backed by a hidden input: click the first box, then type
          const clicked = await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('*')).find(e => (e.innerText || '').trim().startsWith('Verify 2 Factor'));
            const boxes = Array.from(document.querySelectorAll('div, span, li')).filter(e => {
              const r = e.getBoundingClientRect();
              return r.width > 30 && r.width < 70 && r.height > 35 && r.height < 80 && e.children.length === 0;
            });
            if (boxes[0]) { boxes[0].click(); return true; }
            return !!h;
          });
          console.log(`[2FA] Fallback box click: ${clicked}`);
          await page.keyboard.type(input, { delay: 180 });
        }
        await page.waitForTimeout(1200);
        await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button, div, span, .m-btn'))
            .find(x => ['confirm', 'submit', 'verify'].includes((x.innerText || '').trim().toLowerCase()));
          b?.click();
        });
      } catch (e) {
        console.log('[2FA] Entry error (session held):', e.message.split('\n')[0]);
      }
    } else {
      await page.locator('input[placeholder*="answer" i]').last().fill(input, { timeout: 5000 })
        .catch(e => console.log('[CHALLENGE] Fill error (session held):', e.message.split('\n')[0]));
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button, div, span, .m-btn'))
          .find(x => (x.innerText || '').trim().toLowerCase() === 'submit');
        b?.click();
      });
    }

    for (let j = 0; j < 10; j++) {
      await page.waitForTimeout(1500);
      s = await S.readSession(page);
      if (s.isLogged) return finish(context, browser, page);
      if (s.captchaRejected || s.twoFactor) break;
    }

    if (s.captchaRejected) {
      console.log('[CHALLENGE_REJECTED] Dismissing and requesting a fresh challenge...');
      await page.evaluate(() => {
        const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(e => (e.innerText || '').trim().toLowerCase() === 'ok');
        ok?.click();
      });
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button, div, span, .m-btn'))
          .find(x => (x.innerText || '').trim().toLowerCase() === 'login' && x.offsetHeight > 30);
        b?.click();
      });
      await page.waitForTimeout(3000);
    }
    s = await S.readSession(page);
    await snapshot(page, s.twoFactor ? '2FA_ACTIVE' : s.captcha ? 'CHALLENGE_ACTIVE' : 'WAITING');
  }

  console.log('[Sentinel] Window timeout.');
  await browser.close();
})();
