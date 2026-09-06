# charter.fun

**A token that carries its own rules and keeps them without being asked.**

Every meme coin makes promises. Liquidity locked for six months, team tokens
vesting, the treasury returned to holders if the project goes quiet. Those
promises live in a pinned Telegram message, and the pinned message is not
connected to anything. Nobody enforces it, the creator can walk away from it,
and the holder who believed it has no recourse.

Here the rule is written into the token at launch, in plain words, and **it
cannot be edited afterwards by anyone including the creator**. When its
condition is met, anybody at all can make the token carry it out, and the token
cannot refuse.

## Why this needs a network that can read

The conditions worth writing are not arithmetic on the token's own ledger:

> the project's repository has had no commit for ninety days
>
> the published audit has expired
>
> the page we named still says the reserve is fully backed

A contract cannot evaluate any of those. It has no idea what a repository is.
So the condition goes to GenLayer's validators in the words its creator wrote,
along with whatever page it names as the place to check, and they answer one
question: has this happened yet.

The **action** is not left to judgement. It is a fixed instruction the contract
executes itself, in ordinary code, once the answer comes back `MET`.

## What "automatic" honestly means

No chain lets a contract wake itself up. There is no cron, and a rule nobody
ever checks is a rule that never fires. So `tick` is open to everybody and pays
whoever calls it out of the treasury.

The guarantee is not that the token acts unprompted. It is that **when the
condition is met, anybody in the world can make it act, and the creator cannot
stop them.** No signature, no permission, no cooperation from the person who
would least like it to happen. That is the part a pinned message has never had.

## The badge a buyer actually sees

`rules_view()` returns the rules themselves, frozen since launch, and for each
one whether it has fired, when, who made it fire, and the reasoning the
validators gave. Not the creator's description of the rules. The rules.

```json
{
  "token": "CHRT",
  "rules": [{
    "when": "the GenLayer portal homepage mentions the Agent Tank hackathon",
    "checked_against": "https://portal.genlayer.foundation/",
    "then": "BURN", "amount": "50000", "state": "WAITING"
  }],
  "frozen": true
}
```

A badge that showed only the claim would be the pinned message again with
better styling. Three things make it worth trusting instead:

**The rules are frozen at construction.** No method on the contract writes to
`rules` after `__init__`. There is a test that reads the source and fails if one
ever does.

**A rule nobody has checked is visibly unchecked.** `WAITING` means exactly
that, not "fine".

**A page that will not load is not a met condition.** `CANNOT_TELL` changes
nothing, because treating an unreachable page as proof would let anyone fire a
rule by taking a site down, and let a creator dodge one the same way.

## Proved on Studionet

Both paths, on chain, with an address that is **not the creator** calling `tick`
in each case.

**A condition that has not happened.**
[`0x8eF95B88B9fc8D98b3a317dEcBc1ce4C6b89d63a`](https://explorer-studio.genlayer.com/address/0x8eF95B88B9fc8D98b3a317dEcBc1ce4C6b89d63a)
carries the rule *"the GenLayer portal homepage mentions the Agent Tank
hackathon"*. The contract fetched the page and the round answered:

> `NOT_MET` — "The fetched GenLayer portal homepage includes 'Agent Tank' but
> does not mention the 'Agent Tank hackathon'."

Nothing moved and the rule is still `WAITING`. A closer reading than the person
who wrote the condition managed.

**A condition that has.**
[`0x3483Af543718555D608c72DeB809CD0612b6DcDD`](https://explorer-studio.genlayer.com/address/0x3483Af543718555D608c72DeB809CD0612b6DcDD)
carries *"the page states that a security certificate has expired"*, pointed at
a page that says exactly that:

> `MET` — "The page explicitly states that a security certificate has expired,
> which matches the required condition."

The token burned 79,600 of its own supply, paid 400 to the address that made it
happen, and marked the rule `FIRED` with that reasoning attached. Supply went
from 1,000,000 to 920,400.

The creator did not sign anything, was not asked, and could not have stopped it.

## What it will not do

**It does not stop a creator from writing a worthless rule.** "The team is
honest" is not a condition anything can evaluate, and a token can be launched
with rules that never fire. What the badge shows is whether a rule has fired,
not whether it was a good rule to write.

**It does not reach into anybody's balance.** Rules act on the treasury the
token set aside at launch, so a rule can never take tokens from a holder. That
also caps what a rule can ever do, on purpose.

**Actions are a fixed list.** `BURN` and `DISTRIBUTE`. The judgement decides
*whether*; the contract decides *what*, and only from things it can do to
itself with arithmetic.

## The repository

```
contracts/token.py             the token, its rules, and tick
tests/keeps_its_own_rules.py   29 checks through the real methods
scripts/deploy.mjs             launch one
```

```bash
npm install
python tests/keeps_its_own_rules.py
```

Launching one takes the name, symbol, supply, the percentage held back as
treasury, and the rules as JSON:

```bash
node scripts/deploy.mjs contracts/token.py "Charter Coin" "CHRT" "1000000" "30" \
  '[{"when":"the audit at this address has expired","url":"https://...","then":"BURN","amount":50000}]'
```

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
