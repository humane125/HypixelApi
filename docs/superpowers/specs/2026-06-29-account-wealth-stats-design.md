# Account Wealth Stats Dashboard Design

## Goal
Show each registered Minecraft account's current purse, expected coins, Final Destination armor kills, Summoning Eye drops, and active listed auction value in the dashboard without streaming heavy logs or screenshots.

## UI Placement
- Dashboard account cards show a compact stats summary:
  - current purse
  - expected coins
  - Final Destination armor kills
  - Summoning Eye count
- The Connect/remote page shows the detailed breakdown:
  - purse
  - active AH listed value
  - held Summoning Eye value
  - Bazaar-listed Summoning Eye value when parsed from mod events
  - expected total coins
  - per-piece Final Destination kills
  - last update time

## Data Flow
- AutoAuction mod sends small structured stat/event websocket payloads to the API.
- The API stores latest account stats per registered account.
- The dashboard receives latest stats through existing dashboard websocket/account update paths.
- Raw chat logs and screenshots are not used for this feature.

## Mod-Reported Data
The mod reports:
- `purse`: parsed from scoreboard/tablist with existing SkyBlock status parsing.
- `finalDestinationKills`: parsed from currently equipped armor through existing armor parsing.
- `summoningEyesHeld`: persisted per account in the API and changed by events.
- Summoning Eye events from chat:
  - drop detected: increment held count.
  - Bazaar instant sell detected: decrement or clear held count based on parsed amount.
  - Bazaar sell order created: move parsed amount from held eyes to Bazaar-listed eyes.
  - Bazaar order filled/claimed: remove listed eyes from expected eye inventory.

The mod should send only changed values/events, plus a low-frequency heartbeat update around every 30 seconds while connected.

## API-Computed Data
The API computes:
- `estimatedPurse`: latest observed purse plus auction sale credits for auctions that disappeared before expiry.
- `ahListedValue`: active auction BIN/listing value for the account UUID.
- `heldEyeValue`: held Summoning Eyes valued at live Bazaar sell-order price minus fees/tax.
- `listedEyeValue`: Bazaar-listed eye value parsed from sell-order events. If the mod cannot parse the amount or price, use `0` instead of guessing.
- `expectedCoins = estimatedPurse + ahListedValue + heldEyeValue + listedEyeValue`.

## Hypixel Fetching Strategy
- The API fetches Hypixel auction pages globally, not per dashboard/account request.
- Auction data is cached and shared for all accounts.
- The API filters cached active auctions by `auctioneer` UUID matching registered accounts.
- Auction value counts only while the auction is still present in the latest successful Hypixel auction search/cache and has not expired.
- If an auction disappears before its end time, treat it as sold: remove it from `ahListedValue` and add the sale value to `estimatedPurse`.
- If an auction disappears after its end time, treat it as expired/unsold: remove it from `ahListedValue` and do not add it to `estimatedPurse`.
- If an auction timer expires while it is still unsold, stop counting it toward expected coins.
- Sold auctions are a bucket move from active AH value into estimated purse, so expected total does not double count them.
- Bazaar prices are fetched globally and cached, then reused for every account.
- Refresh intervals should be respectful and bounded. A practical first slice is about 60 seconds for Bazaar data and auction refresh only when Hypixel auction data changes or after a bounded interval.

## Persistence
- Summoning Eye counts and Bazaar-listed eye tracking persist per registered account in SQLite.
- Summoning Eye counts persist across Minecraft account switches through Alt Manager, game closes, mod reconnects, API restarts, and dashboard reloads.
- Current purse and armor kills can be latest-observed values only.
- Historical charts are out of scope for the first slice.
- Manual reset button is not included in the first slice.
- Eye count should auto-correct through detected Bazaar instant-sell, sell-order, filled, and claimed chat events.

## Performance Requirements
- Do not send raw logs to power this feature.
- Do not send screenshots for this feature.
- Do not fetch Hypixel auctions separately per account.
- Do not broadcast full auction data to dashboards.
- Account stat websocket payloads should stay small, generally under 1 KB.
- Dashboard account update payloads should include computed stat summaries, not raw source data.

## First Slice
Implement:
- Mod-side structured stat/event payloads.
- API SQLite-backed account stats store.
- API cached Bazaar price lookup for `SUMMONING_EYE`.
- API cached active auction valuation by account UUID.
- Dashboard compact stats on account cards.
- Dashboard detailed stats on Connect/remote page.

## Testing
- Mod tests for Summoning Eye chat event parsing.
- Mod tests for stat payload formatting and no API key leakage.
- Mod tests for armor kill and purse stat snapshot formatting.
- API tests for account stat payload ingestion.
- API tests for expected coin calculation.
- API tests for auction filtering by registered account UUID.
- Frontend tests or component-level checks for compact card stats and remote-page breakdown rendering.
