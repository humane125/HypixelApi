const assert = require('node:assert/strict');
const test = require('node:test');

async function loadProxyDraftsModule() {
  return import('../frontend/src/proxyDrafts.mjs');
}

test('dashboard websocket account refresh preserves the active proxy draft', async () => {
  const { mergeProxyDraftsFromAccounts } = await loadProxyDraftsModule();
  const accounts = [
    {
      id: 1,
      proxy_enabled: true,
      proxy_type: 'SOCKS5',
      proxy_host: 'server-host',
      proxy_port: 1080,
      proxy_username: 'server-user',
    },
    {
      id: 2,
      proxy_enabled: true,
      proxy_type: 'HTTP',
      proxy_host: 'fresh-host',
      proxy_port: 8080,
      proxy_username: 'fresh-user',
    },
  ];
  const currentDrafts = {
    1: {
      proxyEnabled: true,
      proxyType: 'SOCKS5',
      proxyHost: 'typed-but-unsaved-host',
      proxyPort: '1234',
      proxyUsername: 'typed-user',
      proxyPassword: 'typed-password',
    },
  };

  const drafts = mergeProxyDraftsFromAccounts(accounts, currentDrafts, 1);

  assert.equal(drafts[1].proxyHost, 'typed-but-unsaved-host');
  assert.equal(drafts[1].proxyPassword, 'typed-password');
  assert.equal(drafts[2].proxyHost, 'fresh-host');
  assert.equal(drafts[2].proxyPort, '8080');
});

test('dashboard websocket account refresh reloads drafts when no proxy modal is active', async () => {
  const { mergeProxyDraftsFromAccounts } = await loadProxyDraftsModule();
  const drafts = mergeProxyDraftsFromAccounts([
    {
      id: 1,
      proxy_enabled: true,
      proxy_type: 'HTTP',
      proxy_host: 'server-host',
      proxy_port: 8080,
      proxy_username: '',
    },
  ], {
    1: {
      proxyEnabled: true,
      proxyType: 'SOCKS5',
      proxyHost: 'old-local-draft',
      proxyPort: '1234',
      proxyUsername: '',
      proxyPassword: '',
    },
  }, null);

  assert.equal(drafts[1].proxyType, 'HTTP');
  assert.equal(drafts[1].proxyHost, 'server-host');
  assert.equal(drafts[1].proxyPort, '8080');
});
