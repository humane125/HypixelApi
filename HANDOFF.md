# Test API Handoff

Date: 2026-06-17
Branch: `master`
Latest commit at handoff creation: `6301933`

## Current Setup

- Local repo: `C:\Projects\Hypixel\Test API`
- GitHub remote: `https://github.com/humane125/HypixelApi.git`
- RDP deploy path: `C:\Hypixel`
- Public API URL: `https://lazy-similarly-reaffirm.ngrok-free.dev`
- RDP SSH target: `Administrator@23.26.77.96`
- SSH key on this PC: `C:\Users\moham\.ssh\hypixel_rdp_ed25519`

Do not commit `.env`, `data/`, logs, real API keys, Discord webhooks, Discord user IDs, or `node_modules/`.

## Current Behavior

- Dashboard auth uses dashboard username/password only.
- API keys are assigned to existing dashboard users and are stored hashed.
- `/api/mod/ws` authenticates mod clients with an API key that has `mod:connect`.
- Mod websocket auth looks up the Minecraft UUID from Mojang by username.
- Existing Minecraft accounts keep their current `owner_user_id`; another user's API key cannot steal ownership.
- If a Minecraft account row is deleted, the next user who opens that account through the mod creates a fresh row and becomes owner.
- Proxy lookup is Minecraft-account scoped. A mod opening an existing account receives that account's configured proxy without changing ownership.
- Status updates still apply to the existing account row, so a Humane-owned account opened by Edzioo can show `active` or `hypixel` while staying in Humane's folder.
- Stale `active` and `hypixel` accounts are displayed as `offline` after the heartbeat window.
- Active timed bans are preserved through later `active` and `offline` updates until expiry.
- Dashboard account folders are `All`, per-owner folders, and `Banned`.

## Recent Changes

- Fixed ownership stealing in `auth-db.js`.
- Changed proxy lookup from API-key-owner scoped to Minecraft-account scoped.
- Added regression tests for:
  - ownership not transferring when another user opens an existing account
  - proxy settings staying attached to that account
  - `active` and `hypixel` statuses showing on the existing owner account
- Removed stale `handoff2.md`; this file is now the canonical handoff.
- Deployed the runtime `auth-db.js` fix to the RDP at `C:\Hypixel`.

## Verification

Run locally:

```powershell
npm test
npm run build
```

Last local verification before this handoff:

- `npm test` passed.

Use `npm run build` before deploying frontend changes.

## Deploy To RDP

The RDP already has OpenSSH server enabled. Direct `Start-Process` from SSH can be killed when the SSH session exits, so start Node through the scheduled task below.

From this repo:

```powershell
npm install
npm test
npm run build

ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "powershell -NoProfile -Command `"Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force`""
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\server.js" Administrator@23.26.77.96:C:/Hypixel/server.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\auth-db.js" Administrator@23.26.77.96:C:/Hypixel/auth-db.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\package.json" Administrator@23.26.77.96:C:/Hypixel/package.json
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\package-lock.json" Administrator@23.26.77.96:C:/Hypixel/package-lock.json
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" -r "C:\Projects\Hypixel\Test API\public" Administrator@23.26.77.96:C:/Hypixel/
```

Start/restart the RDP Node process:

```powershell
$remoteStart = @'
$ErrorActionPreference = 'Continue'
$cmd = @"
@echo off
cd /d C:\Hypixel
"C:\Program Files\nodejs\node.exe" server.js >> C:\Hypixel\server.out.log 2>> C:\Hypixel\server.err.log
"@
Set-Content -Path 'C:\Hypixel\start-server.cmd' -Value $cmd -Encoding ASCII
schtasks /End /TN HypixelApi 2>$null | Out-Null
schtasks /Delete /TN HypixelApi /F 2>$null | Out-Null
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
schtasks /Create /TN HypixelApi /SC ONCE /ST 23:59 /TR 'C:\Hypixel\start-server.cmd' /RL HIGHEST /F
schtasks /Run /TN HypixelApi
Start-Sleep -Seconds 3
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Select-Object ProcessId,CommandLine,CreationDate
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteStart))
ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "powershell -NoProfile -EncodedCommand $encoded"
```

Verify:

```powershell
ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "powershell -NoProfile -Command `"Get-CimInstance Win32_Process -Filter 'name = ''node.exe''' | Select-Object ProcessId,CommandLine,CreationDate`""
Invoke-WebRequest -UseBasicParsing -Uri "https://lazy-similarly-reaffirm.ngrok-free.dev/" -Headers @{ "ngrok-skip-browser-warning" = "true" }
```

## Next Work

1. Add AutoAuction websocket reconnect/backoff after API or ngrok restarts.
2. Add dashboard visibility for connected mod clients and last heartbeat time.
3. Add a dashboard warning before deleting an account with a live mod socket.
4. Consider making banned-folder delay configurable.
