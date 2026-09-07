// The launchpad on Base Sepolia: launching one, and finding it afterwards.
//
//   node scripts/prove_launchpad_evm.mjs [existing launchpad address]
//
// The point of a launchpad over deploying from a browser is that a launch is
// findable and that the arguments are the arguments. So what is checked here is
// that a stranger's launch lands in the list, that the token it produced holds
// the badges that were asked for, and that the launchpad has no reach into it
// afterwards.
import { Wallet, JsonRpcProvider, ContractFactory, Contract } from 'ethers';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = [];
const say = line => { console.log(line); out.push(line); };

const pad = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CharterLaunchpad.json'), 'utf8'));
const tok = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CharterToken.json'), 'utf8'));

const provider = new JsonRpcProvider(process.env.BASE_RPC || 'https://sepolia.base.org');
const owner = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv)).connect(provider);
// Somebody who did not deploy the launchpad and has no relationship to it.
const stranger = (await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub)).connect(provider);

async function untilVisible(address) {
  for (let i = 0; i < 30; i++) {
    if ((await provider.getCode(address)) !== '0x') return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('no code at ' + address);
}

say('charter.fun launchpad, on Base Sepolia.');
say('');
say('  deployed by  ' + owner.address);
say('  launching as ' + stranger.address);
say('');

let LAUNCHPAD = process.argv[2];
if (!LAUNCHPAD) {
  const factory = new ContractFactory(pad.abi, pad.bytecode, owner);
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();
  LAUNCHPAD = await deployed.getAddress();
  await untilVisible(LAUNCHPAD);
}
say('  launchpad ' + LAUNCHPAD);

const asStranger = new Contract(LAUNCHPAD, pad.abi, stranger);
const reading = new Contract(LAUNCHPAD, pad.abi, provider);

const before = await reading.count();
say('  the list holds ' + before + ' launch(es) before this');
say('');

say('A stranger launches, ticking two badges.');
const BADGES = {
  creatorCeilingBps: 500n,     // 5%
  slowExitBps: 500n,           // 5% an hour
  slowExitWindow: 3600n,
  taintFollows: true,
};
const tx = await asStranger.launch('Listed Coin', 'LIST', 1_000_000n, 0n, BADGES);
const receipt = await tx.wait();
say('  mined in block ' + receipt.blockNumber + ', ' + receipt.gasUsed + ' gas');

// The address comes off the event rather than a return value, because a
// transaction does not hand its return value back to the caller.
const event = receipt.logs
  .map(l => { try { return reading.interface.parseLog(l); } catch { return null; } })
  .find(e => e && e.name === 'Launched');
const TOKEN = event?.args?.token;
say('  token ' + TOKEN);
await untilVisible(TOKEN);

const after = await reading.count();
const listed = await reading.page(0, 5);
const newest = listed[0][0];

const token = new Contract(TOKEN, tok.abi, provider);
const [name, symbol, supply, creator, badges, treasury] = await Promise.all([
  token.name(), token.symbol(), token.totalSupply(), token.owner(),
  token.badges(), token.treasury(),
]);
const creatorHolds = await token.balanceOf(creator);

say('');
say('  listed as     ' + newest.name + ' (' + newest.symbol + ')');
say('  its creator   ' + newest.creator);
say('  badges on it  ceiling ' + badges[0] + 'bps, slow exit ' + badges[1]
  + 'bps per ' + badges[2] + 's, taint ' + badges[3]);
say('  creator holds ' + creatorHolds + ', token holds ' + treasury);

const ceiling = (supply * badges[0]) / 10000n;

const checks = [
  ['the launch landed in the list', after === before + 1n],
  ['newest first, so the top of the list is the last launch',
    newest.token.toLowerCase() === String(TOKEN).toLowerCase()],
  ['the token names the stranger as creator, not the launchpad',
    String(creator).toLowerCase() === stranger.address.toLowerCase()],
  ['and the launchpad holds none of it',
    (await token.balanceOf(LAUNCHPAD)) === 0n],
  ['the badges asked for are the badges on it',
    badges[0] === BADGES.creatorCeilingBps && badges[1] === BADGES.slowExitBps
    && badges[2] === BADGES.slowExitWindow && badges[3] === BADGES.taintFollows],
  ['the ceiling bound at launch, so the badge is true on day one',
    creatorHolds === ceiling && treasury === supply - ceiling],
  ['the creator is under the limits from the first block',
    (await token.restricted(creator)) === true],
  ['and a stranger can find it all by index, with no account',
    (await reading.launchAt(after - 1n)).token.toLowerCase()
      === String(TOKEN).toLowerCase()],
  ['the creator\'s own history is one call',
    (await reading.countByCreator(stranger.address)) > 0n],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length
  ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. A launch anybody can make, and anybody can find.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'launchpad_evm.json'), JSON.stringify({
  proved_at: new Date().toISOString(), chain: 'base sepolia',
  launchpad: LAUNCHPAD, token: TOKEN,
  launched_by: stranger.address, deployed_by: owner.address,
  gas_used: receipt.gasUsed.toString(),
  badges: Object.fromEntries(Object.entries(BADGES).map(([k, v]) => [k, String(v)])),
  checks: checks.map(([label, ok]) => ({ label, ok })),
  transcript: out,
}, null, 2));
say('');
say('Written to results/launchpad_evm.json');
process.exit(failed.length ? 1 : 0);
