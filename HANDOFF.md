# Test API Handoff

Date: 2026-07-01
Branch: `master`
Latest local commit before this handoff: `b2cf301`

## Current Setup

- Local repo: `C:\Humane\Hypixel\Test API`
- GitHub remote: `https://github.com/humane125/HypixelApi.git`
- RDP deploy path: `C:\Hypixel`
- RDP SSH target: `Administrator@23.26.77.96`
- SSH key on this PC: `%USERPROFILE%\.ssh\hypixel_rdp_ed25519`
- Current public API URL: `https://humane-hypixel.duckdns.org`
- Old ngrok URL is deprecated: `https://lazy-similarly-reaffirm.ngrok-free.dev`

Do not commit `.env`, `data/`, logs, real API keys, Discord webhooks, Discord user IDs, or `node_modules/`.

## Test Later

Test the account wealth dashboard with real macro accounts after deploying API/dashboard and copying the latest AutoAuction jar:

- Open `/` and confirm macroing accounts sort above Hypixel accounts, then active accounts, then offline/banned accounts.
- Confirm `macroing` status badges/dots are purple and `hypixel` status badges/dots are orange.
- Confirm each account card shows compact wealth stats: purse, expected future value, held eyes, and lowest Final Destination armor kills.
- Open `/remote/<minecraft_uuid_or_username>` and confirm the detailed Account Wealth panel shows purse, sold auction credit, AH listings, held/listed eye values, expected future, current total, per-piece Final Destination kills, and recent sold/expired auction events.
- While Nebula combat macro is on, confirm macro rates appear on the remote page and show session-only kills/hour, mob coins/hour, eyes/hour, FD value/hour, and total coins/hour.
- Drop a Summoning Eye and confirm the account's held-eye count increments for that Minecraft account UUID.
- Switch accounts through Alt Manager, then switch back. The original account's eye count should still belong to that original Minecraft UUID.
- Create a Summoning Eye sell order and confirm held eyes move to listed eyes with the configured listed price.
- Instant-sell or claim sold eyes and confirm listed/held counts reduce.
- Refresh the auction index after an armor auction disappears:
  - before its end time: value should move into `estimatedPurse`
  - after its end time: value should disappear from expected value without increasing purse

## 2026-07-01 Changes

- Added the `macroing` account wealth state from the 2026-06-30 plan:
  - API persists macroing session baselines and latest samples in `minecraft_account_stats`.
  - Mod `account_stats` payloads can mark an account as macroing.
  - Dashboard treats live macroing accounts as their own status.
  - Macroing accounts sort first, then Hypixel, then active, then offline/banned.
  - Macroing status is purple; Hypixel status is orange.
  - Macroing rate baselines survive short macro-off gaps for 3 minutes. This covers lobby-collision switches, random Nebula interruptions, and manual stops; if macroing returns within 3 minutes, kills/hour and eyes/hour resume the same session. If it stays off longer than 3 minutes, the next macro-on starts a fresh baseline.
- Wealth totals were corrected:
  - `expectedCoins` is now future value only: active AH listed value + held/listed Summoning Eye value.
  - Current purse is shown separately.
  - `currentTotalCoins` is purse + sold auction credit.
  - `estimatedPurse` remains as a compatibility alias for current total.
- Remote account wealth panel now shows:
  - reported purse
  - sold auction credit
  - auction listings
  - held/listed eye values
  - expected future value
  - current total
  - macroing rates while macroing
  - recent auction sold/expired events
- Summoning Eye sell-order tracking now trusts the Bazaar sell-order quantity even if the eyes existed before the mod started tracking them.
- API tests and frontend build passed locally:
  - `npm test`
  - `npm run build`

Test the End lobby collision feature later with real AutoAuction macro instances. The API portion is pushed and deployed to the RDP, but the full behavior needs live mod verification.

Test scenario:

- Start multiple registered accounts across any owner/friend folders.
- Confirm each mod websocket authenticates.
- Confirm a mod can request `registered_accounts` and receive all registered Minecraft usernames, including offline/disconnected accounts.
- Let one account join an End lobby containing another registered account in tablist.
- Expected mod behavior is handled client-side: the newly arriving account should stop Nebula macro, run `/is`, then re-enable Nebula macro.

## Latest Changes

- Implemented account wealth stats API/dashboard slice:
  - `minecraft_account_stats` persists purse, Final Destination armor kills, held/listed Summoning Eyes, listed-eye price, and sold auction credit.
  - `minecraft_account_auction_snapshots` tracks active registered-account auctions by auction UUID.
  - Dashboard account responses now include `wealthStats`.
  - Dashboard websocket account refreshes include `wealthStats`.
  - Mod websocket accepts compact `account_stats` and `summoning_eye_event` messages.
  - Bazaar `SUMMONING_EYE` price is cached and used for held-eye valuation.
  - Auction disappearance reconciliation is now wired:
    - active/unexpired auction disappears before end time = sold, credit goes to `estimatedPurse`
    - disappears after end time = expired/unsold, no purse credit
  - Dashboard account cards render compact wealth stats.
  - Remote-control pages render the detailed Account Wealth panel.
- Account wealth commits:
  - `d629945 Persist account wealth stats`
  - `38364fa Compute account wealth stats`
  - `1802db3 Expose account wealth stats in dashboard accounts`
  - `6753ef0 Ingest mod account wealth stat events`
  - `edb7a31 Render account wealth stats`
- Verified locally:
  - `npm test`
  - `npm run build`

- Planned the account wealth-stats dashboard feature.
- Added docs:
  - `docs/superpowers/specs/2026-06-29-account-wealth-stats-design.md`
  - `docs/superpowers/plans/2026-06-29-account-wealth-stats.md`
- Selected UI direction is A+B:
  - compact wealth stats on each dashboard account card
  - detailed wealth stats on the account remote-control page
- Summoning Eye tracking must persist by Minecraft account UUID, not by Prism instance/socket. If Alt Manager switches Account A -> Account B -> Account A, Account A's eye count remains Account A's count.
- Bazaar pricing should be used for Summoning Eye valuation.
- Auction tracking rule:
  - active/unexpired auctions count in `ahListedValue`
  - if an auction disappears before its end time, treat it as sold, subtract it from expected AH value, and add its value to `estimatedPurse`
  - if an auction disappears after its end time, treat it as expired/unsold and remove it from expected value without increasing purse
  - expected future value is `ahListedValue + heldEyeValue + listedEyeValue`
- Planned storage additions:
  - `minecraft_account_stats` for purse, FD kills, eye counts, listed-eye price, and sold auction credit
  - `minecraft_account_auction_snapshots` for auction UUID, account ID, price, end time, last seen, and state
- Planned low-bandwidth mod behavior:
  - send changed stat events only
  - do not stream full logs/screenshots for this feature
  - use existing dashboard websocket for account stat updates
- Planning commits:
  - `3f869cd Document account wealth stats design`
  - `f779d44 Clarify wealth stats persistence and auction counting`
  - `c80af25 Plan account wealth stats implementation`
  - `75d6d31 Clarify auction sale credit accounting`

- Added authenticated mod websocket request/response:
  - Client sends `{ "type": "registered_accounts" }`.
  - Server replies with `{ "type": "registered_accounts", "accounts": [...] }`.
- The account list is built from all registered Minecraft accounts in the dashboard database, across all owners/friends.
- Response includes:
  - `accountId`
  - `minecraftUuid`
  - `minecraftUsername`
  - `status`
- This is separate from `transfer_accounts`; transfer list still only shows connected clients.
- Added test: `mod websocket returns all registered account usernames on request`.
- Verified locally with `npm test`.
- Deployed to RDP:
  - Copied updated `server.js` to `C:\Hypixel\server.js`.
  - Restarted scheduled task `HypixelApi`.
  - Verified `netstat` listening on `0.0.0.0:3000` and dashboard root returned `HTTP 200`.

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
- Dashboard frontend was restyled locally and then deployed to the RDP.
- Dashboard landing route is now `/`; auctions are on `/auctions`.
- Dashboard session restore no longer flashes the login form while `/api/dashboard/me` is checking.
- Account cards now keep four cards per row on wide dashboard layouts.
- Account card `Connect` now opens a dedicated remote-control page instead of a modal.
- Remote-control routes use stable Minecraft account keys:
  - Dashboard-generated links use `/remote/<minecraft_uuid>`.
  - Manual URLs also resolve by UUID without dashes, Minecraft username, or old numeric dashboard ID for backward compatibility.
- The remote-control page layout was based on `C:\Humane\Website\src\pages\RemoteControl.tsx`; that old Website project was read-only and was not modified.
- Remote-control API/dashboard protocol shell was added and deployed:
  - Dashboard websocket can send `request_screenshot`.
  - API relays `request_screenshot` to the connected mod socket for that account.
  - Mod websocket can send `client_screenshot`.
  - Mod websocket can send `client_log`.
  - API stores remote-control state in memory and broadcasts `live_control_snapshot`, `live_control_update`, and `live_control_error` to dashboard websockets.
- Commits pushed and deployed after the older handoff:
  - `a960b44 Add dashboard live control shell`
  - `618ddc6 Route remote control to its own page`
  - `86acad0 Use account keys for remote control routes`
- RDP deployment copied updated `server.js` and `public/` to `C:\Hypixel`, triggered `HypixelApi`, and verified:
  - `https://humane-hypixel.duckdns.org/remote/LibraryOfStupid` returned `200`.
  - `https://humane-hypixel.duckdns.org/assets/index-C2OLYvYc.js` returned `200`.
  - RDP scheduled task `HypixelApi` status was `Running`.

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
- Dashboard links:
  - `/` shows the dashboard.
  - `/auctions` shows auction search.
  - `/remote/<minecraft_uuid_or_username>` shows the remote-control page for a registered account.
- Remote-control page currently shows:
  - account identity and status
  - large screenshot panel
  - screenshot refresh button
  - in-game/client log panel
  - disabled Send Action panel for the next protocol slice
- Remote-control data is memory-only. It resets when `HypixelApi` restarts.

## Remote Control Protocol

Dashboard to API websocket:

- `request_screenshot`

API to mod websocket:

- `request_screenshot`

Mod to API websocket:

- `client_screenshot`
- `client_log`

API to dashboard websocket:

- `live_control_snapshot`
- `live_control_update`
- `live_control_error`

Expected screenshot payload from mod:

```json
{
  "type": "client_screenshot",
  "imageMime": "image/jpeg",
  "imageBase64": "<base64 image>",
  "capturedAt": "2026-06-23T00:00:00.000Z"
}
```

Expected log payload from mod:

```json
{
  "type": "client_log",
  "level": "info",
  "message": "Handoff complete, new account is Username"
}
```

`level` may be `debug`, `info`, `warn`, or `error`. The API strips Minecraft color codes from `client_log.message` before sending it to dashboards.

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

Immediate next slice is account wealth-stats implementation from the committed plan:

1. Add API tests for persisted account stats defaults and updates.
2. Add API storage helpers in `auth-db.js`.
3. Add auction snapshot reconciliation:
   - refresh active auction snapshots while Hypixel API still returns them
   - disappeared before `end_ms` becomes sold credit in `estimatedPurse`
   - disappeared after `end_ms` becomes expired/unsold
4. Add calculation helper for `estimatedPurse`, `ahListedValue`, `heldEyeValue`, `listedEyeValue`, and `expectedCoins`.
5. Add mod event ingestion for purse, Final Destination kills, Summoning Eye drops, and eye sell/insta-sell clearing.
6. Add dashboard API/websocket payloads for compact account card stats and detailed remote page stats.
7. Render the selected A+B UI.
8. Verify with `npm test` and `npm run build`.

Remote-control backlog:

1. In AutoAuction mod, add websocket handling for API message `request_screenshot`.
2. Capture the Minecraft framebuffer when `request_screenshot` arrives.
3. Encode the capture as JPEG or PNG base64.
4. Send `client_screenshot` back over `/api/mod/ws`.
5. Add a small mod helper for sending `client_log` without leaking API keys or secrets.
6. Emit `client_log` for important events:
   - handoff complete
   - transfer started
   - transfer stopped/cancelled
   - buy order created
   - instant sell completed
   - sell order created
   - transfer cycle complete
   - purse before/after/delta
   - menu stuck/error state
7. Test from the dashboard:
   - open an account card with `Connect`
   - verify URL is `/remote/<minecraft_uuid>`
   - click `Refresh`
   - verify screenshot appears
   - trigger one mod event and verify it appears in In-game Logs without reloading

After screenshot/logs work:

1. Wire the disabled Send Action panel.
2. Add dashboard-to-API websocket message for remote actions.
3. Relay actions API-to-mod only for the selected connected account.
4. Support three action types:
   - server command, for example `/bz` or `/warp end`
   - normal chat message
   - client-side mod command/action
5. Add API tests for action relay and offline-account errors.
6. Add mod tests for command payload parsing and rejection of invalid action types.

Other backlog:

1. Make `HypixelApi` more robust as a service or scheduled task that auto-starts on boot and restarts after crashes.
2. Add dashboard visibility for connected mod clients, transfer session state, and last heartbeat.
3. Add a small admin/debug endpoint for connected mod sockets if more live-status issues appear.
4. Add better transfer error reporting and optional persistent transfer audit logs.
5. Keep the public URL standardized as `https://humane-hypixel.duckdns.org` in docs and runtime configs.
