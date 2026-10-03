/**
 * Send adapter. Delivery is Smartlead — one campaign per caller + client.
 * Never imports into another caller's campaign (Cayden's 3739316 stays his).
 *
 * Dry-run writes a synthetic thread id and sends nothing.
 */

import { randomUUID } from 'node:crypto';
import { addLeadToCampaign, replyToLead } from '../smartlead.js';

const CAYDEN_CAMPAIGN = 3739316;

function angleId(id) {
  const raw = String(id || '').replace(/^<|>$/g, '');
  return `<${raw}>`;
}

export function assertCampaignIsolation({ caller, campaignId, allowedCampaignId } = {}) {
  const id = Number(campaignId);
  const allowed = Number(allowedCampaignId);
  if (!id) return { ok: false, reason: 'smartlead_campaign_missing' };
  if (allowed && id !== allowed) {
    return { ok: false, reason: 'smartlead_campaign_mismatch' };
  }
  if (caller && caller !== 'cayden' && id === CAYDEN_CAMPAIGN) {
    return { ok: false, reason: 'refused_cayden_campaign' };
  }
  if (caller === 'cayden' && allowed && allowed !== CAYDEN_CAMPAIGN && id === CAYDEN_CAMPAIGN) {
    return { ok: true };
  }
  return { ok: true };
}

export async function sendPostcallEmail({
  dryRun = true,
  inbox,
  inboxAccountId,
  to,
  firstName,
  lastName,
  companyName,
  subject,
  body,
  thread,
  campaignId,
  caller,
  allowedCampaignId,
  smartleadLeadId,
  customFields = {},
} = {}) {
  if (!inbox) return { ok: false, reason: 'inbox_missing' };
  if (!to) return { ok: false, reason: 'recipient_missing' };

  const isolated = assertCampaignIsolation({ caller, campaignId, allowedCampaignId });
  if (!isolated.ok) return isolated;

  if (dryRun) {
    const messageId = angleId(`dry.${randomUUID()}@smartlead.local`);
    const threadId = thread?.threadId || `sl-thread-${campaignId}-${randomUUID()}`;
    return {
      ok: true,
      dryRun: true,
      provider: 'smartlead',
      campaignId: Number(campaignId) || null,
      inbox,
      to,
      subject,
      body,
      threadId,
      messageId,
      smartleadLeadId: smartleadLeadId || null,
      headers: thread?.mode === 'reply'
        ? { 'In-Reply-To': thread.inReplyTo, References: thread.references, threadId }
        : { threadId },
    };
  }

  if (!campaignId) return { ok: false, reason: 'smartlead_campaign_missing' };

  if (thread?.mode === 'reply') {
    if (!smartleadLeadId || !thread.inReplyTo) {
      return { ok: false, reason: 'smartlead_thread_missing' };
    }
    const replied = await replyToLead({
      id: campaignId,
      leadId: smartleadLeadId,
      emailBody: body,
      replyMessageId: String(thread.inReplyTo).replace(/^<|>$/g, ''),
      toEmail: to,
    });
    return {
      ok: true,
      dryRun: false,
      provider: 'smartlead',
      campaignId: Number(campaignId),
      inbox,
      to,
      subject,
      body,
      threadId: thread.threadId,
      messageId: angleId(replied?.message_id || replied?.id || `sl.reply.${randomUUID()}`),
      smartleadLeadId,
      raw: replied,
      headers: { 'In-Reply-To': thread.inReplyTo, References: thread.references, threadId: thread.threadId },
    };
  }

  const uploaded = await addLeadToCampaign(
    {
      email: to,
      first_name: firstName || '',
      last_name: lastName || '',
      company_name: companyName || '',
      custom_fields: {
        booking_link: customFields.booking_link || '',
        signature: customFields.signature || '',
        postcall_subject: subject || '',
        postcall_caller: caller || '',
        ...customFields,
      },
    },
    { id: campaignId, emailAccountId: inboxAccountId }
  );

  if (uploaded.invalid > 0) return { ok: false, reason: 'smartlead_invalid', raw: uploaded };
  if (uploaded.unsubscribed > 0) return { ok: false, reason: 'smartlead_unsubscribed', raw: uploaded };

  const leadId = extractLeadId(uploaded);
  const messageId = angleId(`sl.${campaignId}.${leadId || randomUUID()}`);
  const threadId = `sl-${campaignId}-${leadId || to}`;
  return {
    ok: true,
    dryRun: false,
    provider: 'smartlead',
    campaignId: Number(campaignId),
    inbox,
    to,
    subject,
    body,
    threadId,
    messageId,
    smartleadLeadId: leadId,
    raw: uploaded,
    headers: { threadId },
  };
}

function extractLeadId(result) {
  const raw = result?.batches?.[0]?.raw || result;
  return (
    raw?.lead_id ||
    raw?.id ||
    raw?.leads?.[0]?.id ||
    raw?.data?.[0]?.id ||
    null
  );
}

export function nextMorning(from = new Date()) {
  const guess = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  guess.setUTCHours(12, 0, 0, 0);
  return guess;
}
