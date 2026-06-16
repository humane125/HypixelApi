# Handoff Notes

## Current Setup

- API repo: `C:\Humane\Hypixel\Test API`
- RDP deploy path: `C:\Hypixel`
- Public ngrok URL: `https://lazy-similarly-reaffirm.ngrok-free.dev/`
- RDP SSH target: `Administrator@23.26.77.96`
- Dashboard login uses dashboard username/password only.
- API keys are for the mod and API requests only.
- API keys are assigned to existing dashboard users and stored hashed.

Do not commit real API keys, Discord webhooks, Discord user IDs, `.env`, `data/`, logs, or `node_modules/`.

## What Changed

- Added Minecraft account foldering in the dashboard:
  - accounts are grouped by owning dashboard user
  - banned accounts appear in the Banned folder after 8 hours
  - owner/manager users can manually move a banned account to the Banned folder sooner
- Added `banned_foldered_at` database migration and folder metadata in account list responses.
- Added `POST /api/dashboard/accounts/banned-folder` for manual banned-folder moves.
- Updated the React dashboard with folder tabs: `All`, per-owner folders, and `Banned`.
- Added server-side WebSocket disconnect broadcast when a mod reports an account as banned.
- Added a live-account deletion guard: if a dashboard user deletes an account while that mod is still connected, the socket gets an `account_deleted` error and closes cleanly instead of crashing the API.
- Rebuilt the React frontend into `public/`.

Older completed work still in place:

- SQLite-backed dashboard/auth storage in `auth-db.js`.
- Owner/manager/viewer dashboard roles.
- React dashboard and React auction search UI.
- Mineatar avatars for Minecraft account cards.
- `/api/mod/ws` WebSocket endpoint for Minecraft mod connections.
- Mod WebSocket auth requires an API key with `mod:connect`.
- WebSocket auth fetches UUID from Mojang by username and creates/updates the Minecraft account under the API-key owner.
- Heartbeats update `last_seen_at`; stale active accounts are shown as `offline`.

## SSH Key Setup On A New PC

Create a local deploy key on the new PC:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh"
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" -C "hypixel-rdp-deploy"
Get-Content "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519.pub"
```

Paste the printed public key into this file on the RDP:

```text
C:\ProgramData\ssh\administrators_authorized_keys
```

Because the login is `Administrator`, Windows OpenSSH uses `administrators_authorized_keys`, not the normal per-user `authorized_keys` file. Make sure the file has no `.txt` extension.

Set permissions on the RDP:

```powershell
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F"
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "SYSTEM:F"
```

Test from the new PC:

```powershell
ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "echo ok"
```

## Deploy To RDP

From the API repo after pulling latest and running the build:

```powershell
npm install
npm test
npm run build

ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "powershell -NoProfile -Command `"Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force`""
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\server.js" Administrator@23.26.77.96:C:/Hypixel/server.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\auth-db.js" Administrator@23.26.77.96:C:/Hypixel/auth-db.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" -r "C:\Humane\Hypixel\Test API\public" Administrator@23.26.77.96:C:/Hypixel/
ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "powershell -NoProfile -Command `"Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'C:\Hypixel' -WindowStyle Hidden`""
```

Verify Node is running:

```powershell
ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "cmd /c tasklist ^| findstr node"
```

## Verification Used

```powershell
npm test
npm run build
```

Both passed before this handoff.

## Next Work

1. Add reconnect/backoff behavior for the mod socket if the API server or ngrok tunnel restarts.
2. Add dashboard UI for connected mod clients and last heartbeat times.
3. Add a dashboard warning before deleting an account that currently has a live mod socket.
4. Decide whether banned-folder timing should stay at 8 hours or become configurable.
