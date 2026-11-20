import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createRegistry } from '../../src/db/registry.js';
import { createMockClient } from '../../src/ai/mockClient.js';
import { createContactMessageStore } from '../../src/db/repos/contactMessages.js';
import { createFakeMailer } from '../../src/mail/fakeTransport.js';
import { createEstimate } from '../../src/services/estimates/createEstimate.js';

export const PASSWORD = 'correct horse battery';
const HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only
export const MAIL_FROM = '"Mehfil Kitchen via Liaisa" <hello@liaisa.co.in>';
export const OWNER_EMAIL = 'owner@mehfilkitchen.example';

/**
 * Fresh seeded app with the owner area on. `mail`: 'fake' (default) injects a recording mailer,
 * 'fail' one that rejects every send, 'off' none (MAIL_ENABLED=false).
 */
export function setupOwner({ mail = 'fake', env = {}, steps } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test', OWNER_PASSWORD_HASH: HASH, SESSION_SECRET: 'x'.repeat(48),
    BASE_URL: 'https://liaisa.co.in', MAIL_FROM, OWNER_EMAIL,
    ...(mail === 'off' ? {} : { MAIL_ENABLED: 'true', SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' }),
    ...env,
  });
  const registry = createRegistry({ maxBusinesses: config.maxBusinesses });
  const repos = registry.addDemo(config); // seeded; shares id counters with every business added later
  const mailer = mail === 'off' ? null : createFakeMailer({ fail: mail === 'fail' });
  const ai = createMockClient(steps ? { steps } : {});
  const app = createApp(config, { contacts: createContactMessageStore(), registry, mailer, ai });
  return { app, repos, registry, mailer, config, ai };
}

export const CHEAP_HASH = bcrypt.hashSync(PASSWORD, 4);

/** Another business with its owner, made straight in the registry (the signup route itself uses bcrypt cost 12). */
export function addBusiness(registry, { name = 'Spice Route', email = 'owner@spiceroute.example', password = PASSWORD, city = 'Pune' } = {}) {
  const { repos, owner } = registry.signup({ businessName: name, ownerName: 'Test Owner', email, passwordHash: bcrypt.hashSync(password, 4), city });
  return { repos, owner, email, password };
}

const cookieOf = (res) => /liaisa\.sid=[^;]+/.exec((res.headers['set-cookie'] ?? []).join(';'))?.[0];
const csrfOf = (res) => /name="_csrf" value="([^"]+)"/.exec(res.text)?.[1];

/** Log in; returns helpers that carry the session cookie and CSRF token. */
export async function login(app, { email = OWNER_EMAIL, password = PASSWORD } = {}) {
  const page = await request(app).get('/owner/login');
  const res = await request(app).post('/owner/login').set('Cookie', cookieOf(page)).type('form')
    .send({ _csrf: csrfOf(page), email, password });
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  const cookie = cookieOf(res);
  const home = await request(app).get('/owner').set('Cookie', cookie);
  const csrf = csrfOf(home);
  const json = { Cookie: cookie, 'X-CSRF-Token': csrf, Accept: 'application/json' };
  return {
    cookie, csrf,
    get: (path) => request(app).get(path).set('Cookie', cookie),
    getJson: (path) => request(app).get(path).set(json),
    postJson: (path, body = {}) => request(app).post(path).set(json).send(body),
    postForm: (path, body = {}) => request(app).post(path).set('Cookie', cookie).type('form').send({ _csrf: csrf, ...body }),
  };
}

export const byName = (repos, name) => repos.enquiries.list().find((e) => e.customerName === name);
export const estimateOf = (repos, enquiry) => repos.estimates.listByEnquiry(enquiry.id).filter((e) => e.status !== 'superseded').at(-1);

/** A fresh awaiting_approval enquiry with a draft estimate (veg buffet, 40, Tue 15 Dec, Indiranagar). */
export function makeEnquiry(repos, { name = 'Meera Rao', channel = 'email', phone = '919845012345', email = 'meera@example.test', quantity = 40 } = {}) {
  const e = repos.enquiries.create({
    customerName: name, customerEmail: channel === 'email' ? email : (phone ? email : null),
    customerPhone: phone ?? null, preferredChannel: channel, rawText: 'Veg lunch', status: 'awaiting_approval',
    requirementsJson: { service_id: 'veg_buffet', quantity, event_date: '2026-12-15', location: 'Indiranagar' },
    missingFieldsJson: [], summaryForOwner: 'Veg buffet for 40.',
  });
  createEstimate(repos, e.id);
  return repos.enquiries.get(e.id);
}
