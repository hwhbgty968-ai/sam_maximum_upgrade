# Sam architecture and technical decisions

## Layout
```
server.js            Express app: middleware, routes, startup
lib/db.js            SQLite connection + additive migrations + small helpers
lib/ai.js            AI providers, routing, fallback, streaming, Sam Council
lib/search.js        Web search + article reading
lib/admin.js         Admin queries: users, usage, health, errors, backups
lib/accounts.js      Account data: reset tokens, export, deletion
lib/log.js           Structured JSON logging + error log
public/index.html    Main app (vanilla JS)
public/admin.html    Admin dashboard
public/reset.html    Password reset page
scripts/             smoke-test.js (multi-user), backup.js
docs/                ROADMAP.md, ARCHITECTURE.md
```

## How a chat message flows
1. Browser POSTs `/api/chat`, then reads Server-Sent Events (`status`, `model`, `delta`, `done` and `error` events).
2. `requireAuth` loads the user from the database, so disabled or deleted users are rejected on every request.
3. The server builds a system prompt (age, memories, mode) plus the last 20 messages of the chat.
4. `ai.routeCandidates()` picks the tier (fast, balanced or deep) and the provider order. `ai.stream()` tries each candidate and only falls back if nothing has been streamed yet.
5. The answer is saved with the model name, and usage is logged.

## Decisions
| Decision | Why | Revisit when |
|---|---|---|
| All providers go through the **OpenAI SDK's compatible endpoints** | One code path for 4 providers; adding a provider is a few lines | Native-only features are needed, like Claude prompt caching or citations, or Gemini grounding |
| **SQLite** (better-sqlite3) | No separate database server, fast, simple backups | More than one server, or hosting without a persistent disk → move to Postgres |
| **Migrations are additive only** (`addColumn`, `CREATE … IF NOT EXISTS`) | Old databases upgrade safely and running them twice is harmless | Never drop or rename columns. Add new ones and migrate the data |
| **Models are checked at startup** against each provider's real list | Model names change monthly; a wrong name shouldn't break chat | |
| **Vanilla JS frontend** | No build step while the core settles | Start of stage 3: move to a component framework before the redesign |
| **Sessions in SQLite, httpOnly cookies, regenerated on login** | Simple and secure | Moving to Postgres → move sessions there too |
| **Admins come from the `ADMIN_USERNAMES` env var** | Nobody can make themselves admin through the app | Needing finer roles → add a permissions table |

## Adding things
- **New AI provider:** add an entry to `PROVIDERS` in `lib/ai.js` (env key, base URL, default models, vision support, token parameter name).
- **New chat mode:** add it to `MODES` in `server.js` and `MODE_PROMPTS`, then add a button with `data-tool="<mode>"` in `index.html`.
- **New table or column:** add it in `lib/db.js` using `CREATE TABLE IF NOT EXISTS` or `addColumn()`.
- **New feature:** add checks to `scripts/smoke-test.js` that cover at least two users, including a check that user B can't see user A's data.

## Security rules
- API keys live only in env vars and are never sent to the browser.
- Every query on user data includes `user_id = ?` from the session. Admin routes are the only exception, and they check the role on the server.
- Errors shown to users never include stack traces. Those go to the error log with a request ID.
- Never weaken authentication just to make an error go away.
