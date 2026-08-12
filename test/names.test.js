import assert from 'node:assert/strict';
import test from 'node:test';

import {
  looksLikeCompanyName,
  normalizeFirstName,
  normalizeLastName,
  splitContactName,
} from '../lib/names.js';
import { formatCallMoment } from '../lib/time.js';

const first = (name, lastName, fallbackName) =>
  splitContactName({ name, lastName, fallbackName }).firstName;
const last = (name, lastName, fallbackName) =>
  splitContactName({ name, lastName, fallbackName }).lastName;

// --- the case that would put a surname in {{first_name}} ---------------------

test('a full name crammed into Allo `name` is split, not passed through', () => {
  assert.equal(first('John Doe'), 'John');
  assert.equal(last('John Doe'), 'Doe');
});

test('an explicit last_name is trusted', () => {
  assert.equal(first('John', 'Doe'), 'John');
  assert.equal(last('John', 'Doe'), 'Doe');
});

test('name and last_name both populated still yields just the first name', () => {
  assert.equal(first('John Doe', 'Doe'), 'John');
});

test('multi-word surnames survive the split', () => {
  assert.equal(first('Maria Van Der Berg'), 'Maria');
  assert.equal(last('Maria Van Der Berg'), 'Van Der Berg');
});

test('a single name leaves last_name empty rather than inventing one', () => {
  assert.equal(first('Cher'), 'Cher');
  assert.equal(last('Cher'), '');
});

test('blank input does not throw', () => {
  assert.equal(first(''), '');
  assert.equal(first(null), '');
  assert.equal(first(undefined), '');
  assert.deepEqual(splitContactName(), { firstName: '', lastName: '' });
  assert.deepEqual(splitContactName({}), { firstName: '', lastName: '' });
});

// --- SalesGlider normalization rules ----------------------------------------

test('titles are stripped', () => {
  assert.equal(normalizeFirstName('Dr. Anthony'), 'Anthony');
  assert.equal(normalizeFirstName('Mr Robert'), 'Robert');
  assert.equal(first('Dr. Anthony Rossi'), 'Anthony');
  assert.equal(last('Dr. Anthony Rossi'), 'Rossi');
});

test('trailing credentials are stripped', () => {
  assert.equal(normalizeFirstName('Susan, CPA'), 'Susan');
  assert.equal(normalizeFirstName('Dana, PHR'), 'Dana');
});

test('parenthetical nickname is the preferred name', () => {
  assert.equal(normalizeFirstName('Anthony (Tony)'), 'Tony');
  assert.equal(first('Anthony (Tony) Rossi'), 'Tony');
  assert.equal(last('Anthony (Tony) Rossi'), 'Rossi', 'the formal name still supplies the surname');
});

test('a shouted or junk parenthetical is dropped, not used as the name', () => {
  assert.equal(normalizeFirstName('Anthony (CEO)'), 'Anthony');
  assert.equal(normalizeFirstName('Anthony (works remotely, part-time)'), 'Anthony');
});

test('generational suffixes are stripped', () => {
  assert.equal(first('Robert Smith Jr.'), 'Robert');
  assert.equal(last('Robert Smith Jr.'), 'Smith');
  assert.equal(last('William Gates III'), 'Gates');
});

test('initials follow the established rules', () => {
  assert.equal(normalizeFirstName('C J'), 'C J', 'all-initials names are left alone');
  assert.equal(normalizeFirstName('W. Allen'), 'Allen', 'leading initial drops away');
  assert.equal(normalizeFirstName('Robert A.'), 'Robert', 'trailing initial is stripped');
  assert.equal(first('W. Allen Smith'), 'Allen');
  assert.equal(last('W. Allen Smith'), 'Smith');
});

test('casing is fixed only when it is all caps or all lowercase', () => {
  assert.equal(normalizeFirstName('ANTHONY'), 'Anthony');
  assert.equal(normalizeFirstName('anthony'), 'Anthony');
  assert.equal(normalizeFirstName('McDonald'), 'McDonald', 'mixed case is left alone');
  assert.equal(normalizeFirstName('DeAngelo'), 'DeAngelo');
  assert.equal(normalizeFirstName('MARY-JANE'), 'Mary-Jane', 'hyphenated names capitalise both parts');
  assert.equal(last('JOHN SMITH'), 'Smith');
});

test('only informal nickname variants collapse, never formal given names', () => {
  assert.equal(normalizeFirstName('Jimmy'), 'Jim');
  assert.equal(normalizeFirstName('Bobby'), 'Bob');
  assert.equal(normalizeFirstName('Eddy'), 'Ed');
  // Deliberate: converting these would presume a preference the data never stated.
  assert.equal(normalizeFirstName('James'), 'James');
  assert.equal(normalizeFirstName('Robert'), 'Robert');
  assert.equal(normalizeFirstName('Michael'), 'Michael');
  assert.equal(normalizeFirstName('Charles'), 'Charles');
});

test('accented names survive (JS \\w would have truncated them)', () => {
  assert.equal(normalizeFirstName('José'), 'José');
  assert.equal(first('José García'), 'José');
  assert.equal(last('José García'), 'García');
  assert.equal(normalizeFirstName('Renée'), 'Renée');
});

test('emoji and stray characters are stripped', () => {
  assert.equal(normalizeFirstName('John 🚀'), 'John');
  assert.equal(normalizeFirstName('★Sarah'), 'Sarah');
});

test('the whole mess at once', () => {
  const { firstName, lastName } = splitContactName({ name: 'Dr. ANTHONY (Tony) Rossi Jr.' });
  assert.equal(firstName, 'Tony');
  assert.equal(lastName, 'Rossi');
});

test('normalizeLastName tidies without splitting', () => {
  assert.equal(normalizeLastName('SMITH'), 'Smith');
  assert.equal(normalizeLastName('van der Berg'), 'van der Berg');
  assert.equal(normalizeLastName('Smith Jr.'), 'Smith');
  assert.equal(normalizeLastName(''), '');
});

test('company labels are detected', () => {
  assert.equal(looksLikeCompanyName('Serna Electrical Services Llc'), true);
  assert.equal(looksLikeCompanyName('ACME Plumbing Inc.'), true);
  assert.equal(looksLikeCompanyName('John Doe'), false);
  assert.equal(looksLikeCompanyName('Anthony (Tony)'), false);
});

test('a company stuffed into Allo name does not become {{first_name}}', () => {
  assert.deepEqual(splitContactName({ name: 'Serna Electrical Services Llc' }), {
    firstName: '',
    lastName: '',
  });
});

test('call-audio person name wins when CRM name is a company', () => {
  assert.deepEqual(
    splitContactName({
      name: 'Serna Electrical Services Llc',
      fallbackName: 'Miguel Serna',
    }),
    { firstName: 'Miguel', lastName: 'Serna' }
  );
});

test('a company leaked into last_name is dropped, first name kept', () => {
  assert.deepEqual(splitContactName({ name: 'Patrick', lastName: 'Cliffhangers Construction LLC' }), {
    firstName: 'Patrick',
    lastName: '',
  });
});

// --- call date merge fields -------------------------------------------------

test('call timestamps render as readable Eastern values, not ISO strings', () => {
  const m = formatCallMoment('2026-07-30T18:23:11Z', 'America/New_York');
  assert.equal(m.date, 'July 30');
  assert.equal(m.day, 'Thursday');
  assert.equal(m.time, '2:23pm');
});

test('a late-UTC call is dated by the rep local day, not the UTC day', () => {
  // 01:30 UTC on the 31st is still 9:30pm on the 30th in ET.
  const m = formatCallMoment('2026-07-31T01:30:00Z', 'America/New_York');
  assert.equal(m.date, 'July 30');
  assert.equal(m.time, '9:30pm');
});

test('an unparseable timestamp yields blanks rather than "Invalid Date"', () => {
  assert.deepEqual(formatCallMoment(undefined), { date: '', day: '', time: '' });
  assert.deepEqual(formatCallMoment('not a date'), { date: '', day: '', time: '' });
});
