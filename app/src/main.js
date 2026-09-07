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
import { readToken, BASE_EXPLORER } from './evm.js';
import { launch, recentLaunches, LAUNCHPAD } from './launch.js';

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
  // The other half of a charter token: the badges, on the EVM chain, enforced
  // by ordinary code. Null when the address looked up was not one.
  evm: null,
  // The launch form. `form` is what has been typed and ticked, `launching` is
  // what is happening to it.
  form: {
    name: '', symbol: '', supply: '1000000',
    ceiling: false, ceilingPct: '5',
    slow: false, slowPct: '5', slowHours: '1',
    taint: false,
    understood: false,
  },
  launching: null,
  // Everything launched here, newest first. Read off the chain, so an empty
  // list means nobody has launched yet rather than that a server is down.
  recent: null,
  recentError: null,
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
  set({ loading: true, error: null, address, evm: null, status: null, badge: null });

  // An address is looked up on both chains, because a charter token is two
  // things and a person holding one address should not have to know which.
  // The badges are on the EVM side and the judged rules are on GenLayer.
  try {
    const evm = await readToken(address);
    set({ evm, loading: false });
    return;
  } catch { /* not an ERC-20 we recognise; try the other chain */ }

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
      <a class="launch-link" href="#launch">Launch a token</a>
      <div class="head-right">
        <span class="net">${state.evm || state.route === 'launch'
          ? 'Base Sepolia' : 'GenLayer Asimov'}</span>
        ${acc
          ? `<span class="acct" title="${esc(acc)}">${esc(short(acc))}</span>`
          : `<button class="ghost" data-act="connect">Connect a wallet</button>`}
      </div>
    </header>`;
}

function lookup() {
  return `
    <form class="lookup" data-act="lookup">
      <label for="addr">A charter token, on Base Sepolia or GenLayer Asimov</label>
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


// ------------------------------------------------------------- what is here

async function loadRecent() {
  try {
    set({ recent: await recentLaunches(20), recentError: null });
  } catch (e) {
    // Distinguished from an empty list on purpose. "Nobody has launched yet"
    // and "the chain did not answer" look the same on a page and mean opposite
    // things to somebody deciding whether this works.
    set({ recent: null,
          recentError: String(e.shortMessage || e.message).slice(0, 160) });
  }
}

function recentList() {
  if (state.recentError) {
    return `<section class="recent">
      <h2>Launched here</h2>
      <p class="err">Base Sepolia did not answer, so this list is unknown rather
        than empty. (${esc(state.recentError)})</p>
    </section>`;
  }
  if (!state.recent) {
    return `<section class="recent"><h2>Launched here</h2>
      <p class="loading">Reading the launchpad…</p></section>`;
  }
  const { total, launches } = state.recent;
  if (!total) {
    return `<section class="recent">
      <h2>Launched here</h2>
      <p class="none">Nothing yet. The launchpad is at
        <code>${esc(LAUNCHPAD)}</code> on Base Sepolia and its list is empty,
        which anybody can check without asking us.</p>
    </section>`;
  }
  return `<section class="recent">
    <h2>Launched here${total > launches.length ? `, newest ${launches.length} of ${total}` : ''}</h2>
    <ul class="launches">
      ${launches.map(l => `
        <li>
          <a class="launch-row" href="#${esc(l.token)}">
            <span class="launch-name">${esc(l.name)}</span>
            <span class="launch-sym">${esc(l.symbol)}</span>
            <span class="launch-by">by ${esc(short(l.creator))}</span>
            <span class="launch-at">${esc(when(new Date(l.launchedAt * 1000).toISOString()))}</span>
          </a>
        </li>`).join('')}
    </ul>
  </section>`;
}

// ------------------------------------------------------------ launching one

async function doLaunch() {
  const f = state.form;
  const name = f.name.trim();
  const symbol = f.symbol.trim();
  const supply = f.supply.trim();

  if (!name || !symbol || !/^[0-9]+$/.test(supply) || BigInt(supply) <= 0n) {
    return set({ launching: { phase: 'error',
      note: 'A name, a symbol and a whole number of tokens.' } });
  }
  if (!f.understood) {
    return set({ launching: { phase: 'error',
      note: 'The badges cannot be changed afterwards. Confirm that you know.' } });
  }

  const badges = {
    creatorCeilingBps: f.ceiling ? Math.round(Number(f.ceilingPct) * 100) : 0,
    slowExitBps: f.slow ? Math.round(Number(f.slowPct) * 100) : 0,
    slowExitWindow: f.slow ? Math.round(Number(f.slowHours) * 3600) : 0,
    // A cap that does not follow the tokens is escaped by one transfer, so
    // choosing the cap chooses the taint with it. Offering them apart would be
    // offering a badge that does not work.
    taintFollows: f.taint || f.slow,
  };

  set({ launching: { phase: 'signing' } });
  try {
    const { address } = await launch({
      name, symbol, supply, treasuryShare: 0, badges,
    });
    set({ launching: null });
    location.hash = address;
  } catch (e) {
    set({ launching: { phase: 'error',
      note: String(e.shortMessage || e.message).slice(0, 200) } });
  }
}

function launchForm() {
  const f = state.form;
  const l = state.launching;
  const chosen = [f.ceiling, f.slow, f.taint].filter(Boolean).length;

  return `
    <form class="launch" data-act="launch">
      <section class="identity">
        <h1>Launch a token</h1>
        <p class="launched">On Base Sepolia, from your own wallet. Nothing here
          can reach the token afterwards, including us.</p>
      </section>

      <div class="field-row">
        <label>Name<input name="name" value="${esc(f.name)}" placeholder="Charter Coin" /></label>
        <label>Symbol<input name="symbol" value="${esc(f.symbol)}" placeholder="CHRT" /></label>
        <label>Supply<input name="supply" value="${esc(f.supply)}" inputmode="numeric" /></label>
      </div>

      <h2>Badges</h2>
      <p class="frozen">Tick what you want the token to hold you to. You can tick
        none, and a token with none is a normal token: its page will say so
        plainly rather than leave it out.</p>

      <label class="pick ${f.ceiling ? 'on' : ''}">
        <input type="checkbox" name="ceiling" ${f.ceiling ? 'checked' : ''} />
        <span class="pick-body">
          <span class="pick-name">Creator ceiling</span>
          <span class="pick-what">You may never hold more than
            <input class="inline" name="ceilingPct" value="${esc(f.ceilingPct)}"
                   inputmode="decimal" />% of the supply. Whatever you may not
            hold, the token holds from the first block, so the badge is true on
            day one rather than after your first transfer.</span>
        </span>
      </label>

      <label class="pick ${f.slow ? 'on' : ''}">
        <input type="checkbox" name="slow" ${f.slow ? 'checked' : ''} />
        <span class="pick-body">
          <span class="pick-name">Slow exit</span>
          <span class="pick-what">You may move at most
            <input class="inline" name="slowPct" value="${esc(f.slowPct)}"
                   inputmode="decimal" />% of what you hold every
            <input class="inline" name="slowHours" value="${esc(f.slowHours)}"
                   inputmode="decimal" /> hour(s). Every outgoing transfer
            counts, not just sales, and anybody you send to inherits the same
            limit. It does not stop you leaving; it stops you leaving inside one
            block.</span>
        </span>
      </label>

      <label class="pick ${f.taint || f.slow ? 'on' : ''} ${f.slow ? 'forced' : ''}">
        <input type="checkbox" name="taint" ${f.taint || f.slow ? 'checked' : ''}
               ${f.slow ? 'disabled' : ''} />
        <span class="pick-body">
          <span class="pick-name">The limits follow the tokens</span>
          <span class="pick-what">Anybody you send tokens to inherits your limits.
            ${f.slow
              ? 'Included with the slow exit, because a cap that does not follow '
                + 'the tokens is escaped by one transfer.'
              : 'On its own this marks the wallets you funded without capping '
                + 'anything, which is worth less than it sounds.'}</span>
        </span>
      </label>

      <label class="confirm">
        <input type="checkbox" name="understood" ${f.understood ? 'checked' : ''} />
        <span>I understand that ${chosen ? 'these badges' : 'this token carrying no badges'}
          cannot be changed or removed after launch, by me or by anybody.</span>
      </label>

      ${l && l.phase === 'signing'
        ? `<p class="funding">Waiting for your wallet, then for Base to mine it…</p>`
        : `<button type="submit">Launch it</button>`}
      ${l && l.phase === 'error' ? `<p class="err">${esc(l.note)}</p>` : ''}
    </form>`;
}

// -------------------------------------------------------------- the badges

const pct = (bps) => {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac ? `${whole}.${String(frac).padStart(2, '0')}%` : `${whole}%`;
};

/** A window as a count and a unit, so a sentence can say "per hour" and
 *  "takes about 20 hours" from the same number without either reading like a
 *  machine wrote it. */
const perWindow = (seconds) => {
  for (const [size, unit] of [[86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return { each: n === 1 ? unit : `${n} ${unit}s`, plural: `${unit}s` };
    }
  }
  return { each: `${seconds} seconds`, plural: 'windows' };
};

/**
 * One card per badge the creator chose.
 *
 * Each says what it promises, what it is doing right now, and where it is
 * weak. The last of those is the part that makes the rest worth reading: a
 * badge that only ever flatters the token is the pinned message again.
 *
 * Every badge here is enforced by the token itself on every transfer. There is
 * no round, no waiting and nobody to ask, and the card says so, because a
 * buyer should never have to guess whether a promise is arithmetic or an
 * opinion.
 */
function badgeCards(evm) {
  const b = evm.badges;
  const supply = BigInt(evm.totalSupply);
  const cards = [];

  if (b.creatorCeilingBps > 0) {
    const ceiling = (supply * BigInt(b.creatorCeilingBps)) / 10000n;
    const holds = BigInt(evm.creatorHolds);
    cards.push({
      name: 'Creator ceiling',
      promise: `The creator may never hold more than ${pct(b.creatorCeilingBps)} of
        the supply. Not at launch, not later, not by buying back.`,
      now: `Holding ${holds} of a permitted ${ceiling}.`,
      weak: `Other wallets. On its own this says little, because a creator who
        wanted a bigger bag would hold it somewhere else. It is worth something
        next to the taint below, and next to the holder list.`,
      ok: holds <= ceiling,
    });
  }

  if (b.slowExitBps > 0) {
    const w = perWindow(b.slowExitWindow);
    cards.push({
      name: 'Slow exit',
      promise: `The creator may move at most ${pct(b.slowExitBps)} of what it holds
        per ${w.each}. Every outgoing transfer counts, not just sales, so moving
        the bag to another wallet is capped by the same rule.`,
      now: `${evm.badges.creatorMovableNow} movable right now.`,
      weak: `It does not stop an exit, it slows one. At ${pct(b.slowExitBps)} per
        ${w.each} a full exit still takes about
        ${Math.round(10000 / b.slowExitBps)} ${w.plural}. What it stops is
        leaving inside one block, before anybody can react.`,
      ok: true,
    });
  }

  if (b.taintFollows) {
    cards.push({
      name: 'The limits follow the tokens',
      promise: `Anybody the creator sends tokens to inherits the creator's limits,
        from the moment they receive them. The usual escape is to send the bag to
        a fresh wallet and sell from there. Here the move out is itself capped,
        and the move is itself the evidence.`,
      now: null,
      weak: `A wallet funded before launch, that never touched the creator's
        tokens, leaves no trace on this ledger to follow. Catching those needs a
        judgement rather than a lookup.`,
      ok: true,
    });
  }

  return cards;
}

function evmView() {
  const evm = state.evm;
  const cards = badgeCards(evm);

  return `
    <section class="identity">
      <h1>${esc(evm.name)} <span class="sym">${esc(evm.symbol)}</span></h1>
      <p class="launched">An ERC-20 on Base Sepolia, launched by
        <a href="${BASE_EXPLORER}/address/${esc(evm.owner)}" target="_blank"
           rel="noopener noreferrer">${esc(short(evm.owner))}</a>.</p>
    </section>

    <section class="charter">
      <div class="charter-head">
        <h2>The badges</h2>
        <p class="frozen">Chosen when the token was launched and removable by
          nobody, the creator included. Each is enforced by the token itself on
          every transfer: no round, no waiting, nobody to ask.</p>
      </div>

      ${cards.length ? cards.map(card => `
        <article class="rule ${card.ok ? 'is-fired' : ''}">
          <div class="rule-head">
            <span class="mark ${card.ok ? 'fired' : 'untested'}">${card.ok ? '●' : '○'}</span>
            <span class="state">${esc(card.name)}</span>
            <span class="does">enforced in code</span>
          </div>
          <div class="claim">${esc(card.promise)}</div>
          ${card.now ? `<p class="badge-now">${esc(card.now)}</p>` : ''}
          <div class="detail">
            <p class="badge-weak"><strong>Where it is weak.</strong> ${esc(card.weak)}</p>
          </div>
        </article>`).join('')
        : `<div class="no-badges">
             <p class="no-badges-head">This token carries no badges.</p>
             <p>Nothing here limits what its creator can do with it. That is a
                legitimate way to launch and it is not hidden: the absence is
                the information.</p>
           </div>`}
    </section>

    <section class="numbers">
      <h2>The token itself</h2>
      <dl>
        <div><dt>Supply</dt><dd>${esc(evm.totalSupply)}</dd></div>
        <div><dt>Held by the token</dt><dd>${esc(evm.treasury)}</dd></div>
        <div><dt>Creator holds</dt><dd>${esc(evm.creatorHolds)}</dd></div>
        <div><dt>Holders</dt><dd>${esc(evm.holders)}</dd></div>
      </dl>
      <p class="numbers-note">
        ${evm.genlayerToken && !/^0x0+$/.test(evm.genlayerToken)
          ? `Judged rules for this token are decided on ${esc(evm.genlayerChain)} at
             <code>${esc(evm.genlayerToken)}</code>.`
          : `This token carries no judged rules, only the badges above.`}
      </p>
    </section>`;
}

function render() {
  app.innerHTML = `
    ${head()}
    <main>
      ${state.route === 'launch' ? launchForm() : lookup()}
      ${state.route !== 'launch' && !state.evm && !state.status
        ? recentList() : ''}
      ${state.loading ? `<p class="loading">Reading the contract…</p>` : ''}
      ${state.error ? `<p class="err standalone">${esc(state.error)}</p>` : ''}
      ${state.evm ? evmView() : ''}
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

app.addEventListener('input', (event) => {
  const form = event.target.closest('form[data-act="launch"]');
  if (!form) return;
  const el = event.target;
  const value = el.type === 'checkbox' ? el.checked : el.value;
  // Assigned rather than set(), because re-rendering on every keystroke would
  // take the cursor out of the field somebody is typing in.
  state.form = { ...state.form, [el.name]: value };
  if (el.type === 'checkbox') render();
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
  if (form.dataset.act === 'launch') doLaunch();
});

window.addEventListener('hashchange', () => {
  const at = location.hash.slice(1);
  state.route = at === 'launch' ? 'launch' : '';
  if (at && at !== 'launch') load(at);
  else {
    set({ status: null, badge: null, evm: null, address: '' });
    if (at !== 'launch') loadRecent();
  }
});

onAccountChange(account => set({ account }));

const at = location.hash.slice(1);
state.route = at === 'launch' ? 'launch' : '';
render();
if (at && at !== 'launch') load(at);
else loadRecent();
