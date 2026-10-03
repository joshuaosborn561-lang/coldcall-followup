/**
 * Resolve caller by Allo user and client by list prefix.
 * Prefix match: "EMCOR | Pacific" belongs to allo_list_prefix "EMCOR".
 */

export function normName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function callerFromCall(call, configs = []) {
  const user = call?.user || {};
  const id = user.id != null ? String(user.id) : '';
  const name = normName(user.name || user.full_name || '');
  for (const row of configs) {
    if (row.allo_user_id && id && String(row.allo_user_id) === id) return row.caller;
    if (row.allo_user_name && name && normName(row.allo_user_name) === name) return row.caller;
  }
  return null;
}

export function listNamesFromPerson(person) {
  const names = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    if (typeof v === 'object') {
      push(v.name || v.title || v.list_name);
      return;
    }
    names.push(String(v));
  };
  push(person?.lists);
  push(person?.list);
  push(person?.list_name);
  push(person?.listName);
  push(person?.tags);
  return names;
}

export function clientFromPerson(person, configsForCaller = []) {
  const lists = listNamesFromPerson(person);
  for (const row of configsForCaller) {
    const prefix = String(row.allo_list_prefix || '').trim();
    if (!prefix) continue;
    const hit = lists.some((name) => {
      const n = String(name).trim();
      return n === prefix || n.startsWith(`${prefix} |`) || n.startsWith(`${prefix}|`);
    });
    if (hit) return row.client;
  }
  return null;
}

export function configFor(configs, caller, client) {
  return (configs || []).find((row) => row.caller === caller && row.client === client) || null;
}
