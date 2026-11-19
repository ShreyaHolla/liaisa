# Liaisa — Technical Architecture

| | |
|---|---|
| Status | v1 for the 20 November 2026 build |
| Related | `PRD.md` (what to build), `Rules.md` (budget and build discipline), `Idea.md` (why) |

> **Scope (18 Nov):** the business owner already has a website on their own domain; Liaisa does **not** build it. The owner's site links to Liaisa with a "Get a quote" button. Liaisa covers customer interaction (enquiry agent, quotes, approval, email/WhatsApp, follow-ups) and **Client Finder**. Liaisa itself still runs as a live app on its own domain (e.g. `liaisa.co.in`) on GoDaddy Node.js Hosting, with HTTPS, a mailbox and a contact form. See `PRD.md` §0.

> **For Claude Code:** this is how to build what `PRD.md` describes. Follow the folder layout, module boundaries and patterns here. Anything marked `[ verify ]` depends on GoDaddy specifics; check before building on it, don't assume.

---

## 1. Architecture principles

| # | Principle | What it means in code |
|---|---|---|
| P1 | **AI only where language is needed** | Claude interprets enquiries and rate cards. Everything else (prices, status, email, scheduling) is deterministic code. |
| P2 | **The server is the source of truth** | Claude's output is validated against a schema and the price is recalculated on the server. Model-written numbers are never stored as fact. |
| P3 | **A person approves before anything leaves** | No estimate, email or WhatsApp link reaches a customer without an owner approval record. |
| P4 | **Save before send** | Every enquiry and estimate is in MySQL before any email goes out. A failure never loses a lead. |
| P5 | **Secrets live only on the server** | API keys and passwords come from environment variables: never in the repo, browser, logs or prompts. |
| P6 | **Mock first, real AI last** | Every AI path has a mock. Real Claude calls only in the eval run, rehearsals and the demo. |
| P7 | **Boring, small and deployable** | One Node.js process, one database, server-rendered pages, no build step. Nothing the team can't debug at 2 a.m. on 19 November. |

---

## 2. System context

```mermaid
flowchart LR
    Customer(["Customer<br/>browser / phone"])
    Owner(["Owner<br/>dashboard"])
    Judge(["Judges"])

    subgraph GoDaddy["GoDaddy"]
        DNS["Domain + DNS"]
        Host["Node.js Hosting<br/>(HTTPS)"]
        DB[("Managed MySQL")]
        Mail["Mailbox<br/>hello@domain"]
    end

    Claude["Claude API<br/>(Anthropic)"]
    WA["WhatsApp<br/>(wa.me click-to-chat)"]

    Site["Owner's existing website<br/>(not built by Liaisa)"]
    Customer --> Site -->|"Get a quote" link| DNS
    Customer -->|"brief page /for/slug"| DNS
    DNS --> Host
    Owner -->|HTTPS| DNS
    Judge -->|HTTPS| DNS
    Host --> DB
    Host -->|SMTP| Mail
    Mail -->|estimate + follow-up emails| Customer
    Host -->|HTTPS, server-side key| Claude
    Owner -->|one tap, owner sends| WA --> Customer
```

**External dependencies and what happens when each fails**

| Dependency | Used for | If it fails |
|---|---|---|
| Claude API | Enquiry agent, rate-card conversion | Fallback structured form (F10); owner still gets the enquiry |
| SMTP (GoDaddy mailbox) | Estimates, follow-ups, contact form, owner notices | Saved with `failed` status; **Retry** on the dashboard; WhatsApp button still works |
| MySQL | Everything persistent | App returns a friendly error page; `/healthz` reports `db: false` |
| WhatsApp | Owner-sent messages | Nothing breaks; it's only a link the owner opens |

---

## 3. Deployment architecture

```mermaid
flowchart TB
    Dev["Developer laptop<br/>Claude Code + Node"] -->|git push| GH["GitHub repo<br/>(no secrets)"]
    GH -->|GitHub Actions: tests with AI_MODE=mock| CI["CI (free, no Claude cost)"]
    Dev -->|gddy CLI deploy| Host

    subgraph GD["GoDaddy"]
        DNSR["DNS: A/CNAME → hosting<br/>MX, SPF, DKIM, DMARC → mailbox"]
        Host["Node.js Hosting<br/>app process + env vars + TLS"]
        MySQL[("Managed MySQL")]
        MB["Mailbox (SMTP/IMAP)"]
    end

    Internet(("Internet")) -->|https://domain| DNSR --> Host
    Host --> MySQL
    Host --> MB
    Host -->|HTTPS| Anthropic["api.anthropic.com"]
```

### 3.1 Environments
| Env | Where | Database | AI | Email |
|---|---|---|---|---|
| `development` | Laptop | Local MySQL (Docker or native) | `AI_MODE=mock` | Fake transport (logs the email) |
| `test` | Laptop + CI | Test DB, reset per run | `mock` | Fake transport |
| `production` | GoDaddy Node.js Hosting | GoDaddy MySQL | `live`, testing key until rehearsals, then finale key | GoDaddy SMTP |

No staging environment: there isn't time. Instead: mocks + the eval run locally, then deploy to production behind owner login.

### 3.2 Runtime
- **One Node.js process** (current LTS supported by the host `[ verify version ]`), started with `node src/server.js`, listening on `process.env.PORT`.
- The host terminates TLS `[ verify ]`; the app also forces `https` redirects and sets `trust proxy` so rate limiting sees real client IPs.
- **Scheduler:** in-process interval (every 5 min). Shared hosts may put idle apps to sleep `[ verify ]`, so the follow-up runner is also triggered by `POST /owner/followups/run` and on every owner dashboard load (cheap, idempotent).

### 3.3 DNS records (set on 18 Nov; propagation takes time)
| Record | Purpose |
|---|---|
| `A` / `CNAME` for `@` and `www` | Point the domain at Node.js Hosting |
| `MX` | Deliver mail to the GoDaddy mailbox |
| `SPF` (TXT) | Authorise GoDaddy to send as our domain |
| `DKIM` | Sign outgoing mail. **Without it, estimate emails are likely to land in spam.** |
| `DMARC` (TXT) | Start with `p=none` so we can monitor |

GoDaddy usually adds mailbox records automatically when the mailbox is created `[ verify each one exists ]`.

### 3.4 GoDaddy setup (from the kickoff slides, 13 Nov)

Hosting path chosen: **Option A, Node.js Hosting**.

| Step | What to do | Notes |
|---|---|---|
| 1. Developer account | Sign up at developer.godaddy.com; install and authenticate the `gddy` CLI; run a first command (`gddy --help`, `gddy tree`) | No payment method needed |
| 2. Credit | Find the customer ID on godaddy.com (your name, top right); submit it on the registration form; **wait for confirmation before buying anything** | Credit is applied at checkout; cart must show $0 |
| 3. Hosting | Deploy a zip with the `gddy` CLI (free to start) → check the **preview URL** while logged in → go live on the **Economy** plan, **term 1 month** (not 36) → publish with the CLI | Read the Node.js app requirements guide **before** zipping |
| 4. Domain | Search with the CLI; buy `liaisa.co.in` with in-store credit; point it at the app and manage DNS with the CLI; confirm HTTPS | Done: `liaisa.co.in` bought 18 Nov |
| 5. Email | Buy **Titan Business Email, Pro Light, term 1 month**; create `hello@liaisa.co.in` with the CLI; send a test from another account; contact form sends to it | SMTP: username = full email address; if login is rejected at `smtp.titan.email`, use `smtpout.secureserver.net` |

Support: `gddy --help`, `gddy tree`; office hours 13–20 Nov, 4–5 PM IST.

### 3.5 Deploy procedure (copy into README once the commands are confirmed)

```
# 1. Check locally (free: mock AI, fake mail)
npm ci
npm test

# 2. Push to GitHub (CI repeats the tests)
git push

# 3. Build the deploy zip (script: npm run package)
#    - includes: package.json, package-lock.json, src/, prompts/, db/migrations/
#    - excludes: .env*, node_modules/ (unless the requirements guide says to include it),
#      tests/, docs/, coverage/, *.zip
#    - name: liaisa-<git short sha>.zip  (keep the last 3 locally for rollback)

# 4. Deploy to preview, check it, then publish
gddy [ deploy command from the requirements guide ] liaisa-<sha>.zip
#    open the preview URL → /healthz, home page, one enquiry (mock) …
gddy [ publish command ]

# 5. Database
npm run migrate           # against production MySQL; additive, idempotent
npm run seed              # only on a new, empty database

# 6. Smoke test on https://liaisa.co.in (TestCases.md §7 "After deploy")
```

Environment variables are set on the host (hosting settings or `gddy` CLI), never in the zip. Names: see `.env.example`.

Fill in the exact `gddy` commands here and in `CLAUDE.md` the first time they work.

### 3.6 Rollback

| Problem after publishing | Action | Time |
|---|---|---|
| App broken (500s, `/healthz` fails, pages wrong) | Re-deploy and publish the previous zip (`liaisa-<previous sha>.zip`) | ~5 min |
| Claude misbehaving or costs spiking | Set `AI_ENABLED=false` on the host (everyone gets the fallback form), then fix | ~1 min |
| Email sending broken | Nothing is lost (save-before-send). Owner uses **Send on WhatsApp**; fix SMTP; use **Retry** | — |
| Bad migration | Migrations are additive (new tables/columns only), so the previous app version still runs. Restore from backup (§6.1) only if data was damaged | ~10 min |

Rules that make rollback possible:
- Never deploy without first making a backup (§6.1).
- Never write a migration that drops or renames a column during the hackathon. Add new columns; stop using old ones.
- Keep the last 3 deploy zips locally, named by git commit.
- Don't deploy in the last 2 hours before the 20 Nov submission or the 11 Dec finale, except to roll back.

---

## 4. Application architecture

### 4.1 Layers

```mermaid
flowchart TB
    subgraph HTTP["HTTP layer (thin)"]
        R["routes/*<br/>parse → validate (zod) → call service → render"]
        M["middleware/*<br/>helmet, sessions, CSRF, rate limits, auth, errors"]
    end
    subgraph Domain["Service layer (all business logic)"]
        AG["agent"]
        PR["pricing (pure)"]
        RC["ratecard"]
        ES["estimates"]
        MS["messaging<br/>(mail, whatsapp links, templates)"]
        FU["followups"]
        CF["clientFinder"]
    end
    subgraph Adapters["Adapters (talk to the outside world)"]
        REPO["db/repos/*<br/>parameterised SQL"]
        CC["ai/claudeClient<br/>(live | mock)"]
        TX["mail/transport<br/>(smtp | fake)"]
    end
    R --> Domain
    M --> R
    Domain --> Adapters
```

**Dependency rules**
- Routes call services, never repositories or adapters directly.
- Services never import Express (`req`/`res`). They take plain objects and return plain objects or throw typed errors.
- `pricing` is **pure**: no DB, no network, no clock (the date is passed in). It's the most-tested module.
- Adapters are injected (a simple factory in `src/container.js`), so tests swap in mocks without monkey-patching.

### 4.2 Folder layout

```
liaisa/
├── src/
│   ├── server.js                 # starts HTTP + scheduler
│   ├── app.js                    # builds the Express app (testable without listening)
│   ├── container.js              # wires adapters → services by env
│   ├── config.js                 # reads + validates env with zod; fails fast on boot
│   ├── middleware/               # security.js, auth.js, csrf.js, rateLimits.js, errors.js
│   ├── routes/
│   │   ├── public.js             # Liaisa landing (/), /enquire, /contact, /healthz
│   │   ├── briefs.js             # /for/:slug (published Client Finder briefs)
│   │   ├── enquiries.js          # /api/enquiries/*
│   │   ├── contact.js            # /api/contact
│   │   ├── quote.js              # /q/:token/*
│   │   └── owner/                # dashboard.js, enquiries.js, setup.js, settings.js, followups.js, clientFinder.js
│   ├── services/
│   │   ├── agent/                # runTurn.js, tools.js, schemas.js, promptBuilder.js, guards.js
│   │   ├── pricing/              # calculateEstimate.js, schemas.js
│   │   ├── ratecard/             # convertRateCard.js
│   │   ├── estimates/            # approve.js, revise.js, decline.js
│   │   ├── messaging/            # sendEstimate.js, templates.js, whatsappLink.js, phone.js
│   │   ├── followups/            # schedule.js, runDue.js
│   │   └── clientFinder/         # generatePlan.js, generateBrief.js, publish.js, outreachLink.js
│   ├── ai/
│   │   ├── claudeClient.js       # live: @anthropic-ai/sdk, timeouts, usage → ai_calls
│   │   ├── mockClient.js         # canned responses keyed by scenario
│   │   └── cost.js               # tokens → USD from env prices
│   ├── mail/
│   │   ├── smtpTransport.js      # nodemailer
│   │   └── fakeTransport.js      # records emails in memory / logs
│   ├── db/
│   │   ├── pool.js
│   │   ├── migrate.js
│   │   ├── migrations/001_init.sql …
│   │   ├── seed.js               # demo business + approved pricing config (no Claude call)
│   │   └── repos/                # enquiries.js, estimates.js, followups.js, emails.js, aiCalls.js …
│   ├── views/                    # EJS: layouts/, pages/, partials/, owner/
│   └── public/                   # css/, js/ (small vanilla scripts), img/
├── prompts/
│   ├── enquiry-agent.md          # versioned system prompt (shown to judges)
│   └── ratecard.md
├── tests/
│   ├── unit/                     # pricing, phone, whatsappLink, templates, schemas, guards
│   ├── integration/              # routes + DB + fake mail + mock AI
│   ├── cases/                    # 10 real enquiry cases (JSON)
│   └── eval.js                   # npm run eval → live Haiku on the 10 cases, prints pass/fail + cost
├── docs/
│   ├── PROMPTS.md                # build prompts log (submission requirement)
│   └── openapi.yaml              # API contract: build routes, zod schemas and tests from it
├── .env.example                  # names only
├── .gitignore                    # .env, node_modules, coverage, *.log
├── CLAUDE.md                     # short project memory for Claude Code
├── README.md                     # setup, deploy, demo steps
└── package.json
```

### 4.3 Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js LTS, ES modules | `[ verify version on host ]` |
| Web | Express | Small, well known |
| Views | EJS (auto-escaping `<%= %>`) | No front-end build; never use unescaped `<%- %>` with user or AI data |
| Validation | zod | Env, request bodies, AI tool outputs, pricing config |
| DB driver | mysql2/promise | Parameterised queries only; no string-built SQL |
| AI | @anthropic-ai/sdk | Tool use, prompt caching, usage stats |
| Email | nodemailer | SMTP to the GoDaddy mailbox |
| Security | helmet, express-rate-limit, express-session (MySQL store), CSRF tokens, bcrypt | |
| IDs | ulid (public IDs), `crypto.randomBytes(32)` base64url (quote tokens) | |
| Logging | pino (JSON) | Redacts secrets, emails, phones |
| Tests | node:test (or vitest), supertest | |
| CI | GitHub Actions | `npm ci && npm test` with `AI_MODE=mock`: costs no credits |

---

## 5. Core flows

### 5.1 Enquiry → agent → draft estimate

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant W as routes/enquiries
    participant A as services/agent
    participant G as guards
    participant AI as ai/claudeClient
    participant P as services/pricing
    participant DB as MySQL

    C->>W: POST /api/enquiries (name, channel, contact, text)
    W->>W: zod validate, rate limit, honeypot
    W->>DB: INSERT enquiry (status=collecting)
    W->>A: runTurn(enquiryId, text)
    A->>G: AI enabled? under daily cap? under 4 requests?
    alt guard fails
        A-->>W: fallback
        W-->>C: structured form (pre-filled)
    else ok
        A->>AI: messages.create(cached system + catalogue + tools)
        AI-->>A: tool_use calculate_estimate(req)
        A->>P: calculateEstimate(approvedConfig, req, today)
        P-->>A: lineItems, total, warnings
        A->>AI: tool_result
        AI-->>A: tool_use finish_intake(status, requirements, missing…)
        A->>A: zod validate → recompute estimate on server
        A->>DB: UPDATE enquiry, INSERT estimate (draft), INSERT ai_calls
        alt status = needs_info
            A-->>W: question_to_customer
            W-->>C: one short question
        else status = ready
            A-->>W: ready
            W-->>C: "The owner will confirm your estimate shortly"
            W->>DB: queue owner notice email
        end
    end
```

### 5.2 Approval → delivery → follow-ups

```mermaid
sequenceDiagram
    autonumber
    actor O as Owner
    participant R as routes/owner
    participant E as services/estimates
    participant M as services/messaging
    participant F as services/followups
    participant DB as MySQL
    participant S as SMTP

    O->>R: POST /owner/enquiries/:id/approve (CSRF, session)
    R->>E: approve(estimateId, ownerId)
    E->>DB: estimate → approved, quote_token, valid_until (one transaction)
    E->>F: schedule(enquiryId, channel)
    F->>DB: INSERT followups (+2d, +5d, lost at +10d)
    alt channel = email
        E->>M: sendEstimate(enquiryId)
        M->>S: send from hello@domain
        S-->>M: accepted / error
        M->>DB: INSERT emails, estimate → sent | approved_send_failed
        R-->>O: "Sent by email" (or Retry)
    else channel = whatsapp
        R-->>O: show "Send on WhatsApp"
        O->>R: POST /owner/enquiries/:id/whatsapp
        R->>DB: INSERT whatsapp_shares, estimate → sent
        R-->>O: 302 → wa.me/<phone>?text=<prefilled>
    end
```

### 5.3 Follow-up runner (idempotent)

```
every 5 min, on POST /owner/followups/run, and on dashboard load:
  rows = SELECT … FROM followups WHERE status='pending' AND due_at <= NOW() LIMIT 20
  for each row:
    claimed = UPDATE followups SET status='sending' WHERE id=? AND status='pending'
    if claimed != 1: continue                       # another runner has it
    if enquiry is won/declined/paused: mark cancelled; continue
    if channel = email:    send template → status sent | failed
    if channel = whatsapp: status awaiting_owner     # appears on dashboard; owner taps to send
  once a day: email the owner a list of awaiting_owner WhatsApp reminders
```

### 5.4 Client Finder: plan → brief → publish → outreach

```mermaid
sequenceDiagram
    autonumber
    actor O as Owner
    participant R as routes/owner/clientFinder
    participant CF as services/clientFinder
    participant AI as ai/claudeClient
    participant P as services/pricing
    participant DB as MySQL

    O->>R: POST /owner/client-finder/plan (ideal client text)
    R->>CF: generatePlan(text)
    CF->>AI: client_plan tool (cached business + catalogue)
    AI-->>CF: 3–5 segments (JSON)
    CF->>CF: zod validate; reject names, emails, phones
    CF->>DB: INSERT client_plans, ai_calls
    O->>R: POST /owner/client-finder/briefs (segment)
    R->>CF: generateBrief(planId, segmentId)
    CF->>AI: business_brief tool
    AI-->>CF: headline, offer, package_requests…
    CF->>P: calculateEstimate() for each package
    CF->>DB: INSERT briefs (draft, priced packages)
    O->>R: edit + POST /owner/briefs/:id/publish
    R->>DB: briefs → published
    O->>R: POST /owner/briefs/:id/outreach (one recipient)
    R->>DB: INSERT outreach_log
    R-->>O: 302 → mailto: or wa.me link (owner sends)
```

Brief pages (`/for/:slug`) render `content_json` through an escaped template, show priced packages, and include the contact form and a "Get a quote" button. Records created there carry `source_brief_id`.

### 5.5 Enquiry lifecycle

```mermaid
stateDiagram-v2
    [*] --> collecting
    collecting --> awaiting_approval: agent ready
    collecting --> needs_owner: fallback form / cap / AI off
    collecting --> out_of_scope: not offered
    needs_owner --> awaiting_approval: estimate calculated
    awaiting_approval --> quoted: approved and sent
    awaiting_approval --> declined: owner declines
    quoted --> followed_up: reminder sent
    followed_up --> followed_up: next reminder
    quoted --> won: customer accepts
    followed_up --> won: customer accepts
    quoted --> lost: customer declines or +10 days
    followed_up --> lost: customer declines or +10 days
    won --> [*]
    lost --> [*]
    declined --> [*]
    out_of_scope --> [*]
```

A customer **question** on the quote page notifies the owner and pauses follow-ups; the status stays `quoted` / `followed_up`. Transitions are enforced in one function (`services/enquiries/transition.js`) with an allowed-transitions table; any other change throws.

---

## 6. Data architecture

Full DDL is in `PRD.md` §7.2 (enquiries, quotes, follow-ups) and §14.5 (Client Finder); both are part of the MVP.

```mermaid
erDiagram
    BUSINESS_SETTINGS ||--o{ PRICING_CONFIGS : "uses latest approved"
    PRICING_CONFIGS ||--o{ ESTIMATES : "priced with"
    ENQUIRIES ||--o{ ESTIMATES : "has versions"
    ENQUIRIES ||--o{ FOLLOWUPS : "schedules"
    ENQUIRIES ||--o{ EMAILS : "sends"
    ENQUIRIES ||--o{ WHATSAPP_SHARES : "shared via"
    ENQUIRIES ||--o{ CUSTOMER_RESPONSES : "receives"
    ENQUIRIES ||--o{ AI_CALLS : "costs"
    CONTACT_MESSAGES }o--|| BUSINESS_SETTINGS : "for"
    CLIENT_PLANS ||--o{ BRIEFS : "segments become"
    BRIEFS ||--o{ OUTREACH_LOG : "shared via"
    BRIEFS ||--o{ ENQUIRIES : "source of"
    BRIEFS ||--o{ CONTACT_MESSAGES : "source of"
```

**Data rules**
- Money is `DECIMAL(12,2)`; JavaScript does maths in integer paise and converts at the edges. No floating-point totals.
- Times are stored in UTC and shown in IST (`Asia/Kolkata`).
- JSON columns (`requirements_json`, `config_json`, `line_items_json`) are validated with the same zod schemas on write and read.
- Migrations are numbered SQL files run in order and recorded in a `schema_migrations` table. Never edit an applied migration; add a new one.
- Personal data (customer name, email, phone) lives only in `enquiries` and `contact_messages`. It's not sent to Claude and not written to logs.

### 6.1 Storage, backups and retention

**What's stored where**

| Data | Store | Notes |
|---|---|---|
| All business data (enquiries, quotes, follow-ups, briefs, AI call log) | MySQL | Single database; schema in `PRD.md` §7.2, §14.5 |
| Owner sessions | MySQL (`sessions` table via the session store) | Expire after 7 days |
| Static files (CSS, JS, fonts, images) | In the deploy zip under `src/public/` | Served with long cache headers + file-name versioning |
| Uploaded files | **None** in the MVP | Keeps hosting simple |
| Secrets | Host environment variables | Never in DB, zip or repo |

**Backups**

| What | How | When |
|---|---|---|
| Host backups | Whatever the hosting plan provides `[ verify what Economy includes ]` | Automatic |
| Our backup | `npm run backup` → `mysqldump` of production to `~/liaisa-backups/liaisa-<date>-<time>.sql.gz` on the developer's Mac (**outside the repo**) | Before every deploy and every migration; daily from 19 Nov until the finale |
| Keep | Last 7 dumps | Older ones deleted |

The dump holds customer contact details, so it never goes to GitHub, chat, email or shared drives.

**Restore**

```
1. Set AI_ENABLED=false (stop new writes from the agent) and announce downtime if needed
2. gunzip -c ~/liaisa-backups/<file>.sql.gz | mysql -h $DB_HOST -u $DB_USER -p $DB_NAME
3. npm run migrate        (brings the schema up to the deployed code)
4. Smoke test (TestCases.md §7), then AI_ENABLED=true
```
Test a restore **once** on a local database before 20 Nov, so it's known to work.

**Retention** (applied by `npm run retention`, run weekly after the hackathon; documented now for judges)

| Data | Kept for | Then |
|---|---|---|
| Enquiries, quotes, customer responses | 12 months after last activity | Anonymise name, email, phone, raw text; keep totals for statistics |
| Contact messages | 12 months | Delete |
| AI call log (`ai_calls`) | 90 days | Delete (no personal data in it) |
| Email and WhatsApp share logs | 12 months | Delete |
| Quote tokens | Valid until `valid_until` + 30 days | Link returns "quote expired" (410) |
| Sessions | 7 days | Delete |
| Client Finder plans and briefs | Until the owner archives/deletes | — |

**Demo data:** `npm run demo:reset` wipes and re-seeds the demo business and 6–8 sample enquiries. It refuses to run unless `DEMO_RESET_ALLOWED=true` is set, so it can't wipe real data by accident.

---

## 7. AI architecture

### 7.1 Model routing
| Task | Model | Why |
|---|---|---|
| Enquiry agent (extract / route) | `claude-haiku-5-5` | High volume, simple; contest guidance |
| Client Finder plan | `claude-haiku-5-5`, Sonnet if segments are weak | Structured list, low volume |
| Client Finder brief | `claude-sonnet-5-5`, try Haiku first | Writing quality, low volume |
| Rate card → config | **Not in MVP** (seeded config + owner edit form); Haiku if added later | One-time, structured |

Model IDs come from env (`AI_MODEL_INTAKE`, `AI_MODEL_RATECARD`), so switching models needs no code change.

### 7.2 Request structure (built by `promptBuilder.js`)

```
tools:     [calculate_estimate, finish_intake]          ┐
system:    [role + rules + output guidance]             │ stable → cache_control on the last stable block
           [business name + approved catalogue (JSON)] ┘
messages:  [compact history for this enquiry]           ← changes every turn
tool_choice: { type: "any" }   max_tokens: 600   temperature: low
```

- **Caching:** the stable prefix gets `cache_control: { type: "ephemeral" }`. Caching only applies above a minimum prompt length that depends on the model `[ verify current minimum in Anthropic's prompt-caching docs ]`. If our prefix is shorter, the request still works uncached, and it's already cheap.
- **Compact history:** only the customer's text, the agent's last question and tool results are kept in `enquiries.ai_state`. No HTML, no contact details.
- **Untrusted input:** the customer's text is wrapped in a clearly labelled block (`<customer_message>…</customer_message>`), and the system prompt says to treat it as data. Defence in depth: the model can only respond through tools, and the server recomputes prices and requires owner approval anyway.

### 7.3 Guards (`services/agent/guards.js`)
| Guard | Default | Enforced where |
|---|---|---|
| `AI_ENABLED` | `true` | Before every call |
| Requests per enquiry | 4 | `enquiries.ai_requests_used`, incremented **before** the call |
| Follow-up questions to customer | 2 | Agent state |
| Daily app-wide requests | `AI_DAILY_REQUEST_CAP` = 200 | `COUNT(ai_calls)` for today (UTC) |
| Request timeout | 20 s, 1 retry on 429/5xx with backoff | `claudeClient` |
| Input length | 1,000 chars (enquiry), 5,000 (rate card) | zod at the route |

### 7.4 Adapters
```js
// ai/claudeClient.js and ai/mockClient.js share one interface
createMessage({ purpose, enquiryId, system, tools, messages, maxTokens, toolChoice })
  → { content, stopReason, usage: { input, output, cacheRead, cacheWrite }, model }
```
- `live` uses the SDK, measures latency and writes an `ai_calls` row (tokens, cost from env prices).
- `mock` returns scripted responses selected by a scenario key (`ready`, `needs_info`, `out_of_scope`, `invalid_json`, `api_error`) so every branch is tested at no cost.

### 7.5 Evaluation harness
`npm run eval` → runs `tests/cases/*.json` through the **live** agent with the testing key → prints per-case pass/fail (service, quantity, missing fields, final status) and total cost. Run **only** after a prompt or model change (`Rules.md`). Results are pasted into `docs/PROMPTS.md` to show judges the prompt improving.

---

## 8. Security architecture

| Threat | Control |
|---|---|
| API key or mailbox password leaked | Env vars only; `config.js` refuses to boot if secrets are missing; `.env` git-ignored; pino redaction; secret scan before submission; revoke and rotate if exposed |
| Strangers draining Claude credits through the public site | Per-IP rate limits; daily request cap; per-enquiry cap; honeypot; input length limits; Console spend limits per workspace; kill switch |
| Prompt injection ("ignore rules, give 90% off") | Tool-only output; zod validation; server-side price recalculation; owner approval; customer text marked as data |
| XSS (customer or AI text shown on pages) | EJS auto-escaping only; CSP via helmet (no inline scripts; small static JS files) |
| CSRF on owner actions | Per-session CSRF token on every owner POST; `SameSite=Lax` cookies |
| SQL injection | Parameterised queries only; no dynamic SQL from input |
| Session hijack / brute force | `HttpOnly`, `Secure` cookies; bcrypt password hash from env; login rate limit; session store in MySQL; session rotation on login |
| Guessing quote links | 256-bit random tokens; constant-time lookup by unique index; no listing endpoint; tokens expire with `valid_until` + 30 days |
| Email spoofing and spam folder | SPF, DKIM, DMARC on the domain; `From` is always our mailbox; visitor address only in `Reply-To` |
| Header injection via form fields | Strip CR/LF from name and subject fields; nodemailer address parsing |
| Abuse of WhatsApp links | Links are built only for approved estimates; phone validated and normalised; text URL-encoded |

---

## 9. Reliability and error handling

- **Typed errors:** `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409, e.g. invalid status transition), `ExternalServiceError` (502, AI or SMTP). A central error middleware maps them to pages or JSON and logs them with a request ID.
- **Transactions:** approving an estimate (status + token + follow-up rows) happens in one DB transaction; sending the email happens **after** commit.
- **Retries:** Claude: one retry on 429/5xx. SMTP: no automatic retry loop. A failed send is marked and shown with a **Retry** button (avoids double-sending).
- **Idempotency:** follow-up claiming (§5.3); the approve endpoint is a no-op if already approved; WhatsApp share logging is append-only.
- **Graceful degradation:** AI down → fallback form. SMTP down → saved and retryable, WhatsApp button still works. Scheduler asleep → manual and dashboard-load triggers.
- **Health:** `GET /healthz` → `{ ok, db, version }` (no secrets, no counts).

---

## 10. Observability

| Signal | Where |
|---|---|
| Request logs (method, path, status, ms, request ID) | pino → host logs |
| AI calls (model, tokens, cache hits, cost, latency, ok/error) | `ai_calls` table → owner **AI usage** panel |
| Email outcomes | `emails` table → enquiry detail |
| Follow-up timeline | `followups` table → enquiry detail |
| Funnel (enquiries → quoted → won) | Dashboard counts by status |

The AI usage panel doubles as a **demo moment**: "this enquiry cost $0.00X".

---

## 11. Testing architecture

| Level | Scope | Tools | Claude cost |
|---|---|---|---|
| Unit | pricing (all rules, 100% branches), phone normalisation, WhatsApp link builder, templates, zod schemas, guards, status transitions | node:test | $0 |
| Integration | routes + test DB + fake mail + mock AI: enquiry happy path, needs_info, fallback, approve → email, approve → WhatsApp, follow-up runner, quote accept, contact form, auth + CSRF | supertest | $0 |
| Eval | 10 real cases, live Haiku | `npm run eval` | cents per run |
| Smoke (production) | `/healthz`, HTTPS, contact form → mailbox, one real enquiry end-to-end | manual checklist in README | cents |

CI runs unit + integration on every push with `AI_MODE=mock`. **The eval never runs in CI.**

---

## 12. Key decisions (mini ADRs)

| Decision | Chosen | Alternatives | Why |
|---|---|---|---|
| Front end | Server-rendered EJS | React/Next SPA | No build step, fewer moving parts on shared hosting, faster to ship in 2 days |
| Structured AI output | Tools with `tool_choice: any` + zod | Free-text JSON parsing | Reliable structure, fewer retries, matches "give Claude tools" guidance |
| Prices | Pure pricing engine called as a tool | Let Claude calculate | Correct, testable, injection-proof |
| Catalogue delivery | In cached system prompt | `get_services` tool | Saves one request per enquiry |
| DB access | mysql2 + SQL migrations | ORM (Prisma, Sequelize) | Less setup on GoDaddy MySQL; transparent queries |
| Scheduling | In-process timer + manual/dashboard triggers | External cron/queue | Works even if the host sleeps idle apps; no extra service or cost |
| WhatsApp | `wa.me` click-to-chat, owner sends | WhatsApp Cloud API | Free, no Meta approval, keeps a person in control |
| Tenancy | Single business | Multi-tenant | Out of scope; schema keeps business settings in one place so tenancy can be added later |

---

## 13. Scaling path (after the hackathon)

Not built now, but the design doesn't block it:
1. **Multi-tenant:** add `business_id` to every table and scope repos by it; one Liaisa instance serves many businesses on their own domains.
2. **Background jobs:** move follow-ups and email sending to a queue worker when volume grows.
3. **WhatsApp Cloud API:** a new `messaging` adapter behind the same interface, for automatic reminders.
4. **Batch evals:** use the Message Batches API for cheaper large evaluation runs.

---

## 14. Things to verify on day 1

Answered by the kickoff slides: hosting path (Node.js, Economy, 1-month term), deploy method (zip via `gddy` CLI, preview URL, publish), mailbox type (Titan Pro Light, 1 month) and its SMTP host and username format. See §3.4.

Still to check:
- [ ] Node.js app requirements guide: Node version, start command, `PORT`, folder layout, whether `node_modules` goes in the zip, how env vars are set
- [ ] Exact `gddy` commands for deploy, preview, publish and DNS (write them into §3.5 and `CLAUDE.md`)
- [ ] **Is a MySQL database included with the Economy plan?** If not, ask at office hours (4–5 PM IST) before building M4. Keep all SQL inside `db/repos/` so a change of database only touches that folder.
- [ ] Whether the host keeps the process running or sleeps it when idle
- [ ] What backups the Economy plan includes
- [ ] SMTP port and TLS setting for Titan (465 SSL is the usual default); send a test with a 10-line script
- [ ] SPF, DKIM and DMARC records present on `liaisa.co.in` after the mailbox is created
- [ ] Prompt-caching minimum length for Haiku 5.5, and current model prices
