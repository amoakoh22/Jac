# SportyBet Ghana Playwright Stability Playbook (Zero Login Loops, 100% First-Run Execution)

This playbook documents the exact architecture used by **Bermesi** to achieve **100% autonomous 6/6 slip placement** on SportyBet Ghana without login/2FA loops, broad DOM selector collisions, or betslip stake errors.

**Working Reference Implementation:** [`bin/execute_monday_slate.js`](bin/execute_monday_slate.js)

---

## 1. Persistent Trusted-Device Auth (Eliminates Login & 2FA Loops)
- **Proxy SSL Handling:** Always pass `ignoreHTTPSErrors: true` to `browser.newContext()` (and `--ignore-certificate-errors` to `chromium.launch` if needed) when running inside the VM proxy.
- **Persistent `storageState`:** Always load `runtime/sportybet_authenticated_state.json` into `browser.newContext({ storageState })` and **write it back** at the end of every run (`fs.writeFileSync(statePath, JSON.stringify(await context.storageState(), null, 2))`). This preserves SportyBet's trusted-device token and cookies so you never trigger math captchas or email/SMS 2FA loops.
- **Fallback Login Rule:** If a session ever expires (`page.url().includes('login')` or `input[type="password"]` is visible), strip the leading `0` from the Ghana phone number (`creds.phone.replace(/^0/, '')`) before filling the phone input.

---

## 2. Exact SportyBet Mobile URLs (Avoid 404s)
- **Football Today:** `https://www.sportybet.com/gh/m/sport/football/today`
- **NBA:** `https://www.sportybet.com/gh/m/sport/basketball/sr:category:15/sr:tournament:132`
- **Open Bets & Settled History:** Navigate to `https://www.sportybet.com/gh/m/my_accounts/open_bets`. Do **not** navigate directly to `/my_accounts/bet_history` (it returns a `40X` error page). Instead, click the `"Bet History"` tab inside `open_bets`:
  ```js
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("*"));
    const tab = els.find(e => e.textContent.trim() === "Bet History" && e.children.length === 0);
    if (tab) tab.click();
  });
  ```

---

## 3. Exact DOM Row & Outcome Selectors (Zero Parent-Wrapper Collisions)
Never walk up the DOM from a team name without strict row filtering—parent wrappers can contain multiple matches.
- **Row Selector:**
  ```js
  const rows = Array.from(document.querySelectorAll('.m-table-row.m-sports-table, .m-event-sport.m-sports-row'));
  const row = rows.find(r => {
    const txt = r.innerText || '';
    return txt.includes(team) && !txt.includes('SRL') && r.querySelectorAll('.m-outcome').length >= 2 && r.querySelectorAll('.m-outcome').length <= 6;
  });
  ```
- **Outcome Indexing:**
  - Football `1X2`: `outcomes[0]` = Home (`1`), `outcomes[1]` = Draw (`X`), `outcomes[2]` = Away (`2`).
  - Basketball `Winner (incl. OT)`: `outcomes[0]` = Home (`1`), `outcomes[1]` = Away (`2`).
- Always exclude Simulated Reality League (`!txt.includes('SRL')`) so real matches are never confused with SRL sims.

---

## 4. Mobile Betslip Keypad Entry (Never Use `.fill()`)
SportyBet mobile uses a custom on-screen keypad; `.fill()` will fail or be overwritten.
1. Open the betslip (`.betslip-theme-icon`) and click the stake field:
   - **Multiples:** `[data-op="betslip-stake-amount"]`
   - **Singles:** `[data-op="betslip-single-stake"]`
2. Clear existing value and wait `300ms`:
   ```js
   document.querySelector('.m-keyboard-key[data-key="clear"]')?.click();
   ```
3. Tap each character (`'1'`, `'2'`, `'.'`, `'5'`) with a `220ms` delay:
   ```js
   const keyEl = document.querySelector(`.m-keyboard-key[data-op="betslip-keyboard-${ch}"]`)
     || document.querySelector(`.m-keyboard-key[data-key="${ch}"]`);
   if (keyEl) keyEl.click();
   ```
4. Click `[data-key="done"]` and wait `800ms`.
5. Click Place Bet (`[data-op="betslip-placebet"]` for Multiples, `[data-op="single-placebet"], [data-op="betslip-placebet"]` for Singles), wait `2000ms`, then click the final `Confirm` button (`btns[btns.length - 1].click()`).

---

## 5. Cashout Confirmation Selector
On `open_bets`, clicking `[data-op="openbet__cashout_btn"]` opens the bottom drawer; the final confirmation button is `[data-op="open_bets__cashout_confirm"]`.
