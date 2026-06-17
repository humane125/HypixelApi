const assert = require('assert');

const {
  createDatabase,
  createUser,
  createApiKey,
  authenticateApiKey,
  revokeApiKey,
  createMinecraftAccount,
  listMinecraftAccounts,
  recordMinecraftAccountConnectionStatus,
  updateMinecraftAccountProxy,
  getMinecraftAccountProxyForOwner,
  updateMinecraftAccountStatus,
  markMinecraftAccountBannedFoldered,
  deleteMinecraftAccount,
  setUserPassword,
  authenticateUserPassword,
  createDashboardSession,
  authenticateDashboardSession,
  revokeDashboardSession,
  listDashboardUsers,
  updateUserRole,
  deleteDashboardUser,
} = require('../auth-db');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

test('api keys are stored hashed and authenticate with scopes', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'owner', role: 'owner' });
  const issued = createApiKey(db, {
    userId: user.id,
    name: 'owner laptop',
    scopes: ['admin', 'auction:read', 'accounts:write'],
    rawKey: 'hpx_test_owner_secret',
  });

  assert.strictEqual(issued.rawKey, 'hpx_test_owner_secret');
  assert.strictEqual(issued.prefix, 'hpx_test_ow');

  const stored = db.prepare('SELECT key_hash, key_prefix FROM api_keys WHERE id = ?').get(issued.id);
  assert.notStrictEqual(stored.key_hash, 'hpx_test_owner_secret');
  assert.strictEqual(stored.key_prefix, 'hpx_test_ow');

  const auth = authenticateApiKey(db, 'hpx_test_owner_secret');
  assert.strictEqual(auth.user.username, 'owner');
  assert.strictEqual(auth.user.role, 'owner');
  assert.deepStrictEqual(auth.apiKey.scopes, ['admin', 'auction:read', 'accounts:write']);
});

test('revoked and invalid api keys cannot authenticate', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'friend', role: 'user' });
  const issued = createApiKey(db, {
    userId: user.id,
    name: 'friend mod',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_friend_secret',
  });

  assert.strictEqual(authenticateApiKey(db, 'wrong-key'), null);
  revokeApiKey(db, issued.id);
  assert.strictEqual(authenticateApiKey(db, 'hpx_test_friend_secret'), null);
});

test('minecraft accounts can be created, listed, and marked banned', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'owner', role: 'owner' });
  const account = createMinecraftAccount(db, {
    label: 'Main RDP account',
    minecraftUuid: '00000000-0000-0000-0000-000000000001',
    minecraftUsername: 'PlayerOne',
    ownerUserId: user.id,
    notes: 'primary test account',
  });

  assert.strictEqual(account.status, 'active');

  updateMinecraftAccountStatus(db, account.id, {
    status: 'banned',
    banReason: 'Detected ban screen',
  });

  const accounts = listMinecraftAccounts(db);
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].minecraft_username, 'PlayerOne');
  assert.strictEqual(accounts[0].status, 'banned');
  assert.strictEqual(accounts[0].ban_reason, 'Detected ban screen');
});

test('mod connection statuses support hypixel and preserve banned accounts', () => {
	const db = createDatabase(':memory:');
	const user = createUser(db, { username: 'owner', role: 'owner' });
	const account = createMinecraftAccount(db, {
    label: 'Hypixel account',
    minecraftUuid: '00000000-0000-0000-0000-000000000006',
    minecraftUsername: 'HypixelPlayer',
    ownerUserId: user.id,
  });

  const hypixel = recordMinecraftAccountConnectionStatus(db, account.id, 'hypixel');
  assert.strictEqual(hypixel.status, 'hypixel');

	const banned = recordMinecraftAccountConnectionStatus(db, account.id, 'banned');
	assert.strictEqual(banned.status, 'banned');

	const stillBanned = recordMinecraftAccountConnectionStatus(db, account.id, 'offline');
	assert.strictEqual(stillBanned.status, 'banned');
});

test('timed mod bans store metadata and clear from listed accounts after expiry', () => {
	const db = createDatabase(':memory:');
	const user = createUser(db, { username: 'owner', role: 'owner' });
	const account = createMinecraftAccount(db, {
		label: 'Timed ban account',
		minecraftUuid: '00000000-0000-0000-0000-000000000016',
		minecraftUsername: 'TimedBanPlayer',
		ownerUserId: user.id,
	});

	const banned = recordMinecraftAccountConnectionStatus(db, account.id, 'banned', {
		banReason: 'Cheating through the use of unfair game advantages.',
		banId: '#01346337',
		banUntil: '2026-06-16T15:00:00.000Z',
	}, { now: '2026-06-15T15:00:00.000Z' });
	assert.strictEqual(banned.status, 'banned');
	assert.strictEqual(banned.ban_reason, 'Cheating through the use of unfair game advantages.');
	assert.strictEqual(banned.ban_id, '#01346337');
	assert.strictEqual(banned.ban_until, '2026-06-16T15:00:00.000Z');

	const activeOverwrite = recordMinecraftAccountConnectionStatus(db, account.id, 'active', {}, { now: '2026-06-15T15:01:00.000Z' });
	assert.strictEqual(activeOverwrite.status, 'banned');

	const listedDuringBan = listMinecraftAccounts(db, { now: Date.parse('2026-06-15T15:02:00.000Z') });
	assert.strictEqual(listedDuringBan[0].status, 'banned');
	assert.strictEqual(listedDuringBan[0].ban_until, '2026-06-16T15:00:00.000Z');

	const listedAfterBan = listMinecraftAccounts(db, { now: Date.parse('2026-06-16T15:00:01.000Z') });
	assert.strictEqual(listedAfterBan[0].status, 'offline');
	assert.strictEqual(listedAfterBan[0].ban_reason, null);
	assert.strictEqual(listedAfterBan[0].ban_id, null);
	assert.strictEqual(listedAfterBan[0].ban_until, null);
});

test('minecraft account proxy settings are listed without passwords', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'owner', role: 'owner' });
  const account = createMinecraftAccount(db, {
    label: 'Proxy account',
    minecraftUuid: '00000000-0000-0000-0000-000000000041',
    minecraftUsername: 'ProxyPlayer',
    ownerUserId: user.id,
  });

  const updated = updateMinecraftAccountProxy(db, account.id, {
    proxyEnabled: true,
    proxyType: 'socks5',
    proxyHost: 'proxy.example.com',
    proxyPort: '1080',
    proxyUsername: 'proxy-user',
    proxyPassword: 'secret-pass',
  });

  assert.strictEqual(updated.proxy_enabled, 1);
  assert.strictEqual(updated.proxy_type, 'SOCKS5');
  assert.strictEqual(updated.proxy_host, 'proxy.example.com');
  assert.strictEqual(updated.proxy_port, 1080);
  assert.strictEqual(updated.proxy_username, 'proxy-user');
  assert.strictEqual(updated.proxy_has_password, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updated, 'proxy_password'), false);

  const listed = listMinecraftAccounts(db)[0];
  assert.strictEqual(listed.proxy_enabled, 1);
  assert.strictEqual(listed.proxy_type, 'SOCKS5');
  assert.strictEqual(listed.proxy_host, 'proxy.example.com');
  assert.strictEqual(listed.proxy_port, 1080);
  assert.strictEqual(listed.proxy_username, 'proxy-user');
  assert.strictEqual(listed.proxy_has_password, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(listed, 'proxy_password'), false);
});

test('mod proxy lookup is owner scoped and includes the saved password', () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  const other = createUser(db, { username: 'other', role: 'manager' });
  const account = createMinecraftAccount(db, {
    label: 'Proxy lookup account',
    minecraftUuid: '00000000-0000-0000-0000-000000000042',
    minecraftUsername: 'LookupProxyPlayer',
    ownerUserId: owner.id,
  });

  updateMinecraftAccountProxy(db, account.id, {
    proxyEnabled: true,
    proxyType: 'SOCKS5',
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
    proxyUsername: 'local-user',
    proxyPassword: 'local-pass',
  });

  const proxy = getMinecraftAccountProxyForOwner(db, {
    ownerUserId: owner.id,
    minecraftUuid: '00000000000000000000000000000042',
  });
  assert.deepStrictEqual(proxy, {
    accountId: account.id,
    minecraftUuid: '00000000-0000-0000-0000-000000000042',
    minecraftUsername: 'LookupProxyPlayer',
    enabled: true,
    type: 'SOCKS5',
    host: '127.0.0.1',
    port: 1080,
    username: 'local-user',
    password: 'local-pass',
  });

  assert.strictEqual(getMinecraftAccountProxyForOwner(db, {
    ownerUserId: other.id,
    minecraftUsername: 'LookupProxyPlayer',
  }), null);
});

test('banned accounts are foldered after 8 hours or manual move', () => {
	const db = createDatabase(':memory:');
	const user = createUser(db, { username: 'owner', role: 'owner' });
	const account = createMinecraftAccount(db, {
		label: 'Foldered ban account',
		minecraftUuid: '00000000-0000-0000-0000-000000000026',
		minecraftUsername: 'FolderedBanPlayer',
		ownerUserId: user.id,
	});

	recordMinecraftAccountConnectionStatus(db, account.id, 'banned', {
		banReason: 'Cheating',
	}, { now: '2026-06-16T00:00:00.000Z' });

	const early = listMinecraftAccounts(db, { now: Date.parse('2026-06-16T07:59:59.000Z') })[0];
	assert.strictEqual(early.is_banned_foldered, 0);
	assert.strictEqual(early.banned_folder_available_at, '2026-06-16T08:00:00.000Z');

	const late = listMinecraftAccounts(db, { now: Date.parse('2026-06-16T08:00:00.000Z') })[0];
	assert.strictEqual(late.is_banned_foldered, 1);

	markMinecraftAccountBannedFoldered(db, account.id, { now: '2026-06-16T02:00:00.000Z' });
	const manual = listMinecraftAccounts(db, { now: Date.parse('2026-06-16T02:00:01.000Z') })[0];
	assert.strictEqual(manual.is_banned_foldered, 1);
	assert.strictEqual(manual.banned_foldered_at, '2026-06-16T02:00:00.000Z');
});

test('minecraft accounts can be deleted', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'owner', role: 'owner' });
  const account = createMinecraftAccount(db, {
    label: 'Delete me',
    minecraftUuid: '00000000-0000-0000-0000-000000000004',
    minecraftUsername: 'DeleteMe',
    ownerUserId: user.id,
  });

  deleteMinecraftAccount(db, account.id);

  assert.strictEqual(listMinecraftAccounts(db).length, 0);
});

test('users authenticate with hashed dashboard passwords', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'owner', role: 'owner' });

  setUserPassword(db, user.id, 'correct horse battery staple');

  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  assert.ok(stored.password_hash);
  assert.ok(!stored.password_hash.includes('correct horse battery staple'));

  const auth = authenticateUserPassword(db, 'owner', 'correct horse battery staple');
  assert.strictEqual(auth.username, 'owner');
  assert.strictEqual(auth.role, 'owner');
  assert.strictEqual(authenticateUserPassword(db, 'owner', 'wrong-password'), null);
});

test('dashboard sessions authenticate and can be revoked', () => {
  const db = createDatabase(':memory:');
  const user = createUser(db, { username: 'owner', role: 'owner' });
  const session = createDashboardSession(db, user.id, {
    rawToken: 'dash_test_session_secret',
  });

  assert.strictEqual(session.rawToken, 'dash_test_session_secret');
  const stored = db.prepare('SELECT token_hash FROM dashboard_sessions WHERE id = ?').get(session.id);
  assert.notStrictEqual(stored.token_hash, 'dash_test_session_secret');

  const auth = authenticateDashboardSession(db, 'dash_test_session_secret');
  assert.strictEqual(auth.user.username, 'owner');

  revokeDashboardSession(db, 'dash_test_session_secret');
  assert.strictEqual(authenticateDashboardSession(db, 'dash_test_session_secret'), null);
});

test('dashboard users can be listed and roles can be updated', () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  const friend = createUser(db, { username: 'friend', role: 'viewer' });
  setUserPassword(db, friend.id, 'friend-password');

  updateUserRole(db, friend.id, 'manager');

  const users = listDashboardUsers(db);
  assert.deepStrictEqual(users.map((user) => ({
    username: user.username,
    role: user.role,
    has_password: user.has_password,
  })), [
    { username: 'owner', role: 'owner', has_password: 1 },
    { username: 'friend', role: 'manager', has_password: 1 },
  ]);
});

test('dashboard users can be deleted', () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  const friend = createUser(db, { username: 'friend', role: 'viewer' });
  setUserPassword(db, friend.id, 'friend-password');

  deleteDashboardUser(db, friend.id);

  assert.deepStrictEqual(listDashboardUsers(db).map((user) => user.username), ['owner']);
});
