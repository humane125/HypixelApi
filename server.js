const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const {
  normalizeAuction,
  searchIndexedAuctions,
  recommendBin,
} = require('./auction-core');

const DEFAULT_PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const HYPIXEL_AUCTIONS_URL = 'https://api.hypixel.net/v2/skyblock/auctions';

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

function createAuthChecker(apiToken) {
  return function isAuthorized(req, parsedUrl, body = {}) {
    if (!apiToken) return true;

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : null;
    const supplied = req.headers['x-auction-token'] || bearer || parsedUrl.query.token || body.token;
    return supplied === apiToken;
  };
}

function createAppServer(options = {}) {
  const publicDir = options.publicDir || PUBLIC_DIR;
  const fetchImpl = options.fetchImpl || global.fetch;
  const auctionIndex = options.auctionIndex || createAuctionIndexService(options);
  const isAuthorized = createAuthChecker(options.apiToken ?? process.env.AUCTION_API_TOKEN);

  return http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }

    if (pathname === '/api/index/status' && req.method === 'GET') {
      if (!isAuthorized(req, parsedUrl)) {
        writeJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      writeJson(res, 200, auctionIndex.getStatus());
      return;
    }

    if (pathname === '/api/index/refresh' && req.method === 'GET') {
      if (!isAuthorized(req, parsedUrl)) {
        writeJson(res, 401, { error: 'Unauthorized' });
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
        if (!isAuthorized(req, parsedUrl, body)) {
          writeJson(res, 401, { error: 'Unauthorized' });
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
        if (!isAuthorized(req, parsedUrl, body)) {
          writeJson(res, 401, { error: 'Unauthorized' });
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
      if (!isAuthorized(req, parsedUrl)) {
        writeJson(res, 401, { error: 'Unauthorized' });
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
        const targetItem = parsedUrl.query.item || 'Final Destination Chestplate';
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
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/html' });
        res.end(err.code === 'ENOENT' ? '<h1>404 Not Found</h1>' : `Server Error: ${err.code}`, 'utf-8');
        return;
      }

      res.writeHead(200, { 'Content-Type': contentTypes[extname] || 'application/octet-stream' });
      res.end(content);
    });
  });
}

if (require.main === module) {
  loadDotEnv();
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR);
  }

  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createAppServer();
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    if (!process.env.AUCTION_API_TOKEN) {
      console.warn('Warning: AUCTION_API_TOKEN is not set. API endpoints are not token-protected.');
    }
    console.log('Press Ctrl+C to stop');
  });
}

module.exports = {
  createAppServer,
  createAuctionIndexService,
  loadDotEnv,
};
