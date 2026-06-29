# Account Wealth Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight per-account wealth stats showing purse, expected coins, Final Destination kills, Summoning Eyes, and active AH listed value in the dashboard.

**Architecture:** AutoAuction sends tiny structured stat/event payloads over the existing mod websocket. The API persists eye counters in SQLite, stores latest live stats, computes expected value from cached Hypixel auction/Bazaar data, and includes summaries in dashboard account/live-control updates. The frontend renders compact account-card stats plus a detailed Connect/remote-page breakdown.

**Tech Stack:** Node.js `ws`, better-sqlite3, React/Vite dashboard, Fabric client Java, JUnit, Node test runner.

---

### Task 1: API Stats Store

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\auth-db.js`
- Test: `C:\Humane\Hypixel\Test API\tests\auth-db.test.js`

- [ ] **Step 1: Write failing persistence tests**

Add tests proving Summoning Eye counts persist per Minecraft account and survive repeated store updates:

```js
test('minecraft account wealth stats persist summoning eye counts', () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  const account = createMinecraftAccount(db, {
    ownerUserId: owner.id,
    label: 'End macro',
    minecraftUuid: '00000000-0000-0000-0000-000000000901',
    minecraftUsername: 'EndMacroOne',
  });

  upsertMinecraftAccountStats(db, account.id, { purse: 12_000_000, summoningEyesHeld: 3 });
  incrementSummoningEyes(db, account.id, 2);
  moveSummoningEyesToListed(db, account.id, 4, 1_200_000);

  const stats = getMinecraftAccountStats(db, account.id);
  assert.strictEqual(stats.purse, 12_000_000);
  assert.strictEqual(stats.summoning_eyes_held, 1);
  assert.strictEqual(stats.summoning_eyes_listed, 4);
  assert.strictEqual(stats.summoning_eye_list_price, 1_200_000);
});
```

- [ ] **Step 2: Run red test**

Run:

```powershell
npm test -- tests/auth-db.test.js
```

Expected: fail because `upsertMinecraftAccountStats`, `incrementSummoningEyes`, `moveSummoningEyesToListed`, and `getMinecraftAccountStats` do not exist.

- [ ] **Step 3: Add SQLite table and helpers**

Add table in `createDatabase`:

```sql
CREATE TABLE IF NOT EXISTS minecraft_account_stats (
  minecraft_account_id INTEGER PRIMARY KEY REFERENCES minecraft_accounts(id) ON DELETE CASCADE,
  purse INTEGER,
  fd_helmet_kills INTEGER,
  fd_chestplate_kills INTEGER,
  fd_leggings_kills INTEGER,
  fd_boots_kills INTEGER,
  summoning_eyes_held INTEGER NOT NULL DEFAULT 0,
  summoning_eyes_listed INTEGER NOT NULL DEFAULT 0,
  summoning_eye_list_price INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

Export helpers with these exact behaviors:

```js
function getMinecraftAccountStats(db, accountId) {
  return {
    minecraft_account_id: accountId,
    purse: null,
    fd_helmet_kills: null,
    fd_chestplate_kills: null,
    fd_leggings_kills: null,
    fd_boots_kills: null,
    summoning_eyes_held: 0,
    summoning_eyes_listed: 0,
    summoning_eye_list_price: 0,
    updated_at: null,
  };
}

function upsertMinecraftAccountStats(db, accountId, patch) {
  // Writes purse and FD kill fields when present, preserving eye counters.
  return getMinecraftAccountStats(db, accountId);
}

function incrementSummoningEyes(db, accountId, delta) {
  // Adds delta to held eyes and clamps the stored value at zero.
  return getMinecraftAccountStats(db, accountId);
}

function moveSummoningEyesToListed(db, accountId, quantity, pricePerEye) {
  // Moves min(quantity, held) from held eyes to listed eyes and stores price.
  return getMinecraftAccountStats(db, accountId);
}

function clearListedSummoningEyes(db, accountId, quantity = null) {
  // Clears all listed eyes when quantity is null, otherwise decrements listed count.
  return getMinecraftAccountStats(db, accountId);
}
```

- [ ] **Step 4: Run green test**

Run:

```powershell
npm test -- tests/auth-db.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add auth-db.js tests\auth-db.test.js
git commit -m "Persist account wealth stats"
```

### Task 2: API Expected Value Calculator

**Files:**
- Create: `C:\Humane\Hypixel\Test API\account-stats-core.js`
- Test: `C:\Humane\Hypixel\Test API\tests\account-stats-core.test.js`

- [ ] **Step 1: Write failing calculator tests**

```js
const assert = require('assert');
const { computeAccountWealthStats } = require('../account-stats-core');

test('expected coins include purse active auctions and eye values', () => {
  const result = computeAccountWealthStats({
    account: { minecraft_uuid: '00000000-0000-0000-0000-000000000901' },
    stats: { purse: 10_000_000, summoning_eyes_held: 2, summoning_eyes_listed: 1, summoning_eye_list_price: 1_500_000 },
    activeAuctions: [
      { auctioneer: '00000000000000000000000000000901', starting_bid: 24_999_000, bin: true, end: Date.now() + 60_000 },
      { auctioneer: 'other', starting_bid: 99_000_000, bin: true, end: Date.now() + 60_000 },
    ],
    summoningEyeSellOrderPrice: 1_400_000,
    nowMs: Date.now(),
  });

  assert.strictEqual(result.purse, 10_000_000);
  assert.strictEqual(result.ahListedValue, 24_999_000);
  assert.ok(result.heldEyeValue > 0);
  assert.strictEqual(result.listedEyeValue, 1_500_000);
  assert.strictEqual(result.expectedCoins, result.purse + result.ahListedValue + result.heldEyeValue + result.listedEyeValue);
});

test('expired or missing auctions do not count as sold coins', () => {
  const result = computeAccountWealthStats({
    account: { minecraft_uuid: '00000000-0000-0000-0000-000000000901' },
    stats: { purse: 10_000_000 },
    activeAuctions: [
      { auctioneer: '00000000000000000000000000000901', starting_bid: 24_999_000, bin: true, end: Date.now() - 1 },
    ],
    summoningEyeSellOrderPrice: 0,
    nowMs: Date.now(),
  });
  assert.strictEqual(result.ahListedValue, 0);
  assert.strictEqual(result.expectedCoins, 10_000_000);
});
```

- [ ] **Step 2: Run red test**

```powershell
node tests/account-stats-core.test.js
```

Expected: fail because module does not exist.

- [ ] **Step 3: Implement calculator**

Create pure functions:

```js
function normalizeUuid(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function computeAccountWealthStats({ account, stats = {}, activeAuctions = [], summoningEyeSellOrderPrice = 0, nowMs = Date.now() }) {
  const uuid = normalizeUuid(account.minecraft_uuid);
  const purse = Number(stats.purse || 0);
  const ahListedValue = activeAuctions
    .filter((auction) => normalizeUuid(auction.auctioneer) === uuid)
    .filter((auction) => !auction.end || Number(auction.end) > nowMs)
    .reduce((sum, auction) => sum + Number(auction.starting_bid || 0), 0);
  const heldEyeValue = Math.floor(Number(stats.summoning_eyes_held || 0) * Number(summoningEyeSellOrderPrice || 0) * 0.9875);
  const listedEyeValue = Number(stats.summoning_eyes_listed || 0) * Number(stats.summoning_eye_list_price || 0);
  return { purse, ahListedValue, heldEyeValue, listedEyeValue, expectedCoins: purse + ahListedValue + heldEyeValue + listedEyeValue };
}
```

- [ ] **Step 4: Run green test and full API tests**

```powershell
node tests/account-stats-core.test.js
npm test
```

- [ ] **Step 5: Commit**

```powershell
git add account-stats-core.js tests\account-stats-core.test.js package.json
git commit -m "Compute account wealth stats"
```

### Task 3: API Hypixel Bazaar/Auction Cache

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\server.js`
- Test: `C:\Humane\Hypixel\Test API\tests\server-auth.test.js`

- [ ] **Step 1: Write failing service tests**

Add a test server with fake `fetchImpl` returning:
- `https://api.hypixel.net/v2/skyblock/bazaar` with `SUMMONING_EYE.quick_status.buyPrice`.
- `https://api.hypixel.net/v2/skyblock/auctions?page=0` with active auction data.

Assert account listing includes `wealthStats.expectedCoins` and active auction value for matching UUID only.

- [ ] **Step 2: Run red test**

```powershell
npm test -- tests/server-auth.test.js
```

Expected: fail because account lists do not include `wealthStats`.

- [ ] **Step 3: Implement cache services**

Add in `server.js`:

```js
function createBazaarPriceService({ fetchImpl = global.fetch, ttlMs = 60_000 } = {}) { /* caches SUMMONING_EYE price */ }
function createActiveAuctionValueService({ auctionIndex }) { /* reads existing indexed auctions, filters active by auctioneer */ }
```

Use existing auction index refresh instead of fetching per account.

- [ ] **Step 4: Attach wealth stats to account lists**

In `listDashboardMinecraftAccounts()` or account message construction, merge stats:

```js
account.wealthStats = computeAccountWealthStats({
  account,
  stats: getMinecraftAccountStats(db, account.id),
  activeAuctions: auctionIndex.getItems(),
  summoningEyeSellOrderPrice: bazaarPriceService.getCachedSummoningEyeSellOrderPrice(),
});
```

- [ ] **Step 5: Run green tests and commit**

```powershell
npm test
git add server.js tests\server-auth.test.js
git commit -m "Expose account wealth stats in dashboard accounts"
```

### Task 4: API Mod Websocket Stat Events

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\server.js`
- Test: `C:\Humane\Hypixel\Test API\tests\server-auth.test.js`

- [ ] **Step 1: Write failing websocket ingestion test**

After mod auth, send:

```json
{"type":"account_stats","purse":12000000,"finalDestinationKills":{"helmet":25000,"chestplate":25001,"leggings":25002,"boots":25003}}
{"type":"summoning_eye_event","action":"drop","quantity":1}
{"type":"summoning_eye_event","action":"sell_order","quantity":1,"pricePerEye":1500000}
```

Assert stored stats reflect purse, FD kills, held/listed eye movement.

- [ ] **Step 2: Run red test**

```powershell
npm test -- tests/server-auth.test.js
```

- [ ] **Step 3: Implement handlers**

Authenticated mod socket accepts:

```js
if (message.type === 'account_stats') { upsertMinecraftAccountStats(db, account.id, cleanAccountStats(message)); dashboardAccounts?.broadcast(); return; }
if (message.type === 'summoning_eye_event') { applySummoningEyeEvent(db, account.id, message); dashboardAccounts?.broadcast(); return; }
```

Reject invalid values by clamping to safe integer ranges and ignoring malformed payloads.

- [ ] **Step 4: Run green tests and commit**

```powershell
npm test
git add server.js tests\server-auth.test.js
git commit -m "Ingest mod account wealth stat events"
```

### Task 5: AutoAuction Stat Snapshot Payloads

**Files:**
- Create: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\client\java\com\autoauction\client\stats\AccountStatsSnapshot.java`
- Create: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\client\java\com\autoauction\client\stats\SummoningEyeEventDetector.java`
- Modify: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\client\java\com\autoauction\client\control\ModSocketClient.java`
- Modify: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\client\java\com\autoauction\client\AutoauctionClient.java`
- Test: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\test\java\com\autoauction\client\stats\SummoningEyeEventDetectorTest.java`
- Test: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\test\java\com\autoauction\client\control\ModSocketClientTest.java`

- [ ] **Step 1: Write failing mod tests**

Test detector examples:

```java
assertEquals(Optional.of(new SummoningEyeEvent("drop", 1, 0)),
  SummoningEyeEventDetector.detect("RARE DROP! Summoning Eye"));
assertEquals(Optional.of(new SummoningEyeEvent("instant_sell", 2, 0)),
  SummoningEyeEventDetector.detect("[Bazaar] Sold 2x Summoning Eye for 2,800,000 coins!"));
assertEquals(Optional.of(new SummoningEyeEvent("sell_order", 1, 1500000)),
  SummoningEyeEventDetector.detect("[Bazaar] Sell Order Setup! 1x Summoning Eye at 1,500,000 coins each"));
```

Test `ModSocketClient.sendAccountStats(...)` and `sendSummoningEyeEvent(...)` emit small JSON without API token.

- [ ] **Step 2: Run red tests**

```powershell
.\gradlew.bat --no-daemon test --tests com.autoauction.client.stats.SummoningEyeEventDetectorTest --tests com.autoauction.client.control.ModSocketClientTest
```

- [ ] **Step 3: Implement snapshot sending**

Every 30 seconds, or when purse/FD kills change, AutoAuction sends:

```json
{"type":"account_stats","purse":12000000,"finalDestinationKills":{"helmet":25000,"chestplate":25001,"leggings":25002,"boots":25003}}
```

On chat event, AutoAuction sends:

```json
{"type":"summoning_eye_event","action":"drop","quantity":1}
```

- [ ] **Step 4: Run green tests and commit**

```powershell
.\gradlew.bat --no-daemon test
git add src\client\java src\test\java
git commit -m "Send lightweight account wealth stats"
```

### Task 6: Dashboard UI

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\frontend\src\main.jsx`
- Modify: `C:\Humane\Hypixel\Test API\frontend\src\styles.css`

- [ ] **Step 1: Add compact account card rendering**

In each account card, render:

```jsx
<div className="account-wealth-grid">
  <div><span>Purse</span><strong>{formatCoins(account.wealthStats?.purse)}</strong></div>
  <div><span>Expected</span><strong>{formatCoins(account.wealthStats?.expectedCoins)}</strong></div>
  <div><span>FD Kills</span><strong>{formatNumber(account.wealthStats?.finalDestinationKills?.minimum)}</strong></div>
  <div><span>Eyes</span><strong>{formatNumber(account.wealthStats?.summoningEyesHeld)}</strong></div>
</div>
```

- [ ] **Step 2: Add remote-page detailed breakdown**

Render purse, AH listed, held eye value, listed eye value, expected total, per-piece FD kills, and last update.

- [ ] **Step 3: Style without changing account-card layout**

Add a compact grid that fits inside current cards and does not widen cards beyond the current 4-per-row layout.

- [ ] **Step 4: Build and commit**

```powershell
npm run build
git add frontend\src\main.jsx frontend\src\styles.css public
git commit -m "Render account wealth stats in dashboard"
```

### Task 7: Verification and Deploy

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\HANDOFF.md`
- Modify: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\HANDOFF.md`

- [ ] **Step 1: Full verification**

```powershell
cd "C:\Humane\Hypixel\Test API"
npm test
npm run build

cd "C:\Humane\Hypixel\Minecraft Mod\26.1.1"
.\gradlew.bat --no-daemon test
.\gradlew.bat --no-daemon build
```

- [ ] **Step 2: Copy AutoAuction jar**

Copy `build\libs\autoauction-1.0.0.jar` to all active Prism instance `mods` folders.

- [ ] **Step 3: Push and deploy API**

```powershell
git push origin master
scp server.js auth-db.js account-stats-core.js Administrator@23.26.77.96:C:/Hypixel/
scp -r public Administrator@23.26.77.96:C:/Hypixel/
ssh Administrator@23.26.77.96 "schtasks /End /TN HypixelApi & schtasks /Run /TN HypixelApi"
```

- [ ] **Step 4: Push AutoAuction**

```powershell
git push origin main
```

- [ ] **Step 5: Update handoffs and commit**

Document:
- eye counts persist across Alt Manager switches and restarts
- auctions count only while active and unexpired in the latest API cache
- live testing still required for exact Hypixel chat lines

---

## Self-Review

- Spec coverage: purse, FD kills, eye persistence, active AH value, Bazaar eye pricing, A+B UI, and low-bandwidth event payloads are covered.
- No raw logs/screenshots are used for this feature.
- Auction disappearance/expiry does not imply sold coins; this is explicitly implemented in the calculator.
- The plan splits API storage/calculation, mod payloads, and frontend rendering into independently testable tasks.
