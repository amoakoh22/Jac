const fs = require('fs');
const path = require('path');
const S = require('./sportybet_session');

async function placeCustomMonster(page, name, legsPayload, stakeStr, screenshotName) {
  console.log(`\n=== Loading ${name} (${legsPayload.length} legs) ===`);
  const wapItems = legsPayload.map(x => x.wap_item);

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
  console.log(`[${name}] Hydrated betslip count: ${slipCount}`);

  // Open betslip drawer
  await page.evaluate(() => {
    const icon = document.querySelector('.betslip-theme-icon') || document.querySelector('.m-betslip-Balls');
    if (icon) icon.click();
  });
  await page.waitForTimeout(2500);

  // If any unavailable/suspended selections exist, remove them or accept changes
  await page.evaluate(() => {
    const btn = document.querySelector('[data-op="betslip-placebet"]');
    if (btn && /accept|change/i.test(btn.innerText || '')) {
      btn.click();
    }
  });
  await page.waitForTimeout(1200);

  // Focus stake input and type stakeStr
  await page.evaluate(() => {
    const el = document.querySelector('[data-op="betslip-stake-amount"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.click();
    }
  });
  await page.waitForTimeout(800);
  await S.typeStakeOnKeyboard(page, stakeStr);
  await page.waitForTimeout(1000);

  // Click Place Bet (and click again if first click was Accept Changes)
  for (let attempt = 0; attempt < 2; attempt++) {
    const btnText = await page.evaluate(() => {
      const btn = document.querySelector('[data-op="betslip-placebet"]');
      if (btn) {
        const t = (btn.innerText || '').trim();
        btn.click();
        return t;
      }
      return '';
    });
    console.log(`[${name}] Clicked placebet button (attempt ${attempt + 1}): "${btnText}"`);
    await page.waitForTimeout(1800);
    const hasConfirm = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, div, span, a')).some(
        e => (e.innerText || '').trim().toLowerCase() === 'confirm'
      );
    });
    if (hasConfirm) break;
  }

  // Click Confirm
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, div, span, a')).filter(
      e => (e.innerText || '').trim().toLowerCase() === 'confirm'
    );
    if (btns.length) btns[btns.length - 1].click();
  });

  await page.waitForTimeout(5500);
  const shotPath = path.join(S.SCREENSHOT_DIR, screenshotName);
  await page.screenshot({ path: shotPath });

  const res = await page.evaluate(() => {
    const full = document.body ? document.body.innerText : '';
    const idx = full.indexOf('Bet Successful');
    const text = idx >= 0 ? full.slice(idx) : full;
    const code = text.match(/\b([A-Z0-9]{6})\b/) || full.match(/([A-Z0-9]{6})\s*Custom Code/i);
    const stake = text.match(/Total Stake[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    const potWin = text.match(/Potential Win[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    const bonus = text.match(/(?:Max\s+)?Bonus[\s\S]*?([0-9,]+\.[0-9]{2})/i);
    return {
      success: full.includes('Bet Successful') || full.includes('Successful') || full.includes('Bet Placed'),
      code: code ? code[1] : null,
      stake: stake ? stake[1].replace(/,/g, '') : null,
      potentialWin: potWin ? potWin[1].replace(/,/g, '') : null,
      bonus: bonus ? bonus[1].replace(/,/g, '') : null,
      snippet: text.slice(0, 500)
    };
  });

  console.log(`[${name}] Result:`, JSON.stringify(res, null, 2));

  await page.evaluate(() => {
    const ok = Array.from(document.querySelectorAll('button, div, span, a')).find(
      e => (e.innerText || '').trim().toLowerCase() === 'ok'
    );
    if (ok) ok.click();
  });
  await page.waitForTimeout(1500);
  return { ...res, slipCount, screenshotPath: shotPath };
}

(async () => {
  const payloads = JSON.parse(
    fs.readFileSync(path.join(S.ROOT_DIR, 'runtime/monster_v3_v4_payloads.json'), 'utf8')
  );
  const { browser, context, page } = await S.launchBrowser();
  try {
    const r3 = await placeCustomMonster(
      page,
      'MONSTER #3 (45-Fold Goals & Half-Time Cushion Fortress)',
      payloads.monster3,
      '2',
      'codehub_monster_v3_receipt.png'
    );

    const r4 = await placeCustomMonster(
      page,
      'MONSTER #4 (44-Fold Double-Chance, 2UP & Handicap Shield)',
      payloads.monster4,
      '2',
      'codehub_monster_v4_receipt.png'
    );

    const sess = await S.readSession(page);
    await S.persistState(context);

    const summary = { monster3: r3, monster4: r4, sessionAfter: sess };
    fs.writeFileSync(
      path.join(S.ROOT_DIR, 'runtime/monster_v3_v4_results.json'),
      JSON.stringify(summary, null, 2)
    );
    console.log('\n=== FINAL SUMMARY ===\n', JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
})();
