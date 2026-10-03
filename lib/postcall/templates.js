/**
 * Merge fields for post-call templates. Nothing live-sends unless status is
 * "approved". Dry-run / seed preview may render drafts.
 */

const FIELDS = ['first_name', 'company_name', 'booking_link', 'signature'];

export function signatureBlock({ callerName, signatureCompany } = {}) {
  const name = String(callerName || '').trim();
  const company = String(signatureCompany ?? '').trim();
  if (name && company) return `${name}\n${company}`;
  if (name) return name;
  return company;
}

export function mergeTemplate(template, values = {}) {
  const subjectTpl = String(template?.subject || '');
  const bodyTpl = String(template?.body || '');
  const merged = {
    first_name: values.first_name || 'there',
    company_name: values.company_name || 'your team',
    booking_link: values.booking_link || '',
    signature: values.signature || '',
  };
  const replace = (text) =>
    FIELDS.reduce((out, key) => out.replaceAll(`{{${key}}}`, merged[key]), text);
  return { subject: replace(subjectTpl), body: replace(bodyTpl) };
}

export function newThreadSubject(templateSubject) {
  const inner = String(templateSubject || '').replace(/^per my voicemail:\s*/i, '').trim();
  return `Per my voicemail: ${inner}`;
}

export function ensureVoicemailOpen(body) {
  const text = String(body || '').trim();
  if (/^per my voicemail/i.test(text)) return text;
  return `Per my voicemail...\n\n${text}`;
}

export function templateSendable(template, { allowDraft = false } = {}) {
  if (!template) return { ok: false, reason: 'template_missing' };
  if (template.status === 'approved') return { ok: true };
  if (allowDraft && template.status === 'draft') return { ok: true, draft: true };
  return { ok: false, reason: 'template_not_approved' };
}
