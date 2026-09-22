import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFollowUp, shouldFollowUp } from '../lib/voicemail.js';

const call = (over = {}) => ({ result: 'ANSWERED', duration: 40, tags: [], ...over });

// Summaries marked "live" are verbatim from the Allo account.

test('a left voicemail is a follow-up', () => {
  const v = classifyFollowUp(
    call({ summary: 'Cold outbound voicemail about booking more commercial meetings and potential fit.' })
  );
  assert.equal(v.kind, 'voicemail');
  assert.equal(shouldFollowUp(call({ summary: 'Left a voicemail regarding commercial roofing leads.' })).include, true);
});

test('hitting voicemail still follows up when no message was left', () => {
  for (const summary of [
    'Outbound call to a new contact reached voicemail; no message left.',
    'Outbound call to unknown contact ended with voicemail greeting; no message left.',
    'Called and reached voicemail without leaving a message.',
    'Reached voicemail but did not leave a message.',
    'Outbound call to Diaz from Sakesglider; reached voicemail.',
  ]) {
    const v = classifyFollowUp(call({ summary }));
    assert.equal(v.kind, 'voicemail', summary);
    assert.equal(shouldFollowUp(call({ summary })).include, true, summary);
  }
});

test('a call that never connected is included', () => {
  const v = classifyFollowUp(call({ result: 'CLOSED', summary: 'Outbound call.', duration: 39 }));
  assert.equal(v.kind, 'no_connect');
  assert.equal(shouldFollowUp(call({ result: 'CLOSED', summary: 'Outbound call.', duration: 39 })).include, true);
});

test('unanswered / busy / failed results are included', () => {
  for (const result of ['FAILED', 'BUSY', 'NO_ANSWER', 'UNANSWERED', 'MISSED']) {
    const v = classifyFollowUp(call({ result, summary: '', duration: 12 }));
    assert.equal(v.kind, 'no_connect', result);
    assert.equal(shouldFollowUp(call({ result, summary: '', duration: 12 })).include, true, result);
  }
});

test('summary no-answer language is included even when result is ANSWERED', () => {
  const v = classifyFollowUp(call({ summary: 'Outbound call rang through; no one picked up.', duration: 28 }));
  assert.equal(v.kind, 'no_connect');
  assert.equal(shouldFollowUp(call({ summary: 'Outbound call rang through; no one picked up.' })).include, true);
});

test('an explicit conversation tag excludes the call', () => {
  const v = classifyFollowUp(call({ tags: ['conversation'], summary: 'reached voicemail' }));
  assert.equal(v.kind, 'conversation');
  assert.equal(shouldFollowUp(call({ tags: ['conversation'], summary: 'reached voicemail' })).include, false);
});

test('voicemail and no-answer tags include the call', () => {
  assert.equal(shouldFollowUp(call({ tags: ['voicemail'], summary: 'talked about pricing' })).include, true);
  assert.equal(shouldFollowUp(call({ tags: ['no_answer'], summary: '' })).include, true);
});

test('result=VOICEMAIL is included if Allo ever sends it', () => {
  const v = classifyFollowUp(call({ result: 'VOICEMAIL', summary: '' }));
  assert.equal(v.kind, 'voicemail');
  assert.equal(shouldFollowUp(call({ result: 'VOICEMAIL', summary: '' })).include, true);
});

test('a live conversation is not a follow-up', () => {
  const summary = 'Outbound roofing call; caller sought availability after introducing themselves.';
  const v = classifyFollowUp(call({ summary }));
  assert.equal(v.kind, 'conversation');
  assert.equal(shouldFollowUp(call({ summary })).include, false);
});

test('spoke-with-the-prospect language is excluded', () => {
  for (const summary of [
    'Spoke with the owner about commercial roofing and they asked for a follow-up email.',
    'Talked to the prospect; they were not interested in a meeting.',
    'Had a conversation with Mike; discussed pricing and booked a meeting.',
  ]) {
    assert.equal(shouldFollowUp(call({ summary, duration: 180 })).include, false, summary);
    assert.equal(classifyFollowUp(call({ summary })).kind, 'conversation', summary);
  }
});

test('gatekeeper / screen without an owner conversation is included', () => {
  const summary = 'Reached the receptionist; gatekeeper would not put the owner on the line.';
  const v = classifyFollowUp(call({ summary, duration: 45 }));
  assert.equal(v.kind, 'no_connect');
  assert.equal(shouldFollowUp(call({ summary })).include, true);
});

test('gatekeeper then a real owner conversation is excluded', () => {
  const summary = 'Reached the receptionist, then transferred to the owner who said they already have a roofer.';
  assert.equal(classifyFollowUp(call({ summary, duration: 90 })).kind, 'conversation');
  assert.equal(shouldFollowUp(call({ summary, duration: 90 })).include, false);
});

test('a short answered call with no summary is treated as no-speak', () => {
  const v = classifyFollowUp(call({ summary: '', duration: 9 }));
  assert.equal(v.kind, 'no_connect');
  assert.equal(shouldFollowUp(call({ summary: '', duration: 9 })).include, true);
});

test('a long answered call with no summary is excluded (may be a live talk)', () => {
  const v = classifyFollowUp(call({ summary: '', duration: 95 }));
  assert.equal(v.kind, 'uncertain');
  assert.equal(shouldFollowUp(call({ summary: '', duration: 95 })).include, false);
});

test('uncertain calls can be opted in', () => {
  const previous = process.env.FOLLOWUP_INCLUDE_UNCERTAIN;
  process.env.FOLLOWUP_INCLUDE_UNCERTAIN = 'true';
  try {
    const c = call({ summary: '', duration: 95 });
    assert.equal(shouldFollowUp(c).include, true);
  } finally {
    if (previous === undefined) delete process.env.FOLLOWUP_INCLUDE_UNCERTAIN;
    else process.env.FOLLOWUP_INCLUDE_UNCERTAIN = previous;
  }
});

test('transferred without voicemail language is treated as a conversation', () => {
  const v = classifyFollowUp(call({ result: 'TRANSFERRED', summary: 'Outbound call transferred.', duration: 70 }));
  assert.equal(v.kind, 'conversation');
  assert.equal(shouldFollowUp(call({ result: 'TRANSFERRED', summary: 'Outbound call transferred.', duration: 70 })).include, false);
});

test('duration never overrides an explicit voicemail hit', () => {
  const v = classifyFollowUp(call({ summary: 'Outbound call reached voicemail; no message left.', duration: 8 }));
  assert.equal(v.kind, 'voicemail');
  assert.equal(shouldFollowUp(call({ summary: 'Outbound call reached voicemail; no message left.', duration: 8 })).include, true);
});
