# The badges

The creator writes nothing. No JSON, no conditions, no code. They tick boxes,
and each box is a guard that goes into the token and cannot come out.

A badge is not a rule. A rule is one sentence with one trigger. A badge is a
whole standing arrangement: what the token refuses, what it does on its own, and
where it asks for a judgement it cannot make itself.

## What every badge is answering

A meme has no product, no roadmap and usually no website, so most of what
launchpads call safety is beside the point. There is exactly one question a
buyer has, and it is not about the project:

> Can this person hurt me?

Every badge below closes one way they could. Anything that does not close one of
those ways does not belong here, however clever it is.

| How a creator can hurt a buyer | Badge |
|---|---|
| Dump their own bag | Creator Ceiling, Slow Exit |
| Dump through wallets nobody knows are theirs | Rug Protection |
| Pull the liquidity out | Liquidity Burned |
| Print more tokens | No Mint |
| Stop you selling | No Freeze |
| Change the rules once you are in | Frozen at Launch |
| Take the money and disappear | Still Alive |

## Two kinds of badge, and the difference matters

**Some are pure code.** They live in the token, run on every transfer, cost
nothing and cannot fail to fire. Using a validator round for these would be
absurd: no round is needed to know what time it is or how much somebody holds.

**Some need a judgement.** They ask something a contract cannot work out from
its own ledger, and that is the only reason GenLayer is in this at all. GenLayer
does not make things automatic. It lets a contract know something it otherwise
could not.

The badge display must say which is which. A buyer should never have to guess
whether a promise is arithmetic or an opinion.

**On timing.** A validator round takes the better part of a minute and sometimes
several. That never sits in the path of a sale. The judgement happens ahead of
time and its verdict is written into the token; the token then enforces
instantly, from what it already holds. Slow consensus makes the verdict staler,
not the trade slower.

---

# The catalogue

## 1. Rug Protection

**Kind:** judged, then enforced in code.

> Nobody can quietly become the exit. The creator and every wallet the creator
> funded are held to the same limit, and the token knows which wallets those
> are.

This is the one that cannot be built anywhere else, so it is worth being exact
about how it works.

**The problem it solves.** Every launchpad caps what the creator's address can
do. None of them cap the twenty wallets the creator funded before launch. A
buyer watches the creator's address stay full while the price collapses, and
only afterwards does anybody work out those twenty wallets were the same person.

**How the token handles the easy half, with no judgement at all.** If the
creator sends tokens to another address, the token saw it happen. That address
inherits the creator's limits from that moment. This is a mapping write on
transfer: instant, free, unfoolable. Moving to a fresh wallet buys nothing,
because the move is itself the evidence.

**How GenLayer handles the hard half.** The wallets that never touched the
creator's tokens. The ones funded with gas weeks before launch, that bought in
the first seconds like anybody else. Nothing in the token's own ledger connects
them to anybody. Reading that connection means reading the chain's funding
history and judging whether a pattern is a person or a coincidence, and that is
a judgement, not a lookup.

The round is asked once, at launch, before trading opens, and it produces a set
of addresses. The token holds that set and enforces against it forever after,
instantly. The slow part happens when nothing is at stake.

**What it must never do.** It must not block. A wallet caught in this net might
be somebody the creator legitimately paid, and freezing an innocent buyer's
tokens is a worse failure than the one being prevented. So the consequence is
the creator's own limit, never a block. A cap, not a lock.

The distinction is not a nicety. A contract that can stop an address from
selling is a honeypot with a good story attached. The only thing separating this
badge from that is that the limits are set at launch, apply to the creator's
side only, and can never be turned into a block by anybody afterwards.

**Where it breaks.** A creator who funds their puppet wallets from an exchange
withdrawal, months in advance, through a mixer, leaves no pattern to find. This
badge raises the cost of hiding, it does not make hiding impossible. The badge
should say so.

---

## 2. Creator Ceiling

**Kind:** pure code.

> The creator can never hold more than a set share of the supply. Not at launch,
> not later, not by buying back.

Enforced on every transfer: anything that would push the creator above the
ceiling is refused.

**Where it breaks.** Other wallets. On its own this badge is close to
decoration, because a creator who wanted a bigger bag would simply hold it
elsewhere. It is worth something only alongside Rug Protection, which is what
makes "the creator's wallets" a set rather than one address, and alongside a
holder list the buyer can see.

Worth stating plainly on the badge rather than letting it imply more than it
does.

---

## 3. Slow Exit

**Kind:** pure code.

> The creator cannot move more than a set share of their holding in an hour. Not
> to a buyer, not to an exchange, not to another wallet of their own.

The important word is *move*, not *sell*. A cap on selling is escaped by
transferring to a second wallet and selling from there. A cap on every outgoing
transfer is not, because the transfer out is itself capped.

**What it does and does not do.** At five percent an hour, a full exit takes
about a day. This does not prevent a determined creator from leaving. It
prevents them from leaving in one block, before anybody can react, which is the
thing that actually happens.

---

## 4. Liquidity Burned

**Kind:** a launch parameter, shown as a badge.

> The liquidity cannot be withdrawn by anybody, including us.

The LP tokens go to the zero address when the pool is created. Anyone can check
it with one balance read, and it is the only badge here that needs no trust in
this platform at all.

This is not a rule and nothing enforces it later. It either happened at launch
or it did not.

---

## 5. No Mint / No Freeze

**Kind:** an absence, shown as a badge.

> The supply can never grow. No address can ever be stopped from selling.

There is no mint function in the contract and no way to add one. There is no
blacklist, no pause, no trading switch.

These are badges for the same reason a missing lock is worth pointing at: the
usual token has them, and the usual token's holder does not know.

---

## 6. Frozen at Launch

**Kind:** structural.

> Every badge on this token was chosen when it was launched, and none of them
> can be added, edited or removed afterwards by anyone, the creator included.

Without this one, none of the others mean anything.

---

## 7. Still Alive

**Kind:** judged.

> If the project goes quiet, the treasury goes back to the holders rather than
> sitting there forever.

The only badge here that is about the project rather than about the creator's
power, and the weakest of the set for a pure meme, which usually has nothing to
be alive or dead about.

**Why it needs a judgement.** A contract can count commits. It cannot tell the
difference between development and a bot adding a space to a readme every
Tuesday to keep a rule quiet. Counting can be gamed in five seconds; convincing
a reader that real work is happening requires real work.

**Where it breaks.** It points at a page, and if that page belongs to the
creator they can write what they like on it. It is only worth having when the
evidence lives somewhere the creator cannot silently rewrite.

---

# Not in the catalogue, and why

Kept here because the reasons matter more than the list, and because somebody
will ask for each of these.

**Maximum wallet size.** Sybil defeats it in a minute and it costs nothing to
defeat. Every launchpad offers it and it has never worked. A lock that does not
lock is worse than no lock, because somebody trusts it.

**Price triggers.** A round takes the better part of a minute and sometimes
several. Anything that turns on a price is decided long after the price has
moved.

**Fraud detection from news or regulators.** The failure mode is a real project
destroyed by a false match on a name, with no way to undo it. The cost of being
wrong is far higher than the cost of not having it.

**Anything that reads social media.** The platforms block automated reading, so
the badge would fail for reasons that have nothing to do with the token.

**Blocking a wallet.** Not a badge. A honeypot.
