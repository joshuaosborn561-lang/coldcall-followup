/**
 * Should this outbound call produce a follow-up email?
 *
 * Cayden (and the rest of the team) should follow up when there was **no
 * real conversation** with the prospect:
 *
 *   include  no-connect / unanswered / hung up before a talk
 *   include  voicemail / answering machine — whether or not a message was left
 *   include  gatekeeper / screen that never reached the owner
 *   exclude  a live conversation with the prospect
 *
 * Allo has no single "connected to a human" field. Documented `result` values
 * are ANSWERED | VOICEMAIL | TRANSFERRED; live SalesGlider data also uses
 * CLOSED for never-connected dials. The AI `summary` is the real signal.
 *
 * Returns { include, kind, confidence, reason } so a dry run can show why
 * each call was kept or dropped.
 */

// A tag beats inference when a human labelled the call.
const TAG_VOICEMAIL = /^(voicemail|vm|left_?(a_?)?(vm|voicemail|message)|lvm|answering_?machine)$/i;
const TAG_NO_CONNECT =
  /^(no_?(connect|answer)|unanswered|hung_?up|busy|failed|never_?connected|gatekeeper|screen(ed)?)$/i;
const TAG_CONVERSATION = /^(conversation|connected|spoke|talked|meeting_?booked|live)$/i;

const MENTIONS_VOICEMAIL = /\bvoice\s?mail\b|\bvm\b|\banswering machine\b|\bmailbox\b/i;

const NO_CONNECT = /\b(no answer|no one (picked|picks) up|didn'?t answer|did not answer|never connected|not (available|in)|busy( signal)?|unanswered|hung up|hang[\s-]?up|ring(?:ing)? (out|no answer)|couldn'?t (reach|connect)|failed to connect|line (was )?(busy|dead))\b/i;

const GATEKEEPER = /\b(gatekeeper|receptionist|front desk|screener|secretary|assistant|office manager)\b/i;

// Prospect actually spoke — not just "voicemail about booking a meeting".
const LIVE_CONVERSATION =
  /\b(spoke (with|to)|talked (with|to)|conversation with|discussed|they (said|mentioned|asked|were|was)|he said|she said|owner (said|was|is|came)|decision maker|booked (a )?(meeting|call|demo)|scheduled (a )?(meeting|call)|pitched|live (call|conversation)|introduced themselves|sought availability|wrong number|not interested)\b/i;

// After a gatekeeper, did the owner actually come on?
const OWNER_AFTER_GATE =
  /\b(then|after(?:ward|wards)?|transferred (?:to|through)|put (?:me |us )?through|connected (?:me |us )?to)\b[^.;]{0,60}\b(owner|principal|president|prospect|decision maker|him|her)\b|\b(owner|principal|president|decision maker|prospect)\b[^.;]{0,40}\b(said|spoke|talked|discussed|came on|picked up|joined)\b/i;

const NEVER_CONNECTED = new Set([
  'CLOSED',
  'FAILED',
  'BLOCKED',
  'BUSY',
  'NO_ANSWER',
  'MISSED',
  'CANCELED',
  'CANCELLED',
  'UNANSWERED',
]);

// Answered with no useful summary: a greeting / hangup is short; a real talk is not.
const SHORT_NO_SPEAK_SECONDS = Number(process.env.FOLLOWUP_SHORT_SECONDS ?? 30);

export function classifyFollowUp(call) {
  const tags = (call.tags || []).map(String);
  const summary = String(call.summary || '');
  const result = String(call.result || '').toUpperCase();
  const duration = Number(call.duration ?? 0);

  for (const tag of tags) {
    if (TAG_CONVERSATION.test(tag)) return conversation('high', `tagged "${tag}"`);
    if (TAG_VOICEMAIL.test(tag)) return voicemail('high', `tagged "${tag}"`);
    if (TAG_NO_CONNECT.test(tag)) return noConnect('high', `tagged "${tag}"`);
  }

  if (NEVER_CONNECTED.has(result)) {
    return noConnect('high', `result=${result} (never connected)`);
  }

  if (result === 'VOICEMAIL') {
    return voicemail('high', 'result=VOICEMAIL');
  }

  if (MENTIONS_VOICEMAIL.test(summary)) {
    return voicemail('high', 'summary reached voicemail / answering machine');
  }

  if (NO_CONNECT.test(summary)) {
    return noConnect('high', 'summary describes no-connect / no-answer');
  }

  if (GATEKEEPER.test(summary) && !OWNER_AFTER_GATE.test(summary) && !LIVE_CONVERSATION.test(summary)) {
    return noConnect('medium', 'gatekeeper / screen, no owner conversation');
  }

  if (isLiveConversation(summary)) {
    return conversation('high', 'summary describes a live conversation');
  }

  if (!summary) {
    if (duration > 0 && duration < SHORT_NO_SPEAK_SECONDS) {
      return noConnect('medium', `no summary, ${duration}s — too short for a real conversation`);
    }
    if (result === 'ANSWERED' || result === 'TRANSFERRED') {
      return unknown(`result=${result}, no summary, ${duration}s — may have been a live conversation`);
    }
    return unknown(`result=${result || 'unknown'}, no summary`);
  }

  if (duration > 0 && duration < SHORT_NO_SPEAK_SECONDS && !isLiveConversation(summary)) {
    return noConnect('medium', `${duration}s call with no conversation language`);
  }

  if (result === 'TRANSFERRED') {
    return conversation('medium', 'result=TRANSFERRED without voicemail / no-connect language');
  }

  if (result === 'ANSWERED') {
    return conversation('medium', 'answered call with no voicemail / no-connect language');
  }

  return unknown(`result=${result || 'unknown'}, summary does not classify`);
}

function isLiveConversation(summary) {
  if (!LIVE_CONVERSATION.test(summary)) return false;
  if (GATEKEEPER.test(summary) && !OWNER_AFTER_GATE.test(summary)) return false;
  return true;
}

/**
 * Should this call produce a follow-up?
 *
 * Uncertain calls are excluded by default — mailing someone after a real
 * conversation is the expensive mistake. Set FOLLOWUP_INCLUDE_UNCERTAIN=true
 * (or the older VOICEMAIL_INCLUDE_UNCERTAIN) to include them.
 */
export function shouldFollowUp(call) {
  const verdict = classifyFollowUp(call);
  if (verdict.kind === 'conversation') return { include: false, ...verdict };
  if (verdict.kind === 'no_connect' || verdict.kind === 'voicemail') {
    return { include: true, ...verdict };
  }

  const includeUncertain = /^(1|true|yes)$/i.test(
    process.env.FOLLOWUP_INCLUDE_UNCERTAIN || process.env.VOICEMAIL_INCLUDE_UNCERTAIN || ''
  );
  return { include: includeUncertain, ...verdict };
}

/** @deprecated Use classifyFollowUp. Kept so older imports keep resolving. */
export function classifyVoicemail(call) {
  const verdict = classifyFollowUp(call);
  const left = verdict.kind === 'voicemail' ? true : verdict.kind === 'uncertain' ? null : false;
  return { left, confidence: verdict.confidence, reason: verdict.reason, kind: verdict.kind };
}

const voicemail = (confidence, reason) => ({ kind: 'voicemail', confidence, reason });
const noConnect = (confidence, reason) => ({ kind: 'no_connect', confidence, reason });
const conversation = (confidence, reason) => ({ kind: 'conversation', confidence, reason });
const unknown = (reason) => ({ kind: 'uncertain', confidence: 'low', reason });
