// Launching a token, from a browser, with the creator's own wallet.
//
// The creator writes a name, a symbol and a supply, and ticks the badges they
// want. No JSON, no conditions, no code. Whatever they tick goes into the
// token at construction and nobody can take it out again, including them, and
// including us: this contract has no admin and there is nothing here that
// could reach a token after it exists.
import { BrowserProvider, ContractFactory } from 'ethers';
import artifact from './CharterToken.json';

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
 * Deploy a token.
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

  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const token = await factory.deploy(
    name, symbol, BigInt(supply), BigInt(treasuryShare),
    creator,
    // The carrier only matters for judged rules, which this form does not
    // create. It is set to the creator so the field is never the zero address,
    // and with no rules there is nothing for it to carry.
    creator,
    '', '',
    { conditions: [], urls: [], actions: [], amounts: [] },
    {
      creatorCeilingBps: BigInt(badges.creatorCeilingBps || 0),
      slowExitBps: BigInt(badges.slowExitBps || 0),
      slowExitWindow: BigInt(badges.slowExitWindow || 0),
      taintFollows: !!badges.taintFollows,
    },
  );
  await token.waitForDeployment();
  const address = await token.getAddress();

  // A read straight after a deployment can land on a node that has not seen it
  // yet and answer as though the address were empty, which reads as a launch
  // that failed. It did not.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await provider.getCode(address)) !== '0x') break;
    await new Promise(r => setTimeout(r, 2000));
  }
  return { address, creator, hash: token.deploymentTransaction()?.hash };
}
