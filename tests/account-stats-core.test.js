const assert = require('assert');
const { computeAccountWealthStats } = require('../account-stats-core');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

test('expected coins exclude purse and include future value only', () => {
  const nowMs = Date.now();
  const result = computeAccountWealthStats({
    account: { minecraft_uuid: '00000000-0000-0000-0000-000000000901' },
    stats: {
      purse: 10_000_000,
      sold_auction_credit: 24_999_000,
      summoning_eyes_held: 2,
      summoning_eyes_listed: 1,
      summoning_eye_list_price: 1_500_000,
    },
    activeAuctions: [
      { auctioneer: '00000000000000000000000000000901', starting_bid: 24_999_000, bin: true, end: nowMs + 60_000 },
      { auctioneer: 'other', starting_bid: 99_000_000, bin: true, end: nowMs + 60_000 },
    ],
    summoningEyeSellOrderPrice: 1_400_000,
    nowMs,
  });

  assert.strictEqual(result.purse, 10_000_000);
  assert.strictEqual(result.estimatedPurse, 10_000_000);
  assert.strictEqual(result.currentTotalCoins, 10_000_000);
  assert.strictEqual(result.soldAuctionCredit, 24_999_000);
  assert.strictEqual(result.ahListedValue, 24_999_000);
  assert.ok(result.heldEyeValue > 0);
  assert.strictEqual(result.listedEyeValue, 1_500_000);
  assert.strictEqual(result.expectedCoins, result.ahListedValue + result.soldAuctionCredit + result.heldEyeValue + result.listedEyeValue);
});

test('expired auctions do not count as sold coins', () => {
  const nowMs = Date.now();
  const result = computeAccountWealthStats({
    account: { minecraft_uuid: '00000000-0000-0000-0000-000000000901' },
    stats: { purse: 10_000_000 },
    activeAuctions: [
      { auctioneer: '00000000000000000000000000000901', starting_bid: 24_999_000, bin: true, end: nowMs - 1 },
    ],
    summoningEyeSellOrderPrice: 0,
    nowMs,
  });

  assert.strictEqual(result.ahListedValue, 0);
  assert.strictEqual(result.expectedCoins, 0);
});

test('resolved auction ids are excluded from listed expected coins', () => {
  const nowMs = Date.now();
  const result = computeAccountWealthStats({
    account: { minecraft_uuid: '00000000-0000-0000-0000-000000000901' },
    stats: {
      purse: 10_000_000,
      sold_auction_credit: 24_749_010,
    },
    activeAuctions: [
      {
        uuid: 'collected-auction',
        auctioneer: '00000000000000000000000000000901',
        starting_bid: 24_999_000,
        bin: true,
        end: nowMs + 60_000,
      },
    ],
    resolvedAuctionUuids: ['collected-auction'],
    summoningEyeSellOrderPrice: 0,
    nowMs,
  });

  assert.strictEqual(result.ahListedValue, 0);
  assert.strictEqual(result.expectedCoins, 24_749_010);
  assert.strictEqual(result.currentTotalCoins, 10_000_000);
});

test('macroing rates use session deltas only while macroing', () => {
  const result = computeAccountWealthStats({
    account: { minecraft_uuid: '00000000-0000-0000-0000-000000000901' },
    stats: {
      purse: 1_030_000,
      macroing: 1,
      macro_started_at: '2026-07-01T00:00:00.000Z',
      macro_last_sample_at: '2026-07-01T00:30:00.000Z',
      macro_base_purse: 1_000_000,
      macro_last_purse: 1_030_000,
      macro_base_fd_minimum: 100,
      macro_last_fd_minimum: 121,
      macro_base_eye_drops: 0,
      macro_last_eye_drops: 2,
    },
    summoningEyeSellOrderPrice: 1_500_000,
  });

  assert.strictEqual(result.macroing, true);
  assert.strictEqual(result.macroRates.mobCoins, 30_000);
  assert.strictEqual(result.macroRates.mobCoinsPerHour, 60_000);
  assert.strictEqual(result.macroRates.fdKills, 21);
  assert.strictEqual(result.macroRates.fdKillsPerHour, 42);
  assert.strictEqual(result.macroRates.fdValuePerHour, 168_000);
  assert.strictEqual(result.macroRates.eyeDrops, 2);
  assert.strictEqual(result.macroRates.eyeDropsPerHour, 4);
  assert.strictEqual(result.macroRates.eyeValuePerHour, 5_925_000);
  assert.strictEqual(result.macroRates.totalCoinsPerHour, 6_153_000);
});
