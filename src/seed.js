// Startup seed (PRD §0, DESIGN §9): demo business, approved pricing config, sample enquiries.
// All in memory; it runs again on every restart. Makes no Claude call.
import { randomBytes } from 'node:crypto';
import { createEstimate } from './services/estimates/createEstimate.js';

/** PRD §7.1: illustrative demo data, not real prices. */
export const DEMO_PRICING_CONFIG = {
  currency: 'INR',
  tax_pct: 5,
  minimum_order: 5000,
  services: [
    { id: 'veg_buffet', name: 'Veg buffet', unit: 'per_person', unit_label: 'Number of guests', price: 450, min_qty: 20, max_qty: 200 },
    { id: 'nonveg_buffet', name: 'Non-veg buffet', unit: 'per_person', unit_label: 'Number of guests', price: 600, min_qty: 20, max_qty: 200 },
    { id: 'live_counter', name: 'Live dosa counter', unit: 'per_hour', unit_label: 'Hours', price: 2500, min_qty: 2 },
  ],
  addons: [
    { id: 'dessert', name: 'Dessert counter', unit: 'per_person', price: 80 },
    { id: 'staff', name: 'Serving staff', unit: 'flat', price: 3000 },
  ],
  surcharges: { weekend_pct: 10 },
  travel: {
    areas: { Koramangala: 5, Indiranagar: 8, Whitefield: 18 },
    bands: [{ max_km: 10, fee: 0 }, { max_km: 25, fee: 1500 }],
  },
  required_fields: ['service_id', 'quantity', 'event_date', 'location'],
};

/** The demo business. "Reset to demo business" on /owner/setup restores these values. */
export const DEMO_BUSINESS = {
  businessName: 'Mehfil Kitchen',
  tagline: 'Home-style catering for Bengaluru celebrations',
  currencySymbol: '₹',
  whatsappNumber: null,
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// hoursAgo = when the enquiry arrived. Phones and emails use reserved test values.
const SAMPLES = [
  {
    name: 'Priya Nair', channel: 'whatsapp', phone: '+919800000001', status: 'collecting', hoursAgo: 1,
    text: 'Hi, we are planning a housewarming for about 40 people. Veg food please. Do you do buffets?',
    req: { service_id: 'veg_buffet', quantity: 40 }, missing: ['event_date', 'location'],
    summary: 'Veg buffet for about 40 guests. Date and area still needed.',
  },
  {
    name: 'Arjun Mehta', channel: 'email', status: 'needs_owner', source: 'form', hoursAgo: 5,
    text: 'Office lunch for 15 people on 2026-12-09 in Koramangala, non-veg.',
    req: { service_id: 'nonveg_buffet', quantity: 15, event_date: '2026-12-09', location: 'Koramangala' },
    summary: 'Small order (15 guests) is below the 20-guest minimum. Needs your review.',
    estimate: true,
  },
  {
    name: 'Kavita Reddy', channel: 'email', status: 'awaiting_approval', hoursAgo: 8,
    text: "My daughter's engagement on 12 December in Indiranagar. 60 guests, veg buffet and a dessert counter.",
    req: { service_id: 'veg_buffet', quantity: 60, event_date: '2026-12-12', location: 'Indiranagar', addon_ids: ['dessert'] },
    summary: 'Veg buffet for 60 on Sat 12 Dec in Indiranagar, plus dessert counter.',
    estimate: true,
  },
  {
    name: 'Rohan Iyer', channel: 'email', status: 'quoted', hoursAgo: 30,
    text: 'Need non-veg catering for a team dinner, 80 people, 16 December, Koramangala. Serving staff too.',
    req: { service_id: 'nonveg_buffet', quantity: 80, event_date: '2026-12-16', location: 'Koramangala', addon_ids: ['staff'] },
    summary: 'Non-veg buffet for 80 on Wed 16 Dec in Koramangala, with serving staff.',
    estimate: 'sent', emailAgo: 28,
  },
  {
    name: 'Fatima Sheikh', channel: 'whatsapp', phone: '+919800000005', status: 'followed_up', hoursAgo: 96,
    text: 'Birthday party in Whitefield on 5 December, 50 guests, non-veg.',
    req: { service_id: 'nonveg_buffet', quantity: 50, event_date: '2026-12-05', location: 'Whitefield' },
    summary: 'Non-veg buffet for 50 on Sat 5 Dec in Whitefield.',
    estimate: 'sent', emailAgo: 90, followup: 'sent',
  },
  {
    name: 'Sanjay Kulkarni', channel: 'email', status: 'won', hoursAgo: 150,
    text: 'Anniversary lunch on 20 December in Indiranagar for 120 guests. Veg, with dessert and serving staff.',
    req: { service_id: 'veg_buffet', quantity: 120, event_date: '2026-12-20', location: 'Indiranagar', addon_ids: ['dessert', 'staff'] },
    summary: 'Veg buffet for 120 on Sun 20 Dec in Indiranagar, with dessert and staff.',
    estimate: 'sent', emailAgo: 146, response: { type: 'accept', message: 'Looks good, please go ahead.' },
  },
  {
    name: 'Neha Banerjee', channel: 'email', status: 'lost', hoursAgo: 280,
    text: 'Looking for non-veg catering, 30 guests, 28 November, Whitefield.',
    req: { service_id: 'nonveg_buffet', quantity: 30, event_date: '2026-11-28', location: 'Whitefield' },
    summary: 'Non-veg buffet for 30 on Sat 28 Nov in Whitefield. No reply after two reminders.',
    estimate: 'sent', emailAgo: 276, followup: 'sent',
  },
];

/**
 * Fill empty repos with the demo data. `repos` is the object built in container.js.
 * Returns counts for tests and boot logging.
 */
export function seed(repos, { now = new Date() } = {}) {
  repos.businessSettings.save({
    ...DEMO_BUSINESS,
    ownerEmail: 'owner@mehfilkitchen.example',
    followupRulesJson: { steps: [{ step: 1, afterDays: 2 }, { step: 2, afterDays: 5 }] },
    templatesJson: {},
  });
  repos.pricingConfigs.publish(DEMO_PRICING_CONFIG, now);

  for (const s of SAMPLES) {
    const at = (hoursAgo) => new Date(now.getTime() - hoursAgo * HOUR);
    const e = repos.enquiries.create(
      {
        customerName: s.name,
        customerEmail: s.channel === 'email' ? `${s.name.split(' ')[0].toLowerCase()}@example.test` : null,
        customerPhone: s.phone ?? null,
        preferredChannel: s.channel,
        rawText: s.text,
        requirementsJson: s.req,
        missingFieldsJson: s.missing ?? [],
        summaryForOwner: s.summary,
        source: s.source ?? 'ai',
        aiRequestsUsed: s.source === 'form' ? 0 : 2,
        status: s.status,
      },
      at(s.hoursAgo),
    );

    if (e.source === 'ai') {
      repos.aiCalls.create(
        {
          enquiryId: e.id, purpose: 'intake', model: 'claude-haiku-5-5',
          inputTokens: 1800, outputTokens: 320, cacheReadTokens: 1200,
          costUsd: 0.003, latencyMs: 1400, ok: true,
        },
        at(s.hoursAgo),
      );
    }

    if (s.estimate) {
      const est = createEstimate(repos, e.id, { now: at(s.hoursAgo) });
      if (s.estimate === 'sent') {
        repos.estimates.update(est.id, {
          status: 'sent',
          approvedAt: at(s.emailAgo),
          quoteToken: randomBytes(32).toString('base64url'),
          validUntil: new Date(now.getTime() + 14 * DAY).toISOString().slice(0, 10),
        });
        repos.emails.create(
          {
            enquiryId: e.id, type: 'estimate', toAddress: e.customerEmail ?? 'whatsapp-share',
            subject: 'Your estimate from Mehfil Kitchen', status: 'accepted',
          },
          at(s.emailAgo),
        );
      }
    }
    if (s.followup) {
      repos.followups.create(
        { enquiryId: e.id, step: 1, dueAt: at(s.emailAgo - 48), channel: s.channel, status: 'sent', sentAt: at(s.emailAgo - 48) },
        at(s.emailAgo),
      );
    }
    if (s.response) repos.customerResponses.create({ enquiryId: e.id, ...s.response }, at(s.emailAgo - 20));
  }

  return { enquiries: SAMPLES.length };
}
