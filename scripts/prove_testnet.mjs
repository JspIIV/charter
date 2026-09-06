// Does a charter token work on the real testnet, not just the Studio network?
//
//   node scripts/prove_testnet.mjs
//
// It matters for a reason that has nothing to do with the contract. A browser
// wallet cannot sign for Studionet: it is the Studio's own network and there is
// nothing for MetaMask to connect to. An interface built on it would be an
// interface nobody but us could use.
//
// The launchpad is stuck there, because gl.deploy_contract does not work on
// testnet yet. A single token has no such dependency, so this checks whether
// the thing the interface is actually about works where people are.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const creator = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const keeper = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub);

const asCreator = createClient({ chain: testnetAsimov, account: createAccount(creator.privateKey) });
const asKeeper = createClient({ chain: testnetAsimov, account: createAccount(keeper.privateKey) });
const anybody = createClient({ chain: testnetAsimov });

const PAGE = 'https://gist.githubusercontent.com/JspIIV/'
  + '2ff5af1cd421395420c9ec33b9ecbebf/raw/claim_false.txt';
const BOUNTY = 2_000_000_000_000_000n;
const RULES = JSON.stringify([{
  when: 'the page states that a security certificate has expired',
  url: PAGE, then: 'BURN', amount: 40000,
}]);

/** The testnet meters gas per node and answers a burst with -32005 and a
 *  retryAfterMs. That is the node saying "in a moment", not the transaction
 *  failing, and treating it as a failure would report a working contract as a
 *  broken one. */
async function send(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const why = String(e?.details || e?.shortMessage || e?.message || e);
      const waitMs = Number(e?.cause?.data?.retryAfterMs || e?.data?.retryAfterMs || 0);
      const busy = /-32005|at capacity|rate limit|gas rate/i.test(why);
      if (!busy || attempt >= 12) throw e;
      const pause = Math.max(waitMs, 1000) * attempt;
      say(`  (${what}: the node is at capacity, waiting ${Math.round(pause / 1000)}s)`);
      await new Promise(r => setTimeout(r, pause));
    }
  }
}

// Receipts carry BigInts and JSON.stringify refuses them, which turned the
// line meant to explain a failure into a second failure that hid the first.
const show = (value, cap) => JSON.stringify(value,
  (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, cap);

async function settle(client, hash, what) {
  const started = Date.now();
  const r = await client.waitForTransactionReceipt({
    hash, status: 'FINALIZED', retries: 200, interval: 12000,
  });
  say(`  ${what} finalized in ${Math.round((Date.now() - started) / 1000)}s`);
  return r;
}

say('charter.fun on GenLayer testnet (Asimov), where a wallet can reach it.');
say('');

const deployHash = await send('deploy', () => asCreator.deployContract({
  code: fs.readFileSync(path.join(ROOT, 'contracts', 'token.py')),
  args: ['Charter Testnet', 'TCHT', '1000000', '30', RULES, creator.address],
  leaderOnly: false,
}));
const deployed = await settle(asCreator, deployHash, 'deploy');
// Studionet reports the new address at data.contract_address. Testnet did not,
// and reading a missing field as an address turned a working deploy into an
// invalid-address error two calls later. So look in the places it could be and
// say what came back if it is in none of them.
const TOKEN = deployed?.data?.contract_address
  ?? deployed?.contract_address
  ?? deployed?.data?.contractAddress
  ?? deployed?.contractAddress
  ?? deployed?.data?.result?.contract_address;
if (!TOKEN) {
  say('  the deploy finalized but no address came back in the receipt.');
  say('  deploy tx ' + deployHash);
  say('  receipt keys: ' + Object.keys(deployed || {}).join(', '));
  say('  data keys:    ' + Object.keys(deployed?.data || {}).join(', '));
  say('  receipt: ' + show(deployed, 1200));
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'testnet_receipt.json'),
    show(deployed, 200000));
  process.exit(1);
}
say('  token ' + TOKEN);

const fundHash = await send('fund', () => asCreator.writeContract({
  address: TOKEN, functionName: 'fund', args: [], value: BOUNTY,
}));
await settle(asCreator, fundHash, 'fund');

let verdict = null;
let attempts = 0;
for (; attempts < 3; attempts++) {
  const tickHash = await send('tick', () => asKeeper.writeContract({
    address: TOKEN, functionName: 'tick', args: ['0'], value: 0n,
  }));
  await settle(asKeeper, tickHash, `tick ${attempts + 1}`);
  const seen = JSON.parse(await anybody.readContract({
    address: TOKEN, functionName: 'rules_view', args: [],
  }));
  verdict = seen.rules[0];
  say('  testnet says ' + verdict.state);
  if (verdict.state === 'FIRED') break;
}
attempts += 1;

const rules = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'rules_view', args: [],
}));
const status = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'status', args: [],
}));

say('');
say('  supply   ' + status.supply);
say('  bounty   ' + rules.bounty);
say('  because  ' + rules.rules[0].why);
say('  quoting  ' + JSON.stringify(rules.rules[0].quote));
say('  rounds   ' + attempts);

const checks = [
  ['it deploys on testnet', !!TOKEN],
  ['the bounty can be funded there', rules.bounty_ever_funded === BOUNTY.toString()],
  ['a rule fires there', rules.rules[0].state === 'FIRED'],
  ['and the burn came out of the supply', status.supply !== '1000000'],
];
say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. The interface can be built on a network wallets reach.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'testnet.json'), JSON.stringify({
  proved_at: new Date().toISOString(), chain: 'genlayer testnet asimov',
  token: TOKEN, rounds_needed: attempts, rules, status,
  checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
say('');
say('Written to results/testnet.json');
process.exit(failed.length ? 1 : 0);
