const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const API_KEY_PREFIX_LENGTH = 11;
const SESSION_DAYS = 7;
const DASHBOARD_ROLES = new Set(['owner', 'manager', 'viewer']);
const DEFAULT_ACCOUNT_HEARTBEAT_WINDOW_MS = 60_000;
const BANNED_FOLDER_DELAY_MS = 8 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function ensureParentDirectory(databasePath) {
  if (!databasePath || databasePath === ':memory:') return;
  const dir = path.dirname(path.resolve(databasePath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseScopes(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function createDatabase(databasePath = path.join(__dirname, 'data', 'app.db')) {
  ensureParentDirectory(databasePath);
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT,
      created_at TEXT NOT NULL,
      disabled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      raw_key TEXT,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

    CREATE TABLE IF NOT EXISTS minecraft_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      minecraft_uuid TEXT NOT NULL UNIQUE,
      minecraft_username TEXT NOT NULL,
      owner_user_id INTEGER,
      current_user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT NOT NULL DEFAULT '',
      ban_reason TEXT,
      banned_at TEXT,
      ban_until TEXT,
      ban_id TEXT,
      banned_foldered_at TEXT,
      proxy_enabled INTEGER NOT NULL DEFAULT 0,
      proxy_type TEXT NOT NULL DEFAULT 'SOCKS5',
      proxy_host TEXT,
      proxy_port INTEGER,
      proxy_username TEXT,
      proxy_password TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (current_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_minecraft_accounts_status ON minecraft_accounts(status);

    CREATE TABLE IF NOT EXISTS minecraft_account_stats (
      minecraft_account_id INTEGER PRIMARY KEY REFERENCES minecraft_accounts(id) ON DELETE CASCADE,
      purse INTEGER,
      fd_helmet_kills INTEGER,
      fd_chestplate_kills INTEGER,
      fd_leggings_kills INTEGER,
      fd_boots_kills INTEGER,
      summoning_eyes_held INTEGER NOT NULL DEFAULT 0,
      summoning_eyes_listed INTEGER NOT NULL DEFAULT 0,
      summoning_eye_list_price INTEGER NOT NULL DEFAULT 0,
      sold_auction_credit INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS minecraft_account_auction_snapshots (
      auction_uuid TEXT PRIMARY KEY,
      minecraft_account_id INTEGER NOT NULL REFERENCES minecraft_accounts(id) ON DELETE CASCADE,
      price INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      last_seen_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_minecraft_account_auction_snapshots_account
      ON minecraft_account_auction_snapshots(minecraft_account_id);
    CREATE INDEX IF NOT EXISTS idx_minecraft_account_auction_snapshots_state
      ON minecraft_account_auction_snapshots(state);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      api_key_id INTEGER,
      action TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_token_hash ON dashboard_sessions(token_hash);
  `);

  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  if (!userColumns.includes('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }

  const apiKeyColumns = db.prepare('PRAGMA table_info(api_keys)').all().map((column) => column.name);
  if (!apiKeyColumns.includes('raw_key')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN raw_key TEXT');
  }

  const accountColumns = db.prepare('PRAGMA table_info(minecraft_accounts)').all().map((column) => column.name);
  if (!accountColumns.includes('last_seen_at')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN last_seen_at TEXT');
  }
  if (!accountColumns.includes('last_connected_at')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN last_connected_at TEXT');
  }
  if (!accountColumns.includes('client_version')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN client_version TEXT');
  }
  if (!accountColumns.includes('ban_until')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN ban_until TEXT');
  }
  if (!accountColumns.includes('ban_id')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN ban_id TEXT');
  }
  if (!accountColumns.includes('banned_foldered_at')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN banned_foldered_at TEXT');
  }
  if (!accountColumns.includes('proxy_enabled')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN proxy_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!accountColumns.includes('proxy_type')) {
    db.exec("ALTER TABLE minecraft_accounts ADD COLUMN proxy_type TEXT NOT NULL DEFAULT 'SOCKS5'");
  }
  if (!accountColumns.includes('proxy_host')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN proxy_host TEXT');
  }
  if (!accountColumns.includes('proxy_port')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN proxy_port INTEGER');
  }
  if (!accountColumns.includes('proxy_username')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN proxy_username TEXT');
  }
  if (!accountColumns.includes('proxy_password')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN proxy_password TEXT');
  }
  if (!accountColumns.includes('current_user_id')) {
    db.exec('ALTER TABLE minecraft_accounts ADD COLUMN current_user_id INTEGER');
  }
}

function createUser(db, { username, role = 'user' }) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) throw new Error('Username is required');

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername);
  if (existing) return existing;

  const result = db.prepare(`
    INSERT INTO users (username, role, created_at)
    VALUES (?, ?, ?)
  `).run(cleanUsername, role, nowIso());

  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (actual.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actual, expectedBuffer);
}

function setUserPassword(db, userId, password) {
  const cleanPassword = String(password || '');
  if (cleanPassword.length < 8) throw new Error('Password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPassword), userId);
}

function listDashboardUsers(db) {
  return db.prepare(`
    SELECT
      id,
      username,
      role,
      password_hash IS NOT NULL AS has_password,
      created_at,
      disabled_at
    FROM users
    ORDER BY id ASC
  `).all();
}

function getDashboardUserById(db, userId) {
  return db.prepare(`
    SELECT
      id,
      username,
      role,
      password_hash IS NOT NULL AS has_password,
      created_at,
      disabled_at
    FROM users
    WHERE id = ?
  `).get(userId);
}

function updateUserRole(db, userId, role) {
  const cleanRole = String(role || '').trim().toLowerCase();
  if (!DASHBOARD_ROLES.has(cleanRole)) throw new Error('Invalid dashboard role');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(cleanRole, userId);
}

function deleteDashboardUser(db, userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function authenticateUserPassword(db, username, password) {
  const user = db.prepare(`
    SELECT id, username, role, password_hash, disabled_at
    FROM users
    WHERE username = ?
  `).get(String(username || '').trim());

  if (!user || user.disabled_at || !user.password_hash) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

function countPasswordUsers(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL AND disabled_at IS NULL').get().count;
}

function createDashboardSession(db, userId, { rawToken = null, expiresAt = null } = {}) {
  if (!userId) throw new Error('userId is required');
  const token = rawToken || `dash_${crypto.randomBytes(32).toString('base64url')}`;
  const createdAt = nowIso();
  const expires = expiresAt || new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`
    INSERT INTO dashboard_sessions (user_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, hashToken(token), createdAt, expires);

  return {
    id: Number(result.lastInsertRowid),
    userId,
    rawToken: token,
    expiresAt: expires,
  };
}

function authenticateDashboardSession(db, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const row = db.prepare(`
    SELECT
      dashboard_sessions.*,
      users.username,
      users.role,
      users.disabled_at
    FROM dashboard_sessions
    JOIN users ON users.id = dashboard_sessions.user_id
    WHERE dashboard_sessions.token_hash = ?
  `).get(hashToken(token));

  if (!row || row.revoked_at || row.disabled_at) return null;
  if (row.expires_at <= nowIso()) return null;
  return {
    session: {
      id: row.id,
      expiresAt: row.expires_at,
    },
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
    },
  };
}

function revokeDashboardSession(db, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return;
  db.prepare('UPDATE dashboard_sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(), hashToken(token));
}

function createApiKey(db, {
  userId,
  name,
  scopes = [],
  rawKey = null,
  expiresAt = null,
}) {
  if (!userId) throw new Error('userId is required');
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('API key name is required');

  const key = rawKey || `hpx_live_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = key.slice(0, API_KEY_PREFIX_LENGTH);
  const result = db.prepare(`
    INSERT INTO api_keys (user_id, name, key_hash, key_prefix, raw_key, scopes_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    cleanName,
    hashApiKey(key),
    prefix,
    key,
    JSON.stringify(scopes),
    nowIso(),
    expiresAt
  );

  return {
    id: Number(result.lastInsertRowid),
    userId,
    name: cleanName,
    prefix,
    scopes,
    rawKey: key,
  };
}

function authenticateApiKey(db, rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return null;

  const prefix = key.slice(0, API_KEY_PREFIX_LENGTH);
  const rows = db.prepare(`
    SELECT
      api_keys.*,
      users.username,
      users.role,
      users.disabled_at
    FROM api_keys
    JOIN users ON users.id = api_keys.user_id
    WHERE api_keys.key_prefix = ?
  `).all(prefix);
  const expectedHash = hashApiKey(key);
  const now = nowIso();

  for (const row of rows) {
    if (!timingSafeEqualHex(row.key_hash, expectedHash)) continue;
    if (row.revoked_at || row.disabled_at) return null;
    if (row.expires_at && row.expires_at <= now) return null;

    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return {
      user: {
        id: row.user_id,
        username: row.username,
        role: row.role,
      },
      apiKey: {
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        scopes: parseScopes(row.scopes_json),
      },
    };
  }

  return null;
}

function revokeApiKey(db, apiKeyId) {
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), apiKeyId);
}

function deleteApiKey(db, apiKeyId) {
  const existing = db.prepare(`
    SELECT id, user_id, name, key_prefix, scopes_json, revoked_at
    FROM api_keys
    WHERE id = ?
  `).get(apiKeyId);

  if (!existing) throw new Error('API key not found');
  if (!existing.revoked_at) throw new Error('Revoke the API key before deleting it');

  db.prepare('DELETE FROM api_keys WHERE id = ?').run(existing.id);
  return {
    ...existing,
    scopes: parseScopes(existing.scopes_json),
    scopes_json: undefined,
  };
}

function rotateApiKey(db, apiKeyId) {
  const rotate = db.transaction((id) => {
    const existing = db.prepare(`
      SELECT
        api_keys.*,
        users.username,
        users.disabled_at,
        users.password_hash IS NOT NULL AS has_password
      FROM api_keys
      JOIN users ON users.id = api_keys.user_id
      WHERE api_keys.id = ?
    `).get(id);

    if (!existing) throw new Error('API key not found');
    if (existing.revoked_at) throw new Error('API key is already revoked');
    if (existing.disabled_at || !existing.has_password) {
      throw new Error('Replacement keys can only be assigned to active dashboard users with passwords');
    }

    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), existing.id);
    const apiKey = createApiKey(db, {
      userId: existing.user_id,
      name: existing.name,
      scopes: parseScopes(existing.scopes_json),
      expiresAt: existing.expires_at,
    });

    return {
      revokedApiKeyId: existing.id,
      user: {
        id: existing.user_id,
        username: existing.username,
      },
      apiKey,
    };
  });

  return rotate(apiKeyId);
}

function listApiKeys(db) {
  return db.prepare(`
    SELECT
      api_keys.id,
      api_keys.user_id,
      users.username,
      api_keys.name,
      api_keys.key_prefix,
      api_keys.raw_key,
      api_keys.scopes_json,
      api_keys.created_at,
      api_keys.last_used_at,
      api_keys.expires_at,
      api_keys.revoked_at
    FROM api_keys
    JOIN users ON users.id = api_keys.user_id
    ORDER BY api_keys.created_at DESC
  `).all().map((row) => ({
    ...row,
    scopes: parseScopes(row.scopes_json),
    scopes_json: undefined,
  }));
}

function countActiveApiKeys(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE revoked_at IS NULL').get().count;
}

function createMinecraftAccount(db, {
  label,
  minecraftUuid,
  minecraftUsername,
  ownerUserId = null,
  notes = '',
}) {
  const cleanLabel = String(label || '').trim();
  const cleanUuid = String(minecraftUuid || '').trim();
  const cleanUsername = String(minecraftUsername || '').trim();
  if (!cleanLabel) throw new Error('Account label is required');
  if (!cleanUuid) throw new Error('Minecraft UUID is required');
  if (!cleanUsername) throw new Error('Minecraft username is required');

  const timestamp = nowIso();
  const result = db.prepare(`
    INSERT INTO minecraft_accounts (
      label,
      minecraft_uuid,
      minecraft_username,
      owner_user_id,
      status,
      notes,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(cleanLabel, cleanUuid, cleanUsername, ownerUserId, String(notes || ''), timestamp, timestamp);

  return publicMinecraftAccount(db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(result.lastInsertRowid));
}

function applyComputedAccountStatus(account, { now = Date.now(), heartbeatWindowMs = DEFAULT_ACCOUNT_HEARTBEAT_WINDOW_MS } = {}) {
  const foldered = applyBannedFolderState(account, { now });
  if (isActiveBan(account, new Date(now).toISOString())) {
    return foldered;
  }
  if (account.status === 'banned') {
    return {
      ...foldered,
      status: 'offline',
      ban_reason: null,
      banned_at: null,
      ban_until: null,
      ban_id: null,
      is_banned_foldered: 0,
      banned_folder_available_at: null,
    };
  }
  if (
    ['active', 'hypixel'].includes(account.status)
    && account.last_seen_at
    && now - Date.parse(account.last_seen_at) > heartbeatWindowMs
  ) {
    return { ...foldered, status: 'offline', current_user_id: null, current_username: null };
  }
  if (foldered.status === 'offline') {
    return { ...foldered, current_user_id: null, current_username: null };
  }
  return foldered;
}

function applyBannedFolderState(account, { now = Date.now() } = {}) {
  if (!account || account.status !== 'banned' || !account.banned_at) {
    return {
      ...account,
      is_banned_foldered: 0,
      banned_folder_available_at: null,
    };
  }
  const availableAtMs = Date.parse(account.banned_at) + BANNED_FOLDER_DELAY_MS;
  const availableAt = Number.isFinite(availableAtMs) ? new Date(availableAtMs).toISOString() : null;
  const isFoldered = Boolean(account.banned_foldered_at) || (availableAtMs <= now);
  return {
    ...account,
    is_banned_foldered: isFoldered ? 1 : 0,
    banned_folder_available_at: availableAt,
  };
}

function isActiveBan(account, timestamp = nowIso()) {
  return account
    && account.status === 'banned'
    && (!account.ban_until || account.ban_until > timestamp);
}

function cleanOptionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function publicMinecraftAccount(account) {
  if (!account) return account;
  const { proxy_password: proxyPassword, ...safeAccount } = account;
  return {
    ...safeAccount,
    proxy_has_password: proxyPassword ? 1 : 0,
  };
}

function safeNonNegativeInteger(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function nullableNonNegativeInteger(value) {
  if (value == null || value === '') return null;
  return safeNonNegativeInteger(value, 0);
}

function defaultMinecraftAccountStats(accountId) {
  return {
    minecraft_account_id: accountId,
    purse: null,
    fd_helmet_kills: null,
    fd_chestplate_kills: null,
    fd_leggings_kills: null,
    fd_boots_kills: null,
    summoning_eyes_held: 0,
    summoning_eyes_listed: 0,
    summoning_eye_list_price: 0,
    sold_auction_credit: 0,
    updated_at: null,
  };
}

function ensureMinecraftAccountStatsRow(db, accountId) {
  db.prepare(`
    INSERT INTO minecraft_account_stats (minecraft_account_id, updated_at)
    VALUES (?, ?)
    ON CONFLICT(minecraft_account_id) DO NOTHING
  `).run(accountId, nowIso());
}

function getMinecraftAccountStats(db, accountId) {
  const row = db.prepare('SELECT * FROM minecraft_account_stats WHERE minecraft_account_id = ?').get(accountId);
  return row || defaultMinecraftAccountStats(accountId);
}

function upsertMinecraftAccountStats(db, accountId, patch = {}) {
  const existing = getMinecraftAccountStats(db, accountId);
  const next = {
    purse: Object.prototype.hasOwnProperty.call(patch, 'purse')
      ? nullableNonNegativeInteger(patch.purse)
      : existing.purse,
    fd_helmet_kills: Object.prototype.hasOwnProperty.call(patch, 'fdHelmetKills')
      ? nullableNonNegativeInteger(patch.fdHelmetKills)
      : existing.fd_helmet_kills,
    fd_chestplate_kills: Object.prototype.hasOwnProperty.call(patch, 'fdChestplateKills')
      ? nullableNonNegativeInteger(patch.fdChestplateKills)
      : existing.fd_chestplate_kills,
    fd_leggings_kills: Object.prototype.hasOwnProperty.call(patch, 'fdLeggingsKills')
      ? nullableNonNegativeInteger(patch.fdLeggingsKills)
      : existing.fd_leggings_kills,
    fd_boots_kills: Object.prototype.hasOwnProperty.call(patch, 'fdBootsKills')
      ? nullableNonNegativeInteger(patch.fdBootsKills)
      : existing.fd_boots_kills,
    summoning_eyes_held: Object.prototype.hasOwnProperty.call(patch, 'summoningEyesHeld')
      ? safeNonNegativeInteger(patch.summoningEyesHeld)
      : existing.summoning_eyes_held,
    updated_at: nowIso(),
  };
  db.prepare(`
    INSERT INTO minecraft_account_stats (
      minecraft_account_id,
      purse,
      fd_helmet_kills,
      fd_chestplate_kills,
      fd_leggings_kills,
      fd_boots_kills,
      summoning_eyes_held,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(minecraft_account_id) DO UPDATE SET
      purse = excluded.purse,
      fd_helmet_kills = excluded.fd_helmet_kills,
      fd_chestplate_kills = excluded.fd_chestplate_kills,
      fd_leggings_kills = excluded.fd_leggings_kills,
      fd_boots_kills = excluded.fd_boots_kills,
      summoning_eyes_held = excluded.summoning_eyes_held,
      updated_at = excluded.updated_at
  `).run(
    accountId,
    next.purse,
    next.fd_helmet_kills,
    next.fd_chestplate_kills,
    next.fd_leggings_kills,
    next.fd_boots_kills,
    next.summoning_eyes_held,
    next.updated_at
  );
  return getMinecraftAccountStats(db, accountId);
}

function incrementSummoningEyes(db, accountId, delta) {
  const existing = getMinecraftAccountStats(db, accountId);
  const nextHeld = Math.max(0, safeNonNegativeInteger(existing.summoning_eyes_held) + Math.floor(Number(delta || 0)));
  ensureMinecraftAccountStatsRow(db, accountId);
  db.prepare(`
    UPDATE minecraft_account_stats
    SET summoning_eyes_held = ?, updated_at = ?
    WHERE minecraft_account_id = ?
  `).run(nextHeld, nowIso(), accountId);
  return getMinecraftAccountStats(db, accountId);
}

function moveSummoningEyesToListed(db, accountId, quantity, pricePerEye) {
  const existing = getMinecraftAccountStats(db, accountId);
  const moveQuantity = Math.min(safeNonNegativeInteger(quantity), safeNonNegativeInteger(existing.summoning_eyes_held));
  const nextHeld = safeNonNegativeInteger(existing.summoning_eyes_held) - moveQuantity;
  const nextListed = safeNonNegativeInteger(existing.summoning_eyes_listed) + moveQuantity;
  ensureMinecraftAccountStatsRow(db, accountId);
  db.prepare(`
    UPDATE minecraft_account_stats
    SET summoning_eyes_held = ?,
        summoning_eyes_listed = ?,
        summoning_eye_list_price = ?,
        updated_at = ?
    WHERE minecraft_account_id = ?
  `).run(nextHeld, nextListed, safeNonNegativeInteger(pricePerEye), nowIso(), accountId);
  return getMinecraftAccountStats(db, accountId);
}

function clearListedSummoningEyes(db, accountId, quantity = null) {
  const existing = getMinecraftAccountStats(db, accountId);
  const nextListed = quantity == null
    ? 0
    : Math.max(0, safeNonNegativeInteger(existing.summoning_eyes_listed) - safeNonNegativeInteger(quantity));
  ensureMinecraftAccountStatsRow(db, accountId);
  db.prepare(`
    UPDATE minecraft_account_stats
    SET summoning_eyes_listed = ?, updated_at = ?
    WHERE minecraft_account_id = ?
  `).run(nextListed, nowIso(), accountId);
  return getMinecraftAccountStats(db, accountId);
}

function moveListedSummoningEyesToHeld(db, accountId, quantity) {
  const existing = getMinecraftAccountStats(db, accountId);
  const moveQuantity = Math.min(safeNonNegativeInteger(quantity), safeNonNegativeInteger(existing.summoning_eyes_listed));
  const nextHeld = safeNonNegativeInteger(existing.summoning_eyes_held) + moveQuantity;
  const nextListed = safeNonNegativeInteger(existing.summoning_eyes_listed) - moveQuantity;
  ensureMinecraftAccountStatsRow(db, accountId);
  db.prepare(`
    UPDATE minecraft_account_stats
    SET summoning_eyes_held = ?,
        summoning_eyes_listed = ?,
        updated_at = ?
    WHERE minecraft_account_id = ?
  `).run(nextHeld, nextListed, nowIso(), accountId);
  return getMinecraftAccountStats(db, accountId);
}

function compactMinecraftUuid(value) {
  return String(value || '').replace(/-/g, '').trim().toLowerCase();
}

function cleanAuctionSnapshotId(auction) {
  return String(auction?.uuid || auction?.auction_uuid || auction?.id || '').trim();
}

function auctionEndMs(auction) {
  const number = Number(auction?.end ?? auction?.end_ms ?? auction?.endsAt);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function auctionPrice(auction) {
  return safeNonNegativeInteger(auction?.starting_bid ?? auction?.price ?? auction?.highest_bid_amount);
}

function reconcileMinecraftAccountAuctionSnapshots(db, accounts = [], activeAuctions = [], { nowMs = Date.now() } = {}) {
  const timestampMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const timestamp = new Date(timestampMs).toISOString();
  const accountByUuid = new Map();
  for (const account of accounts || []) {
    if (!account?.id) continue;
    accountByUuid.set(compactMinecraftUuid(account.minecraft_uuid), account.id);
  }
  const accountIds = Array.from(new Set(accountByUuid.values()));
  if (!accountIds.length) return { tracked: 0, sold: 0, expired: 0 };

  const activeSnapshotIds = new Set();
  let tracked = 0;
  for (const auction of activeAuctions || []) {
    const snapshotId = cleanAuctionSnapshotId(auction);
    const accountId = accountByUuid.get(compactMinecraftUuid(auction?.auctioneer));
    const endMs = auctionEndMs(auction);
    if (!snapshotId || !accountId || (endMs && endMs <= timestampMs)) continue;

    activeSnapshotIds.add(snapshotId);
    tracked += 1;
    ensureMinecraftAccountStatsRow(db, accountId);
    db.prepare(`
      INSERT INTO minecraft_account_auction_snapshots (
        auction_uuid,
        minecraft_account_id,
        price,
        end_ms,
        last_seen_at,
        state
      )
      VALUES (?, ?, ?, ?, ?, 'active')
      ON CONFLICT(auction_uuid) DO UPDATE SET
        minecraft_account_id = excluded.minecraft_account_id,
        price = excluded.price,
        end_ms = excluded.end_ms,
        last_seen_at = excluded.last_seen_at,
        state = 'active'
    `).run(snapshotId, accountId, auctionPrice(auction), endMs, timestamp);
  }

  const placeholders = accountIds.map(() => '?').join(', ');
  const activeSnapshots = db.prepare(`
    SELECT *
    FROM minecraft_account_auction_snapshots
    WHERE state = 'active'
      AND minecraft_account_id IN (${placeholders})
  `).all(...accountIds);

  let sold = 0;
  let expired = 0;
  for (const snapshot of activeSnapshots) {
    if (activeSnapshotIds.has(snapshot.auction_uuid)) continue;
    const state = snapshot.end_ms && timestampMs < snapshot.end_ms ? 'sold' : 'expired';
    if (state === 'sold') {
      ensureMinecraftAccountStatsRow(db, snapshot.minecraft_account_id);
      db.prepare(`
        UPDATE minecraft_account_stats
        SET sold_auction_credit = sold_auction_credit + ?,
            updated_at = ?
        WHERE minecraft_account_id = ?
      `).run(safeNonNegativeInteger(snapshot.price), timestamp, snapshot.minecraft_account_id);
      sold += 1;
    } else {
      expired += 1;
    }
    db.prepare(`
      UPDATE minecraft_account_auction_snapshots
      SET state = ?,
          last_seen_at = ?
      WHERE auction_uuid = ?
    `).run(state, timestamp, snapshot.auction_uuid);
  }

  return { tracked, sold, expired };
}

function normalizeProxyType(value) {
  const type = String(value || 'SOCKS5').trim().toUpperCase();
  if (!['SOCKS5', 'SOCKS4', 'HTTP'].includes(type)) {
    throw new Error('Invalid proxy type');
  }
  return type;
}

function normalizeProxyPort(value) {
  if (value == null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid proxy port');
  }
  return port;
}

function normalizeProxySettings(settings = {}, existing = {}) {
  const enabled = Boolean(settings.proxyEnabled);
  const type = normalizeProxyType(settings.proxyType || existing.proxy_type || 'SOCKS5');
  const host = cleanOptionalText(settings.proxyHost);
  const port = normalizeProxyPort(settings.proxyPort);
  const username = cleanOptionalText(settings.proxyUsername);
  const password = Object.prototype.hasOwnProperty.call(settings, 'proxyPassword')
    ? cleanOptionalText(settings.proxyPassword)
    : (existing.proxy_password || null);

  if (enabled && !host) {
    throw new Error('Proxy host is required when proxy is enabled');
  }
  if (enabled && !port) {
    throw new Error('Proxy port is required when proxy is enabled');
  }

  return {
    proxy_enabled: enabled ? 1 : 0,
    proxy_type: type,
    proxy_host: enabled ? host : null,
    proxy_port: enabled ? port : null,
    proxy_username: enabled ? username : null,
    proxy_password: enabled ? password : null,
  };
}

function normalizeFutureIso(value, timestamp) {
  const text = cleanOptionalText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  const iso = new Date(parsed).toISOString();
  return iso > timestamp ? iso : null;
}

function listMinecraftAccounts(db, options = {}) {
  return db.prepare(`
    SELECT
      minecraft_accounts.*,
      users.username AS owner_username,
      current_users.username AS current_username
    FROM minecraft_accounts
    LEFT JOIN users ON users.id = minecraft_accounts.owner_user_id
    LEFT JOIN users AS current_users ON current_users.id = minecraft_accounts.current_user_id
    ORDER BY minecraft_accounts.created_at DESC
  `).all().map((account) => publicMinecraftAccount(applyComputedAccountStatus(account, options)));
}

function normalizeMinecraftUuid(uuid) {
  const cleanUuid = String(uuid || '').replace(/-/g, '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(cleanUuid)) throw new Error('Invalid Minecraft UUID');
  return [
    cleanUuid.slice(0, 8),
    cleanUuid.slice(8, 12),
    cleanUuid.slice(12, 16),
    cleanUuid.slice(16, 20),
    cleanUuid.slice(20),
  ].join('-');
}

function upsertMinecraftAccountFromMod(db, {
  minecraftUuid,
  minecraftUsername,
  ownerUserId,
  clientVersion = null,
}) {
  const cleanUuid = normalizeMinecraftUuid(minecraftUuid);
  const cleanUsername = String(minecraftUsername || '').trim();
  if (!cleanUsername) throw new Error('Minecraft username is required');
  if (!ownerUserId) throw new Error('ownerUserId is required');

  const timestamp = nowIso();
  const existing = db.prepare('SELECT * FROM minecraft_accounts WHERE minecraft_uuid = ?').get(cleanUuid);
  if (existing) {
    const preserveBan = isActiveBan(existing, timestamp);
    const ownerToKeep = existing.owner_user_id || ownerUserId;
    db.prepare(`
      UPDATE minecraft_accounts
      SET label = ?,
          minecraft_username = ?,
          owner_user_id = ?,
          current_user_id = ?,
          status = ?,
          ban_reason = ?,
          banned_at = ?,
          ban_until = ?,
          ban_id = ?,
          banned_foldered_at = ?,
          last_connected_at = ?,
          last_seen_at = ?,
          client_version = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      cleanUsername,
      cleanUsername,
      ownerToKeep,
      preserveBan ? null : ownerUserId,
      preserveBan ? 'banned' : 'active',
      preserveBan ? existing.ban_reason : null,
      preserveBan ? existing.banned_at : null,
      preserveBan ? existing.ban_until : null,
      preserveBan ? existing.ban_id : null,
      preserveBan ? existing.banned_foldered_at : null,
      timestamp,
      timestamp,
      clientVersion,
      timestamp,
      existing.id
    );
    return publicMinecraftAccount(db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(existing.id));
  }

  const result = db.prepare(`
    INSERT INTO minecraft_accounts (
      label,
      minecraft_uuid,
      minecraft_username,
      owner_user_id,
      current_user_id,
      status,
      notes,
      last_connected_at,
      last_seen_at,
      client_version,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'active', '', ?, ?, ?, ?, ?)
  `).run(cleanUsername, cleanUuid, cleanUsername, ownerUserId, ownerUserId, timestamp, timestamp, clientVersion, timestamp, timestamp);

  return publicMinecraftAccount(db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(result.lastInsertRowid));
}

function recordMinecraftAccountHeartbeat(db, accountId, { now = null, currentUserId = null } = {}) {
  const timestamp = now || nowIso();
  const existing = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(accountId);
  const preserveBan = isActiveBan(existing, timestamp);
  const nextStatus = preserveBan ? 'banned' : (existing && existing.status === 'hypixel' ? 'hypixel' : 'active');
  db.prepare(`
    UPDATE minecraft_accounts
    SET last_seen_at = ?,
        status = ?,
        current_user_id = ?,
        ban_reason = ?,
        banned_at = ?,
        ban_until = ?,
        ban_id = ?,
        banned_foldered_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    timestamp,
    nextStatus,
    preserveBan ? null : (currentUserId || existing.current_user_id || null),
    preserveBan ? existing.ban_reason : null,
    preserveBan ? existing.banned_at : null,
    preserveBan ? existing.ban_until : null,
    preserveBan ? existing.ban_id : null,
    preserveBan ? existing.banned_foldered_at : null,
    timestamp,
    accountId
  );

  return publicMinecraftAccount(db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(accountId));
}

function recordMinecraftAccountConnectionStatus(db, accountId, status, ban = {}, { now = null, currentUserId = null } = {}) {
  const cleanStatus = String(status || '').trim().toLowerCase();
  if (!['active', 'hypixel', 'offline', 'banned'].includes(cleanStatus)) throw new Error('Invalid connection status');

  const timestamp = now || nowIso();
  const existing = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(accountId);
  if (!existing) return null;

  let nextStatus = cleanStatus;
  let banReason = null;
  let bannedAt = null;
  let banUntil = null;
  let banId = null;

  if (cleanStatus === 'banned') {
    nextStatus = 'banned';
    banReason = cleanOptionalText(ban.banReason) || existing.ban_reason || 'Detected by mod WebSocket status';
    bannedAt = existing.status === 'banned' && existing.banned_at ? existing.banned_at : timestamp;
    banUntil = normalizeFutureIso(ban.banUntil, timestamp) || existing.ban_until || null;
    banId = cleanOptionalText(ban.banId) || existing.ban_id || null;
  } else if (isActiveBan(existing, timestamp)) {
    nextStatus = 'banned';
    banReason = existing.ban_reason;
    bannedAt = existing.banned_at;
    banUntil = existing.ban_until;
    banId = existing.ban_id;
  }
  const nextCurrentUserId = ['active', 'hypixel'].includes(nextStatus)
    ? (currentUserId || existing.current_user_id || null)
    : null;

  db.prepare(`
    UPDATE minecraft_accounts
    SET last_seen_at = ?,
        status = ?,
        current_user_id = ?,
        ban_reason = ?,
        banned_at = ?,
        ban_until = ?,
        ban_id = ?,
        banned_foldered_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    timestamp,
    nextStatus,
    nextCurrentUserId,
    banReason,
    bannedAt,
    banUntil,
    banId,
    nextStatus === 'banned' ? existing.banned_foldered_at : null,
    timestamp,
    accountId
  );

  return publicMinecraftAccount(db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(accountId));
}

function updateMinecraftAccountProxy(db, accountId, settings = {}) {
  const existing = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(accountId);
  if (!existing) return null;
  const proxy = normalizeProxySettings(settings, existing);
  const timestamp = nowIso();

  db.prepare(`
    UPDATE minecraft_accounts
    SET proxy_enabled = ?,
        proxy_type = ?,
        proxy_host = ?,
        proxy_port = ?,
        proxy_username = ?,
        proxy_password = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    proxy.proxy_enabled,
    proxy.proxy_type,
    proxy.proxy_host,
    proxy.proxy_port,
    proxy.proxy_username,
    proxy.proxy_password,
    timestamp,
    accountId
  );

  return publicMinecraftAccount(db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(accountId));
}

function getMinecraftAccountProxyForOwner(db, {
  ownerUserId,
  minecraftUuid = null,
  minecraftUsername = null,
}) {
  if (!ownerUserId) throw new Error('ownerUserId is required');
  let account = null;
  if (minecraftUuid) {
    account = db.prepare(`
      SELECT * FROM minecraft_accounts
      WHERE minecraft_uuid = ?
    `).get(normalizeMinecraftUuid(minecraftUuid));
  }
  if (!account && minecraftUsername) {
    account = db.prepare(`
      SELECT * FROM minecraft_accounts
      WHERE lower(minecraft_username) = lower(?)
    `).get(String(minecraftUsername || '').trim());
  }
  if (!account) return null;

  return {
    accountId: account.id,
    minecraftUuid: account.minecraft_uuid,
    minecraftUsername: account.minecraft_username,
    enabled: Boolean(account.proxy_enabled),
    type: account.proxy_type || 'SOCKS5',
    host: account.proxy_host,
    port: account.proxy_port,
    username: account.proxy_username || '',
    password: account.proxy_password || '',
  };
}

function updateMinecraftAccountStatus(db, accountId, { status, banReason = null, banUntil = null, banId = null }) {
  const allowedStatuses = new Set(['active', 'hypixel', 'offline', 'locked', 'banned']);
  const cleanStatus = String(status || '').trim().toLowerCase();
  if (!allowedStatuses.has(cleanStatus)) throw new Error('Invalid account status');

  const timestamp = nowIso();
  const bannedAt = cleanStatus === 'banned' ? timestamp : null;
  db.prepare(`
    UPDATE minecraft_accounts
    SET status = ?, ban_reason = ?, banned_at = ?, ban_until = ?, ban_id = ?, banned_foldered_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    cleanStatus,
    cleanStatus === 'banned' ? cleanOptionalText(banReason) : null,
    bannedAt,
    cleanStatus === 'banned' ? normalizeFutureIso(banUntil, timestamp) : null,
    cleanStatus === 'banned' ? cleanOptionalText(banId) : null,
    null,
    timestamp,
    accountId
  );
}

function markMinecraftAccountBannedFoldered(db, accountId, { now = null } = {}) {
  const timestamp = now || nowIso();
  db.prepare(`
    UPDATE minecraft_accounts
    SET banned_foldered_at = ?, updated_at = ?
    WHERE id = ? AND status = 'banned'
  `).run(timestamp, timestamp, accountId);
  const account = db.prepare(`
    SELECT
      minecraft_accounts.*,
      users.username AS owner_username,
      current_users.username AS current_username
    FROM minecraft_accounts
    LEFT JOIN users ON users.id = minecraft_accounts.owner_user_id
    LEFT JOIN users AS current_users ON current_users.id = minecraft_accounts.current_user_id
    WHERE minecraft_accounts.id = ?
  `).get(accountId);
  return account ? publicMinecraftAccount(applyComputedAccountStatus(account, { now: Date.parse(timestamp) })) : null;
}

function deleteMinecraftAccount(db, accountId) {
  db.prepare('DELETE FROM minecraft_accounts WHERE id = ?').run(accountId);
}

function writeAuditLog(db, {
  userId = null,
  apiKeyId = null,
  action,
  ip = null,
  userAgent = null,
  metadata = {},
}) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, api_key_id, action, ip, user_agent, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, apiKeyId, action, ip, userAgent, JSON.stringify(metadata || {}), nowIso());
}

module.exports = {
  createDatabase,
  migrateDatabase,
  createUser,
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
  createApiKey,
  authenticateApiKey,
  revokeApiKey,
  deleteApiKey,
  rotateApiKey,
  listApiKeys,
  countActiveApiKeys,
  createMinecraftAccount,
  listMinecraftAccounts,
  upsertMinecraftAccountFromMod,
  getMinecraftAccountStats,
  upsertMinecraftAccountStats,
  incrementSummoningEyes,
  moveSummoningEyesToListed,
  clearListedSummoningEyes,
  moveListedSummoningEyesToHeld,
  reconcileMinecraftAccountAuctionSnapshots,
  recordMinecraftAccountHeartbeat,
  recordMinecraftAccountConnectionStatus,
  updateMinecraftAccountProxy,
  getMinecraftAccountProxyForOwner,
  updateMinecraftAccountStatus,
  markMinecraftAccountBannedFoldered,
  deleteMinecraftAccount,
  writeAuditLog,
};
