"""A token that carries its own rules, through its real methods.

    python tests/keeps_its_own_rules.py
"""

import io
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "..", "contracts", "token.py")


class _Store:
    def __init__(self, kind): self.kind = kind
    def __class_getitem__(cls, item): return cls("map" if isinstance(item, tuple) else "list")
    def make(self): return {} if self.kind == "map" else []


class _Address:
    def __init__(self, hex_value): self.as_hex = hex_value
    def __str__(self): return str(self.as_hex)


class _Message:
    def __init__(self):
        self.sender_address = _Address("0x" + "0" * 40)
        self.value = 0


class _Evm:
    def __init__(self):
        self.transfers = []
        outer = self
        def contract_interface(cls):
            class Bound:
                def __init__(self, address): self.address = str(address).lower()
                def emit_transfer(self, value): outer.transfers.append((self.address, int(value)))
            return Bound
        self.contract_interface = contract_interface


class _Nondet:
    def __init__(self):
        self.answer = ""
        self.page = "the page"
        self.last_task = None
    def exec_prompt(self, task):
        self.last_task = task
        return self.answer
    class _Web:
        def __init__(self, outer): self.outer = outer
        def render(self, url, mode="text"):
            if self.outer.page is None:
                raise RuntimeError("unreachable")
            return self.outer.page
    @property
    def web(self):
        return _Nondet._Web(self)


class _Write:
    def __call__(self, fn): return fn
    def payable(self, fn): return fn


class _PublicNS:
    def __init__(self):
        self.write = _Write()
        self.view = lambda fn: fn


class _EqPrinciple:
    def prompt_comparative(self, run, principle): return run()


class _GL:
    def __init__(self):
        self.Contract = object
        self.public = _PublicNS()
        self.message = _Message()
        self.evm = _Evm()
        self.nondet = _Nondet()
        self.eq_principle = _EqPrinciple()


def load():
    gl = _GL()
    fake = types.ModuleType("genlayer")
    fake.gl = gl
    fake.DynArray = _Store
    fake.TreeMap = _Store
    fake.u32 = int
    fake.u256 = int
    fake.Address = _Address
    sys.modules["genlayer"] = fake
    module = types.ModuleType("token_under_test")
    exec(compile(io.open(CONTRACT, encoding="utf-8").read(), CONTRACT, "exec"), module.__dict__)
    return module, gl


def fresh(module, name, symbol, supply, treasury_share, rules, creator=""):
    contract = module.Token.__new__(module.Token)
    for field, declared in module.Token.__annotations__.items():
        if isinstance(declared, _Store):
            setattr(contract, field, declared.make())
    contract.__init__(name, symbol, supply, treasury_share, json.dumps(rules), creator)
    return contract


RESULTS = []


def check(label, condition):
    RESULTS.append((label, bool(condition)))
    print(("  ok  " if condition else " FAIL "), label)


CREATOR = "0x1111111111111111111111111111111111111111"
BUYER = "0x2222222222222222222222222222222222222222"
KEEPER = "0x3333333333333333333333333333333333333333"

QUIET = {"when": "the project's repository has had no commit for ninety days",
         "url": "https://example.com/repo", "then": "DISTRIBUTE", "amount": 100000}
MILESTONE = {"when": "the token has more than two hundred holders",
             "then": "BURN", "amount": 50000}


def main():
    module, gl = load()

    def as_(address):
        gl.message.sender_address = _Address(address)

    def answers(reading, why="because"):
        gl.nondet.answer = json.dumps({"reading": reading, "why": why})

    print("a token launches with its rules already in it")
    as_(CREATOR)
    c = fresh(module, "Charter Coin", "chrt", "1000000", "30", [QUIET, MILESTONE])
    check("the symbol is normalised", json.loads(c.status())["symbol"] == "CHRT")
    check("the creator holds everything but the treasury",
          c.balance_of(CREATOR) == "700000")
    check("the treasury holds its share", json.loads(c.status())["treasury"] == "300000")
    check("both rules were taken", len(json.loads(c.rules_view())["rules"]) == 2)
    check("and they start waiting",
          all(r["state"] == "WAITING" for r in json.loads(c.rules_view())["rules"]))

    print()
    print("a launchpad launches on somebody else's behalf")
    # The factory is the sender when it deploys, so the creator is passed in.
    # Nothing follows from the field, which is why it can be trusted to whoever
    # calls launch: there is nothing to gain by putting another address in it.
    as_("0x9999999999999999999999999999999999999999")
    behalf = fresh(module, "On Behalf", "obh", "1000", "10", [MILESTONE], CREATOR)
    check("the named creator holds the supply, not the deployer",
          behalf.balance_of(CREATOR) == "900"
          and behalf.balance_of("0x9999999999999999999999999999999999999999") == "0")
    junkc = fresh(module, "No Creator", "noc", "1000", "10", [MILESTONE], "not-an-address")
    check("an unusable creator falls back to the sender",
          json.loads(junkc.status())["creator"]
          == "0x9999999999999999999999999999999999999999")

    print("\nrules a launch will not accept")
    as_(CREATOR)
    junk = fresh(module, "Junk", "jnk", "1000", "10", [
        {"when": "too short", "then": "BURN", "amount": 10},
        {"when": "a condition long enough to be real", "then": "EXPLODE", "amount": 10},
        {"when": "a condition long enough to be real", "then": "BURN", "amount": 999999},
        {"when": "a condition long enough to be real", "then": "BURN", "amount": 50},
    ])
    check("a condition too short to mean anything is dropped, an unknown action is "
          "dropped, an amount larger than the treasury is dropped, and the good one is kept",
          len(json.loads(junk.rules_view())["rules"]) == 1)

    print("\nholders are not made to wait for anybody")
    gl.nondet.last_task = None
    as_(CREATOR)
    check("an ordinary transfer goes through",
          json.loads(c.transfer(BUYER, "200000"))["ok"])
    check("and asked no validator anything", gl.nondet.last_task is None)
    check("the buyer holds it", c.balance_of(BUYER) == "200000")
    as_(BUYER)
    check("sending more than you hold is refused",
          not json.loads(c.transfer(CREATOR, "999999"))["ok"])

    print("\na condition that has not happened")
    as_(KEEPER)
    answers("NOT_MET", "the repository shows a commit yesterday")
    out = json.loads(c.tick("0"))
    check("the rule stays waiting", out["ok"] and out["state"] == "WAITING")
    check("and nothing moved", out["moved"] == "0")
    check("the treasury is untouched", json.loads(c.status())["treasury"] == "300000")

    print("\na page nobody can load is not a met condition")
    gl.nondet.page = None
    as_(KEEPER)
    out = json.loads(c.tick("0"))
    check("it reads CANNOT_TELL", out["reading"] == "CANNOT_TELL")
    check("and fires nothing", json.loads(c.status())["treasury"] == "300000")
    gl.nondet.page = "the page"

    print("\nan answer this contract does not recognise")
    as_(KEEPER)
    gl.nondet.answer = "maybe? probably?"
    out = json.loads(c.tick("0"))
    check("refused, and the rule keeps waiting",
          not out["ok"] and json.loads(c.rules_view())["rules"][0]["state"] == "WAITING")

    print("\nthe condition is met, and the creator is not asked")
    before_creator = int(c.balance_of(CREATOR))
    before_buyer = int(c.balance_of(BUYER))
    as_(KEEPER)
    answers("MET", "no commit since April")
    out = json.loads(c.tick("0"))
    check("it fires", out["ok"] and out["state"] == "FIRED" and out["action"] == "DISTRIBUTE")
    check("the caller was paid for making it happen", int(out["paid_caller"]) > 0)
    check("holders were paid pro rata",
          int(c.balance_of(CREATOR)) > before_creator
          and int(c.balance_of(BUYER)) > before_buyer)
    # 300000 out, 100000 spent, and whatever the pro rata division could not
    # split evenly comes back rather than going to whoever is first in the list.
    # The remainder is always smaller than the number of holders.
    treasury = int(json.loads(c.status())["treasury"])
    check("the treasury went down by the amount, less an unsplittable remainder",
          200000 <= treasury < 200000 + len(json.loads(c.status())["top_holders"]) + 1)
    check("and it cannot fire twice", not json.loads(c.tick("0"))["ok"])

    print("\nburning takes it out of the supply")
    supply_before = int(json.loads(c.status())["supply"])
    as_(KEEPER)
    answers("MET", "the holder count passed two hundred")
    out = json.loads(c.tick("1"))
    check("it fires and burns", out["ok"] and out["action"] == "BURN")
    check("the supply is smaller", int(json.loads(c.status())["supply"]) < supply_before)

    print("\nwhat a buyer sees")
    view = json.loads(c.rules_view())
    check("the rules are marked frozen", view["frozen"] is True)
    check("both are recorded as fired",
          all(r["state"] == "FIRED" for r in view["rules"]))
    check("each carries the reasoning the validators gave",
          all(r["why"] for r in view["rules"]))
    check("and who made it fire", all(r["fired_by"] == KEEPER for r in view["rules"]))
    firings = json.loads(c.firings_view())
    check("the history is its own record", firings["count"] == 2)

    print("\nnothing can edit a rule after launch")
    writable = [m for m in dir(c) if not m.startswith("_") and callable(getattr(c, m))]
    source = io.open(CONTRACT, encoding="utf-8").read()
    body = source[source.index("# ------------------------------------------------------------- the ledger"):]
    check("no method after the constructor appends to rules",
          "self.rules.append" not in body)

    print(chr(10) + "the launchpad deploys exactly the token that was tested")
    import ast as _ast
    generated = os.path.join(HERE, "..", "contracts", "launchpad.py")
    if os.path.exists(generated):
        tree = _ast.parse(io.open(generated, encoding="utf-8").read())
        embedded = None
        for node in tree.body:
            if isinstance(node, _ast.Assign) and getattr(node.targets[0], "id", "") == "TOKEN_SOURCE":
                embedded = eval(compile(_ast.Expression(node.value), "<embedded>", "eval"))
        # The factory carries its own copy of the token. If the two ever drift,
        # the copy that gets deployed is the one nobody read, so this is checked
        # rather than trusted.
        check("the source embedded in the launchpad is the source tested here",
              embedded == io.open(CONTRACT, encoding="utf-8").read())
    else:
        check("launchpad not built yet, run scripts/build_launchpad.py", False)

    failed = [label for label, ok in RESULTS if not ok]
    print()
    if failed:
        print("%d of %d checks failed" % (len(failed), len(RESULTS)))
        return 1
    print("%d checks, through transfer, tick, rules_view and the constructor" % len(RESULTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
