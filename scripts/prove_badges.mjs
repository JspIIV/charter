// The badges, on Base Sepolia, tried rather than asserted.
//
//   node scripts/prove_badges.mjs
//
// The one that matters is the wallet hop. Every launchpad caps what the
// creator's address can do, and every creator escapes it the same way: send the
// bag to a fresh wallet and sell from there. So the cap here is on moving, not
// on selling, and anybody the creator sends to inherits it.
//
// What follows tries the escape rather than claiming it is closed.
import { Wallet, JsonRpcProvider, ContractFactory, Interface } from 'ethers';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const BASE_RPC = process.env.BASE_RPC || 'https://sepolia.base.org';
const artifact = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'build', 'CharterToken.json'), 'utf8'));

const provider = new JsonRpcProvider(BASE_RPC);
const creator = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv)).connect(provider);
// A wallet the creator funds later, standing in for the fresh one a creator
// would reach for. Its address is not known to the contract at launch.
const sock = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub)).connect(provider);
const buyer = '0x000000000000000000000000000000000000dEaD';

const SUPPLY = 1_000_000n;
const SHARE = 0n;                 // no treasury: this is about the badges
const CEILING_BPS = 500n;         // creator may hold at most 5%
const SLOW_BPS = 500n;            // and move at most 5% of it per window
const WINDOW = 3600n;             // an hour

const noRules = { conditions: [], urls: [], actions: [], amounts: [] };

async function untilVisible(address) {
  for (let i = 0; i < 30; i++) {
    if ((await provider.getCode(address)) !== '0x') return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('no code at ' + address);
}

/** The public endpoint is a pool, so a read issued straight after a write can
 *  land on a node a block or two behind and answer from the old state. Here
 *  that does not just misreport a number: the next call reverts with "balance"
 *  and the run reads as a badge refusing something it never saw. */
async function untilBalance(contract, who, expected) {
  for (let i = 0; i < 30; i++) {
    if ((await contract.balanceOf(who)) === expected) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('balance never caught up for ' + who);
}

const iface = new Interface(artifact.abi);

/** Tries something that should be refused, and reports why.
 *
 *  Reporting only that it was refused is not enough. A transfer rejected for
 *  insufficient balance looks exactly like one rejected by a badge, and a limit
 *  that refuses for the wrong reason is not the limit working. So the revert
 *  data is decoded against the ABI and the caller says which error it expected.
 */
async function refused(what, expected, contract, signer, to, amount) {
  // Simulated with an eth_call, because that is what reliably carries revert
  // data back. A failed send sometimes returns the reason and sometimes does
  // not, and a proof that says "refused, reason unknown" cannot tell a badge
  // doing its job from a transfer that simply ran out of balance.
  let named = null;
  try {
    await contract.connect(signer).transfer.staticCall(to, amount);
    say('  WENT THROUGH  ' + what + '  (it did not revert at all)');
    return false;
  } catch (e) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
    if (data && data !== '0x') {
      try { named = iface.parseError(data)?.name ?? null; } catch { named = null; }
    }
    if (!named) {
      const m = /(OverCreatorCeiling|MovingTooFast)/.exec(
        String(e.shortMessage || e.message));
      named = m ? m[1] : null;
    }
  }
  if (named !== expected) {
    say(`  refused for the WRONG reason  ${what}`);
    say(`                  wanted ${expected}, got ${named || 'an undecodable revert'}`);
    return false;
  }
  say(`  refused       ${what}  (${named})`);
  return true;
}

say('charter.fun badges, on Base Sepolia.');
say('');
say('  creator     ' + creator.address);
say('  fresh wallet ' + sock.address);
say('');
say('  badges: creator may hold at most 5% of supply, and may move at most 5%');
say('  of what it holds per hour, counting every outgoing transfer. Anybody the');
say('  creator sends to inherits both.');
say('');

// The creator starts with the whole supply, which is above its own ceiling.
// That is deliberate: the ceiling binds what can come in, so a launch that
// hands the creator everything is exactly the case where it has to work on the
// way out rather than the way in.
const factory = new ContractFactory(artifact.abi, artifact.bytecode, creator);
const token = await factory.deploy(
  'Badge Test', 'BDG', SUPPLY, SHARE,
  creator.address, creator.address,
  '0x0000000000000000000000000000000000000000', 'none',
  noRules,
  { creatorCeilingBps: CEILING_BPS, slowExitBps: SLOW_BPS,
    slowExitWindow: WINDOW, taintFollows: true },
);
await token.waitForDeployment();
const ADDRESS = await token.getAddress();
say('  token ' + ADDRESS);
await untilVisible(ADDRESS);

const held = await token.balanceOf(creator.address);
const allowance = (held * SLOW_BPS) / 10000n;
say('  creator holds ' + held + ', so 5% of that is ' + allowance + ' an hour');
say('');

say('The creator tries to leave in one transaction.');
const dumpRefused = await refused('sending the whole bag at once', 'MovingTooFast',
  token, creator, buyer, held);

say('');
say('Then within the limit, which is allowed.');
let withinOk = true;
try {
  await (await token.connect(creator).transfer(sock.address, allowance)).wait();
  await untilBalance(token, sock.address, allowance);
  say('  went through   sending exactly the hourly allowance');
} catch (e) {
  withinOk = false;
  say('  FAILED         sending exactly the hourly allowance: '
    + String(e.shortMessage || e.message).slice(0, 90));
}

say('');
say('And again in the same hour, which is not.');
const secondRefused = await refused('a second transfer in the same window',
  'MovingTooFast', token, creator, buyer, allowance);

say('');
say('Now the escape everybody uses: the fresh wallet sells instead.');
const sockHolds = await token.balanceOf(sock.address);
say('  the fresh wallet holds ' + sockHolds + ' and was never named at launch');
const isRestricted = await token.restricted(sock.address);
say('  the contract marked it as the creator\'s: ' + isRestricted);
const hopRefused = await refused('the fresh wallet sending its whole balance',
  'MovingTooFast', token, sock, buyer, sockHolds);

say('');
say('The ceiling needs its own token, and the reason is worth knowing.');
say('On the one above, every holder counts as the creator, so the sender own');
say('limit fires before the recipient ceiling is ever reached. That ordering is');
say('right; it just means the ceiling has to be tried where nothing else bites.');

const plain = await factory.deploy(
  'Ceiling Test', 'CEIL', SUPPLY, SHARE,
  creator.address, creator.address,
  '0x0000000000000000000000000000000000000000', 'none',
  noRules,
  { creatorCeilingBps: CEILING_BPS, slowExitBps: 0n,
    slowExitWindow: 0n, taintFollows: false },
);
await plain.waitForDeployment();
const PLAIN = await plain.getAddress();
await untilVisible(PLAIN);
say('  token ' + PLAIN);

const ceiling = (SUPPLY * CEILING_BPS) / 10000n;
say('  the creator may hold at most ' + ceiling);

// Out to an ordinary holder first, which the ceiling does not stop: it binds
// what comes in to the creator, not what leaves.
await (await plain.connect(creator).transfer(sock.address, SUPPLY)).wait();
await untilBalance(plain, sock.address, SUPPLY);
say('  the creator sent everything away, which the ceiling does not stop');

const ceilingRefused = await refused('sending it all back to the creator',
  'OverCreatorCeiling', plain, sock, creator.address, SUPPLY);

let underCeilingOk = true;
try {
  await (await plain.connect(sock).transfer(creator.address, ceiling)).wait();
  say('  went through   sending exactly the ceiling');
} catch (e) {
  underCeilingOk = false;
  say('  FAILED         sending exactly the ceiling: '
    + String(e.shortMessage || e.message).slice(0, 90));
}

const view = await token.badgeView(creator.address);

const checks = [
  ['the creator cannot leave in one transaction, and the contract says why',
    dumpRefused],
  ['but can move its hourly allowance', withinOk],
  ['and not twice in the same hour', secondRefused],
  ['a wallet the creator funded is marked as the creator\'s', isRestricted === true],
  ['and cannot dump either, so the wallet hop buys nothing', hopRefused],
  ['the creator cannot be given more than its ceiling', ceilingRefused],
  ['but can be given exactly the ceiling', underCeilingOk],
  ['and a reader can see what is movable right now', view[5] !== undefined],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length
  ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. Every limit was tried, not asserted.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'badges.json'), JSON.stringify({
  proved_at: new Date().toISOString(),
  chain: 'base sepolia', token: ADDRESS, ceiling_token: PLAIN,
  creator: creator.address, fresh_wallet: sock.address,
  badges: { creatorCeilingBps: String(CEILING_BPS), slowExitBps: String(SLOW_BPS),
            slowExitWindow: String(WINDOW), taintFollows: true },
  checks: checks.map(([label, ok]) => ({ label, ok })),
  transcript: out,
}, null, 2));
say('');
say('Written to results/badges.json');
process.exit(failed.length ? 1 : 0);
