// M8-lite: Follow-up due on the dashboard, the Follow up panel, Send reminder, Mark as done.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, byName } from '../helpers/ownerApp.js';

/** Seeded app with follow-ups due straight away (the demo setting). Rohan: email, Fatima: WhatsApp + 1 reminder sent. */
async function demo(opts = {}) {
  const ctx = setupOwner(opts);
  ctx.repos.businessSettings.save({ followupAfterDays: opts.days ?? 0 });
  const o = await login(ctx.app);
  return { ...ctx, o, rohan: byName(ctx.repos, 'Rohan Iyer'), fatima: byName(ctx.repos, 'Fatima Sheikh') };
}
const reminderMails = (ctx) => ctx.mailer.sent.filter((m) => /Still planning|expires on/.test(m.subject));

test('due and not due: with the default 2 days nothing is due; at 0 the sent quotes appear above All enquiries', async () => {
  const ctx = await demo({ days: 2 });
  const quiet = await ctx.o.get('/owner');
  assert.match(quiet.text, /Follow-up due \(0\)/);
  assert.match(quiet.text, /No sent quotes are waiting for a reminder\./);

  ctx.repos.businessSettings.save({ followupAfterDays: 0 });
  const page = await ctx.o.get('/owner');
  assert.match(page.text, /Follow-up due \(2\)/);
  const section = page.text.slice(page.text.indexOf('Follow-up due'), page.text.indexOf('All enquiries'));
  assert.ok(page.text.indexOf('Follow-up due') < page.text.indexOf('All enquiries'));
  assert.ok(section.includes('Rohan Iyer') && section.includes('Fatima Sheikh'));
  assert.match(section, /Quote sent 3 d ago · 1 of 2 reminders sent/, 'Fatima’s seeded reminder counts');
  assert.match(section, /Follow up<span class="sr"> with Rohan Iyer/);
  for (const name of ['Kavita Reddy', 'Sanjay Kulkarni', 'Neha Banerjee']) assert.ok(!section.includes(name), `${name} is not due`);
});

test('the days setting is editable on /owner/setup (0 allowed, blank means 2, bad values rejected)', async () => {
  const ctx = await demo({ days: 2 });
  const body = (extra) => ({
    businessName: 'Mehfil Kitchen', tagline: '', currencySymbol: '₹', whatsappNumber: '', weekendPct: '10', taxPct: '5',
    svcId: ['veg_buffet'], svcName: ['Veg buffet'], svcPrice: ['450'], svcMin: ['20'], svcMax: ['200'], svcUnit: ['Number of guests'],
    areaName: ['Koramangala'], areaFee: ['0'], ...extra,
  });
  assert.match((await ctx.o.get('/owner/setup')).text, /Remind me to follow up after \(days\)/);
  assert.equal((await ctx.o.postForm('/owner/setup', body({ followupAfterDays: '0' }))).status, 303);
  assert.equal(ctx.repos.businessSettings.get().followupAfterDays, 0);
  assert.equal((await ctx.o.postForm('/owner/setup', body({ followupAfterDays: '' }))).status, 303);
  assert.equal(ctx.repos.businessSettings.get().followupAfterDays, 2);
  for (const bad of ['-1', '61', '1.5', 'x']) {
    const res = await ctx.o.postForm('/owner/setup', body({ followupAfterDays: bad }));
    assert.equal(res.status, 400, bad);
    assert.match(res.text, /Enter a whole number of days, 0 to 60\./);
  }
});

test('the Follow up panel shows a drafted reminder: name, service, date, quote link', async () => {
  const ctx = await demo();
  const page = await ctx.o.get(`/owner/enquiries/${ctx.rohan.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h2 id="fu-h">Follow up<\/h2>/);
  assert.match(page.text, /This is reminder 1 of 2, by email\./);
  const token = ctx.repos.estimates.listByEnquiry(ctx.rohan.id)[0].quoteToken;
  assert.match(page.text, /Hi Rohan, just checking in on your non-veg buffet quote from Mehfil Kitchen for Wed 16 Dec\./);
  assert.ok(page.text.includes(`https://liaisa.co.in/q/${token}`));
  assert.match(page.text, /Send reminder/);
  assert.match(page.text, /Mark as done/);
  // Not on a draft quote.
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  assert.ok(!(await ctx.o.get(`/owner/enquiries/${kavita.id}`)).text.includes('Follow up</h2>'));
});

test('Send reminder by email: sent through the mail service, recorded in Activity, enquiry becomes Reminder sent', async () => {
  const ctx = await demo();
  const before = ctx.mailer.sent.length;
  const res = await ctx.o.postForm(`/owner/enquiries/${ctx.rohan.id}/followup/send`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/owner/enquiries/${ctx.rohan.id}?n=reminder_sent`);
  assert.equal(ctx.mailer.sent.length, before + 1);
  const mail = ctx.mailer.sent.at(-1);
  assert.equal(mail.to, 'rohan@example.test');
  assert.equal(mail.from, '"Mehfil Kitchen via Liaisa" <hello@liaisa.co.in>');
  assert.equal(mail.subject, 'Still planning your Wed 16 Dec event?');
  const page = await ctx.o.get(res.headers.location);
  assert.match(page.text, /<p class="banner tone-done" role="status">Reminder sent<\/p>/);
  assert.match(page.text, /<li>Reminder 1 sent by email · just now<\/li>/);
  assert.match(page.text, /Reminder sent<\/span>/, 'the status label');
  assert.equal(ctx.repos.enquiries.get(ctx.rohan.id).status, 'followed_up');
  assert.equal(ctx.repos.emails.listByEnquiry(ctx.rohan.id).filter((m) => m.type === 'followup').length, 1);
});

test('at most 2 reminders per quote: the third is refused and the panel says so', async () => {
  const ctx = await demo();
  const send = () => ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/send`);
  assert.deepEqual((await send()).body, { channel: 'email', status: 'sent' });
  assert.equal((await send()).status, 200);
  const third = await send();
  assert.equal(third.status, 409);
  assert.match(third.body.error.message, /Both reminders/);
  assert.equal(reminderMails(ctx).length, 2);
  const page = await ctx.o.get(`/owner/enquiries/${ctx.rohan.id}`);
  assert.match(page.text, /Both reminders for this quote have been sent\./);
  assert.ok(!page.text.includes('>Send reminder<'));
  assert.match(page.text, /Reminder 2 sent by email/);
  assert.ok(!(await ctx.o.get('/owner')).text.match(/Follow-up due \(\d\)[\s\S]*Rohan Iyer[\s\S]*All enquiries/), 'no longer listed as due');
});

test('WhatsApp customers: the button opens wa.me with the message filled in; nothing is emailed', async () => {
  const ctx = await demo();
  const page = await ctx.o.get(`/owner/enquiries/${ctx.fatima.id}`);
  assert.match(page.text, /This is reminder 2 of 2, by WhatsApp\./);
  assert.match(page.text, /This opens WhatsApp with the message filled in\. You tap Send there\./);
  const before = ctx.mailer.sent.length;
  const res = await ctx.o.postForm(`/owner/enquiries/${ctx.fatima.id}/followup/send`);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^https:\/\/wa\.me\/919800000005\?text=Hi%20Fatima%2C/);
  const text = decodeURIComponent(res.headers.location.split('?text=')[1]);
  assert.match(text, /^Hi Fatima, just checking in on your non-veg buffet quote from Mehfil Kitchen for Sat 5 Dec\. It’s valid until /);
  assert.ok(text.includes('https://liaisa.co.in/q/'));
  assert.equal(ctx.mailer.sent.length, before);
  const share = ctx.repos.whatsappShares.listByEnquiry(ctx.fatima.id).find((s) => s.type === 'followup');
  assert.ok(share.followupId);
  const after = await ctx.o.get(`/owner/enquiries/${ctx.fatima.id}`);
  assert.match(after.text, /<li>Reminder 2 opened in WhatsApp · just now<\/li>/);
  assert.match(after.text, /<li>Reminder 1 opened in WhatsApp · /, 'the seeded first reminder is listed too');
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${ctx.fatima.id}/followup/send`)).status, 409, 'cap reached');
});

test('no reminder after the customer accepts, declines or asks a question', async () => {
  const ctx = await demo();
  const token = (e) => ctx.repos.estimates.listByEnquiry(e.id)[0].quoteToken;
  const json = { Accept: 'application/json' };
  const ann = ctx.rohan; // the customer who asks a question
  await request(ctx.app).post(`/q/${token(ann)}/question`).set(json).send({ message: 'Can you do Jain food?' });
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${ann.id}/followup/send`)).status, 409);
  const page = await ctx.o.get(`/owner/enquiries/${ann.id}`);
  assert.ok(!page.text.includes('Follow up</h2>'));
  assert.match(page.text, /Customer question/);
  assert.ok(!(await ctx.o.get('/owner')).text.match(/Follow-up due[\s\S]*Rohan Iyer[\s\S]*All enquiries/));

  await request(ctx.app).post(`/q/${token(ctx.fatima)}/accept`).set(json);
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${ctx.fatima.id}/followup/send`)).status, 409);
  assert.match((await ctx.o.get('/owner')).text, /Follow-up due \(0\)/);
  assert.equal(reminderMails(ctx).length, 0);
});

test('Mark as done hides the follow-up and the send is refused', async () => {
  const ctx = await demo();
  const res = await ctx.o.postForm(`/owner/enquiries/${ctx.rohan.id}/followup/done`);
  assert.equal(res.status, 303);
  assert.match((await ctx.o.get(res.headers.location)).text, /Marked as done\. This follow-up is hidden\./);
  assert.ok(!(await ctx.o.get(`/owner/enquiries/${ctx.rohan.id}`)).text.includes('Follow up</h2>'));
  const dash = await ctx.o.get('/owner');
  assert.match(dash.text, /Follow-up due \(1\)/);
  assert.ok(!dash.text.slice(dash.text.indexOf('Follow-up due'), dash.text.indexOf('All enquiries')).includes('Rohan'));
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/send`)).status, 409);
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/done`)).status, 200, 'idempotent');
  const draft = byName(ctx.repos, 'Kavita Reddy');
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${draft.id}/followup/done`)).status, 409);
});

test('follow-up routes need the owner session and a CSRF token', async () => {
  const ctx = await demo();
  const url = `/owner/enquiries/${ctx.rohan.id}/followup/send`;
  assert.equal((await request(ctx.app).post(url).type('form').send({})).status, 302);
  assert.equal((await request(ctx.app).post(`/owner/enquiries/${ctx.rohan.id}/followup/done`).type('form').send({})).status, 302);
  assert.equal((await request(ctx.app).post(url).set('Cookie', ctx.o.cookie).type('form').send({})).status, 403);
  assert.equal(reminderMails(ctx).length, 0);
});

test('email off: the panel says so, no send button, and the server refuses', async () => {
  const ctx = await demo({ mail: 'off' });
  const page = await ctx.o.get(`/owner/enquiries/${ctx.rohan.id}`);
  assert.match(page.text, /Email sending is switched off, so this reminder can’t be sent\./);
  assert.ok(!page.text.includes('>Send reminder<'));
  assert.match(page.text, /Mark as done/);
  const res = await ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/send`);
  assert.equal(res.status, 409);
  assert.equal(ctx.repos.followups.listByEnquiry(ctx.rohan.id).length, 0);
});

test('email failure: recorded in Activity, the quote stays due and does not count', async () => {
  const ctx = await demo({ mail: 'fail' });
  const res = await ctx.o.postForm(`/owner/enquiries/${ctx.rohan.id}/followup/send`);
  assert.equal(res.headers.location, `/owner/enquiries/${ctx.rohan.id}?n=reminder_failed`);
  const page = await ctx.o.get(res.headers.location);
  assert.match(page.text, /The reminder email didn’t send\. Try again\./);
  assert.match(page.text, /<li>Reminder email didn’t send · /);
  assert.match(page.text, /This is reminder 1 of 2/);
  assert.equal(ctx.repos.enquiries.get(ctx.rohan.id).status, 'quoted');
  ctx.mailer.fail = false;
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/send`)).body.status, 'sent');
});

test('reminders use no AI: the request count on the enquiry does not change', async () => {
  const ctx = await demo();
  const used = ctx.repos.enquiries.get(ctx.rohan.id).aiRequestsUsed;
  await ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/send`);
  await ctx.o.postJson(`/owner/enquiries/${ctx.rohan.id}/followup/send`);
  assert.equal(ctx.repos.enquiries.get(ctx.rohan.id).aiRequestsUsed, used);
  assert.equal(ctx.repos.aiCalls.listByEnquiry(ctx.rohan.id).length, 1, 'only the original intake call from the seed');
});
