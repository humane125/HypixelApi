const assert = require('assert');
const WebSocket = require('ws');

const { createDatabase, createUser, createApiKey, setUserPassword } = require('../auth-db');
const { createAppServer, createAuctionIndexService } = require('../server');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((err) => {
      console.error(`not ok - ${name}`);
      process.nextTick(() => {
        throw err;
      });
    });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (err) {
        reject(err);
      }
    });
    socket.once('error', reject);
  });
}

function closeSocketSilently(socket) {
  socket.removeAllListeners('error');
  socket.on('error', () => {});
  socket.close();
}

async function waitForSocketMessageMatching(socket, predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      reject(new Error('Timed out waiting for matching socket message'));
    }, timeoutMs);
    const onError = (err) => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      reject(err);
    };
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        clearTimeout(timeout);
        socket.off('error', onError);
        reject(err);
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('error', onError);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
  });
}

function createTestServer() {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  const ownerKey = createApiKey(db, {
    userId: owner.id,
    name: 'owner key',
    scopes: ['admin', 'auction:read', 'accounts:read', 'accounts:write'],
    rawKey: 'hpx_test_owner_http',
  });
  const auctionIndex = {
    ensureFresh: async () => ({ source: 'cache', status: { ready: true } }),
    refresh: async () => ({ source: 'cache', status: { ready: true } }),
    getStatus: () => ({ ready: true }),
    getItems: () => [],
  };
  const server = createAppServer({ db, auctionIndex, fetchImpl: async () => ({ ok: false }) });
  return { db, owner, ownerKey, server };
}

function createTestServerWithOptions(options = {}) {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  const ownerKey = createApiKey(db, {
    userId: owner.id,
    name: 'owner key',
    scopes: ['admin', 'auction:read', 'accounts:read', 'accounts:write'],
    rawKey: 'hpx_test_owner_http',
  });
  const auctionIndex = {
    ensureFresh: async (sendEvent) => {
      if (sendEvent) sendEvent('done', { source: 'cache', status: { ready: true } });
      return { source: 'cache', status: { ready: true } };
    },
    refresh: async () => ({ source: 'cache', status: { ready: true } }),
    getStatus: () => ({ ready: true }),
    getItems: () => [],
  };
  const server = createAppServer({
    db,
    auctionIndex,
    fetchImpl: async () => ({ ok: false }),
    ...options,
  });
  return { db, owner, ownerKey, server };
}

test('mod websocket authenticates api keys with mod connect scope and registers account', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_socket',
  });
  const server = createAppServer({
    db,
    fetchImpl: async (requestUrl) => {
      assert.strictEqual(String(requestUrl), 'https://api.mojang.com/users/profiles/minecraft/SocketPlayer');
      return {
        ok: true,
        json: async () => ({
          id: '00000000000000000000000000000011',
          name: 'SocketPlayer',
        }),
      };
    },
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_socket',
      username: 'SocketPlayer',
      clientVersion: '26.1.1',
    }));

    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');
    assert.strictEqual(authed.account.minecraft_username, 'SocketPlayer');

    socket.send(JSON.stringify({ type: 'heartbeat' }));
    const heartbeat = await waitForSocketMessage(socket);
    assert.strictEqual(heartbeat.type, 'heartbeat_ok');

    const account = db.prepare('SELECT * FROM minecraft_accounts WHERE minecraft_username = ?').get('SocketPlayer');
    assert.ok(account);
    assert.strictEqual(account.owner_user_id, owner.id);
    assert.strictEqual(account.minecraft_uuid, '00000000-0000-0000-0000-000000000011');
    assert.strictEqual(account.status, 'active');
    assert.strictEqual(account.client_version, '26.1.1');
    assert.ok(account.last_connected_at);
    assert.ok(account.last_seen_at);
  } finally {
    socket.close();
    await close(server);
  }
});

test('mod websocket rejects api keys without mod connect scope', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'auction key',
    scopes: ['auction:read'],
    rawKey: 'hpx_test_auction_only',
  });
  const server = createAppServer({ db });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_auction_only',
      username: 'SocketPlayer',
    }));
    const denied = await waitForSocketMessage(socket);
    assert.strictEqual(denied.type, 'error');
    assert.strictEqual(denied.code, 'forbidden');
  } finally {
    socket.close();
    await close(server);
  }
});

test('mod websocket accepts active and offline status messages', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_status_socket',
  });
  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000013',
        name: 'StatusPlayer',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_status_socket',
      username: 'StatusPlayer',
    }));
    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');

    socket.send(JSON.stringify({ type: 'active' }));
    const active = await waitForSocketMessage(socket);
    assert.strictEqual(active.type, 'status_ok');
    assert.strictEqual(active.status, 'active');

    socket.send(JSON.stringify({ type: 'offline' }));
    const offline = await waitForSocketMessage(socket);
    assert.strictEqual(offline.type, 'status_ok');
    assert.strictEqual(offline.status, 'offline');

    const account = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(authed.account.id);
    assert.strictEqual(account.status, 'offline');
  } finally {
    socket.close();
    await close(server);
  }
});

test('mod websocket accepts hypixel and banned status messages', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_hypixel_socket',
  });
  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000015',
        name: 'HypixelStatusPlayer',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_hypixel_socket',
      username: 'HypixelStatusPlayer',
    }));
    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');

    socket.send(JSON.stringify({ type: 'hypixel' }));
    const hypixel = await waitForSocketMessage(socket);
    assert.strictEqual(hypixel.type, 'status_ok');
    assert.strictEqual(hypixel.status, 'hypixel');

    socket.send(JSON.stringify({
      type: 'banned',
      banReason: 'Cheating through the use of unfair game advantages.',
      banId: '#01346337',
      banUntil: '2026-06-16T15:00:00.000Z',
    }));
    const banned = await waitForSocketMessage(socket);
    assert.strictEqual(banned.type, 'status_ok');
    assert.strictEqual(banned.status, 'banned');
    assert.strictEqual(banned.account.ban_reason, 'Cheating through the use of unfair game advantages.');
    assert.strictEqual(banned.account.ban_id, '#01346337');
    assert.strictEqual(banned.account.ban_until, '2026-06-16T15:00:00.000Z');

    socket.send(JSON.stringify({ type: 'offline' }));
    const offline = await waitForSocketMessage(socket);
    assert.strictEqual(offline.type, 'status_ok');
    assert.strictEqual(offline.status, 'banned');

    const account = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(authed.account.id);
    assert.strictEqual(account.status, 'banned');
    assert.strictEqual(account.ban_reason, 'Cheating through the use of unfair game advantages.');
    assert.strictEqual(account.ban_id, '#01346337');
    assert.strictEqual(account.ban_until, '2026-06-16T15:00:00.000Z');
  } finally {
    socket.close();
    await close(server);
  }
});

test('dashboard websocket pushes account status changes from mod websocket', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_dashboard_live',
  });
  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000014',
        name: 'LivePlayer',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const dashboardSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/dashboard/ws', {
    headers: { Cookie: await loginDashboard(baseUrl) },
  });
  const modSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    const initialPromise = waitForSocketMessage(dashboardSocket);
    await waitForSocketOpen(dashboardSocket);
    const initial = await initialPromise;
    assert.strictEqual(initial.type, 'accounts');
    assert.deepStrictEqual(initial.accounts, []);

    await waitForSocketOpen(modSocket);
    modSocket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_dashboard_live',
      username: 'LivePlayer',
    }));
    const authed = await waitForSocketMessage(modSocket);
    assert.strictEqual(authed.type, 'auth_ok');

    const pushedPromise = waitForSocketMessageMatching(dashboardSocket, (message) => (
      message.type === 'accounts'
      && message.accounts.some((account) => (
        account.minecraft_username === 'LivePlayer'
        && account.status === 'offline'
      ))
    ));
    modSocket.send(JSON.stringify({ type: 'offline' }));
    const offline = await waitForSocketMessage(modSocket);
    assert.strictEqual(offline.type, 'status_ok');
    assert.strictEqual(offline.status, 'offline');

    const pushed = await pushedPromise;
    const account = pushed.accounts.find((row) => row.minecraft_username === 'LivePlayer');
    assert.strictEqual(account.status, 'offline');
  } finally {
    closeSocketSilently(dashboardSocket);
    closeSocketSilently(modSocket);
    await close(server);
  }
});

test('dashboard account list marks stale heartbeat accounts offline', async () => {
  const { db, server } = createTestServerWithOptions({
    accountHeartbeatWindowMs: 30_000,
  });
  const baseUrl = await listen(server);
  try {
    const cookie = await loginDashboard(baseUrl);
    const stale = new Date(Date.now() - 120_000).toISOString();
    db.prepare(`
      INSERT INTO minecraft_accounts (
        label,
        minecraft_uuid,
        minecraft_username,
        owner_user_id,
        status,
        notes,
        last_seen_at,
        last_connected_at,
        created_at,
        updated_at
      )
      VALUES ('Stale', '00000000-0000-0000-0000-000000000012', 'StalePlayer', 1, 'active', '', ?, ?, ?, ?)
    `).run(stale, stale, stale, stale);

    const listed = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: cookie },
    });
    assert.strictEqual(listed.status, 200);
    const account = (await listed.json()).accounts.find((row) => row.minecraft_username === 'StalePlayer');
    assert.strictEqual(account.status, 'offline');
  } finally {
    await close(server);
  }
});

async function loginDashboard(baseUrl, username = 'owner', password = 'owner-password') {
  const login = await fetch(`${baseUrl}/api/dashboard/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.strictEqual(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie.includes('dashboard_session='));
  return cookie;
}

test('dashboard login throttles repeated failed password attempts', async () => {
  const { server } = createTestServerWithOptions({
    loginRateLimit: {
      maxFailures: 2,
      windowMs: 60_000,
      lockMs: 60_000,
    },
  });
  const baseUrl = await listen(server);
  try {
    for (let i = 0; i < 2; i++) {
      const failed = await fetch(`${baseUrl}/api/dashboard/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'wrong-password' }),
      });
      assert.strictEqual(failed.status, 401);
    }

    const throttled = await fetch(`${baseUrl}/api/dashboard/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'wrong-password' }),
    });
    assert.strictEqual(throttled.status, 429);
  } finally {
    await close(server);
  }
});

test('secure dashboard cookie mode adds Secure to session cookies', async () => {
  const { server } = createTestServerWithOptions({ secureCookies: true });
  const baseUrl = await listen(server);
  try {
    const cookie = await loginDashboard(baseUrl);
    assert.ok(cookie.includes('Secure'));
  } finally {
    await close(server);
  }
});

test('query api tokens are limited to event stream endpoints', async () => {
  const { server } = createTestServerWithOptions();
  const baseUrl = await listen(server);
  try {
    const jsonDenied = await fetch(`${baseUrl}/api/index/status?token=hpx_test_owner_http`);
    assert.strictEqual(jsonDenied.status, 401);

    const streamAllowed = await fetch(`${baseUrl}/api/index/refresh?token=hpx_test_owner_http`);
    assert.strictEqual(streamAllowed.status, 200);
    assert.ok((await streamAllowed.text()).includes('"type":"done"'));
  } finally {
    await close(server);
  }
});

test('protected api endpoints reject missing api key and accept bearer api key', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const denied = await fetch(`${baseUrl}/api/index/status`);
    assert.strictEqual(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/api/index/status`, {
      headers: { Authorization: 'Bearer hpx_test_owner_http' },
    });
    assert.strictEqual(allowed.status, 200);
    assert.deepStrictEqual(await allowed.json(), { ready: true });
  } finally {
    await close(server);
  }
});

test('username lookup is protected by database api keys', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const denied = await fetch(`${baseUrl}/api/usernames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['uuid']),
    });
    assert.strictEqual(denied.status, 401);
  } finally {
    await close(server);
  }
});

test('dashboard account endpoints create and list registered minecraft accounts', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const cookie = await loginDashboard(baseUrl);

    const created = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        label: 'RDP Main',
        minecraftUuid: '00000000-0000-0000-0000-000000000001',
        minecraftUsername: 'PlayerOne',
        notes: 'first account',
      }),
    });
    assert.strictEqual(created.status, 201);

    const listed = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: cookie },
    });
    assert.strictEqual(listed.status, 200);
    const body = await listed.json();
    assert.strictEqual(body.accounts.length, 1);
    assert.strictEqual(body.accounts[0].minecraft_username, 'PlayerOne');
  } finally {
    await close(server);
  }
});

test('admin can issue a new api key for an existing dashboard user and only the raw key authenticates', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const cookie = await loginDashboard(baseUrl);
    const createdUser = await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        username: 'friend',
        password: 'friend-password',
        role: 'viewer',
      }),
    });
    assert.strictEqual(createdUser.status, 201);
    const user = (await createdUser.json()).user;

    const issued = await fetch(`${baseUrl}/api/dashboard/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        userId: user.id,
        name: 'friend mod',
        scopes: ['auction:read'],
      }),
    });
    assert.strictEqual(issued.status, 201);
    const body = await issued.json();
    assert.ok(body.apiKey.rawKey.startsWith('hpx_live_'));
    assert.ok(!body.apiKey.key_hash);

    const allowed = await fetch(`${baseUrl}/api/index/status`, {
      headers: { Authorization: `Bearer ${body.apiKey.rawKey}` },
    });
    assert.strictEqual(allowed.status, 200);
  } finally {
    await close(server);
  }
});

test('admin cannot issue api key for arbitrary typed username', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const cookie = await loginDashboard(baseUrl);
    const issued = await fetch(`${baseUrl}/api/dashboard/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        username: 'not-a-dashboard-user',
        name: 'bad key',
        scopes: ['auction:read'],
      }),
    });
    assert.strictEqual(issued.status, 400);
  } finally {
    await close(server);
  }
});

test('admin cannot issue api key for user without dashboard password', async () => {
  const { db, server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const apiOnlyUser = createUser(db, { username: 'api-only', role: 'viewer' });
    const cookie = await loginDashboard(baseUrl);
    const issued = await fetch(`${baseUrl}/api/dashboard/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        userId: apiOnlyUser.id,
        name: 'bad key',
        scopes: ['auction:read'],
      }),
    });
    assert.strictEqual(issued.status, 400);
  } finally {
    await close(server);
  }
});

test('dashboard endpoints reject api keys without a dashboard session', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const denied = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Authorization: 'Bearer hpx_test_owner_http' },
    });
    assert.strictEqual(denied.status, 401);
  } finally {
    await close(server);
  }
});

test('bootstrap token seeds the first owner api key', async () => {
  const db = createDatabase(':memory:');
  const auctionIndex = {
    ensureFresh: async () => ({ source: 'cache', status: { ready: true } }),
    refresh: async () => ({ source: 'cache', status: { ready: true } }),
    getStatus: () => ({ ready: true }),
    getItems: () => [],
  };
  const server = createAppServer({
    db,
    auctionIndex,
    bootstrapToken: 'hpx_test_bootstrap_owner',
    fetchImpl: async () => ({ ok: false }),
  });
  const baseUrl = await listen(server);
  try {
    const allowed = await fetch(`${baseUrl}/api/index/status`, {
      headers: { Authorization: 'Bearer hpx_test_bootstrap_owner' },
    });
    assert.strictEqual(allowed.status, 200);
  } finally {
    await close(server);
  }
});

test('owner can create dashboard users and assign roles', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const ownerCookie = await loginDashboard(baseUrl);
    const created = await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'manager',
        password: 'manager-password',
        role: 'manager',
      }),
    });
    assert.strictEqual(created.status, 201);

    const listed = await fetch(`${baseUrl}/api/dashboard/users`, {
      headers: { Cookie: ownerCookie },
    });
    assert.strictEqual(listed.status, 200);
    const body = await listed.json();
    assert.ok(body.users.some((user) => user.username === 'manager' && user.role === 'manager'));

    const roleUpdate = await fetch(`${baseUrl}/api/dashboard/users/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        userId: body.users.find((user) => user.username === 'manager').id,
        role: 'viewer',
      }),
    });
    assert.strictEqual(roleUpdate.status, 200);
  } finally {
    await close(server);
  }
});

test('manager can create minecraft accounts but viewer cannot', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const ownerCookie = await loginDashboard(baseUrl);
    await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'manager',
        password: 'manager-password',
        role: 'manager',
      }),
    });
    await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'viewer',
        password: 'viewer-password',
        role: 'viewer',
      }),
    });

    const managerCookie = await loginDashboard(baseUrl, 'manager', 'manager-password');
    const viewerCookie = await loginDashboard(baseUrl, 'viewer', 'viewer-password');

    const managerCreate = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: managerCookie,
      },
      body: JSON.stringify({
        label: 'Manager Account',
        minecraftUuid: '00000000-0000-0000-0000-000000000002',
        minecraftUsername: 'PlayerTwo',
      }),
    });
    assert.strictEqual(managerCreate.status, 201);

    const viewerCreate = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: viewerCookie,
      },
      body: JSON.stringify({
        label: 'Viewer Account',
        minecraftUuid: '00000000-0000-0000-0000-000000000003',
        minecraftUsername: 'PlayerThree',
      }),
    });
    assert.strictEqual(viewerCreate.status, 403);
  } finally {
    await close(server);
  }
});

test('owner can delete minecraft accounts but manager cannot', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const ownerCookie = await loginDashboard(baseUrl);
    await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'manager',
        password: 'manager-password',
        role: 'manager',
      }),
    });

    const created = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        label: 'Delete Candidate',
        minecraftUuid: '00000000-0000-0000-0000-000000000005',
        minecraftUsername: 'DeleteCandidate',
      }),
    });
    assert.strictEqual(created.status, 201);
    const account = (await created.json()).account;

    const managerCookie = await loginDashboard(baseUrl, 'manager', 'manager-password');
    const denied = await fetch(`${baseUrl}/api/dashboard/accounts/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: managerCookie,
      },
      body: JSON.stringify({ accountId: account.id }),
    });
    assert.strictEqual(denied.status, 403);

    const deleted = await fetch(`${baseUrl}/api/dashboard/accounts/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({ accountId: account.id }),
    });
    assert.strictEqual(deleted.status, 200);

    const listed = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: ownerCookie },
    });
    const body = await listed.json();
    assert.strictEqual(body.accounts.some((row) => row.id === account.id), false);
  } finally {
    await close(server);
  }
});

test('owner can delete dashboard users but manager cannot', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const ownerCookie = await loginDashboard(baseUrl);
    const managerCreated = await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'manager',
        password: 'manager-password',
        role: 'manager',
      }),
    });
    assert.strictEqual(managerCreated.status, 201);
    const manager = (await managerCreated.json()).user;

    const viewerCreated = await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'viewer',
        password: 'viewer-password',
        role: 'viewer',
      }),
    });
    assert.strictEqual(viewerCreated.status, 201);
    const viewer = (await viewerCreated.json()).user;

    const managerCookie = await loginDashboard(baseUrl, 'manager', 'manager-password');
    const denied = await fetch(`${baseUrl}/api/dashboard/users/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: managerCookie,
      },
      body: JSON.stringify({ userId: viewer.id }),
    });
    assert.strictEqual(denied.status, 403);

    const deleted = await fetch(`${baseUrl}/api/dashboard/users/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({ userId: manager.id }),
    });
    assert.strictEqual(deleted.status, 200);

    const listed = await fetch(`${baseUrl}/api/dashboard/users`, {
      headers: { Cookie: ownerCookie },
    });
    const body = await listed.json();
    assert.strictEqual(body.users.some((user) => user.id === manager.id), false);
    assert.strictEqual(body.users.some((user) => user.id === viewer.id), true);
  } finally {
    await close(server);
  }
});

test('owner cannot delete their own dashboard user from the active session', async () => {
  const { owner, server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const ownerCookie = await loginDashboard(baseUrl);
    const denied = await fetch(`${baseUrl}/api/dashboard/users/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({ userId: owner.id }),
    });
    assert.strictEqual(denied.status, 400);
  } finally {
    await close(server);
  }
});

test('non-owner cannot create dashboard users', async () => {
  const { server } = createTestServer();
  const baseUrl = await listen(server);
  try {
    const ownerCookie = await loginDashboard(baseUrl);
    await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: 'manager',
        password: 'manager-password',
        role: 'manager',
      }),
    });
    const managerCookie = await loginDashboard(baseUrl, 'manager', 'manager-password');

    const denied = await fetch(`${baseUrl}/api/dashboard/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: managerCookie,
      },
      body: JSON.stringify({
        username: 'other',
        password: 'other-password',
        role: 'viewer',
      }),
    });
    assert.strictEqual(denied.status, 403);
  } finally {
    await close(server);
  }
});
