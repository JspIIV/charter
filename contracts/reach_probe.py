# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""What a GenLayer round can actually reach on another chain.

The badge that would make this project different is the one that finds the
wallets a creator funded before launch. Those never touch the token, so nothing
in its own ledger connects them: catching them means reading another chain's
history and judging whether a pattern is one person or a coincidence.

The judging part is what GenLayer is for. The reading part is the question, and
it has not been answered. Reading a *balance* at a pinned block works, and we
proved that elsewhere. Reading a *history* is a different thing: a plain JSON-RPC
node does not index transactions by account, and native transfers emit no logs
at all, so "who first funded this address" is not a question an RPC endpoint
answers.

This contract exists to find out what is reachable rather than to assume. It
does one fetch per call and reports whether anything came back, with a sample of
what did. Nothing is designed on top of it until it has answered.

Only one field goes to consensus: REACHED, EMPTY or REFUSED. The sample is not
compared, because two validators fetching the same endpoint a second apart will
not get byte identical bodies and binding that would fail every time for the
wrong reason.
"""

from genlayer import *
import json
import typing


REACHED = "REACHED"
EMPTY = "EMPTY"
REFUSED = "REFUSED"
OUTCOMES = (REACHED, EMPTY, REFUSED)

MAX_SAMPLE = 900
MAX_URL = 400
MAX_BODY = 1200


def _clip(text: str, limit: int) -> str:
    text = str(text)
    return text if len(text) <= limit else text[:limit] + " [...]"


def _outcome(raw: str) -> str:
    text = str(raw).strip()
    try:
        obj = json.loads(text[text.index("{"):text.rindex("}") + 1])
        if isinstance(obj, dict):
            said = str(obj.get("outcome", "")).strip().upper()
            return said if said in OUTCOMES else ""
    except Exception:
        pass
    return ""


def _field(raw: str, name: str, limit: int) -> str:
    try:
        text = str(raw).strip()
        obj = json.loads(text[text.index("{"):text.rindex("}") + 1])
        if isinstance(obj, dict):
            return _clip(str(obj.get(name, "")), limit)
    except Exception:
        pass
    return ""


class ReachProbe(gl.Contract):
    # Append only. Every attempt is kept, including the ones that failed,
    # because a probe that only recorded what worked would be answering a
    # different question than the one being asked.
    attempts: DynArray[str]

    def __init__(self) -> None:
        pass

    @gl.public.write
    def probe(self, how: str, url: str, body: str) -> str:
        """Try to reach something, and say what came back.

        `how` is get, post or render. `body` is only used by post.
        """
        way = str(how).strip().lower()
        where = _clip(str(url), MAX_URL)
        payload = _clip(str(body), MAX_BODY)

        def look() -> str:
            # Locals only, and nothing here raises: either would end the
            # transaction rather than the round, and a probe that cannot report
            # a failure is not a probe.
            got = ""
            try:
                if way == "render":
                    # render returns text already
                    got = str(gl.nondet.web.render(where, mode="text"))
                else:
                    # get and post return a Response. Stringifying that gives
                    # its repr, which is the status and the headers and none of
                    # the answer, and reads like a success while carrying
                    # nothing. The body has to be taken out and decoded.
                    if way == "post":
                        answer = gl.nondet.web.post(
                            where, body=payload,
                            headers={"Content-Type": "application/json"})
                    else:
                        answer = gl.nondet.web.get(where)
                    raw_body = getattr(answer, "body", None)
                    if raw_body is None:
                        got = str(answer)
                    elif isinstance(raw_body, (bytes, bytearray)):
                        got = raw_body.decode("utf-8", "replace")
                    else:
                        got = str(raw_body)
                    status = getattr(answer, "status", None)
                    if status is not None:
                        got = "status " + str(status) + " | " + got
            except Exception as e:
                return json.dumps({
                    "outcome": REFUSED,
                    "sample": _clip("the fetch raised: " + str(e), MAX_SAMPLE),
                })
            if not got.strip():
                return json.dumps({"outcome": EMPTY, "sample": ""})
            return json.dumps({
                "outcome": REACHED,
                "sample": _clip(got, MAX_SAMPLE),
            })

        raw = gl.eq_principle.prompt_comparative(
            look,
            principle=(
                "Both answers must carry the same value in the field named outcome, one of "
                "REACHED, EMPTY or REFUSED. That field is the whole result: it says whether "
                "this endpoint can be reached from inside a contract at all. The sample is "
                "not compared, because two readers fetching the same endpoint a moment apart "
                "will not receive byte identical bodies, and a rule that bound the sample "
                "would fail for a reason that has nothing to do with reachability."
            ),
        )

        outcome = _outcome(raw)
        if not outcome:
            return json.dumps({"ok": False, "error": "the round produced no outcome "
                                                     "this contract recognises"})

        record = {
            "index": len(self.attempts),
            "how": way,
            "url": where,
            "outcome": outcome,
            "sample": _field(raw, "sample", MAX_SAMPLE),
        }
        self.attempts.append(json.dumps(record))
        return json.dumps({"ok": True, **record})

    @gl.public.view
    def size(self) -> str:
        return json.dumps({"attempts": len(self.attempts)})

    @gl.public.view
    def attempt_at(self, index: str) -> str:
        try:
            position = int(str(index).strip())
        except Exception:
            return json.dumps({"ok": False, "error": "which attempt"})
        if position < 0 or position >= len(self.attempts):
            return json.dumps({"ok": False, "error": "no attempt at that index"})
        return json.dumps({"ok": True, "attempt": json.loads(self.attempts[position])})
