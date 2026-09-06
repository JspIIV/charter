// The factory, on chain, end to end.
//
//   node scripts/prove_launchpad.mjs
//
// Deploys the launchpad from one account, then launches a token from a
// different one, then reads the token back with no account at all. What is
// being proved is that the token a stranger gets out of the factory is the same
// token this repository tests, and that it belongs to the person who launched
// it rather than to the factory that deployed it.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const owner = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const stranger = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub);

const asOwner = createClient({ chain: studionet, account: createAccount(owner.privateKey) });
const asStranger = createClient({ chain: studionet, account: createAccount(stranger.privateKey) });
const anybody = createClient({ chain: studionet });

const wait = ms => new Promise(r => setTimeout(r, ms));

async function settle(client, hash, what) {
  const started = Date.now();
  const r = await client.waitForTransactionReceipt({
    hash, status: 'FINALIZED', retries: 160, interval: 12000,
  });
  say(`  ${what} finalized in ${Math.round((Date.now() - started) / 1000)}s`);
  return r;
}

const RULES = JSON.stringify([{
  when: 'the page states that a security certificate has expired',
  url: 'https://expired.badssl.com/',
  then: 'BURN',
  amount: 40000,
}]);

say('charter.fun launchpad, on GenLayer Studionet.');
say('');
say('  factory owner  ' + owner.address);
say('  launching as   ' + stranger.address);
say('');

const REUSE = process.argv[2] && process.argv[3];
if (REUSE) say('Reusing an existing launchpad and token; reading only.');

let LAUNCHPAD = process.argv[2];
let TOKEN = process.argv[3];

if (!REUSE) {
say('Deploying the launchpad.');
const deployHash = await asOwner.deployContract({
  code: fs.readFileSync(path.join(ROOT, 'contracts', 'launchpad.py')),
  args: [],
  leaderOnly: false,
});
const deployed = await settle(asOwner, deployHash, 'deploy');
LAUNCHPAD = deployed?.data?.contract_address;
say('  launchpad ' + LAUNCHPAD);
say('');

say('A stranger launches a token through it. The factory is the sender when it');
say('deploys, so the creator is passed in and has to survive the trip.');
const launchHash = await asStranger.writeContract({
  address: LAUNCHPAD,
  functionName: 'launch',
  args: ['Charter Coin', 'CHRT', '1000000', '30', RULES],
  value: 0n,
});
await settle(asStranger, launchHash, 'launch');

await wait(3000);
const size = JSON.parse(await anybody.readContract({
  address: LAUNCHPAD, functionName: 'size', args: [],
}));
say('  the launchpad reports ' + size.launched + ' launch(es)');

const record = JSON.parse(await anybody.readContract({
  address: LAUNCHPAD, functionName: 'launch_at', args: ['0'],
}));
TOKEN = record.launch.address;
say('  token ' + TOKEN);
say('');
}

say('Reading the token itself, with no account and no help from us.');
const status = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'status', args: [],
}));
const creatorHolds = await anybody.readContract({
  address: TOKEN, functionName: 'balance_of', args: [stranger.address],
});
const rules = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'rules_view', args: [],
}));

const checks = [
  ['the launchpad deployed a real contract', !!TOKEN && TOKEN !== LAUNCHPAD],
  ['the token names the stranger as creator, not the factory',
    String(status.creator).toLowerCase() === stranger.address.toLowerCase()],
  ['the stranger holds the supply, less the treasury',
    String(creatorHolds) === '700000'],
  ['the treasury is what was asked for', status.treasury === '300000'],
  ['the rule arrived intact', rules.rules.length === 1
    && rules.rules[0].when.includes('security certificate has expired')],
  ['and it is frozen', rules.frozen === true],
  ['and waiting, not quietly fired', rules.rules[0].state === 'WAITING'],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length
  ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. A stranger got the token this repository tests.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'launchpad.json'), JSON.stringify({
  proved_at: new Date().toISOString(),
  chain: 'genlayer studionet',
  launchpad: LAUNCHPAD,
  token: TOKEN,
  launched_by: stranger.address,
  factory_owner: owner.address,
  status, rules,
  checks: checks.map(([label, ok]) => ({ label, ok })),
  transcript: out,
}, null, 2));
say('');
say('Written to results/launchpad.json');
process.exit(failed.length ? 1 : 0);
