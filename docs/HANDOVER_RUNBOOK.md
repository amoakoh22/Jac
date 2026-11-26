# Jac 24/7 Disaster Recovery & Handover Runbook

> **Principle:** The devbox VM is 100% disposable. **GitHub (`amoakoh22/Jac` `origin/main`) + GitHub Secrets + Google Apps Script** are the single source of truth. Zero critical state lives only on a VM.

## 1. Live Production Architecture (Runs With Zero VM & Zero Chat Tokens)
1. **Scheduler (Google Apps Script — `JacSyndicate`):**
   - Triggers `POST https://api.github.com/repos/amoakoh22/Jac/actions/workflows/syndicate_24_7_cron.yml/dispatches` every **15 minutes** with `{"ref":"main","inputs":{"respect_gate":"true"}}`.
   - Uses Script Property `GH_PAT` (fine-grained PAT with `Actions: Read and write` on `amoakoh22/Jac`).
   - Source: [scripts/google_apps_script_cron.js](../scripts/google_apps_script_cron.js) | Setup: [docs/EXTERNAL_CRON_SETUP.md](./EXTERNAL_CRON_SETUP.md).
2. **Cloud Execution Engine (GitHub Actions — [syndicate_24_7_cron.yml](../.github/workflows/syndicate_24_7_cron.yml)):**
   - **Pre-Flight Gate ([syndicate/check_wakeup_gate.py](../syndicate/check_wakeup_gate.py)):** Runs in <1s before Node/Chromium. Skips dead hours in ~8–10s; wakes full engine on `ACTIVE_WINDOW` (`[-25m, +150m]` around pending kickoffs), `REPLENISH_READY` (Vault WON or x100+ slots < 2), `HEARTBEAT_4H`, or manual `workflow_dispatch`.
   - **Full Cycle:** `active_login_sentinel.js` → `AUTO_CASHOUT=1 monitor_syndicate_bets.js` → `live_api_audit.js` → `reconcile_live_audit.py` → `closed_loop_learner.py` → `capital_ledger.py` → `AUTO_DEPLOY=1 autonomous_orchestrator.js --live` → `update_status.py` → `render_syndicate_terminal.py` → SQLite `PRAGMA integrity_check` → `git push origin main`.
3. **Live KPI Terminal (GitHub Pages):**
   - https://amoakoh22.github.io/Jac/ (auto-reloads every 120s, shows red `STALE` banner if >45m old, `status.json` alert if >=3 consecutive cloud failures).

## 2. Persistence Inventory (Nothing Lost on VM Wipe)
| Asset | Where It Lives | Backup / Recovery |
| :--- | :--- | :--- |
| All code, workflows, tests, heuristics (`v3.0.0`, `min_betradar_rtp=0.98`) | `origin/main` | `git clone https://github.com/amoakoh22/Jac.git` |
| SQLite ledger (`data/syndicate_ledger.sqlite`) & manual entries (`data/manual_ledger_entries.json`) | Committed to `origin/main` every active cycle | `PRAGMA integrity_check` gated before every push |
| SportyBet credentials & session cookies | GitHub Secrets: `SPORTYBET_PHONE`, `SPORTYBET_PASSWORD`, `JACK_AUTHENTICATED_STATE_JSON` | Auto-hydrated into `runtime/` on every GH Actions run |
| External 15m cron trigger | Google Apps Script (`script.google.com` → `JacSyndicate`) | Independent of VM and GitHub `schedule` |

## 3. Cold-Start Recovery on Any New VM / Machine (3 Commands)
```bash
git clone https://github.com/amoakoh22/Jac.git && cd Jac
npm ci
bash scripts/verify_cold_start.sh
```
To run interactively on a new VM, copy `SPORTYBET_PHONE`/`SPORTYBET_PASSWORD` into gitignored `runtime/jack_vault.json` (`chmod 600`) and run `node syndicate/active_login_sentinel.js` (complete CAPTCHA/OTP if SportyBet challenges the new IP), then optionally update `JACK_AUTHENTICATED_STATE_JSON` in GitHub Secrets.

## 4. Escalation Playbook (Only When Human Action Is Needed)
- **SportyBet CAPTCHA / 2FA on Cloud Runner:** GitHub Actions marks `status.json` failed (`alert_active: true` after 3 fails). Run `node syndicate/active_login_sentinel.js` locally, solve challenge once, and refresh `JACK_AUTHENTICATED_STATE_JSON` in GitHub Secrets.
- **GitHub PAT Expiry:** Generate a new fine-grained PAT (`Actions: Read and write` on `amoakoh22/Jac`) and update `GH_PAT` in Google Apps Script → Project Settings → Script Properties.
