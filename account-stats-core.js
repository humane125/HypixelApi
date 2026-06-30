function normalizeUuid(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function computeAccountWealthStats({
  account,
  stats = {},
  activeAuctions = [],
  summoningEyeSellOrderPrice = 0,
  nowMs = Date.now(),
}) {
  const uuid = normalizeUuid(account?.minecraft_uuid);
  const purse = numberValue(stats.purse);
  const estimatedPurse = purse + numberValue(stats.sold_auction_credit);
  const ahListedValue = activeAuctions
    .filter((auction) => normalizeUuid(auction.auctioneer) === uuid)
    .filter((auction) => !auction.end || numberValue(auction.end) > nowMs)
    .reduce((sum, auction) => sum + numberValue(auction.starting_bid), 0);
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

  return {
    purse,
    estimatedPurse,
    ahListedValue,
    heldEyeValue,
    listedEyeValue,
    expectedCoins: estimatedPurse + ahListedValue + heldEyeValue + listedEyeValue,
    summoningEyesHeld: numberValue(stats.summoning_eyes_held),
    summoningEyesListed: numberValue(stats.summoning_eyes_listed),
    summoningEyeListPrice: numberValue(stats.summoning_eye_list_price),
    finalDestinationKills,
    updatedAt: stats.updated_at || null,
  };
}

module.exports = {
  normalizeUuid,
  computeAccountWealthStats,
};
