'use strict';

const DISP_LABELS = {
  'ANSWERED':  'Contestada',
  'NO ANSWER': 'No contestada',
  'BUSY':      'Ocupado',
  'FAILED':    'Fallida',
};

/**
 * Extracts a readable agent name from an Asterisk channel string.
 * Examples:
 *   "Agent/03"            → "Agent/03"
 *   "Agent/03-000001ab"   → "Agent/03"
 *   "SIP/202-00a1b2c3"    → "202"
 *   "PJSIP/202-00a1b2c3"  → "202"
 *   "Local/..."           → ""
 *   ""                    → ""
 */
function extractAgentName(channel) {
  if (!channel) return '';
  const agentMatch = channel.match(/^(Agent\/\d+)/);
  if (agentMatch) return agentMatch[1];
  const sipMatch = channel.match(/^(?:SIP|PJSIP)\/(\d+)-/);
  if (sipMatch) return sipMatch[1];
  return '';
}

/**
 * Formats a duration in seconds as mm:ss.
 * Examples: 0 → "0:00", 59 → "0:59", 225 → "3:45", 3661 → "61:01"
 */
function formatBillsec(seconds) {
  const s = Number(seconds) || 0;
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Returns the Spanish label for an Asterisk disposition value.
 * Unknown values are returned as-is.
 */
function dispositionLabel(disposition) {
  return DISP_LABELS[(disposition || '').toUpperCase()] || disposition || '';
}

module.exports = { extractAgentName, formatBillsec, dispositionLabel };
