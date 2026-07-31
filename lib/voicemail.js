/**
 * Did we actually leave a voicemail on this call?
 *
 * Only calls where a message was left should trigger a follow-up email --
 * mailing someone who never heard from us reads as spam. Allo has no explicit
 * "voicemail left" field, so this classifies from the signals it does give:
 *
 *   result      ANSWERED = the line picked up (human OR voicemail machine)
 *               CLOSED   = never connected -> never a voicemail
 *   summary     Allo's AI description of the call. This is the real signal:
 *               it reliably says "no message left" when we hung up on the beep.
 *   tags        If the team tags calls, that is authoritative and wins.
 *   duration    Seconds. A left message takes time; a hangup on the greeting
 *               is short. Used only as a tie-breaker, never on its own.
 *
 * Returns { left, confidence, reason } so a dry run can show the call, and
 * anything uncertain can be reviewed rather than silently mailed.
 */

// A tag beats every inference -- if a human labelled the call, trust them.
const TAG_LEFT = /^(voicemail|vm|left_?(a_?)?(vm|voicemail|message)|lvm)$/i;
const TAG_NOT_LEFT = /^(no_?(vm|voicemail|message)|hung_?up|no_?answer)$/i;

// "no message left", "did not leave a message", "without leaving a message"...
const NEGATED = /\b(no|without|didn'?t|did not|never)\b[^.;]{0,30}\b(message|voicemail|vm)\b|\bvoicemail\b[^.;]{0,20}\bno message\b/i;

// "left a voicemail", "voicemail about ...", "left a message regarding ..."
const LEFT = /\b(left|leaving|dropped|recorded)\b[^.;]{0,30}\b(voicemail|vm|message)\b|\bvoicemail\b\s+(about|regarding|for|explaining|introducing)/i;

// Mentions voicemail at all -- necessary but not sufficient.
const MENTIONS_VOICEMAIL = /\bvoice\s?mail\b|\bvm\b|\banswering machine\b/i;

const MIN_SECONDS_FOR_MESSAGE = Number(process.env.VOICEMAIL_MIN_SECONDS ?? 20);

// A call mentioning voicemail that ran at least this long is treated as a
// message left. Raise it to be stricter, lower it to catch more.
const ASSUME_LEFT_SECONDS = Number(process.env.VOICEMAIL_ASSUME_LEFT_SECONDS ?? 35);

export function classifyVoicemail(call) {
  const tags = (call.tags || []).map(String);
  const summary = String(call.summary || '');
  const result = String(call.result || '').toUpperCase();
  const duration = Number(call.duration ?? 0);

  for (const tag of tags) {
    if (TAG_LEFT.test(tag)) return yes('high', `tagged "${tag}"`);
    if (TAG_NOT_LEFT.test(tag)) return no('high', `tagged "${tag}"`);
  }

  // Allo's documented enum includes VOICEMAIL even though live data shows
  // ANSWERED/CLOSED -- honour it if it ever appears.
  if (result === 'VOICEMAIL') return yes('medium', 'result=VOICEMAIL');

  // Never connected: there was no beep to talk into.
  if (result && result !== 'ANSWERED' && result !== 'VOICEMAIL') {
    return no('high', `result=${result} (never connected)`);
  }

  if (!summary) {
    // Answered with no summary tells us nothing either way.
    return unknown(`result=${result}, no summary`);
  }

  // Order matters: "reached voicemail; no message left" matches both patterns,
  // and the negation is the operative half.
  if (NEGATED.test(summary)) return no('high', 'summary says no message was left');
  if (LEFT.test(summary)) return yes('high', 'summary describes leaving a message');

  if (MENTIONS_VOICEMAIL.test(summary)) {
    // Allo's summary often names the voicemail without saying whether a
    // message was left. Duration settles it: a greeting alone runs ~15-25s,
    // so anything materially longer means someone talked after the beep.
    // Measured against a real day: the ambiguous calls ran 24s to 91s, and
    // treating everything past ~35s as a message recovers most of them.
    if (duration >= ASSUME_LEFT_SECONDS) {
      return yes('medium', `voicemail mentioned, ${duration}s call — long enough to leave a message`);
    }
    return duration >= MIN_SECONDS_FOR_MESSAGE
      ? unknown(`summary mentions voicemail, ${duration}s call, no explicit outcome`)
      : no('medium', `summary mentions voicemail but call was only ${duration}s`);
  }

  // No mention of voicemail at all -- most likely a live conversation or a
  // no-answer. Either way, not a voicemail follow-up.
  return no('medium', 'summary does not mention voicemail');
}

const yes = (confidence, reason) => ({ left: true, confidence, reason });
const no = (confidence, reason) => ({ left: false, confidence, reason });
const unknown = (reason) => ({ left: null, confidence: 'low', reason });

/**
 * Should this call produce a follow-up?
 *
 * Ambiguous calls are excluded by default -- not mailing someone is a cheaper
 * mistake than mailing someone who never heard from us. Set
 * VOICEMAIL_INCLUDE_UNCERTAIN=true to include them.
 */
export function shouldFollowUp(call) {
  const verdict = classifyVoicemail(call);
  if (verdict.left === true) return { include: true, ...verdict };
  if (verdict.left === false) return { include: false, ...verdict };

  const includeUncertain = /^(1|true|yes)$/i.test(process.env.VOICEMAIL_INCLUDE_UNCERTAIN || '');
  return { include: includeUncertain, ...verdict };
}
