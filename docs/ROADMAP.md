# Sam: realistic technical roadmap

This maps the **Sam master plan** (16 sections, 8 stages) onto what exists today, what can be built in-house, and what depends on outside services or new infrastructure.

**Key**
- ✅ Built and working
- 🔨 Can be built now, in-house, with Sam's existing setup
- 🔌 Needs an external service (an API key, OAuth app, payment provider…). Usually costs money per use.
- 🧱 Needs new infrastructure (background workers, sandboxed containers, app-store accounts…)

---

## Where Sam is today (v3)
| Area | Status |
|---|---|
| Own codebase on GitHub, own login, own database, server-side AI keys | ✅ |
| Gemini, Claude, OpenAI and DeepSeek, with automatic fallback | ✅ |
| Auto model routing; Fast, Balanced and Deep modes | ✅ |
| Sam Council | ✅ |
| Switching models without losing context | ✅ History is stored by Sam, not the provider, so any model sees the whole chat |
| Streaming, Stop, markdown, code copy | ✅ |
| Chat search, rename, pin, archive; regenerate; edit and resend; copy; pinned messages; tables; mobile layout | ✅ v3.2 |
| Choosing Council members, viewing individual answers | ✅ v3.2 |
| Web Search and Deep Research modes | ✅ Basic: uses Google News RSS, so news only |
| Image understanding | ✅ |
| User-written memories | ✅ |
| Browser voice (speech in, speech out) | ✅ Basic |
| Usage log, health check, backups, smoke test | ✅ |
| Admin dashboard, roles, account security, error log, automatic backups | ✅ v3.1 |

---

## Additional advanced features (spec 4)
These are extra requirements on top of everything below. The **Stage** column gives where each one fits in the build order at the bottom of this file.

| Feature | Status now | Stage | Depends on |
|---|---|---|---|
| **Model Marketplace** (discover, compare, connect models) | 🟡 Admin sees each provider's models and status; users pick models | 2 (**v3.3**) | Nothing. "Connecting" a provider means an admin adds its API key on the server; keys are never typed into the browser |
| **Prompt Library** (reusable prompts, templates, custom instructions) | ❌ | 2 (**v3.3**) | Nothing |
| **Custom personalities and specialist assistants** | ❌ | 2 (**v3.3**) | Nothing |
| **Automatic task recognition and tool selection** | 🟡 Keyword search trigger and tier routing | 2 (**v3.3**) for modes that exist; grows as each tool lands | Each tool it routes to (Study Centre, images, slides…) |
| **File Library** (uploaded and generated files) | ❌ | 3 | Storage decision (disk, or R2/S3 for several servers); file parsers |
| **Background agents** with progress and notifications | ❌ | 6 | 🏗 Job queue plus a worker process; notifications need push or email (🔌) |
| **Collaborative workspaces and sharing with friends** | ❌ | 7 | Projects and File Library, a permissions model, and moderation if anything goes public |
| **App Builder apps get their own web addresses** | ❌ | 5 (v1 static sites), then 5 (v2) | v1: static hosting (Render static sites, Cloudflare Pages, or Sam serving `/apps/<name>`). v2: 🏗 containers. Users' own hosting accounts through OAuth (🔌) |
| **Advanced admin** (permissions, analytics, cost, health) | ✅ v3.1 basics: roles, users, usage and cost, health, errors | Ongoing | Finer permissions need a roles table; an audit log comes next |
| **Automated backups, recovery, version history** | ✅ Daily backups plus a manual backup. ✅ Code history in git. ❌ In-app version history and a restore button | 3 | Version history of chats and files lands with the File Library and projects |
| **Cross-device sync** (desktop, mobile, tablet) | ✅ Everything lives on the server, so any logged-in device sees the same chats, pins and memories | 3 (PWA install), 8 (native apps) | Installable app: a PWA manifest plus a service worker. Native apps need developer accounts |
| **Safe, tested, reversible self-improvement of Sam** | 🟡 The process exists today: branch → tests → PR → you approve → merge, and `git revert` undoes any change | 5 | Sam proposing its own PRs needs the App Builder's sandbox and a GitHub App. It must **never** auto-merge or auto-deploy to itself |
| **Integrations marketplace** | ❌ | 3 → 6 | A connector framework (OAuth token storage, per-user permissions, revoke), then one integration at a time: Google, Microsoft, Canva… |

**Dependency chain (simplified):**
- Settings and personalities and the Prompt Library (v3.3) → the tool router
- File Library → Study Centre uploads, research documents, Presentation Studio, App Builder projects
- Connector framework → integrations marketplace → productivity and agents
- Job worker → background agents → scheduled automations
- Sandbox → App Builder v2 → Sam improving Sam

## The master plan, section by section

### 1. AI ecosystem
- ✅ Multi-provider, automatic selection, Council, speed modes, context kept when switching models
- 🔨 Model browser (the "marketplace"): a page listing each model's strengths, speed and cost
- 🔨 Personalities and specialist assistants (Tutor, Coder, Researcher, Writer, Business coach, plus user-made ones)
- 🔨 Smarter memory: Sam suggests memories and the user approves them. Plus on/off controls and per-chat "don't remember"
- 🔌 Adding a new provider takes about 10 lines in `lib/ai.js` if it has an OpenAI-compatible API (most do)

### 2. Sam App Builder
- 🔨 **v1, front-end apps:** describe an app → Sam writes HTML/CSS/JS → live preview in a sandboxed iframe → edit in plain English → version history → export to GitHub. No user code runs on Sam's server, so this is safe to build now.
- 🧱 **v2, full-stack apps:** needs isolated containers to run generated backends, for example Fly.io Machines, E2B or a Docker host. Running untrusted code on Sam's own server would put every user's data at risk, so this must stay separate.
- 🔌 Deploying users' apps happens through *their own* GitHub, Render or Vercel accounts using OAuth
- Sam helping to build Sam: possible using the same GitHub flow I use now (branch → PR → you approve → merge). Never auto-deploy.

### 3. Research and Knowledge Centre
- 🔌 **Real web search needs a search API.** Google News RSS only covers news. Options: Brave Search API, Tavily or Serper (all have free tiers). This is the single biggest quality upgrade for research.
- 🔨 Multi-step research: plan → search → read → cross-check → report with numbered citations
- 🔨 Reading PDF, Word, Excel and PowerPoint files (open-source parsers, no external service)
- 🔨 Research projects with saved sources, and reports exported as Word or PDF

### 4. Education and Study Centre
- 🔨 All buildable in-house: revision timetables, quizzes, marking with partial credit, flashcards, weak-topic tracking, adaptive recommendations, subject tutors
- 🔨 Uploading notes and worksheets needs file storage (see section 8)
- ⚠️ Exam-board accuracy (AQA, Edexcel, OCR…): the AI can match syllabuses roughly, but official specifications should be loaded as source documents rather than trusted from memory

### 5. Creative Studio
- 🔌 **Images:** use the Gemini and OpenAI keys Sam already has. This is the next feature to build.
- 🔨 **Presentations:** editable .pptx files and PDFs with speaker notes, generated on the server with open-source libraries
- 🔨 Scripts and storyboards (text only, so cheap)
- 🔌 **Audio:** better voices and transcription through provider text-to-speech and speech-to-text APIs. The free browser voice already works.
- 🔌 **Video:** provider video models. These are **very expensive** per clip, so give them hard per-user limits. Build last.
- ⚠️ Music and narration must use licensed or generated audio only

### 6. Productivity and personal assistant
- 🔨 Tasks, projects, daily and weekly planning, document drafting, an approve-before-acting flow
- 🔌 Google Calendar, Drive and Docs and Microsoft 365 need OAuth apps registered with Google and Microsoft. Gmail access counts as a "restricted scope" and needs a paid security review from Google, so do email last.
- 🧱 Reminders that fire while you're offline need a background worker plus push or email notifications

### 7. Agents and automation
- 🔨 A shared "tools" framework: search, read file, make slides, run quiz… Each agent is a prompt plus a set of allowed tools
- 🔨 Approval gates before any external action
- 🧱 Scheduled and long-running agents need a job queue and a worker process (a Render Background Worker or Cron Job)

### 8. Files, projects and workspace
- 🔨 Projects, folders, pinned chats, search across chats, version history
- 🔨 File storage on Render's disk to start with
- 🔌 S3-compatible storage (Cloudflare R2 or Backblaze B2, both cheap) once files grow or Sam runs more than one server

### 9. Community and collaboration
- 🔨 Shared projects and team workspaces with explicit permissions (private by default)
- ⚠️ Anything public (shared prompts, published apps) needs **moderation and reporting tools** first. UK law applies here: the Online Safety Act and the ICO Children's Code.

### 10. Developer platform
- 🔨 Sam API with per-user API keys, webhooks, usage metering
- Plugin marketplace: much later, after the tools framework (section 7) has settled

### 11. Mobile and desktop
- 🔨 **PWA first:** Sam installs on phones and desktops from the browser. It's cheap and quick.
- 🧱 Native apps (Capacitor or Electron) need Apple ($99/year) and Google ($25 one-off) developer accounts and app review

### 12. Interface and personalisation
- 🔨 All in-house: themes, accents, light and dark modes, response styles, accessibility, shortcuts, sidebar, search, animations
- **Decision for stage 3:** the frontend is one big HTML file now. Before the redesign, move it to a component setup (e.g. Vite + React or Svelte) so features stop tangling together.

### 13. Business features
- 🔨 Business plans, marketing copy, branding and documents: mostly specialist assistants plus the document and presentation tools
- 🔌 Paid plans need Stripe, plus terms, a privacy policy and VAT handling

### 14. Independence and infrastructure
- ✅ Own codebase, login, database, AI connections, GitHub flow, backup script
- ✅ Automatic daily backups, error log, monitoring in the admin dashboard
- 🔌 or 🧱 **Hosting persistence:** Render's free web services can't have a disk, so the SQLite file is wiped on every deploy. Options:
  - A paid Render instance with a disk (works today with no code changes)
  - **Neon Postgres free tier:** no expiry, and it sleeps when idle (best free option; needs the Postgres adapter)
  - Supabase free tier: pauses after a week of low activity until you resume it by hand
  - Render free Postgres: **expires after 30 days**, so it's not suitable
- 🧱 Scaling to many servers needs Postgres plus shared file storage. SQLite is fine for one server and hundreds of users.

### 15. Security and administration
- ✅ Roles (`ADMIN_USERNAMES`), user management, disabling accounts, usage and cost view, provider health, error log with ref codes, backups from the admin panel, password change and reset links, data export, account deletion, CSRF protection, rate limits that only count failed logins
- Later: two-factor login, an audit log of admin actions, security alerts

### ⚠️ Before any public launch
- **Children's data:** Sam currently accepts ages 5 and up. Under UK GDPR, services for under-13s need **parental consent** and must follow the ICO Children's Code. Either set the minimum age to 13 or build a parental-consent flow.
- **Privacy policy and terms of service**, plus a clear statement of which AI providers receive users' messages
- **Costs:** every message costs real money. Use usage budgets, cheap default models and caching. Never advertise "unlimited".

---

## Build order (matches the master plan's 8 stages)

| Stage | Contents | Needs from you |
|---|---|---|
| **1. Foundation** | ✅ Login, messaging, multi-model core, admin, account security, error log, backups | Decide on hosting: paid disk or Neon Postgres |
| **2. Advanced AI** | ✅ v3.2 chat essentials. **Next, v3.3:** Settings Centre, personalities and specialist assistants, Prompt Library, Model Marketplace, automatic mode selection. Then: smart memory, real web search, research reports, document reading | A search API key (free tier is fine) |
| **3. Education and productivity** | Frontend rebuild, Study Centre, files and projects, tasks, PWA, then Google integrations | A Google Cloud OAuth app |
| **4. Creative Studio** | Images, presentations, text-to-speech and speech-to-text, then video | Budget for image and video calls |
| **5. App Builder** | v1 front-end builder with sandboxed preview and GitHub export; v2 full-stack in containers | A container provider for v2 |
| **6. Agents** | Tools framework, approvals, scheduled jobs | A Render worker or cron job |
| **7. Community and developers** | Sharing, moderation, Sam API, webhooks | Legal pages and moderation plan |
| **8. Platform** | Native apps, multi-server scale | Apple and Google developer accounts |

Each stage gets tested (including with several user accounts) and goes through a pull request before it's merged.
