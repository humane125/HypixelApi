# Auction Service API

Base URL examples:

```text
https://lazy-similarly-reaffirm.ngrok-free.dev
```

All JSON endpoints return JSON. The refresh endpoint returns Server-Sent Events.

## Authentication

This service does not need a Hypixel API key for its current auction data fetches.

If `AUCTION_API_TOKEN` is set, pass it using one of these methods:

```http
X-Auction-Token: your-token
```

```http
Authorization: Bearer your-token
```

For `GET` endpoints you can also pass:

```text
?token=your-token
```

If `AUCTION_API_TOKEN` is not set, authentication is disabled.

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
