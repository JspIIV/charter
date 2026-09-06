// Where the test accounts come from.
//
// Two accounts play the two sides of every scenario here: `padv` owns the
// protocols and answers appeals, `ppub` deposits, withdraws and raises alarms.
// A scenario needs both, because a guard only its owner can raise is a switch
// rather than a guard.
//
// There are two ways to have them and the scripts do not care which:
//
//   node scripts/setup.mjs
//     Makes a pair in `.halt/keystores`, which is gitignored, and prints the
//     addresses so they can be funded. Nothing else to set. This is the path if
//     you have just cloned this repository.
//
//   export HALT_KEYSTORES=~/.genlayer/keystores
//   export HALT_KS_PADV=... HALT_KS_PPUB=...
//     Points at keystores you already have, from the GenLayer CLI or Studio.
//
// The passwords used to sit in every script as string literals, which is fine on
// one machine and not fine in a public repository. They open throwaway accounts
// holding testnet balance and nothing else, but a password in a repository
// teaches the wrong habit even when the account is worthless.
import path from 'path';
import os from 'os';
import fs from 'fs';
import url from 'url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const LOCAL = path.join(HERE, '..', '.halt', 'keystores');

const madeHere = fs.existsSync(path.join(LOCAL, 'padv.json'))
  && fs.existsSync(path.join(LOCAL, 'ppub.json'));

export const KS = process.env.HALT_KEYSTORES || (madeHere ? LOCAL
  : path.join(os.homedir(), '.genlayer', 'keystores'));

// The local pair opens with a password `setup.mjs` wrote beside it. It protects
// nothing anybody would want and exists because the keystore format insists on
// one, which is why it is not treated as a secret here and is not committed
// either.
let local = null;
if (KS === LOCAL) {
  try { local = JSON.parse(fs.readFileSync(path.join(LOCAL, 'how-to-open.json'), 'utf8')); }
  catch { local = null; }
}

export const PASS = {
  padv: process.env.HALT_KS_PADV || (local ? local.padv : ''),
  ppub: process.env.HALT_KS_PPUB || (local ? local.ppub : ''),
};

if (!PASS.padv || !PASS.ppub) {
  console.error([
    'No accounts to work with yet.',
    '',
    'Make a pair and see how to fund them:',
    '    node scripts/setup.mjs',
    '',
    'Or point at keystores you already have:',
    '    export HALT_KEYSTORES=~/.genlayer/keystores',
    '    export HALT_KS_PADV=... HALT_KS_PPUB=...',
  ].join('\n'));
  process.exit(1);
}
