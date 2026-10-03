/**
 * Slack alerts for unmatched configs, full inbox pools, and prospect replies.
 */

export async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

export function unmatchedAlert({ call, caller, client } = {}) {
  const who = call?.user?.name || call?.user?.id || 'unknown caller';
  const num = call?.contact_number || '';
  return [
    '*Post-call: no caller/client config match*',
    `Allo user: ${who}`,
    caller ? `Caller slug: ${caller}` : 'Caller: unmatched',
    client ? `Client slug: ${client}` : 'Client: unmatched',
    num ? `Number: ${num}` : '',
    'No email was sent.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function capAlert({ caller, client, email } = {}) {
  return `*Post-call: inbox pool at cap*\n${caller} / ${client} — queued ${email || 'a contact'} for tomorrow morning.`;
}

export function replyAlert({ caller, client, email, mention, snippet } = {}) {
  const tag = mention ? `${mention} + Josh` : `${caller} + Josh`;
  return [
    `*Post-call reply — stop automation*`,
    `Tag: ${tag}`,
    `${caller} / ${client} · ${email}`,
    snippet ? `> ${snippet}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
