# Liaisa — Idea

## 1. The hackathon

**GoDaddy Inclusive Innovation Hackathon 2026 — *Unlock the Creator: A Hackathon for Women in Tech***

GoDaddy invited female developers and technologists to build the next generation of solutions for entrepreneurs, creators and small businesses. Anthropic is a sponsor.

| Item | Details |
|---|---|
| Organiser / sponsor | GoDaddy / Anthropic |
| Who can take part | Female developers and technologists |
| Platform | HackerEarth (assessment, dashboard, final submission) |
| Kickoff webinar | 13 November 2026: brief, build requirements and evaluation criteria |
| **Submission deadline** | **20 November 2026** `[ confirm exact time + time zone on HackerEarth ]` |
| Onsite finale (if selected) | **11 December 2026**: working prototypes showcased; **Top 3** selected |
| Credits | **$100 Claude credits per builder** |

### Challenge statement

> Build **agentic business solutions** leveraging **Claude and GoDaddy technologies** to help **entrepreneurs, creators and small businesses go from idea to launch**.

---

## 2. Mandatory build requirements

All of these must work on the live site. They are pass/fail, so we build them **first**.

| # | Requirement | Done when |
|---|---|---|
| R1 | **Live app on GoDaddy** | Deployed and published on GoDaddy **Node.js Hosting** |
| R2 | **Own domain** | Bought on godaddy.com, DNS points at the app, site loads over **HTTPS** |
| R3 | **Email on the domain** | A mailbox such as `hello@ourdomain.com` that **receives a test email** |
| R4 | **Working contact form** | Messages from the site reach the mailbox |
| R5 | **No password in code or repo** | Mailbox password and API keys only in environment variables / hosting secrets |

---

## 3. Evaluation criteria and how we score

| Criterion | Weight | What judges look for | How we score on it |
|---|---|---|---|
| **Impact** | 35% | Real-world potential, who benefits, whether people would use it | A solo service-business owner gets an assistant that answers enquiries, quotes consistently and follows up, so fewer leads are lost and they don't need staff. Use a believable sample business with a real-looking rate card. |
| **Demo** | 35% | Quality and functionality of the working demo; shows the impact | A tight live flow on our own domain: vague enquiry → Claude asks the right question → owner approves the estimate → email lands in the mailbox → follow-up scheduled. Plus a recorded backup video. |
| **Tech usage** | 15% | Creative, meaningful use of Claude **and** GoDaddy beyond basic integration | Claude uses **tools** (our pricing and catalogue APIs) instead of guessing; returns structured JSON; models matched to steps; prompt caching. GoDaddy provides the whole business presence: domain, hosting, mailbox, contact form, outbound email from the domain. |
| **Execution** | 15% | Code quality, design patterns, security, solid and repeatable build | Clean separation (AI layer / pricing engine / email / scheduler); secrets in env vars; rate limiting; input validation; mock-AI tests; 10 saved real test cases; documented deploy steps. |

**Impact + Demo = 70%.** Polish of the demo flow beats extra features.

---

## 4. Problem statement

Small service businesses (tutors, caterers, photographers, cleaners, repair shops, event vendors and similar) lose leads in the gap between *"a customer asks for a price"* and *"the owner replies with a quote."*

- Enquiries arrive as free text and **miss key details** (date, size, location, options), so the owner goes back and forth before they can quote.
- Owners **price by hand** from a rate card in their head or a spreadsheet, which is slow and inconsistent.
- **Follow-ups get forgotten**, so customers who received a quote and went quiet are never chased.

For one person running a business alone, this sales admin is the difference between launching and getting stuck.

---

## 5. The idea

**Liaisa is an agentic liaison between a small business and its clients: it helps a solo owner find new clients and handles every enquiry, quote and follow-up like a team would.**

The owner pastes their rate card. Claude turns it into a pricing setup that the owner approves. The business then gets a live site on its own domain with a smart enquiry page. When a customer describes what they need, a Claude agent reads it, calls our pricing tools, asks for anything missing and prepares a quote. The **owner approves with one click**, the estimate is emailed from the business's own address, and follow-ups run automatically on templates.

### Agent flow

```
Customer enquiry (free text)
        │
        ▼
Claude agent (Haiku)    approved service catalogue in the cached system prompt
        │            ── tool: calculate_estimate(req)  → our pricing engine (plain code)
        │            ── tool: finish_intake(json)      → structured result, validated by our server
        │
        ├─ missing info?  → asks one targeted question  → customer answers
        │
        ▼
Structured JSON: requirements + estimate + summary
        │
        ▼
Saved to MySQL  →  Owner reviews on dashboard  →  ✅ Approve / ✏️ Edit
        │
        ▼
Estimate emailed from hello@ourdomain.com  →  follow-up scheduled (templates, no AI)
```

### Who does what

| Responsibility | Handled by |
|---|---|
| Understand the enquiry, decide what's missing, ask for it | **Claude Haiku 5.5** (extract / route) |
| Turn the owner's rate card into a pricing config (once) | **Claude**: Haiku first, Sonnet only if needed; owner approves |
| Look up services, calculate prices | **Our APIs**, called by Claude as tools; Claude never invents a price |
| Approve before anything is sent | **The owner** (a person stays in control) |
| Status, email, scheduling, reminders | Application code + MySQL + scheduled job |

---

## 6. Features (MVP)

### Must-haves (mandatory requirements)
- **F1 Business website on our domain** over HTTPS (R1, R2)
- **F2 Contact form** → message delivered to `hello@ourdomain.com` (R3, R4)
- **F3 Secrets handling**: mailbox password, Claude API key and DB credentials in env vars only; `.env` in `.gitignore` (R5)

### Core product
- **F4 Owner setup**: business details + paste the rate card → Claude converts it to a structured pricing config → owner reviews and approves → saved and reused.
- **F5 AI enquiry agent**: customer describes the job; Claude reads the cached catalogue and uses the `calculate_estimate` and `finish_intake` tools; asks at most a couple of follow-up questions; returns structured JSON. **Max 4 API requests per enquiry**, including tool round-trips and retries.
- **F6 Validated estimates**: calculated by code from the approved config; line-item breakdown; revisions stored with a reason.
- **F7 Owner approval**: every estimate waits on the dashboard until the owner approves or edits it. Nothing is sent without a person confirming.
- **F8 Email handoff**: save enquiry → save estimate → (approval) → send from the domain mailbox → record delivery status. An email failure never loses a lead.
- **F8b Send on WhatsApp**: customers can choose WhatsApp instead of email. The owner sends the quote, and later reminders, with one tap using a prefilled WhatsApp message (click-to-chat link; no API, no cost).
- **F9 Rule-based follow-ups**: owner-approved templates; scheduled job sends due reminders; tracks due / sent / responded.
- **F10 Owner dashboard**: enquiries by status (new → awaiting approval → quoted → followed up → won / lost).
- **F11 Fallback**: if AI is off or the cap is hit, customers finish with a structured form and the owner still receives it.

### Stretch (not before 20 Nov; only if selected for the finale)
- **Client Finder (moved into the MVP on 18 Nov)**: for a new business, Claude suggests who its first clients could be and where to find them, then writes a one-page brief that's published on the owner's domain with the contact form. The owner shares it one person at a time by email or WhatsApp. No scraping, no bulk sending. Spec in `PRD.md` §14.
- Automatic WhatsApp reminders via the WhatsApp Business (Cloud) API, demoed with Meta's free test number
- Owner can ask the dashboard in plain English, e.g. "who hasn't replied this week?"
- Deeper GoDaddy use for "idea to launch" (e.g. domain suggestions or availability during owner setup) — `[ check which GoDaddy APIs / gddy CLI features are available to us ]`

### Out of scope
Payments, invoicing, calendar booking, multi-business accounts, AI-written follow-ups, long chat conversations.

---

## 7. Tech stack

| Layer | Choice |
|---|---|
| Hosting | GoDaddy Node.js Hosting (deployed via `gddy` CLI) |
| Domain + HTTPS | GoDaddy domain, DNS → app, SSL |
| Email | GoDaddy mailbox on our domain (contact form + estimates + follow-ups via SMTP) |
| Database | One managed MySQL database (GoDaddy) |
| Backend | Node.js |
| AI | Claude API: Haiku 5.5 for the enquiry agent; Sonnet 5.5 only where measured as necessary |
| Scheduling | Backend scheduled job for follow-ups |
| Repo | GitHub (no secrets committed) |

### Data stored

| Area | Why |
|---|---|
| Business settings and approved prices | Reuse the owner's rates without re-entry |
| Enquiries and requirements | Dashboard; keep what's already been collected |
| Estimates and revisions | What the customer received and why it changed |
| Approval, email and follow-up status | Who approved, when it was sent, what's due, whether the customer replied |
| AI call log (tokens, model, cost) | Measure real cost per enquiry; show efficiency to judges |

### Security patterns (Execution score)
- Secrets only in env vars / hosting config; never in code, repo, logs or the browser.
- Claude API is called **only from the server**; the key is never sent to the browser.
- Rate limiting per IP on the enquiry and contact endpoints; honeypot field against bots.
- Daily app-wide cap on Claude calls; `AI_ENABLED` kill switch.
- Input validation and length limits on all form fields; parameterised SQL queries.
- Owner dashboard behind a login.

---

## 8. Demo plan

The same script serves two purposes: the **video summary for the 20 November submission**, and the **live demo at the 11 December finale** if we're selected.

1. Open **our domain over HTTPS**: the sample business's live site.
2. Owner setup: show the approved pricing config (processed in advance).
3. Customer enquiry: a vague request → Claude asks one sharp question → customer answers.
4. Dashboard: estimate waiting with line items → owner clicks **Approve**.
5. Email arrives in the customer inbox, sent from `hello@ourdomain.com`.
6. Follow-up shown as scheduled; trigger it manually to show it working.
7. Contact form → message arrives in the mailbox.
8. Ten seconds on cost: "This enquiry cost $0.00X in Claude credits" from our AI call log.
9. Fallback: switch AI off and the form still works.

At the finale, keep the submission video ready as a backup in case of venue Wi-Fi problems.

---

## 9. Final submission checklist (HackerEarth): due **20 November 2026**

### Setup
- [ ] Developer account created and `gddy` CLI working
- [ ] Customer ID and hosting choice submitted

### Live site
- [ ] App created, deployed and published on the Node.js Hosting path; live link working
- [ ] Own domain bought and pointed at the app
- [ ] Site loads over HTTPS
- [ ] Mailbox created and test email received
- [ ] Contact form sends messages to the mailbox
- [ ] Mailbox password kept out of code and repo

### Artifacts
- [ ] GitHub repository (README with setup and deploy steps)
- [ ] Project brief: documentation
- [ ] Video summary
- [ ] Demo deck
- [ ] Build process: how we built it with GoDaddy and Claude, **including the prompts we used** (from `docs/PROMPTS.md`)
- [ ] Extra material for judges: architecture diagram, AI cost log, test cases and results
- [ ] All artifacts submitted on HackerEarth
