// Close out the testnet proof against the token already deployed there.
//   node scripts/finish_testnet.mjs 0x...
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { KS, PASS } from './keys.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TOKEN = process.argv[2] || '0xDE119CC63c8C2AF6D48f9b540Cd454fE703Cb83e';
const out = [];
const say = l => { console.log(l); out.push(l); };

const creator = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const keeper = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub);
const asCreator = createClient({ chain: testnetAsimov, account: createAccount(creator.privateKey) });
const asKeeper = createClient({ chain: testnetAsimov, account: createAccount(keeper.privateKey) });
const anybody = createClient({ chain: testnetAsimov });
const BOUNTY = 2_000_000_000_000_000n;

async function send(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const why = String(e?.details || e?.shortMessage || e?.message || e);
      const waitMs = Number(e?.cause?.data?.retryAfterMs || 0);
      if (!/-32005|at capacity|rate limit|gas rate/i.test(why) || attempt >= 12) throw e;
      const pause = Math.max(waitMs, 1000) * attempt;
      say(`  (${what}: node at capacity, waiting ${Math.round(pause / 1000)}s)`);
      await new Promise(r => setTimeout(r, pause));
    }
  }
}
const settle = async (c, hash, what) => {
  const t = Date.now();
  await c.waitForTransactionReceipt({ hash, status: 'FINALIZED', retries: 200, interval: 12000 });
  say(`  ${what} finalized in ${Math.round((Date.now() - t) / 1000)}s`);
};
const read = async fn => JSON.parse(await anybody.readContract({ address: TOKEN, functionName: fn, args: [] }));

say('Finishing the testnet proof on ' + TOKEN);
const before = await read('rules_view');
if (before.bounty_ever_funded === '0') {
  const h = await send('fund', () => asCreator.writeContract({
    address: TOKEN, functionName: 'fund', args: [], value: BOUNTY }));
  await settle(asCreator, h, 'fund');
}

let verdict = null, attempts = 0;
for (; attempts < 3; attempts++) {
  const h = await send('tick', () => asKeeper.writeContract({
    address: TOKEN, functionName: 'tick', args: ['0'], value: 0n }));
  await settle(asKeeper, h, `tick ${attempts + 1}`);
  verdict = (await read('rules_view')).rules[0];
  say('  testnet says ' + verdict.state);
  if (verdict.state === 'FIRED') break;
}
attempts += 1;

const rules = await read('rules_view');
const status = await read('status');
say('  supply  ' + status.supply);
say('  because ' + rules.rules[0].why);
say('  quoting ' + JSON.stringify(rules.rules[0].quote));

const checks = [
  ['the bounty funded on testnet', rules.bounty_ever_funded === BOUNTY.toString()],
  ['a rule fires on testnet', rules.rules[0].state === 'FIRED'],
  ['the burn came out of the supply', status.supply !== '1000000'],
  ['the round quoted the page', !!rules.rules[0].quote],
];
say('');
for (const [l, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + l);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} failed`
  : `${checks.length} checks, on the network a wallet can reach. Rounds needed: ${attempts}.`);

fs.writeFileSync(path.join(ROOT, 'results', 'testnet.json'), JSON.stringify({
  proved_at: new Date().toISOString(), chain: 'genlayer testnet asimov',
  token: TOKEN, rounds_needed: attempts, rules, status,
  checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
process.exit(failed.length ? 1 : 0);
