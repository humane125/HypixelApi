# Handoff Notes

## Current Setup

- Local API repo on this machine: `C:\Projects\Hypixel\Test API`
- API repo path used on the RDP when deploying from there manually: `C:\Humane\Hypixel\Test API`
- RDP deploy path: `C:\Hypixel`
- Public ngrok URL: `https://lazy-similarly-reaffirm.ngrok-free.dev/`
- RDP SSH target: `Administrator@23.26.77.96`
- Dashboard login uses dashboard username/password only.
- API keys are for the mod and API requests only.
- API keys are assigned to existing dashboard users and stored hashed.
- Use this file as the canonical API handoff. Do not create `handoff2.md` for follow-up notes.

Do not commit real API keys, Discord webhooks, Discord user IDs, `.env`, `data/`, logs, or `node_modules/`.

## What Changed

- Fixed Minecraft account ownership stealing:
  - an existing Minecraft UUID keeps its current `owner_user_id` when opened by another dashboard user's mod/API key
  - ownership only changes if the account row is deleted first, then another user opens that Minecraft account and creates a fresh row
  - proxy lookup is now Minecraft-account scoped so the mod can fetch that account's configured proxy without reassigning ownership
- Added tests covering the Humane-owned `Rivoh89` opened by Edzioo case.
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
- WebSocket auth fetches UUID from Mojang by username and creates a new Minecraft account under the API-key owner only when the UUID does not already exist.
- Existing Minecraft account rows preserve their owner when the same account is opened by another API-key user.
- Heartbeats update `last_seen_at`; stale active accounts are shown as `offline`.
- WebSocket account registration validates that an account row exists before using `account.id`.
- Authenticated accounts are marked offline when the mod WebSocket closes.
- Live-account deletion is handled cleanly with an `account_deleted` socket error.

## RDP SSH Status

OpenSSH is already enabled on the RDP from a previous machine setup. Codex can auto-update the RDP with `ssh`/`scp` once this PC's public key is added to the existing Administrator authorized keys file.

Keep these commands only as a recovery checklist if the RDP is rebuilt or SSH stops working:

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}
```

The VPS/RDP provider firewall must also allow inbound TCP port `22` to `23.26.77.96`.

For Administrator key login, Windows OpenSSH reads:

```text
C:\ProgramData\ssh\administrators_authorized_keys
```

If this PC cannot connect, paste this PC's public key into that file and then fix permissions:

```powershell
New-Item -ItemType Directory -Force C:\ProgramData\ssh
New-Item -ItemType File -Force C:\ProgramData\ssh\administrators_authorized_keys
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F"
icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "SYSTEM:F"
Restart-Service sshd
```

## SSH Key Setup On This PC

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
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\server.js" Administrator@23.26.77.96:C:/Hypixel/server.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\auth-db.js" Administrator@23.26.77.96:C:/Hypixel/auth-db.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\package.json" Administrator@23.26.77.96:C:/Hypixel/package.json
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Projects\Hypixel\Test API\package-lock.json" Administrator@23.26.77.96:C:/Hypixel/package-lock.json
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" -r "C:\Projects\Hypixel\Test API\public" Administrator@23.26.77.96:C:/Hypixel/
```

Start/restart Node through a scheduled task. Direct `Start-Process` from SSH can be killed when the SSH session exits on this RDP.

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

Verify Node is running:

```powershell
ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "powershell -NoProfile -Command `"Get-CimInstance Win32_Process -Filter 'name = ''node.exe''' | Select-Object ProcessId,CommandLine,CreationDate`""
Invoke-WebRequest -UseBasicParsing -Uri "https://lazy-similarly-reaffirm.ngrok-free.dev/" -Headers @{ "ngrok-skip-browser-warning" = "true" }
```

## Verification Used

```powershell
npm test
npm run build
```

`npm test` passed after the ownership/proxy fix. Run `npm run build` before deploying any frontend changes.

## Next Work

1. Add reconnect/backoff behavior for the mod socket if the API server or ngrok tunnel restarts.
2. Add dashboard UI for connected mod clients and last heartbeat times.
3. Add a dashboard warning before deleting an account that currently has a live mod socket.
4. Decide whether banned-folder timing should stay at 8 hours or become configurable.
