const assert = require('assert');

const {
  createDatabase,
  createUser,
  createApiKey,
  authenticateApiKey,
  revokeApiKey,
  createMinecraftAccount,
  listMinecraftAccounts,
  updateMinecraftAccountStatus,
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
