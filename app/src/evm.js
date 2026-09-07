// The badges live on the token, on an EVM chain, and are enforced by ordinary
// code on every transfer. Reading them needs no account and no wallet.
//
// This is the half of a charter token that never asks anybody anything: no
// round, no waiting, no bounty. Which is exactly why the page has to say so.
// A buyer should never have to guess whether a promise is arithmetic or an
// opinion.
import { JsonRpcProvider, Contract } from 'ethers';

export const BASE_RPC = 'https://sepolia.base.org';
export const BASE_EXPLORER = 'https://sepolia.basescan.org';

const ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function treasury() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function holderCount() view returns (uint256)',
  'function restricted(address) view returns (bool)',
  'function badges() view returns (uint256 creatorCeilingBps, uint256 slowExitBps, uint256 slowExitWindow, bool taintFollows)',
  'function badgeView(address who) view returns (uint256 creatorCeilingBps, uint256 slowExitBps, uint256 slowExitWindow, bool taintFollows, bool isRestricted, uint256 movable, uint256 windowEndsAt)',
  'function genlayerToken() view returns (string)',
  'function genlayerChain() view returns (string)',
];

const provider = new JsonRpcProvider(BASE_RPC);

export async function readToken(address) {
  const token = new Contract(address, ABI, provider);
  const [name, symbol, totalSupply, treasury, owner, holders,
         genlayerToken, genlayerChain] = await Promise.all([
    token.name(), token.symbol(), token.totalSupply(), token.treasury(),
    token.owner(), token.holderCount(), token.genlayerToken(), token.genlayerChain(),
  ]);
  const creatorHolds = await token.balanceOf(owner);
  const view = await token.badgeView(owner);

  return {
    address, name, symbol,
    totalSupply: totalSupply.toString(),
    treasury: treasury.toString(),
    owner, holders: Number(holders),
    creatorHolds: creatorHolds.toString(),
    genlayerToken, genlayerChain,
    badges: {
      creatorCeilingBps: Number(view[0]),
      slowExitBps: Number(view[1]),
      slowExitWindow: Number(view[2]),
      taintFollows: view[3],
      creatorMovableNow: view[5].toString(),
      windowEndsAt: Number(view[6]),
    },
  };
}
