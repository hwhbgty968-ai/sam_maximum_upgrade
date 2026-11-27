# Sam AI

Sam is a self-hosted AI assistant platform with its own backend, database, accounts and AI connections. No Base44 credits, no third-party builder.

## What works now (v3, stage 1)
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
- **Memories:** notes you write that Sam uses in every chat. You can view and delete them.
- **Voice:** speech input and spoken replies, using the browser's built-in speech features.
- **Usage log:** every AI call is recorded (`GET /api/usage`). Streamed token counts are estimates.

Image generation isn't connected yet, so that button is disabled. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Run locally
Requires **Node.js 20.18 or newer** (needed by the web-search library).
```bash
npm install
cp .env.example .env      # then add at least one AI key
npm start                 # → http://localhost:3000
```
To test it, leave Sam running and open a second terminal:
```bash
npm run test:smoke        # creates 2 test users, checks login, privacy and AI replies
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
`npm run backup` makes a safe copy of the database while Sam is running. Copies go to `DATA_DIR/backups/`, and the newest 14 are kept. To restore, stop Sam and copy a backup over `sam.sqlite`.

## Security notes
- API keys stay on the server and are never sent to the browser.
- Passwords are stored as bcrypt hashes. Sessions are httpOnly cookies, and the session ID changes at every login.
- Rate limits: login and register allow 20 tries per 15 minutes per IP. Chat allows 20 messages per minute per user. Everything else allows 300 requests per minute per IP.
- Every database query is scoped to the logged-in user, and the smoke test checks that one user can't read another's chats.
- Still to come: password reset, CSRF tokens, an admin dashboard, and 2FA. See the roadmap.
