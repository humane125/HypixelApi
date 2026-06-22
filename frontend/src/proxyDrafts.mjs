export function proxyDraftFromAccount(account) {
  return {
    proxyEnabled: Boolean(account.proxy_enabled),
    proxyType: account.proxy_type || 'SOCKS5',
    proxyHost: account.proxy_host || '',
    proxyPort: account.proxy_port ? String(account.proxy_port) : '',
    proxyUsername: account.proxy_username || '',
    proxyPassword: '',
  };
}

export function proxyDraftsFromAccounts(accounts) {
  return Object.fromEntries((accounts || []).map((account) => [account.id, proxyDraftFromAccount(account)]));
}

export function mergeProxyDraftsFromAccounts(accounts, currentDrafts = {}, activeProxyAccountId = null) {
  const nextDrafts = proxyDraftsFromAccounts(accounts);
  if (activeProxyAccountId != null && currentDrafts[activeProxyAccountId]) {
    nextDrafts[activeProxyAccountId] = currentDrafts[activeProxyAccountId];
  }
  return nextDrafts;
}
