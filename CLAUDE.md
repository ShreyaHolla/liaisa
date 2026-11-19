# Liaisa — Claude Code project memory

Liaisa is an agentic liaison for small businesses: it finds new clients (Client Finder) and turns customer enquiries into owner-approved quotes with email/WhatsApp follow-ups. Built for the GoDaddy Inclusive Innovation Hackathon 2026. **Submission deadline: 20 November 2026.**

## Read before working (only the parts you need)
- `docs/PRD.md` — **what** to build. Section 0 = current scope. Section 12 = milestones.
- `docs/ARCHITECTURE.md` — **how** to build it: folder layout, module rules, flows, security.
- `docs/Rules.md` — **budget rules. Follow them in every session.**
- `docs/openapi.yaml` — **the API contract.** Request/response shapes, status codes and error format for every endpoint. Build routes, zod schemas and integration tests to match it exactly.
- `docs/DESIGN.md` — **how it looks and reads**: tokens, screens, components, exact words. Use only its tokens and vocabulary.
- `docs/TestCases.md` — **how to verify** each milestone. A milestone is done only when its *Must* tests in §5 pass; report results in the §8 format.
- `docs/Idea.md` — background only; rarely needed.

Don't read all four in full every session. Open the section relevant to the current milestone.

## Budget rules (summary of `docs/Rules.md`)
- Total Claude budget: $100. Development cap: $60. Stop and report at $20, $40, $50, $60 spent.
- Model: **Sonnet** by default; Haiku for simple edits; **Opus only with explicit approval**.
- One milestone per session. Plan in a few lines and get a yes before writing code for anything non-trivial.
- Never read `node_modules`, lock files, build output or whole logs. Search, then read only the relevant lines.
- If a fix fails twice, stop and explain instead of guessing again.
- No refactors, cleanups or features outside the current milestone.
- After each milestone: commit, and add a short entry to `docs/PROMPTS.md` (prompt, model, rough cost, outcome).

## Hard rules
- **No secrets in code or the repo.** API keys, mailbox password and DB credentials come only from env vars. `.env` stays git-ignored; update `.env.example` (names only) when adding a variable.
- **Claude API is called only from the server.** `AI_MODE=mock` by default in dev and tests; real calls only in `npm run eval`, rehearsals and the demo.
- **Never let Claude compute prices.** Prices come only from `services/pricing` (pure, unit-tested).
- **Nothing reaches a customer without owner approval** (email, WhatsApp link or published brief).
- **Ask before** anything that costs money or is hard to undo: GoDaddy purchases, DNS changes, deploys to `liaisa.co.in`, deleting data, force-pushing, sending real email to anyone except our own test addresses.

## Stack
Node.js (LTS; **use no features newer than Node 20**, host version unverified) + Express, EJS views, MySQL (`mysql2`, SQL migrations), zod, `@anthropic-ai/sdk`, nodemailer (Titan mailbox via SMTP), helmet, express-rate-limit. Hosting: GoDaddy Node.js Hosting (Economy), deployed as a zip with the `gddy` CLI. Domain: `liaisa.co.in`. Mailbox: `hello@liaisa.co.in`.

SMTP: username is the full email address. If login is rejected at `smtp.titan.email`, use `smtpout.secureserver.net`.

## Commands (fill in as they're created)
- `npm run dev` — local server, mock AI (`node --watch`)
- `npm start` — run `node src/server.js` (what the host runs)
- `npm test` — unit + integration tests (mock AI, no cost); runner is `scripts/test.js` (node:test, Node 20-safe)
- `npm run eval` — 10 real cases with live Claude (**costs credits; only after a prompt or model change**)
- `npm run migrate` / `npm run seed`
- `npm run package` — build `liaisa-<sha>.zip` for deploy (no `.env`, tests or docs)
- `npm run backup` — dump production MySQL to `~/liaisa-backups/` (outside the repo). **Run before every deploy and migration.**
- `npm run demo:reset` — re-seed demo data (only when `DEMO_RESET_ALLOWED=true`)
- Deploy: `[ gddy commands go here once confirmed ]` — see `docs/ARCHITECTURE.md` §3.4–3.6 (incl. rollback)
