'use strict';

const fs = require('fs');
const path = require('path');

const sportybetApi = require('./sportybet_api');
const bonusModel = require('./bonus_model');
const learningFilter = require('./learning_filter');
const modeA = require('./mode_a_x100_builder');
const modeB = require('./mode_b_fortress_builder');
const exporter = require('./ticket_exporter');

function loadCandidatesFromFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.candidates)) return raw.candidates;
  if (Array.isArray(raw.legs)) return raw.legs;
  return [];
}

function runQuantPipeline(opts = {}) {
  const {
    mode = 'both', // 'x100' | 'fortress' | 'both'
    candidates = [],
    fortressCandidates = null,
    bonusPlan = bonusModel.getDefaultBonusPlan(),
    heuristicsPath = learningFilter.DEFAULT_HEURISTICS_PATH,
    dbPath = learningFilter.DEFAULT_DB_PATH,
    bankroll = 187.67,
    x100Count = 1,
    x100Opts = {},
    fortressOpts = {},
    outPath = null
  } = opts;

  const learningCtx = opts.learningCtx || learningFilter.loadLearningContext({
    heuristicsPath,
    dbPath
  });

  const tickets = [];
  const diagnostics = {};
  const usedEventIds = new Set();

  if (mode === 'x100' || mode === 'both') {
    if (x100Count > 1) {
      const resA = modeA.buildDisjointX100Tickets(candidates, bonusPlan, learningCtx, x100Count, {
        bankroll,
        ...x100Opts
      });
      diagnostics.modeA = resA.diagnostics;
      for (const t of resA.tickets) {
        tickets.push(t);
        for (const l of t.legs) usedEventIds.add(l.eventId);
      }
    } else {
      const resA = modeA.buildX100PlusEvTicket(candidates, bonusPlan, learningCtx, {
        bankroll,
        ...x100Opts
      });
      diagnostics.modeA = resA.diagnostics;
      if (resA.ok && resA.ticket) {
        tickets.push(resA.ticket);
        for (const l of resA.ticket.legs) usedEventIds.add(l.eventId);
      }
    }
  }

  if (mode === 'fortress' || mode === 'both') {
    const fPool = Array.isArray(fortressCandidates) && fortressCandidates.length > 0
      ? fortressCandidates
      : candidates;
    const resB = modeB.buildFortress98Ticket(fPool, bonusPlan, learningCtx, {
      bankroll,
      excludeEventIds: usedEventIds,
      ...fortressOpts
    });
    diagnostics.modeB = resB.diagnostics;
    if (resB.ok && resB.ticket) {
      tickets.push(resB.ticket);
    }
  }

  const payload = exporter.buildExportPayload(tickets, {
    bankrollGhs: bankroll,
    heuristicsVersion: learningCtx.heuristicsVersion
  });
  const validation = exporter.validateExportPayload(payload);

  let writtenPath = null;
  if (outPath) {
    writtenPath = exporter.exportTicketsToFile(payload, outPath);
  }

  return {
    payload,
    validation,
    diagnostics,
    writtenPath
  };
}

function parseCliArgs(argv) {
  const args = {
    mode: 'both',
    dryRun: false,
    input: null,
    fortressInput: null,
    out: null,
    bankroll: 187.67,
    heuristics: learningFilter.DEFAULT_HEURISTICS_PATH,
    db: learningFilter.DEFAULT_DB_PATH,
    count: 1
  };

  for (const token of argv) {
    if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token.startsWith('--mode=')) {
      args.mode = token.slice('--mode='.length);
    } else if (token.startsWith('--input=')) {
      args.input = token.slice('--input='.length);
    } else if (token.startsWith('--fortress-input=')) {
      args.fortressInput = token.slice('--fortress-input='.length);
    } else if (token.startsWith('--out=')) {
      args.out = token.slice('--out='.length);
    } else if (token.startsWith('--bankroll=')) {
      args.bankroll = Number(token.slice('--bankroll='.length));
    } else if (token.startsWith('--heuristics=')) {
      args.heuristics = token.slice('--heuristics='.length);
    } else if (token.startsWith('--db=')) {
      args.db = token.slice('--db='.length);
    } else if (token.startsWith('--count=')) {
      args.count = Number(token.slice('--count='.length));
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  const candidates = [];

  if (args.input) {
    for (const p of args.input.split(',').map(s => s.trim()).filter(Boolean)) {
      candidates.push(...loadCandidatesFromFile(p));
    }
  }
  const fortressCandidates = args.fortressInput
    ? loadCandidatesFromFile(args.fortressInput)
    : null;

  const result = runQuantPipeline({
    mode: args.mode,
    candidates,
    fortressCandidates,
    bankroll: args.bankroll,
    heuristicsPath: args.heuristics,
    dbPath: args.db,
    x100Count: args.count,
    outPath: args.out
  });

  console.log(JSON.stringify({
    dryRun: args.dryRun,
    mode: args.mode,
    ticketsGenerated: result.payload.tickets.length,
    validation: result.validation,
    writtenPath: result.writtenPath,
    diagnostics: result.diagnostics
  }, null, 2));
}

module.exports = {
  ...sportybetApi,
  ...bonusModel,
  ...learningFilter,
  ...modeA,
  ...modeB,
  ...exporter,
  loadCandidatesFromFile,
  runQuantPipeline,
  parseCliArgs
};
