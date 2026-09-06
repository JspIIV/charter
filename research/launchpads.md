# What a launchpad actually has to get right

Research for charter.fun, September 2026.

This exists because the design conversation was running ahead of the evidence.
Every claim below says where it came from and how confident it is, because the
failure mode of this kind of research is a confident sentence nobody checked.

**How things were verified.** Constants and mechanisms were taken from at least
two independent sources, and where the sources implied a number that is widely
quoted elsewhere, the number was re-derived by arithmetic rather than trusted.
Contract behaviour was read from canonical source code, not from documentation
about it. Deployment addresses were checked by reading code off the chain.
Anything that rests on a single source is marked **single source**.

---

## 1. pump.fun: the curve, exactly

**Verified: two independent documentation sources agree on every constant, and
the constants re-derive a third widely quoted figure.**

Token supply is 1,000,000,000,000,000 base units at 6 decimals, so one billion
tokens. At creation the curve holds:

| | base units | |
|---|---|---|
| virtual token reserves | 1,073,000,000,000,000 | |
| virtual SOL reserves | 30,000,000,000 | 30 SOL |
| real token reserves | 793,100,000,000,000 | 79.31% of supply |
| real SOL reserves | 0 | |

Pricing is the Uniswap v2 constant product on the **virtual** reserves:
`virtual_token * virtual_sol = k`. A buy lowers virtual token reserves and
raises virtual SOL reserves, so the price rises. Fees come off the gross SOL
before the reserves update.

**Graduation is not a market cap.** The program condition is
`real_token_reserves == 0`: every token that was for sale has been sold. The
`$69,000` figure repeated everywhere is a consequence of the constants, not a
rule anybody coded.

Deriving it:

```
k                    = 1,073,000,000,000,000 x 30,000,000,000 = 3.219e25
virtual tokens left  = 1,073,000,000,000,000 - 793,100,000,000,000 = 279,900,000,000,000
virtual SOL then     = k / 279,900,000,000,000 = 115,005,359,056 lamports
SOL actually raised  = 115.005 - 30 = 85.005 SOL
```

85.005 SOL. The widely quoted "85 SOL" falls out of the constants, which is the
strongest confirmation available that both the constants and the figure are
right.

**Three design facts worth stealing:**

*The virtual reserves are the whole trick.* The 279.9 billion gap between
virtual and real token reserves is never for sale. It exists so the curve still
has a defined price when the real tokens run out, and so the starting price is a
sane number rather than zero.

*20.69% of supply is held back for the pool.* It is not an allocation to a
person; it is the token side of the liquidity that gets created at migration.

*Price rises 14.7x from the first buy to graduation.* That is the entire reward
for buying early, and it is also the reason the first buy is worth sniping.

---

## 2. The first buyer problem, and what Flaunch does about it

**Partly verified: the mechanism is described consistently by three secondary
sources. Flaunch's own documentation site did not resolve when fetched, so this
is not confirmed from the primary source.**

A bonding curve gives the best price to whoever buys first, which means bots buy
first. The creator's own friends, and the creator, are competing with automated
snipers for the bottom of the curve.

Flaunch, on Base, answers this with a **fixed price window**: for the first 30
minutes every buyer pays the same price, and only afterwards does the token
trade on the open market. It also runs a **Progressive Bid Wall**, a Uniswap v4
hook that turns every 0.1 ETH of accumulated trading fees into a buy order just
below spot, building a price floor that follows the price up. Fees are reported
as going entirely to the creator and to buybacks, with the split chosen by the
creator.

This matters for us in two ways. First, sniping is a real problem we had not
considered at all. Second, fee redirection and automated buybacks are **already
done** by somebody on our chain, so they are not where we are different.

---

## 3. The migration attack, read from the source

**Verified from canonical source code**, `Uniswap/v2-periphery`
`UniswapV2Router02.sol` and `Uniswap/v2-core` `UniswapV2Pair.sol`.

This is the finding that matters most, because it breaks the naive version of
the plan we were about to build.

`_addLiquidity` in the router does this:

```solidity
if (factory.getPair(tokenA, tokenB) == address(0)) factory.createPair(tokenA, tokenB);
(uint reserveA, uint reserveB) = getReserves(...);
if (reserveA == 0 && reserveB == 0) {
    (amountA, amountB) = (amountADesired, amountBDesired);   // we set the price
} else {
    uint amountBOptimal = quote(amountADesired, reserveA, reserveB);  // THEY set the price
    ...
    require(amountBOptimal >= amountBMin, 'UniswapV2Router: INSUFFICIENT_B_AMOUNT');
}
```

So the pool's price is set by whoever adds liquidity to an empty pair, and after
that the router deposits at **the existing ratio**, whatever it is.

`createPair` is permissionless. Anyone can call it. And `mint` on the pair is
callable directly, without the router.

**The attack.** Someone who holds any of our tokens, which by graduation day
means most of the buyers, calls `createPair(ourToken, WETH)`, sends a dust
amount of each side, and calls `pair.mint()`. They have now set the price to
whatever they like. When our migration then runs:

- with sensible `amountMin` values it **reverts**, and graduation is blocked for
  as long as the attacker cares to keep doing it. A denial of service on the
  single most important transaction the contract ever makes.
- with `amountMin` set to zero, which is what a first draft does, we deposit at
  the attacker's ratio and they arbitrage the difference out of the pool
  immediately.

Either way the naive migration loses.

**What actually defends it**, and this follows directly from the code rather
than from anybody's blog:

1. The token contract creates the pair **itself, at construction**, so the pair
   exists with zero reserves and nobody can be first.
2. Transfers to that pair address are refused until graduation, so nobody can
   seed it behind our back.
3. At graduation the contract transfers both sides to the pair and calls
   `pair.mint()` **directly**, not through the router, so no ratio quoting is
   involved at all.

Also confirmed in `UniswapV2Pair.mint`: on the first mint, `MINIMUM_LIQUIDITY`
(1000) LP tokens are minted to the zero address permanently, so the first
depositor can never hold the entire LP supply.

---

## 4. Which Uniswap version, and why

**Verified on chain**: all three are deployed on Base Sepolia. Addresses were
confirmed by reading contract code, and for v2 the exact function selectors we
would call were confirmed present in the deployed bytecode.

| | address | checked |
|---|---|---|
| v2 factory | `0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e` | `allPairsLength()` answered 10,729 |
| v2 router02 | `0x1689E7B1F10000AE47eBfE339a4f69dECd19F602` | `factory()` and `WETH()` answered correctly |
| v3 factory | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | has code, `owner()` answers |
| v4 PoolManager | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` | has code |
| WETH | `0x4200000000000000000000000000000000000006` | has code |

**v3 is wrong for this.** A position is an NFT over a price range, so "the
liquidity is locked" stops being a single fact anybody can check and becomes
three: who owns the NFT, what range it covers, and how much is in it. Worse, a
creator can put liquidity in a narrow range far from spot, which reads as locked
and provides almost nothing tradeable. For a product whose entire claim is that
you can check it yourself, that is a downgrade. The capital efficiency that
justifies v3 elsewhere is worth nothing here, because the liquidity is being
burned and will never be managed.

**v2 is verifiable and has one real hole.** LP tokens are a fungible ERC-20;
burning them means sending them to the zero address and checking it means one
balance read. But once liquidity is on Uniswap our contract sees nothing of the
trading, so anything funded by trading fees stops being funded at exactly the
moment the token starts trading properly.

**v4 closes that hole and opens others.** A hook sits on the pool and runs on
every swap for as long as the pool exists, which is what Flaunch uses. But hook
permissions are **encoded in the bits of the hook's own address**, so a valid
address has to be found by mining a CREATE2 salt (verified from Uniswap's
developer documentation). One shared hook for every token avoids mining per
launch, at the cost of a single contract whose bugs reach every token that uses
it. And v4 positions are not fungible either, so the clean burn proof is gone.

---

## 5. What we do not know yet

Named so that nothing here gets treated as settled when it is not.

- **Flaunch's mechanism is not confirmed from primary sources.** Their docs host
  did not resolve. The 30 minute window, the 0.1 ETH bid wall step and the fee
  split all come from secondary write-ups.
- **No launchpad audit report was actually read.** Searching returned generic
  material about bonding curve risk classes, not findings against a specific
  launchpad. Reading two or three real reports is the obvious next step and it
  has not been done.
- **Whether a v4 hook can take a fee on a swap** was not confirmed. Flaunch
  evidently does something equivalent in production, but the mechanism was not
  read.
- **Curve arithmetic in Solidity** has not been worked at all: rounding
  direction, precision, what the first and last buy do at the boundary, and
  whether a buy and an immediate sell can extract value. Known exploit classes
  exist here. We have not touched them.
- **Base mainnet addresses differ from Base Sepolia** and have not been checked.

---

## 6. What this changes

The plan before this research was: a bonding curve, graduate to Uniswap v2 at a
threshold we choose, burn the LP. Three things about it were wrong or missing.

**The graduation threshold should not be a price or a market cap.** pump.fun
uses "the tokens for sale ran out", which needs no oracle and cannot be pushed
around by a large trade. That is better than the ETH-raised threshold proposed
earlier, and much better than a market cap.

**The migration cannot use the router.** The pair has to be created by the token
at construction, transfers to it refused until graduation, and `mint` called
directly. Anything else is either exploitable or blockable by any token holder.

**Sniping the first buy is a real problem** and was not in the design at all. A
fixed price opening window is the known answer.

And the honest conclusion about sequencing has not changed. Fee redirection,
buybacks and fair launch windows are all being done on Base already, by teams
who have been at it longer. The part nobody else has is a rule, written in plain
words at launch, that a round of validators decides by reading the world. That
is the part worth being first at, and it is the part that already works.
