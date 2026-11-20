// The platform's in-memory tables: businesses, owners and one repo set per business. Data resets on restart
// (the signup page says so). MySQL replaces this later; the method names are the contract.
import { createRepos, DEMO_SLUG } from './repos/index.js';
import { seed } from '../seed.js';
import { STARTER_PRICING, starterSettings } from '../services/setup/starter.js';

export class SignupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'email_taken' | 'business_cap'
  }
}

export const DEMO_OWNER_EMAIL = 'owner@mehfilkitchen.example';
export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

/** "Priya's Bakes & Café" -> "priyas-bakes-cafe". Never empty. */
export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'business';
}

export function createRegistry({ maxBusinesses = 50 } = {}) {
  const repoSets = new Map(); // businessId -> repos
  const owners = []; // { id, businessId, email, name, passwordHash }
  const counters = new Map();
  let nextBusinessId = 1;
  let nextOwnerId = 1;

  const seq = (name) => {
    if (!counters.has(name)) counters.set(name, { n: 0, next() { this.n += 1; return this.n; } });
    return counters.get(name);
  };
  const global = {
    aiCallsSince: (from) => [...repoSets.values()].reduce((n, r) => n + r.aiCalls.countSince(from), 0),
  };

  const slugTaken = (slug) => [...repoSets.values()].some((r) => r.business.slug === slug);
  function uniqueSlug(name) {
    const base = slugify(name);
    let slug = base;
    for (let i = 2; slugTaken(slug); i += 1) slug = `${base}-${i}`.slice(0, 48);
    return slug;
  }

  const api = {
    get size() { return repoSets.size; },
    maxBusinesses,
    seq,
    uniqueSlug,
    emailTaken: (email) => owners.some((o) => o.email === normaliseEmail(email)),
    ownerByEmail: (email) => owners.find((o) => o.email === normaliseEmail(email)) ?? null,
    ownerById: (id) => owners.find((o) => o.id === id) ?? null,
    owners: () => owners.map(({ passwordHash, ...o }) => o),
    repos: (businessId) => repoSets.get(businessId) ?? null,
    bySlug: (slug) => [...repoSets.values()].find((r) => r.business.slug === slug) ?? null,
    businesses: () => [...repoSets.values()].map((r) => r.business),

    addOwner({ businessId, email, name, passwordHash }) {
      const owner = { id: nextOwnerId, businessId, email: normaliseEmail(email), name, passwordHash };
      nextOwnerId += 1;
      owners.push(owner);
      const repos = repoSets.get(businessId);
      if (repos && !repos.business.ownerEmail) repos.business.ownerEmail = owner.email;
      return owner;
    },

    /** Register a business and its (empty) repo set. */
    addBusiness({ slug, isDemo = false, limits = null }) {
      if (repoSets.size >= maxBusinesses) throw new SignupError('business_cap', 'We are at capacity for this demo right now. Please try again later.');
      const repos = createRepos({ id: nextBusinessId, slug, isDemo, limits }, { seq, global });
      nextBusinessId += 1;
      repoSets.set(repos.business.id, repos);
      return repos;
    },

    /** Adopt a repo set built elsewhere (tests that build repos by hand) as a business. */
    adopt(repos) {
      repos.global ??= global;
      repoSets.set(repos.business.id, repos);
      nextBusinessId = Math.max(nextBusinessId, repos.business.id + 1);
      return repos;
    },

    /** The demo business with its seed data. Its owner comes from OWNER_EMAIL and the existing hash (never logged). */
    addDemo(config, { now = new Date(), repos: given = null } = {}) {
      // `given`: repos already built and seeded by the caller (tests); otherwise create and seed them here.
      let repos = given;
      if (repos) api.adopt(repos);
      else {
        repos = api.addBusiness({ slug: DEMO_SLUG, isDemo: true });
        seed(repos, { now });
      }
      if (config.ownerEnabled && config.ownerPasswordHash) {
        api.addOwner({ businessId: repos.business.id, email: config.ownerEmail ?? DEMO_OWNER_EMAIL, name: 'Owner', passwordHash: config.ownerPasswordHash });
      }
      return repos;
    },

    /**
     * Signup: a business from the starter template plus its owner, or a SignupError.
     * `passwordHash` is already hashed by the route (bcrypt cost 12).
     */
    signup({ businessName, ownerName, email, passwordHash, city }, { now = new Date() } = {}) {
      if (api.emailTaken(email)) throw new SignupError('email_taken', 'That email already has an account. Log in instead.');
      const repos = api.addBusiness({ slug: uniqueSlug(businessName) });
      repos.businessSettings.save(starterSettings({ name: businessName, city, ownerEmail: normaliseEmail(email) }));
      repos.pricingConfigs.publish(structuredClone(STARTER_PRICING), now);
      const owner = api.addOwner({ businessId: repos.business.id, email, name: ownerName, passwordHash });
      return { repos, owner };
    },
  };
  return api;
}
