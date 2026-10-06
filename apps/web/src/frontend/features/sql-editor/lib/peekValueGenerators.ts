/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sample-value generators for the Data Peek row form.
 *
 * A curated faker-backed list (gender, country, state, city, address, …) loads
 * `@faker-js/faker/locale/en` on first use so the editor chunk stays light.
 * Sync fallbacks keep Generate working before the chunk arrives.
 *
 * Number fields also accept simple `=` formulas (`=10+5`, `=100*1.1`).
 */
import type { PeekField } from '@/features/sql-editor/lib/peekRowValidation';
import { loadOnce } from '@/shared/lib/loadOnce';

export type PeekGeneratorId =
  | 'string'
  | 'money'
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'gender'
  | 'country'
  | 'state'
  | 'city'
  | 'address'
  | 'street'
  | 'zipCode'
  | 'phone'
  | 'company'
  | 'jobTitle'
  | 'uuid'
  | 'url'
  | 'ipv4'
  | 'boolean'
  | 'integer'
  | 'float'
  | 'pastDate'
  | 'futureDate'
  | 'recentDate';

export const PEEK_GENERATORS: { id: PeekGeneratorId; label: string; group: string }[] = [
  { id: 'string', label: 'String', group: 'Text' },
  { id: 'email', label: 'Email', group: 'Person' },
  { id: 'firstName', label: 'First name', group: 'Person' },
  { id: 'lastName', label: 'Last name', group: 'Person' },
  { id: 'fullName', label: 'Full name', group: 'Person' },
  { id: 'gender', label: 'Gender', group: 'Person' },
  { id: 'phone', label: 'Phone', group: 'Person' },
  { id: 'jobTitle', label: 'Job title', group: 'Person' },
  { id: 'company', label: 'Company', group: 'Person' },
  { id: 'country', label: 'Country', group: 'Location' },
  { id: 'state', label: 'State', group: 'Location' },
  { id: 'city', label: 'City', group: 'Location' },
  { id: 'address', label: 'Address', group: 'Location' },
  { id: 'street', label: 'Street', group: 'Location' },
  { id: 'zipCode', label: 'Zip code', group: 'Location' },
  { id: 'money', label: 'Money', group: 'Number' },
  { id: 'integer', label: 'Integer', group: 'Number' },
  { id: 'float', label: 'Float', group: 'Number' },
  { id: 'boolean', label: 'Boolean', group: 'Other' },
  { id: 'uuid', label: 'UUID', group: 'Other' },
  { id: 'url', label: 'URL', group: 'Other' },
  { id: 'ipv4', label: 'IPv4', group: 'Other' },
  { id: 'pastDate', label: 'Past date', group: 'Date' },
  { id: 'futureDate', label: 'Future date', group: 'Date' },
  { id: 'recentDate', label: 'Recent date', group: 'Date' },
];

type FakerLike = {
  person: {
    firstName: () => string;
    lastName: () => string;
    fullName: () => string;
    gender: () => string;
    jobTitle: () => string;
  };
  internet: { email: () => string; url: () => string; ipv4: () => string };
  location: {
    country: () => string;
    state: () => string;
    city: () => string;
    streetAddress: () => string;
    street: () => string;
    zipCode: () => string;
  };
  phone: { number: () => string };
  company: { name: () => string };
  finance: { amount: (opts?: { min?: number; max?: number; dec?: number }) => string };
  string: { uuid: () => string; alphanumeric: (opts: { length: number }) => string };
  number: { int: (opts: { min: number; max: number }) => number; float: (opts: { min: number; max: number; fractionDigits?: number }) => number };
  datatype: { boolean: () => boolean };
  date: {
    past: () => Date;
    future: () => Date;
    recent: () => Date;
  };
};

// A failed fetch is retried on the next value rather than cached as "no faker".
const loadFaker = loadOnce(async () => {
  const { faker } = await import('@faker-js/faker/locale/en');
  return faker as unknown as FakerLike;
});

const FIRST_NAMES = [
  'Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Chloe', 'Lucas',
  'Iris', 'Owen', 'Nora', 'Kai', 'Ella', 'Leo', 'Ruby', 'Jude',
];
const LAST_NAMES = [
  'Nguyen', 'Patel', 'Garcia', 'Kim', 'Silva', 'Chen', 'Ali', 'Brooks',
  'Sato', 'Khan', 'Rossi', 'Murphy', 'Costa', 'Singh', 'Lopez', 'Park',
];
const WORDS = [
  'amber', 'cedar', 'delta', 'ember', 'flint', 'grove', 'harbor', 'ivory',
  'jade', 'keel', 'lotus', 'maple', 'north', 'orbit', 'pine', 'quartz',
];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Germany', 'Japan', 'Australia', 'Brazil', 'India'];
const STATES = ['California', 'Texas', 'New York', 'Washington', 'Florida', 'Ontario', 'Bavaria', 'Tokyo'];
const CITIES = ['Seattle', 'Austin', 'Toronto', 'Berlin', 'Osaka', 'Sydney', 'Recife', 'Pune'];
const STREETS = ['Oak St', 'Maple Ave', 'Cedar Rd', 'Pine Blvd', 'Harbor Way', 'Market St'];
const GENDERS = ['female', 'male', 'non-binary'];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function formatDate(d: Date, withTime: boolean): string {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  if (!withTime) return `${y}-${m}-${day}`;
  return `${y}-${m}-${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function syncFallback(
  id: PeekGeneratorId,
  field?: Pick<PeekField, 'kind' | 'maxLength' | 'scale'>
): string {
  const withTime = field?.kind === 'timestamp';
  switch (id) {
    case 'firstName':
      return pick(FIRST_NAMES);
    case 'lastName':
      return pick(LAST_NAMES);
    case 'fullName':
      return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    case 'gender':
      return pick(GENDERS);
    case 'email': {
      const local = `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}${randInt(1, 99)}`;
      return `${local}@${pick(['example.com', 'mail.test', 'foxschema.dev'])}`;
    }
    case 'money': {
      const scale = Math.min(Math.max(field?.scale ?? 2, 0), 4);
      return `${randInt(1, 9999)}.${String(randInt(0, 10 ** scale - 1)).padStart(scale, '0')}`;
    }
    case 'integer':
      return String(randInt(1, 9999));
    case 'float':
      return (randInt(1, 9999) + Math.random()).toFixed(field?.scale ?? 2);
    case 'boolean':
      return Math.random() < 0.5 ? 'true' : 'false';
    case 'country':
      return pick(COUNTRIES);
    case 'state':
      return pick(STATES);
    case 'city':
      return pick(CITIES);
    case 'street':
      return pick(STREETS);
    case 'address':
      return `${randInt(10, 9999)} ${pick(STREETS)}, ${pick(CITIES)}`;
    case 'zipCode':
      return String(randInt(10000, 99999));
    case 'phone':
      return `+1-${randInt(200, 999)}-${randInt(100, 999)}-${randInt(1000, 9999)}`;
    case 'company':
      return `${pick(WORDS)} ${pick(['Labs', 'Systems', 'Works', 'Studio'])}`;
    case 'jobTitle':
      return pick(['Engineer', 'Analyst', 'Manager', 'Designer', 'Operator']);
    case 'uuid':
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    case 'url':
      return `https://${pick(WORDS)}.example/${pick(WORDS)}`;
    case 'ipv4':
      return `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;
    case 'pastDate': {
      const d = new Date();
      d.setDate(d.getDate() - randInt(30, 800));
      return formatDate(d, withTime);
    }
    case 'futureDate': {
      const d = new Date();
      d.setDate(d.getDate() + randInt(7, 400));
      return formatDate(d, withTime);
    }
    case 'recentDate': {
      const d = new Date();
      d.setDate(d.getDate() - randInt(0, 14));
      return formatDate(d, withTime);
    }
    case 'string':
    default: {
      let out = `${pick(WORDS)}-${pick(WORDS)}-${randInt(10, 99)}`;
      if (field?.maxLength && out.length > field.maxLength) out = out.slice(0, field.maxLength);
      return out;
    }
  }
}

function fromFaker(
  faker: FakerLike,
  id: PeekGeneratorId,
  field?: Pick<PeekField, 'kind' | 'maxLength' | 'scale'>
): string {
  const withTime = field?.kind === 'timestamp';
  switch (id) {
    case 'firstName':
      return faker.person.firstName();
    case 'lastName':
      return faker.person.lastName();
    case 'fullName':
      return faker.person.fullName();
    case 'gender':
      return faker.person.gender();
    case 'email':
      return faker.internet.email();
    case 'phone':
      return faker.phone.number();
    case 'jobTitle':
      return faker.person.jobTitle();
    case 'company':
      return faker.company.name();
    case 'country':
      return faker.location.country();
    case 'state':
      return faker.location.state();
    case 'city':
      return faker.location.city();
    case 'address':
      return faker.location.streetAddress();
    case 'street':
      return faker.location.street();
    case 'zipCode':
      return faker.location.zipCode();
    case 'money': {
      const dec = Math.min(Math.max(field?.scale ?? 2, 0), 4);
      return faker.finance.amount({ min: 1, max: 9999, dec });
    }
    case 'integer':
      return String(faker.number.int({ min: 1, max: 9999 }));
    case 'float':
      return String(faker.number.float({ min: 1, max: 9999, fractionDigits: field?.scale ?? 2 }));
    case 'boolean':
      return String(faker.datatype.boolean());
    case 'uuid':
      return faker.string.uuid();
    case 'url':
      return faker.internet.url();
    case 'ipv4':
      return faker.internet.ipv4();
    case 'pastDate':
      return formatDate(faker.date.past(), withTime);
    case 'futureDate':
      return formatDate(faker.date.future(), withTime);
    case 'recentDate':
      return formatDate(faker.date.recent(), withTime);
    case 'string':
    default: {
      const len = Math.min(field?.maxLength ?? 12, 32);
      return faker.string.alphanumeric({ length: Math.max(4, len) });
    }
  }
}

/** Sync generate (fallback / tests). Prefer `generatePeekValueAsync` in UI. */
export function generatePeekValue(
  id: PeekGeneratorId,
  field?: Pick<PeekField, 'kind' | 'maxLength' | 'scale'>
): string {
  return syncFallback(id, field);
}

export async function generatePeekValueAsync(
  id: PeekGeneratorId,
  field?: Pick<PeekField, 'kind' | 'maxLength' | 'scale'>
): Promise<string> {
  const faker = await loadFaker().catch(() => null);
  if (!faker) return syncFallback(id, field);
  try {
    let out = fromFaker(faker, id, field);
    if (field?.maxLength && out.length > field.maxLength) out = out.slice(0, field.maxLength);
    return out;
  } catch {
    return syncFallback(id, field);
  }
}

export function suggestPeekGenerator(field: Pick<PeekField, 'name' | 'kind' | 'type'>): PeekGeneratorId {
  const name = field.name.toLowerCase();
  const type = field.type.toLowerCase();
  if (/e_?mail|email_address/.test(name) || type.includes('email')) return 'email';
  if (/first[_\s-]?name|given[_\s-]?name|fname|forename/.test(name)) return 'firstName';
  if (/last[_\s-]?name|sur[_\s-]?name|family[_\s-]?name|lname/.test(name)) return 'lastName';
  if (/^name$|full[_\s-]?name|display[_\s-]?name/.test(name)) return 'fullName';
  if (/gender|sex/.test(name)) return 'gender';
  if (/country/.test(name)) return 'country';
  if (/state|province|region/.test(name)) return 'state';
  if (/city|town/.test(name)) return 'city';
  if (/zip|postal|postcode/.test(name)) return 'zipCode';
  if (/street/.test(name)) return 'street';
  if (/address|addr/.test(name)) return 'address';
  if (/phone|mobile|tel/.test(name)) return 'phone';
  if (/company|org|employer/.test(name)) return 'company';
  if (/job|title|role/.test(name)) return 'jobTitle';
  if (/uuid|guid/.test(name) || type.includes('uuid')) return 'uuid';
  if (/url|website|href/.test(name)) return 'url';
  // Avoid nested optionals (`(_?v?4)?`) — security/detect-unsafe-regex rejects that shape.
  if (name === 'ip' || name.endsWith('_ip') || /ipv4|ip_v4|ip4|ip_addr/.test(name)) return 'ipv4';
  if (field.kind === 'boolean' || /bool|flag|is_|has_/.test(name)) return 'boolean';
  if (field.kind === 'date' || field.kind === 'timestamp') {
    if (/expir|due|end|until/.test(name)) return 'futureDate';
    if (/creat|insert|start|born|join/.test(name)) return 'pastDate';
    return 'recentDate';
  }
  if (
    field.kind === 'decimal' ||
    /amount|price|cost|balance|salary|wage|fee|total|money/.test(name) ||
    /money|currency|numeric|decimal|number/.test(type)
  ) {
    return 'money';
  }
  if (field.kind === 'integer') return 'integer';
  return 'string';
}

/**
 * Evaluate a simple `=` formula for number fields.
 * Only digits, `.`, `+`, `-`, `*`, `/`, and parentheses are allowed.
 * Returns null when the input is not a formula or is unsafe/invalid.
 */
export function evaluatePeekFormula(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed.startsWith('=')) return null;
  const expr = trimmed.slice(1).replace(/\s+/g, '');
  if (!expr || !/^[\d.+\-*/()]+$/.test(expr)) return null;
  if (/[+]{2}|[-]{2}|[*\/]{2}|\(\)|^\.+|\.{2,}/.test(expr)) return null;
  try {
    // Expression already restricted to a digit/operator alphabet.
    const result = Function(`"use strict"; return (${expr});`)() as unknown;
    if (typeof result !== 'number' || !Number.isFinite(result)) return null;
    // Avoid scientific notation noise for typical money/int edits.
    if (Number.isInteger(result)) return String(result);
    return String(Math.round(result * 1e8) / 1e8);
  } catch {
    return null;
  }
}

/** Apply formula on blur when present; otherwise return the raw value. */
export function resolvePeekNumberInput(raw: string): string {
  return evaluatePeekFormula(raw) ?? raw;
}
