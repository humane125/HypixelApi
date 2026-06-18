# Test API Handoff

Date: 2026-06-18
Branch: `master`

## Current Setup

- Local repo: `C:\Humane\Hypixel\Test API`
- GitHub remote: `https://github.com/humane125/HypixelApi.git`
- RDP deploy path: `C:\Hypixel`
- Public API URL: `https://lazy-similarly-reaffirm.ngrok-free.dev`
- RDP SSH target: `Administrator@23.26.77.96`
- SSH key on this PC: `C:\Users\SoulP\.ssh\hypixel_rdp_ed25519`

Do not commit `.env`, `data/`, logs, real API keys, Discord webhooks, Discord user IDs, or `node_modules/`.

## Current Behavior

- Dashboard auth uses dashboard username/password only.
- API keys are assigned to existing dashboard users and are stored hashed.
- `/api/mod/ws` authenticates mod clients with an API key that has `mod:connect`.
- Mod websocket auth looks up the Minecraft UUID from Mojang by username.
- Existing Minecraft accounts keep their current `owner_user_id`; another user's API key cannot steal ownership.
- Proxy lookup is Minecraft-account scoped. A mod opening an existing account receives that account's configured proxy without changing ownership.
- Status updates still apply to the existing account row, so an account opened through another user's API key can show `active` or `hypixel` while staying in the original owner's folder.
- Stale `active` and `hypixel` accounts are displayed as `offline` after the heartbeat window.
- Active timed bans are preserved through later `active` and `offline` updates until expiry.
- Dashboard account folders are `All`, per-owner folders, and `Banned`.

## Connected Transfer Protocol

Client-to-server websocket messages:

- `transfer_list`
- `transfer_invite`
- `transfer_accept`
- `transfer_decline`
- `transfer_cancel`
- `transfer_run`
- `transfer_buy_order_ready`

Server-to-client websocket messages:

- `transfer_accounts`
- `transfer_invite`
- `transfer_pending`
- `transfer_accepted`
- `transfer_declined`
- `transfer_cancelled`
- `transfer_error`
- `transfer_run`
- `transfer_run_sent`
- `transfer_buy_order_ready`

Transfer sessions are memory-only. The API lists all currently connected mod clients, rejects self-invites, rejects offline targets, rejects busy accounts, expires pending invites after 120 seconds, and relays accepted-session automation messages between the paired sender and receiver.

`transfer_buy_order_ready` is the relay used after the receiver has created the buy order. It tells the sender to start the instant-sell step for the accepted session.

## Recent Changes

- Added connected transfer pairing over `/api/mod/ws`.
- Added transfer run relay from sender to receiver.
- Added receiver buy-order-ready relay from receiver to sender.
- Added API tests for connected listing, invite, accept, decline, cancel, offline, self-invite, busy-session, run, and buy-order-ready cases.
- Deployed `server.js` to the RDP at `C:\Hypixel` and restarted the `HypixelApi` scheduled task.
- Verified the public ngrok URL returned `200 OK` after restart.

## Verification

Run locally:

```powershell
npm test
npm run build
```

Latest local verification on 2026-06-18:

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
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\server.js" Administrator@23.26.77.96:C:/Hypixel/server.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\auth-db.js" Administrator@23.26.77.96:C:/Hypixel/auth-db.js
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\package.json" Administrator@23.26.77.96:C:/Hypixel/package.json
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\package-lock.json" Administrator@23.26.77.96:C:/Hypixel/package-lock.json
scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" -r "C:\Humane\Hypixel\Test API\public" Administrator@23.26.77.96:C:/Hypixel/
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

1. Continue the transfer loop after the receiver creates the sell offer by adding sender buy-back routing.
2. Add receiver sell-offer fill detection and sell-offer claim routing.
3. Add cycle state, stop conditions, and error recovery to the API session model if automation needs server-side coordination.
4. Add websocket reconnect/backoff support in the mod and keep transfer state coherent after reconnect.
5. Add dashboard visibility for connected mod clients, transfer session state, and last heartbeat time.
6. Add a dashboard warning before deleting an account with a live mod socket.
