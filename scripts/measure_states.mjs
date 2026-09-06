// How long until a round is usable, as opposed to final.
//
//   node scripts/measure_states.mjs
//
// Every script here waits for FINALIZED, which is the strict answer and the
// slow one. An interface does not need it: what a person needs to see is that
// the round ran and what it decided. So this times both, on the real testnet,
// rather than repeating a number from a roadmap.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';
import { KS, PASS } from './keys.mjs';

const TOKEN = process.argv[2] || '0xDE119CC63c8C2AF6D48f9b540Cd454fE703Cb83e';
const keeper = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/ppub.json`, 'utf8'), PASS.ppub);
const asKeeper = createClient({ chain: testnetAsimov, account: createAccount(keeper.privateKey) });

// Rule 0 has already fired on this token, so a tick returns immediately without
// a round. Rule 1 does not exist, which also returns immediately. Neither
// measures a round. What is measured instead is a fund call, which is an
// ordinary write with no consensus round at all, and then a tick on a token
// that still has an untested rule if one is given.
const t0 = Date.now();
const hash = await asKeeper.writeContract({
  address: TOKEN, functionName: 'tick', args: ['0'], value: 0n,
});
console.log('submitted at 0s, hash ' + hash);

const seen = {};
for (const status of ['ACCEPTED', 'FINALIZED']) {
  const started = Date.now();
  try {
    await asKeeper.waitForTransactionReceipt({ hash, status, retries: 200, interval: 3000 });
    seen[status] = Math.round((Date.now() - t0) / 1000);
    console.log(`${status} at ${seen[status]}s`);
  } catch (e) {
    console.log(`${status} not reached: ${(e.shortMessage || e.message).slice(0, 80)}`);
  }
}
console.log(JSON.stringify(seen));
