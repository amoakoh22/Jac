/**
 * Free 24/7 External Cron Trigger via Google Apps Script (script.google.com)
 * Triggers GitHub Actions workflow_dispatch every 15 minutes with respect_gate=true
 * so WakeupGate skips dead hours in ~3s and runs full Chromium only during match windows.
 *
 * Setup:
 * 1. Go to https://script.google.com -> New project -> paste this file.
 * 2. In Project Settings -> Script Properties, add:
 *      GH_PAT = <your fine-grained GitHub PAT with Actions: Read & Write on amoakoh22/Jac>
 * 3. Run `installTrigger()` once (accept permissions). Done!
 */
function triggerJacSyndicate() {
  const token = PropertiesService.getScriptProperties().getProperty('GH_PAT');
  if (!token) throw new Error('Missing Script Property: GH_PAT');

  const url = 'https://api.github.com/repos/amoakoh22/Jac/actions/workflows/syndicate_24_7_cron.yml/dispatches';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({
      ref: 'main',
      inputs: { respect_gate: 'true' },
    }),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 204) {
    throw new Error('GitHub dispatch failed: HTTP ' + code + ' ' + resp.getContentText());
  }
  Logger.log('Dispatched syndicate_24_7_cron.yml (respect_gate=true): HTTP 204');
}

function installTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'triggerJacSyndicate') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('triggerJacSyndicate').timeBased().everyMinutes(15).create();
  triggerJacSyndicate();
}
