// Launch a charter token on GenLayer Asimov with a real rule, fund a bounty,
// then fire the rule end to end. Proves the workflow the app drives.
//
//   export CHARTER_PASS=...            # padv keystore password
//   node scripts/launch_and_fire.mjs
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';
import path from 'path';
import os from 'os';
import url from 'url';

const PASS = process.env.CHARTER_PASS || '';
if (!PASS) { console.error('set CHARTER_PASS'); process.exit(1); }
const KS = process.env.CHARTER_KEYSTORES || path.join(os.homedir(), '.genlayer', 'keystores');
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const w = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/padv.json`, 'utf8'), PASS);
const c = createClient({ chain: testnetAsimov, account: createAccount(w.privateKey) });
const reader = createClient({ chain: testnetAsimov });
const transient = e => /revert|-32005|-32603|at capacity|gas rate|rate limit|backpressure|fetch failed|timeout|502|503|429/i
  .test(String(e?.details || e?.shortMessage || e?.message || e));
const send = async fn => { for (let a=1;;a++){ try{ return await fn(); }
  catch(e){ if(!transient(e)||a>=8) throw e; console.log(`  transient, retry ${a}`); await new Promise(r=>setTimeout(r,6000*a)); } } };
const read = async fn => { try{ return JSON.parse(await reader.readContract({address:TOKEN,functionName:fn})); }catch{ return {}; } };

const rules = [{ when:'the page states that the security certificate has expired',
  url:'https://gist.githubusercontent.com/JspIIV/2ff5af1cd421395420c9ec33b9ecbebf/raw/claim_false.txt',
  then:'BURN', amount:40000 }];
const linkage = '0xade834a3dA17275ad7493E7181daA3641e2F74ca'; // the EVM token this mirrors, on Base Sepolia
const args = ['Charter Demo', 'CDEMO', '1000000', '30', JSON.stringify(rules), w.address, linkage];

console.log('deploying token.py as', w.address);
const dhash = await send(()=>c.deployContract({ code: fs.readFileSync(path.join(ROOT,'contracts','token.py')), args, leaderOnly:false, gas: 90_000_000n }));
console.log('deploy tx', dhash);
const r = await c.waitForTransactionReceipt({ hash:dhash, status:'FINALIZED', retries:150, interval:8000 });
const TOKEN = r?.data?.contract_address ?? r?.contract_address ?? r?.data?.recipient;
if (!TOKEN) { console.error('no address; tx', dhash); process.exit(1); }
console.log('TOKEN', TOKEN);

console.log('funding bounty…');
try { const fh = await send(()=>c.writeContract({ address:TOKEN, functionName:'fund', args:[], value:2_000_000_000_000_000n, gas: 8_000_000n }));
  await c.waitForTransactionReceipt({ hash:fh, status:'FINALIZED', retries:60, interval:6000 }).catch(()=>{}); } catch(e){ console.log('fund note:', String(e.shortMessage||e.message).slice(0,80)); }
await new Promise(r=>setTimeout(r,8000));

console.log('firing rule 0 (tick)…');
await send(()=>c.writeContract({ address:TOKEN, functionName:'tick', args:['0'], value:0n, gas: 30_000_000n }));
let fired=null;
for (let i=0;i<90;i++){ await new Promise(r=>setTimeout(r,5000));
  const rv = await read('rules_view'); const r0=(rv.rules||[])[0]||{};
  process.stdout.write(`\r  round… ${(i+1)*5}s state=${r0.state||'?'}`);
  if (r0.state==='FIRED'){ fired=r0; console.log('\n  FIRED:', r0.why); break; }
}
const status = await read('status'); const rv = await read('rules_view');
fs.mkdirSync(path.join(ROOT,'results'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'results','linked_asimov.json'), JSON.stringify({
  network:'genlayer testnet asimov', explorer:'https://explorer-asimov.genlayer.com/address/'+TOKEN,
  token:TOKEN, deploy_tx:dhash, linkage, proved_at:new Date().toISOString(),
  status, rules:rv.rules, fired: !!fired }, null, 2));
console.log('\nsaved results/linked_asimov.json — treasury', status.treasury, 'supply', status.supply, 'fired', !!fired);
