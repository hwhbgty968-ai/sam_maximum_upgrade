# Ezer architecture and technical decisions

Ezer is the platform; Sam is its built-in AI assistant. Code, routes, tables and cookies keep their original `sam` names on purpose.

## Layout
```
server.js            Express app: middleware, routes, startup
lib/db.js            Database layer: Postgres (DATABASE_URL) or SQLite, one async API, additive migrations
lib/session-store.js Login sessions stored in Sam's own database
lib/backup.js        Full JSON backup + restore (works across engines)
lib/ai.js            AI providers, routing, fallback, streaming, Sam Council
lib/search.js        Web search + article reading
lib/admin.js         Admin queries: users, usage, health, errors, backups
lib/guests.js        Guest mode: in-memory guest chats, daily allowances (guest / network / all), opt-in save
lib/credits.js       Plans and Sam Credits: prices, quotes, reserve → settle/cancel on a visible ledger, Max fair use, admin settings
lib/accounts.js      Account data: reset tokens, export, deletion
lib/log.js           Structured JSON logging + error log
public/index.html    Main app (vanilla JS)
public/admin.html    Admin dashboard
public/reset.html    Password reset page
scripts/             smoke-test.js (multi-user), backup.js, restore.js
docs/                ROADMAP.md, ARCHITECTURE.md
```

## How a chat message flows
1. Browser POSTs `/api/chat`, then reads Server-Sent Events (`status`, `model`, `delta`, `done` and `error` events).
2. `requireAuth` loads the user from the database, so disabled or deleted users are rejected on every request.
3. The server builds a system prompt (age, memories, mode) plus the last 20 messages of the chat.
4. `ai.routeCandidates()` picks the tier (fast, balanced or deep) and builds the try-order: the chosen model, then the same tier on every other usable provider, then the other tiers (`TIER_FALLBACK`). Providers whose key was rejected are left out; models cooling down after a failure go last. `ai.stream()` tries each candidate and only falls back if nothing has been streamed yet. Every failure is classified (`classifyError`: invalid_key, model_not_found, quota, rate_limit, outage, network, bad_request) and recorded in an in-memory health table; `describeFailure` turns the most useful error into a plain message. Live test results (`testProviders`) are stored in `app_settings.provider_tests` so a restart remembers them.
5. The answer is saved with the model name, and usage is logged.

## Decisions
| Decision | Why | Revisit when |
|---|---|---|
| All providers go through the **OpenAI SDK's compatible endpoints** | One code path for 4 providers; adding a provider is a few lines | Native-only features are needed, like Claude prompt caching or citations, or Gemini grounding |
| **Postgres when `DATABASE_URL` is set, SQLite otherwise** (v4.0) | Hosted Sam needs data that survives restarts (Neon free plan); running locally should need no setup | — |
| **One SQL dialect for both engines**: `?` placeholders, `datetime('now'[, '-1 day'])` (a matching function is created in Postgres), `lower(x)` for case-insensitive matches, `substr()` for dates | Every query is written once and tested on both | A query that truly needs engine-specific SQL → branch on `db.engine` in that one place |
| **All database calls are async**, and multi-step writes use `db.tx()` | Required by Postgres; on SQLite, other requests wait while a transaction is open so they can't join it by accident | — |
| **Migrations are additive only** (`addColumn`, `CREATE … IF NOT EXISTS`) | Old databases upgrade safely and running them twice is harmless | Never drop or rename columns. Add new ones and migrate the data |
| **Models are checked at startup** against each provider's real list | Model names change monthly; a wrong name shouldn't break chat | |
| **Vanilla JS frontend** | No build step while the core settles | Start of stage 3: move to a component framework before the redesign |
| **Sessions in Sam's own database** (`user_sessions`), httpOnly cookies, regenerated on login | Logins survive restarts on either engine | — |
| **Admin role stored in the database; first admin via a one-time setup code** from the server log | Only someone who can read the server's logs can become the first admin; no username race | Needing finer roles → add a permissions table |

## Adding things
- **New AI provider:** add an entry to `PROVIDERS` in `lib/ai.js` (env key, base URL, default models, vision support, token parameter name).
- **New chat mode:** add it to `MODES` in `server.js` and `MODE_PROMPTS`, then add a button with `data-tool="<mode>"` in `index.html`.
- **New table or column:** add it in **both** `migrateSqlite()` and `migratePostgres()` in `lib/db.js`, using `CREATE TABLE IF NOT EXISTS` or `db.addColumn()`. Add new tables to `TABLES` so backups include them.
- **New feature:** add checks to `scripts/smoke-test.js` that cover at least two users, including a check that user B can't see user A's data.

## Security rules
- API keys live only in env vars and are never sent to the browser.
- Every query on user data includes `user_id = ?` from the session. Admin routes are the only exception, and they check the role on the server.
- Errors shown to users never include stack traces. Those go to the error log with a request ID.
- Never weaken authentication just to make an error go away.
