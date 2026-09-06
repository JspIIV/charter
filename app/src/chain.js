// Talking to the chain the rules live on.
//
// GenLayer testnet, not the Studio network. A browser wallet cannot reach
// Studionet at all, so an interface built on it would be an interface nobody
// but us could use. The launchpad is stuck there because gl.deploy_contract
// does not work on testnet yet; a single token has no such dependency, which
// is what this app is about.
import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';

export const CHAIN_ID_HEX = '0x107d'; // 4221

const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: 'GenLayer Asimov',
  nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
  rpcUrls: ['https://rpc-asimov.genlayer.com'],
  blockExplorerUrls: ['https://explorer-asimov.genlayer.com'],
};

export const EXPLORER = 'https://explorer-asimov.genlayer.com';

let account = null;
const reader = createClient({ chain: testnetAsimov });

export const currentAccount = () => account;
export const short = a => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '');

export function onAccountChange(fn) {
  if (!window.ethereum?.on) return;
  window.ethereum.on('accountsChanged', accounts => {
    account = accounts[0] || null;
    fn(account);
  });
}

export async function connect() {
  if (!window.ethereum) {
    throw new Error('No browser wallet found. Reading works without one; '
      + 'signing needs MetaMask or something like it.');
  }
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  account = accounts[0];
  return account;
}

async function useGenLayer() {
  if (!window.ethereum) throw new Error('No browser wallet found.');
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() === CHAIN_ID_HEX) return;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS],
      });
      return;
    }
    throw new Error('This signs on GenLayer Asimov. Your wallet stayed on another '
      + 'network, and a transaction signed there would be rejected.');
  }
}

// The wallet is handed a fully specified transaction by the SDK, including
// fields wallets would rather compute themselves, and a wallet that dislikes
// one of them reports only that a parameter was invalid. It is given back what
// it cannot work out for itself.
const WALLET_COMPUTES = ['nonce', 'type', 'chainId'];

// What a consensus round is given to run in. This is a correctness setting, not
// a tuning one: a round fetches a page and prompts a model, and a limit
// estimated the ordinary way is far too small. The transaction is then accepted,
// the round never completes, and the fee is spent for nothing. Unused gas is not
// charged, so the only cost of being generous is a larger reserve while it runs.
const ROUND_GAS = 6_000_000n;

function walletFriendly(provider) {
  return {
    ...provider,
    request: async payload => {
      if (payload?.method !== 'eth_sendTransaction') return provider.request(payload);
      const tx = { ...(payload.params?.[0] ?? {}) };
      for (const key of WALLET_COMPUTES) delete tx[key];
      if (BigInt(tx.gas ?? 0) < ROUND_GAS) tx.gas = '0x' + ROUND_GAS.toString(16);
      try {
        return await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      } catch (err) {
        if (err?.code !== -32602 || tx.gasPrice === undefined) throw err;
        const withoutPrice = { ...tx };
        delete withoutPrice.gasPrice;
        return provider.request({ method: 'eth_sendTransaction', params: [withoutPrice] });
      }
    },
  };
}

// A busy node answers a burst with -32005 and a retryAfterMs. That is the node
// saying "in a moment", not the call failing, and showing it as a failure would
// tell somebody their transaction was rejected when it was not.
const transient = e => {
  const s = String(e?.details || e?.shortMessage || e?.message || e);
  return /-32005|at capacity|gas rate|rate limit|fetch failed|timeout|502|503|429/i.test(s);
};

export async function read(address, functionName, args = []) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const raw = await reader.readContract({ address, functionName, args });
      try { return JSON.parse(raw); } catch { return raw; }
    } catch (e) {
      if (!transient(e)) throw e;
      last = e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw last;
}

/**
 * Sign a write, then wait for the contract to show it.
 *
 * The receipt is deliberately not what this waits on. Asked through a wallet
 * provider the SDK reaches the consensus contract with a plain eth_call, which
 * this network answers with nothing, so a transaction that was accepted reads
 * as a failure. What a person wants to know is whether the thing they asked for
 * happened, so that is what gets checked: the contract is read back until it
 * shows the change.
 *
 * `onTick` is called each time round with the seconds elapsed, because a round
 * takes the better part of a minute and a page that says nothing for that long
 * reads as broken.
 */
export async function write(address, functionName, args = [], { value = 0n, settled, onTick } = {}) {
  await useGenLayer();
  const client = createClient({
    chain: testnetAsimov, account, provider: walletFriendly(window.ethereum),
  });

  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await client.writeContract({ address, functionName, args, value });
      break;
    } catch (e) {
      if (!transient(e) || attempt >= 6) throw e;
      const waitMs = Number(e?.cause?.data?.retryAfterMs || 0);
      await new Promise(r => setTimeout(r, Math.max(waitMs, 1500) * attempt));
    }
  }

  const started = Date.now();
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(r => setTimeout(r, 4000));
    const seconds = Math.round((Date.now() - started) / 1000);
    if (typeof onTick === 'function') onTick(seconds);
    try { if (!settled || await settled()) return { hash, seconds }; } catch { /* keep asking */ }
  }
  throw new Error('Signed, but the contract has not shown the change yet. Nothing is '
    + 'lost: GenLayer settles in its own time. Reload in a minute.');
}
