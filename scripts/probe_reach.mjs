// Can a GenLayer round read another chain's history?
//
//   node scripts/probe_reach.mjs
//
// Not a proof of anything, a measurement. The flagship badge needs to find the
// wallets a creator funded before launch, and those are only visible in another
// chain's transaction history. Whether that history is reachable from inside a
// contract decides whether the badge can be built as designed, so it is asked
// rather than assumed.
//
// Four things are tried, cheapest and most likely first:
//
//   a balance at a pinned block   we have done this before, so it is the control
//   logs for an address           logs exist for ERC-20 moves, not for gas
//   an explorer API without a key most want one, and a key in a public contract
//                                 is not a design, it is a leak waiting
//   an explorer page rendered     no key, but scraping a page nobody promised
//                                 to keep stable
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const owner = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const asOwner = createClient({ chain: studionet, account: createAccount(owner.privateKey) });
const anybody = createClient({ chain: studionet });

const BASE_RPC = 'https://sepolia.base.org';
// A real address on Base Sepolia with a history: the creator we have been using.
const SUBJECT = '0x0b57877ec84D96b672CD47D8Ea4424283fDB9F6C';

const rpc = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

const TRIES = [
  ['post', BASE_RPC, rpc('eth_getBalance', [SUBJECT, 'latest']),
   'a balance, the control: this is the one we already rely on elsewhere'],
  ['post', BASE_RPC, rpc('eth_getTransactionCount', [SUBJECT, 'latest']),
   'how many transactions it has sent, which is a count and not a history'],
  ['post', BASE_RPC, rpc('eth_getLogs', [{
     fromBlock: '0x2C4A2E0', toBlock: '0x2C4A2F0',
     topics: [null, null, '0x000000000000000000000000' + SUBJECT.slice(2).toLowerCase()],
   }]),
   'logs naming it as a recipient, which covers token moves but never gas'],
  ['get', `https://api-sepolia.basescan.org/api?module=account&action=txlist&address=${SUBJECT}&sort=asc&page=1&offset=5`,
   '', 'an explorer API with no key, which is where a real history would come from'],
  ['render', `https://sepolia.basescan.org/address/${SUBJECT}`,
   '', 'the explorer page itself, scraped'],
];

async function settle(hash, what) {
  const started = Date.now();
  await asOwner.waitForTransactionReceipt({
    hash, status: 'FINALIZED', retries: 200, interval: 10000,
  });
  say(`    (${what} settled in ${Math.round((Date.now() - started) / 1000)}s)`);
}

say('What a GenLayer round can reach on Base Sepolia.');
say('');

const deployHash = await asOwner.deployContract({
  code: fs.readFileSync(path.join(ROOT, 'contracts', 'reach_probe.py')),
  args: [], leaderOnly: false,
});
const deployed = await asOwner.waitForTransactionReceipt({
  hash: deployHash, status: 'FINALIZED', retries: 200, interval: 10000,
});
const PROBE = deployed?.data?.contract_address ?? deployed?.recipient;
say('  probe ' + PROBE);
say('');

const results = [];
for (const [how, where, body, what] of TRIES) {
  say(what);
  try {
    const hash = await asOwner.writeContract({
      address: PROBE, functionName: 'probe', args: [how, where, body], value: 0n,
    });
    await settle(hash, how);
  } catch (e) {
    say('    (the call itself failed: '
      + String(e.shortMessage || e.message).slice(0, 90) + ')');
    results.push({ how, url: where, what, outcome: 'CALL FAILED', sample: '' });
    say('');
    continue;
  }

  const size = JSON.parse(await anybody.readContract({
    address: PROBE, functionName: 'size', args: [],
  }));
  const last = JSON.parse(await anybody.readContract({
    address: PROBE, functionName: 'attempt_at', args: [String(size.attempts - 1)],
  }));
  const a = last.attempt || {};
  say('    ' + a.outcome);
  if (a.sample) say('    ' + String(a.sample).replace(/\s+/g, ' ').slice(0, 200));
  results.push({ how, url: where, what, outcome: a.outcome, sample: a.sample });
  say('');
}

say('---');
for (const r of results) {
  say(`  ${String(r.outcome || '?').padEnd(12)} ${r.what}`);
}

const reachable = results.filter(r => r.outcome === 'REACHED');
say('');
say(`${reachable.length} of ${results.length} reachable from inside a contract.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'reach.json'), JSON.stringify({
  measured_at: new Date().toISOString(),
  chain: 'genlayer studionet', probe: PROBE, subject: SUBJECT,
  results, transcript: out,
}, null, 2));
say('');
say('Written to results/reach.json');
