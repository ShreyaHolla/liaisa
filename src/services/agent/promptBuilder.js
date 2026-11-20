// Builds one Claude request (ARCHITECTURE §7.2). Customer name, email and phone never go in here.
import fs from 'node:fs';
import { formatDate } from '../../util/formatDate.js';
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

/** Compact state block for the newest customer message: what is known, what is still missing. */
function stateBlock(known, missing, questionsLeft) {
  const shown = known.event_date ? { ...known, event_date_display: formatDate(known.event_date) } : known;
  return `\n<known_so_far>${JSON.stringify(shown)}</known_so_far>\n<still_missing>${JSON.stringify(missing)}</still_missing>\n<questions_left>${questionsLeft}</questions_left>`;
}

export function buildRequest({ businessName, pricing, history, known, missing, questionsLeft, today, turnMessages }) {
  const text = template
    .replaceAll('{{business_name}}', businessName)
    .replaceAll('{{catalogue}}', JSON.stringify(buildCatalogue(pricing)));
  const lastCustomer = history.length - 1;
  const messages = history.map((h, i) => {
    if (h.role === 'agent') return { role: 'assistant', content: h.text };
    let content = wrap(h.text);
    if (i === 0) content = `<today>${today}</today>\n${content}`;
    if (i === lastCustomer && (history.length > 1 || Object.keys(known).length)) content += stateBlock(known, missing, questionsLeft);
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
