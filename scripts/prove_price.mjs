// A pool, and therefore a price.
//
//   node scripts/prove_price.mjs
//
// Until somebody makes a market there is no price, and the app says so rather
// than inventing one. This makes the market, so that the other half can be
// checked against something real: launch a token, put it and some ETH into a
// Uniswap v2 pair, and read the price back off the reserves.
//
// It also answers a question the badges raise. Adding liquidity is an outgoing
// transfer from the creator, so a creator who ticked the slow exit can only
// move their allowance into the pool at a time. That is the badge working, not
// a bug, and it is worth knowing before somebody ticks it and then cannot open
// a pool in one go.
import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const pad = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CharterLaunchpad.json'), 'utf8'));
const tokArt = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CharterToken.json'), 'utf8'));

const LAUNCHPAD = process.env.LAUNCHPAD || '0xB8688c7f31580EbF0A55d14534C2863b8Ed89709';
const ROUTER = '0x1689E7B1F10000AE47eBfE339a4f69dECd19F602';
const FACTORY = '0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e';
const WETH = '0x4200000000000000000000000000000000000006';

const ROUTER_ABI = [
  'function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) payable returns (uint amountToken,uint amountETH,uint liquidity)',
];
const FACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const provider = new JsonRpcProvider(process.env.BASE_RPC || 'https://sepolia.base.org');
const creator = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv)).connect(provider);

const SUPPLY = 1_000_000n;               // whole tokens, as the launch asks
const INTO_POOL = 400_000n;              // whole tokens
const ETH_IN = 500_000_000_000_000n;     // 0.0005 ETH
const DEAD = '0x000000000000000000000000000000000000dEaD';

async function untilVisible(address) {
  for (let i = 0; i < 30; i++) {
    if ((await provider.getCode(address)) !== '0x') return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('no code at ' + address);
}

/** The public endpoint is a pool of nodes, so a write is not visible to all of
 *  them at once. Adding liquidity right after approving means the gas estimate
 *  can be answered by a node that has not seen the approval, and the router
 *  reports it as transferFrom failing, which reads as the token refusing rather
 *  than the node being behind. */
async function untilSeen(what, read, expected) {
  for (let i = 0; i < 30; i++) {
    if ((await read()) >= expected) return;
    if (i === 0) say('  waiting for the rpc to catch up with the ' + what);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(what + ' never became visible');
}

say('charter.fun: making a market so there is a price to show.');
say('');

let TOKEN = process.argv[2];
if (!TOKEN) {
  // No badges on this one. A slow exit would cap what can go into the pool in
  // one transaction, which is the badge doing its job and the wrong thing to be
  // testing here.
  const launchpad = new Contract(LAUNCHPAD, pad.abi, creator);
  const tx = await launchpad.launch('Priced Coin', 'PRCD', SUPPLY, 0n, {
    creatorCeilingBps: 0n, slowExitBps: 0n, slowExitWindow: 0n, taintFollows: false,
  });
  const receipt = await tx.wait();
  const event = receipt.logs
    .map(l => { try { return launchpad.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === 'Launched');
  TOKEN = event.args.token;
}
say('  token ' + TOKEN);
await untilVisible(TOKEN);

const token = new Contract(TOKEN, tokArt.abi, creator);
const decimals = await token.decimals();
const amount = INTO_POOL * 10n ** BigInt(decimals);

say('  approving the router for ' + INTO_POOL + ' tokens');
await (await token.approve(ROUTER, amount)).wait();
await untilSeen('approval',
  () => token.allowance(creator.address, ROUTER), amount);
await untilSeen('balance',
  () => token.balanceOf(creator.address), amount);

say('  adding liquidity: ' + INTO_POOL + ' tokens and 0.0005 ETH');
const router = new Contract(ROUTER, ROUTER_ABI, creator);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
// The LP tokens go straight to the dead address. Burning them is what makes
// "the liquidity cannot be pulled" a fact somebody can check with one balance
// read rather than a promise.
const added = await (await router.addLiquidityETH(
  TOKEN, amount, amount, ETH_IN, DEAD, deadline, { value: ETH_IN },
)).wait();
say('  mined in block ' + added.blockNumber + ', ' + added.gasUsed + ' gas');

const factory = new Contract(FACTORY, FACTORY_ABI, provider);
const pairAddress = await factory.getPair(TOKEN, WETH);
say('  pair ' + pairAddress);
await untilVisible(pairAddress);

const pair = new Contract(pairAddress, PAIR_ABI, provider);
const [reserves, token0, lpTotal, lpBurned] = await Promise.all([
  pair.getReserves(), pair.token0(), pair.totalSupply(), pair.balanceOf(DEAD),
]);
const tokenIsFirst = String(token0).toLowerCase() === TOKEN.toLowerCase();
const tokensInPool = tokenIsFirst ? reserves[0] : reserves[1];
const ethInPool = tokenIsFirst ? reserves[1] : reserves[0];
const priceWei = ethInPool / (tokensInPool / 10n ** BigInt(decimals));

say('');
say('  in the pool   ' + (tokensInPool / 10n ** BigInt(decimals)) + ' tokens, '
  + ethInPool + ' wei');
say('  price         ' + priceWei + ' wei per token');
say('  LP total      ' + lpTotal + ', of which burned ' + lpBurned);

// Uniswap permanently locks the first 1000 LP tokens itself, so the burned
// share is everything except those.
const checks = [
  ['a pair exists for this token', !!pairAddress && !/^0x0+$/.test(pairAddress)],
  ['it holds the tokens that went in', tokensInPool === amount],
  ['and the ETH', ethInPool === ETH_IN],
  ['there is a price, read from the reserves', priceWei > 0n],
  ['every LP token minted to us was burned', lpBurned === lpTotal - 1000n],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length
  ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. There is a market now, so there is a price to read.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'price.json'), JSON.stringify({
  proved_at: new Date().toISOString(), chain: 'base sepolia',
  token: TOKEN, pair: pairAddress, launchpad: LAUNCHPAD,
  tokens_in_pool: tokensInPool.toString(), eth_in_pool: ethInPool.toString(),
  price_wei_per_token: priceWei.toString(),
  lp_total: lpTotal.toString(), lp_burned: lpBurned.toString(),
  checks: checks.map(([label, ok]) => ({ label, ok })),
  transcript: out,
}, null, 2));
say('');
say('Written to results/price.json');
process.exit(failed.length ? 1 : 0);
