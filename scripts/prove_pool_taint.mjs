// The badge must not catch the buyers.
//
//   node scripts/prove_pool_taint.mjs
//
// The slow exit follows the tokens, which is what stops a creator moving the bag
// to a fresh wallet and selling from there. Followed literally it also destroys
// the token: the creator adds liquidity, the pool is marked because it received
// from a marked address, and then the pool marks every buyer it ever sells to.
// Everybody who bought would be held to the creator's limits.
//
// That failure is invisible in every test that has no pool, which is every test
// this project had until now. So this one has a pool, and asks the question
// that matters: after a real buy through Uniswap, is the buyer free?
//
// It also checks the other half still works, because the fix could easily have
// bought a usable token by making the badge do nothing.
import { Wallet, JsonRpcProvider, Contract, Interface } from 'ethers';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const tokArt = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CharterToken.json'), 'utf8'));
const padArt = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CharterLaunchpad.json'), 'utf8'));

const ROUTER = '0x1689E7B1F10000AE47eBfE339a4f69dECd19F602';
const FACTORY = '0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e';
const WETH = '0x4200000000000000000000000000000000000006';

const ROUTER_ABI = [
  'function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) payable returns (uint,uint,uint)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin,address[] path,address to,uint deadline) payable',
];
const FACTORY_ABI = ['function getPair(address,address) view returns (address)'];

const provider = new JsonRpcProvider(process.env.BASE_RPC || 'https://sepolia.base.org');
const creator = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv)).connect(provider);
// Somebody who buys from the pool like anybody else, and has never had
// anything from the creator.
const buyer = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub)).connect(provider);

const WHOLE = 1_000_000n;
const INTO_POOL = 300_000n;
const ETH_IN = 400_000_000_000_000n;   // 0.0004
const BUY_WITH = 20_000_000_000_000n;  // 0.00002
const DEAD = '0x000000000000000000000000000000000000dEaD';

const iface = new Interface(tokArt.abi);

async function untilVisible(address) {
  for (let i = 0; i < 30; i++) {
    if ((await provider.getCode(address)) !== '0x') return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('no code at ' + address);
}
async function untilSeen(read, atLeast) {
  for (let i = 0; i < 30; i++) {
    if ((await read()) >= atLeast) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('never became visible');
}

say('A token with the badge on, and a real pool in front of it.');
say('');
say('  creator ' + creator.address);
say('  buyer   ' + buyer.address);
say('');

// Launched through the launchpad, so this is the token a person would get.
const launchpad = new Contract(
  process.env.LAUNCHPAD || '0x6fFbf8e8F6986ea7b65A0bfDdD8D984e6Fcff0E3',
  padArt.abi, creator);
say('  launchpad ' + await launchpad.getAddress());

// No ceiling here: it would keep the creator from holding enough to seed a
// pool, and what is being tested is the taint rather than the ceiling.
let TOKEN = process.argv[2];
if (!TOKEN) {
  const tx = await launchpad.launch('Pool Taint', 'PTNT', WHOLE, 0n, {
    creatorCeilingBps: 0n, slowExitBps: 5000n, slowExitWindow: 3600n,
    taintFollows: true,
  });
  const receipt = await tx.wait();
  const ev = receipt.logs
    .map(l => { try { return launchpad.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === 'Launched');
  TOKEN = ev.args.token;
}
say('  token ' + TOKEN);
await untilVisible(TOKEN);

const token = new Contract(TOKEN, tokArt.abi, creator);
const amount = INTO_POOL * 10n ** 18n;

const router = new Contract(ROUTER, ROUTER_ABI, creator);
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 900);
const factoryEarly = new Contract(FACTORY, FACTORY_ABI, provider);

if (/^0x0+$/.test(await factoryEarly.getPair(TOKEN, WETH))) {
  say('');
  say('The creator seeds a pool, which is a transfer to a contract.');
  await (await token.approve(ROUTER, amount)).wait();
  await untilSeen(() => token.allowance(creator.address, ROUTER), amount);
  await (await router.addLiquidityETH(
    TOKEN, amount, amount, ETH_IN, DEAD, deadline(), { value: ETH_IN })).wait();
} else {
  say('');
  say('The pool is already there from an earlier run.');
}

const factory = new Contract(FACTORY, FACTORY_ABI, provider);
// Asked until it answers. A pair read the instant it is created comes back as
// the zero address from any node a block behind, and that reads as "the pool
// was never made" rather than "ask again".
let PAIR = '0x0000000000000000000000000000000000000000';
for (let i = 0; i < 30 && /^0x0+$/.test(PAIR); i++) {
  PAIR = await factory.getPair(TOKEN, WETH);
  if (/^0x0+$/.test(PAIR)) await new Promise(r => setTimeout(r, 2000));
}
await untilVisible(PAIR);
say('  pair ' + PAIR);
const pairMarked = await token.restricted(PAIR);
say('  is the pool marked as the creator\'s? ' + pairMarked);

say('');
say('Then somebody buys through it, the way anybody would.');
const beforeBuy = await token.balanceOf(buyer.address);
await (await router.connect(buyer)
  .swapExactETHForTokensSupportingFeeOnTransferTokens(
    0n, [WETH, TOKEN], buyer.address, deadline(), { value: BUY_WITH })).wait();
await untilSeen(() => token.balanceOf(buyer.address), beforeBuy + 1n);
const bought = await token.balanceOf(buyer.address);
say('  the buyer now holds ' + bought);
const buyerMarked = await token.restricted(buyer.address);
say('  is the buyer marked? ' + buyerMarked);

say('');
say('The buyer sells the lot straight back, which a marked address could not.');
let buyerFree = true;
try {
  await token.connect(buyer).transfer.staticCall(DEAD, bought);
} catch (e) {
  buyerFree = false;
  say('  refused: ' + String(e.shortMessage || e.message).slice(0, 100));
}
if (buyerFree) say('  went through, so the buyer is under no limit');

say('');
say('And the badge still works where it should: creator to a plain wallet.');
const third = '0xbdb591cddd787956a4fb17a8f4c325366525efd2';
const small = 1000n * 10n ** 18n;
await (await token.transfer(third, small)).wait();
await untilSeen(() => token.balanceOf(third), small);
const walletMarked = await token.restricted(third);
say('  a wallet the creator paid is marked? ' + walletMarked);

const checks = [
  ['the pool is not marked by receiving from the creator', pairMarked === false],
  ['so a buyer is not marked by buying from the pool', buyerMarked === false],
  ['and the buyer can move everything they bought', buyerFree],
  ['while a plain wallet the creator paid is still marked', walletMarked === true],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length
  ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. The badge catches the creator and lets the market alone.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'pool_taint.json'), JSON.stringify({
  proved_at: new Date().toISOString(), chain: 'base sepolia',
  token: TOKEN, pair: PAIR, creator: creator.address, buyer: buyer.address,
  pair_marked: pairMarked, buyer_marked: buyerMarked, wallet_marked: walletMarked,
  checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
say('');
say('Written to results/pool_taint.json');
process.exit(failed.length ? 1 : 0);
