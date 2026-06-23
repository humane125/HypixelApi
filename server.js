const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const {
  normalizeAuction,
  searchIndexedAuctions,
  recommendBin,
} = require('./auction-core');
const {
  createDatabase,
  createUser,
  createApiKey,
  authenticateApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  rotateApiKey,
  countActiveApiKeys,
  setUserPassword,
  listDashboardUsers,
  getDashboardUserById,
  updateUserRole,
  deleteDashboardUser,
  authenticateUserPassword,
  countPasswordUsers,
  createDashboardSession,
  authenticateDashboardSession,
  revokeDashboardSession,
  createMinecraftAccount,
  listMinecraftAccounts,
  upsertMinecraftAccountFromMod,
  recordMinecraftAccountHeartbeat,
  recordMinecraftAccountConnectionStatus,
  updateMinecraftAccountProxy,
  getMinecraftAccountProxyForOwner,
  updateMinecraftAccountStatus,
  markMinecraftAccountBannedFoldered,
  deleteMinecraftAccount,
  writeAuditLog,
} = require('./auth-db');

const DEFAULT_PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const HYPIXEL_AUCTIONS_URL = 'https://api.hypixel.net/v2/skyblock/auctions';
const DEFAULT_LOGIN_RATE_LIMIT = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};
const DEFAULT_ACCOUNT_HEARTBEAT_WINDOW_MS = 60_000;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

function loadDotEnv(filePath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auction-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(fetchImpl, requestUrl, options = {}, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetchImpl(requestUrl, options);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : delay * 2 ** i;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay * 2 ** i));
    }
  }
}

function createAuctionIndexService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const concurrencyLimit = Number(options.concurrencyLimit || 12);
  const hypixelApiKey = options.hypixelApiKey || process.env.HYPIXEL_API_KEY;
  const state = {
    ready: false,
    refreshing: false,
    lastUpdated: null,
    totalPages: 0,
    totalAuctions: 0,
    indexedBinCount: 0,
    refreshedAt: null,
    indexedAuctions: [],
    refreshPromise: null,
  };

  const headers = {
    'User-Agent': 'Hypixel-Auction-Search-Service/2.0',
  };
  if (hypixelApiKey) {
    headers['API-Key'] = hypixelApiKey;
    headers.Authorization = `Bearer ${hypixelApiKey}`;
  }

  async function fetchPage(page) {
    const response = await fetchWithRetry(fetchImpl, `${HYPIXEL_AUCTIONS_URL}?page=${page}`, { headers });
    const data = await response.json();
    if (!data.success) {
      throw new Error(`Hypixel API error: ${data.cause || data.error || 'unknown error'}`);
    }
    return data;
  }

  async function refresh(sendEvent = null) {
    if (state.refreshPromise) {
      if (sendEvent) sendEvent('status', { message: 'Refresh already running; waiting for shared index...' });
      const result = await state.refreshPromise;
      if (sendEvent) sendEvent('done', result);
      return result;
    }

    state.refreshing = true;
    state.refreshPromise = (async () => {
      if (sendEvent) sendEvent('status', { message: 'Checking Hypixel auction update state...' });
      const page0 = await fetchPage(0);

      if (state.ready && state.lastUpdated === page0.lastUpdated) {
        state.refreshing = false;
        if (sendEvent) sendEvent('done', { source: 'cache', status: getStatus() });
        return { source: 'cache', status: getStatus() };
      }

      const totalPages = page0.totalPages || 0;
      const totalAuctions = page0.totalAuctions || 0;
      const indexed = [];
      let completedPages = 1;

      if (sendEvent) {
        sendEvent('init', {
          totalPages,
          totalAuctions,
          lastUpdated: page0.lastUpdated,
        });
      }

      for (const auction of page0.auctions || []) {
        if (auction.bin) indexed.push(normalizeAuction(auction));
      }

      const pagesToFetch = Array.from({ length: Math.max(0, totalPages - 1) }, (_, idx) => idx + 1);
      async function worker() {
        while (pagesToFetch.length > 0) {
          const page = pagesToFetch.shift();
          try {
            const data = await fetchPage(page);
            for (const auction of data.auctions || []) {
              if (auction.bin) indexed.push(normalizeAuction(auction));
            }
          } catch (err) {
            if (sendEvent) sendEvent('warning', { message: `Failed page ${page}: ${err.message}` });
          } finally {
            completedPages++;
            if (sendEvent) {
              sendEvent('progress', {
                completedPages,
                totalPages,
                indexedBinCount: indexed.length,
              });
            }
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrencyLimit, Math.max(1, totalPages)) }, worker));

      indexed.sort((a, b) => a.price - b.price);
      state.ready = true;
      state.refreshing = false;
      state.lastUpdated = page0.lastUpdated;
      state.totalPages = totalPages;
      state.totalAuctions = totalAuctions;
      state.indexedBinCount = indexed.length;
      state.refreshedAt = Date.now();
      state.indexedAuctions = indexed;

      const status = getStatus();
      if (sendEvent) sendEvent('done', { source: 'fresh', status });
      return { source: 'fresh', status };
    })();

    try {
      return await state.refreshPromise;
    } finally {
      state.refreshing = false;
      state.refreshPromise = null;
    }
  }

  async function ensureFresh(sendEvent = null) {
    return refresh(sendEvent);
  }

  function getStatus() {
    return {
      ready: state.ready,
      refreshing: state.refreshing,
      lastUpdated: state.lastUpdated,
      totalPages: state.totalPages,
      totalAuctions: state.totalAuctions,
      indexedBinCount: state.indexedBinCount,
      ageMs: state.refreshedAt ? Date.now() - state.refreshedAt : null,
    };
  }

  return {
    ensureFresh,
    refresh,
    getStatus,
    getItems: () => state.indexedAuctions,
  };
}

const usernameCache = new Map();

async function getUsername(uuid, fetchImpl = global.fetch) {
  if (!uuid) return 'Unknown';
  if (usernameCache.has(uuid)) return usernameCache.get(uuid);

  const profileUrl = `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`;
  try {
    const res = await fetchWithRetry(fetchImpl, profileUrl, {}, 2, 200);
    const data = await res.json();
    if (data && data.name) {
      usernameCache.set(uuid, data.name);
      return data.name;
    }
  } catch (err) {
    try {
      const fallback = await fetchImpl(`https://api.mojang.com/user/profile/${uuid}`);
      if (fallback.ok) {
        const data = await fallback.json();
        if (data && data.name) {
          usernameCache.set(uuid, data.name);
          return data.name;
        }
      }
    } catch (fallbackErr) {
      // Keep the response usable when Mojang is unavailable.
    }
  }

  return `${uuid.substring(0, 8)}...`;
}

async function getMinecraftProfileByUsername(username, fetchImpl = global.fetch) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) throw new Error('Minecraft username is required');

  const profileUrl = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(cleanUsername)}`;
  const response = await fetchWithRetry(fetchImpl, profileUrl, {}, 2, 200);
  if (!response.ok) {
    throw new Error(`Mojang profile lookup failed: HTTP ${response.status}`);
  }
  const profile = await response.json();
  if (!profile || !profile.id || !profile.name) {
    throw new Error('Mojang profile lookup did not return a Minecraft profile');
  }
  return profile;
}

function readQueryToken(parsedUrl) {
  return parsedUrl.searchParams ? parsedUrl.searchParams.get('token') : parsedUrl.query.token;
}

function createAuthChecker(apiToken) {
  return function isAuthorized(req, parsedUrl, body = {}, options = {}) {
    if (!apiToken) return true;

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : null;
    const queryToken = options.allowQueryToken ? readQueryToken(parsedUrl) : null;
    const supplied = req.headers['x-auction-token'] || bearer || queryToken || body.token;
    return supplied === apiToken;
  };
}

function extractApiToken(req, parsedUrl, body = {}, options = {}) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : null;
  const queryToken = options.allowQueryToken ? readQueryToken(parsedUrl) : null;
  return req.headers['x-api-key']
    || req.headers['x-auction-token']
    || bearer
    || queryToken
    || body.token
    || null;
}

function hasRequiredScopes(auth, requiredScopes = []) {
  if (!auth) return false;
  if (!requiredScopes.length) return true;
  if (auth.user && auth.user.role === 'owner') return true;
  const scopes = new Set((auth.apiKey && auth.apiKey.scopes) || []);
  if (scopes.has('admin')) return true;
  return requiredScopes.every((scope) => scopes.has(scope));
}

function apiKeyHasScopes(auth, requiredScopes = []) {
  if (!auth || !auth.apiKey) return false;
  if (!requiredScopes.length) return true;
  const scopes = new Set(auth.apiKey.scopes || []);
  if (scopes.has('admin')) return true;
  return requiredScopes.every((scope) => scopes.has(scope));
}

function ensureBootstrapApiKey(db, rawKey) {
  if (!db || !rawKey) return;
  const user = createUser(db, { username: 'owner', role: 'owner' });
  const existing = authenticateApiKey(db, rawKey);
  if (existing) {
    db.prepare('UPDATE api_keys SET raw_key = COALESCE(raw_key, ?) WHERE id = ?').run(rawKey, existing.apiKey.id);
    return;
  }

  try {
    createApiKey(db, {
      userId: user.id,
      name: 'Bootstrap owner key',
      scopes: ['admin', 'auction:read', 'accounts:read', 'accounts:write', 'mod:connect'],
      rawKey,
    });
  } catch (err) {
    if (!String(err.message || '').includes('UNIQUE')) {
      throw err;
    }
  }
}

function createAuthorizer({ db, legacyApiToken }) {
  const legacyChecker = createAuthChecker(legacyApiToken);

  return function authorize(req, parsedUrl, body = {}, requiredScopes = [], options = {}) {
    if (db) {
      const auth = authenticateApiKey(db, extractApiToken(req, parsedUrl, body, options));
      if (!auth) return { ok: false, status: 401, payload: { error: 'Unauthorized' } };
      if (!hasRequiredScopes(auth, requiredScopes)) {
        return { ok: false, status: 403, payload: { error: 'Forbidden' } };
      }
      return { ok: true, auth };
    }

    if (!legacyChecker(req, parsedUrl, body, options)) {
      return { ok: false, status: 401, payload: { error: 'Unauthorized' } };
    }

    return {
      ok: true,
      auth: {
        user: { id: null, username: 'legacy-token', role: 'owner' },
        apiKey: { id: null, name: 'Legacy shared token', scopes: ['admin'] },
      },
    };
  };
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  for (const chunk of header.split(';')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    const name = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function cookieParts(baseParts, secure = false) {
  return [
    ...baseParts,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function sessionCookie(rawToken, maxAgeSeconds = 7 * 24 * 60 * 60, secure = false) {
  return cookieParts([
    `dashboard_session=${encodeURIComponent(rawToken)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ], secure);
}

function clearSessionCookie(secure = false) {
  return cookieParts([
    'dashboard_session=',
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ], secure);
}

function clientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createLoginRateLimiter(options = {}) {
  const settings = {
    ...DEFAULT_LOGIN_RATE_LIMIT,
    ...options,
  };
  const attempts = new Map();
  const now = () => Date.now();

  function keyFor(req, username) {
    const cleanUsername = String(username || '').trim().toLowerCase() || '<empty>';
    return `${clientIp(req)}:${cleanUsername}`;
  }

  function currentEntry(key, timestamp) {
    const entry = attempts.get(key);
    if (!entry) return { failures: 0, lastFailureAt: 0, lockedUntil: 0 };
    if (!entry.lockedUntil && timestamp - entry.lastFailureAt > settings.windowMs) {
      attempts.delete(key);
      return { failures: 0, lastFailureAt: 0, lockedUntil: 0 };
    }
    return entry;
  }

  function check(req, username) {
    const timestamp = now();
    const entry = currentEntry(keyFor(req, username), timestamp);
    if (entry.lockedUntil && entry.lockedUntil > timestamp) {
      return {
        ok: false,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - timestamp) / 1000),
      };
    }
    return { ok: true };
  }

  function recordFailure(req, username) {
    const timestamp = now();
    const key = keyFor(req, username);
    const entry = currentEntry(key, timestamp);
    const failures = entry.failures + 1;
    attempts.set(key, {
      failures,
      lastFailureAt: timestamp,
      lockedUntil: failures >= settings.maxFailures ? timestamp + settings.lockMs : 0,
    });
  }

  function reset(req, username) {
    attempts.delete(keyFor(req, username));
  }

  return { check, recordFailure, reset };
}

function shouldUseSecureCookies(req, explicitSecureCookies) {
  if (explicitSecureCookies != null) return Boolean(explicitSecureCookies);
  const envValue = String(process.env.DASHBOARD_COOKIE_SECURE || process.env.SECURE_COOKIES || '').toLowerCase();
  if (['1', 'true', 'yes'].includes(envValue)) return true;
  if (['0', 'false', 'no'].includes(envValue)) return false;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return forwardedProto.split(',').map((part) => part.trim()).includes('https')
    || Boolean(req.socket && req.socket.encrypted);
}

function ensureBootstrapDashboardUser(db, username, password) {
  if (!db || !username || !password) return;
  const user = createUser(db, { username, role: 'owner' });
  setUserPassword(db, user.id, password);
}

function createDashboardAuthorizer(db) {
  return function authorizeDashboard(req) {
    if (!db) return { ok: false, status: 500, payload: { error: 'Dashboard database is not configured' } };
    const token = parseCookies(req).dashboard_session;
    const auth = authenticateDashboardSession(db, token);
    if (!auth) return { ok: false, status: 401, payload: { error: 'Dashboard login required' } };
    return { ok: true, auth };
  };
}

function requireDashboardOwner(access) {
  if (!access.ok) return access;
  if (access.auth.user.role !== 'owner') {
    return { ok: false, status: 403, payload: { error: 'Owner access required' } };
  }
  return access;
}

function requireDashboardAccountManager(access) {
  if (!access.ok) return access;
  if (!['owner', 'manager'].includes(access.auth.user.role)) {
    return { ok: false, status: 403, payload: { error: 'Owner or manager access required' } };
  }
  return access;
}

function auditRequest(db, auth, req, action, metadata = {}) {
  if (!db || !auth) return;
  writeAuditLog(db, {
    userId: auth.user.id,
    apiKeyId: auth.apiKey ? auth.apiKey.id : null,
    action,
    ip: req.socket && req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || null,
    metadata,
  });
}

function sendSocketJson(socket, payload) {
  if (socket.readyState === WEBSOCKET_CLOSING || socket.readyState === WEBSOCKET_CLOSED) {
    return;
  }
  try {
    socket.send(JSON.stringify(payload), () => {});
  } catch (err) {
    // The socket can close between the readyState check and send.
  }
}

function createDashboardAccountBroadcaster({ db, heartbeatWindowMs }) {
  const clients = new Set();
  let getLiveAccountStatuses = () => [];

  function accountsMessage() {
    return {
      type: 'accounts',
      accounts: applyLiveAccountStatuses(
        listMinecraftAccounts(db, { heartbeatWindowMs }),
        getLiveAccountStatuses()
      ),
      sentAt: new Date().toISOString(),
    };
  }

  function attach(socket) {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    setImmediate(() => {
      sendSocketJson(socket, accountsMessage());
    });
  }

  function broadcast() {
    if (!clients.size) return;
    const message = accountsMessage();
    for (const socket of clients) {
      if (socket.readyState !== WEBSOCKET_CLOSING && socket.readyState !== WEBSOCKET_CLOSED) {
        sendSocketJson(socket, message);
      } else {
        clients.delete(socket);
      }
    }
  }

  function setLiveAccountStatusProvider(provider) {
    getLiveAccountStatuses = typeof provider === 'function' ? provider : () => [];
  }

  return { attach, broadcast, setLiveAccountStatusProvider };
}

function createLiveControlStore() {
  const dashboardClients = new Set();
  const accountStates = new Map();
  const MAX_LOGS = 100;

  function attachDashboard(socket, modConnections) {
    dashboardClients.add(socket);
    socket.on('close', () => dashboardClients.delete(socket));
    socket.on('error', () => dashboardClients.delete(socket));
    socket.on('message', (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch (err) {
        sendSocketJson(socket, { type: 'live_control_error', code: 'invalid_json', message: 'Invalid JSON message' });
        return;
      }
      handleDashboardMessage(socket, message, modConnections);
    });
    setImmediate(() => sendSocketJson(socket, {
      type: 'live_control_snapshot',
      accounts: [...accountStates.entries()].map(([accountId, state]) => ({ accountId, state })),
    }));
  }

  function handleDashboardMessage(socket, message, modConnections) {
    if (message.type !== 'request_screenshot') return;
    const accountId = Number(message.accountId);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      console.warn('Live control screenshot request rejected: invalid account id', message.accountId);
      sendSocketJson(socket, { type: 'live_control_error', code: 'invalid_account', message: 'accountId is required' });
      return;
    }
    const requestId = crypto.randomUUID();
    const sent = modConnections.sendToAccount(accountId, {
      type: 'request_screenshot',
      accountId,
      requestId,
      sentAt: new Date().toISOString(),
    });
    console.info(`Live control screenshot request ${requestId} for account ${accountId}: ${sent ? 'sent' : 'offline'}`);
    if (!sent) {
      sendSocketJson(socket, { type: 'live_control_error', code: 'account_offline', accountId, message: 'Account is not connected' });
    }
  }

  function handleModMessage(account, message) {
    if (!account || !account.id) return false;
    if (message.type === 'client_log') {
      recordLog(account, message);
      return true;
    }
    if (message.type === 'client_screenshot') {
      recordScreenshot(account, message);
      return true;
    }
    return false;
  }

  function recordLog(account, message) {
    const state = mutableState(account.id);
    state.logs.unshift({
      id: crypto.randomUUID(),
      level: cleanLevel(message.level),
      message: stripMinecraftFormatting(message.message),
      createdAt: new Date().toISOString(),
    });
    state.logs = state.logs.slice(0, MAX_LOGS);
    state.updatedAt = new Date().toISOString();
    broadcast(account.id);
  }

  function recordScreenshot(account, message) {
    const imageMime = String(message.imageMime || 'image/jpeg').trim();
    const imageBase64 = String(message.imageBase64 || '').trim();
    if (!imageBase64) return;
    const state = mutableState(account.id);
    state.screenshot = {
      imageMime,
      imageBase64,
      capturedAt: message.capturedAt || new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    broadcast(account.id);
  }

  function mutableState(accountId) {
    const key = Number(accountId);
    if (!accountStates.has(key)) {
      accountStates.set(key, {
        logs: [],
        screenshot: null,
        updatedAt: null,
      });
    }
    return accountStates.get(key);
  }

  function publicState(accountId) {
    const state = mutableState(accountId);
    return {
      logs: state.logs,
      screenshot: state.screenshot,
      updatedAt: state.updatedAt,
    };
  }

  function broadcast(accountId) {
    const message = {
      type: 'live_control_update',
      accountId: Number(accountId),
      state: publicState(accountId),
      sentAt: new Date().toISOString(),
    };
    for (const socket of [...dashboardClients]) {
      if (socket.readyState === WEBSOCKET_CLOSING || socket.readyState === WEBSOCKET_CLOSED) {
        dashboardClients.delete(socket);
        continue;
      }
      sendSocketJson(socket, message);
    }
  }

  function cleanLevel(level) {
    const value = String(level || 'info').trim().toLowerCase();
    return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info';
  }

  function stripMinecraftFormatting(value) {
    return String(value || '').replace(/(?:\u00a7|&)[0-9a-fk-or]/gi, '').trim();
  }

  return { attachDashboard, handleModMessage };
}

function createModConnectionRegistry() {
  const clients = new Set();
  const transferSessions = new Map();
  const TRANSFER_INVITE_TTL_MS = 120_000;

  function register(socket, auth, account) {
    let client = [...clients].find((entry) => entry.socket === socket);
    if (!client) {
      client = { socket, auth, account };
      clients.add(client);
      socket.on('close', () => remove(socket, 'Socket disconnected'));
      socket.on('error', () => remove(socket, 'Socket disconnected'));
    }
    client.auth = auth;
    client.account = account;
  }

  function remove(socket, reason = 'Socket disconnected') {
    for (const client of [...clients]) {
      if (client.socket === socket) {
        clients.delete(client);
      }
    }
    cancelSessionForSocket(socket, reason, { notifySource: false });
  }

  function connectedAccounts() {
    pruneClosedClients();
    return [...clients]
      .filter((client) => client.account && client.account.id)
      .map((client) => ({
        accountId: client.account.id,
        minecraftUuid: client.account.minecraft_uuid,
        minecraftUsername: client.account.minecraft_username,
        status: client.account.status || 'active',
      }));
  }

  function liveAccountStatuses() {
    pruneClosedClients();
    const byAccountId = new Map();
    for (const client of clients) {
      if (!client.account || !client.account.id) continue;
      if (!['active', 'hypixel'].includes(client.account.status)) continue;
      const liveStatus = client.account.status === 'hypixel' ? 'hypixel' : 'active';
      byAccountId.set(client.account.id, {
        accountId: client.account.id,
        status: liveStatus,
        currentUserId: client.auth && client.auth.user ? client.auth.user.id : null,
        currentUsername: client.auth && client.auth.user ? client.auth.user.username : null,
      });
    }
    return [...byAccountId.values()];
  }

  function hasLiveAccountConnection(accountId, exceptSocket = null) {
    pruneClosedClients();
    return [...clients].some((client) => (
      client.socket !== exceptSocket
      && client.account
      && client.account.id === accountId
      && ['active', 'hypixel'].includes(client.account.status)
    ));
  }

  function sendToAccount(accountId, payload) {
    pruneClosedClients();
    const target = [...clients].find((client) => (
      client.account
      && Number(client.account.id) === Number(accountId)
      && client.socket.readyState !== WEBSOCKET_CLOSING
      && client.socket.readyState !== WEBSOCKET_CLOSED
    ));
    if (!target) return false;
    sendSocketJson(target.socket, payload);
    return true;
  }

  function handleTransferMessage(socket, message) {
    pruneClosedClients();
    expireTransferSessions();
    const source = clientForSocket(socket);
    if (!source || !source.account) {
      sendTransferError(socket, 'account_unavailable', 'Authenticated Minecraft account is unavailable; reconnect the mod.');
      return true;
    }

    if (message.type === 'transfer_list') {
      sendSocketJson(socket, {
        type: 'transfer_accounts',
        accounts: connectedAccounts(),
        sentAt: new Date().toISOString(),
      });
      return true;
    }

    if (message.type === 'transfer_invite') {
      createTransferInvite(source, message);
      return true;
    }

    if (message.type === 'transfer_accept') {
      acceptTransferInvite(source, message);
      return true;
    }

    if (message.type === 'transfer_decline') {
      declineTransferInvite(source, message);
      return true;
    }

    if (message.type === 'transfer_cancel') {
      cancelSessionForSocket(socket, `${source.account.minecraft_username} cancelled`, { notifySource: true });
      return true;
    }

    if (message.type === 'transfer_run') {
      runTransfer(source, message);
      return true;
    }

    if (message.type === 'transfer_buy_order_ready') {
      transferBuyOrderReady(source, message);
      return true;
    }

    if (message.type === 'transfer_sell_offer_ready') {
      transferSellOfferReady(source, message);
      return true;
    }

    if (message.type === 'transfer_sell_offer_bought') {
      transferSellOfferBought(source, message);
      return true;
    }

    if (message.type === 'transfer_cycle_complete') {
      transferCycleComplete(source, message);
      return true;
    }

    return false;
  }

  function createTransferInvite(source, message) {
    const itemName = cleanText(message.itemName);
    const receiverUsername = cleanText(message.receiverUsername);
    if (!receiverUsername || !itemName) {
      sendTransferError(source.socket, 'invalid_transfer', 'receiverUsername and itemName are required');
      return;
    }

    const senderUsername = source.account.minecraft_username;
    if (sameUsername(senderUsername, receiverUsername)) {
      sendTransferError(source.socket, 'self_invite', 'Cannot transfer to the same account');
      return;
    }

    const receiver = clientByUsername(receiverUsername);
    if (!receiver) {
      sendTransferError(source.socket, 'target_offline', `${receiverUsername} is not connected`);
      return;
    }

    if (sessionForSocket(source.socket) || sessionForSocket(receiver.socket)) {
      sendTransferError(source.socket, 'account_busy', 'One of the accounts is already in a transfer session');
      return;
    }

    const session = {
      id: crypto.randomUUID(),
      senderSocket: source.socket,
      receiverSocket: receiver.socket,
      senderAccountId: source.account.id,
      receiverAccountId: receiver.account.id,
      senderUsername,
      receiverUsername: receiver.account.minecraft_username,
      itemName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TRANSFER_INVITE_TTL_MS).toISOString(),
      timer: null,
    };
    session.timer = setTimeout(() => {
      if (!transferSessions.has(session.id)) return;
      finishSession(session, {
        type: 'transfer_cancelled',
        sessionId: session.id,
        reason: 'Transfer invite expired',
      });
    }, TRANSFER_INVITE_TTL_MS);
    if (typeof session.timer.unref === 'function') session.timer.unref();
    transferSessions.set(session.id, session);

    sendSocketJson(source.socket, { type: 'transfer_pending', session: publicTransferSession(session) });
    sendSocketJson(receiver.socket, { type: 'transfer_invite', session: publicTransferSession(session) });
  }

  function acceptTransferInvite(receiver, message) {
    const senderUsername = cleanText(message.senderUsername);
    const session = [...transferSessions.values()].find((candidate) => (
      candidate.status === 'pending'
      && candidate.receiverSocket === receiver.socket
      && sameUsername(candidate.senderUsername, senderUsername)
    ));
    if (!session) {
      sendTransferError(receiver.socket, 'invite_not_found', `No pending transfer invite from ${senderUsername || 'that account'}`);
      return;
    }
    clearTransferTimer(session);
    session.status = 'accepted';
    sendSocketJson(session.senderSocket, {
      type: 'transfer_accepted',
      role: 'sender',
      session: publicTransferSession(session),
    });
    sendSocketJson(session.receiverSocket, {
      type: 'transfer_accepted',
      role: 'receiver',
      session: publicTransferSession(session),
    });
  }

  function declineTransferInvite(receiver, message) {
    const senderUsername = cleanText(message.senderUsername);
    const session = [...transferSessions.values()].find((candidate) => (
      candidate.status === 'pending'
      && candidate.receiverSocket === receiver.socket
      && sameUsername(candidate.senderUsername, senderUsername)
    ));
    if (!session) {
      sendTransferError(receiver.socket, 'invite_not_found', `No pending transfer invite from ${senderUsername || 'that account'}`);
      return;
    }
    finishSession(session, {
      type: 'transfer_declined',
      reason: `${session.receiverUsername} declined`,
      session: publicTransferSession(session),
    });
  }

  function runTransfer(source, message) {
    const session = sessionForSocket(source.socket);
    if (!session) {
      sendTransferError(source.socket, 'session_not_found', 'No transfer session is active');
      return;
    }
    if (session.status !== 'accepted') {
      sendTransferError(source.socket, 'session_not_accepted', 'Transfer session is not accepted yet');
      return;
    }
    if (session.senderSocket !== source.socket) {
      sendTransferError(source.socket, 'sender_required', 'Only the transfer sender can start a transfer run');
      return;
    }

    const quantity = Math.max(1, Number.parseInt(message.quantity, 10) || 1);
    const payload = {
      quantity,
      session: publicTransferSession(session),
    };
    sendSocketJson(session.senderSocket, {
      type: 'transfer_run_sent',
      ...payload,
    });
    sendSocketJson(session.receiverSocket, {
      type: 'transfer_run',
      ...payload,
    });
  }

  function transferBuyOrderReady(source, message) {
    const session = sessionForSocket(source.socket);
    if (!session) {
      sendTransferError(source.socket, 'session_not_found', 'No transfer session is active');
      return;
    }
    if (session.status !== 'accepted') {
      sendTransferError(source.socket, 'session_not_accepted', 'Transfer session is not accepted yet');
      return;
    }
    if (session.receiverSocket !== source.socket) {
      sendTransferError(source.socket, 'receiver_required', 'Only the transfer receiver can mark the buy order ready');
      return;
    }

    const quantity = Math.max(1, Number.parseInt(message.quantity, 10) || 1);
    sendSocketJson(session.senderSocket, {
      type: 'transfer_buy_order_ready',
      quantity,
      session: publicTransferSession(session),
    });
  }

  function transferSellOfferReady(source, message) {
    const session = sessionForSocket(source.socket);
    if (!session) {
      sendTransferError(source.socket, 'session_not_found', 'No transfer session is active');
      return;
    }
    if (session.status !== 'accepted') {
      sendTransferError(source.socket, 'session_not_accepted', 'Transfer session is not accepted yet');
      return;
    }
    if (session.receiverSocket !== source.socket) {
      sendTransferError(source.socket, 'receiver_required', 'Only the transfer receiver can mark the sell offer ready');
      return;
    }

    const quantity = Math.max(1, Number.parseInt(message.quantity, 10) || 1);
    sendSocketJson(session.senderSocket, {
      type: 'transfer_sell_offer_ready',
      quantity,
      session: publicTransferSession(session),
    });
  }

  function transferSellOfferBought(source, message) {
    const session = sessionForSocket(source.socket);
    if (!session) {
      sendTransferError(source.socket, 'session_not_found', 'No transfer session is active');
      return;
    }
    if (session.status !== 'accepted') {
      sendTransferError(source.socket, 'session_not_accepted', 'Transfer session is not accepted yet');
      return;
    }
    if (session.senderSocket !== source.socket) {
      sendTransferError(source.socket, 'sender_required', 'Only the transfer sender can mark the sell offer bought');
      return;
    }

    const quantity = Math.max(1, Number.parseInt(message.quantity, 10) || 1);
    sendSocketJson(session.receiverSocket, {
      type: 'transfer_sell_offer_bought',
      quantity,
      session: publicTransferSession(session),
    });
  }

  function transferCycleComplete(source, message) {
    const session = sessionForSocket(source.socket);
    if (!session) {
      sendTransferError(source.socket, 'session_not_found', 'No transfer session is active');
      return;
    }
    if (session.status !== 'accepted') {
      sendTransferError(source.socket, 'session_not_accepted', 'Transfer session is not accepted yet');
      return;
    }
    if (session.receiverSocket !== source.socket) {
      sendTransferError(source.socket, 'receiver_required', 'Only the transfer receiver can complete a transfer cycle');
      return;
    }

    const quantity = Math.max(1, Number.parseInt(message.quantity, 10) || 1);
    const before = Number.isFinite(Number(message.before)) ? Math.trunc(Number(message.before)) : 0;
    const after = Number.isFinite(Number(message.after)) ? Math.trunc(Number(message.after)) : before;
    const delta = Number.isFinite(Number(message.delta)) ? Math.trunc(Number(message.delta)) : after - before;
    sendSocketJson(session.senderSocket, {
      type: 'transfer_cycle_complete',
      quantity,
      before,
      after,
      delta,
      session: publicTransferSession(session),
    });
  }

  function cancelSessionForSocket(socket, reason, { notifySource = true } = {}) {
    const session = sessionForSocket(socket);
    if (!session) {
      if (notifySource) sendTransferError(socket, 'session_not_found', 'No transfer session is active');
      return;
    }
    finishSession(session, {
      type: 'transfer_cancelled',
      sessionId: session.id,
      reason,
    }, { excludeSocket: notifySource ? null : socket });
  }

  function finishSession(session, message, { excludeSocket = null } = {}) {
    clearTransferTimer(session);
    transferSessions.delete(session.id);
    for (const socket of [session.senderSocket, session.receiverSocket]) {
      if (socket !== excludeSocket) {
        sendSocketJson(socket, message);
      }
    }
  }

  function expireTransferSessions() {
    const now = Date.now();
    for (const session of [...transferSessions.values()]) {
      if (session.status === 'pending' && Date.parse(session.expiresAt) <= now) {
        finishSession(session, {
          type: 'transfer_cancelled',
          sessionId: session.id,
          reason: 'Transfer invite expired',
        });
      }
    }
  }

  function pruneClosedClients() {
    for (const client of [...clients]) {
      if (client.socket.readyState === WEBSOCKET_CLOSING || client.socket.readyState === WEBSOCKET_CLOSED) {
        remove(client.socket, 'Socket disconnected');
      }
    }
  }

  function clearTransferTimer(session) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  function sessionForSocket(socket) {
    return [...transferSessions.values()].find((session) => (
      session.senderSocket === socket || session.receiverSocket === socket
    ));
  }

  function clientForSocket(socket) {
    return [...clients].find((client) => client.socket === socket) || null;
  }

  function clientByUsername(username) {
    return [...clients].find((client) => (
      client.account && sameUsername(client.account.minecraft_username, username)
    )) || null;
  }

  function publicTransferSession(session) {
    return {
      id: session.id,
      senderUsername: session.senderUsername,
      receiverUsername: session.receiverUsername,
      itemName: session.itemName,
      status: session.status,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  function sendTransferError(socket, code, message) {
    sendSocketJson(socket, {
      type: 'transfer_error',
      code,
      message,
      sentAt: new Date().toISOString(),
    });
  }

  function broadcastDisconnect({ sourceSocket, sourceAccount }) {
    if (!sourceAccount) return;
    const minecraftUsername = sourceAccount.minecraft_username;
    const message = {
      type: 'disconnect_now',
      reason: `Ban detected on ${minecraftUsername || 'another account'}`,
      sourceAccount: {
        id: sourceAccount.id,
        minecraftUuid: sourceAccount.minecraft_uuid,
        minecraftUsername,
      },
      sentAt: new Date().toISOString(),
    };

    for (const client of clients) {
      if (client.socket === sourceSocket) continue;
      if (client.socket.readyState === WEBSOCKET_CLOSING || client.socket.readyState === WEBSOCKET_CLOSED) {
        clients.delete(client);
        continue;
      }
      sendSocketJson(client.socket, message);
    }
  }

  function cleanText(value) {
    return String(value || '').trim();
  }

  function sameUsername(left, right) {
    return cleanText(left).toLowerCase() === cleanText(right).toLowerCase();
  }

  return { register, remove, broadcastDisconnect, handleTransferMessage, liveAccountStatuses, hasLiveAccountConnection, sendToAccount };
}

function applyLiveAccountStatuses(accounts, liveStatuses) {
  if (!Array.isArray(liveStatuses) || liveStatuses.length === 0) return accounts;
  const liveByAccountId = new Map(liveStatuses.map((status) => [status.accountId, status]));
  return accounts.map((account) => {
    const live = liveByAccountId.get(account.id);
    if (!live || account.status === 'banned') return account;
    return {
      ...account,
      status: live.status,
      current_user_id: live.currentUserId || account.current_user_id || null,
      current_username: live.currentUsername || account.current_username || null,
    };
  });
}

function sendDeletedModAccountError(socket) {
  sendSocketJson(socket, {
    type: 'error',
    code: 'account_deleted',
    message: 'Minecraft account was deleted from the dashboard; reconnect the mod to register it again.',
  });
  setImmediate(() => socket.close(4000, 'account_deleted'));
}

function attachModWebSocketServer(server, {
  db,
  fetchImpl,
  enabled = true,
  authorizeDashboard = null,
  dashboardAccounts = null,
} = {}) {
  if (!db) return null;

  const modSocketServer = enabled ? new WebSocketServer({ noServer: true }) : null;
  const dashboardSocketServer = dashboardAccounts ? new WebSocketServer({ noServer: true }) : null;
  const modConnections = createModConnectionRegistry();
  const liveControls = createLiveControlStore();
  dashboardAccounts?.setLiveAccountStatusProvider(() => modConnections.liveAccountStatuses());
  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (parsedUrl.pathname === '/api/mod/ws' && modSocketServer) {
      modSocketServer.handleUpgrade(req, socket, head, (ws) => {
        modSocketServer.emit('connection', ws, req);
      });
      return;
    }

    if (parsedUrl.pathname === '/api/dashboard/ws' && dashboardSocketServer && authorizeDashboard) {
      const access = authorizeDashboard(req);
      if (!access.ok) {
        socket.write(`HTTP/1.1 ${access.status} Unauthorized\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      dashboardSocketServer.handleUpgrade(req, socket, head, (ws) => {
        dashboardSocketServer.emit('connection', ws, req, access.auth);
      });
      return;
    }

    socket.destroy();
  });

  if (dashboardSocketServer) {
    dashboardSocketServer.on('connection', (socket) => {
      dashboardAccounts.attach(socket);
      liveControls.attachDashboard(socket, modConnections);
    });
  }

  if (!modSocketServer) {
    return { modSocketServer, dashboardSocketServer, modConnections };
  }

  modSocketServer.on('connection', (socket, req) => {
    let authContext = null;
    let account = null;
    socket.on('close', () => {
      if (!authContext || !account || !account.id) {
        return;
      }
      if (!modConnections.hasLiveAccountConnection(account.id, socket)) {
        account = recordMinecraftAccountConnectionStatus(db, account.id, 'offline');
      }
      dashboardAccounts?.broadcast();
    });

    socket.on('message', async (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch (err) {
        sendSocketJson(socket, { type: 'error', code: 'invalid_json', message: 'Invalid JSON message' });
        return;
      }

      if (!authContext) {
        if (message.type !== 'auth') {
          sendSocketJson(socket, { type: 'error', code: 'auth_required', message: 'Send auth first' });
          return;
        }

        const auth = authenticateApiKey(db, message.apiKey);
        if (!auth) {
          sendSocketJson(socket, { type: 'error', code: 'unauthorized', message: 'Invalid API key' });
          return;
        }
        if (!apiKeyHasScopes(auth, ['mod:connect'])) {
          sendSocketJson(socket, { type: 'error', code: 'forbidden', message: 'API key missing mod:connect scope' });
          return;
        }

        try {
          const profile = await getMinecraftProfileByUsername(message.username, fetchImpl);
          const registeredAccount = upsertMinecraftAccountFromMod(db, {
            minecraftUuid: profile.id,
            minecraftUsername: profile.name,
            ownerUserId: auth.user.id,
            clientVersion: message.clientVersion || null,
          });
          if (!registeredAccount || !registeredAccount.id) {
            throw new Error('Account registration failed');
          }
          authContext = auth;
          account = registeredAccount;
          modConnections.register(socket, auth, account);
          auditRequest(db, auth, req, 'mod.connect', { accountId: account.id, username: profile.name });
          dashboardAccounts?.broadcast();
          sendSocketJson(socket, {
            type: 'auth_ok',
            account,
            user: auth.user,
          });
        } catch (err) {
          authContext = null;
          account = null;
          const message = err && err.message ? err.message : 'Profile lookup failed';
          const code = message === 'Account registration failed' ? 'account_registration_failed' : 'profile_lookup_failed';
          sendSocketJson(socket, { type: 'error', code, message });
          setImmediate(() => socket.close(1011, code));
        }
        return;
      }

      if (!account || !account.id) {
        authContext = null;
        account = null;
        sendSocketJson(socket, {
          type: 'error',
          code: 'account_unavailable',
          message: 'Authenticated Minecraft account is unavailable; reconnect the mod.',
        });
        setImmediate(() => socket.close(1011, 'account_unavailable'));
        return;
      }

      if (message.type === 'heartbeat') {
        account = recordMinecraftAccountHeartbeat(db, account.id, { currentUserId: authContext.user.id });
        if (!account) {
          sendDeletedModAccountError(socket);
          return;
        }
        modConnections.register(socket, authContext, account);
        dashboardAccounts?.broadcast();
        sendSocketJson(socket, {
          type: 'heartbeat_ok',
          accountId: account.id,
          lastSeenAt: account.last_seen_at,
        });
        return;
      }

      if (message.type === 'active' || message.type === 'hypixel' || message.type === 'offline' || message.type === 'banned') {
        account = recordMinecraftAccountConnectionStatus(db, account.id, message.type, {
          banReason: message.banReason,
          banUntil: message.banUntil,
          banId: message.banId,
        }, {
          currentUserId: authContext.user.id,
        });
        if (!account) {
          sendDeletedModAccountError(socket);
          return;
        }
        modConnections.register(socket, authContext, account);
        auditRequest(db, authContext, req, 'mod.status', {
          accountId: account.id,
          status: account.status,
          banUntil: account.ban_until,
          banId: account.ban_id,
        });
        dashboardAccounts?.broadcast();
        sendSocketJson(socket, {
          type: 'status_ok',
          accountId: account.id,
          status: account.status,
          account,
          lastSeenAt: account.last_seen_at,
        });
        if (message.type === 'banned' && account.status === 'banned') {
          modConnections.broadcastDisconnect({ sourceSocket: socket, sourceAccount: account });
        }
        return;
      }

      if (modConnections.handleTransferMessage(socket, message)) {
        return;
      }

      if (liveControls.handleModMessage(account, message)) {
        return;
      }

      sendSocketJson(socket, { type: 'error', code: 'unknown_type', message: 'Unknown message type' });
    });
  });

  return { modSocketServer, dashboardSocketServer, modConnections, liveControls };
}

function createAppServer(options = {}) {
  const publicDir = options.publicDir || PUBLIC_DIR;
  const fetchImpl = options.fetchImpl || global.fetch;
  const auctionIndex = options.auctionIndex || createAuctionIndexService(options);
  const db = options.db === false
    ? null
    : (options.db || createDatabase(options.databasePath || process.env.DATABASE_PATH || path.join(__dirname, 'data', 'app.db')));
  const bootstrapToken = options.bootstrapToken ?? process.env.OWNER_API_KEY ?? process.env.AUCTION_API_TOKEN;
  ensureBootstrapApiKey(db, bootstrapToken);
  ensureBootstrapDashboardUser(
    db,
    options.dashboardUsername ?? process.env.DASHBOARD_USERNAME,
    options.dashboardPassword ?? process.env.DASHBOARD_PASSWORD
  );
  const authorize = createAuthorizer({
    db,
    legacyApiToken: options.apiToken ?? process.env.AUCTION_API_TOKEN,
  });
  const authorizeDashboard = createDashboardAuthorizer(db);
  const loginRateLimiter = options.loginRateLimit === false
    ? null
    : createLoginRateLimiter(options.loginRateLimit);
  const secureCookies = options.secureCookies;

  const accountHeartbeatWindowMs = options.accountHeartbeatWindowMs || DEFAULT_ACCOUNT_HEARTBEAT_WINDOW_MS;
  let getLiveAccountStatuses = () => [];
  function listDashboardMinecraftAccounts() {
    return applyLiveAccountStatuses(
      listMinecraftAccounts(db, { heartbeatWindowMs: accountHeartbeatWindowMs }),
      getLiveAccountStatuses()
    );
  }
  const dashboardAccounts = db
    ? createDashboardAccountBroadcaster({ db, heartbeatWindowMs: accountHeartbeatWindowMs })
    : null;
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }

    if (pathname === '/api/index/status' && req.method === 'GET') {
      const access = authorize(req, parsedUrl, {}, ['auction:read']);
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }
      writeJson(res, 200, auctionIndex.getStatus());
      return;
    }

    if (pathname === '/api/index/refresh' && req.method === 'GET') {
      const access = authorize(req, parsedUrl, {}, ['auction:read'], { allowQueryToken: true });
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const sendSSE = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      };

      try {
        await auctionIndex.ensureFresh(sendSSE);
      } catch (err) {
        sendSSE('error', { message: err.message });
      } finally {
        res.end();
      }
      return;
    }

    if (pathname === '/api/search' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = authorize(req, parsedUrl, body, ['auction:read']);
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }

        const refreshResult = await auctionIndex.ensureFresh();
        const results = searchIndexedAuctions(auctionIndex.getItems(), body);
        writeJson(res, 200, {
          cache: refreshResult.status,
          source: refreshResult.source,
          results,
        });
      } catch (err) {
        writeJson(res, err.message === 'Invalid JSON body' ? 400 : 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/recommend-bin' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = authorize(req, parsedUrl, body, ['auction:read']);
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }

        const refreshResult = await auctionIndex.ensureFresh();
        const recommendation = recommendBin(auctionIndex.getItems(), body);
        writeJson(res, 200, {
          cache: refreshResult.status,
          source: refreshResult.source,
          ...recommendation,
        });
      } catch (err) {
        writeJson(res, err.message === 'Invalid JSON body' ? 400 : 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/scan' && req.method === 'GET') {
      const access = authorize(req, parsedUrl, {}, ['auction:read'], { allowQueryToken: true });
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const sendSSE = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      };

      try {
        const targetItem = parsedUrl.searchParams.get('item') || 'Final Destination Chestplate';
        await auctionIndex.ensureFresh(sendSSE);
        const results = searchIndexedAuctions(auctionIndex.getItems(), {
          query: targetItem,
          filters: {},
          sort: 'price_asc',
          limit: 500,
        });
        sendSSE('done', { results });
      } catch (err) {
        sendSSE('error', { message: err.message });
      } finally {
        res.end();
      }
      return;
    }

    if (pathname === '/api/usernames' && req.method === 'POST') {
      try {
        const uuids = await parseRequestBody(req);
        const access = authorize(req, parsedUrl, uuids, ['auction:read']);
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const mapping = {};
        await Promise.all((Array.isArray(uuids) ? uuids : []).map(async (uuid) => {
          mapping[uuid] = await getUsername(uuid, fetchImpl);
        }));
        writeJson(res, 200, mapping);
      } catch (err) {
        writeJson(res, 400, { error: 'Invalid JSON body' });
      }
      return;
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const access = authorize(req, parsedUrl);
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }
      writeJson(res, 200, {
        user: access.auth.user,
        apiKey: access.auth.apiKey,
      });
      return;
    }

    if (pathname === '/api/mod/account-proxy' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = authorize(req, parsedUrl, body, ['mod:connect']);
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        if (!body.minecraftUuid && !body.minecraftUsername) {
          writeJson(res, 400, { error: 'minecraftUuid or minecraftUsername is required' });
          return;
        }
        const proxy = getMinecraftAccountProxyForOwner(db, {
          ownerUserId: access.auth.user.id,
          minecraftUuid: body.minecraftUuid,
          minecraftUsername: body.minecraftUsername,
        });
        if (!proxy) {
          writeJson(res, 404, { error: 'Minecraft account proxy not found' });
          return;
        }
        auditRequest(db, access.auth, req, 'mod.account_proxy.lookup', {
          accountId: proxy.accountId,
          minecraftUsername: proxy.minecraftUsername,
          proxyEnabled: proxy.enabled,
        });
        writeJson(res, 200, { proxy });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/login' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const loginLimit = loginRateLimiter ? loginRateLimiter.check(req, body.username) : { ok: true };
        if (!loginLimit.ok) {
          writeJson(res, 429, {
            error: 'Too many login attempts. Try again later.',
            retryAfterSeconds: loginLimit.retryAfterSeconds,
          });
          return;
        }
        const user = authenticateUserPassword(db, body.username, body.password);
        if (!user) {
          if (loginRateLimiter) loginRateLimiter.recordFailure(req, body.username);
          writeJson(res, 401, { error: 'Invalid username or password' });
          return;
        }
        if (loginRateLimiter) loginRateLimiter.reset(req, body.username);
        const session = createDashboardSession(db, user.id);
        res.setHeader('Set-Cookie', sessionCookie(session.rawToken, undefined, shouldUseSecureCookies(req, secureCookies)));
        auditRequest(db, { user, apiKey: { id: null } }, req, 'dashboard.login');
        writeJson(res, 200, {
          user,
          expiresAt: session.expiresAt,
        });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/logout' && req.method === 'POST') {
      const token = parseCookies(req).dashboard_session;
      revokeDashboardSession(db, token);
      res.setHeader('Set-Cookie', clearSessionCookie(shouldUseSecureCookies(req, secureCookies)));
      writeJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/dashboard/me' && req.method === 'GET') {
      const access = authorizeDashboard(req);
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }
      writeJson(res, 200, {
        user: access.auth.user,
        session: access.auth.session,
      });
      return;
    }

    if (pathname === '/api/dashboard/accounts' && req.method === 'GET') {
      const access = authorizeDashboard(req);
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }
      writeJson(res, 200, { accounts: listDashboardMinecraftAccounts() });
      return;
    }

    if (pathname === '/api/dashboard/accounts' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardAccountManager(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const account = createMinecraftAccount(db, {
          label: body.label,
          minecraftUuid: body.minecraftUuid,
          minecraftUsername: body.minecraftUsername,
          ownerUserId: body.ownerUserId || access.auth.user.id,
          notes: body.notes,
        });
        auditRequest(db, access.auth, req, 'minecraft_account.create', { accountId: account.id });
        dashboardAccounts?.broadcast();
        writeJson(res, 201, { account });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/accounts/status' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardAccountManager(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        updateMinecraftAccountStatus(db, body.accountId, {
          status: body.status,
          banReason: body.banReason,
        });
        auditRequest(db, access.auth, req, 'minecraft_account.status', {
          accountId: body.accountId,
          status: body.status,
        });
        dashboardAccounts?.broadcast();
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/accounts/proxy' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardAccountManager(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const account = updateMinecraftAccountProxy(db, body.accountId, {
          proxyEnabled: body.proxyEnabled,
          proxyType: body.proxyType,
          proxyHost: body.proxyHost,
          proxyPort: body.proxyPort,
          proxyUsername: body.proxyUsername,
          proxyPassword: body.proxyPassword,
        });
        if (!account) {
          writeJson(res, 404, { error: 'Minecraft account not found' });
          return;
        }
        auditRequest(db, access.auth, req, 'minecraft_account.proxy', {
          accountId: account.id,
          proxyEnabled: Boolean(account.proxy_enabled),
          proxyType: account.proxy_type,
          proxyHost: account.proxy_host,
          proxyPort: account.proxy_port,
          proxyUsername: account.proxy_username,
          proxyHasPassword: Boolean(account.proxy_has_password),
        });
        dashboardAccounts?.broadcast();
        writeJson(res, 200, { account });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/accounts/banned-folder' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardAccountManager(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const account = markMinecraftAccountBannedFoldered(db, body.accountId);
        if (!account) {
          writeJson(res, 404, { error: 'Banned Minecraft account not found' });
          return;
        }
        auditRequest(db, access.auth, req, 'minecraft_account.banned_folder', {
          accountId: body.accountId,
        });
        dashboardAccounts?.broadcast();
        writeJson(res, 200, { account });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/accounts/delete' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        deleteMinecraftAccount(db, body.accountId);
        auditRequest(db, access.auth, req, 'minecraft_account.delete', {
          accountId: body.accountId,
        });
        dashboardAccounts?.broadcast();
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/users' && req.method === 'GET') {
      const access = requireDashboardOwner(authorizeDashboard(req));
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }
      writeJson(res, 200, { users: listDashboardUsers(db) });
      return;
    }

    if (pathname === '/api/dashboard/users' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const existing = listDashboardUsers(db).find((user) => user.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
        if (existing) {
          writeJson(res, 409, { error: 'Dashboard username already exists' });
          return;
        }
        const user = createUser(db, {
          username: body.username,
          role: body.role || 'viewer',
        });
        updateUserRole(db, user.id, body.role || 'viewer');
        setUserPassword(db, user.id, body.password);
        auditRequest(db, access.auth, req, 'dashboard_user.create', {
          userId: user.id,
          username: user.username,
          role: body.role || 'viewer',
        });
        writeJson(res, 201, {
          user: listDashboardUsers(db).find((row) => row.id === user.id),
        });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/users/role' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        updateUserRole(db, body.userId, body.role);
        auditRequest(db, access.auth, req, 'dashboard_user.role', {
          userId: body.userId,
          role: body.role,
        });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/users/password' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        setUserPassword(db, body.userId, body.password);
        auditRequest(db, access.auth, req, 'dashboard_user.password', {
          userId: body.userId,
        });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/users/delete' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        if (Number(body.userId) === Number(access.auth.user.id)) {
          writeJson(res, 400, { error: 'You cannot delete your own active dashboard user' });
          return;
        }
        deleteDashboardUser(db, body.userId);
        auditRequest(db, access.auth, req, 'dashboard_user.delete', {
          userId: body.userId,
        });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/api-keys' && req.method === 'GET') {
      const access = requireDashboardOwner(authorizeDashboard(req));
      if (!access.ok) {
        writeJson(res, access.status, access.payload);
        return;
      }
      writeJson(res, 200, { apiKeys: listApiKeys(db) });
      return;
    }

    if (pathname === '/api/dashboard/api-keys' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        if (!body.userId) {
          writeJson(res, 400, { error: 'Select an existing dashboard user for this API key' });
          return;
        }
        const user = getDashboardUserById(db, body.userId);
        if (!user || user.disabled_at || !user.has_password) {
          writeJson(res, 400, { error: 'API keys can only be assigned to dashboard users with passwords' });
          return;
        }
        const apiKey = createApiKey(db, {
          userId: user.id,
          name: body.name,
          scopes: Array.isArray(body.scopes) ? body.scopes : ['auction:read'],
        });
        auditRequest(db, access.auth, req, 'api_key.create', {
          apiKeyId: apiKey.id,
          username: user.username,
          scopes: apiKey.scopes,
        });
        writeJson(res, 201, { user, apiKey });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/api-keys/revoke' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        revokeApiKey(db, body.apiKeyId);
        auditRequest(db, access.auth, req, 'api_key.revoke', { apiKeyId: body.apiKeyId });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/api-keys/delete' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const deleted = deleteApiKey(db, body.apiKeyId);
        auditRequest(db, access.auth, req, 'api_key.delete', {
          apiKeyId: deleted.id,
          userId: deleted.user_id,
          name: deleted.name,
          prefix: deleted.key_prefix,
        });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/dashboard/api-keys/replace' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const access = requireDashboardOwner(authorizeDashboard(req));
        if (!access.ok) {
          writeJson(res, access.status, access.payload);
          return;
        }
        const replacement = rotateApiKey(db, body.apiKeyId);
        auditRequest(db, access.auth, req, 'api_key.replace', {
          revokedApiKeyId: replacement.revokedApiKeyId,
          apiKeyId: replacement.apiKey.id,
          username: replacement.user.username,
          scopes: replacement.apiKey.scopes,
        });
        writeJson(res, 201, replacement);
      } catch (err) {
        writeJson(res, 400, { error: err.message });
      }
      return;
    }

    const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, requestedPath);
    const relative = path.relative(publicDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const extname = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
    };

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT' && req.method === 'GET' && !extname) {
          fs.readFile(path.join(publicDir, 'index.html'), (indexErr, indexContent) => {
            if (indexErr) {
              res.writeHead(500, { 'Content-Type': 'text/html' });
              res.end(`Server Error: ${indexErr.code}`, 'utf-8');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(indexContent);
          });
          return;
        }
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/html' });
        res.end(err.code === 'ENOENT' ? '<h1>404 Not Found</h1>' : `Server Error: ${err.code}`, 'utf-8');
        return;
      }

      res.writeHead(200, { 'Content-Type': contentTypes[extname] || 'application/octet-stream' });
      res.end(content);
    });
  });

  const socketServers = attachModWebSocketServer(server, {
    db,
    fetchImpl,
    enabled: options.modWebSocket !== false,
    authorizeDashboard,
    dashboardAccounts,
  });
  if (socketServers && socketServers.modConnections) {
    getLiveAccountStatuses = () => socketServers.modConnections.liveAccountStatuses();
    dashboardAccounts?.setLiveAccountStatusProvider(getLiveAccountStatuses);
  }
  return server;
}

if (require.main === module) {
  loadDotEnv();
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR);
  }

  const port = Number(process.env.PORT || DEFAULT_PORT);
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'app.db');
  const configuredBootstrapToken = process.env.OWNER_API_KEY || process.env.AUCTION_API_TOKEN;
  let generatedBootstrapToken = null;
  let bootstrapToken = configuredBootstrapToken;
  const configuredDashboardUsername = process.env.DASHBOARD_USERNAME;
  const configuredDashboardPassword = process.env.DASHBOARD_PASSWORD;
  let generatedDashboardPassword = null;
  let dashboardUsername = configuredDashboardUsername;
  let dashboardPassword = configuredDashboardPassword;

  if (!bootstrapToken) {
    const db = createDatabase(databasePath);
    if (countActiveApiKeys(db) === 0) {
      generatedBootstrapToken = `hpx_live_${crypto.randomBytes(24).toString('base64url')}`;
      bootstrapToken = generatedBootstrapToken;
    }
    db.close();
  }

  if (!dashboardUsername || !dashboardPassword) {
    const db = createDatabase(databasePath);
    if (countPasswordUsers(db) === 0) {
      dashboardUsername = dashboardUsername || 'owner';
      generatedDashboardPassword = crypto.randomBytes(18).toString('base64url');
      dashboardPassword = generatedDashboardPassword;
    }
    db.close();
  }

  const server = createAppServer({
    databasePath,
    bootstrapToken,
    dashboardUsername,
    dashboardPassword,
  });
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    if (generatedBootstrapToken) {
      console.warn('Generated first-run owner API key. Save it now, then create named keys in the dashboard:');
      console.warn(generatedBootstrapToken);
    } else if (!configuredBootstrapToken) {
      console.warn('No OWNER_API_KEY or AUCTION_API_TOKEN is set. Existing database API keys are required for access.');
    }
    if (generatedDashboardPassword) {
      console.warn('Generated first-run dashboard login. Save it now, then change it later:');
      console.warn(`username: ${dashboardUsername}`);
      console.warn(`password: ${generatedDashboardPassword}`);
    } else if (!configuredDashboardUsername || !configuredDashboardPassword) {
      console.warn('No DASHBOARD_USERNAME/DASHBOARD_PASSWORD is set. Existing dashboard users are required for login.');
    }
    console.log('Press Ctrl+C to stop');
  });
}

module.exports = {
  createAppServer,
  createAuctionIndexService,
  loadDotEnv,
};
