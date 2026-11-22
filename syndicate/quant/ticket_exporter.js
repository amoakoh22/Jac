'use strict';

const fs = require('fs');
const path = require('path');
const { buildWapItemFromLive } = require('./sportybet_api');

function formatLegForExport(leg) {
  const match = leg.match || `${leg.home || ''} vs ${leg.away || ''}`.trim();
  return {
    eventId: String(leg.eventId || ''),
    sportId: String(leg.sportId || 'sr:sport:1'),
    match,
    league: String(leg.league || ''),
    marketKey: String(leg.marketKey || 'UNKNOWN'),
    marketId: String(leg.marketId || ''),
    specifier: String(leg.specifier || ''),
    outcomeId: String(leg.outcomeId || ''),
    outcomeDesc: String(leg.outcomeDesc || ''),
    odds: Number(leg.odds),
    prob: Number(leg.prob),
    rtp: Number(leg.rtp),
    wap_item: leg.wap_item || buildWapItemFromLive(leg)
  };
}

function formatTicketForExport(ticket) {
  const mp = ticket.mathProof || {};
  const ga = ticket.guardrailAudit || {};
  return {
    id: String(ticket.id),
    mode: ticket.mode,
    name: String(ticket.name || ticket.id),
    recommendedStakeGhs: Number(ticket.recommendedStakeGhs || 0),
    mathProof: {
      folds: Number(mp.folds || 0),
      qualifyingCount: Number(mp.qualifyingCount || 0),
      baseOdds: Number(mp.baseOdds || 0),
      bonusPct: Number(mp.bonusPct || 0),
      effectiveMultiplier: Number(mp.effectiveMultiplier || 0),
      potentialPayout: Number(mp.potentialPayout || 0),
      combinedWinProb: Number(mp.combinedWinProb || 0),
      geometricMeanRtp: Number(mp.geometricMeanRtp || 0),
      trueExpectedRtp: Number(mp.trueExpectedRtp || 0),
      expectedValueGhs: Number(mp.expectedValueGhs || 0),
      isPositiveEv: Boolean(mp.isPositiveEv)
    },
    guardrailAudit: {
      zeroCorrelationPassed: Boolean(ga.zeroCorrelationPassed),
      activeOverlapCount: Number(ga.activeOverlapCount || 0),
      bannedMarketViolations: Number(ga.bannedMarketViolations || 0)
    },
    legs: (ticket.legs || []).map(formatLegForExport)
  };
}

function buildExportPayload(tickets, opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const bankrollGhs = Number(opts.bankrollGhs ?? opts.bankroll ?? 187.67);
  const heuristicsVersion = String(opts.heuristicsVersion || '3.0.0');

  return {
    generatedAt,
    bankrollGhs,
    heuristicsVersion,
    tickets: (tickets || []).map(formatTicketForExport)
  };
}

function validateExportPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object'] };
  }
  if (!payload.generatedAt || Number.isNaN(Date.parse(payload.generatedAt))) {
    errors.push('Invalid generatedAt ISO-8601 timestamp');
  }
  if (!Number.isFinite(payload.bankrollGhs) || payload.bankrollGhs < 0) {
    errors.push('Invalid bankrollGhs');
  }
  if (!payload.heuristicsVersion || typeof payload.heuristicsVersion !== 'string') {
    errors.push('Missing heuristicsVersion');
  }
  if (!Array.isArray(payload.tickets)) {
    errors.push('tickets must be an array');
    return { valid: false, errors };
  }

  for (let idx = 0; idx < payload.tickets.length; idx++) {
    const t = payload.tickets[idx];
    const prefix = `tickets[${idx}]`;
    if (!t.id) errors.push(`${prefix}: missing id`);
    if (t.mode !== 'x100_plus_ev' && t.mode !== 'fortress_98pct') {
      errors.push(`${prefix}: invalid mode ${t.mode}`);
    }
    if (!t.mathProof || typeof t.mathProof !== 'object') {
      errors.push(`${prefix}: missing mathProof`);
    }
    if (!t.guardrailAudit || t.guardrailAudit.zeroCorrelationPassed !== true) {
      errors.push(`${prefix}: zeroCorrelationPassed must be true`);
    }
    if (!Array.isArray(t.legs) || t.legs.length === 0) {
      errors.push(`${prefix}: legs must be non-empty array`);
      continue;
    }

    const evSet = new Set();
    for (let li = 0; li < t.legs.length; li++) {
      const l = t.legs[li];
      if (!l.eventId) errors.push(`${prefix}.legs[${li}]: missing eventId`);
      if (evSet.has(l.eventId)) errors.push(`${prefix}.legs[${li}]: duplicate eventId ${l.eventId}`);
      evSet.add(l.eventId);
      if (!l.wap_item || !l.wap_item.key || !l.wap_item.marketInfo || !l.wap_item.outcomeInfo) {
        errors.push(`${prefix}.legs[${li}]: invalid wap_item`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function exportTicketsToFile(payload, outPath) {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return resolved;
}

module.exports = {
  formatLegForExport,
  formatTicketForExport,
  buildExportPayload,
  validateExportPayload,
  exportTicketsToFile
};
