"""Generate the launchpad, with the token's source embedded in it.

A factory has to carry the source of what it deploys, which means the token
exists twice: once as `contracts/token.py` that people read and test, and once
as a string inside the factory. Copying it across by hand guarantees they drift,
and the copy that drifts is the one that actually gets deployed.

So the factory is generated. `contracts/token.py` is the only source, this reads
it, and `contracts/launchpad.py` is an artefact nobody should edit.

    python scripts/build_launchpad.py
"""

import io
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = os.path.join(HERE, "contracts", "token.py")
OUT = os.path.join(HERE, "contracts", "launchpad.py")

token_source = io.open(TOKEN, encoding="utf-8").read()

# The source cannot go in as a plain triple quoted string: token.py contains its
# own triple quotes and its own backslash escapes, and both would be eaten. Each
# line goes in as its own repr instead, which Python escapes correctly by
# construction, and they are joined back together at load time.
NL = chr(10)
embedded = ("TOKEN_SOURCE = chr(10).join([" + NL
            + "".join("    %r," % line + NL for line in token_source.split(NL))
            + "])")

LAUNCHPAD = '''# {{ "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }}
"""charter.fun: the place a token with its own rules gets launched.

Anybody fills in a name, a symbol, a supply, how much of it the token holds back
for its own rules to act on, and the rules themselves in plain words. This
deploys a fresh contract for it and writes down where it went.

Each token is its own contract rather than a row in this one. That costs a
deployment per launch and it is worth it: a token that is its own contract can
be held, read and called by anything, and its rules cannot be reached by
whatever else this registry is doing. A launchpad that owned every token it ever
made would be exactly the single point of control the tokens are meant not to
have.

**This file is generated.** `contracts/token.py` is the source of what gets
deployed; `scripts/build_launchpad.py` reads it and writes this. Editing the
copy below only guarantees the deployed token stops matching the one people
read and test.

The creator is passed to the token explicitly, because this contract is the
sender when it deploys and the person who launched it is not. Nothing follows
from that field: a creator cannot edit a rule, stop a tick, or take anything
back. It says who launched it and that is all it says.
"""

from genlayer import *
from datetime import datetime, timezone
import json
import typing


{embedded}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _addr(address) -> str:
    return str(address).lower()


def _clip(text: str, limit: int) -> str:
    text = str(text).strip()
    return text if len(text) <= limit else text[:limit] + " [...]"


class Launchpad(gl.Contract):
    # Every token ever launched here, as JSON. Append only: a token that turned
    # out badly is part of what this place has produced, and hiding it would
    # make the good ones worth less.
    launches: DynArray[str]

    def __init__(self) -> None:
        pass

    @gl.public.write
    def launch(self, name: str, symbol: str, supply: str,
               treasury_share: str, rules_json: str) -> str:
        """Deploy a token carrying the rules given here, and remember it.

        The rules are handed straight to the token, which validates them itself
        and drops anything malformed at construction. This contract does not
        pre-approve them: a launchpad that decided which rules were acceptable
        would be a launchpad with an opinion, and the next question would be
        whose.
        """
        creator = _addr(gl.message.sender_address.as_hex)
        index = len(self.launches)

        address = gl.deploy_contract(
            code=TOKEN_SOURCE.lstrip("\\n").encode("utf-8"),
            args=[str(name), str(symbol), str(supply), str(treasury_share),
                  str(rules_json), creator],
            salt_nonce=index + 1,
            on="accepted",
        )

        self.launches.append(json.dumps({{
            "index": index,
            "address": address.as_hex if hasattr(address, "as_hex") else str(address),
            "name": _clip(str(name), 60),
            "symbol": _clip(str(symbol), 12).upper(),
            "creator": creator,
            "launched_at": _now_iso(),
        }}))
        return json.dumps({{"ok": True, "index": index,
                           "address": self.launches[index] and json.loads(
                               self.launches[index])["address"]}})

    @gl.public.view
    def size(self) -> str:
        return json.dumps({{"launched": len(self.launches)}})

    @gl.public.view
    def launches_view(self, start: str, count: str) -> str:
        try:
            first = max(0, int(str(start).strip()))
            how_many = min(50, max(1, int(str(count).strip())))
        except Exception:
            return json.dumps({{"ok": False, "error": "give a start and a count"}})
        out = []
        for position in range(first, min(first + how_many, len(self.launches))):
            out.append(json.loads(self.launches[position]))
        return json.dumps({{"ok": True, "total": len(self.launches), "launches": out}})

    @gl.public.view
    def launch_at(self, index: str) -> str:
        try:
            position = int(str(index).strip())
        except Exception:
            return json.dumps({{"ok": False, "error": "which launch"}})
        if position < 0 or position >= len(self.launches):
            return json.dumps({{"ok": False, "error": "no launch at that index"}})
        return json.dumps({{"ok": True, "launch": json.loads(self.launches[position])}})
'''

io.open(OUT, "w", encoding="utf-8", newline="\n").write(
    LAUNCHPAD.format(embedded=embedded))

print("wrote contracts/launchpad.py with %d characters of token source embedded"
      % len(token_source))
