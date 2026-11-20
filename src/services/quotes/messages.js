// Words for the quote email, the WhatsApp message and the owner notices (DESIGN §4.10, §7).
// Pure functions: prices are read from the saved estimate, never computed here.
import { inr, unitNoun } from '../../util/format.js';
import { formatDate } from '../../util/formatDate.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const quoteUrl = (config, token) => `${config.baseUrl.replace(/\/$/, '')}/q/${token}`;
export const ownerUrl = (config, enquiryId) => `${config.baseUrl.replace(/\/$/, '')}/owner/enquiries/${enquiryId}`;
export const firstName = (enquiry) => enquiry.customerName.split(' ')[0];

/** One printable row per line item. */
export function describeLines(lineItems, symbol = '₹') {
  return lineItems.map((l) => {
    const qty = l.quantity !== undefined && l.unitPrice !== undefined ? `${l.quantity} × ${inr(l.unitPrice, symbol)}` : '';
    return { label: l.reason ? `${l.label} (${l.reason})` : l.label, qty, amount: inr(l.amount, symbol), kind: l.kind };
  });
}

/** 'for 40 guests on Sun 13 Dec' (the noun comes from the service's unit label), or '' when there is nothing to say. */
export function eventPhrase(pricing, requirements = {}) {
  const service = pricing.services.find((s) => s.id === requirements.service_id);
  const parts = [];
  if (service && requirements.quantity) parts.push(`for ${requirements.quantity} ${unitNoun(service)}`);
  if (requirements.event_date) parts.push(`on ${formatDate(requirements.event_date)}`);
  return parts.join(' ');
}

const renderTemplate = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/** F12 message: greeting, total, validity, quote link. Owner may override via templatesJson.whatsappQuote. */
export function whatsappText({ business, enquiry, estimate, pricing, link }) {
  const sym = business.currencySymbol ?? '₹';
  const vars = {
    customer_name: firstName(enquiry), business_name: business.businessName,
    total: inr(estimate.total, sym), valid_until: formatDate(estimate.validUntil), quote_link: link,
  };
  const custom = business.templatesJson?.whatsappQuote;
  if (typeof custom === 'string' && custom.trim()) return renderTemplate(custom, vars);
  const what = eventPhrase(pricing, enquiry.requirementsJson);
  return `Hi ${vars.customer_name}, here's your quote from ${business.businessName}${what ? ` ${what}` : ''}: ${vars.total}. `
    + `Valid until ${vars.valid_until}. View and accept: ${link}`;
}

/** Quote email: plain text and simple single-column HTML (max 600 px, inline styles). */
export function quoteEmail({ business, enquiry, estimate, link }) {
  const sym = business.currencySymbol ?? '₹';
  const rows = describeLines(estimate.lineItemsJson, sym);
  const name = firstName(enquiry);
  const valid = formatDate(estimate.validUntil);
  const note = estimate.noteForCustomer;
  const subject = `Your quote from ${business.businessName}: ${inr(estimate.total, sym)}`;

  const text = [
    `Hi ${name},`, '',
    `Here is your quote from ${business.businessName}.`, '',
    ...rows.map((r) => `${r.label}${r.qty ? `  ${r.qty}` : ''}  ${r.amount}`),
    '', `Total: ${inr(estimate.total, sym)}`, `Valid until ${valid}.`,
    ...(note ? ['', note] : []),
    '', `View and accept your quote: ${link}`, '', `${business.businessName}`,
  ].join('\n');

  const td = 'padding:6px 0;border-bottom:1px solid #dcd8e3;';
  const html = `<!doctype html><html><body style="margin:0;background:#f3f2f7;font-family:system-ui,Arial,sans-serif;color:#1e1a24;">
<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;">
<p>Hi ${esc(name)},</p>
<p>Here is your quote from ${esc(business.businessName)}.</p>
<table role="presentation" style="width:100%;border-collapse:collapse;">
${rows.map((r) => `<tr><td style="${td}">${esc(r.label)}${r.qty ? ` <span style="color:#555e6b;">${esc(r.qty)}</span>` : ''}</td><td style="${td}text-align:right;">${esc(r.amount)}</td></tr>`).join('\n')}
<tr><td style="padding:10px 0;font-weight:bold;">Total</td><td style="padding:10px 0;text-align:right;font-weight:bold;">${esc(inr(estimate.total, sym))}</td></tr>
</table>
<p style="color:#555e6b;">Valid until ${esc(valid)}.</p>
${note ? `<p>${esc(note)}</p>` : ''}
<p><a href="${esc(link)}" style="display:inline-block;background:#17735e;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">View and accept your quote</a></p>
<p style="color:#555e6b;">${esc(business.businessName)}</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Owner notice when an enquiry is ready for approval (DESIGN §4.10). `links` = signed one-tap URLs (optional). */
export function ownerReadyEmail({ config, enquiry, pricing, links = null, total = null, warnings = 0, symbol = '₹' }) {
  const service = pricing.services.find((s) => s.id === enquiry.requirementsJson?.service_id);
  const qty = enquiry.requirementsJson?.quantity;
  const subject = `New enquiry: ${firstName(enquiry)}${service ? `, ${service.name.toLowerCase()}${qty ? ` for ${qty}` : ''}` : ''}`;
  const link = ownerUrl(config, enquiry.id);
  const lines = [enquiry.summaryForOwner ?? 'A new enquiry is ready for your approval.'];
  if (total !== null) lines.push('', `Quote total: ${inr(total, symbol)} · ${warnings === 0 ? 'no warnings' : `${warnings} warning${warnings === 1 ? '' : 's'}: check before approving`}`);
  if (links) lines.push('', `Approve and send: ${links.approve}`, `Decline: ${links.decline}`, '(Each link opens a confirm page and works once, for 24 hours.)');
  lines.push('', `Review in Liaisa: ${link}`);
  return { subject, text: lines.join('\n') };
}

/** Owner notice when a customer answers a quote. */
export function ownerResponseEmail({ config, enquiry, type, message }) {
  const name = firstName(enquiry);
  const subject = type === 'accept' ? `${name} accepted your quote` : `${name} asked a question about the quote`;
  const body = type === 'question' ? `${name} wrote:\n"${message}"\n\n` : '';
  return { subject, text: `${body}Open in Liaisa: ${ownerUrl(config, enquiry.id)}` };
}
