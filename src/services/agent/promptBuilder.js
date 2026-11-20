// Builds one Claude request (ARCHITECTURE §7.2). Customer name, email and phone never go in here.
import fs from 'node:fs';
import { formatDate } from '../../util/formatDate.js';
import { unitLabel, unitNoun } from '../../util/format.js';
import { TOOLS } from './tools.js';

const template = fs.readFileSync(new URL('../../../prompts/enquiry-agent.md', import.meta.url), 'utf8');

// Stop customer text from closing its own wrapper tag.
const wrap = (text) => `<customer_message>${text.replaceAll('</customer_message>', '[/customer_message]')}</customer_message>`;

/** Catalogue: names, units and required fields only. No prices. */
export function buildCatalogue(pricing) {
  return {
    services: pricing.services.map(({ id, name, unit, unit_label, min_qty, max_qty }) => ({ id, name, unit, quantity_is: unitLabel({ unit, unit_label }), min_qty, max_qty })),
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

/** Example values for the prompt's worked examples, taken from the business's own catalogue. */
export function promptExamples(pricing) {
  const service = pricing.services[0] ?? { id: 'service', name: 'Service' };
  const area = Object.keys(pricing.travel.areas)[0] ?? 'Area';
  const typo = area.length > 3 ? `${area.slice(0, 2)}${area.slice(3)}` : area; // drops the third letter
  const names = pricing.services.slice(0, 2).map((s) => s.name.toLowerCase()).join(' or ');
  return {
    ex_service_id: service.id, ex_service_name: service.name, ex_service_names: names || service.name.toLowerCase(),
    ex_area: area, ex_area_typo: typo, ex_noun: unitNoun(service),
  };
}

export function buildRequest({ businessName, pricing, history, known, missing, questionsLeft, today, turnMessages }) {
  let text = template
    .replaceAll('{{business_name}}', businessName)
    .replaceAll('{{catalogue}}', JSON.stringify(buildCatalogue(pricing)));
  for (const [key, value] of Object.entries(promptExamples(pricing))) text = text.replaceAll(`{{${key}}}`, value);
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
