# Test API Handoff

Date: 2026-06-20
Branch: `master`
Latest local commit before this handoff: `afefcb9 Keep dashboard accounts active for live mod sockets`

## Current Setup

- Local repo: `C:\Humane\Hypixel\Test API`
- GitHub remote: `https://github.com/humane125/HypixelApi.git`
- RDP deploy path: `C:\Hypixel`
- RDP SSH target: `Administrator@23.26.77.96`
- SSH key on this PC: `%USERPROFILE%\.ssh\hypixel_rdp_ed25519`
- Current public API URL: `https://humane-hypixel.duckdns.org`
- Old ngrok URL is deprecated: `https://lazy-similarly-reaffirm.ngrok-free.dev`

Do not commit `.env`, `data/`, logs, real API keys, Discord webhooks, Discord user IDs, or `node_modules/`.

## What Happened

- The public endpoint was moved from ngrok to DuckDNS + Caddy:
  - DNS: `humane-hypixel.duckdns.org -> 23.26.77.96`
  - Caddy reverse proxies `https://humane-hypixel.duckdns.org` to `127.0.0.1:3000`.
  - Caddy obtained a Let's Encrypt certificate successfully.
  - Caddy was installed as a Windows service named `caddy` and verified running.
- `HypixelApi` scheduled task was stopped at one point, causing Caddy `502 Bad Gateway`.
- `HypixelApi` was started again and verified listening on `0.0.0.0:3000`.
- Public HTTPS returned `200` with dashboard title `Hypixel SkyBlock Control`.
- Public websocket handshake to `wss://humane-hypixel.duckdns.org/api/mod/ws` opened successfully.
- AutoAuction and Alt Manager configs in the 26.1.2 Prism instance were manually updated to the new DuckDNS base URL.
- Dashboard account active-state was fixed after websocket reconnect/duplicate-socket cases:
  - Dashboard account lists overlay live mod socket state for connected `active`/`hypixel` clients.
  - An old mod socket closing no longer marks the account offline if another live socket for the same account is still connected.
  - Explicit `offline` and `banned` mod status messages still display as offline/banned.
- Commit `afefcb9` was pushed to GitHub, `server.js` was copied to `C:\Hypixel`, `HypixelApi` was restarted, and public HTTPS returned `200`.

## Current Behavior

- Dashboard auth uses dashboard username/password.
- API keys are assigned to existing dashboard users and stored hashed.
- `/api/mod/ws` authenticates mod clients with an API key that has `mod:connect`.
- Mod websocket auth resolves Minecraft UUID from Mojang by username.
- Existing Minecraft accounts keep current ownership; another user's API key cannot steal ownership.
- Proxy lookup is Minecraft-account scoped.
- Status updates apply to the existing account row, so an account can show live status without changing owner folder.
- Dashboard account cards use live mod socket state when available, so reconnect races and duplicate sockets do not leave active accounts displayed as offline.
- Stale `active` and `hypixel` accounts display as `offline` after heartbeat timeout.
- Active timed bans are preserved through later updates until expiry.

## Connected Transfer Protocol

Client-to-server websocket messages include:

- `transfer_list`
- `transfer_invite`
- `transfer_accept`
- `transfer_decline`
- `transfer_cancel`
- `transfer_run`
- `transfer_buy_order_ready`
- `transfer_sell_offer_ready`
- `transfer_sell_offer_bought`
- `transfer_cycle_complete`

Server relays paired transfer messages only between the accepted sender and receiver session. Cycle completion relays receiver purse `before`, `after`, and `delta` back to the sender so the sender can loop until the target is reached.

Transfer sessions are memory-only. The API lists connected mod clients, rejects self-invites, offline targets, and busy accounts, and expires pending invites after 120 seconds.

## RDP Services

Check Caddy:

```powershell
sc.exe query caddy
```

Check API task:

```powershell
schtasks /Query /TN HypixelApi /V /FO LIST
netstat -ano | findstr :3000
```

Start API task if needed:

```powershell
schtasks /Run /TN HypixelApi
```

## Verification

Local repo:

```powershell
cd "C:\Humane\Hypixel\Test API"
npm test
npm run build
```

Public endpoint from PC:

```powershell
Invoke-WebRequest -Uri "https://humane-hypixel.duckdns.org/" -UseBasicParsing
```

WebSocket probe from PC:

```powershell
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]"wss://humane-hypixel.duckdns.org/api/mod/ws", [Threading.CancellationToken]::None).Wait(10000)
$ws.State
```

Expected state: `Open`.

## Deploy To RDP

Use explicit OpenSSH path if `ssh` is not in PATH:

```powershell
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
```

Deploy changed server files:

```powershell
& $scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\server.js" Administrator@23.26.77.96:C:/Hypixel/server.js
& $scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\auth-db.js" Administrator@23.26.77.96:C:/Hypixel/auth-db.js
& $scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\package.json" Administrator@23.26.77.96:C:/Hypixel/package.json
& $scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" "C:\Humane\Hypixel\Test API\package-lock.json" Administrator@23.26.77.96:C:/Hypixel/package-lock.json
& $scp -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" -r "C:\Humane\Hypixel\Test API\public" Administrator@23.26.77.96:C:/Hypixel/
```

Restart API:

```powershell
& $ssh -i "$env:USERPROFILE\.ssh\hypixel_rdp_ed25519" Administrator@23.26.77.96 "schtasks /Run /TN HypixelApi"
```

## Next Work

1. Make `HypixelApi` more robust as a service or scheduled task that auto-starts on boot and restarts after crashes.
2. Add dashboard visibility for connected mod clients, transfer session state, and last heartbeat.
3. Add a small admin/debug endpoint for connected mod sockets if more live-status issues appear.
4. Add better transfer error reporting and optional persistent transfer audit logs.
5. Keep the public URL standardized as `https://humane-hypixel.duckdns.org` in docs and runtime configs.
