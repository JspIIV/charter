// A verdict reached on GenLayer, landing on an ERC-20 on Base Sepolia.
//
//   node scripts/prove_cross_chain.mjs
//
// The rules need a network that can read a web page and hold a round of
// validators to a single word. The token needs to be a thing a wallet shows and
// an exchange can list. No one chain is both, so the token is an ordinary ERC-20
// on Base Sepolia and the judgement is made on GenLayer, and a carrier walks the
// decision across.
//
// The carrier is the weak part and is treated as such. It never carries an
// amount or a destination: those were written into the ERC-20 at deployment. It
// carries a rule index and the words the round used. What it can do wrong is
// fire a rule GenLayer has not fired, which this script also tests the bounds
// of, and which anybody can catch by reading the GenLayer side.
import { Wallet, JsonRpcProvider, ContractFactory, Contract } from 'ethers';
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

const BASE_RPC = process.env.BASE_RPC || 'https://sepolia.base.org';
const artifact = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'build', 'CharterToken.json'), 'utf8'));

const creatorKey = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const keeperKey = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub);

const provider = new JsonRpcProvider(BASE_RPC);
const creator = creatorKey.connect(provider);
// The same key carries the decision here. It is a separate role and the
// contract treats it as one: what follows tests that the role, not the person,
// is what the contract enforces.
const carrier = creator;
const outsider = keeperKey.connect(provider);

const asCreator = createClient({ chain: studionet, account: createAccount(creatorKey.privateKey) });
const asKeeper = createClient({ chain: studionet, account: createAccount(keeperKey.privateKey) });
const anybody = createClient({ chain: studionet });

const PAGE = 'https://gist.githubusercontent.com/JspIIV/'
  + '2ff5af1cd421395420c9ec33b9ecbebf/raw/claim_false.txt';
const CONDITION = 'the page states that a security certificate has expired';
const BURN_AMOUNT = 40000n;
const SUPPLY = 1000000n;
const SHARE = 30n;
const BOUNTY = 2_000_000_000_000_000n;

const RULES = JSON.stringify([{
  when: CONDITION, url: PAGE, then: 'BURN', amount: Number(BURN_AMOUNT),
}]);

async function settle(client, hash, what) {
  const started = Date.now();
  const receipt = await client.waitForTransactionReceipt({
    hash, status: 'FINALIZED', retries: 160, interval: 12000,
  });
  say(`  ${what} finalized in ${Math.round((Date.now() - started) / 1000)}s`);
  return receipt;
}

say('charter.fun across two chains.');
say('');
say('  judgement on  GenLayer Studionet');
say('  money on      Base Sepolia');
say('  creator       ' + creator.address);
say('  carrier       ' + carrier.address);
say('  outsider      ' + outsider.address);
say('');

// ------------------------------------------------- the rules, where they can be judged

say('Deploying the rules on GenLayer.');
const genHash = await asCreator.deployContract({
  code: fs.readFileSync(path.join(ROOT, 'contracts', 'token.py')),
  args: ['Charter Cross', 'XCHT', String(SUPPLY), String(SHARE), RULES, creator.address],
  leaderOnly: false,
});
const genDeployed = await asCreator.waitForTransactionReceipt({
  hash: genHash, status: 'FINALIZED', retries: 160, interval: 12000,
});
const GEN_TOKEN = genDeployed?.data?.contract_address;
say('  genlayer token ' + GEN_TOKEN);

// -------------------------------------------------- the token, where it can be held

say('');
say('Deploying the ERC-20 on Base Sepolia, with the same rules and their');
say('amounts fixed in it. The carrier never supplies an amount.');
const factory = new ContractFactory(artifact.abi, artifact.bytecode, creator);
const erc20 = await factory.deploy(
  'Charter Cross', 'XCHT', SUPPLY, SHARE,
  creator.address, carrier.address,
  GEN_TOKEN, 'genlayer studionet',
  { conditions: [CONDITION], urls: [PAGE], actions: [0], amounts: [BURN_AMOUNT] },
);
await erc20.waitForDeployment();
const ERC20 = await erc20.getAddress();
say('  erc20 ' + ERC20);
say('  supply ' + (await erc20.totalSupply()) + ', treasury ' + (await erc20.treasury())
  + ', creator holds ' + (await erc20.balanceOf(creator.address)));

// ----------------------------------------------------------- the judgement

say('');
say('Funding the bounty and letting somebody who is not the creator call tick.');
const fundHash = await asCreator.writeContract({
  address: GEN_TOKEN, functionName: 'fund', args: [], value: BOUNTY,
});
await settle(asCreator, fundHash, 'fund');

const tickHash = await asKeeper.writeContract({
  address: GEN_TOKEN, functionName: 'tick', args: ['0'], value: 0n,
});
await settle(asKeeper, tickHash, 'tick');

const decided = JSON.parse(await anybody.readContract({
  address: GEN_TOKEN, functionName: 'rules_view', args: [],
}));
const verdict = decided.rules[0];
say('  genlayer says ' + verdict.state);
say('  because       ' + verdict.why);
say('  quoting       ' + JSON.stringify(verdict.quote));

// -------------------------------------------------------------- the carrier

say('');
say('The carrier reads that off GenLayer and delivers it. It sends a rule index');
say('and the words the round used. Nothing else.');

const beforeSupply = await erc20.totalSupply();
if (verdict.state !== 'FIRED') {
  say('  nothing to carry: the rule did not fire');
}
const fireTx = await erc20.connect(carrier).fire(0, verdict.why || '', verdict.quote || '');
const fireReceipt = await fireTx.wait();
say('  fire mined in block ' + fireReceipt.blockNumber
  + ', ' + fireReceipt.gasUsed + ' gas');

const afterSupply = await erc20.totalSupply();
const landed = await erc20.ruleAt(0);
say('');
say('  supply   ' + beforeSupply + ' -> ' + afterSupply);
say('  treasury ' + (await erc20.treasury()));
say('  rule 0   fired=' + landed[4] + ' why=' + JSON.stringify(landed[6]));

// -------------------------------------------------- what the carrier cannot do

say('');
say('What the carrier cannot do, tried rather than asserted.');

let secondFire = 'went through';
try {
  await (await erc20.connect(carrier).fire(0, 'again', '')).wait();
} catch (e) {
  secondFire = 'refused: ' + (e.shortMessage || e.message).slice(0, 80);
}
say('  firing the same rule twice: ' + secondFire);

let outsiderFire = 'went through';
try {
  await (await erc20.connect(outsider).fire(0, 'me', '')).wait();
} catch (e) {
  outsiderFire = 'refused: ' + (e.shortMessage || e.message).slice(0, 80);
}
say('  firing from an address that is not the carrier: ' + outsiderFire);

// The ERC-20 is a real one, so this is worth showing rather than claiming.
say('');
say('And it is an ordinary token while all this is happening.');
const sendTx = await erc20.connect(creator).transfer(outsider.address, 1000n);
await sendTx.wait();
say('  transferred 1000 to ' + outsider.address);

const checks = [
  ['genlayer reached a verdict', verdict.state === 'FIRED'],
  ['the burn landed on the erc20, for the amount written at deployment',
    beforeSupply - afterSupply === BURN_AMOUNT],
  ['the treasury paid for it', (await erc20.treasury()) === (SUPPLY * SHARE / 100n) - BURN_AMOUNT],
  ['no holder lost anything',
    (await erc20.balanceOf(creator.address)) === SUPPLY - (SUPPLY * SHARE / 100n) - 1000n],
  ['the reasoning crossed with it', landed[6] === (verdict.why || '')],
  ['and the words the round quoted', landed[7] === (verdict.quote || '')],
  ['the erc20 names the genlayer contract it answers to',
    (await erc20.genlayerToken()).toLowerCase() === String(GEN_TOKEN).toLowerCase()],
  ['a second firing is refused', secondFire.startsWith('refused')],
  ['a firing from anybody but the carrier is refused', outsiderFire.startsWith('refused')],
  ['and it is an ordinary erc20 throughout',
    (await erc20.balanceOf(outsider.address)) === 1000n],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length
  ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. The verdict was made where it could be, and landed`);
if (!failed.length) say('where the money is.');

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'cross_chain.json'), JSON.stringify({
  proved_at: new Date().toISOString(),
  genlayer: { chain: 'studionet', token: GEN_TOKEN, verdict },
  evm: {
    chain: 'base sepolia', token: ERC20,
    supply_before: beforeSupply.toString(), supply_after: afterSupply.toString(),
    treasury_after: (await erc20.treasury()).toString(),
    fire_tx: fireTx.hash, fire_block: fireReceipt.blockNumber,
    gas_used: fireReceipt.gasUsed.toString(),
  },
  carrier: carrier.address,
  carrier_bounds: { second_firing: secondFire, from_an_outsider: outsiderFire },
  caveat: 'the carrier can deliver a firing genlayer has not made; it cannot choose '
    + 'an amount or a destination, and the genlayer side is public so a false '
    + 'delivery is checkable by anybody',
  checks: checks.map(([label, ok]) => ({ label, ok })),
  transcript: out,
}, null, 2));
say('');
say('Written to results/cross_chain.json');
process.exit(failed.length ? 1 : 0);
