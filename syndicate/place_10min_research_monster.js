const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

(async () => {
  const payload = JSON.parse(
    fs.readFileSync(path.join(S.ROOT_DIR, 'runtime/ten_min_research_monster.json'), 'utf8')
  );
  const wapItems = payload.legs.map(x => x.wap_item);
  const { browser, context, page } = await S.launchBrowser();
  try {
    await page.goto('https://www.sportybet.com/gh/m/sport/football/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2500);

    await page.evaluate((items) => {
      localStorage.setItem('wapBetslips', JSON.stringify(items));
    }, wapItems);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4500);

    const slipCount = await S.getSlipCount(page);
    console.log('Hydrated 1-10m Research Monster legs:', slipCount);

    await page.evaluate(() => {
      const icon = document.querySelector('.betslip-theme-icon') || document.querySelector('.m-betslip-Balls');
      if (icon) icon.click();
    });
    await page.waitForTimeout(2500);

    await page.evaluate(() => {
      const el = document.querySelector('[data-op="betslip-stake-amount"]');
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.click();
      }
    });
    await page.waitForTimeout(800);
    await S.typeStakeOnKeyboard(page, '2');
    await page.waitForTimeout(1000);

    for (let attempt = 0; attempt < 3; attempt++) {
      const btnText = await page.evaluate(() => {
        const btn = document.querySelector('[data-op="betslip-placebet"]');
        if (btn) {
          const t = (btn.innerText || '').trim();
          btn.click();
          return t;
        }
        return '';
      });
      console.log(`Clicked placebet button (attempt ${attempt + 1}): "${btnText}"`);
      await page.waitForTimeout(1800);
      const hasConfirm = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, div, span, a')).some(
          e => (e.innerText || '').trim().toLowerCase() === 'confirm'
        )
      );
      if (hasConfirm) break;
    }

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div, span, a')).filter(
        e => (e.innerText || '').trim().toLowerCase() === 'confirm'
      );
      if (btns.length) btns[btns.length - 1].click();
    });

    await page.waitForTimeout(5500);
    const shotPath = path.join(S.SCREENSHOT_DIR, 'codehub_10min_research_monster_receipt.png');
    await page.screenshot({ path: shotPath });

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
        potentialWin: potWin ? potWin[1].replace(/,/g, '') : null,
        snippet: text.slice(0, 400)
      };
    });

    console.log('Placement result:', JSON.stringify(res, null, 2));
    fs.writeFileSync(
      path.join(S.ROOT_DIR, 'runtime/ten_min_research_monster_result.json'),
      JSON.stringify({ ...res, slipCount, screenshotPath: shotPath }, null, 2)
    );
    await S.persistState(context);
  } finally {
    await browser.close();
  }
})();
