import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Ban,
  Camera,
  ChevronLeft,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Gavel,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Monitor,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import './styles.css';
import fdBootsIcon from './assets/final-destination/fd-boots.png';
import fdChestplateIcon from './assets/final-destination/fd-chestplate.png';
import fdHelmetIcon from './assets/final-destination/fd-helmet.png';
import fdLeggingsIcon from './assets/final-destination/fd-leggings.png';
import coinGoldIcon from './assets/wealth/coin-gold.png';
import summoningEyeIcon from './assets/wealth/summoning-eye.png';
import { mergeProxyDraftsFromAccounts, proxyDraftFromAccount, proxyDraftsFromAccounts } from './proxyDrafts.mjs';

const TOKEN_STORAGE_KEY = 'auctionApiToken';

const colorMap = {
  '0': '#111111',
  '1': '#6f7fa6',
  '2': '#6f946f',
  '3': '#78999a',
  '4': '#a06c6c',
  '5': '#94759a',
  '6': '#b79b61',
  '7': '#a7abb0',
  '8': '#6e737a',
  '9': '#8ea2c6',
  a: '#7aa17d',
  b: '#91aeb0',
  c: '#c06f6f',
  d: '#b8a6c9',
  e: '#c4b878',
  f: '#edf0f3',
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

const defaultAuctionForm = {
  itemName: 'Final Destination Chestplate',
  rarity: 'any',
  recomb: 'no',
  stars: 'any',
  minKills: '25000',
  maxKills: '30000',
  minPrice: '',
  maxPrice: '',
  enchants: '',
  sort: 'price_asc',
};

const defaultAccountForm = {
  label: '',
  minecraftUuid: '',
  minecraftUsername: '',
  notes: '',
};

const defaultKeyForm = {
  userId: '',
  name: '',
  scopes: ['auction:read', 'mod:connect'],
};

const defaultUserForm = {
  username: '',
  password: '',
  role: 'viewer',
};

const finalDestinationIcons = {
  helmet: fdHelmetIcon,
  chestplate: fdChestplateIcon,
  leggings: fdLeggingsIcon,
  boots: fdBootsIcon,
};

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(path, token, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...authHeaders(token),
    ...(options.headers || {}),
  };
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function tokenQuery(path, token) {
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

function websocketUrl(path) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
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

function formatCoins(value, fallback = '0') {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return formatPrice(Math.max(0, Math.floor(number)));
}

function formatStatNumber(value, fallback = '-') {
  const number = Number(value);
  return Number.isFinite(number) ? formatNumber(number) : fallback;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.floor(bytes)} B`;
}

function formatTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Waiting';
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

function formatFullDuration(ms) {
  if (!ms || ms <= 0) return 'Ended';
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function displayAccountStatus(account, nowMs) {
  if (account.status === 'banned' && account.ban_until && Date.parse(account.ban_until) <= nowMs) {
    return 'offline';
  }
  if ((account.status === 'active' || account.status === 'hypixel') && account.wealthStats?.macroing) {
    return 'macroing';
  }
  return account.status;
}

function isLiveAccountStatus(status) {
  return status === 'active' || status === 'hypixel' || status === 'macroing';
}

function accountStatusRank(account, nowMs) {
  const status = displayAccountStatus(account, nowMs);
  const ranks = {
    macroing: 0,
    hypixel: 1,
    active: 2,
    offline: 3,
    banned: 4,
  };
  return ranks[status] ?? 5;
}

function isAccountInBannedFolder(account, nowMs) {
  if (displayAccountStatus(account, nowMs) !== 'banned') return false;
  if (account.is_banned_foldered) return true;
  return Boolean(account.banned_folder_available_at && Date.parse(account.banned_folder_available_at) <= nowMs);
}

function accountOwnerFolder(account) {
  return account.owner_username || 'Unassigned';
}

function parseNumber(value) {
  const parsed = Number(String(value || '').trim());
  return Number.isFinite(parsed) && String(value || '').trim() ? parsed : null;
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
    if (name && Number.isFinite(level)) enchants[name] = level;
  }
  return enchants;
}

function buildFilters(form) {
  const filters = {
    category: 'armor',
    enchants: parseEnchants(form.enchants),
  };
  if (form.rarity !== 'any') filters.rarity = [form.rarity];
  if (form.recomb !== 'any') filters.recomb = form.recomb === 'yes';
  const minKills = parseNumber(form.minKills);
  const maxKills = parseNumber(form.maxKills);
  const minPrice = parseNumber(form.minPrice);
  const maxPrice = parseNumber(form.maxPrice);
  if (minKills != null) filters.minKills = minKills;
  if (maxKills != null) filters.maxKills = maxKills;
  if (minPrice != null) filters.minPrice = minPrice;
  if (maxPrice != null) filters.maxPrice = maxPrice;
  if (form.stars !== 'any') filters.minStars = Number(form.stars);
  if (Object.keys(filters.enchants).length === 0) delete filters.enchants;
  return filters;
}

function buildRecommendationAttributes(form) {
  const minKills = parseNumber(form.minKills);
  const maxKills = parseNumber(form.maxKills);
  const attributes = {
    enchants: parseEnchants(form.enchants),
    recomb: form.recomb === 'yes',
  };
  if (minKills != null) attributes.minKills = minKills;
  if (maxKills != null) attributes.maxKills = maxKills;
  if (minKills != null && maxKills != null) attributes.kills = Math.round((minKills + maxKills) / 2);
  else if (minKills != null) attributes.kills = minKills;
  if (form.rarity !== 'any') attributes.rarity = form.rarity;
  if (form.stars !== 'any') attributes.stars = Number(form.stars);
  if (Object.keys(attributes.enchants).length === 0) delete attributes.enchants;
  return attributes;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function mineatarFaceUrl(uuid) {
  const cleanUuid = String(uuid || '').replace(/-/g, '').trim();
  if (!cleanUuid) return '';
  return `https://api.mineatar.io/face/${encodeURIComponent(cleanUuid)}?scale=8&overlay=true&format=png`;
}

function minecraftColorToHTML(text) {
  const tokens = String(text || '').split('Â§');
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

function Field({ label, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function viewFromPath(pathname) {
  if (pathname === '/auctions') return 'auctions';
  if (pathname.startsWith('/remote')) return 'remote';
  return 'dashboard';
}

function remoteAccountKeyFromPath(pathname) {
  const match = String(pathname || '').match(/^\/remote\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function remoteAccountPath(account) {
  const key = String(account?.minecraft_uuid || account?.minecraft_username || account?.id || '').trim();
  return `/remote/${encodeURIComponent(key)}`;
}

function normalizeRemoteKey(value) {
  return String(value || '').replace(/-/g, '').trim().toLowerCase();
}

function accountMatchesRemoteKey(account, key) {
  const normalizedKey = normalizeRemoteKey(key);
  if (!normalizedKey) return false;
  return normalizeRemoteKey(account.minecraft_uuid) === normalizedKey
    || String(account.minecraft_username || '').trim().toLowerCase() === String(key || '').trim().toLowerCase()
    || String(account.id) === String(key);
}

function App() {
  const [activeView, setActiveView] = useState(() => viewFromPath(window.location.pathname));
  const [remoteAccountKey, setRemoteAccountKey] = useState(() => remoteAccountKeyFromPath(window.location.pathname));
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) || '');

  useEffect(() => {
    const handlePopState = () => {
      setActiveView(viewFromPath(window.location.pathname));
      setRemoteAccountKey(remoteAccountKeyFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const updateToken = useCallback((value) => {
    setToken(value);
    localStorage.setItem(TOKEN_STORAGE_KEY, value.trim());
  }, []);

  const navigateView = useCallback((nextView, account = null) => {
    const nextPath = nextView === 'auctions'
      ? '/auctions'
      : nextView === 'remote' && account
        ? remoteAccountPath(account)
        : '/';
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setActiveView(nextView);
    setRemoteAccountKey(nextView === 'remote' ? remoteAccountKeyFromPath(nextPath) : null);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><Server size={18} /></div>
          <div>
            <h1><span>SkyBlock</span> Control</h1>
            <p className="muted">Auction pricing, API keys, and registered Minecraft accounts</p>
          </div>
        </div>
        <div className="topbar-actions">
          <nav className="view-tabs" aria-label="Primary views">
            <button className={activeView === 'dashboard' ? 'active' : ''} type="button" onClick={() => navigateView('dashboard')}><LayoutDashboard size={16} aria-hidden="true" />Dashboard</button>
            <button className={activeView === 'auctions' ? 'active' : ''} type="button" onClick={() => navigateView('auctions')}><Gavel size={16} aria-hidden="true" />Auctions</button>
            {activeView === 'remote' ? (
              <button className="active" type="button"><Monitor size={16} aria-hidden="true" />Remote</button>
            ) : null}
          </nav>
          {activeView === 'dashboard' ? (
            <div className="topbar-metrics" aria-label="Dashboard status">
              <div>
                <span>API Status</span>
                <strong className="online-dot">Online</strong>
              </div>
              <div>
                <span>Session</span>
                <strong>Local</strong>
              </div>
              <div>
                <span>Mode</span>
                <strong>Review</strong>
              </div>
            </div>
          ) : null}
          {activeView === 'auctions' ? (
            <input
              className="token-input"
              type="password"
              placeholder="API key for API/mod calls"
              value={token}
              onChange={(event) => updateToken(event.target.value)}
            />
          ) : null}
        </div>
      </header>

      {activeView === 'auctions'
        ? <AuctionView token={token} />
        : <DashboardView remoteAccountKey={remoteAccountKey} navigateView={navigateView} />}
    </main>
  );
}

function AuctionView({ token }) {
  const [form, setForm] = useState(defaultAuctionForm);
  const [cacheLine, setCacheLine] = useState('Cache not loaded');
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState([]);
  const [source, setSource] = useState('Waiting');
  const [recommendation, setRecommendation] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [busy, setBusy] = useState(false);

  const lowest = results[0] || null;
  const average = useMemo(() => {
    if (!results.length) return 0;
    return Math.round(results.reduce((sum, item) => sum + item.price, 0) / results.length);
  }, [results]);

  const updateField = useCallback((field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  }, []);

  const renderCacheStatus = useCallback((status) => {
    if (!status.ready) {
      setCacheLine(status.refreshing ? 'Index refresh running' : 'Cache not loaded');
      return;
    }
    const age = status.ageMs == null ? 'unknown age' : `${Math.max(0, Math.round(status.ageMs / 1000))}s old`;
    setCacheLine(`${formatNumber(status.indexedBinCount)} BIN auctions indexed from ${status.totalPages} pages, ${age}`);
  }, []);

  useEffect(() => {
    apiFetch('/api/index/status', token)
      .then(renderCacheStatus)
      .catch((err) => setCacheLine(err.message === 'Unauthorized' ? 'Unauthorized: check API key' : 'Status unavailable'));
  }, [renderCacheStatus, token]);

  const resolveUsernames = useCallback(async (items) => {
    const unique = [...new Set(items.map((item) => item.auctioneer).filter(Boolean))].slice(0, 25);
    if (!unique.length) return;
    try {
      const mapping = await apiFetch('/api/usernames', token, {
        method: 'POST',
        body: JSON.stringify(unique),
      });
      setResults((current) => current.map((item) => ({
        ...item,
        sellerName: mapping[item.auctioneer] || item.sellerName,
      })));
    } catch (err) {
      console.error('Username resolution failed:', err);
    }
  }, [token]);

  const runSearch = useCallback(async (event) => {
    event.preventDefault();
    setBusy(true);
    setSource('Searching');
    try {
      const body = await apiFetch('/api/search', token, {
        method: 'POST',
        body: JSON.stringify({
          query: form.itemName.trim(),
          filters: buildFilters(form),
          sort: form.sort,
          limit: 100,
        }),
      });
      const nextResults = body.results || [];
      setResults(nextResults);
      setSource(body.source === 'fresh' ? 'Fresh index' : body.source === 'cache' ? 'Cached index' : body.source);
      renderCacheStatus(body.cache);
      resolveUsernames(nextResults);
    } catch (err) {
      setSource(err.message);
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, [form, renderCacheStatus, resolveUsernames, token]);

  const runRecommendation = useCallback(async () => {
    setBusy(true);
    setRecommendation({ price: null, detail: 'Calculating' });
    try {
      const body = await apiFetch('/api/recommend-bin', token, {
        method: 'POST',
        body: JSON.stringify({
          baseName: form.itemName.trim(),
          attributes: buildRecommendationAttributes(form),
          limit: 10,
        }),
      });
      renderCacheStatus(body.cache);
      if (body.recommendedPrice == null) {
        setRecommendation({ price: null, detail: body.warnings?.[0] || 'No market data' });
      } else {
        const warning = body.warnings?.length ? ` - ${body.warnings.join(' ')}` : '';
        setRecommendation({
          price: body.recommendedPrice,
          detail: `${body.basis.replace(/_/g, ' ')}${warning}`,
        });
      }
    } catch (err) {
      setRecommendation({ price: null, detail: err.message });
    } finally {
      setBusy(false);
    }
  }, [form, renderCacheStatus, token]);

  const runRefresh = useCallback(() => {
    setProgress({ status: 'Connecting', percent: 0 });
    setBusy(true);
    const sourceStream = new EventSource(tokenQuery('/api/index/refresh', token));
    sourceStream.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status') setProgress({ status: data.message, percent: 0 });
      if (data.type === 'init') setProgress({ status: `Indexing ${data.totalPages} pages`, percent: 2 });
      if (data.type === 'progress') {
        const percent = Math.round((data.completedPages / data.totalPages) * 100);
        setProgress({ status: `${formatNumber(data.indexedBinCount)} BIN auctions indexed`, percent });
      }
      if (data.type === 'done') {
        renderCacheStatus(data.status);
        setProgress({ status: data.source === 'cache' ? 'Cache already fresh' : 'Index ready', percent: 100 });
        setBusy(false);
        sourceStream.close();
      }
      if (data.type === 'error') {
        setProgress({ status: data.message, percent: 0 });
        setBusy(false);
        sourceStream.close();
      }
    };
    sourceStream.onerror = () => {
      setProgress({ status: 'Refresh connection lost', percent: 0 });
      setBusy(false);
      sourceStream.close();
    };
  }, [renderCacheStatus, token]);

  return (
    <>
      <section className="status-strip">
        <p className="muted">{cacheLine}</p>
        <button className="btn secondary" type="button" onClick={runRefresh} disabled={busy}><RefreshCw size={16} aria-hidden="true" />Refresh Index</button>
      </section>

      {progress ? (
        <section className="progress-panel">
          <div className="progress-meta">
            <span>{progress.status}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
          </div>
        </section>
      ) : null}

      <section className="control-panel">
        <form className="search-grid" onSubmit={runSearch}>
          <Field label="Exact Item" className="item-field">
            <input value={form.itemName} onChange={(event) => updateField('itemName', event.target.value)} required />
          </Field>
          <Field label="Rarity">
            <select value={form.rarity} onChange={(event) => updateField('rarity', event.target.value)}>
              <option value="any">Any</option>
              <option value="LEGENDARY">Legendary</option>
              <option value="MYTHIC">Mythic</option>
              <option value="EPIC">Epic</option>
              <option value="RARE">Rare</option>
              <option value="UNCOMMON">Uncommon</option>
              <option value="COMMON">Common</option>
            </select>
          </Field>
          <Field label="Recomb">
            <select value={form.recomb} onChange={(event) => updateField('recomb', event.target.value)}>
              <option value="any">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Stars">
            <select value={form.stars} onChange={(event) => updateField('stars', event.target.value)}>
              <option value="any">Any</option>
              <option value="0">0+</option>
              <option value="1">1+</option>
              <option value="2">2+</option>
              <option value="3">3+</option>
              <option value="4">4+</option>
              <option value="5">5+</option>
            </select>
          </Field>
          <Field label="Min Kills">
            <input type="number" min="0" value={form.minKills} onChange={(event) => updateField('minKills', event.target.value)} />
          </Field>
          <Field label="Max Kills">
            <input type="number" min="0" value={form.maxKills} onChange={(event) => updateField('maxKills', event.target.value)} />
          </Field>
          <Field label="Min Price">
            <input type="number" min="0" value={form.minPrice} onChange={(event) => updateField('minPrice', event.target.value)} placeholder="0" />
          </Field>
          <Field label="Max Price">
            <input type="number" min="0" value={form.maxPrice} onChange={(event) => updateField('maxPrice', event.target.value)} placeholder="Any" />
          </Field>
          <Field label="Enchants" className="enchant-field">
            <input value={form.enchants} onChange={(event) => updateField('enchants', event.target.value)} placeholder="e.g. Growth V, Protection V" />
          </Field>
          <Field label="Sort">
            <select value={form.sort} onChange={(event) => updateField('sort', event.target.value)}>
              <option value="price_asc">Price Low</option>
              <option value="price_desc">Price High</option>
              <option value="kills_desc">Kills High</option>
              <option value="ending_soon">Ending Soon</option>
            </select>
          </Field>
          <div className="form-actions">
            <button className="btn primary" type="submit" disabled={busy}><Search size={16} aria-hidden="true" />{busy ? 'Working...' : 'Search'}</button>
            <button className="btn gold" type="button" onClick={runRecommendation} disabled={busy}><Activity size={16} aria-hidden="true" />Recommend BIN</button>
          </div>
        </form>
      </section>

      <section className="stats-row">
        <StatCard title="Lowest BIN" value={lowest ? formatPrice(lowest.price) : '---'} detail={lowest ? `${formatNumber(lowest.kills)} kills` : 'No result'} variant="legendary" icon={Gavel} />
        <StatCard title="Average BIN" value={average ? formatPrice(average) : '---'} detail="Filtered listings" variant="mythic" icon={Activity} />
        <StatCard title="Matches" value={formatNumber(results.length)} detail={source} variant="rare" icon={Search} />
        <StatCard title="Recommended BIN" value={recommendation?.price ? formatPrice(recommendation.price) : '---'} detail={recommendation?.detail || 'Run recommendation'} variant="recommendation" icon={KeyRound} />
      </section>

      <section className="results-panel">
        <div className="section-heading">
          <h2>Active BIN Listings</h2>
          <span className="pill">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
        <AuctionTable results={results} onSelect={setSelectedItem} />
      </section>

      {selectedItem ? <TooltipModal item={selectedItem} onClose={() => setSelectedItem(null)} /> : null}
    </>
  );
}

function StatCard({ title, value, detail, variant, icon: Icon }) {
  return (
    <article className={`stat-card rarity-${variant}`}>
      <div className="stat-card-label">
        {Icon ? <Icon size={17} aria-hidden="true" /> : null}
        <span>{title}</span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function AuctionTable({ results, onSelect }) {
  if (!results.length) {
    return (
      <div className="table-wrap">
        <table>
          <tbody><tr><td className="empty-cell">No matching BIN listings</td></tr></tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Price</th>
            <th>Rarity</th>
            <th>Kills</th>
            <th>Stars</th>
            <th>Recomb</th>
            <th>Enchants</th>
            <th>Seller</th>
            <th>Ends</th>
            <th>Name</th>
          </tr>
        </thead>
        <tbody>
          {results.map((item, index) => {
            const enchantText = Object.entries(item.enchants || {})
              .slice(0, 3)
              .map(([name, level]) => `${name} ${level}`)
              .join(', ') || 'None';
            return (
              <tr key={item.uuid || index} onClick={() => onSelect(item)}>
                <td className="muted">#{index + 1}</td>
                <td className="price">{formatPrice(item.price)} <small>{formatNumber(item.price)}</small></td>
                <td><span className={`rarity ${String(item.rarity).toLowerCase().replace(/\s+/g, '-')}`}>{item.rarity}</span></td>
                <td>{formatNumber(item.kills)}</td>
                <td className="stars">{item.stars > 0 ? 'âœª'.repeat(item.stars) : 'None'}</td>
                <td>{item.recomb ? <span className="badge mythic">Yes</span> : <span className="badge">No</span>}</td>
                <td>{enchantText}</td>
                <td>{item.sellerName || `${String(item.auctioneer || '').slice(0, 8)}...`}</td>
                <td>{formatDuration(item.endsAt - Date.now())}</td>
                <td className="item-name">{item.displayName}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TooltipModal({ item, onClose }) {
  return (
    <div className="modal">
      <button className="modal-scrim" type="button" aria-label="Close item lore" onClick={onClose} />
      <section className="mc-tooltip">
        <div className="tooltip-head">
          <strong className={`rarity ${String(item.rarity).toLowerCase().replace(/\s+/g, '-')}`}>{item.displayName}</strong>
          <button type="button" onClick={onClose}>x</button>
        </div>
        <div className="tooltip-lore" dangerouslySetInnerHTML={{ __html: minecraftColorToHTML(item.raw_lore || item.cleanLore || '') }} />
        <footer className="tooltip-footer">
          <span>{formatNumber(item.price)} coins</span>
          <span>{item.sellerName || item.auctioneer}</span>
          <span>{formatDuration(item.endsAt - Date.now())}</span>
        </footer>
      </section>
    </div>
  );
}

function ProxyConfigModal({ account, draft, onChange, onSave, onClose }) {
  return (
    <div className="modal">
      <button className="modal-scrim" type="button" aria-label="Close proxy settings" onClick={onClose} />
      <section className="proxy-modal" aria-modal="true" role="dialog" aria-labelledby="proxy-modal-title">
        <div className="modal-head">
          <div>
            <span className="modal-eyebrow">Account Proxy</span>
            <h3 id="proxy-modal-title">{account.minecraft_username}</h3>
          </div>
          <button type="button" aria-label="Close proxy settings" onClick={onClose}>x</button>
        </div>
        <form className="proxy-modal-form" onSubmit={(event) => onSave(event, account)}>
          <Field label="Type">
            <select
              value={draft.proxyType}
              onChange={(event) => onChange(account.id, 'proxyType', event.target.value)}
            >
              <option value="SOCKS5">SOCKS5</option>
              <option value="SOCKS4">SOCKS4</option>
              <option value="HTTP">HTTP</option>
            </select>
          </Field>
          <Field label="Host">
            <input
              value={draft.proxyHost}
              onChange={(event) => onChange(account.id, 'proxyHost', event.target.value)}
              placeholder="127.0.0.1"
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              min="1"
              max="65535"
              value={draft.proxyPort}
              onChange={(event) => onChange(account.id, 'proxyPort', event.target.value)}
              placeholder="1080"
            />
          </Field>
          <Field label="Username">
            <input
              value={draft.proxyUsername}
              onChange={(event) => onChange(account.id, 'proxyUsername', event.target.value)}
              placeholder="Optional"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={draft.proxyPassword}
              onChange={(event) => onChange(account.id, 'proxyPassword', event.target.value)}
              placeholder={account.proxy_has_password ? 'Password set; leave blank to keep' : 'Optional'}
              autoComplete="new-password"
            />
          </Field>
          <div className="modal-actions">
            <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="btn primary" type="submit">Set Proxy</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function liveControlStateMap(accounts) {
  return Object.fromEntries((accounts || []).map((entry) => [entry.accountId, entry.state || {}]));
}

function dashboardReconnectDelayMs(attempt) {
  const cleanAttempt = Math.max(0, Number.isFinite(Number(attempt)) ? Number(attempt) : 0);
  return Math.min(10_000, 1_000 * (2 ** Math.min(4, cleanAttempt)));
}

function remoteLogSourceLabel(source) {
  const normalized = String(source || 'system').trim().toLowerCase();
  if (normalized === 'chat') return 'Chat';
  if (normalized === 'debug') return 'Debug';
  if (normalized === 'status') return 'Status';
  return 'System';
}

function remoteLogSegmentStyle(segment) {
  const style = {};
  if (segment?.color) style.color = segment.color;
  if (segment?.bold) style.fontWeight = 800;
  if (segment?.italic) style.fontStyle = 'italic';
  const decorations = [];
  if (segment?.underline) decorations.push('underline');
  if (segment?.strikethrough) decorations.push('line-through');
  if (decorations.length) style.textDecoration = decorations.join(' ');
  return style;
}

function RemoteLogPanel({ title, description, logs, emptyOnlineText, emptyOfflineText, isOnline }) {
  const logLines = [...(logs || [])].reverse();
  const logScrollRef = useRef(null);
  const [isLogsFollowing, setIsLogsFollowing] = useState(true);
  const latestLogKey = logLines.length
    ? (logLines[logLines.length - 1].id || `${logLines[logLines.length - 1].createdAt}-${logLines[logLines.length - 1].message}`)
    : 'empty';

  useEffect(() => {
    if (!isLogsFollowing) return;
    const scrollToLatest = () => {
      if (logScrollRef.current) {
        logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
      }
    };
    window.requestAnimationFrame(() => {
      scrollToLatest();
      window.setTimeout(scrollToLatest, 0);
    });
  }, [latestLogKey, isLogsFollowing, title]);

  return (
    <section className="remote-panel remote-log-panel">
      <div className="remote-log-head">
        <div className="remote-section-title">
          <div><FileText size={18} aria-hidden="true" /></div>
          <div>
            <h3>{title}</h3>
            <p className="muted">{description}</p>
          </div>
        </div>
        <div className="remote-log-actions">
          <span className={`status-badge live-status-badge ${isOnline ? 'active' : 'offline'}`}>
            <span className="status-word">{isOnline ? 'Live' : 'Offline'}</span>
          </span>
          <button
            className="btn secondary compact remote-follow-button"
            type="button"
            onClick={() => {
              setIsLogsFollowing(true);
              if (logScrollRef.current) {
                logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
              }
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {isLogsFollowing ? 'Following' : 'Focus Latest'}
          </button>
        </div>
      </div>
      <div
        className="remote-log-list"
        ref={logScrollRef}
        onScroll={() => {
          const element = logScrollRef.current;
          if (!element) return;
          const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
          setIsLogsFollowing(distanceFromBottom <= 48);
        }}
      >
        {logLines.length ? (
          <div className="remote-log-lines">
            {logLines.map((entry) => (
              <div className={`remote-log-line ${entry.level || 'info'}`} key={entry.id || `${entry.createdAt}-${entry.message}`}>
                <time>{entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString() : '--:--:--'}</time>
                <span className={`remote-log-source source-${entry.source || 'system'}`}>[{remoteLogSourceLabel(entry.source)}]</span>
                <span className="remote-log-level">[{entry.level || 'info'}]</span>
                <p>
                  {Array.isArray(entry.segments) && entry.segments.length ? (
                    entry.segments.map((segment, index) => (
                      <span
                        className="remote-log-segment"
                        key={`${entry.id || entry.createdAt}:${index}`}
                        style={remoteLogSegmentStyle(segment)}
                      >
                        {segment.text}
                      </span>
                    ))
                  ) : entry.message}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="remote-empty-log">
            <Monitor size={28} aria-hidden="true" />
            <p>{isOnline ? emptyOnlineText : emptyOfflineText}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function AccountWealthStrip({ stats }) {
  const fdMinimum = stats?.finalDestinationKills?.minimum;
  const items = [
    { label: 'Purse', value: formatCoins(stats?.purse) },
    { label: 'Expected', value: formatCoins(stats?.expectedCoins) },
    { label: 'Eyes', value: formatStatNumber(stats?.summoningEyesHeld) },
    { label: 'FD', value: fdMinimum == null ? '-' : formatStatNumber(fdMinimum) },
  ];
  return (
    <div className="account-wealth-strip" aria-label="Account wealth summary">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function auctionEventIcon(event) {
  const itemName = String(event?.itemName || '').toLowerCase();
  if (itemName.includes('final destination')) {
    if (itemName.includes('helmet')) return fdHelmetIcon;
    if (itemName.includes('chestplate')) return fdChestplateIcon;
    if (itemName.includes('leggings')) return fdLeggingsIcon;
    if (itemName.includes('boots')) return fdBootsIcon;
  }
  return coinGoldIcon;
}

function auctionEventTitle(event) {
  const itemName = String(event?.itemName || '').trim();
  if (itemName) {
    if (event.state === 'collected') return `${itemName} collected`;
    return event.state === 'sold' ? `${itemName} sold` : `${itemName} expired`;
  }
  if (event.state === 'collected') return 'Auction collected';
  return event.state === 'sold' ? 'Auction sold' : 'Auction expired';
}

function RemoteWealthPanel({ stats }) {
  const finalDestinationKills = stats?.finalDestinationKills || {};
  const macroRates = stats?.macroRates || null;
  const auctionEvents = Array.isArray(stats?.auctionEvents) ? stats.auctionEvents : [];
  const moneyRows = [
    ['Reported purse', stats?.purse],
    ['Sold auction credit', stats?.soldAuctionCredit],
    ['Auction listings', stats?.ahListedValue],
    ['Held eye value', stats?.heldEyeValue],
    ['Listed eye value', stats?.listedEyeValue],
    ['Expected future', stats?.expectedCoins],
    ['Current total', stats?.currentTotalCoins],
  ];
  const fdRows = [
    ['Helmet', finalDestinationKills.helmet],
    ['Chestplate', finalDestinationKills.chestplate],
    ['Leggings', finalDestinationKills.leggings],
    ['Boots', finalDestinationKills.boots],
  ];

  return (
    <section className="remote-panel remote-wealth-panel">
      <div className="remote-section-title">
        <div><img className="wealth-title-icon" src={coinGoldIcon} alt="" aria-hidden="true" /></div>
        <div>
          <h3>Account Wealth</h3>
          <p className="muted">Purse, active auctions, summoning eyes, and Final Destination armor progress.</p>
        </div>
      </div>
      <div className="remote-wealth-grid">
        <div className="remote-wealth-group">
          <div className="remote-wealth-group-head">
            <img className="wealth-icon" src={coinGoldIcon} alt="" aria-hidden="true" />
            <span>Coins</span>
          </div>
          {moneyRows.map(([label, value]) => (
            <div className="remote-wealth-row" key={label}>
              <span>{label}</span>
              <strong>{formatCoins(value)}</strong>
            </div>
          ))}
        </div>
        <div className="remote-wealth-group">
          <div className="remote-wealth-group-head">
            <img className="wealth-icon" src={summoningEyeIcon} alt="" aria-hidden="true" />
            <span>Summoning Eyes</span>
          </div>
          <div className="remote-wealth-row">
            <span>Held</span>
            <strong>{formatStatNumber(stats?.summoningEyesHeld)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Listed</span>
            <strong>{formatStatNumber(stats?.summoningEyesListed)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Listed price</span>
            <strong>{formatCoins(stats?.summoningEyeListPrice)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Last stat update</span>
            <strong>{formatTimestamp(stats?.updatedAt)}</strong>
          </div>
        </div>
        <div className="remote-wealth-group">
          <div className="remote-wealth-group-head">
            <img className="wealth-icon" src={fdHelmetIcon} alt="" aria-hidden="true" />
            <span>Final Destination</span>
          </div>
          {fdRows.map(([label, value]) => (
            <div className="remote-wealth-row" key={label}>
              <span>{label}</span>
              <strong>{value == null ? '-' : formatStatNumber(value)}</strong>
            </div>
          ))}
          <div className="remote-wealth-row">
            <span>Lowest piece</span>
            <strong>{finalDestinationKills.minimum == null ? '-' : formatStatNumber(finalDestinationKills.minimum)}</strong>
          </div>
        </div>
      </div>
      {macroRates ? (
        <div className="remote-wealth-group remote-macro-group">
          <div className="remote-wealth-group-head">
            <Activity size={18} aria-hidden="true" />
            <span>Macroing Rate</span>
          </div>
          <div className="remote-wealth-row">
            <span>Session</span>
            <strong>{formatDuration(macroRates.elapsedMs)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Kills / h</span>
            <strong>{formatStatNumber(macroRates.fdKillsPerHour)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Mob coins / h</span>
            <strong>{formatCoins(macroRates.mobCoinsPerHour)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Eyes / h</span>
            <strong>{formatStatNumber(macroRates.eyeDropsPerHour)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>FD value / h</span>
            <strong>{formatCoins(macroRates.fdValuePerHour)}</strong>
          </div>
          <div className="remote-wealth-row">
            <span>Total / h</span>
            <strong>{formatCoins(macroRates.totalCoinsPerHour)}</strong>
          </div>
        </div>
      ) : null}
      {auctionEvents.length ? (
        <div className="remote-auction-events">
          {auctionEvents.map((event) => (
            <div className={`remote-auction-event ${event.state}`} key={`${event.auctionUuid}:${event.updatedAt}`}>
              <span className="remote-auction-event-title">
                <img className="remote-auction-event-icon" src={auctionEventIcon(event)} alt="" aria-hidden="true" />
                <span>{auctionEventTitle(event)}</span>
              </span>
              <strong>{event.state === 'sold' || event.state === 'collected' ? `+${formatCoins(event.price)}` : `Removed ${formatCoins(event.price)}`}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RemoteControlPage({ account, state, nowMs, onRequestScreenshot, onSendAction, onBack }) {
  const [isScreenshotExpanded, setIsScreenshotExpanded] = useState(false);
  const [actionType, setActionType] = useState('server_command');
  const [actionDraft, setActionDraft] = useState('');
  const [isActionSending, setIsActionSending] = useState(false);
  const logs = state?.logs || [];
  const chatLogs = logs.filter((entry) => String(entry.source || '').toLowerCase() === 'chat');
  const autoAuctionLogs = logs.filter((entry) => String(entry.source || 'system').toLowerCase() !== 'chat');
  const screenshot = state?.screenshot || null;
  const lastError = state?.lastError || null;
  const isScreenshotLoading = Boolean(state?.isScreenshotLoading);
  const displayStatus = displayAccountStatus(account, nowMs);
  const isOnline = isLiveAccountStatus(displayStatus);
  const screenshotAgeTimestamp = screenshot?.receivedAt || screenshot?.capturedAt;
  const screenshotAgeMs = screenshotAgeTimestamp ? nowMs - Date.parse(screenshotAgeTimestamp) : null;
  const screenshotDataUrl = screenshot?.imageBase64
    ? `data:${screenshot.imageMime || 'image/jpeg'};base64,${screenshot.imageBase64}`
    : null;
  const actionPrefix = actionType === 'text_message' ? '' : '/';
  const actionPlaceholder = actionType === 'client_command'
    ? 'autoauction'
    : actionType === 'server_command'
      ? 'warp end'
      : 'hello there';
  const canSendAction = isOnline && !isActionSending && actionDraft.trim().length > 0;

  const submitRemoteAction = async (event) => {
    event.preventDefault();
    if (!canSendAction) return;
    setIsActionSending(true);
    const sent = await onSendAction(account.id, actionType, actionDraft);
    if (sent) {
      setActionDraft('');
    }
    setIsActionSending(false);
  };

  useEffect(() => {
    if (!isScreenshotExpanded) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsScreenshotExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isScreenshotExpanded]);

  return (
    <section className="remote-page">
      <div className="remote-page-head">
        <div>
          <h2>Remote Control</h2>
          <p className="muted">Monitor and manage the connected Minecraft instance.</p>
        </div>
        <button className="btn secondary compact" type="button" onClick={() => onRequestScreenshot(account.id)} disabled={isScreenshotLoading}>
          {isScreenshotLoading ? <Loader2 size={15} aria-hidden="true" className="spin-icon" /> : <RefreshCw size={15} aria-hidden="true" />}
          {isScreenshotLoading ? 'Refreshing' : 'Refresh Status'}
        </button>
      </div>

      <div className="remote-detail-grid">
        <section className="remote-panel remote-screenshot-panel">
          <div className="remote-instance-head">
            <div className="remote-instance-left">
              <button className="remote-icon-button" type="button" aria-label="Back to dashboard" onClick={onBack}>
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <img
                className="remote-avatar"
                src={mineatarFaceUrl(account.minecraft_uuid)}
                alt={`${account.minecraft_username} Minecraft skin face`}
              />
              <div className="remote-instance-copy">
                <div className="remote-title-row">
                  <h3>{account.minecraft_username}</h3>
                  <span className={`status-badge live-status-badge ${displayStatus}`}>
                    <span className="status-word">{isOnline ? 'Connected' : displayStatus}</span>
                  </span>
                </div>
                <div className="remote-meta-line">
                  <span><Clock size={14} aria-hidden="true" />Last update {state?.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : 'Waiting'}</span>
                  <span>{lastError?.message || (isScreenshotLoading ? 'Refreshing screenshot' : screenshot ? 'Live screenshot ready' : 'Waiting for first screenshot')}</span>
                </div>
              </div>
            </div>
            <div className="remote-instance-actions">
              <div>
                <span>Status</span>
                <strong className={isOnline ? 'remote-online' : ''}>{isOnline ? 'Connected' : 'Offline'}</strong>
              </div>
              <button className="btn secondary compact" type="button" onClick={() => onRequestScreenshot(account.id)} disabled={isScreenshotLoading}>
                {isScreenshotLoading ? <Loader2 size={15} aria-hidden="true" className="spin-icon" /> : <RefreshCw size={15} aria-hidden="true" />}
                {isScreenshotLoading ? 'Refreshing' : 'Refresh'}
              </button>
            </div>
          </div>

          <div className="remote-screenshot-stage">
            {lastError ? (
              <div className="remote-inline-error">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{lastError.message}</span>
              </div>
            ) : null}
            {screenshotDataUrl ? (
              <>
                <img
                  className={isScreenshotLoading ? 'is-loading' : ''}
                  src={screenshotDataUrl}
                  alt={`${account.minecraft_username} game screenshot`}
                />
                {isScreenshotLoading ? (
                  <div className="remote-loading-overlay" aria-live="polite" aria-label="Refreshing screenshot">
                    <div className="remote-loading-dot" />
                    <div className="remote-loading-ring">
                      <Loader2 size={38} aria-hidden="true" className="spin-icon" />
                    </div>
                  </div>
                ) : null}
                <div className="remote-screenshot-overlay">
                  <span>{screenshotAgeMs != null && Number.isFinite(screenshotAgeMs) ? `${Math.max(0, Math.round(screenshotAgeMs / 1000))}s ago` : 'Latest'}</span>
                </div>
                <button className="remote-enlarge-button" type="button" onClick={() => setIsScreenshotExpanded(true)} aria-label="Open screenshot preview">
                  <span className="remote-enlarge-pill">
                    <ExternalLink size={16} aria-hidden="true" />
                    Click to enlarge
                  </span>
                </button>
              </>
            ) : (
              <div className={`remote-empty-screenshot ${isScreenshotLoading ? 'is-loading' : ''}`}>
                {!isScreenshotLoading ? (
                  <div className="remote-empty-screenshot-icon"><Monitor size={42} aria-hidden="true" /></div>
                ) : null}
                {isScreenshotLoading ? (
                  <div className="remote-loading-inline" aria-live="polite">
                    <div className="remote-loading-dot" />
                    <div className="remote-loading-ring">
                      <Loader2 size={34} aria-hidden="true" className="spin-icon" />
                    </div>
                  </div>
                ) : null}
                <p>{isScreenshotLoading ? 'Requesting a fresh screenshot from this instance.' : 'Waiting for the first screenshot from this instance.'}</p>
                <button className="btn secondary compact" type="button" onClick={() => onRequestScreenshot(account.id)}>
                  <Camera size={15} aria-hidden="true" />Request Screenshot
                </button>
              </div>
            )}
          </div>
        </section>

        <form className="remote-panel remote-action-panel" onSubmit={submitRemoteAction}>
          <div className="remote-section-title">
            <div><Send size={18} aria-hidden="true" /></div>
            <div>
              <h3>Send Action</h3>
              <p className="muted">Choose an action type and send it to this connected instance.</p>
            </div>
          </div>
          <Field label="Action Type">
            <select disabled={!isOnline || isActionSending} value={actionType} onChange={(event) => setActionType(event.target.value)}>
              <option value="client_command">Client Command</option>
              <option value="server_command">Server Command</option>
              <option value="text_message">Text Message</option>
            </select>
          </Field>
          <Field label="Message / Command">
            <div className="remote-command-input">
              {actionPrefix ? <span>{actionPrefix}</span> : null}
              <input
                disabled={!isOnline || isActionSending}
                placeholder={actionPlaceholder}
                value={actionDraft}
                onChange={(event) => setActionDraft(event.target.value)}
              />
            </div>
          </Field>
          <p className="remote-hint">{isOnline ? 'Commands are sent to this connected instance over the live control socket.' : 'This instance must be connected before actions can be sent.'}</p>
          <button className="btn primary" type="submit" disabled={!canSendAction}>
            {isActionSending ? <Loader2 size={15} aria-hidden="true" className="spin-icon" /> : <Send size={15} aria-hidden="true" />}
            {isActionSending ? 'Sending' : 'Send Action'}
          </button>
          <div className="remote-examples">
            <span>Examples</span>
            <p><strong>Client:</strong> /autoauction</p>
            <p><strong>Server:</strong> /warp end</p>
            <p><strong>Text:</strong> hello there</p>
          </div>
        </form>
      </div>

      <RemoteWealthPanel stats={account.wealthStats} />

      <RemoteLogPanel
        title="In-game Logs"
        description="Recent Minecraft chat lines from this instance."
        logs={chatLogs}
        emptyOnlineText="Waiting for the first in-game chat line."
        emptyOfflineText="This instance is offline. Chat logs clear when the instance closes."
        isOnline={isOnline}
      />

      <RemoteLogPanel
        title="Auto Auction Logs"
        description="Recent AutoAuction workflow and system outputs."
        logs={autoAuctionLogs}
        emptyOnlineText="Waiting for the first AutoAuction log line."
        emptyOfflineText="This instance is offline. Stored AutoAuction logs will appear here when available."
        isOnline={isOnline}
      />

      {isScreenshotExpanded && screenshotDataUrl ? (
        <div className="remote-lightbox" role="dialog" aria-modal="true" aria-label="Screenshot preview" onClick={() => setIsScreenshotExpanded(false)}>
          <div className="remote-lightbox-shell" onClick={(event) => event.stopPropagation()}>
            <div className="remote-lightbox-head">
              <div>
                <p>Screenshot preview</p>
                <h3>{account.minecraft_username}</h3>
              </div>
              <div className="remote-lightbox-actions">
                <button className="btn secondary compact" type="button" onClick={() => onRequestScreenshot(account.id)} disabled={isScreenshotLoading}>
                  {isScreenshotLoading ? <Loader2 size={15} aria-hidden="true" className="spin-icon" /> : <RefreshCw size={15} aria-hidden="true" />}
                  {isScreenshotLoading ? 'Refreshing' : 'Refresh screenshot'}
                </button>
                <button className="remote-lightbox-close" type="button" onClick={() => setIsScreenshotExpanded(false)} aria-label="Close screenshot preview">
                  <X size={20} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="remote-lightbox-stage">
              <img
                className={isScreenshotLoading ? 'is-loading' : ''}
                src={screenshotDataUrl}
                alt={`${account.minecraft_username} expanded game screenshot`}
              />
              {isScreenshotLoading ? (
                <div className="remote-loading-overlay" aria-live="polite" aria-label="Refreshing screenshot">
                  <div className="remote-loading-dot" />
                  <div className="remote-loading-ring">
                    <Loader2 size={38} aria-hidden="true" className="spin-icon" />
                  </div>
                </div>
              ) : null}
              <div className="remote-screenshot-overlay">
                <span>{screenshotAgeMs != null && Number.isFinite(screenshotAgeMs) ? `${Math.max(0, Math.round(screenshotAgeMs / 1000))}s ago` : 'Latest'}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DashboardView({ remoteAccountKey = null, navigateView }) {
  const [me, setMe] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [modReleases, setModReleases] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [dashboardUsers, setDashboardUsers] = useState([]);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [accountForm, setAccountForm] = useState(defaultAccountForm);
  const [keyForm, setKeyForm] = useState(defaultKeyForm);
  const [userForm, setUserForm] = useState(defaultUserForm);
  const [statusMessage, setStatusMessage] = useState('Log in to access the dashboard');
  const [issuedKey, setIssuedKey] = useState(null);
  const [roleDrafts, setRoleDrafts] = useState({});
  const [proxyDrafts, setProxyDrafts] = useState({});
  const [summoningEyeDrafts, setSummoningEyeDrafts] = useState({});
  const [activeProxyAccountId, setActiveProxyAccountId] = useState(null);
  const [liveControlByAccountId, setLiveControlByAccountId] = useState({});
  const [nowMs, setNowMs] = useState(Date.now());
  const [activeAccountFolder, setActiveAccountFolder] = useState('all');
  const [screenshotRefreshNonce, setScreenshotRefreshNonce] = useState(0);
  const dashboardSocketRef = useRef(null);
  const screenshotTimeoutsRef = useRef(new Map());
  const autoRefreshAccountRef = useRef(null);
  const remoteLiveAccountIdRef = useRef(null);

  const clearScreenshotTimeout = useCallback((accountId) => {
    const timer = screenshotTimeoutsRef.current.get(Number(accountId));
    if (timer) {
      window.clearTimeout(timer);
      screenshotTimeoutsRef.current.delete(Number(accountId));
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const [meBody, accountsBody, releasesBody] = await Promise.all([
        apiFetch('/api/dashboard/me', null),
        apiFetch('/api/dashboard/accounts', null),
        apiFetch('/api/dashboard/mod-releases', null),
      ]);
      const keysBody = meBody.user.role === 'owner'
        ? await apiFetch('/api/dashboard/api-keys', null)
        : { apiKeys: [] };
      const usersBody = meBody.user.role === 'owner'
        ? await apiFetch('/api/dashboard/users', null)
        : { users: [] };
      setMe(meBody.user);
      setAccounts(accountsBody.accounts || []);
      setModReleases(releasesBody.releases || []);
      setProxyDrafts(proxyDraftsFromAccounts(accountsBody.accounts || []));
      setApiKeys(keysBody.apiKeys || []);
      setDashboardUsers(usersBody.users || []);
      setStatusMessage('Dashboard loaded');
    } catch (err) {
      setMe(null);
      setAccounts([]);
      setModReleases([]);
      setProxyDrafts({});
      setActiveProxyAccountId(null);
      setLiveControlByAccountId({});
      setApiKeys([]);
      setDashboardUsers([]);
      setStatusMessage(err.message);
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!me) return undefined;

    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;

    const connectSocket = () => {
      if (closed) return;
      const attemptForConnection = reconnectAttempt;
      const socket = new WebSocket(websocketUrl('/api/dashboard/ws'));
      dashboardSocketRef.current = socket;

      socket.onopen = () => {
        if (attemptForConnection > 0) {
          setStatusMessage('Dashboard live updates reconnected');
        }
        const subscribedAccountId = remoteLiveAccountIdRef.current;
        if (subscribedAccountId) {
          socket.send(JSON.stringify({ type: 'live_control_subscribe', accountId: subscribedAccountId }));
        }
        reconnectAttempt = 0;
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'accounts') {
            const nextAccounts = data.accounts || [];
            setAccounts(nextAccounts);
            setProxyDrafts((current) => mergeProxyDraftsFromAccounts(nextAccounts, current, activeProxyAccountId));
          } else if (data.type === 'live_control_snapshot') {
            const snapshot = liveControlStateMap(data.accounts);
            setLiveControlByAccountId((current) => ({ ...current, ...snapshot }));
          } else if (data.type === 'live_control_update') {
            const incomingState = data.state || {};
            const hasScreenshot = Boolean(incomingState.screenshot?.imageBase64);
            const isCleared = Boolean(incomingState.clearedAt);
            if (hasScreenshot || isCleared) {
              clearScreenshotTimeout(data.accountId);
            }
            setLiveControlByAccountId((current) => {
              const previous = current[data.accountId] || {};
              return {
                ...current,
                [data.accountId]: {
                  ...previous,
                  ...incomingState,
                  lastError: hasScreenshot || isCleared ? null : previous.lastError,
                  isScreenshotLoading: hasScreenshot || isCleared ? false : Boolean(previous.isScreenshotLoading),
                },
              };
            });
          } else if (data.type === 'live_control_log') {
            const incomingLog = data.log;
            if (!incomingLog) return;
            setLiveControlByAccountId((current) => {
              const previous = current[data.accountId] || {};
              return {
                ...current,
                [data.accountId]: {
                  ...previous,
                  logs: [incomingLog, ...(previous.logs || [])].slice(0, 100),
                  updatedAt: data.updatedAt || previous.updatedAt,
                  clearedAt: null,
                },
              };
            });
          } else if (data.type === 'live_control_action_sent') {
            setStatusMessage('Remote action sent');
          } else if (data.type === 'live_control_error') {
            setStatusMessage(data.message || 'Live control request failed');
            if (data.accountId) {
              clearScreenshotTimeout(data.accountId);
              setLiveControlByAccountId((current) => ({
                ...current,
                [data.accountId]: {
                  ...(current[data.accountId] || {}),
                  isScreenshotLoading: false,
                  lastError: {
                    code: data.code || 'live_control_error',
                    message: data.message || 'Live control request failed',
                    createdAt: new Date().toISOString(),
                  },
                },
              }));
            }
          }
        } catch (err) {
          console.error('Dashboard websocket message failed:', err);
        }
      };

      socket.onclose = () => {
        if (dashboardSocketRef.current === socket) {
          dashboardSocketRef.current = null;
        }
        if (closed) return;
        const delayMs = dashboardReconnectDelayMs(reconnectAttempt);
        reconnectAttempt += 1;
        setStatusMessage(`Dashboard live updates disconnected; reconnecting in ${Math.round(delayMs / 1000)}s`);
        reconnectTimer = window.setTimeout(connectSocket, delayMs);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connectSocket();

    return () => {
      closed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (dashboardSocketRef.current) {
        const socket = dashboardSocketRef.current;
        dashboardSocketRef.current = null;
        socket.close();
      }
    };
  }, [activeProxyAccountId, me, clearScreenshotTimeout]);

  useEffect(() => () => {
    for (const timer of screenshotTimeoutsRef.current.values()) {
      window.clearTimeout(timer);
    }
    screenshotTimeoutsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!remoteAccountKey && !accounts.some((account) => (
      account.status === 'banned'
      && (account.ban_until || account.banned_folder_available_at)
    ))) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [accounts, remoteAccountKey]);

  useEffect(() => {
    const hasExpiredBan = accounts.some((account) => (
      account.status === 'banned'
      && account.ban_until
      && Date.parse(account.ban_until) <= nowMs
    ));
    if (hasExpiredBan) {
      loadDashboard();
    }
  }, [accounts, loadDashboard, nowMs]);

  const login = useCallback(async (event) => {
    event.preventDefault();
    try {
      setDashboardLoading(true);
      const body = await apiFetch('/api/dashboard/login', null, {
        method: 'POST',
        body: JSON.stringify(loginForm),
      });
      setMe(body.user);
      setLoginForm({ username: '', password: '' });
      setStatusMessage('Dashboard loaded');
      await loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
      setDashboardLoading(false);
    }
  }, [loadDashboard, loginForm]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/dashboard/logout', null, { method: 'POST' });
    } catch (err) {
      console.error('Logout failed:', err);
    }
    setMe(null);
    setAccounts([]);
    setProxyDrafts({});
    setActiveProxyAccountId(null);
    setLiveControlByAccountId({});
    setApiKeys([]);
    setDashboardUsers([]);
    setIssuedKey(null);
    setDashboardLoading(false);
    setStatusMessage('Logged out');
  }, []);

  const updateAccountForm = useCallback((field, value) => {
    setAccountForm((current) => ({ ...current, [field]: value }));
  }, []);

  const updateKeyForm = useCallback((field, value) => {
    setKeyForm((current) => ({ ...current, [field]: value }));
  }, []);

  const updateUserForm = useCallback((field, value) => {
    setUserForm((current) => ({ ...current, [field]: value }));
  }, []);

  const updateProxyDraft = useCallback((accountId, field, value) => {
    setProxyDrafts((current) => ({
      ...current,
      [accountId]: {
        ...(current[accountId] || {}),
        [field]: value,
      },
    }));
  }, []);

  const openProxyModal = useCallback((account) => {
    setProxyDrafts((current) => ({
      ...current,
      [account.id]: current[account.id] || proxyDraftFromAccount(account),
    }));
    setActiveProxyAccountId(account.id);
  }, []);

  const toggleScope = useCallback((scope) => {
    setKeyForm((current) => {
      const scopeSet = new Set(current.scopes);
      if (scopeSet.has(scope)) scopeSet.delete(scope);
      else scopeSet.add(scope);
      return { ...current, scopes: [...scopeSet] };
    });
  }, []);

  const createAccount = useCallback(async (event) => {
    event.preventDefault();
    try {
      await apiFetch('/api/dashboard/accounts', null, {
        method: 'POST',
        body: JSON.stringify(accountForm),
      });
      setAccountForm(defaultAccountForm);
      setStatusMessage('Account registered');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [accountForm, loadDashboard]);

  const createKey = useCallback(async (event) => {
    event.preventDefault();
    try {
      if (!keyForm.userId) {
        setStatusMessage('Select a dashboard user for this API key');
        return;
      }
      const body = await apiFetch('/api/dashboard/api-keys', null, {
        method: 'POST',
        body: JSON.stringify({
          ...keyForm,
          userId: Number(keyForm.userId),
        }),
      });
      setIssuedKey(body.apiKey);
      setKeyForm(defaultKeyForm);
      setStatusMessage('API key created. Copy it now; it will not be shown again.');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [keyForm, loadDashboard]);

  const createDashboardUser = useCallback(async (event) => {
    event.preventDefault();
    try {
      await apiFetch('/api/dashboard/users', null, {
        method: 'POST',
        body: JSON.stringify(userForm),
      });
      setUserForm(defaultUserForm);
      setStatusMessage('Dashboard user created');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard, userForm]);

  const updateDashboardUserRole = useCallback(async (user) => {
    const nextRole = roleDrafts[user.id] || user.role;
    try {
      await apiFetch('/api/dashboard/users/role', null, {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          role: nextRole,
        }),
      });
      setStatusMessage('Dashboard user role updated');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard, roleDrafts]);

  const deleteMinecraftAccount = useCallback(async (account) => {
    const confirmed = window.confirm(`Delete Minecraft account "${account.minecraft_username}" from the dashboard?`);
    if (!confirmed) return;
    try {
      await apiFetch('/api/dashboard/accounts/delete', null, {
        method: 'POST',
        body: JSON.stringify({ accountId: account.id }),
      });
      setStatusMessage('Minecraft account deleted');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard]);

  const moveMinecraftAccountToBannedFolder = useCallback(async (account) => {
    try {
      await apiFetch('/api/dashboard/accounts/banned-folder', null, {
        method: 'POST',
        body: JSON.stringify({ accountId: account.id }),
      });
      setStatusMessage('Account moved to Banned');
      setActiveAccountFolder('banned');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard]);

  const saveAccountProxy = useCallback(async (event, account) => {
    event.preventDefault();
    const draft = proxyDrafts[account.id] || proxyDraftFromAccount(account);
    const password = String(draft.proxyPassword || '').trim();
    try {
      await apiFetch('/api/dashboard/accounts/proxy', null, {
        method: 'POST',
        body: JSON.stringify({
          accountId: account.id,
          proxyEnabled: true,
          proxyType: draft.proxyType,
          proxyHost: draft.proxyHost,
          proxyPort: draft.proxyPort,
          proxyUsername: draft.proxyUsername,
          ...(password ? { proxyPassword: password } : {}),
        }),
      });
      setStatusMessage(`Proxy saved for ${account.minecraft_username}`);
      loadDashboard();
      setActiveProxyAccountId(null);
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard, proxyDrafts]);

  const updateSummoningEyeDraft = useCallback((accountId, value) => {
    setSummoningEyeDrafts((current) => ({
      ...current,
      [accountId]: value,
    }));
  }, []);

  const saveSummoningEyeCorrection = useCallback(async (event, account) => {
    event.preventDefault();
    const rawValue = summoningEyeDrafts[account.id] ?? account.wealthStats?.summoningEyesHeld ?? 0;
    const summoningEyesHeld = Number(rawValue);
    if (!Number.isSafeInteger(summoningEyesHeld) || summoningEyesHeld < 0) {
      setStatusMessage('Held eyes must be a non-negative whole number');
      return;
    }
    try {
      await apiFetch('/api/dashboard/accounts/summoning-eyes', null, {
        method: 'POST',
        body: JSON.stringify({
          accountId: account.id,
          summoningEyesHeld,
        }),
      });
      setSummoningEyeDrafts((current) => {
        const next = { ...current };
        delete next[account.id];
        return next;
      });
      setStatusMessage(`Held eyes corrected for ${account.minecraft_username}`);
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard, summoningEyeDrafts]);

  const deleteDashboardUser = useCallback(async (user) => {
    const confirmed = window.confirm(`Delete dashboard user "${user.username}"?`);
    if (!confirmed) return;
    try {
      await apiFetch('/api/dashboard/users/delete', null, {
        method: 'POST',
        body: JSON.stringify({ userId: user.id }),
      });
      setStatusMessage('Dashboard user deleted');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard]);

  const revokeKey = useCallback(async (apiKeyId) => {
    try {
      await apiFetch('/api/dashboard/api-keys/revoke', null, {
        method: 'POST',
        body: JSON.stringify({ apiKeyId }),
      });
      setStatusMessage('API key revoked');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard]);

  const deleteKey = useCallback(async (key) => {
    const confirmed = window.confirm(`Delete revoked API key "${key.name}"?`);
    if (!confirmed) return;
    try {
      await apiFetch('/api/dashboard/api-keys/delete', null, {
        method: 'POST',
        body: JSON.stringify({ apiKeyId: key.id }),
      });
      setStatusMessage('API key deleted');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard]);

  const replaceKey = useCallback(async (apiKeyId) => {
    try {
      const body = await apiFetch('/api/dashboard/api-keys/replace', null, {
        method: 'POST',
        body: JSON.stringify({ apiKeyId }),
      });
      setIssuedKey(body.apiKey);
      setStatusMessage('API key replaced. Copy the new key now.');
      loadDashboard();
    } catch (err) {
      setStatusMessage(err.message);
    }
  }, [loadDashboard]);

  const copyText = useCallback(async (value, label) => {
    const text = String(value || '').trim();
    if (!text) {
      setStatusMessage(`No ${label} to copy`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage(`${label} copied`);
    } catch (err) {
      setStatusMessage(`Could not copy ${label}: ${err.message}`);
    }
  }, []);

  const connectAccount = useCallback((account) => {
    navigateView('remote', account);
    setStatusMessage(`Live control opened for ${account.minecraft_username}`);
  }, [navigateView]);

  const remoteAccount = remoteAccountKey
    ? accounts.find((account) => accountMatchesRemoteKey(account, remoteAccountKey)) || null
    : null;
  const remoteAccountStatus = remoteAccount ? displayAccountStatus(remoteAccount, nowMs) : null;

  const requestLiveScreenshot = useCallback((accountId, options = {}) => {
    const quiet = Boolean(options.quiet);
    const socket = dashboardSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      clearScreenshotTimeout(accountId);
      if (!quiet) {
        setStatusMessage('Dashboard live updates are not connected');
      }
      setLiveControlByAccountId((current) => ({
        ...current,
        [accountId]: {
          ...(current[accountId] || {}),
          isScreenshotLoading: false,
          lastError: {
            code: 'dashboard_socket_closed',
            message: 'Dashboard live updates are not connected',
            createdAt: new Date().toISOString(),
          },
        },
      }));
      return;
    }
    clearScreenshotTimeout(accountId);
    const timer = window.setTimeout(() => {
      screenshotTimeoutsRef.current.delete(Number(accountId));
      setLiveControlByAccountId((current) => ({
        ...current,
        [accountId]: {
          ...(current[accountId] || {}),
          isScreenshotLoading: false,
          lastError: {
            code: 'screenshot_timeout',
            message: 'Screenshot request timed out',
            createdAt: new Date().toISOString(),
          },
        },
      }));
      if (!quiet) {
        setStatusMessage('Screenshot request timed out');
      }
    }, 15000);
    screenshotTimeoutsRef.current.set(Number(accountId), timer);
    setLiveControlByAccountId((current) => ({
      ...current,
      [accountId]: {
        ...(current[accountId] || {}),
        isScreenshotLoading: true,
        lastError: null,
      },
    }));
    socket.send(JSON.stringify({ type: 'request_screenshot', accountId }));
    if (!quiet) {
      setScreenshotRefreshNonce((current) => current + 1);
      setStatusMessage('Screenshot refresh requested');
    }
  }, [clearScreenshotTimeout]);

  const sendLiveAction = useCallback(async (accountId, actionType, content) => {
    const socket = dashboardSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatusMessage('Dashboard live updates are not connected');
      setLiveControlByAccountId((current) => ({
        ...current,
        [accountId]: {
          ...(current[accountId] || {}),
          lastError: {
            code: 'dashboard_socket_closed',
            message: 'Dashboard live updates are not connected',
            createdAt: new Date().toISOString(),
          },
        },
      }));
      return false;
    }
    socket.send(JSON.stringify({
      type: 'send_action',
      accountId,
      actionType,
      content,
    }));
    setStatusMessage('Remote action queued');
    return true;
  }, []);

  useEffect(() => {
    const accountId = remoteAccount?.id ? Number(remoteAccount.id) : null;
    const previousAccountId = remoteLiveAccountIdRef.current;
    remoteLiveAccountIdRef.current = accountId;
    const socket = dashboardSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return undefined;
    }
    if (accountId) {
      socket.send(JSON.stringify({ type: 'live_control_subscribe', accountId }));
    } else if (previousAccountId) {
      socket.send(JSON.stringify({ type: 'live_control_unsubscribe' }));
    }
    return undefined;
  }, [remoteAccount?.id]);

  useEffect(() => {
    if (!remoteAccount || !isLiveAccountStatus(remoteAccountStatus)) {
      autoRefreshAccountRef.current = null;
      return undefined;
    }
    const accountId = remoteAccount.id;
    if (autoRefreshAccountRef.current !== accountId) {
      autoRefreshAccountRef.current = accountId;
      requestLiveScreenshot(accountId, { quiet: true });
    }
    const timer = window.setInterval(() => {
      requestLiveScreenshot(accountId, { quiet: true });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [remoteAccount?.id, remoteAccountStatus, requestLiveScreenshot, screenshotRefreshNonce]);

  if (dashboardLoading && !me) {
    return (
      <>
        <section className="status-strip">
          <p className="muted">Checking dashboard session...</p>
        </section>
        <section className="login-panel session-check-panel">
          <div>
            <h2>Loading Dashboard</h2>
            <p className="muted">Restoring your signed-in session.</p>
          </div>
        </section>
      </>
    );
  }

  if (!me) {
    return (
      <>
        <section className="status-strip">
          <p className="muted">{statusMessage}</p>
        </section>
        <section className="login-panel">
          <div>
            <h2>Dashboard Login</h2>
            <p className="muted">Use your dashboard username and password. API keys are only for mods and API requests.</p>
          </div>
          <form className="stack-form" onSubmit={login}>
            <Field label="Username">
              <input value={loginForm.username} onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))} autoComplete="username" required />
            </Field>
            <Field label="Password">
              <input type="password" value={loginForm.password} onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" required />
            </Field>
            <button className="btn primary" type="submit">Log In</button>
          </form>
        </section>
      </>
    );
  }

  const canManageUsers = me.role === 'owner';
  const canManageAccounts = me.role === 'owner' || me.role === 'manager';
  const ownerFolders = [...new Set(accounts
    .filter((account) => !isAccountInBannedFolder(account, nowMs))
    .map(accountOwnerFolder))]
    .sort((a, b) => a.localeCompare(b));
  const accountFolders = [
    { key: 'all', label: 'All', count: accounts.filter((account) => !isAccountInBannedFolder(account, nowMs)).length },
    ...ownerFolders.map((owner) => ({
      key: `owner:${owner}`,
      label: owner,
      count: accounts.filter((account) => !isAccountInBannedFolder(account, nowMs) && accountOwnerFolder(account) === owner).length,
    })),
    { key: 'banned', label: 'Banned', count: accounts.filter((account) => isAccountInBannedFolder(account, nowMs)).length },
  ];
  const selectedAccountFolder = accountFolders.some((folder) => folder.key === activeAccountFolder)
    ? activeAccountFolder
    : 'all';
  const activeProxyAccount = accounts.find((account) => account.id === activeProxyAccountId) || null;
  const visibleAccounts = accounts.filter((account) => {
    const inBannedFolder = isAccountInBannedFolder(account, nowMs);
    if (selectedAccountFolder === 'banned') return inBannedFolder;
    if (selectedAccountFolder === 'all') return !inBannedFolder;
    return !inBannedFolder && selectedAccountFolder === `owner:${accountOwnerFolder(account)}`;
  }).sort((a, b) => (
    accountStatusRank(a, nowMs) - accountStatusRank(b, nowMs)
    || accountOwnerFolder(a).localeCompare(accountOwnerFolder(b))
    || String(a.minecraft_username || '').localeCompare(String(b.minecraft_username || ''))
  ));
  const connectedCount = accounts.filter((account) => {
    const status = displayAccountStatus(account, nowMs);
    return isLiveAccountStatus(status);
  }).length;
  const hypixelCount = accounts.filter((account) => displayAccountStatus(account, nowMs) === 'hypixel').length;
  const bannedCount = accounts.filter((account) => isAccountInBannedFolder(account, nowMs)).length;
  const activeKeyCount = apiKeys.filter((key) => !key.revoked_at).length;

  if (remoteAccountKey) {
    return (
      <>
        <section className="status-strip">
          <p className="muted">{me ? `Signed in as ${me.username} (${me.role})` : statusMessage}</p>
          <div className="inline-actions">
            <button className="btn secondary" type="button" onClick={loadDashboard}><RefreshCw size={16} aria-hidden="true" />Reload</button>
            <button className="btn secondary" type="button" onClick={() => navigateView('dashboard')}><ChevronLeft size={16} aria-hidden="true" />Dashboard</button>
          </div>
        </section>

        {remoteAccount ? (
          <RemoteControlPage
            account={remoteAccount}
            state={liveControlByAccountId[remoteAccount.id]}
            nowMs={nowMs}
            onRequestScreenshot={requestLiveScreenshot}
            onSendAction={sendLiveAction}
            onBack={() => navigateView('dashboard')}
          />
        ) : (
          <section className="results-panel remote-not-found">
            <Monitor size={34} aria-hidden="true" />
            <h2>Remote account not found</h2>
            <p className="muted">This account is not registered in the dashboard or has not finished loading.</p>
            <button className="btn primary compact" type="button" onClick={() => navigateView('dashboard')}>Back to Dashboard</button>
          </section>
        )}
      </>
    );
  }

  return (
    <>
      <section className="status-strip">
        <p className="muted">{me ? `Signed in as ${me.username} (${me.role})` : statusMessage}</p>
        <div className="inline-actions">
          <button className="btn secondary" type="button" onClick={loadDashboard}><RefreshCw size={16} aria-hidden="true" />Reload</button>
          <button className="btn secondary" type="button" onClick={logout}><LogOut size={16} aria-hidden="true" />Log Out</button>
        </div>
      </section>

      <section className="stats-row dashboard-summary" aria-label="Dashboard summary">
        <StatCard title="Connected Clients" value={formatNumber(connectedCount)} detail={`${formatNumber(accounts.length)} registered accounts`} variant="rare" icon={Users} />
        <StatCard title="Hypixel Active" value={formatNumber(hypixelCount)} detail="Currently on Hypixel" variant="mythic" icon={Activity} />
        <StatCard title="Banned Folder" value={formatNumber(bannedCount)} detail="Held outside active rotation" variant="legendary" icon={Ban} />
        <StatCard title="Active API Keys" value={formatNumber(activeKeyCount)} detail={`${formatNumber(apiKeys.length)} total keys`} variant="recommendation" icon={KeyRound} />
      </section>

      <section className="results-panel mod-downloads-panel">
        <div className="section-heading">
          <div>
            <h2>Mod Downloads</h2>
            <p className="muted">Latest jars copied to the RDP release folder.</p>
          </div>
          <span className="pill">{modReleases.length} files</span>
        </div>
        {modReleases.length ? (
          <div className="mod-release-grid">
            {modReleases.map((release) => (
              <article className="mod-release-card" key={release.filename}>
                <div className="release-icon" aria-hidden="true"><FileText size={18} /></div>
                <div className="release-main">
                  <h3>{release.modName}</h3>
                  <code>{release.filename}</code>
                  <p className="muted">{formatBytes(release.sizeBytes)} - Updated {formatTimestamp(release.updatedAt)}</p>
                  <span className="release-checksum">SHA256 {String(release.sha256 || '').slice(0, 12)}</span>
                </div>
                <a className="btn primary compact" href={release.downloadUrl} download>
                  <Download size={15} aria-hidden="true" />Download
                </a>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-cell">No jars found in the release folder</div>
        )}
      </section>

      <section className="dashboard-workspace">
        <aside className="dashboard-sidebar">
        {canManageAccounts ? (
          <div className="control-panel">
          <div className="section-heading">
            <h2>Register Minecraft Account</h2>
          </div>
          <form className="stack-form" onSubmit={createAccount}>
            <Field label="Label">
              <input value={accountForm.label} onChange={(event) => updateAccountForm('label', event.target.value)} placeholder="RDP Main" required />
            </Field>
            <Field label="Minecraft UUID">
              <input value={accountForm.minecraftUuid} onChange={(event) => updateAccountForm('minecraftUuid', event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required />
            </Field>
            <Field label="Username">
              <input value={accountForm.minecraftUsername} onChange={(event) => updateAccountForm('minecraftUsername', event.target.value)} placeholder="PlayerName" required />
            </Field>
            <Field label="Notes">
              <textarea value={accountForm.notes} onChange={(event) => updateAccountForm('notes', event.target.value)} placeholder="Owner, use case, or device notes" />
            </Field>
            <button className="btn primary" type="submit"><Plus size={16} aria-hidden="true" />Add Account</button>
          </form>
        </div>
        ) : null}

        {canManageUsers ? (
          <div className="control-panel">
            <div className="section-heading">
              <h2>Create Dashboard User</h2>
            </div>
            <form className="stack-form" onSubmit={createDashboardUser}>
              <Field label="Username">
                <input value={userForm.username} onChange={(event) => updateUserForm('username', event.target.value)} placeholder="friend-name" required />
              </Field>
              <Field label="Password">
                <input type="password" value={userForm.password} onChange={(event) => updateUserForm('password', event.target.value)} placeholder="Minimum 8 characters" required />
              </Field>
              <Field label="Role">
                <select value={userForm.role} onChange={(event) => updateUserForm('role', event.target.value)}>
                  <option value="viewer">Viewer</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
              </Field>
              <button className="btn primary" type="submit"><UserPlus size={16} aria-hidden="true" />Create User</button>
            </form>
          </div>
        ) : null}

        {canManageUsers ? (
          <div className="control-panel">
          <div className="section-heading">
            <h2>Create API Key</h2>
          </div>
          <form className="stack-form" onSubmit={createKey}>
            <Field label="Dashboard User">
              <select value={keyForm.userId} onChange={(event) => updateKeyForm('userId', event.target.value)} required>
                <option value="">Select user</option>
                {dashboardUsers.map((user) => (
                  <option key={user.id} value={user.id}>{user.username} ({user.role})</option>
                ))}
              </select>
            </Field>
            <Field label="Key Name">
              <input value={keyForm.name} onChange={(event) => updateKeyForm('name', event.target.value)} placeholder="Friend mod key" required />
            </Field>
            <div className="scope-grid">
              {['auction:read', 'accounts:read', 'accounts:write', 'mod:connect', 'admin'].map((scope) => (
                <label key={scope} className="scope-check">
                  <input type="checkbox" checked={keyForm.scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                  <span>{scope}</span>
                </label>
              ))}
            </div>
            <button className="btn gold" type="submit"><KeyRound size={16} aria-hidden="true" />Create Key</button>
          </form>
          {issuedKey ? (
            <div className="issued-key">
              <span>New key</span>
              <div className="issued-key-row">
                <code>{issuedKey.rawKey}</code>
                <button className="btn secondary compact" type="button" onClick={() => copyText(issuedKey.rawKey, 'API key')}><Copy size={15} aria-hidden="true" />Copy</button>
              </div>
            </div>
          ) : null}
        </div>
        ) : null}
        </aside>

        <div className="dashboard-main">

      {canManageUsers ? (
        <section className="results-panel dashboard-users-panel">
          <div className="section-heading">
            <h2>Dashboard Users</h2>
            <span className="pill">{dashboardUsers.length} users</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Password</th>
                  <th>Created</th>
                  <th>Assign Role</th>
                  <th>Remove</th>
                </tr>
              </thead>
              <tbody>
                {dashboardUsers.length ? dashboardUsers.map((user) => {
                  const roleDraft = roleDrafts[user.id] || user.role;
                  return (
                    <tr key={user.id}>
                      <td>{user.username}</td>
                      <td><span className={`status-badge ${user.role === 'owner' ? 'locked' : user.role === 'manager' ? 'active' : 'offline'}`}>{user.role}</span></td>
                      <td>{user.has_password ? 'Set' : 'Missing'}</td>
                      <td>{user.created_at}</td>
                      <td className="role-controls">
                        <select value={roleDraft} onChange={(event) => setRoleDrafts((current) => ({ ...current, [user.id]: event.target.value }))}>
                          <option value="viewer">viewer</option>
                          <option value="manager">manager</option>
                          <option value="owner">owner</option>
                        </select>
                        <button className="btn secondary compact" type="button" onClick={() => updateDashboardUserRole(user)}><ShieldCheck size={15} aria-hidden="true" />Save</button>
                      </td>
                      <td>
                        <button
                          className="btn danger compact"
                          type="button"
                          disabled={user.id === me.id}
                          onClick={() => deleteDashboardUser(user)}
                        >
                          <Trash2 size={15} aria-hidden="true" />Delete
                        </button>
                      </td>
                    </tr>
                  );
                }) : <tr><td className="empty-cell" colSpan="6">No dashboard users found</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="results-panel account-panel">
        <div className="section-heading">
          <h2>{selectedAccountFolder === 'banned' ? 'Banned Accounts' : 'Minecraft Accounts'}</h2>
          <span className="pill">{visibleAccounts.length} shown</span>
        </div>
        <div className="folder-tabs">
          {accountFolders.map((folder) => (
            <button
              key={folder.key}
              className={selectedAccountFolder === folder.key ? 'active' : ''}
              type="button"
              onClick={() => setActiveAccountFolder(folder.key)}
            >
              <span>{folder.label}</span>
              <small>{folder.count}</small>
            </button>
          ))}
        </div>
        {visibleAccounts.length ? (
          <div className="account-grid">
            {visibleAccounts.map((account) => {
              const displayStatus = displayAccountStatus(account, nowMs);
              const banRemainingMs = displayStatus === 'banned' && account.ban_until
                ? Date.parse(account.ban_until) - nowMs
                : null;
              const folderRemainingMs = displayStatus === 'banned' && account.banned_folder_available_at && !isAccountInBannedFolder(account, nowMs)
                ? Date.parse(account.banned_folder_available_at) - nowMs
                : null;
              return (
                <article className="account-card" key={account.id}>
                  <div className="account-card-head">
                    <img
                      className="account-avatar"
                      src={mineatarFaceUrl(account.minecraft_uuid)}
                      alt={`${account.minecraft_username} Minecraft skin face`}
                      loading="lazy"
                    />
                    <div className="account-identity">
                      <h3>{account.minecraft_username}</h3>
                      <span>{account.label}</span>
                    </div>
                    <span className={`status-dot ${displayStatus}`} title={displayStatus} />
                  </div>

                  <dl className="account-meta">
                    <div>
                      <dt>Owner</dt>
                      <dd>{account.owner_username || 'Unassigned'}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <span className={`status-badge live-status-badge ${displayStatus}`}>
                          <span className="status-word">{displayStatus}</span>
                          {isLiveAccountStatus(displayStatus) && account.current_username ? (
                            <span className="status-user">({account.current_username})</span>
                          ) : null}
                        </span>
                      </dd>
                    </div>
                    {displayStatus === 'banned' && banRemainingMs != null ? (
                      <div>
                        <dt>Time Left</dt>
                        <dd>{formatFullDuration(banRemainingMs)}</dd>
                      </div>
                    ) : null}
                    {folderRemainingMs != null ? (
                      <div>
                        <dt>Banned Folder</dt>
                        <dd>{formatFullDuration(folderRemainingMs)}</dd>
                      </div>
                    ) : null}
                    {displayStatus === 'banned' && account.ban_reason ? (
                      <div className="wide-row">
                        <dt>Reason</dt>
                        <dd>{account.ban_reason}</dd>
                      </div>
                    ) : null}
                    {displayStatus === 'banned' && account.ban_id ? (
                      <div>
                        <dt>Ban ID</dt>
                        <dd>{account.ban_id}</dd>
                      </div>
                    ) : null}
                    <div className="uuid-row">
                      <dt>UUID</dt>
                      <dd>{account.minecraft_uuid}</dd>
                    </div>
                    <div>
                      <dt>Notes</dt>
                      <dd>{account.notes || 'None'}</dd>
                    </div>
                    <div>
                      <dt>Proxy</dt>
                      <dd>{account.proxy_enabled ? `${account.proxy_type} ${account.proxy_host}:${account.proxy_port}` : 'Disabled'}</dd>
                    </div>
                  </dl>

                  <AccountWealthStrip stats={account.wealthStats} />

                  {canManageUsers || canManageAccounts ? (
                    <div className="account-controls">
                      {canManageAccounts ? (
                        <form className="eye-correction-form" onSubmit={(event) => saveSummoningEyeCorrection(event, account)}>
                          <label htmlFor={`held-eyes-${account.id}`}>
                            <img className="eye-correction-icon" src={summoningEyeIcon} alt="" aria-hidden="true" />
                            Held Eyes
                          </label>
                          <input
                            id={`held-eyes-${account.id}`}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            step="1"
                            placeholder={String(account.wealthStats?.summoningEyesHeld ?? 0)}
                            value={summoningEyeDrafts[account.id] ?? ''}
                            onChange={(event) => updateSummoningEyeDraft(account.id, event.target.value)}
                            aria-label={`Correct held summoning eyes for ${account.minecraft_username}`}
                          />
                          <button className="btn secondary compact" type="submit">Set</button>
                        </form>
                      ) : null}
                      <div className="account-action-row">
                        {canManageUsers ? (
                          <button className="btn primary compact account-connect" type="button" onClick={() => connectAccount(account)}><Activity size={15} aria-hidden="true" />Connect</button>
                        ) : null}
                        {canManageUsers ? (
                          <button className="btn danger compact" type="button" title="Delete account" onClick={() => deleteMinecraftAccount(account)}><Trash2 size={15} aria-hidden="true" />Delete</button>
                        ) : null}
                        {canManageAccounts && displayStatus === 'banned' && !isAccountInBannedFolder(account, nowMs) ? (
                          <button className="btn secondary compact wide-action" type="button" onClick={() => moveMinecraftAccountToBannedFolder(account)}><Ban size={15} aria-hidden="true" />Move to Banned</button>
                        ) : null}
                        {canManageAccounts ? (
                          <button className="btn secondary compact wide-action" type="button" onClick={() => openProxyModal(account)}><Settings size={15} aria-hidden="true" />Configure</button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-cell">No accounts in this folder</div>
        )}
      </section>

      {canManageUsers ? (
      <section className="results-panel api-keys-panel">
        <div className="section-heading">
          <h2>API Keys</h2>
          <span className="pill">{apiKeys.length} total</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Last Used</th>
                <th>State</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.length ? apiKeys.map((key) => {
                const fullKey = key.raw_key || key.rawKey || '';
                return (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="owner-cell">{key.username}</td>
                    <td><code>{key.key_prefix}</code></td>
                    <td>{key.scopes.join(', ')}</td>
                    <td>{key.last_used_at || 'Never'}</td>
                    <td>{key.revoked_at ? <span className="status-badge banned">revoked</span> : <span className="status-badge active">active</span>}</td>
                    <td>
                      <div className="key-actions">
                        {fullKey ? (
                          <button
                            className="btn secondary compact"
                            type="button"
                            title="Copy full API key"
                            onClick={() => copyText(fullKey, 'API key')}
                          >
                            <Copy size={15} aria-hidden="true" />Copy
                          </button>
                        ) : (
                          <button
                            className="btn secondary compact"
                            type="button"
                            disabled={Boolean(key.revoked_at)}
                            title="Replace this old unrecoverable key with a new full key"
                            onClick={() => replaceKey(key.id)}
                          >
                            <RotateCw size={15} aria-hidden="true" />Replace
                          </button>
                        )}
                        {key.revoked_at ? (
                          <button className="btn danger compact" type="button" onClick={() => deleteKey(key)}><Trash2 size={15} aria-hidden="true" />Delete</button>
                        ) : (
                          <button className="btn danger compact" type="button" onClick={() => revokeKey(key.id)}><ShieldCheck size={15} aria-hidden="true" />Revoke</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }) : <tr><td className="empty-cell" colSpan="7">No API keys found</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      ) : null}

        </div>
      </section>

      {canManageAccounts && activeProxyAccount ? (
        <ProxyConfigModal
          account={activeProxyAccount}
          draft={proxyDrafts[activeProxyAccount.id] || proxyDraftFromAccount(activeProxyAccount)}
          onChange={updateProxyDraft}
          onSave={saveAccountProxy}
          onClose={() => setActiveProxyAccountId(null)}
        />
      ) : null}

    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
