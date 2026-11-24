'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const quant = require('../syndicate/quant/index');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('integration_dryrun — offline end-to-end quant pipeline & API client checks', () => {
  let tmpDir;
  let tmpDbPath;
  let outJsonPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(__dirname, '.tmp-int-'));
    tmpDbPath = path.join(tmpDir, 'dryrun_ledger.sqlite');
    outJsonPath = path.join(tmpDir, 'exported_tickets.json');

    const db = new DatabaseSync(tmpDbPath);
    db.exec(`
      CREATE TABLE syndicate_codehub_bullets (
        bullet_id TEXT PRIMARY KEY,
        booking_code TEXT,
        status TEXT
      );
      CREATE TABLE syndicate_creator_anchor_ledger (
        ledger_id TEXT PRIMARY KEY,
        booking_code TEXT,
        match_name TEXT,
        selection TEXT,
        status TEXT
      );
      CREATE TABLE syndicate_tickets (
        ticket_id TEXT PRIMARY KEY,
        booking_code TEXT,
        status TEXT
      );
      CREATE TABLE syndicate_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        match_name TEXT,
        market_name TEXT,
        selection TEXT,
        outcome TEXT
      );
    `);
    // Mark Ajax vs ADO Den Haag as active to verify firewall excludes it from cached fortress universe
    db.prepare("INSERT INTO syndicate_codehub_bullets VALUES ('B1', 'C36TTY', 'IN_PROGRESS')").run();
    db.prepare("INSERT INTO syndicate_creator_anchor_ledger VALUES ('L1', 'C36TTY', 'Ajax vs ADO Den Haag', 'Away Team to Win Both Halves: No @1.01', 'IN_PROGRESS')").run();
    db.close();
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs offline dry-run CLI on cached runtime JSON fixtures and validates exported schema', () => {
    const u100Path = path.join(ROOT_DIR, 'runtime', 'postmortem_100x_universe.json');
    const f50Path = path.join(ROOT_DIR, 'runtime', 'fortress_50fold_99pct_candidates.json');
    assert.ok(fs.existsSync(u100Path), 'cached postmortem_100x_universe.json must exist');
    assert.ok(fs.existsSync(f50Path), 'cached fortress_50fold_99pct_candidates.json must exist');

    const stdout = execFileSync(process.execPath, [
      path.join(ROOT_DIR, 'syndicate', 'quant', 'index.js'),
      '--mode=both',
      '--dry-run',
      `--input=${u100Path}`,
      `--fortress-input=${f50Path}`,
      `--db=${tmpDbPath}`,
      `--out=${outJsonPath}`,
      '--bankroll=187.67'
    ], { encoding: 'utf8' });

    const summary = JSON.parse(stdout);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.validation.valid, true, `Validation errors: ${JSON.stringify(summary.validation.errors)}`);
    assert.ok(fs.existsSync(outJsonPath));

    const exported = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
    assert.equal(exported.bankrollGhs, 187.67);
    assert.ok(Array.isArray(exported.tickets));
    assert.ok(exported.tickets.length >= 1, 'Expected at least Mode B fortress ticket from cached fixtures');

    const validation = quant.validateExportPayload(exported);
    assert.equal(validation.valid, true);

    // Verify Ajax vs ADO Den Haag was blocked by active-fixture firewall
    for (const t of exported.tickets) {
      assert.equal(t.guardrailAudit.zeroCorrelationPassed, true);
      assert.equal(t.guardrailAudit.activeOverlapCount, 0);
      for (const leg of t.legs) {
        assert.ok(!/ajax/i.test(leg.match), 'Active fixture Ajax vs ADO Den Haag must be excluded');
        assert.ok(leg.wap_item && leg.wap_item.key && leg.wap_item.marketInfo && leg.wap_item.outcomeInfo);
      }
    }
  });

  it('filters SRL/virtual fixtures and inactive markets/outcomes in sportybet_api.js', async () => {
    const mockRequest = {
      async post(url) {
        if (url.includes('wapConfigurableEventsByOrder')) {
          return {
            async json() {
              return {
                data: {
                  tournaments: [
                    {
                      id: 'sr:tournament:17',
                      name: 'Premier League',
                      categoryName: 'England',
                      events: [
                        { eventId: 'sr:match:1', status: 0, homeTeamName: 'Liverpool', awayTeamName: 'Everton', estimateStartTime: Date.now() + 999999, sport: { id: 'sr:sport:1', name: 'Football' } },
                        { eventId: 'sr:match:2', status: 0, homeTeamName: 'Liverpool SRL', awayTeamName: 'Everton SRL', estimateStartTime: Date.now() + 999999, sport: { id: 'sr:sport:1', name: 'Football' } },
                        { eventId: 'sr:match:3', status: 1, homeTeamName: 'Chelsea', awayTeamName: 'Spurs', estimateStartTime: Date.now() + 999999, sport: { id: 'sr:sport:1', name: 'Football' } }
                      ]
                    },
                    {
                      id: 'sr:tournament:999',
                      name: 'Premier League Simulated Reality League',
                      categoryName: 'Simulated Reality League',
                      events: [
                        { eventId: 'sr:match:4', status: 0, homeTeamName: 'Arsenal', awayTeamName: 'Leeds', estimateStartTime: Date.now() + 999999, sport: { id: 'sr:sport:1', name: 'Football' } }
                      ]
                    }
                  ]
                }
              };
            }
          };
        }
        if (url.includes('Outcomes')) {
          return {
            async json() {
              return {
                data: [
                  {
                    eventId: 'sr:match:1',
                    status: 0,
                    homeTeamName: 'Liverpool',
                    awayTeamName: 'Everton',
                    estimateStartTime: Date.now() + 999999,
                    sport: { id: 'sr:sport:1', name: 'Football', category: { id: 'sr:category:1', name: 'England', tournament: { id: 'sr:tournament:17', name: 'Premier League' } } },
                    markets: [
                      {
                        id: '10', status: 0, desc: 'Double Chance',
                        outcomes: [
                          { id: '9', desc: '1X', odds: '1.24', probability: '0.798', isActive: 1 },
                          { id: '11', desc: 'X2', odds: '2.40', probability: '0.400', isActive: 0 }
                        ]
                      },
                      {
                        id: '18', status: 1, desc: 'Over/Under',
                        outcomes: [{ id: '12', desc: 'Over 1.5', odds: '1.25', probability: '0.79', isActive: 1 }]
                      }
                    ]
                  }
                ]
              };
            }
          };
        }
        return { async json() { return { data: [] }; } };
      }
    };

    const events = await quant.fetchEventsByOrder(mockRequest, { maxPages: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'sr:match:1');

    const outcomes = await quant.fetchOutcomesBatch(mockRequest, [{ eventId: 'sr:match:1', marketId: '10', outcomeId: '9', specifier: null }]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcomeId, '9');
    assert.equal(outcomes[0].isActive, true);
    assert.ok(outcomes[0].wap_item.key.includes('sr:match:1'));
  });
});
