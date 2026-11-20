// What a new business starts with at signup: two example services and two areas the owner edits on Setup.
// Illustrative placeholders, not real prices. No add-ons, no tax, no weekend surcharge until the owner sets them.
export const STARTER_PRICING = {
  currency: 'INR',
  tax_pct: 0,
  minimum_order: 0,
  services: [
    { id: 'example_service', name: 'Example service (rename me)', unit: 'per_person', unit_label: 'Number of people', price: 500, min_qty: 1, max_qty: 200 },
    { id: 'example_hourly', name: 'Example hourly service (rename me)', unit: 'per_hour', unit_label: 'Hours', price: 1000, min_qty: 1 },
  ],
  addons: [],
  surcharges: { weekend_pct: 0 },
  travel: { areas: { 'Nearby area (rename me)': { fee: 0 }, 'Farther area (rename me)': { fee: 500 } }, bands: [] },
  required_fields: ['service_id', 'quantity', 'event_date', 'location'],
};

export const starterSettings = ({ name, city, ownerEmail }) => ({
  businessName: name, tagline: '', currencySymbol: '₹', whatsappNumber: null, city,
  bulkApproveLimit: null, autoApprove: false, followupAfterDays: 2,
  onboarding: true, // shows the "Set your prices, share your link" checklist until the first save on Setup
  ownerEmail, followupRulesJson: { steps: [{ step: 1, afterDays: 2 }, { step: 2, afterDays: 5 }] }, templatesJson: {},
});
