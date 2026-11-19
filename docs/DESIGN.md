# Liaisa — Design & UX

| | |
|---|---|
| Status | v1, 19 Nov 2026 |
| Related | `PRD.md` (features), `ARCHITECTURE.md` (EJS views, no front-end build), `TestCases.md` §6 (QA checklist) |

> **For Claude Code:** build every page from this file. Use only the tokens in §3 (no new colours, fonts or sizes), the components in §5 and the words in §7. Server-rendered EJS + one CSS file + small vanilla JS files. No CSS framework, no inline scripts (CSP).

---

## 1. Who we design for

| Person | Context | What they need from the screen |
|---|---|---|
| **Customer** | On a phone, often arriving from WhatsApp or the owner's website. Not technical. May write in Hinglish. | Type what they need, answer one short question, know what happens next. Never feel they're filling in a form for a machine. |
| **Owner** | A solo business owner between jobs, often on a phone too. | See in five seconds what needs them. Approve a quote with one tap, with enough detail to trust it. |
| **Judge** | Watching a 3-minute demo on a projector, then reading GitHub. | Understand the product without narration; see the agent work and the human stay in control. |

**Design consequence:** customer pages are **mobile-first** and single-column. The owner dashboard works on a phone first and spreads out on a laptop.

---

## 2. Design idea: the thread between two sides

Liaisa is a **go-between**. Every screen shows two sides (customer and business) and the thread that connects them.

- **The journey line** is the signature element and the one bold thing in the design. It's a thin plum line with marked stops that shows where an enquiry is: *Asked → Clarified → Drafted → Approved → Sent → Reminded → Accepted*. It appears on the owner's enquiry detail, as a compact version in the dashboard list, and as a short customer-facing version on the quote page. It is a real sequence, which is why it gets steps.
- **Two voices, set apart by alignment, not bubbles.** On the enquiry page, the customer's words sit on the left in the body face. Liaisa's replies sit indented under a plum rule, in the same body face. No chat bubbles, no avatars, no robot icons.
- **Everything else stays quiet:** white and soft cool-grey surfaces, one plum brand colour, status colours only where status lives.

What we deliberately avoid: a cream background with a terracotta accent, dark mode with a neon accent, rows of identical rounded cards with grey shadows, gradient washes, all-caps labels above headings, and "AI sparkle" icons.

---

## 3. Tokens

Put these in `src/public/css/tokens.css` as CSS custom properties. All text/background pairs below meet WCAG AA (checked).

### 3.1 Colour

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--plum` | `#3B2352` | Brand, headings, journey line, primary links | 13.6:1 on white |
| `--ink` | `#1E1A24` | Body text | 17.1:1 on white |
| `--slate` | `#555E6B` | Secondary text, hints, timestamps | 6.6:1 on white |
| `--cloud` | `#F3F2F7` | Page background (cool, faintly violet) | — |
| `--white` | `#FFFFFF` | Surfaces: forms, quote sheet, panels | — |
| `--line` | `#DCD8E3` | Borders, dividers, inactive journey stops | decorative |
| `--jade` | `#17735E` | Primary action buttons (Approve & send, Accept quote), success | 5.8:1 white-on-jade |
| `--amber` | `#9A5B00` | "Needs you" text and icons | 5.4:1 on white |
| `--rose` | `#B4233F` | Errors, Decline | 6.5:1 on white |

Tinted status backgrounds (text colour → background):

| Status tone | Text | Background | Contrast |
|---|---|---|---|
| Needs you | `#5C3600` | `#FCEFD8` | 9.3:1 |
| Done / accepted | `#0E4A3C` | `#E1F2EC` | 8.8:1 |
| Problem | `#7A1229` | `#FBE6EA` | 9.1:1 |
| In progress | `#3B2352` | `#ECE6F2` | 11.1:1 |

Never rely on colour alone: every status also has a text label (and an icon where space allows).

### 3.2 Typography

| Role | Face | Notes |
|---|---|---|
| Display: brand name, page titles, the quote total | **Young Serif** (single weight) | A letter-like serif that suits a go-between. Use sparingly: never for body or UI text. |
| Body + UI | **Figtree** (400, 500, 600) | Friendly and very legible on phones. |
| Rupee sign | Figtree falls back per glyph | Check `₹` renders cleanly; if not, add `"Noto Sans"` to the stack. |

Self-host the font files in `src/public/fonts/` (`.woff2`, `font-display: swap`) so the CSP doesn't need a third-party font host.

Type scale (ratio 1.25, base 16 px, body line-height 1.55, headings 1.2):

| Token | Size | Use |
|---|---|---|
| `--t-xs` | 12.8 px | Timestamps, fine print |
| `--t-sm` | 14 px | Labels, table text, hints |
| `--t-base` | 16 px | Body, inputs (never smaller on phones, or iOS zooms) |
| `--t-md` | 20 px | Section headings, Liaisa's question |
| `--t-lg` | 25 px | Page titles |
| `--t-xl` | 31 px | Display headings |
| `--t-2xl` | 39 px | Quote total, landing headline (desktop) |

Rules: sentence case everywhere; no all-caps labels; text max width `62ch` (`--measure`); left-aligned (the quote total is right-aligned in its table).

### 3.3 Space, shape and depth

| Token | Value |
|---|---|
| Space scale | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 · `--s-8` 64 px |
| Radius | `--r-sm` 6 px (inputs, buttons, badges) · `--r-lg` 14 px (the quote sheet and the enquiry form only) |
| Shadow | One only: `--lift: 0 1px 2px rgb(59 35 82 / 8%), 0 8px 24px rgb(59 35 82 / 6%)`, used **only** on the quote sheet and modal dialogs |
| Borders | `1px solid var(--line)` for structure |
| Layout widths | Customer pages: `--col: 36rem` · Owner pages: up to `72rem` |
| Breakpoints | `40rem` (large phone/tablet) · `64rem` (laptop) |
| Tap targets | Min 44 × 44 px |
| Focus | `outline: 3px solid var(--plum); outline-offset: 2px` on every interactive element, never removed |

---

## 4. Screens

Status words, button labels and copy come from §7. ASCII wireframes are layout intent, not pixel specs.

### 4.1 Liaisa home — `liaisa.co.in/` (the product's own site; satisfies R1, R4)

Purpose: tell an owner (and judges) what Liaisa does in one screen, show it working, and offer contact.

```
┌──────────────────────────────────────────────┐
│ Liaisa                               Contact │
│                                              │
│  Every enquiry answered.                     │  ← Young Serif, --t-2xl
│  Every quote yours to approve.               │
│                                              │
│  "Need food for 40 at my son's birthday"     │  ← the exchange, set as type
│  ┃ Lovely! Which date, and which area?       │    (plum rule = Liaisa)
│  "13 Dec, Koramangala"                       │
│  ┃ Got it. Your quote is with the owner.     │
│  ● Owner approved · ₹18,900 sent by email    │  ← journey stop
│                                              │
│  [ Try the demo enquiry ]  See how it works  │
├──────────────────────────────────────────────┤
│ How it works: 1 Customer asks  2 Liaisa      │  ← a real sequence, so numbered
│ clarifies  3 You approve  4 Liaisa follows up│
├──────────────────────────────────────────────┤
│ Find your first clients (Client Finder)      │
├──────────────────────────────────────────────┤
│ Contact form                                 │
└──────────────────────────────────────────────┘
```
- The hero exchange is static HTML. Its one animation plays on page load: lines appear in order, ~350 ms apart. Skip it when `prefers-reduced-motion` is set.
- "Try the demo enquiry" opens the Mehfil Kitchen enquiry page.

### 4.2 Enquiry page — `/enquire` (customer, F4)

Header shows the **business's** name (Young Serif) and a small "Powered by Liaisa" in the footer, not the header.

**Step 1: describe**
```
Mehfil Kitchen
Home-style catering for small events

Tell us what you need
┌──────────────────────────────────────────┐
│ e.g. Veg lunch for 40 people on 13 Dec,  │  ← textarea, 5 rows, 1,000-char counter
│ in Koramangala                           │
└──────────────────────────────────────────┘
Your name        [                    ]
Reply to me on   ( ) WhatsApp  ( ) Email     ← segmented control
Phone / Email    [                    ]      ← field label changes with choice
[ Send enquiry ]
We'll only use your details to reply about this enquiry.
```

**Step 2: Liaisa asks** (same page, no reload)
```
You wrote
  "Veg lunch for 40 people at my son's birthday"
┃ Lovely! Which date is it, and which area?      ← --t-md, plum rule on the left
┌──────────────────────────────────────────┐
│                                          │
└──────────────────────────────────────────┘
[ Send answer ]
```
While waiting: the button reads "Sending…" and is disabled; under it, a slate line "Checking your details…". The reply region is `aria-live="polite"`.

**Step 3: done**
```
Thanks, Priya. Your enquiry is with Mehfil Kitchen.
What we understood
  Veg buffet · 40 guests · Sun 13 Dec · Koramangala
You'll get your quote on WhatsApp once the owner approves it.
```
No price is ever shown here (PRD F4).

**Fallback form** (F10): same page and style, heading "Tell us a few details", fields for service (select), guests, date, area (select + "Other"), add-ons (checkboxes), notes. Pre-filled from what was understood. Never mention errors or AI being "down".

### 4.3 Quote page — `/q/:token` (customer, F7)

The one place with `--r-lg` and `--lift`: it should feel like a document worth keeping.

```
┌──────────────────────────────────────────┐
│ Mehfil Kitchen                           │
│ Quote for Priya · valid until 26 Nov     │
│                                          │
│ Veg buffet  40 × ₹450         ₹18,000    │
│ Dessert counter  40 × ₹80      ₹3,200    │
│ Weekend (10%)                  ₹2,120    │
│ Travel to Whitefield           ₹1,500    │
│ Tax (5%)                       ₹1,241    │
│ ──────────────────────────────────────── │
│ Total                         ₹26,061    │  ← Young Serif --t-2xl
│                                          │
│ Asked ● Quoted ● Your reply ○            │  ← short journey line
│                                          │
│ [ Accept quote ]                         │  ← jade, full width on phones
│ Ask a question     Decline               │  ← text buttons
└──────────────────────────────────────────┘
```
- "Ask a question" expands a textarea in place.
- After Accept: the sheet stays; a done-tone banner reads "Accepted. Mehfil Kitchen will be in touch to confirm." The journey's last stop fills.
- Amounts use Indian grouping: `₹26,061`, `₹1,20,000` (`Intl.NumberFormat('en-IN')`).

### 4.4 Owner dashboard — `/owner` (F9)

Ordered by **what needs the owner now**, not by date.

```
Good evening, Mehfil Kitchen                     [Client Finder] [Settings]

Needs you (3)
┌────────────────────────────────────────────────────────────────┐
│ Priya · Veg buffet, 40 · 13 Dec       Needs your approval  ₹18,900 [Review] │
│ Arjun · Non-veg, 60 · 12 Dec          Reminder due (WhatsApp)   [Send on WhatsApp] │
│ Neha  · asked: "Can you do Jain food?" Customer question         [Reply] │
└────────────────────────────────────────────────────────────────┘

This week   12 enquiries · 7 quotes sent · 3 accepted · AI cost ₹4.10

All enquiries   [All ▾]
  Name    What                    Journey            Status         Updated
  Priya   Veg buffet · 40         ●●●○○○○            Needs approval  2 min ago
  …
```
- "Needs you" uses a single bordered panel (rows, not cards). Empty state: "Nothing needs you right now. New enquiries will appear here."
- On phones the table becomes stacked rows: name + status on line 1, what + updated on line 2.
- Polls every 30 s with a small `fetch` (no websockets).

### 4.5 Enquiry detail — `/owner/enquiries/:id` (F6, F7, F8, F12)

```
← All enquiries
Priya · Veg buffet for 40
Asked ─● Clarified ─● Drafted ─● Approved ○─ Sent ○─ Reminded ○─ Accepted ○   ← full journey line

┌ Conversation ───────────────┐ ┌ Quote (draft v1) ───────────────────┐
│ "Veg lunch for 40…"         │ │ Line items (editable qty)           │
│ ┃ Which date and area?      │ │ + Add discount (needs a reason)     │
│ "13 Dec, Koramangala"       │ │ Warnings: none                      │
│                             │ │ Total ₹18,900                       │
│ What Liaisa understood      │ │ Reply by: WhatsApp (98450 12345)    │
│ Veg buffet · 40 · 13 Dec …  │ │ [ Approve & send ]   Decline        │
│ Summary for you: …          │ │                                     │
└─────────────────────────────┘ └─────────────────────────────────────┘
Activity: emails, WhatsApp shares, reminders, AI requests used (2 of 4, ₹0.25)
```
- Phone: the quote panel comes **first** (that's the action), the conversation below.
- Warnings use the needs-you tone, with plain text, e.g. "Fewer guests (10) than this service's minimum (20)."
- Approve opens a confirm dialog: "Send ₹18,900 quote to Priya on WhatsApp?" → [Approve & send] [Cancel]. For WhatsApp, the next step opens WhatsApp; the page then shows "Opened in WhatsApp. Tap Send there to deliver it."

### 4.6 Client Finder — `/owner/client-finder` (F13)

A real sequence, so it's shown as three numbered steps on one page:

```
1 Describe your ideal client     [textarea]  [ Find client groups ]
2 Pick a group                   ( ) Office HR teams planning team lunches
                                     Why: … Where to find them: …
                                 ( ) Residential society committees …
                                 [ Write a brief for this group ]
3 Review and publish             Brief preview (as customers will see it)
                                 [Edit] [ Publish brief ]
   Published: liaisa.co.in/for/office-lunches   [Copy link]
   Share with one person:  Name/number or email [      ]
                           [ Send by email ] [ Send on WhatsApp ]
Results: 42 views · 3 enquiries · 1 contact message
```
- Below the step-1 button, slate text: "Liaisa suggests types of clients and where to find them. It never collects anyone's contact details."

### 4.7 Brief page — `/for/:slug` (public, F13)

Same family as the quote page: business name in Young Serif, headline, the client's problem, offer, priced packages (engine prices, Indian grouping), why us, then the contact form and a jade "Get a quote" button. No testimonials or logos unless the owner adds real ones.

### 4.8 Settings — `/owner/settings` and `/owner/setup`

Plain forms in sections: Business details · Prices (table: service, unit, price, min, max; add/remove rows) · Follow-up timing · Message templates (with placeholder chips `{{customer_name}}` etc. and a live preview). Save buttons say what they save: "Save prices", "Save templates".

### 4.9 Login and errors
- Login: business name, password, "Log in". Wrong password: "That password doesn't match. Try again." After the limit: "Too many tries. Wait 15 minutes, then try again."
- 404: "This page doesn't exist. If you followed a quote link, ask the business to send it again."
- 500: "Something went wrong on our side. Your details are saved; try again in a minute."

### 4.10 Emails

Simple, single-column HTML (max 600 px, inline styles, system fonts) **plus a plain-text version**. From "Mehfil Kitchen via Liaisa" `<hello@liaisa.co.in>`.

| Email | Subject | Body essentials |
|---|---|---|
| Quote | "Your quote from Mehfil Kitchen: ₹18,900" | Greeting · line items · total · valid until · button "View and accept your quote" |
| Reminder 1 | "Still planning your 13 Dec event?" | One line + same button |
| Reminder 2 | "Your quote from Mehfil Kitchen expires on 26 Nov" | One line + button |
| Owner notice | "New enquiry: Priya, veg buffet for 40" | Summary + "Review in Liaisa" link |
| Contact form | "Website message from {name}" | Message; Reply-To = visitor |

WhatsApp messages: short, no markdown, one link, e.g.:
> Hi Priya, here's your quote from Mehfil Kitchen for 40 guests on 13 Dec: ₹18,900. View and accept: https://liaisa.co.in/q/…

---

## 5. Components

Build as EJS partials in `src/views/partials/` with matching CSS blocks.

| Component | Notes |
|---|---|
| `button` | Variants: **primary** (jade fill, white text), **secondary** (white, plum border/text), **text** (plum text, underline on hover), **danger-text** (rose). Labels are verbs naming the result. Disabled + "…ing" label while submitting. |
| `field` | Label above input (always visible; no placeholder-as-label), hint in slate below, error in rose below with an icon, `aria-describedby` linking hint/error. Inputs 16 px. |
| `segmented` | Two-option choice (WhatsApp / Email); real radio inputs, styled. |
| `status-badge` | Tone background + text from §3.1, `--r-sm`, sentence-case label from §7. |
| `journey` | `<ol>` with `aria-label="Enquiry progress"`; each stop is `<li>` with visually hidden text "done" / "current" / "not yet". Full and compact variants. Plum line, filled dots for done, ringed dot for current, `--line` for not yet. |
| `exchange` | Customer line (quoted, ink) and Liaisa line (indented, `border-left: 3px solid var(--plum)`). |
| `quote-sheet` | Table with `<th scope>`; amounts right-aligned, `font-variant-numeric: tabular-nums`. |
| `needs-you-row` | Name, what, reason (needs-you tone), one primary action. |
| `banner` | Done / needs-you / problem tones; `role="status"` (or `role="alert"` for problems). |
| `dialog` | Native `<dialog>`; focus moves to the dialog and returns afterwards; Esc closes. |
| `empty-state` | One sentence saying what will appear + the action to make it happen. |

---

## 6. Interaction and motion

- **One orchestrated moment:** the landing-page exchange (§4.1).
- **Motion that answers an action:** Liaisa's question fades in (150 ms) after "Send enquiry"; a journey stop fills (200 ms) after Approve or Accept; dialogs fade (120 ms). Nothing else animates. No hover lifts on rows.
- `@media (prefers-reduced-motion: reduce)` turns all of it off.
- Forms work without JavaScript (normal POST + full page render); JS only improves them (no reload, live counter).
- Double-submit protection: buttons disable on submit; the server is idempotent anyway.

---

## 7. Words

Voice: plain, warm, brief. Sentence case. Active voice. Errors say what happened and what to do; they don't apologise. No "AI-powered", "magic" or "sparkle" language anywhere on customer screens. To customers, Liaisa speaks for **the business**.

### 7.1 Vocabulary (use exactly these)

| Concept | Customer sees | Owner sees | Never say |
|---|---|---|---|
| Customer request | Enquiry | Enquiry | Lead, ticket, submission |
| Price document | Quote | Quote (internally `estimate`) | Estimate, proposal, invoice |
| Owner's yes | — | Approve & send → toast "Approved and sent" | Submit, OK |
| Customer's yes | Accept quote → "Accepted" | Accepted | Confirm, convert |
| Reminder | — | Reminder | Nudge, drip, follow-up sequence |
| Client Finder output | — | Client groups · Brief | Segments, personas, leads list |

### 7.2 Status labels (DB value → label)

| DB status | Owner label | Tone |
|---|---|---|
| `collecting` | Asking the customer | In progress |
| `needs_owner` | Needs your review | Needs you |
| `awaiting_approval` | Needs your approval | Needs you |
| `quoted` | Quote sent | In progress |
| `followed_up` | Reminder sent | In progress |
| `won` | Accepted | Done |
| `lost` | Closed: no reply / declined | Neutral (slate) |
| `declined` | You declined | Neutral |
| `out_of_scope` | Not something you offer | Neutral |
| follow-up `awaiting_owner` | Reminder due: send on WhatsApp | Needs you |
| estimate `approved_send_failed` | Email didn't send: retry | Problem |

### 7.3 Messages

| Situation | Text |
|---|---|
| Enquiry too long | "Please keep it under 1,000 characters. You can add details after we reply." |
| Phone invalid | "Enter a 10-digit mobile number, like 98450 12345." |
| Email invalid | "Enter an email address, like name@example.com." |
| Too many enquiries (429) | "You've sent a few enquiries in a row. Try again in an hour, or use the contact form." |
| Email failed (owner) | "The quote email didn't send. Your quote is saved. Retry sending" |
| Unknown area (warning) | "Liaisa couldn't match 'Mysore' to a travel fee. Check the travel charge before approving." |
| Empty dashboard | "No enquiries yet. Share your enquiry link: liaisa.co.in/enquire [Copy link]" |
| Empty Client Finder | "Describe who you'd love to work with, and Liaisa will suggest where to find them." |

---

## 8. Accessibility checklist (build to this; QA in `TestCases.md` §6)

- [ ] Colour contrast AA or better (all tokens checked in §3.1)
- [ ] Every input has a visible `<label>`; errors linked with `aria-describedby`
- [ ] Keyboard: everything reachable with Tab, visible focus ring, logical order, no traps; dialogs return focus
- [ ] Liaisa replies announced via `aria-live="polite"`
- [ ] Status never shown by colour alone
- [ ] Tap targets ≥ 44 px; inputs ≥ 16 px text
- [ ] `lang="en-IN"` on `<html>`; dates as "Sun 13 Dec"; currency with Indian grouping
- [ ] Works at 320 px wide and at 200% zoom without sideways scrolling
- [ ] `prefers-reduced-motion` respected
- [ ] Page titles unique: "Quote from Mehfil Kitchen · Liaisa"

---

## 9. Demo polish (Demo is 35% of the score)

- Seed realistic demo data: 6–8 enquiries across statuses, with Indian names and believable requests, so the dashboard isn't empty on camera.
- Set browser zoom so text is readable on a projector (test at 125%).
- Keep the phone (customer) and laptop (owner) side by side in the video: the journey line moving on both is the story.
- Show the AI cost line ("this enquiry cost ₹0.25") once. It proves efficiency without a lecture.
