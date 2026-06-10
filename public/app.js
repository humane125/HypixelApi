let currentResults = [];

const els = {
  cacheLine: document.getElementById('cache-line'),
  token: document.getElementById('api-token'),
  refresh: document.getElementById('btn-refresh'),
  form: document.getElementById('search-form'),
  search: document.getElementById('btn-search'),
  recommend: document.getElementById('btn-recommend'),
  itemName: document.getElementById('item-name'),
  rarity: document.getElementById('filter-rarity'),
  recomb: document.getElementById('filter-recomb'),
  stars: document.getElementById('filter-stars'),
  minKills: document.getElementById('min-kills'),
  maxKills: document.getElementById('max-kills'),
  minPrice: document.getElementById('min-price'),
  maxPrice: document.getElementById('max-price'),
  enchants: document.getElementById('enchant-filter'),
  sort: document.getElementById('sort-order'),
  progressPanel: document.getElementById('progress-panel'),
  progressStatus: document.getElementById('progress-status'),
  progressPercent: document.getElementById('progress-percent'),
  progressBar: document.getElementById('progress-bar'),
  statLowest: document.getElementById('stat-lowest'),
  statLowestDetail: document.getElementById('stat-lowest-detail'),
  statAverage: document.getElementById('stat-average'),
  statCount: document.getElementById('stat-count'),
  statSource: document.getElementById('stat-source'),
  statRecommend: document.getElementById('stat-recommend'),
  statRecommendDetail: document.getElementById('stat-recommend-detail'),
  resultsCount: document.getElementById('results-count'),
  tbody: document.getElementById('results-tbody'),
  modal: document.getElementById('tooltip-modal'),
  modalClose: document.getElementById('modal-close'),
  tooltipClose: document.getElementById('btn-close-tooltip'),
  tooltipName: document.getElementById('tooltip-item-name'),
  tooltipLore: document.getElementById('tooltip-item-lore'),
  tooltipPrice: document.getElementById('tooltip-price'),
  tooltipSeller: document.getElementById('tooltip-seller'),
  tooltipTime: document.getElementById('tooltip-time'),
};

const colorMap = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
};

const romanMap = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

function authHeaders() {
  const token = els.token.value.trim();
  return token ? { 'X-Auction-Token': token } : {};
}

function withTokenQuery(path) {
  const token = els.token.value.trim();
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString();
}

function formatPrice(price) {
  const value = Number(price || 0);
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatNumber(value);
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return 'Ended';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function parseNumberInput(input) {
  const value = input.value.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEnchants(value) {
  const enchants = {};
  const chunks = String(value || '').split(',').map((chunk) => chunk.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(/^(.+?)\s+([ivx]+|\d+)$/i);
    if (!match) continue;
    const name = match[1].trim();
    const levelText = match[2].toLowerCase();
    const level = romanMap[levelText] || Number(levelText);
    if (name && Number.isFinite(level)) {
      enchants[name] = level;
    }
  }
  return enchants;
}

function buildFilters() {
  const filters = {
    category: 'armor',
    enchants: parseEnchants(els.enchants.value),
  };

  if (els.rarity.value !== 'any') filters.rarity = [els.rarity.value];
  if (els.recomb.value !== 'any') filters.recomb = els.recomb.value === 'yes';

  const minKills = parseNumberInput(els.minKills);
  const maxKills = parseNumberInput(els.maxKills);
  const minPrice = parseNumberInput(els.minPrice);
  const maxPrice = parseNumberInput(els.maxPrice);
  if (minKills != null) filters.minKills = minKills;
  if (maxKills != null) filters.maxKills = maxKills;
  if (minPrice != null) filters.minPrice = minPrice;
  if (maxPrice != null) filters.maxPrice = maxPrice;
  if (els.stars.value !== 'any') filters.minStars = Number(els.stars.value);

  if (Object.keys(filters.enchants).length === 0) {
    delete filters.enchants;
  }

  return filters;
}

function buildRecommendationAttributes() {
  const minKills = parseNumberInput(els.minKills);
  const maxKills = parseNumberInput(els.maxKills);
  const attributes = {
    enchants: parseEnchants(els.enchants.value),
    recomb: els.recomb.value === 'yes',
  };

  if (minKills != null) attributes.minKills = minKills;
  if (maxKills != null) attributes.maxKills = maxKills;
  if (minKills != null && maxKills != null) attributes.kills = Math.round((minKills + maxKills) / 2);
  else if (minKills != null) attributes.kills = minKills;
  if (els.rarity.value !== 'any') attributes.rarity = els.rarity.value;
  if (els.stars.value !== 'any') attributes.stars = Number(els.stars.value);
  if (Object.keys(attributes.enchants).length === 0) delete attributes.enchants;

  return attributes;
}

function minecraftColorToHTML(text) {
  const tokens = String(text || '').split('§');
  let html = escapeHtml(tokens[0] || '');
  let color = null;
  let bold = false;
  let italic = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const code = token[0].toLowerCase();
    const rest = escapeHtml(token.slice(1));
    if (colorMap[code]) {
      color = colorMap[code];
      bold = false;
      italic = false;
    } else if (code === 'l') {
      bold = true;
    } else if (code === 'o') {
      italic = true;
    } else if (code === 'r') {
      color = null;
      bold = false;
      italic = false;
    }

    const styles = [];
    if (color) styles.push(`color:${color}`);
    if (bold) styles.push('font-weight:800');
    if (italic) styles.push('font-style:italic');
    html += styles.length ? `<span style="${styles.join(';')}">${rest}</span>` : rest;
  }

  return html.replace(/\n/g, '<br>');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function refreshStatus() {
  const res = await fetch(withTokenQuery('/api/index/status'), { headers: authHeaders() });
  if (res.status === 401) {
    els.cacheLine.textContent = 'Unauthorized: check API token';
    return;
  }
  const status = await res.json();
  renderCacheStatus(status);
}

function renderCacheStatus(status) {
  if (!status.ready) {
    els.cacheLine.textContent = status.refreshing ? 'Index refresh running' : 'Cache not loaded';
    return;
  }
  const age = status.ageMs == null ? 'unknown age' : `${Math.max(0, Math.round(status.ageMs / 1000))}s old`;
  els.cacheLine.textContent = `${formatNumber(status.indexedBinCount)} BIN auctions indexed from ${status.totalPages} pages, ${age}`;
}

function setBusy(isBusy, label = 'Search') {
  els.search.disabled = isBusy;
  els.recommend.disabled = isBusy;
  els.refresh.disabled = isBusy;
  els.search.textContent = isBusy ? 'Working...' : label;
}

async function runSearch(event) {
  if (event) event.preventDefault();
  setBusy(true);
  els.statSource.textContent = 'Searching';

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        query: els.itemName.value.trim(),
        filters: buildFilters(),
        sort: els.sort.value,
        limit: 100,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Search failed');

    currentResults = body.results || [];
    renderCacheStatus(body.cache);
    renderResults(currentResults, body.source);
    resolveUsernames(currentResults.slice(0, 25).map((item) => item.auctioneer));
  } catch (err) {
    els.statSource.textContent = err.message;
    renderResults([], 'error');
  } finally {
    setBusy(false);
  }
}

async function runRecommendation() {
  setBusy(true);
  els.statRecommend.textContent = '...';
  els.statRecommendDetail.textContent = 'Calculating';

  try {
    const res = await fetch('/api/recommend-bin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        baseName: els.itemName.value.trim(),
        attributes: buildRecommendationAttributes(),
        limit: 10,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Recommendation failed');

    renderCacheStatus(body.cache);
    if (body.recommendedPrice == null) {
      els.statRecommend.textContent = '---';
      els.statRecommendDetail.textContent = body.warnings?.[0] || 'No market data';
      return;
    }

    els.statRecommend.textContent = formatPrice(body.recommendedPrice);
    const warning = body.warnings && body.warnings.length > 0 ? ` - ${body.warnings.join(' ')}` : '';
    els.statRecommendDetail.textContent = `${body.basis.replace(/_/g, ' ')}${warning}`;
  } catch (err) {
    els.statRecommend.textContent = '---';
    els.statRecommendDetail.textContent = err.message;
  } finally {
    setBusy(false);
  }
}

function runRefresh() {
  els.progressPanel.classList.remove('hidden');
  els.progressStatus.textContent = 'Connecting';
  els.progressPercent.textContent = '0%';
  els.progressBar.style.width = '0%';
  setBusy(true);

  const source = new EventSource(withTokenQuery('/api/index/refresh'));
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'status') {
      els.progressStatus.textContent = data.message;
    }
    if (data.type === 'init') {
      els.progressStatus.textContent = `Indexing ${data.totalPages} pages`;
      els.progressBar.style.width = '2%';
      els.progressPercent.textContent = '2%';
    }
    if (data.type === 'progress') {
      const pct = Math.round((data.completedPages / data.totalPages) * 100);
      els.progressStatus.textContent = `${formatNumber(data.indexedBinCount)} BIN auctions indexed`;
      els.progressBar.style.width = `${pct}%`;
      els.progressPercent.textContent = `${pct}%`;
    }
    if (data.type === 'done') {
      renderCacheStatus(data.status);
      els.progressStatus.textContent = data.source === 'cache' ? 'Cache already fresh' : 'Index ready';
      els.progressBar.style.width = '100%';
      els.progressPercent.textContent = '100%';
      setBusy(false);
      source.close();
    }
    if (data.type === 'error') {
      els.progressStatus.textContent = data.message;
      setBusy(false);
      source.close();
    }
  };
  source.onerror = () => {
    els.progressStatus.textContent = 'Refresh connection lost';
    setBusy(false);
    source.close();
  };
}

function renderResults(items, source) {
  els.resultsCount.textContent = `${items.length} result${items.length === 1 ? '' : 's'}`;
  els.statCount.textContent = formatNumber(items.length);
  els.statSource.textContent = source === 'fresh' ? 'Fresh index' : source === 'cache' ? 'Cached index' : source;

  if (items.length === 0) {
    els.statLowest.textContent = '---';
    els.statLowestDetail.textContent = 'No result';
    els.statAverage.textContent = '---';
    els.tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">No matching BIN listings</td></tr>';
    return;
  }

  const lowest = items[0];
  const avg = Math.round(items.reduce((sum, item) => sum + item.price, 0) / items.length);
  els.statLowest.textContent = formatPrice(lowest.price);
  els.statLowestDetail.textContent = `${lowest.kills.toLocaleString()} kills`;
  els.statAverage.textContent = formatPrice(avg);

  els.tbody.innerHTML = items.map((item, index) => {
    const enchantText = Object.entries(item.enchants || {})
      .slice(0, 3)
      .map(([name, level]) => `${escapeHtml(name)} ${level}`)
      .join(', ') || 'None';
    const seller = item.sellerName || `${item.auctioneer.slice(0, 8)}...`;
    return `
      <tr data-index="${index}">
        <td class="muted">#${index + 1}</td>
        <td class="price">${formatPrice(item.price)} <small>${formatNumber(item.price)}</small></td>
        <td><span class="rarity ${item.rarity.toLowerCase().replace(/\s+/g, '-')}">${item.rarity}</span></td>
        <td>${formatNumber(item.kills)}</td>
        <td class="stars">${item.stars > 0 ? '✪'.repeat(item.stars) : 'None'}</td>
        <td>${item.recomb ? '<span class="badge mythic">Yes</span>' : '<span class="badge">No</span>'}</td>
        <td>${enchantText}</td>
        <td><span class="seller" data-uuid="${escapeHtml(item.auctioneer)}">${escapeHtml(seller)}</span></td>
        <td>${formatDuration(item.endsAt - Date.now())}</td>
        <td class="item-name">${escapeHtml(item.displayName)}</td>
      </tr>
    `;
  }).join('');
}

async function resolveUsernames(uuids) {
  const unique = [...new Set(uuids.filter(Boolean))];
  if (unique.length === 0) return;

  try {
    const res = await fetch('/api/usernames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unique),
    });
    const mapping = await res.json();
    for (const [uuid, name] of Object.entries(mapping)) {
      currentResults.forEach((item) => {
        if (item.auctioneer === uuid) item.sellerName = name;
      });
      document.querySelectorAll(`.seller[data-uuid="${CSS.escape(uuid)}"]`).forEach((cell) => {
        cell.textContent = name;
      });
    }
  } catch (err) {
    console.error('Username resolution failed:', err);
  }
}

function openTooltip(index) {
  const item = currentResults[index];
  if (!item) return;
  els.tooltipName.textContent = item.displayName;
  els.tooltipName.className = `rarity ${item.rarity.toLowerCase().replace(/\s+/g, '-')}`;
  els.tooltipLore.innerHTML = minecraftColorToHTML(item.raw_lore || item.cleanLore || '');
  els.tooltipPrice.textContent = `${formatNumber(item.price)} coins`;
  els.tooltipSeller.textContent = item.sellerName || item.auctioneer;
  els.tooltipTime.textContent = formatDuration(item.endsAt - Date.now());
  els.modal.classList.remove('hidden');
}

function closeTooltip() {
  els.modal.classList.add('hidden');
}

els.form.addEventListener('submit', runSearch);
els.recommend.addEventListener('click', runRecommendation);
els.refresh.addEventListener('click', runRefresh);
els.modalClose.addEventListener('click', closeTooltip);
els.tooltipClose.addEventListener('click', closeTooltip);
els.tbody.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-index]');
  if (row) openTooltip(Number(row.dataset.index));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTooltip();
});

refreshStatus().catch(() => {
  els.cacheLine.textContent = 'Status unavailable';
});
