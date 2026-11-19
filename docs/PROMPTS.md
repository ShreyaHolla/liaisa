# Build prompts log

| # | Milestone | Prompt (summary) | Model | Rough cost | Outcome |
|---|---|---|---|---|---|
| 1 | M1 Skeleton | Build minimal Express app: server.js, app.js, config.js (zod), GET /, GET /healthz, scripts dev/start/test/package; write and run M1 tests. Plan first, then build. Constraint: nothing newer than Node 20. | Sonnet 5.5 | < $1 (est.; check /cost) | 8/8 tests pass locally (TC-REQ-01, -07, TC-SEC-07 + home + config). Live deploy (TC-REQ-01 manual) not done. |
| 2 | M3 Contact form | Contact form on home page + POST /api/contact: nodemailer only when MAIL_ENABLED=true, fake transport in tests, save before send (in-memory store until M4), honeypot, 5/hour/IP rate limit, CR/LF stripped from name. User decisions: email_status gains `skipped`; JS enhancement plus 303 no-JS fallback (/?contact=sent\|error\|limit). | Sonnet 5.5 | not measured (check /cost) | 31/31 local tests pass (TC-CON-01 to -06, config, M1). TC-REQ-06 and -08 pass as shell checks. TC-REQ-05 (live email) not done: needs deploy and MAIL_ENABLED=true. |
