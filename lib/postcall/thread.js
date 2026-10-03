/**
 * Threading rules for the post-call Smartlead path.
 *
 * First email from this caller+client = new thread (lead import).
 * Later emails = reply-email-thread on that same post-call campaign lead
 * (threadId, In-Reply-To, References). Never reply onto a different
 * Smartlead campaign's thread (source=smartlead from another sequence).
 */

export function isSmartleadThread(contact) {
  if (!contact) return false;
  if (contact.source === 'smartlead') return true;
  if (contact.thread_source === 'smartlead') return true;
  return false;
}

export function decideThread(contact) {
  if (isSmartleadThread(contact)) {
    return { mode: 'new_thread', reason: 'do_not_thread_smartlead' };
  }
  const threadId = contact?.thread_id;
  const lastMessageId = contact?.last_message_id;
  if (threadId && lastMessageId) {
    return {
      mode: 'reply',
      threadId,
      inReplyTo: lastMessageId,
      references: contact.references || lastMessageId,
    };
  }
  return { mode: 'new_thread' };
}

export function headersFor(decision) {
  if (decision.mode !== 'reply') return {};
  return {
    threadId: decision.threadId,
    'In-Reply-To': decision.inReplyTo,
    References: decision.references,
  };
}

export function nextSendCount(contact) {
  return Number(contact?.send_count || 0) + 1;
}
