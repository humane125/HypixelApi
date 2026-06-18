const assert = require('assert');
const WebSocket = require('ws');

const {
  createDatabase,
  createUser,
  createApiKey,
  setUserPassword,
  createMinecraftAccount,
  updateMinecraftAccountProxy,
} = require('../auth-db');
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

test('mod websocket lists connected transfer accounts and accepts a transfer invite', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  createApiKey(db, {
    userId: owner.id,
    name: 'sender mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_transfer_sender',
  });
  createApiKey(db, {
    userId: owner.id,
    name: 'receiver mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_transfer_receiver',
  });
  const profiles = {
    SenderPlayer: '00000000000000000000000000001001',
    ReceiverPlayer: '00000000000000000000000000001002',
  };
  const server = createAppServer({
    db,
    fetchImpl: async (requestUrl) => {
      const username = decodeURIComponent(String(requestUrl).split('/').pop());
      return {
        ok: true,
        json: async () => ({ id: profiles[username], name: username }),
      };
    },
  });
  const baseUrl = await listen(server);
  const sender = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  const receiver = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await Promise.all([waitForSocketOpen(sender), waitForSocketOpen(receiver)]);
    sender.send(JSON.stringify({ type: 'auth', apiKey: 'hpx_test_transfer_sender', username: 'SenderPlayer' }));
    receiver.send(JSON.stringify({ type: 'auth', apiKey: 'hpx_test_transfer_receiver', username: 'ReceiverPlayer' }));
    assert.strictEqual((await waitForSocketMessage(sender)).type, 'auth_ok');
    assert.strictEqual((await waitForSocketMessage(receiver)).type, 'auth_ok');

    sender.send(JSON.stringify({ type: 'transfer_list' }));
    const listed = await waitForSocketMessage(sender);
    assert.strictEqual(listed.type, 'transfer_accounts');
    assert.deepStrictEqual(listed.accounts.map((account) => account.minecraftUsername).sort(), ['ReceiverPlayer', 'SenderPlayer']);

    sender.send(JSON.stringify({
      type: 'transfer_invite',
      receiverUsername: 'ReceiverPlayer',
      itemName: 'ENCHANTED DIAMOND',
    }));
    const pending = await waitForSocketMessage(sender);
    const invite = await waitForSocketMessage(receiver);
    assert.strictEqual(pending.type, 'transfer_pending');
    assert.strictEqual(invite.type, 'transfer_invite');
    assert.strictEqual(invite.session.senderUsername, 'SenderPlayer');
    assert.strictEqual(invite.session.receiverUsername, 'ReceiverPlayer');
    assert.strictEqual(invite.session.itemName, 'ENCHANTED DIAMOND');

    receiver.send(JSON.stringify({ type: 'transfer_accept', senderUsername: 'SenderPlayer' }));
    const senderAccepted = await waitForSocketMessage(sender);
    const receiverAccepted = await waitForSocketMessage(receiver);
    assert.strictEqual(senderAccepted.type, 'transfer_accepted');
    assert.strictEqual(senderAccepted.role, 'sender');
    assert.strictEqual(receiverAccepted.type, 'transfer_accepted');
    assert.strictEqual(receiverAccepted.role, 'receiver');
    assert.strictEqual(senderAccepted.session.id, receiverAccepted.session.id);

    sender.send(JSON.stringify({ type: 'transfer_run', quantity: 128 }));
    const senderRun = await waitForSocketMessage(sender);
    const receiverRun = await waitForSocketMessage(receiver);
    assert.strictEqual(senderRun.type, 'transfer_run_sent');
    assert.strictEqual(senderRun.quantity, 128);
    assert.strictEqual(receiverRun.type, 'transfer_run');
    assert.strictEqual(receiverRun.quantity, 128);
    assert.strictEqual(receiverRun.session.itemName, 'ENCHANTED DIAMOND');

    receiver.send(JSON.stringify({ type: 'transfer_buy_order_ready', quantity: 128 }));
    const senderReady = await waitForSocketMessage(sender);
    assert.strictEqual(senderReady.type, 'transfer_buy_order_ready');
    assert.strictEqual(senderReady.quantity, 128);
    assert.strictEqual(senderReady.session.itemName, 'ENCHANTED DIAMOND');

    receiver.send(JSON.stringify({ type: 'transfer_sell_offer_ready', quantity: 128 }));
    const senderSellOfferReady = await waitForSocketMessage(sender);
    assert.strictEqual(senderSellOfferReady.type, 'transfer_sell_offer_ready');
    assert.strictEqual(senderSellOfferReady.quantity, 128);
    assert.strictEqual(senderSellOfferReady.session.itemName, 'ENCHANTED DIAMOND');

    sender.send(JSON.stringify({ type: 'transfer_sell_offer_bought', quantity: 128 }));
    const receiverSellOfferBought = await waitForSocketMessage(receiver);
    assert.strictEqual(receiverSellOfferBought.type, 'transfer_sell_offer_bought');
    assert.strictEqual(receiverSellOfferBought.quantity, 128);
    assert.strictEqual(receiverSellOfferBought.session.itemName, 'ENCHANTED DIAMOND');

    receiver.send(JSON.stringify({
      type: 'transfer_cycle_complete',
      quantity: 128,
      before: 1000000,
      after: 18500000,
      delta: 17500000,
    }));
    const senderCycleComplete = await waitForSocketMessage(sender);
    assert.strictEqual(senderCycleComplete.type, 'transfer_cycle_complete');
    assert.strictEqual(senderCycleComplete.quantity, 128);
    assert.strictEqual(senderCycleComplete.before, 1000000);
    assert.strictEqual(senderCycleComplete.after, 18500000);
    assert.strictEqual(senderCycleComplete.delta, 17500000);
    assert.strictEqual(senderCycleComplete.session.itemName, 'ENCHANTED DIAMOND');
  } finally {
    closeSocketSilently(sender);
    closeSocketSilently(receiver);
    await close(server);
  }
});

test('mod websocket handles transfer decline cancel and invalid invite cases', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  for (const [rawKey, name] of [
    ['hpx_test_transfer_sender_errors', 'SenderPlayer'],
    ['hpx_test_transfer_receiver_errors', 'ReceiverPlayer'],
    ['hpx_test_transfer_third_errors', 'ThirdPlayer'],
  ]) {
    createApiKey(db, {
      userId: owner.id,
      name,
      scopes: ['mod:connect'],
      rawKey,
    });
  }
  const profiles = {
    SenderPlayer: '00000000000000000000000000002001',
    ReceiverPlayer: '00000000000000000000000000002002',
    ThirdPlayer: '00000000000000000000000000002003',
  };
  const server = createAppServer({
    db,
    fetchImpl: async (requestUrl) => {
      const username = decodeURIComponent(String(requestUrl).split('/').pop());
      return {
        ok: true,
        json: async () => ({ id: profiles[username], name: username }),
      };
    },
  });
  const baseUrl = await listen(server);
  const sender = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  const receiver = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  const third = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await Promise.all([waitForSocketOpen(sender), waitForSocketOpen(receiver), waitForSocketOpen(third)]);
    sender.send(JSON.stringify({ type: 'auth', apiKey: 'hpx_test_transfer_sender_errors', username: 'SenderPlayer' }));
    receiver.send(JSON.stringify({ type: 'auth', apiKey: 'hpx_test_transfer_receiver_errors', username: 'ReceiverPlayer' }));
    third.send(JSON.stringify({ type: 'auth', apiKey: 'hpx_test_transfer_third_errors', username: 'ThirdPlayer' }));
    assert.strictEqual((await waitForSocketMessage(sender)).type, 'auth_ok');
    assert.strictEqual((await waitForSocketMessage(receiver)).type, 'auth_ok');
    assert.strictEqual((await waitForSocketMessage(third)).type, 'auth_ok');

    sender.send(JSON.stringify({ type: 'transfer_invite', receiverUsername: 'SenderPlayer', itemName: 'ENCHANTED DIAMOND' }));
    const selfInvite = await waitForSocketMessage(sender);
    assert.strictEqual(selfInvite.type, 'transfer_error');
    assert.strictEqual(selfInvite.code, 'self_invite');

    sender.send(JSON.stringify({ type: 'transfer_invite', receiverUsername: 'OfflinePlayer', itemName: 'ENCHANTED DIAMOND' }));
    const offline = await waitForSocketMessage(sender);
    assert.strictEqual(offline.type, 'transfer_error');
    assert.strictEqual(offline.code, 'target_offline');

    sender.send(JSON.stringify({ type: 'transfer_invite', receiverUsername: 'ReceiverPlayer', itemName: 'ENCHANTED DIAMOND' }));
    assert.strictEqual((await waitForSocketMessage(sender)).type, 'transfer_pending');
    assert.strictEqual((await waitForSocketMessage(receiver)).type, 'transfer_invite');

    third.send(JSON.stringify({ type: 'transfer_invite', receiverUsername: 'ReceiverPlayer', itemName: 'ENCHANTED DIAMOND' }));
    const busy = await waitForSocketMessage(third);
    assert.strictEqual(busy.type, 'transfer_error');
    assert.strictEqual(busy.code, 'account_busy');

    receiver.send(JSON.stringify({ type: 'transfer_decline', senderUsername: 'SenderPlayer' }));
    const declined = await waitForSocketMessage(sender);
    assert.strictEqual(declined.type, 'transfer_declined');
    assert.strictEqual(declined.reason, 'ReceiverPlayer declined');

    sender.send(JSON.stringify({ type: 'transfer_invite', receiverUsername: 'ReceiverPlayer', itemName: 'ENCHANTED DIAMOND' }));
    assert.strictEqual((await waitForSocketMessage(sender)).type, 'transfer_pending');
    assert.strictEqual((await waitForSocketMessage(receiver)).type, 'transfer_invite');
    sender.send(JSON.stringify({ type: 'transfer_cancel' }));
    const cancelled = await waitForSocketMessage(receiver);
    assert.strictEqual(cancelled.type, 'transfer_cancelled');
    assert.strictEqual(cancelled.reason, 'SenderPlayer cancelled');
  } finally {
    closeSocketSilently(sender);
    closeSocketSilently(receiver);
    closeSocketSilently(third);
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

test('mod websocket does not crash when account registration returns no account', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_missing_account_socket',
  });
  db.exec(`
    CREATE TRIGGER test_delete_mod_account_after_insert
    AFTER INSERT ON minecraft_accounts
    BEGIN
      DELETE FROM minecraft_accounts WHERE id = NEW.id;
    END
  `);
  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000019',
        name: 'MissingAccountPlayer',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_missing_account_socket',
      username: 'MissingAccountPlayer',
    }));
    const failed = await waitForSocketMessage(socket);
    assert.strictEqual(failed.type, 'error');
    assert.strictEqual(failed.code, 'account_registration_failed');

    const closed = await new Promise((resolve, reject) => {
      socket.once('close', () => resolve(true));
      socket.once('error', reject);
      setTimeout(() => reject(new Error('Timed out waiting for socket close')), 1500);
    });
    assert.strictEqual(closed, true);
  } finally {
    closeSocketSilently(socket);
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

test('mod websocket marks account offline when the socket closes without an offline message', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_socket_close',
  });
  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000020',
        name: 'ClosedSocketPlayer',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_socket_close',
      username: 'ClosedSocketPlayer',
    }));
    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');

    socket.send(JSON.stringify({ type: 'hypixel' }));
    const hypixel = await waitForSocketMessage(socket);
    assert.strictEqual(hypixel.status, 'hypixel');

    socket.close();
    await new Promise((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
      setTimeout(() => reject(new Error('Timed out waiting for socket close')), 1500);
    });

    let account = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(authed.account.id);
    const deadline = Date.now() + 1500;
    while (account.status !== 'offline' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      account = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(authed.account.id);
    }
    assert.strictEqual(account.status, 'offline');
  } finally {
    closeSocketSilently(socket);
    await close(server);
  }
});

test('mod websocket closes cleanly when the dashboard deleted its account while connected', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_deleted_account_socket',
  });
  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000016',
        name: 'DeletedLivePlayer',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_deleted_account_socket',
      username: 'DeletedLivePlayer',
    }));
    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');

    db.prepare('DELETE FROM minecraft_accounts WHERE id = ?').run(authed.account.id);
    socket.send(JSON.stringify({ type: 'heartbeat' }));
    const deleted = await waitForSocketMessage(socket);
    assert.strictEqual(deleted.type, 'error');
    assert.strictEqual(deleted.code, 'account_deleted');
  } finally {
    closeSocketSilently(socket);
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

    const futureBanUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    socket.send(JSON.stringify({
      type: 'banned',
      banReason: 'Cheating through the use of unfair game advantages.',
      banId: '#01346337',
      banUntil: futureBanUntil,
    }));
    const banned = await waitForSocketMessage(socket);
    assert.strictEqual(banned.type, 'status_ok');
    assert.strictEqual(banned.status, 'banned');
    assert.strictEqual(banned.account.ban_reason, 'Cheating through the use of unfair game advantages.');
    assert.strictEqual(banned.account.ban_id, '#01346337');
    assert.strictEqual(banned.account.ban_until, futureBanUntil);

    socket.send(JSON.stringify({ type: 'offline' }));
    const offline = await waitForSocketMessage(socket);
    assert.strictEqual(offline.type, 'status_ok');
    assert.strictEqual(offline.status, 'banned');

    const account = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(authed.account.id);
    assert.strictEqual(account.status, 'banned');
    assert.strictEqual(account.ban_reason, 'Cheating through the use of unfair game advantages.');
    assert.strictEqual(account.ban_id, '#01346337');
    assert.strictEqual(account.ban_until, futureBanUntil);
  } finally {
    socket.close();
    await close(server);
  }
});

test('mod websocket broadcasts disconnect command to other connected mods when an account is banned', async () => {
  const db = createDatabase(':memory:');
  const owner = createUser(db, { username: 'owner', role: 'owner' });
  setUserPassword(db, owner.id, 'owner-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_mod_disconnect_socket',
  });
  const server = createAppServer({
    db,
    fetchImpl: async (requestUrl) => {
      const username = String(requestUrl).split('/').pop();
      const profiles = {
        BannedPlayer: '00000000000000000000000000000021',
        SafePlayer: '00000000000000000000000000000022',
      };
      return {
        ok: Boolean(profiles[username]),
        json: async () => ({
          id: profiles[username],
          name: username,
        }),
      };
    },
  });
  const baseUrl = await listen(server);
  const bannedSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  const safeSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await Promise.all([waitForSocketOpen(bannedSocket), waitForSocketOpen(safeSocket)]);
    bannedSocket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_disconnect_socket',
      username: 'BannedPlayer',
    }));
    safeSocket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_mod_disconnect_socket',
      username: 'SafePlayer',
    }));
    const bannedAuth = await waitForSocketMessage(bannedSocket);
    const safeAuth = await waitForSocketMessage(safeSocket);
    assert.strictEqual(bannedAuth.type, 'auth_ok');
    assert.strictEqual(safeAuth.type, 'auth_ok');

    const disconnectPromise = waitForSocketMessageMatching(safeSocket, (message) => (
      message.type === 'disconnect_now'
      && message.sourceAccount.minecraftUsername === 'BannedPlayer'
    ));
    bannedSocket.send(JSON.stringify({
      type: 'banned',
      banReason: 'Dev test ban',
      banId: '#TEST',
    }));
    const bannedStatus = await waitForSocketMessage(bannedSocket);
    assert.strictEqual(bannedStatus.type, 'status_ok');
    assert.strictEqual(bannedStatus.status, 'banned');

    const disconnect = await disconnectPromise;
    assert.strictEqual(disconnect.reason, 'Ban detected on BannedPlayer');
    assert.strictEqual(disconnect.sourceAccount.id, bannedAuth.account.id);
  } finally {
    closeSocketSilently(bannedSocket);
    closeSocketSilently(safeSocket);
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

test('dashboard account list marks stale live heartbeat accounts offline', async () => {
  const { db, server } = createTestServerWithOptions({
    accountHeartbeatWindowMs: 30_000,
  });
  const baseUrl = await listen(server);
  try {
    const cookie = await loginDashboard(baseUrl);
    const stale = new Date(Date.now() - 120_000).toISOString();
    const insertAccount = db.prepare(`
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
      VALUES (?, ?, ?, 1, ?, '', ?, ?, ?, ?)
    `);
    insertAccount.run('Stale Active', '00000000-0000-0000-0000-000000000012', 'StaleActivePlayer', 'active', stale, stale, stale, stale);
    insertAccount.run('Stale Hypixel', '00000000-0000-0000-0000-000000000013', 'StaleHypixelPlayer', 'hypixel', stale, stale, stale, stale);

    const listed = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: cookie },
    });
    assert.strictEqual(listed.status, 200);
    const accounts = (await listed.json()).accounts;
    const activeAccount = accounts.find((row) => row.minecraft_username === 'StaleActivePlayer');
    const hypixelAccount = accounts.find((row) => row.minecraft_username === 'StaleHypixelPlayer');
    assert.strictEqual(activeAccount.status, 'offline');
    assert.strictEqual(hypixelAccount.status, 'offline');
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

test('dashboard can save account proxy settings without exposing proxy passwords in account lists', async () => {
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
        label: 'Proxy Account',
        minecraftUuid: '00000000-0000-0000-0000-000000000051',
        minecraftUsername: 'DashboardProxyPlayer',
      }),
    });
    assert.strictEqual(created.status, 201);
    const accountId = (await created.json()).account.id;

    const saved = await fetch(`${baseUrl}/api/dashboard/accounts/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        accountId,
        proxyEnabled: true,
        proxyType: 'socks5',
        proxyHost: 'proxy.example.com',
        proxyPort: '1080',
        proxyUsername: 'dash-user',
        proxyPassword: 'dash-secret',
      }),
    });
    assert.strictEqual(saved.status, 200);
    const savedBody = await saved.json();
    assert.strictEqual(savedBody.account.proxy_enabled, 1);
    assert.strictEqual(savedBody.account.proxy_type, 'SOCKS5');
    assert.strictEqual(savedBody.account.proxy_host, 'proxy.example.com');
    assert.strictEqual(savedBody.account.proxy_port, 1080);
    assert.strictEqual(savedBody.account.proxy_username, 'dash-user');
    assert.strictEqual(savedBody.account.proxy_has_password, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(savedBody.account, 'proxy_password'), false);

    const listed = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: cookie },
    });
    assert.strictEqual(listed.status, 200);
    const listedAccount = (await listed.json()).accounts.find((account) => account.id === accountId);
    assert.strictEqual(listedAccount.proxy_has_password, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(listedAccount, 'proxy_password'), false);
  } finally {
    await close(server);
  }
});

test('mod account proxy lookup is authenticated and scoped to the minecraft account', async () => {
  const { db, owner, server } = createTestServer();
  const other = createUser(db, { username: 'other', role: 'manager' });
  setUserPassword(db, other.id, 'other-password');
  createApiKey(db, {
    userId: owner.id,
    name: 'owner mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_owner_mod_proxy',
  });
  createApiKey(db, {
    userId: other.id,
    name: 'other mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_other_mod_proxy',
  });
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
        label: 'Lookup Proxy Account',
        minecraftUuid: '00000000-0000-0000-0000-000000000052',
        minecraftUsername: 'LookupDashboardProxy',
      }),
    });
    assert.strictEqual(created.status, 201);
    const accountId = (await created.json()).account.id;

    const saved = await fetch(`${baseUrl}/api/dashboard/accounts/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        accountId,
        proxyEnabled: true,
        proxyType: 'SOCKS5',
        proxyHost: '127.0.0.1',
        proxyPort: 1080,
        proxyUsername: 'mod-user',
        proxyPassword: 'mod-secret',
      }),
    });
    assert.strictEqual(saved.status, 200);

    const denied = await fetch(`${baseUrl}/api/mod/account-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minecraftUsername: 'LookupDashboardProxy' }),
    });
    assert.strictEqual(denied.status, 401);

    const otherLookup = await fetch(`${baseUrl}/api/mod/account-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer hpx_test_other_mod_proxy',
      },
      body: JSON.stringify({ minecraftUsername: 'LookupDashboardProxy' }),
    });
    assert.strictEqual(otherLookup.status, 200);
    const otherProxy = (await otherLookup.json()).proxy;
    assert.strictEqual(otherProxy.accountId, accountId);
    assert.strictEqual(otherProxy.host, '127.0.0.1');
    assert.strictEqual(otherProxy.password, 'mod-secret');

    const lookup = await fetch(`${baseUrl}/api/mod/account-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer hpx_test_owner_mod_proxy',
      },
      body: JSON.stringify({ minecraftUuid: '00000000000000000000000000000052' }),
    });
    assert.strictEqual(lookup.status, 200);
    assert.deepStrictEqual(await lookup.json(), {
      proxy: {
        accountId,
        minecraftUuid: '00000000-0000-0000-0000-000000000052',
        minecraftUsername: 'LookupDashboardProxy',
        enabled: true,
        type: 'SOCKS5',
        host: '127.0.0.1',
        port: 1080,
        username: 'mod-user',
        password: 'mod-secret',
      },
    });
  } finally {
    await close(server);
  }
});

test('existing owner account goes active and hypixel when another user opens it through the mod', async () => {
  const db = createDatabase(':memory:');
  const humane = createUser(db, { username: 'Humane', role: 'manager' });
  setUserPassword(db, humane.id, 'humane-password');
  const edzioo = createUser(db, { username: 'Edzioo', role: 'manager' });
  createApiKey(db, {
    userId: edzioo.id,
    name: 'edzioo mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_edzioo_status_existing_account',
  });
  const account = createMinecraftAccount(db, {
    label: 'Rivoh89',
    minecraftUuid: '00000000-0000-0000-0000-000000000089',
    minecraftUsername: 'Rivoh89',
    ownerUserId: humane.id,
  });

  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000089',
        name: 'Rivoh89',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_edzioo_status_existing_account',
      username: 'Rivoh89',
    }));
    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');
    assert.strictEqual(authed.account.id, account.id);
    assert.strictEqual(authed.account.owner_user_id, humane.id);

    socket.send(JSON.stringify({ type: 'active' }));
    const active = await waitForSocketMessage(socket);
    assert.strictEqual(active.type, 'status_ok');
    assert.strictEqual(active.status, 'active');

    const stored = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(account.id);
    assert.strictEqual(stored.owner_user_id, humane.id);
    assert.strictEqual(stored.status, 'active');

    const humaneCookie = await loginDashboard(baseUrl, 'Humane', 'humane-password');
    const listedActive = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: humaneCookie },
    });
    assert.strictEqual(listedActive.status, 200);
    const listedActiveAccount = (await listedActive.json()).accounts.find((row) => row.id === account.id);
    assert.ok(listedActiveAccount);
    assert.strictEqual(listedActiveAccount.owner_username, 'Humane');
    assert.strictEqual(listedActiveAccount.current_username, 'Edzioo');
    assert.strictEqual(listedActiveAccount.status, 'active');

    socket.send(JSON.stringify({ type: 'hypixel' }));
    const hypixel = await waitForSocketMessage(socket);
    assert.strictEqual(hypixel.type, 'status_ok');
    assert.strictEqual(hypixel.status, 'hypixel');

    const listedHypixel = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: humaneCookie },
    });
    assert.strictEqual(listedHypixel.status, 200);
    const listedHypixelAccount = (await listedHypixel.json()).accounts.find((row) => row.id === account.id);
    assert.ok(listedHypixelAccount);
    assert.strictEqual(listedHypixelAccount.owner_username, 'Humane');
    assert.strictEqual(listedHypixelAccount.current_username, 'Edzioo');
    assert.strictEqual(listedHypixelAccount.status, 'hypixel');

    socket.send(JSON.stringify({ type: 'offline' }));
    const offline = await waitForSocketMessage(socket);
    assert.strictEqual(offline.type, 'status_ok');
    assert.strictEqual(offline.status, 'offline');

    const listedOffline = await fetch(`${baseUrl}/api/dashboard/accounts`, {
      headers: { Cookie: humaneCookie },
    });
    assert.strictEqual(listedOffline.status, 200);
    const listedOfflineAccount = (await listedOffline.json()).accounts.find((row) => row.id === account.id);
    assert.ok(listedOfflineAccount);
    assert.strictEqual(listedOfflineAccount.status, 'offline');
    assert.strictEqual(listedOfflineAccount.current_username, null);
  } finally {
    closeSocketSilently(socket);
    await close(server);
  }
});

test('mod websocket does not transfer existing account ownership or lose proxy settings', async () => {
  const db = createDatabase(':memory:');
  const humane = createUser(db, { username: 'Humane', role: 'manager' });
  const edzioo = createUser(db, { username: 'Edzioo', role: 'manager' });
  createApiKey(db, {
    userId: edzioo.id,
    name: 'edzioo mod key',
    scopes: ['mod:connect'],
    rawKey: 'hpx_test_edzioo_existing_account',
  });
  const account = createMinecraftAccount(db, {
    label: 'Rivoh89',
    minecraftUuid: '00000000-0000-0000-0000-000000000089',
    minecraftUsername: 'Rivoh89',
    ownerUserId: humane.id,
  });
  updateMinecraftAccountProxy(db, account.id, {
    proxyEnabled: true,
    proxyType: 'SOCKS5',
    proxyHost: '127.0.0.89',
    proxyPort: 1089,
    proxyUsername: 'rivoh-proxy',
    proxyPassword: 'rivoh-secret',
  });

  const server = createAppServer({
    db,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: '00000000000000000000000000000089',
        name: 'Rivoh89',
      }),
    }),
  });
  const baseUrl = await listen(server);
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      type: 'auth',
      apiKey: 'hpx_test_edzioo_existing_account',
      username: 'Rivoh89',
    }));
    const authed = await waitForSocketMessage(socket);
    assert.strictEqual(authed.type, 'auth_ok');
    assert.strictEqual(authed.account.owner_user_id, humane.id);

    const stored = db.prepare('SELECT * FROM minecraft_accounts WHERE id = ?').get(account.id);
    assert.strictEqual(stored.owner_user_id, humane.id);
    assert.strictEqual(stored.proxy_enabled, 1);
    assert.strictEqual(stored.proxy_host, '127.0.0.89');
    assert.strictEqual(stored.proxy_port, 1089);

    const proxyLookup = await fetch(`${baseUrl}/api/mod/account-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer hpx_test_edzioo_existing_account',
      },
      body: JSON.stringify({ minecraftUuid: '00000000000000000000000000000089' }),
    });
    assert.strictEqual(proxyLookup.status, 200);
    const proxyBody = await proxyLookup.json();
    assert.strictEqual(proxyBody.proxy.accountId, account.id);
    assert.strictEqual(proxyBody.proxy.host, '127.0.0.89');
    assert.strictEqual(proxyBody.proxy.password, 'rivoh-secret');

    socket.close();
    await new Promise((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
      setTimeout(() => reject(new Error('Timed out waiting for socket close')), 1500);
    });

    db.prepare('DELETE FROM minecraft_accounts WHERE id = ?').run(account.id);
    const reopenedSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/mod/ws');
    try {
      await waitForSocketOpen(reopenedSocket);
      reopenedSocket.send(JSON.stringify({
        type: 'auth',
        apiKey: 'hpx_test_edzioo_existing_account',
        username: 'Rivoh89',
      }));
      const reopened = await waitForSocketMessage(reopenedSocket);
      assert.strictEqual(reopened.type, 'auth_ok');
      assert.strictEqual(reopened.account.owner_user_id, edzioo.id);
      assert.strictEqual(reopened.account.proxy_enabled, 0);
    } finally {
      closeSocketSilently(reopenedSocket);
    }
  } finally {
    closeSocketSilently(socket);
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

test('manager can move banned minecraft account to banned folder', async () => {
  const { db, server } = createTestServer();
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
    const owner = db.prepare('SELECT id FROM users WHERE username = ?').get('owner');
    const result = db.prepare(`
      INSERT INTO minecraft_accounts (
        label,
        minecraft_uuid,
        minecraft_username,
        owner_user_id,
        status,
        notes,
        ban_reason,
        banned_at,
        created_at,
        updated_at
      )
      VALUES ('Banned test', '00000000-0000-0000-0000-000000000042', 'FolderMovePlayer', ?, 'banned', '', 'Cheating', '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z')
    `).run(owner.id);

    const managerCookie = await loginDashboard(baseUrl, 'manager', 'manager-password');
    const moved = await fetch(`${baseUrl}/api/dashboard/accounts/banned-folder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: managerCookie,
      },
      body: JSON.stringify({ accountId: result.lastInsertRowid }),
    });
    assert.strictEqual(moved.status, 200);
    const body = await moved.json();
    assert.strictEqual(body.account.is_banned_foldered, 1);
    assert.ok(body.account.banned_foldered_at);
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
