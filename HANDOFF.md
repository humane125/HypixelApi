# Handoff Notes

## What Changed

- Added SQLite-backed dashboard/auth storage in `auth-db.js`.
- Added dashboard username/password sessions separate from API keys.
- Added owner/manager/viewer roles.
- API keys are assigned only to existing dashboard users and are stored hashed.
- Added React dashboard and React auction search UI.
- Added Mineatar avatars for Minecraft account cards.
- Hardened authentication:
  - login throttling for repeated failed dashboard logins
  - `Secure` dashboard cookies when HTTPS/ngrok is detected or forced by env
  - query-string API keys limited to SSE endpoints only
- Added `/api/mod/ws` WebSocket endpoint for Minecraft mod connections.
- Mod WebSocket auth requires an API key with `mod:connect`.
- WebSocket auth fetches UUID from Mojang by username and creates/updates the Minecraft account under the API-key owner.
- Heartbeats update `last_seen_at`; stale active accounts are shown as `offline`.

## Important Runtime Notes

- Default server URL is `http://localhost:3000`.
- Current ngrok URL is `https://lazy-similarly-reaffirm.ngrok-free.dev/`.
- Use dashboard username/password for dashboard access.
- Use API keys for mod/API access.
- Recommended production env:

```text
DASHBOARD_COOKIE_SECURE=true
DATABASE_PATH=data/app.db
```

- First-run credentials/API keys may be printed once in the server console if no DB users/keys exist.
- `data/`, `.env`, logs, and `node_modules/` are intentionally ignored.

## Verification Used

```powershell
npm test
npm run build
npm audit --omit=dev
```

All passed before this handoff.

## Next Work

1. Add ban detection command handling:
   - mod sends `{ "type": "ban_detected", "reason": "..." }`
   - server marks that account `banned`
   - server broadcasts a disconnect command to other connected mods
2. Add live dashboard updates over WebSocket or SSE so account cards update without reload.
3. Add dashboard UI for connected mod clients and last heartbeat times.
4. Consider persistent login throttle storage if the public ngrok deployment needs lockout state to survive restarts.
