// Deploy a contract with constructor arguments.
//   node deploy.mjs contracts/vault.py 0xGUARDIAN
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'fs';
import { KS, PASS } from './keys.mjs';
const w = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS.padv);
const c = createClient({ chain: studionet, account: createAccount(w.privateKey) });
const hash = await c.deployContract({
  code: fs.readFileSync(process.argv[2]),
  args: process.argv.slice(3),
  leaderOnly: false,
});
const r = await c.waitForTransactionReceipt({ hash, status: 'FINALIZED', retries: 120, interval: 10000 });
console.log('address', r?.data?.contract_address ?? JSON.stringify(r).slice(0, 300));
