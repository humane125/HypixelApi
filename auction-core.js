const FINAL_DESTINATION_BASE_NAMES = [
  'Final Destination Helmet',
  'Final Destination Chestplate',
  'Final Destination Leggings',
  'Final Destination Boots',
];

const WISE_DRAGON_BASE_NAMES = [
  'Wise Dragon Helmet',
  'Wise Dragon Chestplate',
  'Wise Dragon Leggings',
  'Wise Dragon Boots',
];

const EXACT_BASE_NAMES = [
  ...FINAL_DESTINATION_BASE_NAMES,
  ...WISE_DRAGON_BASE_NAMES,
];

const KNOWN_REFORGES = new Set([
  'Ancient',
  'Clean',
  'Fierce',
  'Giant',
  'Pure',
  'Smart',
  'Spiked',
  'Wise',
  'Loving',
  'Necrotic',
  'Titanic',
  'Renowned',
  'Hyper',
  'Heroic',
  'Very',
]);

const ROMAN_VALUES = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
};

const RECOMMENDATION_MAX_PRICE = 30_000_000;
const FINAL_DESTINATION_25K_FALLBACK_PRICE = 25_000_000;
const SINGLE_LOW_OUTLIER_THRESHOLD = 17_000_000;
const SINGLE_LOW_OUTLIER_RECOMMENDATION = 20_000_000;
const LOW_CLUSTER_MAX_PRICE = 17_500_000;
const LOW_CLUSTER_MIN_COUNT = 3;
const RECOMB_ADJUSTMENT = 2_500_000;
const ULTIMATE_ENCHANT_ADJUSTMENT = 1_000_000;

const ULTIMATE_ENCHANT_NAMES = new Set([
  'Bank',
  'Bobbin Time',
  'Chimera',
  'Combo',
  'Duplex',
  'Fatal Tempo',
  'Flash',
  'Habanero Tactics',
  'Inferno',
  'Last Stand',
  'Legion',
  'No Pain No Gain',
  'One For All',
  'Refrigerate',
  'Rend',
  'Soul Eater',
  'Swarm',
  'The One',
  'Ultimate Jerry',
  'Ultimate Wise',
  'Werewolf',
  'Wisdom',
]);

function stripMinecraftCodes(value) {
  const text = String(value || '');
  let output = '';

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 167) {
      i++;
      continue;
    }
    if (code === 194 && text.charCodeAt(i + 1) === 167) {
      i += 2;
      continue;
    }
    output += text[i];
  }

  return output.replace(/\u00c2/g, '');
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function romanToNumber(value) {
  const roman = String(value || '').toUpperCase();
  let total = 0;
  let previous = 0;

  for (let i = roman.length - 1; i >= 0; i--) {
    const current = ROMAN_VALUES[roman[i]] || 0;
    if (current < previous) {
      total -= current;
    } else {
      total += current;
      previous = current;
    }
  }

  return total;
}

function parseStars(cleanName) {
  const matches = String(cleanName || '').match(/[✪★]/g);
  return matches ? matches.length : 0;
}

function parseKills(cleanLore) {
  const lore = String(cleanLore || '');
  const upgradeMatches = [...lore.matchAll(/\(([\d,]+)\s*\/\s*[\d,]+\)/g)];
  if (upgradeMatches.length > 0) {
    const last = upgradeMatches[upgradeMatches.length - 1];
    return Number.parseInt(last[1].replace(/,/g, ''), 10) || 0;
  }

  const bulwarkIdx = lore.indexOf('Enderman Bulwark');
  if (bulwarkIdx !== -1) {
    const section = lore.slice(bulwarkIdx, bulwarkIdx + 350);
    const looseMatch = section.match(/\(([\d,]+)(?:\/|[\d,]*\))/);
    if (looseMatch) {
      return Number.parseInt(looseMatch[1].replace(/,/g, ''), 10) || 0;
    }
  }

  return 0;
}

function parseEnchantments(cleanLore) {
  const enchants = {};
  const lines = String(cleanLore || '').split(/\r?\n/).map(normalizeWhitespace).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z' -]*?)\s+([IVXLCDM]+)$/);
    if (!match) continue;

    const name = normalizeWhitespace(match[1]);
    const level = romanToNumber(match[2]);
    if (level > 0) {
      enchants[name] = level;
    }
  }

  return enchants;
}

function parseRarityFromLore(cleanLore) {
  const match = String(cleanLore || '').match(/\b(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|DIVINE|SPECIAL|VERY SPECIAL)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractBaseNameAndReforge(cleanName) {
  let name = normalizeWhitespace(cleanName)
    .replace(/[✪★]/g, '')
    .replace(/[✿➊➋➌➍➎]/g, '')
    .trim();

  for (const baseName of EXACT_BASE_NAMES) {
    const idx = name.toLowerCase().lastIndexOf(baseName.toLowerCase());
    if (idx === -1) continue;

    const prefix = normalizeWhitespace(name.slice(0, idx));
    return {
      baseName,
      reforge: prefix || 'None',
    };
  }

  const words = name.split(' ');
  const firstWord = words[0];
  if (words.length > 1 && KNOWN_REFORGES.has(firstWord)) {
    return {
      baseName: words.slice(1).join(' '),
      reforge: firstWord,
    };
  }

  return {
    baseName: name,
    reforge: 'None',
  };
}

function normalizeAuction(auction) {
  const rawName = auction.item_name || '';
  const rawLore = auction.item_lore || '';
  const displayName = normalizeWhitespace(stripMinecraftCodes(rawName));
  const cleanLore = stripMinecraftCodes(rawLore);
  const { baseName, reforge } = extractBaseNameAndReforge(displayName);
  const rarity = String(auction.tier || parseRarityFromLore(cleanLore) || 'UNKNOWN').toUpperCase();

  return {
    uuid: auction.uuid,
    auctioneer: auction.auctioneer,
    itemUuid: auction.item_uuid,
    displayName,
    item_name: displayName,
    baseName,
    baseKey: normalizeKey(baseName),
    rarity,
    tier: rarity,
    category: auction.category || null,
    price: Number(auction.starting_bid || 0),
    reforge,
    stars: parseStars(displayName),
    kills: parseKills(cleanLore),
    recomb: rarity === 'MYTHIC' || rawName.includes('✿') || displayName.includes('✿'),
    enchants: parseEnchantments(cleanLore),
    endsAt: auction.end || null,
    end: auction.end || null,
    raw_lore: rawLore,
    cleanLore,
  };
}

function enchantFilterMatches(item, requiredEnchants = {}) {
  for (const [name, requiredLevel] of Object.entries(requiredEnchants || {})) {
    const actualLevel = item.enchants[name] || 0;
    if (actualLevel < requiredLevel) return false;
  }
  return true;
}

function matchesFilters(item, filters = {}) {
  if (filters.rarity) {
    const rarities = Array.isArray(filters.rarity) ? filters.rarity : [filters.rarity];
    const raritySet = new Set(rarities.map((rarity) => String(rarity).toUpperCase()));
    if (!raritySet.has(item.rarity)) return false;
  }

  if (filters.category && String(item.category || '').toLowerCase() !== String(filters.category).toLowerCase()) {
    return false;
  }

  if (filters.minKills != null && item.kills < Number(filters.minKills)) return false;
  if (filters.maxKills != null && item.kills > Number(filters.maxKills)) return false;
  if (filters.recomb != null && item.recomb !== Boolean(filters.recomb)) return false;
  if (filters.minStars != null && item.stars < Number(filters.minStars)) return false;
  if (filters.stars != null && String(filters.stars) !== 'any' && item.stars !== Number(filters.stars)) return false;
  if (filters.reforge && String(filters.reforge).toLowerCase() !== 'any') {
    if (String(filters.reforge).toLowerCase() === 'none') {
      if (item.reforge.toLowerCase() !== 'none') return false;
    } else if (item.reforge.toLowerCase() !== String(filters.reforge).toLowerCase()) {
      return false;
    }
  }
  if (filters.minPrice != null && item.price < Number(filters.minPrice)) return false;
  if (filters.maxPrice != null && item.price > Number(filters.maxPrice)) return false;
  if (!enchantFilterMatches(item, filters.enchants)) return false;

  return true;
}

function sortItems(items, sort = 'price_asc') {
  const sorted = [...items];
  const sorters = {
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
    kills_asc: (a, b) => a.kills - b.kills || a.price - b.price,
    kills_desc: (a, b) => b.kills - a.kills || a.price - b.price,
    ending_soon: (a, b) => (a.endsAt || 0) - (b.endsAt || 0),
  };

  sorted.sort(sorters[sort] || sorters.price_asc);
  return sorted;
}

function searchIndexedAuctions(indexedAuctions, request = {}) {
  const queryKey = normalizeKey(request.query || request.baseName || '');
  if (!queryKey) return [];

  const filtered = indexedAuctions.filter((item) => {
    const displayKey = normalizeKey(item.displayName || item.item_name || '');
    if (item.baseKey !== queryKey && !displayKey.includes(queryKey)) return false;
    return matchesFilters(item, request.filters || {});
  });

  return sortItems(filtered, request.sort).slice(0, Number(request.limit || 100));
}

function buildComparableFilters(attributes = {}, strict = true) {
  const filters = {};
  if (attributes.rarity) filters.rarity = [attributes.rarity];
  if (attributes.recomb === true) filters.recomb = true;
  if (attributes.enchants) filters.enchants = attributes.enchants;
  if (attributes.stars != null) filters.minStars = attributes.stars;

  if (attributes.minKills != null || attributes.maxKills != null) {
    if (attributes.minKills != null) filters.minKills = Math.max(0, Number(attributes.minKills));
    if (attributes.maxKills != null) filters.maxKills = Number(attributes.maxKills);
  } else if (attributes.kills != null) {
    const range = Number(attributes.killsRange || 5000);
    filters.minKills = Math.max(0, Number(attributes.kills) - range);
    filters.maxKills = Number(attributes.kills) + range;
  }

  if (!strict) {
    delete filters.recomb;
    delete filters.enchants;
    delete filters.minStars;
    delete filters.minKills;
    delete filters.maxKills;
  }

  return filters;
}

function undercutAmount(price) {
  return price >= 25_000_000 ? 1_000_000 : 500_000;
}

function hasUltimateEnchant(enchants = {}) {
  return Object.keys(enchants).some((name) => ULTIMATE_ENCHANT_NAMES.has(name));
}

function recommendationAdjustmentsForComparable(comparable, attributes = {}) {
  const adjustments = [];
  const requestedRecomb = attributes.recomb === true;
  const requestedHasUltimate = hasUltimateEnchant(attributes.enchants || {});

  if (!requestedRecomb && comparable.recomb) {
    adjustments.push({
      reason: 'Comparable listing is recombed but priced item is not; subtracting 2.5m.',
      amount: RECOMB_ADJUSTMENT,
    });
  }

  if (!requestedHasUltimate && hasUltimateEnchant(comparable.enchants)) {
    adjustments.push({
      reason: 'Comparable listing has an ultimate enchant but priced item does not; subtracting 1m.',
      amount: ULTIMATE_ENCHANT_ADJUSTMENT,
    });
  }

  return adjustments;
}

function priceFromExactComparables(exactComparables, attributes, warnings) {
  const lowest = exactComparables[0].price;
  const lowClusterCount = exactComparables.filter((item) => item.price <= LOW_CLUSTER_MAX_PRICE).length;

  if (lowest < SINGLE_LOW_OUTLIER_THRESHOLD && lowClusterCount < LOW_CLUSTER_MIN_COUNT) {
    warnings.push('Lowest comparable is a single listing under 17m; using 20m outlier floor.');
    return SINGLE_LOW_OUTLIER_RECOMMENDATION;
  }

  let recommendedPrice = lowest - undercutAmount(lowest);
  const adjustments = recommendationAdjustmentsForComparable(exactComparables[0], attributes);
  for (const adjustment of adjustments) {
    recommendedPrice -= adjustment.amount;
    warnings.push(adjustment.reason);
  }

  if (recommendedPrice > RECOMMENDATION_MAX_PRICE) {
    warnings.push('Recommendation capped at 30m after upgrade deductions because the adjusted lowest BIN is still high.');
    recommendedPrice = RECOMMENDATION_MAX_PRICE;
  }

  return Math.max(0, recommendedPrice);
}

function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function computeBaseline(items) {
  const prices = items.map((item) => item.price).filter((price) => price > 0).sort((a, b) => a - b);
  if (prices.length === 0) {
    return {
      count: 0,
      median: 0,
      trimmedAverage: 0,
      floor: 0,
    };
  }

  const center = median(prices);
  const floor = Math.round(center * 0.9);
  const highCap = center * 2.5;
  const trimmed = prices.filter((price) => price >= floor && price <= highCap);
  const trimmedAverage = Math.round(trimmed.reduce((sum, price) => sum + price, 0) / trimmed.length);

  return {
    count: prices.length,
    median: center,
    trimmedAverage,
    floor,
  };
}

function isFinalDestination25kRequest(baseName, attributes = {}) {
  if (!FINAL_DESTINATION_BASE_NAMES.includes(baseName)) return false;

  if (attributes.minKills != null) return Number(attributes.minKills) >= 25_000;
  if (attributes.kills != null) return Number(attributes.kills) >= 25_000;
  return false;
}

function recommendBin(indexedAuctions, request = {}) {
  const baseName = request.baseName || request.query || '';
  const baseKey = normalizeKey(baseName);
  const attributes = request.attributes || {};
  const sameBase = indexedAuctions.filter((item) => item.baseKey === baseKey && item.price > 0);
  const warnings = [];

  if (sameBase.length === 0) {
    return {
      recommendedPrice: null,
      basis: 'none',
      comparables: [],
      baseline: null,
      rulesRelaxed: [],
      warnings: ['No active BIN listings found for this base item.'],
    };
  }

  const strictFilters = buildComparableFilters(attributes, true);
  const exactComparables = sortItems(sameBase.filter((item) => matchesFilters(item, strictFilters)), 'price_asc');
  const baseline = computeBaseline(sameBase);

  if (exactComparables.length > 0) {
    const recommendedPrice = priceFromExactComparables(exactComparables, attributes, warnings);

    return {
      recommendedPrice,
      basis: 'exact_comparable',
      comparables: exactComparables.slice(0, Number(request.limit || 10)),
      baseline,
      rulesRelaxed: [],
      warnings,
    };
  }

  const relaxedComparables = sortItems(sameBase.filter((item) => matchesFilters(item, buildComparableFilters(attributes, false))), 'price_asc');
  const baselinePrice = baseline.trimmedAverage || baseline.median;
  let recommendedPrice = Math.min(
    RECOMMENDATION_MAX_PRICE,
    Math.max(baselinePrice - undercutAmount(baselinePrice), baseline.floor || 0)
  );
  const rulesRelaxed = ['kills', 'stars', 'recomb', 'enchants'];
  let basis = 'baseline';

  warnings.push(`No exact comparable listings found; relaxed ${rulesRelaxed.join(', ')} and used guarded market baseline.`);
  if (recommendedPrice < FINAL_DESTINATION_25K_FALLBACK_PRICE && isFinalDestination25kRequest(baseName, attributes)) {
    recommendedPrice = FINAL_DESTINATION_25K_FALLBACK_PRICE;
    basis = 'final_destination_25k_floor';
    warnings.push('No exact 25k Final Destination comparable listings found; using 25m fallback floor.');
  }

  return {
    recommendedPrice,
    basis,
    comparables: relaxedComparables.slice(0, Number(request.limit || 10)),
    baseline,
    rulesRelaxed,
    warnings,
  };
}

module.exports = {
  FINAL_DESTINATION_BASE_NAMES,
  stripMinecraftCodes,
  normalizeAuction,
  searchIndexedAuctions,
  recommendBin,
  parseEnchantments,
  parseKills,
  parseStars,
};
