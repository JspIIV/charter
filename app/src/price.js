// The live price, when there is one.
//
// A token launched here has no market until somebody makes one. Until then
// there is no price, and putting a number in that space would be the one lie
// that undoes everything the badges are for: a page that invents a price is a
// page you cannot trust about a creator's holdings either.
//
// So this asks Uniswap. If a pair exists and holds reserves, the price is read
// from those reserves, on chain, now. If it does not, the answer is that there
// is no market yet, said plainly.
import { JsonRpcProvider, Contract } from 'ethers';

// Confirmed on Base Sepolia by reading the deployed code: the factory answered
// allPairsLength, and the router pointed back at it and at this WETH.
export const V2_FACTORY = '0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e';
export const WETH = '0x4200000000000000000000000000000000000006';

const FACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function totalSupply() view returns (uint256)',
];

const provider = new JsonRpcProvider('https://sepolia.base.org');
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * @returns {{market: false} | {market: true, pair, priceWei, ethInPool, tokensInPool}}
 *
 * `priceWei` is wei of ETH per whole token. A token with a pair but no reserves
 * counts as no market: a pool nobody has funded prices nothing, and reporting
 * a division by zero as a price would be worse than reporting nothing.
 */
export async function livePrice(token, decimals = 18) {
  const factory = new Contract(V2_FACTORY, FACTORY_ABI, provider);
  const pair = await factory.getPair(token, WETH);
  if (!pair || pair === ZERO) return { market: false };

  const pool = new Contract(pair, PAIR_ABI, provider);
  const [reserves, token0] = await Promise.all([pool.getReserves(), pool.token0()]);
  const tokenIsFirst = String(token0).toLowerCase() === String(token).toLowerCase();
  const tokensInPool = tokenIsFirst ? reserves[0] : reserves[1];
  const ethInPool = tokenIsFirst ? reserves[1] : reserves[0];

  if (tokensInPool === 0n || ethInPool === 0n) return { market: false, pair };

  // Whole tokens, so the price is per token rather than per base unit.
  const whole = tokensInPool / 10n ** BigInt(decimals);
  if (whole === 0n) return { market: false, pair };

  return {
    market: true,
    pair,
    priceWei: ethInPool / whole,
    ethInPool,
    tokensInPool,
  };
}

/**
 * Wei as ETH, cut to significant figures rather than to a fixed number of
 * decimal places.
 *
 * A launch price is often a billionth of an ETH, and eight places renders that
 * as "0". A page that shows a real price as zero is worse than one that shows
 * no price at all: the first is wrong and the second is honest.
 */
export function eth(wei, figures = 3) {
  const n = BigInt(wei || 0);
  if (n === 0n) return '0';

  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0');

  if (whole > 0n) {
    const trimmed = frac.slice(0, Math.max(figures, 4)).replace(/0+$/, '');
    return trimmed ? `${whole}.${trimmed}` : String(whole);
  }

  // Below one, keep counting past the leading zeros so the figures that carry
  // the number are the ones shown.
  const lead = frac.search(/[1-9]/);
  const cut = frac.slice(0, lead + figures).replace(/0+$/, '');
  return `0.${cut}`;
}
