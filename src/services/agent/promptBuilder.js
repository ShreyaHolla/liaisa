// Builds one Claude request (ARCHITECTURE §7.2). Customer name, email and phone never go in here.
import fs from 'node:fs';
import { TOOLS } from './tools.js';

const template = fs.readFileSync(new URL('../../../prompts/enquiry-agent.md', import.meta.url), 'utf8');

// Stop customer text from closing its own wrapper tag.
const wrap = (text) => `<customer_message>${text.replaceAll('</customer_message>', '[/customer_message]')}</customer_message>`;

/** Catalogue: names, units and required fields only. No prices. */
export function buildCatalogue(pricing) {
  return {
    services: pricing.services.map(({ id, name, unit, min_qty, max_qty }) => ({ id, name, unit, min_qty, max_qty })),
    addons: pricing.addons.map(({ id, name, unit }) => ({ id, name, unit })),
    areas: Object.keys(pricing.travel.areas),
    required_fields: pricing.required_fields,
  };
}

export function buildRequest({ businessName, pricing, history, known, today, turnMessages }) {
  const text = template
    .replaceAll('{{business_name}}', businessName)
    .replaceAll('{{catalogue}}', JSON.stringify(buildCatalogue(pricing)));
  const lastCustomer = history.length - 1;
  const messages = history.map((h, i) => {
    if (h.role === 'agent') return { role: 'assistant', content: h.text };
    let content = wrap(h.text);
    if (i === 0) content = `<today>${today}</today>\n${content}`;
    if (i === lastCustomer && Object.keys(known).length) content += `\n<known_so_far>${JSON.stringify(known)}</known_so_far>`;
    return { role: 'user', content };
  });
  return {
    system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages: [...messages, ...turnMessages],
    maxTokens: 600,
    toolChoice: { type: 'any' },
  };
}
