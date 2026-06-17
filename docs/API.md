# Auction Service API

Base URL examples:

```text
https://lazy-similarly-reaffirm.ngrok-free.dev
```

All JSON endpoints return JSON. The refresh endpoint returns Server-Sent Events.

## Authentication

This service does not need a Hypixel API key for its current auction data fetches.

API access is controlled by database-backed API keys. API keys are for mods, external scripts, and auction API calls.

Pass API keys with:

```http
Authorization: Bearer hpx_live_your_key
```

Legacy clients can still send:

```http
X-Auction-Token: your-token
```

For Server-Sent Events through browser `EventSource`, query-string token support remains available only on stream endpoints such as `/api/index/refresh` and legacy `/api/scan`:

```text
?token=your-token
```

Normal JSON endpoints reject query-string API keys. Use headers for those requests because URLs can leak into logs and browser history.

First-run bootstrap:

- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` seed the first owner dashboard login.
- `OWNER_API_KEY` seeds the first owner API key.
- `AUCTION_API_TOKEN` is accepted as a backwards-compatible API bootstrap key.
- If no dashboard login is configured and the database has no password users, the server prints a first-run dashboard password on startup.
- If no API bootstrap key is configured and the database has no API keys, the server prints a one-time generated owner API key on startup.
- Dashboard login has in-memory throttling for repeated failed attempts.
- `DASHBOARD_COOKIE_SECURE=true` forces `Secure` on dashboard cookies. The server also enables it automatically when the request has `X-Forwarded-Proto: https`.

Scopes:

- `admin`: manage API keys.
- `auction:read`: call auction/search/recommend/usernames APIs.
- `accounts:read`: view registered Minecraft accounts.
- `accounts:write`: create accounts and update account status.
- `mod:connect`: connect the Minecraft mod WebSocket and register heartbeat status.

Dashboard roles:

- `owner`: create/delete dashboard users, assign roles, manage API keys, and create/update/delete Minecraft accounts.
- `manager`: create/update Minecraft accounts.
- `viewer`: view dashboard data only.

The dashboard renders registered Minecraft account avatars with Mineatar:

```text
https://api.mineatar.io/face/<uuid>?scale=8&overlay=true&format=png
```

## Cache Model

The service keeps an in-memory index of active BIN auctions.

Current implementation:

- Fetches Hypixel page `0`.
- If top-level `lastUpdated` is unchanged, keeps the current cache.
- If changed or cache is empty, fetches all auction pages.
- Normalizes all BIN auctions into searchable records.
- Cache is lost when the Node process restarts.

Live API observation:

- Active auctions are sorted by per-auction `last_updated` descending.
- `claimed` exists on active auctions but is normally `false` in active pages.
- Hypixel also exposes `/v2/skyblock/auctions_ended`, which can be used later for incremental removals.

## Normalized Auction Shape

Search and recommendation responses return normalized auction objects:

```json
{
  "uuid": "auction uuid",
  "auctioneer": "seller uuid",
  "itemUuid": "item uuid if present",
  "displayName": "Ancient Final Destination Chestplate",
  "item_name": "Ancient Final Destination Chestplate",
  "baseName": "Final Destination Chestplate",
  "baseKey": "final destination chestplate",
  "rarity": "LEGENDARY",
  "tier": "LEGENDARY",
  "category": "armor",
  "price": 30000000,
  "reforge": "Ancient",
  "stars": 0,
  "kills": 28359,
  "recomb": false,
  "enchants": {
    "Growth": 5,
    "Protection": 5
  },
  "endsAt": 1781200000000,
  "raw_lore": "Minecraft colored lore",
  "cleanLore": "Plain lore"
}
```

## `GET /api/index/status`

Returns current cache status.

Example:

```powershell
Invoke-WebRequest -UseBasicParsing 'http://localhost:3001/api/index/status'
```

Response:

```json
{
  "ready": true,
  "refreshing": false,
  "lastUpdated": 1781037832246,
  "totalPages": 45,
  "totalAuctions": 44706,
  "indexedBinCount": 41601,
  "ageMs": 20496
}
```

## `GET /api/index/refresh`

Refreshes the shared in-memory index and streams progress as Server-Sent Events.

Browser/EventSource example:

```js
const events = new EventSource('/api/index/refresh');
events.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};
```

Event types:

```json
{ "type": "status", "message": "Checking Hypixel auction update state..." }
```

```json
{ "type": "init", "totalPages": 45, "totalAuctions": 44706, "lastUpdated": 1781037832246 }
```

```json
{ "type": "progress", "completedPages": 12, "totalPages": 45, "indexedBinCount": 11022 }
```

```json
{ "type": "done", "source": "fresh", "status": { "ready": true } }
```

`source` is usually:

- `fresh`: fetched and rebuilt from Hypixel.
- `cache`: current cache was already fresh.

## `POST /api/search`

Searches the shared index.

Example:

```powershell
$body = @{
  query = 'Final Destination Chestplate'
  filters = @{
    category = 'armor'
    minKills = 25000
    maxKills = 31000
    recomb = $false
  }
  sort = 'price_asc'
  limit = 10
} | ConvertTo-Json -Depth 5

Invoke-WebRequest -UseBasicParsing 'http://localhost:3001/api/search' `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body
```

Request:

```json
{
  "query": "Final Destination Chestplate",
  "filters": {
    "rarity": ["LEGENDARY", "MYTHIC"],
    "category": "armor",
    "minKills": 25000,
    "maxKills": 31000,
    "recomb": false,
    "enchants": {
      "Growth": 5,
      "Protection": 5
    },
    "minStars": 0,
    "reforge": "any",
    "minPrice": 0,
    "maxPrice": 30000000
  },
  "sort": "price_asc",
  "limit": 25
}
```

Supported filters:

- `rarity`: string or array, for example `LEGENDARY`, `MYTHIC`.
- `category`: for example `armor`.
- `minKills`, `maxKills`
- `recomb`: `true` or `false`.
- `enchants`: object where values are minimum levels.
- `minStars`
- `stars`: exact star count.
- `reforge`: exact reforge name, `none`, or `any`.
- `minPrice`, `maxPrice`

Supported sort values:

- `price_asc`
- `price_desc`
- `kills_asc`
- `kills_desc`
- `ending_soon`

Response:

```json
{
  "cache": {
    "ready": true,
    "refreshing": false,
    "lastUpdated": 1781037832246,
    "totalPages": 45,
    "totalAuctions": 44706,
    "indexedBinCount": 41601,
    "ageMs": 20496
  },
  "source": "cache",
  "results": []
}
```

## `POST /api/recommend-bin`

Calculates a suggested BIN price.

This is tuned for Final Destination armor. It uses exact `baseName` matching and optional attributes.

Example:

```powershell
$body = @{
  baseName = 'Final Destination Chestplate'
  attributes = @{
    minKills = 25000
    maxKills = 31000
    recomb = $false
  }
  limit = 10
} | ConvertTo-Json -Depth 5

Invoke-WebRequest -UseBasicParsing 'http://localhost:3001/api/recommend-bin' `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body
```

Request:

```json
{
  "baseName": "Final Destination Chestplate",
  "attributes": {
    "minKills": 25000,
    "maxKills": 31000,
    "recomb": false,
    "enchants": {
      "Growth": 5
    },
    "stars": 0,
    "rarity": "LEGENDARY"
  },
  "limit": 10
}
```

Recommendation rules:

1. Find comparable listings for the same `baseName`.
2. Respect exact `minKills` / `maxKills` if provided.
3. If `recomb: true`, only recombed listings match.
4. If `recomb: false`, recombed listings can still be used as comparables, but their added recomb value is deducted.
5. Apply undercut:
   - `-500,000` if lowest comparable is under `25,000,000`.
   - `-1,000,000` if lowest comparable is `25,000,000` or higher.
6. Deduct upgrade value from the comparable listing if your item does not have that upgrade:
   - `-2,500,000` if comparable is recombed and request has `recomb: false`.
   - `-1,000,000` if comparable has an ultimate enchant and request does not.
7. Apply max cap after deductions:
   - If adjusted recommendation is still above `30,000,000`, cap it to `30,000,000`.
8. Low-market guard:
   - One listing under `17,000,000` is treated as an outlier and returns `20,000,000`.
   - A cluster of at least 3 listings near `17,000,000` is trusted and undercut normally.
9. Final Destination 25k fallback:
   - If a Final Destination armor request is for `25,000`+ kills and no exact comparable is found, the fallback recommendation will not go below `25,000,000`.
   - This prevents cheap `0` kill base listings from dragging 25k armor recommendations down.

Example:

```text
lowest comparable = 44m, recombed, has Refrigerate
request item = clean / not recombed / no ultimate enchant
44m - 1m undercut - 2.5m recomb - 1m ultimate = 39.5m
39.5m is over 30m, so recommendedPrice = 30m
```

Response:

```json
{
  "cache": { "ready": true },
  "source": "cache",
  "recommendedPrice": 30000000,
  "basis": "exact_comparable",
  "comparables": [],
  "baseline": {
    "count": 5,
    "median": 32000000,
    "trimmedAverage": 33000000,
    "floor": 28800000
  },
  "rulesRelaxed": [],
  "warnings": [
    "Comparable listing is recombed but priced item is not; subtracting 2.5m.",
    "Comparable listing has an ultimate enchant but priced item does not; subtracting 1m.",
    "Recommendation capped at 30m after upgrade deductions because the adjusted lowest BIN is still high."
  ]
}
```

## `POST /api/usernames`

Resolves Minecraft UUIDs to usernames through Mojang APIs.

Requires `auction:read`.

Request:

```json
[
  "uuid1",
  "uuid2"
]
```

Response:

```json
{
  "uuid1": "PlayerName",
  "uuid2": "OtherName"
}
```

## Dashboard API

Dashboard endpoints use username/password login and an HTTP-only `dashboard_session` cookie. They do not accept API keys.

### `POST /api/dashboard/login`

Request:

```json
{
  "username": "owner",
  "password": "your dashboard password"
}
```

Response sets the `dashboard_session` cookie:

```json
{
  "user": {
    "id": 1,
    "username": "owner",
    "role": "owner"
  },
  "expiresAt": "2026-06-22T10:31:56.507Z"
}
```

### `POST /api/dashboard/logout`

Revokes the current dashboard session cookie.

### `GET /api/dashboard/me`

Returns the authenticated dashboard user and session metadata.

### `GET /api/dashboard/accounts`

Requires a dashboard session. All dashboard roles can read accounts.

Response:

```json
{
  "accounts": [
    {
      "id": 1,
      "label": "RDP Main",
      "minecraft_uuid": "00000000-0000-0000-0000-000000000001",
      "minecraft_username": "PlayerOne",
      "status": "active",
      "notes": "",
      "ban_reason": null,
      "banned_at": null,
      "owner_username": "owner"
    }
  ]
}
```

### `POST /api/dashboard/accounts`

Requires dashboard role `owner` or `manager`.

Request:

```json
{
  "label": "RDP Main",
  "minecraftUuid": "00000000-0000-0000-0000-000000000001",
  "minecraftUsername": "PlayerOne",
  "notes": "primary account"
}
```

### `POST /api/dashboard/accounts/status`

Requires dashboard role `owner` or `manager`.

Request:

```json
{
  "accountId": 1,
  "status": "banned",
  "banReason": "Detected ban screen"
}
```

### `POST /api/dashboard/accounts/delete`

Requires dashboard role `owner`.

Request:

```json
{
  "accountId": 1
}
```

Allowed statuses:

- `active`
- `offline`
- `locked`
- `banned`

### `POST /api/dashboard/accounts/proxy`

Requires dashboard role `owner` or `manager`.

Saves proxy settings for one Minecraft account. Dashboard account lists return proxy metadata, but never return `proxy_password`; use `proxy_has_password` to show whether a password is already stored.

Request:

```json
{
  "accountId": 1,
  "proxyEnabled": true,
  "proxyType": "SOCKS5",
  "proxyHost": "127.0.0.1",
  "proxyPort": 1080,
  "proxyUsername": "optional-user",
  "proxyPassword": "optional-password"
}
```

Response:

```json
{
  "account": {
    "id": 1,
    "minecraft_username": "PlayerOne",
    "proxy_enabled": 1,
    "proxy_type": "SOCKS5",
    "proxy_host": "127.0.0.1",
    "proxy_port": 1080,
    "proxy_username": "optional-user",
    "proxy_has_password": 1
  }
}
```

Supported proxy types:

- `SOCKS5`
- `SOCKS4`
- `HTTP`

### `GET /api/dashboard/api-keys`

Requires dashboard role `owner`.

Lists key metadata only. Raw keys are never returned after creation.

### `POST /api/dashboard/api-keys`

Requires dashboard role `owner`.

API keys can only be assigned to existing dashboard users with passwords. Create the dashboard user first, then pass that user's `id`.

Request:

```json
{
  "userId": 2,
  "name": "Friend mod key",
  "scopes": ["auction:read", "mod:connect"]
}
```

Response includes the raw key once:

```json
{
  "apiKey": {
    "id": 2,
    "name": "Friend mod key",
    "prefix": "hpx_live_ab",
    "scopes": ["auction:read", "mod:connect"],
    "rawKey": "hpx_live_..."
  }
}
```

### `POST /api/dashboard/api-keys/revoke`

Requires dashboard role `owner`.

Request:

```json
{
  "apiKeyId": 2
}
```

### `GET /api/dashboard/users`

Requires dashboard role `owner`.

Response:

```json
{
  "users": [
    {
      "id": 1,
      "username": "owner",
      "role": "owner",
      "has_password": 1,
      "created_at": "2026-06-15T10:31:56.507Z",
      "disabled_at": null
    }
  ]
}
```

### `POST /api/dashboard/users`

Requires dashboard role `owner`.

Request:

```json
{
  "username": "friend",
  "password": "at-least-8-characters",
  "role": "manager"
}
```

Allowed roles:

- `owner`
- `manager`
- `viewer`

### `POST /api/dashboard/users/role`

Requires dashboard role `owner`.

Request:

```json
{
  "userId": 2,
  "role": "viewer"
}
```

### `POST /api/dashboard/users/password`

Requires dashboard role `owner`.

Request:

```json
{
  "userId": 2,
  "password": "new-password"
}
```

### `POST /api/dashboard/users/delete`

Requires dashboard role `owner`.

The currently logged-in owner cannot delete their own active dashboard user from the same session.

Request:

```json
{
  "userId": 2
}
```

## Mod WebSocket

### `GET /api/mod/ws`

The Minecraft mod connects with WebSocket and authenticates in the first message. Do not put the API key in the URL.

The API key must include `mod:connect`.

Client auth message:

```json
{
  "type": "auth",
  "apiKey": "hpx_live_...",
  "username": "MinecraftName",
  "clientVersion": "1.0.0"
}
```

Server behavior:

1. Validates the API key and `mod:connect` scope.
2. Fetches the UUID from Mojang using `https://api.mojang.com/users/profiles/minecraft/<username>`.
3. Creates or updates the Minecraft account.
4. Assigns the account to the dashboard user that owns the API key.
5. Sets `last_connected_at`, `last_seen_at`, and `client_version`.

Success response:

```json
{
  "type": "auth_ok",
  "account": {
    "minecraft_username": "MinecraftName",
    "status": "active"
  }
}
```

After auth, the mod sends:

```json
{ "type": "heartbeat" }
```

The server replies:

```json
{
  "type": "heartbeat_ok",
  "accountId": 1,
  "lastSeenAt": "2026-06-15T11:00:00.000Z"
}
```

Accounts with stale `last_seen_at` are shown as `offline` in dashboard account listings.

## Mod Account Proxy Lookup

### `POST /api/mod/account-proxy`

Requires an API key with `mod:connect`. The lookup is scoped to the dashboard user that owns the API key, so one user cannot fetch another user's account proxy settings.

Request by UUID or username:

```json
{
  "minecraftUuid": "00000000-0000-0000-0000-000000000001"
}
```

```json
{
  "minecraftUsername": "PlayerOne"
}
```

Response:

```json
{
  "proxy": {
    "accountId": 1,
    "minecraftUuid": "00000000-0000-0000-0000-000000000001",
    "minecraftUsername": "PlayerOne",
    "enabled": true,
    "type": "SOCKS5",
    "host": "127.0.0.1",
    "port": 1080,
    "username": "optional-user",
    "password": "optional-password"
  }
}
```

Proxy passwords are returned only by this mod-authenticated lookup endpoint. They are not included in dashboard account lists or audit metadata.

## Legacy `GET /api/scan`

The old SSE scan route still exists for compatibility.

```text
/api/scan?item=Final%20Destination%20Chestplate
```

It refreshes the shared index and returns matching results, but new integrations should use:

- `POST /api/search`
- `POST /api/recommend-bin`

## Mod Integration Notes

Recommended mod flow:

1. Run this Node service on the RDP.
2. Expose it through ngrok.
3. Optionally set `AUCTION_API_TOKEN` if the ngrok URL should require a shared token.
4. Mod calls `POST /api/recommend-bin` with the item it wants to price.
5. Mod reads `recommendedPrice`, `warnings`, and `comparables`.

For clean 25k Final Destination armor:

```json
{
  "baseName": "Final Destination Chestplate",
  "attributes": {
    "minKills": 25000,
    "maxKills": 31000,
    "recomb": false
  }
}
```

If the item is recombed:

```json
{
  "baseName": "Final Destination Chestplate",
  "attributes": {
    "minKills": 25000,
    "maxKills": 31000,
    "recomb": true
  }
}
```

## Known Limitations

- Cache is memory-only.
- Current implementation still rebuilds all pages when Hypixel top-level `lastUpdated` changes.
- Incremental refresh is possible later because active auctions are sorted by per-auction `last_updated`, and `/v2/skyblock/auctions_ended` can remove completed auctions.
- `item_bytes` is not decoded yet.
- Ultimate enchant detection is based on parsed lore names and a known-name list.
