// Launching a token, from a browser, with the creator's own wallet.
//
// The creator writes a name, a symbol and a supply, and ticks the badges they
// want. No JSON, no conditions, no code. Whatever they tick goes into the
// token at construction and nobody can take it out again, including them, and
// including us: this contract has no admin and there is nothing here that
// could reach a token after it exists.
import { BrowserProvider, JsonRpcProvider, Contract } from 'ethers';
import pad from './CharterLaunchpad.json';

/// The launchpad on Base Sepolia. Deploying a token straight from here would
/// work, and would mean the app decides what goes in the constructor. Going
/// through the launchpad means the arguments are on chain, the launch is in a
/// list anybody can read, and a different app claiming the same badges would
/// have to put the same arguments in the same place.
export const LAUNCHPAD = '0xB8688c7f31580EbF0A55d14534C2863b8Ed89709';

const reader = new JsonRpcProvider('https://sepolia.base.org');

export const BASE_CHAIN_ID_HEX = '0x14a34'; // 84532

const BASE_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
};

export async function useBase() {
  if (!window.ethereum) {
    throw new Error('No browser wallet found. Launching needs one; reading does not.');
  }
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() === BASE_CHAIN_ID_HEX) return;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain', params: [BASE_PARAMS],
      });
      return;
    }
    throw new Error('This launches on Base Sepolia. Your wallet stayed on another '
      + 'network, and a token deployed there would not be the one this page shows.');
  }
}

/**
 * Launch a token through the launchpad.
 *
 * The badges are passed exactly as ticked. Nothing is quietly corrected on the
 * way through: a ceiling above a hundred percent or a window of zero is
 * refused by the contract rather than clamped, because a launch that silently
 * fixed a badge would put a badge on the token that its creator did not
 * choose.
 */
export async function launch({ name, symbol, supply, treasuryShare, badges }) {
  await useBase();
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const creator = await signer.getAddress();

  const launchpad = new Contract(LAUNCHPAD, pad.abi, signer);
  const tx = await launchpad.launch(
    name, symbol, BigInt(supply), BigInt(treasuryShare),
    {
      creatorCeilingBps: BigInt(badges.creatorCeilingBps || 0),
      slowExitBps: BigInt(badges.slowExitBps || 0),
      slowExitWindow: BigInt(badges.slowExitWindow || 0),
      taintFollows: !!badges.taintFollows,
    },
  );
  const receipt = await tx.wait();

  // The new address comes off the event. A transaction does not hand its
  // return value back to the caller, so reading one would mean guessing.
  const event = receipt.logs
    .map(log => { try { return launchpad.interface.parseLog(log); } catch { return null; } })
    .find(e => e && e.name === 'Launched');
  const address = event?.args?.token;
  if (!address) throw new Error('The launch was mined but reported no address.');

  // A read straight after a deployment can land on a node that has not seen it
  // yet and answer as though the address were empty, which reads as a launch
  // that failed. It did not.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await provider.getCode(address)) !== '0x') break;
    await new Promise(r => setTimeout(r, 2000));
  }
  return { address, creator, hash: tx.hash };
}


/** Every launch, newest first. Read straight off the chain: no indexer, no
 *  server, and nothing that has to keep working for this list to be true. */
export async function recentLaunches(take = 20) {
  const launchpad = new Contract(LAUNCHPAD, pad.abi, reader);
  const [rows, total] = await launchpad.page(0, take);
  return {
    total: Number(total),
    launches: rows.map(r => ({
      token: r.token,
      creator: r.creator,
      name: r.name,
      symbol: r.symbol,
      launchedAt: Number(r.launchedAt),
    })),
  };
}
