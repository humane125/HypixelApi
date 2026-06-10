async function run() {
  const apiKey = process.env.HYPIXEL_API_KEY;
  const headers = { "API-Key": apiKey, "Authorization": `Bearer ${apiKey}` };
  
  // Let's search page 0-5 for a Final Destination Chestplate and print its lore
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`https://api.hypixel.net/v2/skyblock/auctions?page=${page}`, { headers });
    const data = await res.json();
    if (!data.success) continue;
    
    for (const auc of data.auctions) {
      if (auc.bin && auc.item_name.replace(/§./g, '').includes("Final Destination Chestplate")) {
        console.log("=========================================");
        console.log("Name:", auc.item_name);
        console.log("Cleaned Name:", auc.item_name.replace(/§./g, ''));
        console.log("Raw Lore:\n", auc.item_lore);
        console.log("Cleaned Lore:\n", auc.item_lore.replace(/§./g, ''));
      }
    }
  }
}
run();
