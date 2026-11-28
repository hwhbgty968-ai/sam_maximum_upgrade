# Sam AI

Sam is a self-hosted AI assistant platform with its own backend, database, accounts and AI connections. No Base44 credits, no third-party builder.

## What works now (v4.3)
- **Plans and Sam Credits (v4.3, no real money yet):** Free accounts get 1,000 Sam Credits a month. Each answer costs a fixed, published amount: Fast 1, Balanced 5, Deep 12, with some models priced individually. Web search adds 1 and an image adds 2. Members see the price next to Send, and after each answer they see what it cost and what's left. They're never charged more than the price shown. Failed answers are free. **Max** gives "Unlimited Sam Credits": no monthly allowance, and nothing deducted for included features. Its one fair-use rule is published: after a set number of top-model messages a day, Sam answers with standard models (no charge, no block). Members see their plan, prices, limits and every balance change in Settings → Plan & credits. Admins move accounts between plans, add or remove credits, and change every number and the wording in Admin → Plans & credits. No payments yet.
- **Guest mode (v4.2):** "Try Sam without an account" on the login page. Guests get 10 free messages a day on the Fast models. They can't use web search, images, Council, memory or settings; those buttons are hidden for guests rather than faked. Guest chats live only in the server's memory and are never written to the database. They're deleted when the guest leaves, logs in or signs up, or after 2 hours idle. When a guest signs up or logs in, they can tick "Save my guest chat" to keep it. Without the tick, it's deleted. Cost limits: 10 a day per guest, 30 per network (so clearing cookies doesn't help), and 300 a day for all guests together. A failed answer doesn't count.
- **Sign-up is 13+ (v4.2)**, in line with UK GDPR and the ICO Children's Code. Existing accounts are untouched.
- **Honest, self-healing AI routing (v4.1):** when a model fails, Sam first tries the same speed on the other providers, then the other speeds, and skips any provider whose API key was rejected. Errors say what really happened ("Gemini is overloaded, try again in a minute", "the admin needs to fix the OpenAI key") with a ref code; admins also see which provider and model failed and why. API keys never appear in messages or logs.
- **Provider diagnostics (v4.1):** admin dashboard → AI providers shows, per model, whether the key works, whether the provider lists it, the last live test and whether Sam is using it right now. **Test all providers now** sends a tiny message to every model. Sam also tests at startup (at most every 6 hours). Models that don't work are greyed out in the model picker with the reason.
- **Permanent database:** set `DATABASE_URL` to a Postgres database (Neon's free plan works) and every account, chat, memory and setting survives restarts and redeploys, including on Render's free plan. Without it, Sam uses a local SQLite file as before, which suits running it on your own computer. The same code runs on both.
- **First admin via a one-time setup code** printed in the server log. There's no more `ADMIN_USERNAMES` race where whoever registered a listed name first became admin. Admins can then promote or demote others from the dashboard.
- **Full backups as one JSON file** (admin dashboard → Backups, or `npm run backup`), and `npm run restore` to load one into an empty database. The same pair moves Sam from SQLite to Postgres.
- **New design** based on the original Base44 Sam: dark navy with a cyan-to-purple brand, a sidebar with profile, New chat, sections and chat search, a status bar, a welcome screen with task cards and recent chats, suggested prompts, and a big composer with **Web**, **Auto** (assistant, model and speed) and **Council** toggles. It works on phones through a slide-out menu. Features that aren't built yet are shown as "Soon", not fake buttons.

- **Accounts:** register, log in and log out. Sessions last 30 days. Each user's chats and memories are private to them.
- **Multi-model AI:** Gemini, Claude, OpenAI and DeepSeek. Add whichever keys you have.
  - Model picker, or **Auto**, which picks a model by task.
  - **Fast / Balanced / Deep** speed modes.
  - If a model fails, Sam tries the same speed on other providers, then other speeds, and tells you if it had to switch.
  - At startup Sam checks each provider's real model list and replaces any model name that doesn't exist.
- **Streaming replies** with a **Stop** button. A stopped reply is saved up to the point you stopped it.
- **Sam Council:** asks several models, then combines their answers into one.
- **Web Search / Deep Research:** live news search with source links.
- **Image analysis:** attach a photo and ask about it.
- **Coding mode**, markdown formatting, and copy buttons on code blocks.
- **Chat management:** search all your chats (titles and message text); rename, pin, archive and delete chats; a pinned group at the top of the chat list.
- **Message actions:** copy any message, pin it, regenerate Sam's last reply, edit and resend your own message. If the AI fails, nothing is lost.
- **Pinned tab** for pinned chats and messages. Pins survive refresh, log-out and switching devices.
- **Sam Council:** choose up to 4 member models, and open "Show individual answers" to see what each one said.
- **Tables** in replies, and a layout that works on phones.
- **Settings Centre:** Sam's personality (5 styles), response length, "explain simply", custom instructions, default model and speed, memory on/off, automatic task detection on/off, **dark or light theme** and **5 accent colours**. Settings are saved on the server, so they follow you to every device.
- **Specialist assistants:** Tutor, Coder, Researcher, Writer, Business coach and Creative partner, plus **your own custom assistants**. Choose one per chat.
- **Prompt Library:** built-in templates plus your own saved prompts. "Use" drops one into the message box.
- **Model Marketplace:** every provider Sam supports, whether it's connected, its models and their status, with a "Use" button.
- **Automatic task recognition:** in a normal chat, Sam spots coding, research, news or homework questions and switches to the right mode or the Tutor for that message. It shows "auto: …" on the reply, and you can turn it off in Settings.
- **Memories:** notes you write that Sam uses in every chat. You can view and delete them.
- **Voice:** speech input and spoken replies, using the browser's built-in speech features.
- **Usage log:** every AI call is recorded. Users can see their own usage in Settings. Streamed token counts are estimates.
- **Admin dashboard** at `/admin`, for admins:
  - Overview stats, system health, and which database Sam is using
  - Users: search, disable/enable, make or remove admins, and one-time password reset links
  - Usage and cost per day, provider and model
  - Model status for each AI provider
  - Error log with ref codes
  - Backups: download a full backup (any database), plus daily server copies when using SQLite
- **Your account (Settings):** change password (this signs out your other devices), export all your data as JSON, delete your account.
- **Security:** blocks cross-site requests, signs out disabled users instantly, and puts a ref code on every error message that matches an entry in the error log.

Image generation isn't connected yet, so that button is disabled. See [docs/ROADMAP.md](docs/ROADMAP.md) for the full plan and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code fits together.

## Run locally
Requires **Node.js 20.18–24** (22 LTS recommended, and it's what Render uses via `.node-version`). Brand-new Node releases can break the database library until it publishes builds for them.
```bash
npm install
cp .env.example .env      # then add at least one AI key
npm start                 # → http://localhost:3000
```
To test it, leave Sam running and open a second terminal:
```bash
npm run test:smoke        # creates 2 test users, checks login, privacy, account features and AI replies
# To include the admin checks, pass an admin account:
SMOKE_ADMIN_USER=yourname SMOKE_ADMIN_PASS='your password' npm run test:smoke
# …or, on a brand-new Sam with no admin yet, the setup code from the server log:
SMOKE_ADMIN_SETUP_CODE=XXXX-XXXX-XXXX npm run test:smoke
```

## Becoming the admin
The first time Sam starts with no admin, it prints a line like this in the server log:
```
[sam] No admin yet. Admin setup code: ABCD-EFGH-JKLM
```
Log in to Sam, open **Settings → Become admin**, and enter the code. On Render, the log is on your service's **Logs** page. The code only works while Sam has no admin, and a new one is made at each restart until someone uses it. To pick your own code instead, set `ADMIN_SETUP_CODE`. After that, admins make other admins from the dashboard.

## Environment variables
| Variable | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | one AI key needed | Google Gemini |
| `ANTHROPIC_API_KEY` | | Claude |
| `OPENAI_API_KEY` | | OpenAI |
| `DEEPSEEK_API_KEY` | | DeepSeek (text only, can't read images) |
| `PROVIDER_ORDER` | no | The order Sam tries providers in. Default `gemini,anthropic,openai,deepseek` |
| `<PROVIDER>_MODEL_<FAST\|BALANCED\|DEEP>` | no | Overrides the model for a tier, e.g. `GEMINI_MODEL_DEEP` |
| `MAX_TOKENS` | no | Reply budget for Balanced (default 4000). Fast gets half, Deep gets double |
| `COUNCIL_CHAIR_SPEED` | no | Tier used to combine council answers (default `balanced`) |
| `AI_FIRST_TOKEN_TIMEOUT_MS` / `AI_REQUEST_TIMEOUT_MS` | no | How long Sam waits for a model before trying the next one. Defaults: first words within 30 s (Fast), 45 s (Balanced), 90 s (Deep); whole non-streamed answers within 60 / 90 / 150 s |
| `GUEST_MODE` | no | `0` turns guest mode off (default on) |
| `GUEST_DAILY_MESSAGES` / `GUEST_NETWORK_DAILY` / `GUEST_DAILY_TOTAL` | no | Guest allowances per day: per guest (default 10), per network (30) and for all guests together (300) |
| `GUEST_IDLE_MIN` | no | Minutes without a message before a guest chat is deleted (default 120) |
| `PROVIDER_STARTUP_TEST` | no | `0` turns off the automatic startup test of every model (default on, at most once every 6 hours, a few tokens per model) |
| `DATABASE_URL` | recommended on hosting | Postgres connection string (e.g. from Neon). When set, Sam stores everything there permanently. When empty, Sam uses `sam.sqlite` in `DATA_DIR` |
| `PG_POOL_MAX` | no | Max database connections (default 5) |
| `ADMIN_SETUP_CODE` | no | Your own one-time code for becoming the first admin (otherwise one is generated and logged) |
| `MODEL_PRICES` | no | JSON of USD prices per 1M tokens, e.g. `{"gemini-3.7-flash":[0.3,2.5]}`, so the admin dashboard can show costs |
| `AUTO_BACKUP` / `BACKUP_KEEP` | no | Daily automatic SQLite backup (default on) and how many backup files to keep (default 14) |
| `ALLOWED_ORIGINS` | rarely | Extra sites allowed to call the API |
| `SESSION_SECRET` | recommended | Long random string. If you leave it empty, Sam generates one and stores it in the database |
| `DATA_DIR` | no | Folder for `sam.sqlite` and local backups (SQLite only) |
| `CHAT_RATE_PER_MIN` | no | Messages allowed per user per minute (default 20) |
| `NODE_ENV` | on hosting | Set to `production` to turn on secure cookies and proxy trust |
| `TRUST_PROXY` | rarely | Force proxy trust when your host isn't detected automatically |

Old `.env` files still work. `OPENAI_MODEL` and `AI_MODEL` are still read.

## Deploy on Render
1. Push this repo to GitHub.
2. Create a free Postgres database (e.g. a Neon project, in the region closest to your Render service) and copy its connection string.
3. In Render, go to **New → Blueprint** and pick the repo. When Render asks, paste the connection string as `DATABASE_URL` and add your AI keys.
4. Open the service's **Logs**, copy the admin setup code, then register on the site and use **Settings → Become admin**.
5. Run the smoke test against it: `BASE_URL=https://your-app.onrender.com npm run test:smoke`

If a deploy fails with `was compiled against a different Node.js version`, the build cache holds packages built for another Node version. `npm install` now rebuilds the database library automatically (`postinstall`); if it ever happens anyway, use **Manual Deploy → Clear build cache & deploy**.

⚠️ **Without `DATABASE_URL`, Render's free plan loses everything** after 15 idle minutes or any deploy, because its disk is temporary. With `DATABASE_URL` set, nothing is lost. The free plan still sleeps when idle, so the first visit after a quiet spell takes about a minute.

## Backups and moving data
- **Download a full backup:** admin dashboard → Backups. You get one JSON file with every account (password *hashes*, never passwords), chat, memory, setting, assistant and prompt. Keep it private.
- **From your computer:** `npm run backup` writes the same file to `DATA_DIR/backups/` and keeps the newest 14. With `DATABASE_URL` set, this pulls a copy of the live database onto your machine.
- **Restore:** `npm run restore -- backups/sam-backup-….json` loads a backup into an **empty** database. It refuses to mix with existing accounts unless you add `--force`.
- **SQLite → Postgres:** run `npm run backup` without `DATABASE_URL`, then `DATABASE_URL=… npm run restore -- <that file>`.
- **Postgres history:** Neon also keeps its own point-in-time restore (6 hours on the free plan).
- **SQLite only:** Sam also copies `sam.sqlite` once a day to `DATA_DIR/backups/`. To restore one of those, stop Sam and copy it over `sam.sqlite`.

## Security notes
- API keys stay on the server and are never sent to the browser.
- Passwords are stored as bcrypt hashes. Sessions are httpOnly cookies, and the session ID changes at every login.
- Rate limits: login and register allow 20 tries per 15 minutes per IP. Chat allows 20 messages per minute per user. Everything else allows 300 requests per minute per IP.
- Every database query is scoped to the logged-in user, and the smoke test checks that one user can't read another's chats.
- Database connections to hosted Postgres use TLS with certificate checks.
- Still to come: two-factor login and an audit log of admin actions. See the roadmap.
