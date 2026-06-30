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

test('expected coins include estimated purse active auctions and eye values', () => {
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
  assert.strictEqual(result.estimatedPurse, 34_999_000);
  assert.strictEqual(result.ahListedValue, 24_999_000);
  assert.ok(result.heldEyeValue > 0);
  assert.strictEqual(result.listedEyeValue, 1_500_000);
  assert.strictEqual(result.expectedCoins, result.estimatedPurse + result.ahListedValue + result.heldEyeValue + result.listedEyeValue);
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
  assert.strictEqual(result.expectedCoins, 10_000_000);
});
