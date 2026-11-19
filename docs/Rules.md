# Liaisa — Rules: Budget, Credits and Build Discipline

These rules apply to Claude (Claude Code and any Claude session) working on this project. **Follow them unless the project owner explicitly overrides one in writing.** They follow the contest's Claude usage guidelines: *match the model to the step, cache what you repeat, keep answers short, watch your spend, guard your link and key.*

## 0. Hard limits

| Budget | Hard cap | Pays for |
|---|---|---|
| Claude credits | **$100** (per builder) | Claude Code while building + Claude API calls made by the app |
| GoDaddy | **$40** | Domain, mailbox, and any hosting / database cost not covered by the hackathon |

Claude credits cannot pay for GoDaddy, and GoDaddy money cannot top up Claude credits. Separate Console workspaces still draw from the same balance — **track the total, not just per workspace.** If teammates join, each builder's credits are tracked separately in the Spend log.

**Key dates:** submission deadline **20 November 2026** `[ confirm exact time + time zone ]`; onsite finale **11 December 2026** if selected. The submission comes first: a working, deployed, documented MVP beats an ambitious unfinished one.

---

## 1. Claude credit allocation

| Bucket | Budget | Stop when total spend reaches |
|---|---|---|
| Building and debugging (Claude Code) | $60 | **$60** |
| Integration tests, the 10 real cases, rehearsals (API) | $20 | **$80** |
| Protected finale reserve | $10 | **Never touch before 11 Dec** |
| Contingency | $10 | Only with the owner's approval |
| **Total** | **$100** | |

### Checkpoints: stop, report, wait for a go-ahead
- **$20, $40, $50** spent on development
- **$60**: development budget used up; no more building without approval to use contingency
- **$80** total: only demo-critical and submission-critical work
- **$90** total: everything stops except the finale

Update the **Spend log** (§8) at every checkpoint.

---

## 2. Build order: pass/fail requirements first

The mandatory requirements (live app, domain + HTTPS, mailbox, contact form, no secrets in repo) are pass/fail. They need **almost no Claude credits** — build them first so the submission is never at risk.

1. GoDaddy developer account, `gddy` CLI, hello-world Node app deployed
2. Domain + DNS + HTTPS; mailbox; test email received
3. Contact form → mailbox (secrets in env vars)
4. Database schema; owner setup with **mock** rate-card output
5. Pricing engine (pure code, unit-tested)
6. Enquiry agent with **mock** Claude responses and tool stubs
7. Owner approval + estimate email + follow-up job
8. Dashboard
9. Switch mocks for real Claude calls; run the 10 real cases
10. Polish the demo flow; record the backup video; write submission docs

### Schedule to the 20 November deadline

| When | Items | Must be true by the end |
|---|---|---|
| **18 Nov** (rest of today) | 1–3 | Live on our domain over HTTPS; mailbox receives email; contact form works; no secrets in repo. **All pass/fail requirements met.** |
| **19 Nov** | 4–9 | Owner setup, pricing engine, enquiry agent with real Claude, approval, estimate email, follow-up job, basic dashboard; 10 real cases run once |
| **20 Nov** (morning) | 10 | Demo flow polished; video recorded; README, project brief, `docs/PROMPTS.md`, demo deck written |
| **20 Nov** (before deadline) | Submit | Every item in `Idea.md` §9 ticked and uploaded to HackerEarth, **with a buffer of several hours** |

If a day slips, cut from the **end** of the feature list (dashboard polish, then follow-ups), never the pass/fail requirements or the submission docs. Improvements for the finale come after 20 November, only if we're selected.

Impact + Demo are **70%** of the score. When choosing between an extra feature and a smoother demo, pick the demo.

---

## 3. Building with Claude Code ($60)

### Match the model to the step (contest guidance)

| Model | Use for |
|---|---|
| **Haiku 5.5** | Simple, mechanical edits: boilerplate, renaming, formatting, simple tests, doc edits |
| **Sonnet 5.5** | **Default** for most of the build: features, debugging, reviews |
| **Opus 5.5** | Only for genuinely tricky coding or long multi-step work, **with the owner's approval per task** |

### Work in small milestones
1. One milestone = one item from §2 with a clear "done" check.
2. Check usage (`/cost` or Console) **after every milestone** and log it.
3. Commit after each working milestone so nothing has to be regenerated.

### Keep context small (context is what you pay for)
4. **`/clear` between unrelated tasks**; `/compact` when a long session is still needed.
5. **Read only what's needed.** Never read `node_modules`, lock files, build output or full logs. Search, then read the relevant lines.
6. `CLAUDE.md` + `Idea.md` + this file are the project memory. Keep `CLAUDE.md` short.
7. Paste only the error message and the relevant lines, never whole logs.

### Avoid wasted work
8. **Start simple:** get one prompt working before adding more agent steps.
9. Plan first for anything beyond a small change: state the approach in a few lines, get a yes, then code.
10. No speculative refactors, "while I'm here" cleanups, or features outside `Idea.md` §6.
11. If a fix fails **twice**, stop and explain instead of guessing a third time.
12. Prefer targeted edits over regenerating whole files.
13. No large fan-outs or many subagents without approval.

### Keep a person in control
14. **Ask before anything that spends money or is hard to undo:** GoDaddy purchases, DNS changes, deploys to the live domain, deleting data, force-pushing, sending real emails to anyone except our own test addresses.

### Record the process (judges asked for it)
15. Log the **key prompts** used during the build in `docs/PROMPTS.md`: one entry per milestone with the prompt, the model, roughly what it cost, and the outcome. Keep entries short; don't log every message.
16. Keep the app's runtime prompts in versioned files (e.g. `prompts/enquiry-agent.md`) so they can be shown to judges as they are.

---

## 4. The app's runtime Claude calls ($20 testing + $10 finale)

### Where Claude is used
17. Claude is called **only** to:
    - run the enquiry agent: understand the request, call our tools, decide what's missing, return JSON;
    - convert the owner's rate card into a pricing config: **once**, then saved after the owner approves;
    - Client Finder (MVP, `PRD.md` §14): one request for a client plan and one per brief, capped at 10 requests a day.
18. Claude is **never** used for price maths, business rules, status, email, scheduling or routine reminders.

### Model
19. **Haiku 5.5 by default** (extract / route is exactly what it's for). Move a step to Sonnet only if Haiku fails our 10 real cases, and write the reason here.

### Be specific, give tools, ask for structure
20. Each system prompt states **the goal, the user, and what a good answer looks like**, with one short example.
21. Claude gets **tools** (`calculate_estimate`, `finish_intake`) and must use them for prices and results instead of guessing. The service catalogue sits in the cached system prompt, which saves a request per enquiry.
22. Responses are **JSON** matching a fixed schema; invalid JSON counts as one retry.

### Limits built into the code
23. **Max 4 API requests per enquiry**, including tool round-trips and retries. Then fall back to the structured form.
24. **`max_tokens` capped** on every request, sized to the schema. Keep answers short.
25. **Compact input:** only the relevant services and the requirements collected so far.
26. **Cache what you repeat:** use prompt caching for the system prompt, tool definitions and service catalogue.
27. **`AI_ENABLED=false` kill switch** sends everyone to the structured form instantly.
28. **Log every call:** model, input tokens, output tokens, cached tokens, cost. This also feeds the demo's "cost per enquiry" moment.

### Guard the link and the key
The live site is public. Anyone who finds it can spend our credits unless we stop them.

29. The Claude API key lives **only on the server**, in env vars. It never goes to the browser, the repo, logs or screenshots.
30. **Rate-limit per IP** on the enquiry and contact endpoints (e.g. a few enquiries per IP per hour).
31. **Daily app-wide cap** on Claude requests (e.g. 200/day); above it, use the fallback form.
32. Honeypot field (and a CAPTCHA if abuse appears) on public forms.
33. Max length on all customer text input, so nobody can paste a novel into the prompt.
34. Console **spend limits** on each workspace (testing ≤ $20, finale ≤ $10).
35. If a key is ever exposed: **revoke it immediately**, create a new one, tell the owner.

### Test on real cases, cheaply
36. **Mock AI by default** (`AI_MODE=mock`): all UI, pricing, email, database and dashboard tests run on saved responses at no cost.
37. Save **10 real test cases** in `tests/cases/` (enquiry text + expected requirements + expected missing fields). Rerun them with real Claude **after each prompt or model change**, and at no other time.
38. **Never** run real Claude calls in loops, load tests, CI on every commit, or automatic retries beyond rule 23.
39. After the first real run, record the **measured** cost per enquiry in §6.

### Protect the finale
40. Separate **testing** and **finale** workspaces and keys. The finale key is used only for final rehearsals and on 11 December.
41. Process the sample rate card **in advance**; the live demo spends credits only on enquiries.
42. Keep the fallback working at all times.

---

## 5. GoDaddy budget ($40)

43. **No purchase without the owner's explicit approval.** Claude may recommend; only the owner buys.
44. First check what the **hackathon already provides** (hosting, credits, vouchers) and what the plan includes (MySQL, SSL, mailbox), and use that.
45. Buy only what the requirements need: **one domain, one mailbox.** No second database or extra service.
46. Decline add-ons and upsells unless required (privacy upgrades, backups, SEO tools, premium email tiers, multi-year terms). Note the **renewal price** of anything bought.
47. Log every charge in the Spend log.
48. If something would push GoDaddy spend over **$40**, stop and propose a cheaper alternative.

---

## 6. Cost reference (verify before relying on it)

From our planning notes. **Re-check current prices on Anthropic's pricing page before the first real test run.**

| Model | Input / MTok | Output / MTok |
|---|---|---|
| Haiku 5.5 | $0.10 | $0.50 |
| Sonnet 5.5 | $2 | $10 |

Illustrative: ~12,000 input + ~3,000 output tokens per completed enquiry → **Haiku ≈ $0.0027**, **Sonnet ≈ $0.054** per enquiry. These are calculated, not measured. The real budget risk is **development**, not runtime.

Measured cost per enquiry (after first real run): `[ $ ___ ]`

---

## 7. Before submission (20 November 2026): checklist

- [ ] All mandatory requirements pass on the live domain (`Idea.md` §2)
- [ ] Sample rate card processed and approved
- [ ] All 10 real cases pass on the final prompt and model
- [ ] Full demo flow run end-to-end on the live domain at least twice
- [ ] Kill switch tested; fallback form works
- [ ] Rate limits and daily cap active (the live link goes to judges and can be shared)
- [ ] Contact form and estimate emails arrive from the domain mailbox
- [ ] Follow-up can be triggered manually
- [ ] Demo video recorded
- [ ] `git grep` / secret scan shows no passwords or keys in the repo
- [ ] `docs/PROMPTS.md` and the AI cost log ready for the project brief
- [ ] Spend log up to date
- [ ] Everything submitted on HackerEarth, with time to spare

### If selected: before the finale (11 December)
- [ ] Finale workspace has ≥ $10 available, spend limit set
- [ ] Site, domain, mailbox and HTTPS still live (check renewals and that nothing has expired)
- [ ] Demo rehearsed twice on the live domain; submission video ready as a backup
- [ ] Any post-submission improvements stayed inside the remaining budget

---

## 8. Spend log

Update after every milestone, real test run and purchase.

| Date | Builder | What | Model | Claude spend | GoDaddy spend | Claude total | GoDaddy total |
|---|---|---|---|---|---|---|---|
| | | Start | – | $0 | $0 | $0 | $0 |
| | | | | | | | |
