import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyVoicemail, shouldFollowUp } from '../lib/voicemail.js';

const call = (over = {}) => ({ result: 'ANSWERED', duration: 40, tags: [], ...over });

// Summaries below are verbatim from the live Allo account.

test('a left voicemail is recognised', () => {
  const v = classifyVoicemail(
    call({ summary: 'Cold outbound voicemail about booking more commercial meetings and potential fit.' })
  );
  assert.equal(v.left, true);
  assert.equal(v.confidence, 'high');
});

test('"no message left" is not a follow-up, even though it says voicemail', () => {
  for (const summary of [
    'Outbound call to a new contact reached voicemail; no message left.',
    'Outbound call to unknown contact ended with voicemail greeting; no message left.',
    'Called and reached voicemail without leaving a message.',
    'Reached voicemail but did not leave a message.',
  ]) {
    const v = classifyVoicemail(call({ summary }));
    assert.equal(v.left, false, summary);
  }
});

test('a call that never connected is never a voicemail', () => {
  const v = classifyVoicemail(call({ result: 'CLOSED', summary: 'Outbound call.', duration: 39 }));
  assert.equal(v.left, false);
  assert.match(v.reason, /never connected/);
});

test('an explicit tag beats every inference', () => {
  const left = classifyVoicemail(call({ tags: ['voicemail'], summary: 'no message left' }));
  assert.equal(left.left, true, 'tag wins over summary');

  const notLeft = classifyVoicemail(call({ tags: ['no_voicemail'], summary: 'left a voicemail about pricing' }));
  assert.equal(notLeft.left, false);
});

test('unrelated tags do not interfere', () => {
  const v = classifyVoicemail(call({ tags: ['to_call_back', 'not_interested'], summary: 'left a voicemail about roofing' }));
  assert.equal(v.left, true);
});

test('result=VOICEMAIL is honoured if Allo ever sends it', () => {
  assert.equal(classifyVoicemail(call({ result: 'VOICEMAIL', summary: '' })).left, true);
});

test('a live conversation is not a voicemail', () => {
  const v = classifyVoicemail(
    call({ summary: 'Outbound roofing call; caller sought availability after introducing themselves.' })
  );
  assert.equal(v.left, false);
});

test('ambiguous "reached voicemail" is flagged uncertain, not assumed', () => {
  const v = classifyVoicemail(call({ summary: 'Outbound call to Diaz from Sakesglider; reached voicemail.', duration: 40 }));
  assert.equal(v.left, null, 'must not guess either way');
});

test('a short call that only mentions voicemail is treated as no message', () => {
  const v = classifyVoicemail(call({ summary: 'Outbound call; reached voicemail.', duration: 9 }));
  assert.equal(v.left, false);
});

test('answered with no summary is uncertain', () => {
  assert.equal(classifyVoicemail(call({ summary: '' })).left, null);
});

test('uncertain calls are excluded by default', () => {
  const c = call({ summary: 'Outbound call to Diaz from Sakesglider; reached voicemail.' });
  assert.equal(shouldFollowUp(c).include, false, 'not mailing is the cheaper mistake');
});

test('uncertain calls can be opted in', () => {
  const previous = process.env.VOICEMAIL_INCLUDE_UNCERTAIN;
  process.env.VOICEMAIL_INCLUDE_UNCERTAIN = 'true';
  try {
    const c = call({ summary: 'Outbound call to Diaz from Sakesglider; reached voicemail.' });
    assert.equal(shouldFollowUp(c).include, true);
  } finally {
    if (previous === undefined) delete process.env.VOICEMAIL_INCLUDE_UNCERTAIN;
    else process.env.VOICEMAIL_INCLUDE_UNCERTAIN = previous;
  }
});

test('a confirmed left voicemail is always included', () => {
  const c = call({ summary: 'Left a voicemail regarding commercial roofing leads.' });
  assert.equal(shouldFollowUp(c).include, true);
});
