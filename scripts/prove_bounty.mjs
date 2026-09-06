// The bounty, on chain: real coin in, real coin out to whoever did the work.
//
//   node scripts/prove_bounty.mjs
//
// A keeper spends gas to call tick. Paid only in the token, before the token
// has a market, that is unpaid work, and unpaid work does not get done. So the
// bounty is held in the network's own coin. What has to be shown is not that
// the number in storage moved, but that a third party's actual balance went up
// by calling tick, and that nobody, the creator included, could have taken it
// back before they did.
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

const creator = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const keeper = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub);

const asCreator = createClient({ chain: studionet, account: createAccount(creator.privateKey) });
const asKeeper = createClient({ chain: studionet, account: createAccount(keeper.privateKey) });
const anybody = createClient({ chain: studionet });

async function settle(client, hash, what) {
  const started = Date.now();
  const receipt = await client.waitForTransactionReceipt({
    hash, status: 'FINALIZED', retries: 160, interval: 12000,
  });
  say(`  ${what} finalized in ${Math.round((Date.now() - started) / 1000)}s`);
  return receipt;
}

/** A rule that did not fire leaves no reason behind: the record only keeps one
 *  once there is a firing to attach it to. So when nothing fired, the receipt is
 *  the only place left to look, and it is dumped whole rather than picked at,
 *  because guessing which field holds the return payload is how a diagnostic
 *  ends up printing a number that means nothing. */
function receiptDump(receipt) {
  try { return JSON.stringify(receipt).slice(0, 600); }
  catch { return String(receipt); }
}

const BOUNTY = 2_000_000_000_000_000n;   // 0.002 GEN

const RULES = JSON.stringify([{
  when: 'the page states that a security certificate has expired',
  // A page that says so plainly. Pointing this at a site whose certificate has
  // actually expired proves nothing here: the fetch fails, the round reads
  // CANNOT_TELL, and what gets tested is the refusal rather than the payout.
  url: 'https://gist.githubusercontent.com/JspIIV/2ff5af1cd421395420c9ec33b9ecbebf/raw/claim_false.txt',
  then: 'BURN',
  amount: 40000,
}]);

say('charter.fun bounty, on GenLayer Studionet.');
say('');
say('  creator ' + creator.address);
say('  keeper  ' + keeper.address);
say('');

say('The creator launches a token and puts up the bounty.');
const deployHash = await asCreator.deployContract({
  code: fs.readFileSync(path.join(ROOT, 'contracts', 'token.py')),
  args: ['Bounty Coin', 'BNTY', '1000000', '30', RULES, creator.address],
  leaderOnly: false,
});
const deployed = await asCreator.waitForTransactionReceipt({
  hash: deployHash, status: 'FINALIZED', retries: 160, interval: 12000,
});
const TOKEN = deployed?.data?.contract_address;
say('  token ' + TOKEN);

const fundHash = await asCreator.writeContract({
  address: TOKEN, functionName: 'fund', args: [], value: BOUNTY,
});
await settle(asCreator, fundHash, 'fund');

const funded = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'rules_view', args: [],
}));
say('  the badge now reads bounty ' + funded.bounty
  + ' across ' + funded.waiting_rules + ' waiting rule(s)');
say('');

say('A different address calls tick. It is not the creator and needs nobody\'s');
say('permission.');
const before = await anybody.getBalance({ address: keeper.address });
const tickHash = await asKeeper.writeContract({
  address: TOKEN, functionName: 'tick', args: ['0'], value: 0n,
});
const tickReceipt = await settle(asKeeper, tickHash, 'tick');
const after = await anybody.getBalance({ address: keeper.address });

const rules = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'rules_view', args: [],
}));
const firings = JSON.parse(await anybody.readContract({
  address: TOKEN, functionName: 'firings_view', args: [],
}));
const fired = firings.firings[0];

say('');
say('  the round said: ' + (rules.rules[0].why || '(nothing recorded)'));
say('  it quoted:      ' + (fired ? JSON.stringify(fired.quote) : '(no firing)'));
say('  keeper balance before ' + before);
say('  keeper balance after  ' + after);
say('  bounty recorded paid  ' + (fired ? fired.bounty_paid : '(no firing)'));

// What this measures is that the coin left the contract and arrived in an
// account that is not the creator's. It does not measure whether a bounty
// covers a keeper's costs: Studionet did not charge this caller for the call,
// so the balance rises by exactly the bounty and there is no gas in the number
// to compare against.
const moved = BigInt(after) - BigInt(before);

const checks = [
  ['the rule fired', rules.rules[0].state === 'FIRED'],
  ['the whole bounty went to the one waiting rule',
    !!fired && fired.bounty_paid === BOUNTY.toString()],
  ['the badge shows nothing left behind it', rules.bounty === '0'],
  ['and the badge still remembers what was put up',
    rules.bounty_ever_funded === BOUNTY.toString()],
  ['the coin arrived in an account that is not the creator', moved === BOUNTY],
  ['the token records who was paid', !!fired && fired.by.toLowerCase()
    === keeper.address.toLowerCase()],
  ['and what the round said it was reading when it decided',
    !!fired && typeof fired.quote === 'string' && fired.quote.length > 0],
];

say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} checks failed`
  : `${checks.length} checks. The bounty left the contract and reached the keeper.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'bounty.json'), JSON.stringify({
  proved_at: new Date().toISOString(),
  chain: 'genlayer studionet',
  token: TOKEN, creator: creator.address, keeper: keeper.address,
  bounty_wei: BOUNTY.toString(),
  keeper_balance_before: String(before), keeper_balance_after: String(after),
  net_change_wei: moved.toString(),
  rules, firings,
  note: 'studionet did not charge the keeper for this call, so the balance '
    + 'change is the bounty alone and says nothing about gas coverage',
  checks: checks.map(([label, ok]) => ({ label, ok })),
  transcript: out,
}, null, 2));
say('');
say('Written to results/bounty.json');
process.exit(failed.length ? 1 : 0);
