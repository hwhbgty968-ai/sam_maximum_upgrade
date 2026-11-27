# Sam roadmap

Each stage ships something that works on its own and gets tested before the next stage starts. Nothing existing gets deleted.

## ✅ Stage 1: reliable core (done)
- Login fixes: proxy trust (the cause of the "Please log in first" loop on Render), the session ID changes at every login, usernames work in any capitals, rate limits on auth, a session secret that survives restarts, and logout that always works.
- Multi-provider AI (Gemini, Claude, OpenAI, DeepSeek) with model discovery, Auto routing, Fast/Balanced/Deep modes, and fallback when a provider fails.
- Streaming replies with Stop, Sam Council, and a usage log.
- Health check, JSON errors for unknown API routes, a global error handler, backups, a multi-user smoke test, and `render.yaml`.

## Stage 2: platform foundations
- **Postgres option** (`DATABASE_URL`), so Render's free and managed databases work without a disk, plus a script to migrate an existing SQLite database.
- **Admin dashboard:** users, usage and cost per provider and model, provider health, and disabling abusive accounts. Admins are set with `ADMIN_USERNAMES`.
- Password change and reset, CSRF tokens, and an account deletion and data export button.
- Per-user daily budgets that the admin can set. They're there to stop abuse, not to ration normal use.
- Structured logs and a request ID shown on error messages.

## Stage 3: interface overhaul
- New layout: collapsible sidebar, search, pinned and renamed chats, folders and projects.
- Dark and light themes, a settings centre (appearance, voice, privacy, connected services, usage) and a profile page.
- File uploads: PDF, DOCX and text for Q&A, with storage on disk or S3-compatible storage.
- Keep the Sam branding and logo.

## Stage 4: tools
- **Image generation and editing:** Gemini image models and/or OpenAI images. This replaces the disabled button.
- **Research reports:** multi-step search, citations, and export to Doc/PDF.
- **Study Centre:** revision plans, quizzes, auto-marking with partial marks, progress tracking and recommendations.
- **Presentation Studio:** editable .pptx and PDF output with speaker notes, generated server-side.
- Documents, tasks, reminders and projects.
- **Integrations**, one at a time, each with real OAuth: Google (Drive, Docs, Slides, Calendar), then Microsoft 365, then Canva where its API allows it.
- Voice upgrade: server-side speech-to-text and text-to-speech for better voices. Video and audio generation, where provider APIs exist.

## Stage 5: Sam App Builder
1. Sam turns a description into a plan: pages, data model, auth and API.
2. Sam generates the files into an isolated project workspace, with version history kept as git commits.
3. A preview runs in a sandboxed container, with no access to Sam's own data or keys.
4. Sam runs automated checks, fixes what fails, and asks the user to approve important changes.
5. One-click deploy to a hosting provider using the user's own account (Render, Vercel, etc.).

This is the hardest part by a long way. Running untrusted generated code safely needs container isolation, which means a different hosting setup than a single Render web service. Plan for that before building it.

## Honest limits
- Every AI call costs money from the provider. Sam can be efficient (routing, caching, fallbacks), but it can never offer truly unlimited use.
- Integrations only count as done once they're connected with real credentials and tested.
