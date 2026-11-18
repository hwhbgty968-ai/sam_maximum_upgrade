# Sam AI — Maximum Upgrade

A full-stack starter for Sam with:
- Real AI chat through the OpenAI API (server-side key; never put the key in browser code)
- Account registration and login
- Persistent chat history
- User-managed saved memories
- Browser speech-to-text and text-to-speech
- Responsive futuristic interface

## Requirements
- Node.js 18 or newer
- An OpenAI API key with API access/billing enabled

## Run it locally
1. Extract the ZIP.
2. Open a terminal in the `sam_maximum_upgrade` folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Put your API key in `.env` as `OPENAI_API_KEY=...`.
6. Replace `SESSION_SECRET` with a long random secret.
7. Run `npm start`.
8. Open http://localhost:3000

## Important
- The AI will not answer with a real model until you add your own API key.
- Keep `.env` private. Never publish your API key or commit `.env` to Git.
- This starter uses SQLite and Express's default in-memory session store. For a public production deployment, use a persistent database, a production session store, HTTPS, backups, account recovery, CSRF protection, stronger abuse controls, and review privacy/legal requirements.
- The microphone and speech features depend on browser support and permissions. Speech recognition is commonly best supported in Chromium-based browsers.
- Saved memories are notes you add yourself. You can view and delete them in the Memory tab.
- Do not use a weak or shared password. This starter is a foundation, not a security-audited commercial service.

## Deploy online
Deploy the project to a Node.js hosting provider. Set the environment variables in that provider's secret/environment settings (do not upload `.env`). Attach persistent storage for `sam.sqlite`, configure HTTPS, and replace the default session store before exposing it publicly.
