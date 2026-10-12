# Rabbithole

YouTube as one categorized home screen. Each interest is a **lane**: two rows of video cards that scroll sideways together, ranked on its own so one binge can't bury your other interests. Searches are filed into the right lane by Claude, and new lanes are only created when you confirm.

Lanes are built server-side from the official **YouTube Data API v3**: your subscriptions (sorted into lanes by Claude, correctable by you), a few searches per lane, and local signals (clicks, watch time, likes). YouTube is never scraped, and nothing is ever posted to it.

## Setup

1. **Install:** `npm install` (Node 24.11, see `.nvmrc`). On Windows, if the install fails building `better-sqlite3` with "could not find any Visual Studio installation", use `npm ci --ignore-scripts`: the package ships a prebuilt Windows binary and nothing else needs install scripts.
2. **Google OAuth client** (one time, in [Google Cloud Console](https://console.cloud.google.com/)):
   - Create a project. Enable **YouTube Data API v3** (APIs & Services → Library).
   - **OAuth consent screen:** User type *External*, publishing status **Testing**. Add your own Google account under **Test users**. Add the scope `.../auth/youtube.readonly`.
   - **Credentials → Create credentials → OAuth client ID → Web application.** Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`.
   - Copy the client ID and secret.
3. **Configure:** `cp .env.example .env.local`, then fill in:
   - `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` from step 2
   - `AUTH_SECRET`: `openssl rand -base64 33`
   - `TOKEN_ENC_KEY`: `openssl rand -base64 32`
   - `ANTHROPIC_API_KEY` from the [Claude Console](https://platform.claude.com/)
4. **Run:** `npm run dev`, open http://localhost:3000, and sign in with Google. Choose **Set up lanes from my subscriptions**.

## Validation ("do first" checks)

| Check | How |
| --- | --- |
| OAuth with `youtube.readonly`, real channel-to-lane classification, quota per lane refresh | Sign in once in the app, then `npm run check:youtube` |
| Routing on 20 sample queries | `npm run eval:routing` (needs `ANTHROPIC_API_KEY`) |
| Unit tests: quota ceiling, refresh cost, ranking, router rules, token sealing, disconnect, CSRF, CSP | `npm test` |
| IFrame playback | Click any card; the modal uses the YouTube IFrame Player API |

**Quota model** (measured in `tests/server.test.ts` and live by `check:youtube`): a lane refresh costs 1 unit per channel in the lane (`playlistItems.list`), 1 unit per 50 videos (`videos.list`), and 100 units per lane search (`search.list`, at most 2 per lane, cached for 24 hours). A lane with 10 channels costs about 211 units on its first refresh of the day and about 11 after that. Every call is booked in `quota_log` *before* it is made, inside the same transaction as the check, so the day can never pass the 10,000-unit limit. Background refreshes stop at 10,000 − `YT_QUOTA_RESERVE` so searches still work; when quota is low, lanes show their cached videos.

## Architecture

- **Next.js 16 App Router** + React + Tailwind. `src/proxy.ts` sets a strict nonce-based CSP: images only from YouTube's image hosts, frames only from the YouTube player.
- **Auth.js** (Google, authorization-code flow, `youtube.readonly`). The session is an encrypted httpOnly cookie that holds only the user id. Google tokens are sealed with AES-256-GCM in SQLite and never reach the browser. **Disconnect** (Settings) revokes the grant and deletes every row stored for you.
- **Drizzle + SQLite** (`data/rabbithole.db`): `users`, `lanes`, `channel_lanes`, `feed_items`, `signals`, `routing_corrections`, `quota_log`, `search_cache`.
- **Server modules** (`src/server/`):
  - `tokens.ts`: auth tokens.
  - `lanes.ts`: lane service.
  - `youtube.ts` + `quota.ts`: the quota-aware YouTube client.
  - `ranker.ts`: ranking.
  - `router.ts` + `llm.ts`: search routing.
  - `search_cache`: the cache, in the database.
  - `http.ts`: validation, CSRF, rate limits.
- **Every API route** validates its input with zod, checks the session, requires a same-origin `Origin` plus the `x-rabbithole` header (CSRF), and is rate-limited per user.
- **Search routing:** Claude (`claude-opus-5-5` at low effort, structured JSON validated with zod) receives only the query and the lane ids, names and descriptions, plus your past corrections. It never receives tokens, history or account details. At confidence ≥ 0.7 the search is routed straight to a lane with a chip you can change. Below that, you pick from the top two lanes or "New lane". A proposed new lane is created only when you confirm it.

## Notes

- Videos play in YouTube's embedded player. Embedded plays may not count toward your YouTube watch history; each player has an **Open on YouTube** link.
- Videos under 60 seconds (a Shorts heuristic) are hidden by default; you can change this in Settings.
- Non-goals: scraping, ad blocking, downloads, fake engagement, posting to YouTube, mobile apps, monetization.
