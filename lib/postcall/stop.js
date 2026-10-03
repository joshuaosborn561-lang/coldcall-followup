/**
 * Stop rules. Skip and log if any of these fire.
 */

export const MAX_UNANSWERED = 3;

export function evaluateStops({
  contact,
  alloPerson,
  suppression,
  campaignLead,
  campaignReplied,
} = {}) {
  const reasons = [];

  if (contact?.status === 'replied') reasons.push('replied_to_caller');
  if (contact?.status === 'suppressed') reasons.push('suppressed');
  if (contact?.status === 'paused') reasons.push('paused');

  if (Number(contact?.send_count || 0) >= MAX_UNANSWERED && contact?.status !== 'replied') {
    reasons.push('three_unanswered_attempts');
  }

  if (alloPerson) {
    if (alloPerson.do_not_contact === true || alloPerson.dnc === true) reasons.push('allo_dnc');
    const tags = (alloPerson.tags || []).map(String);
    if (tags.some((t) => /do[_ -]?not[_ -]?contact|dnc|unsubscribe/i.test(t))) {
      reasons.push('allo_dnc');
    }
  }

  if (suppression) reasons.push('global_suppression');

  if (campaignLead) {
    const status = String(campaignLead.status || '').toUpperCase();
    const category = String(campaignLead.category || '').toLowerCase();
    if (/unsub/.test(status) || /unsub/.test(category)) reasons.push('smartlead_unsubscribed');
    if (/dnc|do not contact/.test(category)) reasons.push('smartlead_dnc');
    if (campaignLead.replied || /replied|interested/.test(category)) reasons.push('replied_to_campaign');
  }

  if (campaignReplied) reasons.push('replied_to_campaign');

  const unique = [...new Set(reasons)];
  if (unique.includes('three_unanswered_attempts')) {
    return { skip: true, pause: true, reasons: unique };
  }
  if (unique.length) return { skip: true, pause: false, reasons: unique };
  return { skip: false, pause: false, reasons: [] };
}

export function contactKey(caller, client, email) {
  return `${caller}::${client}::${String(email || '').trim().toLowerCase()}`;
}
