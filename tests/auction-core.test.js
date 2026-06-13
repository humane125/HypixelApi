const assert = require('assert');

const { normalizeAuction, searchIndexedAuctions, recommendBin } = require('../auction-core');

function normalizeName(itemName, overrides = {}) {
  return normalizeAuction({
    uuid: 'test-auction',
    auctioneer: 'test-seller',
    item_name: itemName,
    item_lore: 'LEGENDARY HELMET',
    tier: 'LEGENDARY',
    category: 'armor',
    starting_bid: 1,
    ...overrides,
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

test('plain Wise Dragon Helmet keeps Wise as the armor set name', () => {
  const item = normalizeName('Wise Dragon Helmet');

  assert.strictEqual(item.baseName, 'Wise Dragon Helmet');
  assert.strictEqual(item.reforge, 'None');
});

test('Very Wise Dragon Helmet parses Very as reforge', () => {
  const item = normalizeName('Very Wise Dragon Helmet');

  assert.strictEqual(item.baseName, 'Wise Dragon Helmet');
  assert.strictEqual(item.reforge, 'Very');
});

test('other reforges on Wise Dragon Helmet still parse normally', () => {
  const item = normalizeName('Necrotic Wise Dragon Helmet');

  assert.strictEqual(item.baseName, 'Wise Dragon Helmet');
  assert.strictEqual(item.reforge, 'Necrotic');
});

test('search matches item names containing Wise Dragon Helmet regardless of reforge', () => {
  const items = [
    normalizeName('Wise Dragon Helmet'),
    normalizeName('Very Wise Dragon Helmet'),
    normalizeName('Necrotic Wise Dragon Helmet'),
    normalizeName('Wise Dragon Chestplate'),
  ];

  const results = searchIndexedAuctions(items, {
    query: 'Wise Dragon Helmet',
    filters: { category: 'armor' },
    sort: 'price_asc',
  });

  assert.deepStrictEqual(results.map((item) => item.displayName), [
    'Wise Dragon Helmet',
    'Very Wise Dragon Helmet',
    'Necrotic Wise Dragon Helmet',
  ]);
});

test('search can match a phrase from the auction display name', () => {
  const items = [
    normalizeName('Wise Dragon Helmet'),
    normalizeName('Very Wise Dragon Helmet'),
    normalizeName('Necrotic Wise Dragon Helmet'),
    normalizeName('Wise Dragon Chestplate'),
  ];

  const results = searchIndexedAuctions(items, {
    query: 'Dragon Helmet',
    filters: { category: 'armor' },
    sort: 'price_asc',
  });

  assert.deepStrictEqual(results.map((item) => item.displayName), [
    'Wise Dragon Helmet',
    'Very Wise Dragon Helmet',
    'Necrotic Wise Dragon Helmet',
  ]);
});

test('25k Final Destination fallback recommendation does not use cheap 0 kill baseline', () => {
  const items = [
    normalizeName('Final Destination Helmet', {
      uuid: 'cheap-0-kill',
      item_lore: 'Next Upgrade: +20 (0/100)\nLEGENDARY HELMET',
      starting_bid: 1_500_000,
    }),
    normalizeName('Final Destination Helmet', {
      uuid: 'cheap-0-kill-2',
      item_lore: 'Next Upgrade: +20 (0/100)\nLEGENDARY HELMET',
      starting_bid: 1_700_000,
    }),
    normalizeName('Ancient Final Destination Helmet', {
      uuid: 'nearby-high-kill',
      item_lore: 'Next Upgrade: +355 (30,218/50,000)\nMYTHIC HELMET',
      tier: 'MYTHIC',
      starting_bid: 84_000_000,
    }),
  ];

  const result = recommendBin(items, {
    baseName: 'Final Destination Helmet',
    attributes: {
      minKills: 25_000,
      maxKills: 30_000,
      recomb: false,
    },
  });

  assert.strictEqual(result.recommendedPrice, 25_000_000);
  assert.strictEqual(result.basis, 'final_destination_25k_floor');
});
