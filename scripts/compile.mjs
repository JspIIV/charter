// Compiles the escrow with solc and writes the artifact next to it.
import solc from 'solc';
import fs from 'fs';
import path from 'path';

const name = process.argv[2] || 'AgentAllowance';
const source = fs.readFileSync(`contracts/${name}.sol`, 'utf8');

const input = {
  language: 'Solidity',
  sources: { [`${name}.sol`]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

// Local imports are resolved off disk. The script was written for one file and
// a launchpad has to import the token it deploys; without this, solc reports
// the import as a missing source rather than asking for it.
function findImport(where) {
  const file = path.join('contracts', path.basename(where));
  try { return { contents: fs.readFileSync(file, 'utf8') }; }
  catch (e) { return { error: `not found: ${file}` }; }
}

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.log(`[${e.severity}] ${e.formattedMessage.trim()}`);
if (errors.length) process.exit(1);

const c = out.contracts[`${name}.sol`][name];
if (!c) {
  console.error(`no contract named ${name} in ${name}.sol`);
  process.exit(1);
}
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync(`build/${name}.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
console.log(`compiled ${name}: ${c.abi.length} abi entries, ${c.evm.bytecode.object.length / 2} bytes`);
