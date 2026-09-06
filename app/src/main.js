// The badge, and the two things anybody can do to a token.
//
// This is not a trading screen. There is no price, no chart and no liquidity,
// and none of that is hidden. The one job here is that somebody looking at a
// token can decide for themselves whether its rules are real.
//
// So the rules are the page. Everything financial is underneath them, because
// the supply and the holder list are not what is being claimed.
//
// State is one object and there is one render. That is the whole architecture,
// and it is enough: several ticks can be in flight at once, each with its own
// clock, and a re-render draws whatever is true now.
import { connect, currentAccount, onAccountChange, read, write, short, EXPLORER } from './chain.js';

const app = document.getElementById('app');

const state = {
  route: location.hash.slice(1) || '',
  account: null,
  address: '',
  loading: false,
  error: null,
  status: null,
  badge: null,
  firings: null,
  // One entry per rule being worked on: {phase, seconds, note}. Keyed by index
  // so two rules can be in flight at once without either losing its clock.
  busy: {},
  funding: null,
};

const set = (patch) => { Object.assign(state, patch); render(); };
const busy = (index, patch) => set({ busy: { ...state.busy, [index]: patch } });
const clearBusy = (index) => {
  const next = { ...state.busy };
  delete next[index];
  set({ busy: next });
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const gen = (wei) => {
  const n = BigInt(wei || 0);
  if (n === 0n) return '0';
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

const when = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
};

// ---------------------------------------------------------------- loading

async function load(address) {
  set({ loading: true, error: null, address });
  try {
    const [status, badge, firings] = await Promise.all([
      read(address, 'status'),
      read(address, 'rules_view'),
      read(address, 'firings_view'),
    ]);
    set({ status, badge, firings, loading: false });
  } catch (e) {
    // Saying "nothing answered" when the node was merely busy is a lie, and it
    // sends somebody off to check an address that was never the problem. The
    // reason the chain gave goes on the page.
    const why = String(e?.details || e?.shortMessage || e?.message || e);
    const busyNode = /-32005|at capacity|gas rate|rate limit|429|503|502|timeout|fetch/i.test(why);
    set({
      loading: false, status: null, badge: null, firings: null,
      error: busyNode
        ? `The GenLayer node did not answer in time. That is the network being
           busy, not a problem with this address. Try again in a moment.
           (${why})`
        : `Nothing usable came back from that address on GenLayer Asimov. It may
           be a contract of another kind, or on another network. (${why})`,
    });
  }
}

async function refresh() {
  if (!state.address) return;
  try {
    const [status, badge, firings] = await Promise.all([
      read(state.address, 'status'),
      read(state.address, 'rules_view'),
      read(state.address, 'firings_view'),
    ]);
    set({ status, badge, firings });
  } catch { /* leave what is on screen */ }
}

// ------------------------------------------------------------- the actions

async function doTick(index) {
  if (!currentAccount()) {
    try { set({ account: await connect() }); }
    catch (e) { return busy(index, { phase: 'error', note: e.message }); }
  }

  const wasFired = state.badge?.rules?.[index]?.state === 'FIRED';
  busy(index, { phase: 'signing', seconds: 0 });

  try {
    await write(state.address, 'tick', [String(index)], {
      onTick: (seconds) => busy(index, { phase: 'asking', seconds }),
      // A tick that answers NOT_MET or CANNOT_TELL changes nothing on chain, so
      // there is no state change to wait for and waiting for one would hang
      // until the timeout. What is waited on is the round having run at all,
      // which shows up either as the rule firing or as the transaction being
      // done, so this settles on the firing and the caller handles the rest.
      settled: async () => {
        const badge = await read(state.address, 'rules_view');
        set({ badge });
        return !wasFired && badge.rules[index].state === 'FIRED';
      },
    });
    clearBusy(index);
    await refresh();
  } catch (e) {
    const after = await read(state.address, 'rules_view').catch(() => null);
    if (after && after.rules[index].state === 'FIRED') {
      set({ badge: after });
      clearBusy(index);
      await refresh();
      return;
    }
    // The common ending, and not an error: the round ran and did not settle it.
    busy(index, { phase: 'unsettled', note: e.message });
    if (after) set({ badge: after });
  }
}

async function doFund(amount) {
  if (!currentAccount()) {
    try { set({ account: await connect() }); }
    catch (e) { return set({ funding: { phase: 'error', note: e.message } }); }
  }
  let wei;
  try {
    const [whole, frac = ''] = String(amount).trim().split('.');
    wei = BigInt(whole || 0) * 10n ** 18n
      + BigInt((frac + '0'.repeat(18)).slice(0, 18) || 0);
  } catch {
    return set({ funding: { phase: 'error', note: 'That is not an amount.' } });
  }
  if (wei <= 0n) return set({ funding: { phase: 'error', note: 'Send more than nothing.' } });

  const before = BigInt(state.badge?.bounty_ever_funded || 0);
  set({ funding: { phase: 'signing', seconds: 0 } });
  try {
    await write(state.address, 'fund', [], {
      value: wei,
      onTick: (seconds) => set({ funding: { phase: 'sending', seconds } }),
      settled: async () => {
        const badge = await read(state.address, 'rules_view');
        set({ badge });
        return BigInt(badge.bounty_ever_funded) > before;
      },
    });
    set({ funding: null });
    await refresh();
  } catch (e) {
    set({ funding: { phase: 'error', note: e.message } });
  }
}

// ---------------------------------------------------------------- drawing

function head() {
  const acc = state.account;
  return `
    <header>
      <a class="wordmark" href="#">charter<span>.fun</span></a>
      <div class="head-right">
        <span class="net">GenLayer Asimov</span>
        ${acc
          ? `<span class="acct" title="${esc(acc)}">${esc(short(acc))}</span>`
          : `<button class="ghost" data-act="connect">Connect a wallet</button>`}
      </div>
    </header>`;
}

function lookup() {
  return `
    <form class="lookup" data-act="lookup">
      <label for="addr">A charter token on GenLayer Asimov</label>
      <div class="row">
        <input id="addr" name="addr" spellcheck="false" autocomplete="off"
               placeholder="0x…" value="${esc(state.address)}" />
        <button type="submit">Read it</button>
      </div>
      <p class="hint">Reading needs no wallet and no account.</p>
    </form>`;
}

// A rule nobody has checked is not a passing rule and it is not a failing one.
// "Untested" is what it actually means, and the mark is an empty dashed ring
// rather than a tick or a cross, so it reads as a gap rather than a verdict.
function ruleMark(rule) {
  if (rule.state === 'FIRED') {
    return `<span class="mark fired" title="This rule has been carried out">●</span>`;
  }
  return `<span class="mark untested" title="Nobody has checked this rule yet">○</span>`;
}

function ruleRow(rule, index) {
  const work = state.busy[index];
  const fired = rule.state === 'FIRED';

  // Claim on the left, the evidence it will be judged against on the right,
  // with an arrow between them. A condition nobody could check from the page
  // beside it does not need an accusation from us: the two columns simply do
  // not meet, and a reader sees that before they read a word from us.
  const evidence = rule.checked_against
    ? `<a href="${esc(rule.checked_against)}" target="_blank" rel="noopener noreferrer"
          class="evidence">${esc(rule.checked_against)}</a>`
    : `<span class="evidence none">no page named; judged on what the token
         can see about itself</span>`;

  return `
    <article class="rule ${fired ? 'is-fired' : ''}">
      <div class="rule-head">
        ${ruleMark(rule)}
        <span class="state">${fired ? 'Carried out' : 'Untested'}</span>
        <span class="does">${esc(rule.then)} ${esc(rule.amount)}</span>
      </div>

      <div class="claim-evidence">
        <div class="claim">${esc(rule.when)}</div>
        <div class="arrow" aria-hidden="true">→</div>
        <div class="against">
          <span class="against-label">checked against</span>
          ${evidence}
        </div>
      </div>

      ${fired ? firedDetail(rule) : untestedDetail(rule, index, work)}
    </article>`;
}

function firedDetail(rule) {
  return `
    <div class="detail">
      <p class="why">${esc(rule.why)}</p>
      ${rule.quote ? `
        <blockquote class="quote">${esc(rule.quote)}</blockquote>
        <p class="quote-stamp">What the round said it was reading, ${esc(when(rule.fired_at))}.
           The page is not stored anywhere and may have changed since.</p>` : ''}
      <p class="by">Made to happen by
        <a href="${EXPLORER}/address/${esc(rule.fired_by)}" target="_blank"
           rel="noopener noreferrer">${esc(short(rule.fired_by))}</a>,
        who needed nobody's permission.</p>
    </div>`;
}

function untestedDetail(rule, index, work) {
  if (!work) {
    return `
      <div class="detail">
        <button class="tick" data-act="tick" data-rule="${index}">Check this rule</button>
        <span class="tick-note">Anybody can. It takes about a minute.</span>
      </div>`;
  }

  if (work.phase === 'unsettled') {
    // Not red, and not called an error, because it is not one. A round of
    // validators looked and did not reach a single answer, which is a thing
    // that happens and which the person should be told plainly.
    return `
      <div class="detail unsettled">
        <p class="unsettled-head">The round did not settle it</p>
        <p>The validators looked and did not arrive at one answer. That happens:
           the page may not have loaded, or it may not speak clearly enough to
           the condition. Nothing moved and nothing was spent from the bounty.</p>
        <button class="tick" data-act="tick" data-rule="${index}">Ask again</button>
      </div>`;
  }

  if (work.phase === 'error') {
    return `<div class="detail"><p class="err">${esc(work.note)}</p>
      <button class="tick" data-act="tick" data-rule="${index}">Try again</button></div>`;
  }

  // A spinner for a minute reads as a frozen page. The steps say what is
  // actually happening, and the clock counts up rather than pretending to know
  // how long it will take.
  const steps = [
    ['signing', 'Waiting for your wallet'],
    ['asking', 'Validators are fetching the page and reading it'],
  ];
  const at = steps.findIndex(([k]) => k === work.phase);
  return `
    <div class="detail working">
      <ol class="steps">
        ${steps.map(([key, label], i) => `
          <li class="${i < at ? 'done' : i === at ? 'now' : ''}">
            <span class="box">${i < at ? '×' : i === at ? '·' : ' '}</span>${label}
          </li>`).join('')}
      </ol>
      <p class="clock">${work.seconds ? `${work.seconds}s elapsed` : ''}</p>
    </div>`;
}

// An empty bounty means one of three different things and they are not
// interchangeable. Telling somebody nobody ever paid for these rules, when in
// fact the money was paid out to whoever did the work, is exactly the kind of
// wrong sentence that makes a badge worth nothing.
function bountyWords(badge) {
  const now = BigInt(badge.bounty || 0);
  const ever = BigInt(badge.bounty_ever_funded || 0);
  const waiting = badge.waiting_rules;

  if (now > 0n) {
    return `Put up so that whoever checks a rule is paid for it.
      ${esc(gen(badge.bounty_per_waiting_rule))} GEN for each of the ${waiting}
      still untested. Nobody can take it back out, including whoever added it.`;
  }
  if (ever === 0n) {
    return `Nobody has put up anything to have these rules checked. Checking one
      costs gas, so a rule with nothing behind it is a rule that may sit untested
      for a long time.`;
  }
  if (waiting === 0) {
    return `${esc(gen(ever))} GEN was put up and all of it went to whoever made
      these rules happen. There is nothing left because there is nothing left to
      do.`;
  }
  return `${esc(gen(ever))} GEN was put up and all of it has been claimed, but
    ${waiting} rule${waiting === 1 ? '' : 's'} still ${waiting === 1 ? 'goes' : 'go'}
    unchecked. Anybody who wants ${waiting === 1 ? 'it' : 'them'} looked at can
    put up more.`;
}

function bounty() {
  const badge = state.badge;
  const now = BigInt(badge.bounty || 0);
  const ever = BigInt(badge.bounty_ever_funded || 0);
  // Dashed only when nothing was ever put up. A bounty that was funded and
  // claimed is a thing that worked, not a gap.
  const missing = now === 0n && ever === 0n;
  const f = state.funding;

  return `
    <section class="bounty ${missing ? 'empty' : ''}">
      <div class="bounty-figure">
        <span class="bounty-amount">${esc(gen(badge.bounty))}</span>
        <span class="bounty-unit">GEN</span>
      </div>
      <p class="bounty-what">${bountyWords(badge)}</p>
      ${f && f.phase !== 'error' ? `
        <p class="funding">Adding to the bounty${f.seconds ? `, ${f.seconds}s elapsed` : ''}…</p>`
        : `
        <form class="fund" data-act="fund">
          <input name="amount" inputmode="decimal" spellcheck="false"
                 placeholder="0.01" aria-label="Amount in GEN" />
          <button type="submit">${missing ? 'Put something up' : 'Add to it'}</button>
        </form>`}
      ${f && f.phase === 'error' ? `<p class="err">${esc(f.note)}</p>` : ''}
    </section>`;
}

function tokenView() {
  const { status, badge, firings } = state;
  return `
    <section class="identity">
      <h1>${esc(status.name)} <span class="sym">${esc(status.symbol)}</span></h1>
      <p class="launched">Launched ${esc(when(status.launched_at))} by
        <a href="${EXPLORER}/address/${esc(status.creator)}" target="_blank"
           rel="noopener noreferrer">${esc(short(status.creator))}</a>.</p>
    </section>

    <section class="charter">
      <div class="charter-head">
        <h2>The rules</h2>
        <p class="frozen">Written into the token when it was launched. No method on
          this contract can add, edit or remove one, and that includes the
          creator's.</p>
      </div>
      ${badge.rules.length
        ? badge.rules.map(ruleRow).join('')
        : `<p class="none">This token carries no rules. There is nothing here to check.</p>`}
    </section>

    ${bounty()}

    ${firings && firings.count ? `
      <section class="history">
        <h2>What has happened</h2>
        ${firings.firings.map(f => `
          <div class="firing">
            <span class="firing-what">${esc(f.then)} ${esc(f.amount)}</span>
            <span class="firing-when">${esc(when(f.at))}</span>
            <p class="firing-why">${esc(f.why)}</p>
          </div>`).join('')}
      </section>` : ''}

    <section class="numbers">
      <h2>The token itself</h2>
      <dl>
        <div><dt>Supply</dt><dd>${esc(status.supply)}</dd></div>
        <div><dt>Treasury</dt><dd>${esc(status.treasury)}</dd></div>
        <div><dt>Holders</dt><dd>${esc(status.holders)}</dd></div>
        <div><dt>Rules carried out</dt><dd>${esc(status.fired)} of ${esc(status.rules)}</dd></div>
      </dl>
      <p class="numbers-note">There is no market for this token. No pool, no price,
        no chart. What is on this page is the rules and whether they have been
        kept, which is the only thing it claims.</p>
    </section>`;
}

function render() {
  app.innerHTML = `
    ${head()}
    <main>
      ${lookup()}
      ${state.loading ? `<p class="loading">Reading the contract…</p>` : ''}
      ${state.error ? `<p class="err standalone">${esc(state.error)}</p>` : ''}
      ${state.status && state.badge ? tokenView() : ''}
    </main>
    <footer>
      <p>Reading is free and needs no account. Checking a rule needs gas and pays
         the bounty share to whoever does it.</p>
    </footer>`;
}

// ------------------------------------------------------------------ events

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  if (act === 'connect') {
    event.preventDefault();
    try { set({ account: await connect() }); }
    catch (e) { set({ error: e.message }); }
  }
  if (act === 'tick') {
    event.preventDefault();
    doTick(Number(button.dataset.rule));
  }
});

app.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-act]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.dataset.act === 'lookup') {
    const address = String(data.get('addr') || '').trim();
    if (address) { location.hash = address; }
  }
  if (form.dataset.act === 'fund') doFund(data.get('amount'));
});

window.addEventListener('hashchange', () => {
  const address = location.hash.slice(1);
  if (address) load(address); else set({ status: null, badge: null, address: '' });
});

onAccountChange(account => set({ account }));

render();
if (location.hash.slice(1)) load(location.hash.slice(1));
