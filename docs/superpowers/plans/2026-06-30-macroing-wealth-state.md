# Macroing Wealth State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account expected coins future-only, show auction sold/expired outcomes, and add a macroing dashboard state with lightweight rate tracking.

**Architecture:** Keep all heavy auction reconciliation and rate calculation on the API/RDP. AutoAuction continues sending compact `account_stats` snapshots at the existing bounded interval and adds only macro state to those snapshots. The dashboard renders the latest computed summaries; it does not poll Hypixel or subscribe to hidden per-account streams.

**Tech Stack:** Node.js, better-sqlite3, WebSocket `ws`, React/Vite, Fabric Java mod.

---

### Task 1: Future-Only Expected Coins

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\tests\account-stats-core.test.js`
- Modify: `C:\Humane\Hypixel\Test API\tests\server-auth.test.js`
- Modify: `C:\Humane\Hypixel\Test API\account-stats-core.js`
- Modify: `C:\Humane\Hypixel\Test API\frontend\src\main.jsx`

- [ ] **Step 1: Write failing tests**

Change the account stats tests so `expectedCoins` excludes `purse` and includes only active AH listings, held/listed eye value, and `sold_auction_credit`.

```js
assert.strictEqual(result.currentTotalCoins, 34_999_000);
assert.strictEqual(result.expectedCoins, result.soldAuctionCredit + result.ahListedValue + result.heldEyeValue + result.listedEyeValue);
assert.strictEqual(result.expectedCoins, 24_999_000 + 24_999_000 + result.heldEyeValue + 1_500_000);
```

Also update the expired-auction test to expect `expectedCoins === 0` when purse is the only value.

- [ ] **Step 2: Run failing tests**

Run:

```powershell
npm test -- tests/account-stats-core.test.js
```

Expected: failure because the old code includes `estimatedPurse`, which includes purse, in `expectedCoins`.

- [ ] **Step 3: Implement calculator change**

In `account-stats-core.js`, return these fields:

```js
const soldAuctionCredit = numberValue(stats.sold_auction_credit);
const currentTotalCoins = purse + soldAuctionCredit;
const expectedCoins = soldAuctionCredit + ahListedValue + heldEyeValue + listedEyeValue;
```

Keep `estimatedPurse` as a compatibility alias for `currentTotalCoins` so existing UI does not break during deploy.

- [ ] **Step 4: Update labels**

In `frontend\src\main.jsx`, change compact and remote labels:

```js
{ label: 'Purse', value: formatCoins(stats?.purse) },
{ label: 'Expected', value: formatCoins(stats?.expectedCoins) },
```

Remote coins rows should show `Reported purse`, `Sold auction credit`, `Auction listings`, `Held eye value`, `Listed eye value`, and `Expected future`.

- [ ] **Step 5: Run API tests**

Run:

```powershell
npm test
```

Expected: all tests pass.

### Task 2: Auction Sold/Expired Dashboard Messages

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\auth-db.js`
- Modify: `C:\Humane\Hypixel\Test API\account-stats-core.js`
- Modify: `C:\Humane\Hypixel\Test API\frontend\src\main.jsx`
- Modify: `C:\Humane\Hypixel\Test API\frontend\src\styles.css`
- Test: `C:\Humane\Hypixel\Test API\tests\auth-db.test.js`

- [ ] **Step 1: Write failing DB test**

Extend the auction snapshot reconciliation test to assert recent events are returned:

```js
const soldEvents = listMinecraftAccountAuctionEvents(db, soldAccount.id, 5);
assert.strictEqual(soldEvents[0].state, 'sold');
assert.strictEqual(soldEvents[0].price, 24_999_000);

const expiredEvents = listMinecraftAccountAuctionEvents(db, expiredAccount.id, 5);
assert.strictEqual(expiredEvents[0].state, 'expired');
```

- [ ] **Step 2: Run failing DB test**

Run:

```powershell
node tests/auth-db.test.js
```

Expected: failure because `listMinecraftAccountAuctionEvents` does not exist yet.

- [ ] **Step 3: Implement event query**

Add `listMinecraftAccountAuctionEvents(db, accountId, limit = 5)` in `auth-db.js` to read `minecraft_account_auction_snapshots` rows where `state IN ('sold', 'expired')`, ordered by `last_seen_at DESC`.

- [ ] **Step 4: Attach events to wealth stats**

When dashboard account payloads are built, attach recent auction events into `wealthStats.auctionEvents`. The row fields are `auctionUuid`, `state`, `price`, `endedAt`, and `updatedAt`.

- [ ] **Step 5: Render messages**

Add a compact remote wealth activity list:

```jsx
Auction sold: +24.99M
Auction expired: removed 24.99M from expected
```

No full auction data or per-account auction payloads are sent.

### Task 3: Macroing State And Rates

**Files:**
- Modify: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\client\java\com\autoauction\client\control\ModSocketClient.java`
- Modify: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\src\client\java\com\autoauction\client\stats\AccountStatsSnapshot.java`
- Modify: `C:\Humane\Hypixel\Test API\auth-db.js`
- Modify: `C:\Humane\Hypixel\Test API\server.js`
- Modify: `C:\Humane\Hypixel\Test API\account-stats-core.js`
- Modify: `C:\Humane\Hypixel\Test API\frontend\src\main.jsx`

- [ ] **Step 1: Write failing API test**

Add a test that posts two `account_stats` snapshots with `macroing: true`, purse and FD kill deltas, and asserts `wealthStats.macroRates.killsPerHour` and `wealthStats.macroRates.mobCoinsPerHour` are positive.

- [ ] **Step 2: Add persisted macro session fields**

Store minimal session baselines in `minecraft_account_stats`: `macroing`, `macro_started_at`, `macro_last_sample_at`, `macro_base_purse`, `macro_last_purse`, `macro_base_fd_minimum`, `macro_last_fd_minimum`, `macro_base_eyes`, `macro_last_eyes`.

- [ ] **Step 3: Compute rates server-side**

Only when `macroing` is true:

```js
mobCoinsPerHour = purseDelta / elapsedHours;
fdKillsPerHour = fdMinimumDelta / elapsedHours;
eyeDropsPerHour = eyeDropDelta / elapsedHours;
fdValuePerHour = fdKillsPerHour * 4 * 25_000_000 / 25_000;
```

Use the existing 30-second snapshot cadence. Do not add per-kill requests.

- [ ] **Step 4: Send macro state from mod**

Add a boolean `macroing` field to `account_stats` based on `NebulaMacroController.observedState() == ON`.

- [ ] **Step 5: Render dashboard state**

Display a `macroing` status badge on connected account cards and a remote macro panel with session duration, kills/h, mob coins/h, eyes/h, FD value/h, and total/h.

### Task 4: Commit And Verify

**Files:**
- Modify: `C:\Humane\Hypixel\Test API\HANDOFF.md`
- Modify: `C:\Humane\Hypixel\Minecraft Mod\26.1.1\HANDOFF.md`

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm test
npm run build
.\gradlew.bat --no-daemon test
```

- [ ] **Step 2: Commit each repo**

Commit API/dashboard and AutoAuction changes separately.

- [ ] **Step 3: Deploy/copy when requested**

Deploy API to RDP and copy built AutoAuction jar to the active Prism instance folders only after local verification.

