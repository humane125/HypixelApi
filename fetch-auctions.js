const zlib = require('zlib');

// Format price into a readable format (e.g., 12.5M or 850k)
function formatPriceCompact(price) {
  if (price >= 1_000_000_000) {
    return (price / 1_000_000_000).toFixed(2) + 'B';
  }
  if (price >= 1_000_000) {
    return (price / 1_000_000).toFixed(2) + 'M';
  }
  if (price >= 1_000) {
    return (price / 1_000).toFixed(1) + 'k';
  }
  return price.toString();
}

// Format number with commas
function formatNumber(num) {
  return num.toLocaleString();
}

// Format duration remaining
function formatDuration(ms) {
  if (ms <= 0) return "Ended";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// Helper to fetch with retry and backoff
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay * Math.pow(2, i);
        console.warn(`[Rate Limit] HTTP 429. Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      const waitTime = delay * Math.pow(2, i);
      console.warn(`[Fetch Error] ${err.message}. Retrying in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Resolve Minecraft UUID to Username using Mojang API (cached in memory)
const usernameCache = new Map();
async function getUsername(uuid) {
  if (!uuid) return "Unknown";
  if (usernameCache.has(uuid)) return usernameCache.get(uuid);

  const url = `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`;
  try {
    const res = await fetchWithRetry(url, {}, 2, 500);
    const data = await res.json();
    if (data && data.name) {
      usernameCache.set(uuid, data.name);
      return data.name;
    }
  } catch (err) {
    // Fallback if Mojang API fails or rate limits
    // We can also try Mojang's profile API as fallback
    try {
      const fallbackUrl = `https://api.mojang.com/user/profile/${uuid}`;
      const res = await fetch(fallbackUrl);
      if (res.ok) {
        const data = await res.json();
        if (data && data.name) {
          usernameCache.set(uuid, data.name);
          return data.name;
        }
      }
    } catch (fallbackErr) {
      // Ignore fallback error
    }
  }
  
  // Return truncated UUID if resolution fails
  return `${uuid.substring(0, 8)}...`;
}

// Main function
async function main() {
  const apiKey = process.env.HYPIXEL_API_KEY;
  if (!apiKey) {
    console.error("Error: HYPIXEL_API_KEY environment variable is not set.");
    console.error("Please create a .env file containing: HYPIXEL_API_KEY=your_key");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let minKills = 0;
  let maxKills = Infinity;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-kills' && args[i + 1]) {
      minKills = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--max-kills' && args[i + 1]) {
      maxKills = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const targetItem = "Final Destination Chestplate";
  console.log(`==================================================`);
  console.log(`Hypixel SkyBlock Auction Finder`);
  console.log(`Target: "${targetItem}" (BIN only)`);
  if (minKills > 0 || maxKills !== Infinity) {
    console.log(`Filter: Kills range [${formatNumber(minKills)} to ${maxKills === Infinity ? '∞' : formatNumber(maxKills)}]`);
  }
  console.log(`==================================================\n`);

  const headers = {
    "API-Key": apiKey,
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Hypixel-BIN-Finder/1.0"
  };

  console.log("Fetching page 0 to initialize...");
  let page0;
  try {
    const res = await fetchWithRetry("https://api.hypixel.net/v2/skyblock/auctions?page=0", { headers });
    page0 = await res.json();
  } catch (err) {
    console.error("Failed to fetch page 0:", err.message);
    process.exit(1);
  }

  if (!page0.success) {
    console.error("Hypixel API returned success=false on page 0:", page0.cause || page0.error);
    process.exit(1);
  }

  const totalPages = page0.totalPages;
  const totalAuctions = page0.totalAuctions;
  console.log(`Found ${totalPages} pages containing ${formatNumber(totalAuctions)} total active auctions.`);

  // Function to search for target item in a page's auctions
  function parsePageAuctions(auctions) {
    const matches = [];
    if (!auctions) return matches;

    for (const auc of auctions) {
      // Must be Buy It Now (BIN)
      if (!auc.bin) continue;

      const rawName = auc.item_name || "";
      // Strip Minecraft formatting codes
      const cleanName = rawName.replace(/§./g, '').trim();

      // Check if it's the target item (case-insensitive search)
      if (cleanName.toLowerCase().includes(targetItem.toLowerCase())) {
        const rawLore = auc.item_lore || "";
        const cleanLore = rawLore.replace(/§./g, '');

        // Extract kills from Enderman Bulwark section
        let kills = 0;
        const bulwarkIdx = cleanLore.indexOf("Enderman Bulwark");
        if (bulwarkIdx !== -1) {
          const bulwarkSection = cleanLore.substring(bulwarkIdx, bulwarkIdx + 300);
          const killsMatch = bulwarkSection.match(/\(([\d,]+)(?:\/|[\d,]*\))/);
          if (killsMatch) {
            kills = parseInt(killsMatch[1].replace(/,/g, ''));
          }
        }

        // Extract stars
        // We count circled stars ✪
        const stars = (cleanName.match(/✪/g) || []).length;

        // Check if recombobulated (Mythic rarity instead of Legendary, or has ✿ symbol in name)
        const recomb = cleanLore.includes("MYTHIC") || rawName.includes("✿");

        // Extract reforge
        // Remove stars and check prefix
        const nameWithoutStars = cleanName.replace(/✪/g, '').trim();
        const reforgeMatch = nameWithoutStars.match(/^(.+?)\s+Final Destination Chestplate$/i);
        let reforge = reforgeMatch ? reforgeMatch[1] : "None";
        // Remove recomb symbol ✿ if present in reforge
        if (reforge.startsWith("✿")) {
          reforge = reforge.substring(1).trim() || "None";
        }

        if (kills < minKills || kills > maxKills) continue;

        matches.push({
          uuid: auc.uuid,
          auctioneer: auc.auctioneer,
          item_name: cleanName,
          price: auc.starting_bid,
          reforge,
          stars,
          kills,
          recomb,
          endsAt: auc.end,
          lore: cleanLore
        });
      }
    }
    return matches;
  }

  const matchedAuctions = [];
  
  // Parse page 0 first
  matchedAuctions.push(...parsePageAuctions(page0.auctions));

  // Fetch remaining pages in parallel with a concurrency pool
  console.log(`Scanning pages 1 to ${totalPages - 1}...`);
  
  const pagesToFetch = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  const concurrencyLimit = 8;
  let activeWorkers = 0;
  let completedPages = 1; // Page 0 is completed

  const processQueue = async () => {
    while (pagesToFetch.length > 0) {
      const page = pagesToFetch.shift();
      try {
        const url = `https://api.hypixel.net/v2/skyblock/auctions?page=${page}`;
        const res = await fetchWithRetry(url, { headers });
        const data = await res.json();
        if (data.success && data.auctions) {
          const pageMatches = parsePageAuctions(data.auctions);
          matchedAuctions.push(...pageMatches);
        }
      } catch (err) {
        console.error(`\nFailed to scan page ${page}:`, err.message);
      } finally {
        completedPages++;
        if (completedPages % 5 === 0 || completedPages === totalPages) {
          process.stdout.write(`Progress: ${completedPages}/${totalPages} pages scanned...\r`);
        }
      }
    }
  };

  // Start concurrent workers
  const workers = Array.from({ length: concurrencyLimit }, () => processQueue());
  await Promise.all(workers);
  console.log(`\nScan complete! Found ${matchedAuctions.length} BIN listings for "${targetItem}".`);

  if (matchedAuctions.length === 0) {
    console.log("No active BIN auctions found for this item.");
    return;
  }

  // Sort by price ascending
  matchedAuctions.sort((a, b) => a.price - b.price);

  console.log("\nResolving seller usernames for the top listings...");
  // Limit username resolution to top 15 to avoid rate limiting
  const itemsToResolve = matchedAuctions.slice(0, 15);
  await Promise.all(itemsToResolve.map(async (auc) => {
    auc.sellerName = await getUsername(auc.auctioneer);
  }));

  console.log("\n========================================= ACTIVE BIN AUCTIONS =========================================");
  console.log(
    `${"Rank".padEnd(5)} ` +
    `${"Price".padEnd(12)} ` +
    `${"Kills".padEnd(9)} ` +
    `${"Reforge".padEnd(10)} ` +
    `${"Stars".padEnd(6)} ` +
    `${"Recomb".padEnd(6)} ` +
    `${"Seller".padEnd(16)} ` +
    `${"Time Left".padEnd(10)} ` +
    `Item Display Name`
  );
  console.log("-".repeat(116));

  matchedAuctions.forEach((auc, index) => {
    const rank = `#${index + 1}`;
    const priceStr = formatPriceCompact(auc.price);
    const fullPriceStr = formatNumber(auc.price);
    const killsStr = formatNumber(auc.kills);
    const reforgeStr = auc.reforge;
    const starsStr = auc.stars > 0 ? "★".repeat(auc.stars) : "None";
    const recombStr = auc.recomb ? "Yes" : "No";
    const sellerStr = auc.sellerName || `${auc.auctioneer.substring(0, 8)}...`;
    const timeLeftStr = formatDuration(auc.endsAt - Date.now());

    // Print top 15 with full details and seller name
    if (index < 15) {
      console.log(
        `${rank.padEnd(5)} ` +
        `${(priceStr + ` (${priceStr === fullPriceStr ? '' : priceStr})`).slice(0, 12).padEnd(12)} ` +
        `${killsStr.padEnd(9)} ` +
        `${reforgeStr.padEnd(10)} ` +
        `${starsStr.padEnd(6)} ` +
        `${recombStr.padEnd(6)} ` +
        `${sellerStr.padEnd(16)} ` +
        `${timeLeftStr.padEnd(10)} ` +
        `${auc.item_name}`
      );
    } else if (index === 15) {
      console.log(`... and ${matchedAuctions.length - 15} more listings:`);
    } else if (index < 30) {
      // Print some additional items in brief
      console.log(
        `${rank.padEnd(5)} ` +
        `${fullPriceStr.padEnd(12)} ` +
        `${killsStr.padEnd(9)} ` +
        `${reforgeStr.padEnd(10)} ` +
        `${starsStr.padEnd(6)} ` +
        `${recombStr.padEnd(6)} ` +
        `${"---".padEnd(16)} ` +
        `${timeLeftStr.padEnd(10)} ` +
        `${auc.item_name}`
      );
    }
  });
  console.log("=======================================================================================================\n");
  
  // Show statistical summary
  const minPrice = matchedAuctions[0].price;
  const maxPrice = matchedAuctions[matchedAuctions.length - 1].price;
  const avgPrice = matchedAuctions.reduce((sum, a) => sum + a.price, 0) / matchedAuctions.length;
  
  console.log("Summary Statistics:");
  console.log(`- Lowest BIN:  ${formatNumber(minPrice)} coins (${formatPriceCompact(minPrice)})`);
  console.log(`- Average BIN: ${formatNumber(Math.round(avgPrice))} coins (${formatPriceCompact(avgPrice)})`);
  console.log(`- Highest BIN: ${formatNumber(maxPrice)} coins (${formatPriceCompact(maxPrice)})`);
}

main().catch(err => {
  console.error("Unhandled error:", err);
});
