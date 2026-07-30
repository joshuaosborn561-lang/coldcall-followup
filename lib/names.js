/**
 * First/last name normalization for the Smartlead merge fields.
 *
 * Two problems to solve before {{first_name}} is safe to put in a subject line:
 *
 * 1. Allo's Contact has `name` and `last_name`, but contacts imported from a
 *    dialer list or a CSV routinely have the WHOLE name sitting in `name` with
 *    `last_name` empty. Passing that straight through renders "Hi John Doe,".
 *
 * 2. Raw CRM names carry titles, credentials, suffixes, parenthetical
 *    nicknames and shouting ("Dr. ANTHONY (Tony) Rossi Jr.").
 *
 * The cleaning rules are a port of SalesGlider's established
 * normalize_names_and_cities.py, deliberately kept faithful to it -- including
 * the narrow nickname map. Formal given names are NOT converted to nicknames
 * (James stays James); only informal variants within a family collapse
 * (Jimmy -> Jim). Do not widen that map here without checking first; it grew
 * out of specific audit corrections, not a generic name database.
 */

const TITLE_PREFIX = /^(Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+/i;
const CREDENTIAL_SUFFIX = /,\s*[A-Z]{2,}$/;
const NAME_SUFFIX = /\s+(Jr|Sr|II|III|IV|V)\.?$/i;
const PAREN_NICKNAME = /\(([^)]+)\)/;

// Unicode-aware: the Python original used re.UNICODE, so \w matched accented
// letters. JavaScript's \w is ASCII-only and would turn "José" into "Jos".
const NON_NAME_CHARS = /[^\p{L}\p{N}\s()\-'.]/gu;

const NICKNAME_MAP = {
  jimmy: 'Jim',
  bobby: 'Bob',
  billy: 'Bill',
  ricky: 'Rick',
  tommy: 'Tom',
  eddie: 'Ed',
  eddy: 'Ed',
  ronnie: 'Ron',
  donnie: 'Don',
  joey: 'Joe',
};

function isInitial(word) {
  return /^[A-Za-z]\.?$/.test(word);
}

function stripJunk(str) {
  return String(str).replace(NON_NAME_CHARS, '').trim();
}

/** Capitalise only ALL CAPS or all-lowercase input; leave mixed case alone. */
function fixCasing(str) {
  if (str !== str.toUpperCase() && str !== str.toLowerCase()) return str;
  return str
    .split(/\s+/)
    .map((word) =>
      word
        .split('-')
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
        .join('-')
    )
    .join(' ');
}

/** Strip titles, credentials, suffixes and stray characters. */
function cleanNameString(raw) {
  return stripJunk(raw).replace(TITLE_PREFIX, '').replace(CREDENTIAL_SUFFIX, '').trim();
}

/**
 * Normalize a first-name value. Port of normalize_first_name() from the
 * SalesGlider script -- same rules, same order.
 */
export function normalizeFirstName(raw) {
  if (!raw || !String(raw).trim()) return '';

  let name = cleanNameString(raw);

  // A parenthetical nickname is the preferred name: "Anthony (Tony)" -> Tony.
  const match = PAREN_NICKNAME.exec(name);
  if (match) {
    const nick = match[1].trim();
    if (/^[A-Za-z' -]{1,20}$/.test(nick) && nick !== nick.toUpperCase()) {
      name = nick;
    } else {
      name = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  name = name.replace(NAME_SUFFIX, '').trim();

  let parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return String(raw).trim();

  let result;
  if (parts.length > 1 && parts.every(isInitial)) {
    // All-initials ("C J") -- leave it alone.
    result = parts.join(' ');
  } else if (parts.length > 1 && isInitial(parts[0])) {
    // Leading initial ("W. Allen") -- the real name follows.
    const real = parts.filter((p) => !isInitial(p));
    result = real.length ? real[0] : name;
  } else {
    while (parts.length > 1 && isInitial(parts[parts.length - 1])) parts = parts.slice(0, -1);
    result = parts[0];
  }

  result = fixCasing(result);

  const key = result.toLowerCase();
  if (NICKNAME_MAP[key]) result = NICKNAME_MAP[key];

  return result || String(raw).trim();
}

/** Tidy an explicit last-name value without splitting it. */
export function normalizeLastName(raw) {
  if (!raw || !String(raw).trim()) return '';
  const cleaned = cleanNameString(raw)
    .replace(NAME_SUFFIX, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? fixCasing(cleaned) : '';
}

/**
 * Everything after the first name, when `name` turned out to hold a full name.
 * Returns '' if there is no surname in there.
 */
function deriveLastName(rawName) {
  const cleaned = cleanNameString(rawName)
    .replace(/\([^)]*\)/g, ' ') // drop the nickname, keep the formal name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NAME_SUFFIX, '')
    .trim();

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return '';
  if (parts.every(isInitial)) return '';

  // Skip any leading initials, then take everything past the first real name.
  let i = 0;
  while (i < parts.length && isInitial(parts[i])) i++;
  const rest = parts.slice(i + 1).filter((p) => !isInitial(p));

  return rest.length ? fixCasing(rest.join(' ')) : '';
}

/**
 * Resolve an Allo contact into the first_name / last_name Smartlead merges on.
 *
 * `last_name` is trusted when Allo has one. When it is empty, `name` is
 * treated as possibly holding the full name and split -- which is the case
 * that would otherwise put a surname into {{first_name}}.
 */
export function splitContactName({ name, lastName } = {}) {
  const rawName = String(name ?? '').trim();
  const rawLast = String(lastName ?? '').trim();

  const firstName = normalizeFirstName(rawName);

  if (rawLast) return { firstName, lastName: normalizeLastName(rawLast) };
  return { firstName, lastName: deriveLastName(rawName) };
}
