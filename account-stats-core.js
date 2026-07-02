function normalizeUuid(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanAuctionUuid(value) {
  return String(value || '').trim();
}

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hourly(delta, elapsedMs) {
  if (!elapsedMs || elapsedMs <= 0) return 0;
  return Math.floor((Math.max(0, delta) * 3_600_000) / elapsedMs);
}

function computeMacroRates(stats, summoningEyeSellOrderPrice) {
  const macroing = stats.macroing === true || numberValue(stats.macroing) === 1;
  if (!macroing) return null;

  const startedMs = timestampMs(stats.macro_started_at);
  const sampleMs = timestampMs(stats.macro_last_sample_at);
  const elapsedMs = startedMs == null || sampleMs == null ? 0 : Math.max(0, sampleMs - startedMs);
  const mobCoins = Math.max(0, numberValue(stats.macro_last_purse) - numberValue(stats.macro_base_purse));
  const fdKills = Math.max(0, numberValue(stats.macro_last_fd_minimum) - numberValue(stats.macro_base_fd_minimum));
  const eyeDrops = Math.max(0, numberValue(stats.macro_last_eye_drops) - numberValue(stats.macro_base_eye_drops));
  const mobCoinsPerHour = hourly(mobCoins, elapsedMs);
  const fdKillsPerHour = hourly(fdKills, elapsedMs);
  const eyeDropsPerHour = hourly(eyeDrops, elapsedMs);
  const fdValuePerHour = Math.floor((fdKillsPerHour * 4 * 25_000_000) / 25_000);
  const eyeValuePerHour = Math.floor(eyeDropsPerHour * numberValue(summoningEyeSellOrderPrice) * 0.9875);
  const totalCoinsPerHour = mobCoinsPerHour + fdValuePerHour + eyeValuePerHour;

  return {
    startedAt: stats.macro_started_at || null,
    lastSampleAt: stats.macro_last_sample_at || null,
    elapsedMs,
    mobCoins,
    fdKills,
    eyeDrops,
    mobCoinsPerHour,
    fdKillsPerHour,
    eyeDropsPerHour,
    fdValuePerHour,
    eyeValuePerHour,
    totalCoinsPerHour,
  };
}

function computeAccountWealthStats({
  account,
  stats = {},
  activeAuctions = [],
  resolvedAuctionUuids = [],
  summoningEyeSellOrderPrice = 0,
  nowMs = Date.now(),
}) {
  const uuid = normalizeUuid(account?.minecraft_uuid);
  const resolvedAuctionUuidSet = new Set((resolvedAuctionUuids || []).map(cleanAuctionUuid).filter(Boolean));
  const purse = numberValue(stats.purse);
  const soldAuctionCredit = numberValue(stats.sold_auction_credit);
  const currentTotalCoins = purse + soldAuctionCredit;
  const estimatedPurse = currentTotalCoins;
  const ahListedValue = activeAuctions
    .filter((auction) => normalizeUuid(auction.auctioneer) === uuid)
    .filter((auction) => !resolvedAuctionUuidSet.has(cleanAuctionUuid(auction.uuid || auction.auction_uuid || auction.id)))
    .filter((auction) => !auction.end || numberValue(auction.end) > nowMs)
    .reduce((sum, auction) => sum + numberValue(auction.starting_bid ?? auction.price), 0);
  const heldEyeValue = Math.floor(numberValue(stats.summoning_eyes_held) * numberValue(summoningEyeSellOrderPrice) * 0.9875);
  const listedEyeValue = numberValue(stats.summoning_eyes_listed) * numberValue(stats.summoning_eye_list_price);
  const finalDestinationKills = {
    helmet: stats.fd_helmet_kills == null ? null : numberValue(stats.fd_helmet_kills),
    chestplate: stats.fd_chestplate_kills == null ? null : numberValue(stats.fd_chestplate_kills),
    leggings: stats.fd_leggings_kills == null ? null : numberValue(stats.fd_leggings_kills),
    boots: stats.fd_boots_kills == null ? null : numberValue(stats.fd_boots_kills),
  };
  const killValues = Object.values(finalDestinationKills).filter((value) => value != null);
  finalDestinationKills.minimum = killValues.length ? Math.min(...killValues) : null;
  const macroRates = computeMacroRates(stats, summoningEyeSellOrderPrice);

  return {
    purse,
    soldAuctionCredit,
    currentTotalCoins,
    estimatedPurse,
    ahListedValue,
    heldEyeValue,
    listedEyeValue,
    expectedCoins: ahListedValue + heldEyeValue + listedEyeValue,
    summoningEyesHeld: numberValue(stats.summoning_eyes_held),
    summoningEyesListed: numberValue(stats.summoning_eyes_listed),
    summoningEyeListPrice: numberValue(stats.summoning_eye_list_price),
    summoningEyeDropsTotal: numberValue(stats.summoning_eye_drops_total),
    finalDestinationKills,
    macroing: Boolean(macroRates),
    macroStartedAt: macroRates?.startedAt || null,
    macroRates,
    updatedAt: stats.updated_at || null,
  };
}

module.exports = {
  normalizeUuid,
  computeAccountWealthStats,
};
