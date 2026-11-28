# Sam AI

Sam is a self-hosted AI assistant platform with its own backend, database, accounts and AI connections. No Base44 credits, no third-party builder.

## What works now (v3.3)
- **Accounts:** register, log in and log out. Sessions last 30 days. Each user's chats and memories are private to them.
- **Multi-model AI:** Gemini, Claude, OpenAI and DeepSeek. Add whichever keys you have.
  - Model picker, or **Auto**, which picks a model by task.
  - **Fast / Balanced / Deep** speed modes.
  - If one provider fails, Sam tries the next one automatically.
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
- **Admin dashboard** at `/admin`, for anyone listed in `ADMIN_USERNAMES`:
  - Overview stats and system health
  - Users: search, disable/enable, and one-time password reset links
  - Usage and cost per day, provider and model
  - Model status for each AI provider
  - Error log with ref codes
  - Backups, with a "Back up now" button
- **Your account (Settings):** change password (this signs out your other devices), export all your data as JSON, delete your account.
- **Security:** blocks cross-site requests, signs out disabled users instantly, and puts a ref code on every error message that matches an entry in the error log.

Image generation isn't connected yet, so that button is disabled. See [docs/ROADMAP.md](docs/ROADMAP.md) for the full plan and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code fits together.

## Run locally
Requires **Node.js 20.18 or newer** (needed by the web-search library).
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
```

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
| `ADMIN_USERNAMES` | for `/admin` | Comma-separated usernames that get admin access. **Create the account first, then add its name.** |
| `MODEL_PRICES` | no | JSON of USD prices per 1M tokens, e.g. `{"gemini-3.7-flash":[0.3,2.5]}`, so the admin dashboard can show costs |
| `AUTO_BACKUP` / `BACKUP_KEEP` | no | Daily automatic backup (default on) and how many to keep (default 14) |
| `ALLOWED_ORIGINS` | rarely | Extra sites allowed to call the API |
| `SESSION_SECRET` | recommended | Long random string. If you leave it empty, Sam generates one and stores it in the database |
| `DATA_DIR` | on hosting | Folder for `sam.sqlite`. Point it at a persistent disk |
| `CHAT_RATE_PER_MIN` | no | Messages allowed per user per minute (default 20) |
| `NODE_ENV` | on hosting | Set to `production` to turn on secure cookies and proxy trust |
| `TRUST_PROXY` | rarely | Force proxy trust when your host isn't detected automatically |

Old `.env` files still work. `OPENAI_MODEL` and `AI_MODEL` are still read.

## Deploy on Render
1. Push this repo to GitHub.
2. In Render, go to **New → Blueprint** and pick the repo. `render.yaml` sets up the service, health check and a 1 GB disk at `/var/data`.
3. Enter your AI keys when Render asks for them.
4. Open the site, then run the smoke test against it: `BASE_URL=https://your-app.onrender.com npm run test:smoke`

⚠️ **Render's free plan has no persistent disk.** On it, every deploy or restart **wipes all accounts and chats**. Use a paid instance with the disk, or wait for the Postgres option planned for stage 2.

## Backups
Sam backs itself up automatically once a day. You can also run one from the admin dashboard, or with `npm run backup`. Copies go to `DATA_DIR/backups/`, and the newest 14 are kept. To restore, stop Sam and copy a backup over `sam.sqlite`.

## Security notes
- API keys stay on the server and are never sent to the browser.
- Passwords are stored as bcrypt hashes. Sessions are httpOnly cookies, and the session ID changes at every login.
- Rate limits: login and register allow 20 tries per 15 minutes per IP. Chat allows 20 messages per minute per user. Everything else allows 300 requests per minute per IP.
- Every database query is scoped to the logged-in user, and the smoke test checks that one user can't read another's chats.
- Still to come: two-factor login and an audit log of admin actions. See the roadmap.
