# Base44 spec: gap analysis

This compares the **Base44 upgrade requirements** (the 20-section spec) with Sam as it is in this repo. The long-term plan is in [ROADMAP.md](ROADMAP.md); this file doesn't repeat it, only maps the Base44 requirements onto it.

**Key:** ✅ implemented · 🟡 partial · ❌ missing · 🐞 broken · 🔌 needs an external service · 🏗 needs an architecture change

| # | Area | Status | Notes |
|---|---|---|---|
| 1 | Identity and design | 🟡 | Sam's name, personality and branding are kept. The look is clean, but it isn't the "premium" redesign yet (that's 🏗 stage 3: component frontend, themes) |
| 2 | Chat upgrade | 🟡 → ✅ in v3.2 | Already done: modes, streaming, auto and manual model choice, multiple providers, persistent history, copy code, context kept across models. **v3.2 adds:** chat search; rename, pin and archive; regenerate; copy the whole reply; edit and resend; tables. ❌ Still missing: equations (needs a maths renderer), general file attachments (see 7) |
| 3 | Sam Council | 🟡 → ✅ in v3.2 | Already done: several models, a combined answer, disagreements noted. **v3.2 adds:** choose which models take part, and "show individual answers" (saved with the chat). A separate quality-scoring step: ❌ later |
| 4 | Deep Research | 🟡 | News search with real links, and it never fakes a search. ❌ Multi-step research, research projects, document and slide export. 🔌 Full web search needs a search API (Brave, Tavily…) |
| 5 | Automatic task recognition | 🟡 | Picks the model tier and triggers search by keyword. ❌ No general "tool router" yet; it depends on the tools in 6–10 existing first |
| 6 | Study Centre | ❌ | All in-house work: quizzes, marking with partial marks, progress tracking, weak topics, flashcards. Uploading worksheets depends on 7 |
| 7 | Image and file understanding | 🟡 | ✅ Image Q&A. ❌ PDF, Word and Excel reading (open-source parsers, in-house). 🔌 Image generation and editing (Gemini and OpenAI keys you already have) |
| 8 | Coding Assistant | 🟡 | ✅ Coding mode, formatted code, copy. ❌ Project files and folders, GitHub links (🔌 GitHub OAuth), running code (🏗 sandbox, shared with App Builder) |
| 9 | Video Studio | ❌ | Concepts, scripts and storyboards are text, so they can be built in-house. 🔌 Actual video generation is an expensive provider API. Every button will show whether it's live |
| 10 | Presentation Studio and documents | ❌ | .pptx, PDF and speaker notes can be generated in-house. 🔌 Google Slides, Drive, Microsoft 365 and Canva need an OAuth app each |
| 11 | Productivity and integrations | ❌ | Tasks, projects and planning are in-house. 🔌 Calendar and email need OAuth. 🏗 Reminders need a background worker |
| 12 | Settings Centre | 🟡 | ✅ Voice on/off, account security, data export and delete, usage stats. ❌ Personality and response style, default model and mode, light theme and accent colours, notifications |
| 13 | Memory and persistent data | 🟡 → better in v3.2 | ✅ Per-user memories (add and delete), private history. **v3.2 adds:** pinned messages and chats. ❌ Saved prompts, memory editing, pinned files and projects (need 7 and 8 first) |
| 14 | Pinned workspace | 🟡 in v3.2 | **v3.2:** Pinned section in the sidebar (chats) and a Pinned tab (messages). These survive refresh and log-out. ❌ Collections, notes, custom order, and pinning files, tasks and so on once those exist |
| 15 | Performance | 🟡 | ✅ Routing, streaming, retries and fallback, history limited to 20 messages, Stop button, indexed queries. ❌ Response caching, background jobs (🏗 worker), summarising long chats |
| 16 | **"Unauthorised" error** | ✅ fixed (see below) | |
| 17 | Usage limits and cost | 🟡 | ✅ No message caps. Only anti-spam limits (20 per minute per user, configurable). Usage log, admin cost view, clear "provider is rate-limiting" errors. ❌ Per-user budgets, cost-aware provider choice |
| 18 | Reliability and testing | 🟡 | ✅ A smoke test across several accounts, unit and browser tests, desktop **and mobile** checks in v3.2. Still needed: a run on your machine with real AI keys (`npm run test:smoke`) |
| 19 | Migration and deployment | 🟡 | ✅ GitHub, Render blueprint, env vars, backups, error log, **no Base44 dependencies at all**. ❌ Persistent storage decision (paid disk or Neon Postgres) |
| 20 | This analysis | ✅ | |

## The "Unauthorised" error (section 16)

**What I could check:** this repo, the version that replaced the Base44 app. **What I couldn't check:** the Base44 app's own backend functions and row-level security rules, because that code was never in the repo. I'm not guessing at those.

In Sam's own stack, I traced the whole request path (browser → session cookie → server → database → AI provider) and found several causes of "Unauthorised" or "Please log in first" when sending messages, for **every** user:

1. **Proxy trust was missing (the main cause).** On Render, Sam runs behind a proxy. In production mode the session cookie is "secure", but Express thought the connection was plain HTTP, so it **never sent the cookie**. Every request after login came back 401. That matches "it happened to me and my friends". **Fixed:** `trust proxy` is turned on for Render or production.
2. **All users shared one rate-limit bucket** (50 a minute for everyone behind the proxy). That produces 429s that look like auth failures. **Fixed:** the limits now go by real client IP and by user.
3. **The frontend couldn't tell error types apart.** A wrong-password 401 and an expired session looked the same, and AI-provider key errors showed up as generic failures. **Fixed:** session errors carry a `code`, provider key rejections say "the AI provider rejected Sam's API key", and every error shows a **ref** you can look up in Admin → Errors.
4. **The session secret used a known default and could change on restart**, which made users look logged in but then get rejected. **Fixed:** the secret is stored in the database.

**How it's verified:** `scripts/smoke-test.js` registers two separate users and checks:
- both can log in and send messages
- chats are saved
- each user can read only their own history
- cross-user reads, posts and deletes are refused
- errors come back clearly
- the AI connection works (when a key is set)

Run it on your machine or against Render: `BASE_URL=https://… npm run test:smoke`.

## Priority order
| Priority | What | Why first | Depends on |
|---|---|---|---|
| **P1 (v3.2, this update)** | Chat essentials (2), Council choice and contributions (3), pinning (13, 14), mobile check (18) | Used in every conversation; all in-house | Nothing |
| **P2** | Settings Centre (12): personality, response style, default model and mode, light theme and accents | Spec section 1 identity plus everyday comfort | Nothing |
| **P3** | File understanding (7): PDF, Word and Excel reading; image generation | Unlocks Study Centre uploads, research documents and Presentation Studio | 🔌 your existing AI keys |
| **P4** | Study Centre (6) | Core original purpose of Sam | P3 for uploads |
| **P5** | Deep Research v2 (4) and Presentation and documents (10) | High value; share the same export pipeline | 🔌 search API key |
| **P6** | Tool router (5), Video Studio text tools (9), Productivity (11) | Builds on the tools above | 🔌 OAuth apps, 🏗 worker |
| **Always** | Persistent hosting decision (19) | Without it, Render's free plan wipes data | Your choice |
