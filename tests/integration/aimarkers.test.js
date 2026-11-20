// M13: the landing page demo, AI markers, "calculated by the server" and "Form" captions, reduced motion, contrast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { setup as agentSetup, START } from '../helpers/agentApp.js';
import { setupOwner, login, byName, estimateOf } from '../helpers/ownerApp.js';
import { scenarios } from '../../src/ai/mockClient.js';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';
import { DEMO_PRICING_CONFIG } from '../../src/seed.js';
import { signLink } from '../../src/services/quotes/oneTap.js';

const css = fs.readFileSync(new URL('../../src/public/css/app.css', import.meta.url), 'utf8');
const BADGE = /<span class="ai-badge"[^>]*><span aria-hidden="true">✦<\/span> AI<span class="sr">: written by AI\. Prices are calculated by the server and approved by the owner\.<\/span><\/span>/;
const BADGE_ALL = new RegExp(BADGE.source, 'g');
const SENTENCE = 'Written by AI. Prices are calculated by the server and approved by the owner.';
const LEGEND = '✦</span> AI = written by AI. Everything else is a form or a fixed rule.';
const count = (text, re) => (text.match(re) ?? []).length;
async function world(opts) {
  const ctx = setupOwner(opts);
  return { ...ctx, o: await login(ctx.app) };
}
const section = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

// ---- The badge itself --------------------------------------------------------------------------

test('the AI badge is a sparkle plus the word AI, never an icon alone, with an accessible label and a tooltip', async () => {
  const ctx = await world();
  const page = await request(ctx.app).get('/');
  const badge = BADGE.exec(page.text)[0];
  assert.match(badge, /title="Written by AI\. Prices are calculated by the server and approved by the owner\."/);
  assert.match(badge, /<span aria-hidden="true">✦<\/span> AI</, 'the sparkle is decoration; the text AI is always there');
  assert.match(badge, /class="sr">: written by AI/, 'screen readers get the full sentence');
  assert.match(css, /\.ai-badge \{[^}]*color: var\(--plum\)/);
});

test('no page has a sparkle without the word AI next to it', async () => {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  await ctx.o.postJson('/owner/clients/discover', { area: 'Whitefield' });
  const draft = await ctx.o.postJson('/owner/clients/draft', { type: 'customer', ref: 'e:sanjay@example.test' });
  const paths = [['/', false], ['/b/mehfil-kitchen/enquire', false], [`/b/mehfil-kitchen/q/${estimateOf(ctx.repos, rohan).quoteToken}`, false], ['/owner', true], [`/owner/enquiries/${kavita.id}`, true],
    ['/owner/clients?tab=reconnect', true], ['/owner/clients?tab=leads', true], ['/owner/clients?tab=find', true], [`/owner/clients/drafts/${draft.body.draftId}`, true], ['/owner/follow-ups', true], ['/owner/setup', true]];
  for (const [path, owner] of paths) {
    const res = owner ? await ctx.o.get(path) : await request(ctx.app).get(path);
    assert.equal(res.status, 200, path);
    const stripped = res.text.replace(BADGE_ALL, '').replace(/<p class="legend"[\s\S]*?<\/p>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
    assert.ok(!stripped.includes('✦'), `${path}: a sparkle outside a badge or the legend`);
    for (const m of res.text.matchAll(/✦<\/span>([^<]*)/g)) assert.match(m[1], /^ (?:AI|AI = written by AI\.)/, `${path}: "${m[1]}"`);
  }
});

// ---- Where the badge goes ----------------------------------------------------------------------

test('customer screens: the assistant’s question and "What we understood" carry the AI badge; fixed forms say Form', async () => {
  const ctx = await world();
  const ask = await request(ctx.app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ name: 'Meera', channel: 'email', email: 'm@example.test', description: 'Veg lunch for 40 people please' });
  const bubble = section(ask.text, '<p class="bubble liaisa">', '</p>');
  assert.match(bubble, BADGE);
  assert.ok(!/class="bubble you"[^>]*>[^<]*<span class="who">You<\/span>[^<]*<span class="ai-badge"/.test(ask.text), 'the customer’s own words are not marked');
  assert.match(ask.text, /<span class="tag">Form<\/span> Your answer/);

  const start = await request(ctx.app).get('/b/mehfil-kitchen/enquire');
  assert.match(start.text, /<span class="tag">Form<\/span> You fill this in\. Liaisa may ask one follow-up question\./);
  assert.equal(count(start.text, BADGE_ALL), 0, 'the empty form has nothing written by AI');

  const done = agentSetup({ steps: scenarios.ready() });
  const res = await request(done.app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ ...START, name: 'Priya' });
  assert.match(res.text, /What we understood <span class="ai-badge"/);
  assert.match(res.text, BADGE);

  // A form-submitted enquiry: nothing was written by AI, so it says Form instead.
  const fb = agentSetup({ env: { AI_ENABLED: 'false' } });
  const first = await request(fb.app).post('/b/mehfil-kitchen/api/enquiries').send(START);
  const fallback = await request(fb.app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ ...START, name: 'Meera' });
  assert.match(fallback.text, /<span class="tag">Form<\/span> Fixed fields\. No AI here\./);
  const formDone = await request(fb.app).post(`/b/mehfil-kitchen/api/enquiries/${first.body.publicId}/form`).set('Accept', 'text/html').type('form')
    .send({ service_id: 'veg_buffet', quantity: '40', event_date: '2026-12-13', location: 'Koramangala' });
  assert.match(formDone.text, /What we understood <span class="tag">Form<\/span>/);
  assert.equal(count(formDone.text, BADGE_ALL), 0);
});

test('owner detail: "What Liaisa understood" and "Summary for you" are marked AI, with the caption; form enquiries say Form', async () => {
  const ctx = await world();
  const kavita = byName(ctx.repos, 'Kavita Reddy'); // source ai
  const arjun = byName(ctx.repos, 'Arjun Mehta'); // source form
  const ai = await ctx.o.get(`/owner/enquiries/${kavita.id}`);
  assert.match(ai.text, /<h2>What Liaisa understood <span class="ai-badge"/);
  const summary = section(ai.text, '<strong>Summary for you:</strong>', '</p>');
  assert.match(summary, BADGE);
  assert.ok(summary.includes(SENTENCE), 'the caption sits under the summary');
  const form = await ctx.o.get(`/owner/enquiries/${arjun.id}`);
  assert.match(form.text, /<h2>What Liaisa understood <span class="tag">Form<\/span><\/h2>/);
  assert.match(section(form.text, '<strong>Summary for you:</strong>', '</p>'), /<span class="tag">Form<\/span>/);
  assert.ok(!/Summary for you:<\/strong> <span class="ai-badge"/.test(form.text));
});

test('Client Finder: drafted messages, discovered leads and their why-fit lines are marked AI; standard messages and fixed reasons are not', async () => {
  const ctx = await world();
  await ctx.o.postJson('/owner/clients/discover', { area: 'Whitefield' });
  const find = await ctx.o.get('/owner/clients?tab=find');
  const cards = find.text.split('<li class="card">').slice(1);
  assert.equal(cards.length, 5);
  for (const card of cards) {
    assert.match(card, BADGE);
    assert.match(card, /Found and summarised by AI from a public web page\. Check the source\./);
  }
  assert.match(section(find.text, '<h2 id="found-h">', '</h2>'), BADGE);
  assert.ok(find.text.includes(SENTENCE), 'the one-line caption is on the page');

  const reconnect = await ctx.o.get('/owner/clients?tab=reconnect');
  assert.match(reconnect.text, /<span class="tag">Fixed rule<\/span> <span class="slate small">Why now:<\/span>/);
  assert.equal(count(reconnect.text, BADGE_ALL), 0, 'reasons are rules, not AI');
  const leads = await ctx.o.get('/owner/clients?tab=leads');
  assert.match(leads.text, /<span class="tag">Form<\/span> You type this in\. No AI\./);

  const d = await ctx.o.postJson('/owner/clients/draft', { type: 'customer', ref: 'e:sanjay@example.test' });
  const page = await ctx.o.get(`/owner/clients/drafts/${d.body.draftId}`);
  assert.match(page.text, /<span class="ai-badge"[\s\S]*?<\/span><\/span>\s*Written by Liaisa from the facts we hold\./);

  const plain = await world({ env: { AI_ENABLED: 'false' } });
  const d2 = await plain.o.postJson('/owner/clients/draft', { type: 'customer', ref: 'e:sanjay@example.test' });
  const std = await plain.o.get(`/owner/clients/drafts/${d2.body.draftId}`);
  assert.match(std.text, /<span class="tag">Standard message<\/span> This is the standard message\./);
  assert.equal(count(std.text, BADGE_ALL), 0, 'a template is not marked AI');
});

test('the voice briefing is labelled for what it is: read aloud from fixed fields, not written by AI', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  const briefing = section(page.text, '<div class="briefing" id="briefing" hidden>', '</div>');
  assert.match(briefing, /Read aloud by your device from the fixed fields below\. Not written by AI\./);
  assert.equal(count(briefing, BADGE_ALL), 0, 'it is built by code from the card fields, so it is not marked AI');
});

test('follow-up reminders use a fixed template and say so', async () => {
  const ctx = await world();
  ctx.repos.businessSettings.save({ followupAfterDays: 0 });
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const page = await ctx.o.get(`/owner/enquiries/${rohan.id}`);
  assert.match(page.text, /Draft message <span class="tag">Fixed template, no AI<\/span>/);
  assert.equal(count(section(page.text, 'id="fu-h"', '</section>'), BADGE_ALL), 0);
});

// ---- Calculated by the server ------------------------------------------------------------------

test('every total is captioned "Calculated by the server" and drawn in jade', async () => {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const quote = await request(ctx.app).get(`/b/mehfil-kitchen/q/${estimateOf(ctx.repos, rohan).quoteToken}`);
  assert.match(quote.text, /<\/table>\s*<p class="calc-note">Calculated by the server<\/p>/);
  const detail = await ctx.o.get(`/owner/enquiries/${kavita.id}`);
  assert.match(detail.text, /<p class="calc-note">Calculated by the server<\/p>/);
  const home = await ctx.o.get('/owner');
  assert.equal(count(home.text, /<div class="approval__total">[^<]*<span class="calc-note">Calculated by the server<\/span><\/div>/g), 2, 'a caption on each approval card');
  const link = signLink('x'.repeat(48), { businessId: ctx.repos.business.id, enquiryId: kavita.id, version: 1, action: 'approve' });
  assert.match((await request(ctx.app).get(`/a/${link}`)).text, /<p class="calc-note">Calculated by the server<\/p>/);
  assert.match(css, /\.sheet tfoot td \{ color: var\(--jade\); \}/);
  assert.match(css, /\.approval__total \{ color: var\(--jade\); \}/);
  assert.match(css, /\.calc-note \{[^}]*color: var\(--jade\)/);
});

// ---- The legend --------------------------------------------------------------------------------

test('a one-line legend on customer and owner screens', async () => {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const link = signLink('x'.repeat(48), { businessId: ctx.repos.business.id, enquiryId: kavita.id, version: 1, action: 'approve' });
  const pages = [await request(ctx.app).get('/'), await request(ctx.app).get('/signup'), await request(ctx.app).get('/owner/login'), await request(ctx.app).get('/b/mehfil-kitchen/enquire'), await request(ctx.app).get(`/b/mehfil-kitchen/q/${estimateOf(ctx.repos, rohan).quoteToken}`),
    await request(ctx.app).get(`/a/${link}`), await ctx.o.get('/owner'), await ctx.o.get('/owner/follow-ups'), await ctx.o.get('/owner/clients'), await ctx.o.get('/owner/setup'),
    await ctx.o.get(`/owner/enquiries/${kavita.id}`), await ctx.o.get('/owner/approve-clean')];
  for (const res of pages) {
    assert.equal(count(res.text, /<p class="legend" role="note">/g), 1);
    assert.ok(res.text.includes(LEGEND));
  }
});

// ---- The landing page --------------------------------------------------------------------------

test('landing: a phone plays one quote from message to "Quote sent", built from original markup with no images', async () => {
  const ctx = await world();
  const page = await request(ctx.app).get('/');
  const demo = section(page.text, '<figure class="hero-demo"', '</figure>');
  assert.match(demo, /<div class="phone" aria-hidden="true">/);
  const order = ['Veg lunch for 60 on Saturday', 'Which area is the event in?', 'Koramangala', 'Quote for Priya', '₹31,185', 'Calculated by the server', 'Approve', 'Quote sent'];
  let at = -1;
  for (const text of order) { const i = demo.indexOf(text, at + 1); assert.ok(i > at, `${text} in order`); at = i; }
  assert.match(section(demo, 'demo-msg--ai', '</p>'), BADGE, 'the assistant’s message is marked AI');
  for (const step of ['s1', 's2', 's3', 's4', 's5', 's6']) assert.ok(new RegExp(`class="[^"]*\\b${step}\\b`).test(demo), step);
  assert.match(demo, /<figcaption id="demo-cap"/);
  assert.match(demo, /data-toggle-anim="hero-demo" aria-pressed="false">Pause animation<\/button>/);
  assert.match(demo, /<p class="sr">What happens: [^<]*Liaisa, an AI assistant, asks which area[^<]*₹31,185 calculated by the server[^<]*The quote is sent\./, 'a text alternative for the animation');
  assert.ok(!/<img|<picture|<video|<canvas/.test(demo) && !/background-image/.test(css), 'the demo is original markup and CSS: no images');
  const imgs = [...page.text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 1 && imgs.every((u) => /^\/img\/liaisa-[a-z-]+\.svg\?v=[0-9a-f]{10}$/.test(u)), `only our own logo files: ${imgs}`);
  assert.ok(!/<picture|<video|<canvas/.test(page.text));
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(demo), 'no external references');
  assert.match(page.text, /<a class="btn lg" href="\/b\/mehfil-kitchen\/enquire">Try the demo enquiry<\/a>/);
  assert.match(page.text, /<a class="btn secondary lg" href="\/signup">Sign up your business<\/a>/);
  assert.match(page.text, /<a class="btn secondary lg" href="\/owner\/login">Owner login<\/a>/);
});

test('landing: the demo quote is the pricing engine’s number for that request, not an invented one', () => {
  const quote = calculateEstimate(DEMO_PRICING_CONFIG, { service_id: 'veg_buffet', quantity: 60, event_date: '2026-12-12', location: 'Koramangala' }); // a Saturday
  assert.equal(quote.total, 31185);
  assert.deepEqual(quote.warnings, []);
});

test('landing: three steps with their own small inline SVG icons, the safety strip, and no scroll-triggered fade-ins', async () => {
  const ctx = await world();
  const page = await request(ctx.app).get('/');
  const steps = section(page.text, '<ol class="steps">', '</ol>').split('<li>').slice(1);
  assert.equal(steps.length, 3);
  for (const li of steps) {
    assert.match(li, /<span class="step-icon"><svg viewBox="0 0 24 24" aria-hidden="true">/);
    assert.ok(!/<svg[^>]*(?:href|xlink)/.test(li) && !/<script|style=/.test(li));
  }
  for (const title of ['Describe your need', 'Owner approves the quote', 'Accept on your phone']) assert.ok(page.text.includes(title), title);
  const safe = section(page.text, '<div class="safe">', '</section>');
  assert.match(safe, /The server calculates the price\./);
  assert.match(safe, /The owner approves every quote\./);
  assert.match(safe, /You can see what is AI\./);
  assert.match(safe, BADGE);
  assert.ok(!/IntersectionObserver|data-reveal|fade-in|scroll-timeline|animation-timeline/.test(css + fs.readFileSync(new URL('../../src/public/js/ui.js', import.meta.url), 'utf8')), 'no fade-in-on-scroll');
});

test('landing: nothing inline, assets versioned, the same CSP', async () => {
  const ctx = await world();
  const page = await request(ctx.app).get('/');
  assert.ok(!/\sstyle="/.test(page.text));
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(page.text));
  assert.match(page.text, /href="\/css\/app\.css\?v=[0-9a-f]{10}"/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.ok(!/unsafe-inline[^;]*;[^]*script-src|script-src[^;]*unsafe-inline/.test(page.headers['content-security-policy']));
  assert.ok(!/fonts\.(?:googleapis|gstatic)/.test(page.text + css));
});

// ---- Motion ------------------------------------------------------------------------------------

test('reduced motion: every hero animation lives inside prefers-reduced-motion: no-preference, so the base state is the static final frame', () => {
  const marker = '@media (prefers-reduced-motion: no-preference) {\n  .hero-demo .s1';
  const at = css.indexOf(marker);
  assert.ok(at > 0, 'the hero animations are inside a no-preference media query');
  const outside = css.slice(0, at) + css.slice(css.indexOf('@keyframes demo-pop', at));
  assert.ok(!/animation:\s*demo-/.test(outside.replace(/@keyframes[^{]+\{[\s\S]*?\}\s*\}/g, '')), 'no animation is applied outside it');
  const baseDemo = css.slice(css.indexOf('.hero--split {'), at).replace(/\.demo-tap \{[^}]*\}/, ''); // the tap ripple is meant to be invisible at rest
  assert.ok(!/opacity:\s*0\b/.test(baseDemo), 'nothing starts hidden in the base state');
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \[data-toggle-anim\], \.js \[data-toggle-anim\] \{ display: none; \}/, 'the pause button is hidden when there is no motion');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation-duration: 0\.01ms/);
  for (let n = 1; n <= 6; n += 1) assert.match(css, new RegExp(`@keyframes demo-s${n} `), `step ${n}`);
  assert.match(css, /\.hero-demo\.is-paused \*, \.hero-demo\.is-paused \{ animation-play-state: paused !important; \}/);
});

test('the pause button is wired in the shared script and works without altering the markup contract', () => {
  const ui = fs.readFileSync(new URL('../../src/public/js/ui.js', import.meta.url), 'utf8');
  assert.match(ui, /data-toggle-anim/);
  assert.match(ui, /classList\.toggle\('is-paused'\)/);
  assert.match(ui, /Play animation/);
});

// ---- Contrast ----------------------------------------------------------------------------------

const token = (name) => {
  const hex = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?);`).exec(css)[1];
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(token(a)), lum(token(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('contrast stays WCAG AA for the new colours: AI badge, jade amounts, tags, the demo phone', () => {
  const pairs = [['plum', 'tint-progress-bg'], ['jade', 'white'], ['jade', 'cloud'], ['slate', 'white'], ['slate', 'cloud'], ['white', 'plum'], ['white', 'jade-dark'],
    ['white', 'jade'], ['tint-done-fg', 'tint-done-bg'], ['plum', 'white'], ['plum', 'cloud'], ['ink', 'white']];
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  assert.match(css, /\.ai-badge \{[^}]*background: var\(--tint-progress-bg\); color: var\(--plum\)/);
  assert.match(css, /\.demo-total \{[^}]*color: var\(--jade\)/);
});
