# Free External 15-Minute Scheduler Setup (Replaces Dropped GitHub `schedule`)

GitHub's native `on: schedule` (`*/15 * * * *`) dropped 30/31 slots in testing.
`workflow_dispatch` is 100% reliable and passes `respect_gate=true` so [check_wakeup_gate.py](../syndicate/check_wakeup_gate.py) still skips dead hours in ~3s.

## Step 1: Create a Fine-Grained GitHub PAT (30 sec)
1. Open GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** Only select repositories → `amoakoh22/Jac`.
3. **Permissions → Repository permissions → Actions:** **Read and write**.
4. Copy the `github_pat_...` token (never commit it to git).

## Step 2A: Google Apps Script (Free, 0 Card, Recommended)
1. Open https://script.google.com → **New project**.
2. Paste [scripts/google_apps_script_cron.js](../scripts/google_apps_script_cron.js).
3. Click **Project Settings (gear) → Script Properties → Add script property**:
   - Property: `GH_PAT`
   - Value: your `github_pat_...`
4. Select `installTrigger` in the top toolbar and click **Run** once (authorize when prompted).
   - Installs an automatic **every 15 minutes** trigger and fires an immediate test dispatch.

## Step 2B: Alternative — `cron-job.org` (Free, No Code)
- **URL:** `https://api.github.com/repos/amoakoh22/Jac/actions/workflows/syndicate_24_7_cron.yml/dispatches`
- **Schedule:** Every 15 minutes
- **Method:** `POST`
- **Headers:**
  - `Authorization: Bearer <your_github_pat>`
  - `Accept: application/vnd.github+json`
  - `Content-Type: application/json`
  - `User-Agent: jac-cron`
- **Body:** `{"ref":"main","inputs":{"respect_gate":"true"}}`
