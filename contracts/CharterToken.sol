// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.26;

/// @title CharterToken
/// @notice An ordinary ERC-20 whose treasury is spoken for in advance.
///
/// The rules live on GenLayer, where a contract can read a web page and a round
/// of validators can decide whether a condition written in plain words has been
/// met. That decision cannot reach this chain by itself, so a carrier delivers
/// it. This contract exists to make the carrier not matter very much.
///
/// ## What a rule is here
///
/// At deployment the creator writes, for each rule, what it does and how much:
/// burn N tokens from the treasury, or distribute N to holders. Those numbers
/// are immutable and the carrier never supplies them. It supplies one thing: a
/// rule index that GenLayer has marked FIRED.
///
/// ## What a hostile carrier can do
///
/// It can fire a rule that GenLayer has not fired, or fire one early. That is
/// real, and it is the price of a cross chain verdict without a bridge. What it
/// buys back is that the damage has a ceiling written into the contract:
///
///   it cannot choose an amount       each amount was fixed at deployment
///   it cannot invent a rule          only indices that exist, only once each
///   it cannot name a destination     a burn goes nowhere, a distribution goes
///                                    pro rata to holders by the same
///                                    arithmetic every time, and neither can
///                                    pay the carrier
///   it cannot reach a holder         rules act on the treasury this contract
///                                    holds, never on anybody's balance
///   it cannot undo a firing          there is no unfire, so it cannot fire and
///                                    then quietly reverse it
///
/// So the worst it does is make the token keep its own promises sooner than it
/// should have. It cannot take anything, cannot send anything anywhere new, and
/// cannot stop a rule that has fired from having fired.
///
/// A premature firing is also visible. The GenLayer side is public and anybody
/// can read whether the rule it claims is actually FIRED there, so this contract
/// records which GenLayer token the rules answer to. A rule index means nothing
/// on its own: index 0 exists in every charter token ever deployed, and a
/// firing that named only an index could be a decision about somebody else's
/// token delivered here.
contract CharterToken {
    // ---------------------------------------------------------------- erc20

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ---------------------------------------------------------- the charter

    enum Action { BURN, DISTRIBUTE }

    struct Rule {
        string when;      // the condition, in the words it was written in
        string url;       // where GenLayer was told to look
        Action act;
        uint256 amount;   // fixed here, at deployment, forever
        bool fired;
        uint64 firedAt;
        string why;       // what the round said decided it
        string quote;     // the words on the page it said it was reading
    }

    Rule[] private rules;

    /// The GenLayer contract these rules are decided by, and the network it is
    /// on. Recorded so that checking a firing needs nothing but this receipt.
    string public genlayerToken;
    string public genlayerChain;

    /// The treasury the rules act on. Held by this contract, never taken from a
    /// holder, and the ceiling on everything a rule can ever do.
    uint256 public treasury;

    address public owner;
    address public carrier;

    /// Holders in order of first receipt, so a distribution has a list to work
    /// from. Append only: an address that empties out stays in the list and
    /// simply receives nothing.
    address[] private holders;
    mapping(address => bool) private known;

    // ------------------------------------------------------------- the badges
    //
    // Chosen by the creator at launch by ticking a box, written here, and never
    // removable by anyone. A token can carry none of them; that is a legitimate
    // launch and the absence is as visible as the presence.
    //
    // These four need no validator round. They are arithmetic over balances and
    // block.timestamp, they run on every transfer, they cost nothing, and they
    // cannot fail to fire. Asking a round what time it is would be absurd.

    struct Badges {
        // The creator may never hold more than this share of supply, in
        // hundredths of a percent. 0 means the badge was not chosen.
        uint256 creatorCeilingBps;
        // The creator may move at most this share of their own holding per
        // window, in hundredths of a percent, counting every outgoing transfer
        // rather than only sales. 0 means the badge was not chosen.
        uint256 slowExitBps;
        uint256 slowExitWindow;      // seconds
        // Anybody the creator sent tokens to inherits the creator's limits, so
        // moving to a fresh wallet buys nothing: the move is itself capped, and
        // the move is itself the evidence.
        bool taintFollows;
    }

    Badges public badges;

    /// Addresses held to the creator's limits. The creator from launch, and
    /// afterwards anybody the creator or an already-marked address sent to.
    mapping(address => bool) public restricted;

    /// Rolling window per restricted address: what has left, and when the
    /// window it belongs to started.
    mapping(address => uint256) private movedInWindow;
    mapping(address => uint256) private windowStartedAt;

    event Restricted(address indexed who, address indexed by);

    error OverCreatorCeiling(uint256 wouldHold, uint256 ceiling);
    error MovingTooFast(uint256 wanted, uint256 allowedThisWindow);

    event RuleFired(uint256 indexed rule, Action action, uint256 amount, string why);
    event CarrierChanged(address indexed from, address indexed to);
    event Distributed(uint256 amount, uint256 paid, uint256 returnedToTreasury);

    error NotOwner();
    error NotCarrier();
    error NoSuchRule();
    error AlreadyFired();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    struct Charter {
        string[] conditions;
        string[] urls;
        uint8[] actions;
        uint256[] amounts;
    }

    /// @param treasuryShare percent of supply held back for the rules, 0 to 100
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        uint256 treasuryShare,
        address creator_,
        address carrier_,
        string memory genlayerToken_,
        string memory genlayerChain_,
        Charter memory charter,
        Badges memory chosen
    ) {
        require(treasuryShare <= 100, "share");
        require(creator_ != address(0), "creator");
        require(
            charter.conditions.length == charter.urls.length
                && charter.conditions.length == charter.actions.length
                && charter.conditions.length == charter.amounts.length,
            "rules"
        );

        name = name_;
        symbol = symbol_;
        owner = creator_;
        carrier = carrier_;
        genlayerToken = genlayerToken_;
        genlayerChain = genlayerChain_;

        // Refused rather than clamped. A ceiling above 100% or a window of zero
        // is a badge that reads as a promise and enforces nothing, and a launch
        // that quietly corrects it would put that badge on the token anyway.
        require(chosen.creatorCeilingBps <= 10000, "ceiling");
        require(chosen.slowExitBps <= 10000, "slow exit");
        require(chosen.slowExitBps == 0 || chosen.slowExitWindow > 0, "window");
        badges = chosen;

        // Whole tokens in, base units out.
        //
        // Declaring eighteen decimals and then storing an unscaled number is
        // the same as declaring none: a balance of a million reads as
        // 0.000000000001 in every wallet and every pool, and the mistake stays
        // invisible until somebody tries to trade it. Scaling here keeps the
        // constructor saying what a person means by a supply.
        uint256 scaled = supply_ * (10 ** uint256(decimals));
        totalSupply = scaled;
        uint256 held = (scaled * treasuryShare) / 100;
        // The ceiling binds from the first block, not from the first transfer.
        //
        // Without this, a creator could tick "I may hold at most five percent",
        // be handed the whole supply at launch, and carry a badge that says one
        // thing while the holder list says another. The ceiling would still be
        // working exactly as written, and the badge would still be a lie.
        //
        // What the creator may not hold, the token holds. That is not a
        // consolation prize: the treasury is reachable only by the rules, and a
        // creator who chose this badge chose that.
        uint256 toCreator = scaled - held;
        if (chosen.creatorCeilingBps > 0) {
            uint256 ceiling = (scaled * chosen.creatorCeilingBps) / 10000;
            if (toCreator > ceiling) {
                held += toCreator - ceiling;
                toCreator = ceiling;
            }
        }
        treasury = held;

        // The creator is marked from the start, so the very first transfer out
        // is already under whatever limits were chosen.
        if (chosen.taintFollows || chosen.slowExitBps > 0) {
            restricted[creator_] = true;
            emit Restricted(creator_, address(0));
        }
        _credit(creator_, toCreator);
        emit Transfer(address(0), creator_, toCreator);

        // Rules that together claim more than the treasury holds could not all
        // be carried out, and a badge for a rule that cannot work is worse than
        // no badge, so it is refused here rather than kept as decoration.
        uint256 claimed;
        for (uint256 i = 0; i < charter.conditions.length; i++) {
            require(charter.actions[i] <= uint8(Action.DISTRIBUTE), "action");
            require(charter.amounts[i] > 0, "amount");
            uint256 ruleAmount = charter.amounts[i] * (10 ** uint256(decimals));
            claimed += ruleAmount;
            require(claimed <= held, "over treasury");
            rules.push(Rule({
                when: charter.conditions[i],
                url: charter.urls[i],
                act: Action(charter.actions[i]),
                amount: ruleAmount,
                fired: false,
                firedAt: 0,
                why: "",
                quote: ""
            }));
        }
    }

    // -------------------------------------------------------------- the badge

    function ruleCount() external view returns (uint256) {
        return rules.length;
    }

    function ruleAt(uint256 index)
        external
        view
        returns (
            string memory when_,
            string memory url,
            Action act,
            uint256 amount,
            bool fired,
            uint64 firedAt,
            string memory why,
            string memory quote
        )
    {
        if (index >= rules.length) revert NoSuchRule();
        Rule storage r = rules[index];
        return (r.when, r.url, r.act, r.amount, r.fired, r.firedAt, r.why, r.quote);
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return holders[index];
    }

    // -------------------------------------------------------------- the rules

    /// Carry a decision GenLayer has already made.
    ///
    /// The caller supplies which rule, and what the round said about it. It does
    /// not supply what happens next: that was written at deployment and is read
    /// out of storage here.
    function fire(uint256 index, string calldata why, string calldata quote) external {
        if (msg.sender != carrier) revert NotCarrier();
        if (index >= rules.length) revert NoSuchRule();

        Rule storage r = rules[index];
        if (r.fired) revert AlreadyFired();

        r.fired = true;
        r.firedAt = uint64(block.timestamp);
        r.why = why;
        r.quote = quote;

        uint256 amount = r.amount > treasury ? treasury : r.amount;
        treasury -= amount;

        if (r.act == Action.BURN) {
            totalSupply -= amount;
            emit Transfer(address(this), address(0), amount);
        } else {
            _distribute(amount);
        }

        emit RuleFired(index, r.act, amount, why);
    }

    /// Pro rata to everybody holding a balance. What the division cannot split
    /// evenly goes back to the treasury rather than to whoever happens to be
    /// first in the list.
    function _distribute(uint256 amount) private {
        uint256 total;
        for (uint256 i = 0; i < holders.length; i++) total += balanceOf[holders[i]];
        if (total == 0 || amount == 0) {
            treasury += amount;
            return;
        }
        uint256 paid;
        for (uint256 i = 0; i < holders.length; i++) {
            address who = holders[i];
            uint256 share = (amount * balanceOf[who]) / total;
            if (share > 0) {
                balanceOf[who] += share;
                paid += share;
                emit Transfer(address(this), who, share);
            }
        }
        if (amount > paid) treasury += amount - paid;
        emit Distributed(amount, paid, amount - paid);
    }

    /// The owner may replace a carrier that has stopped running. It gains
    /// nothing by doing so: a new carrier has exactly the powers the old one
    /// had, which are the ones bounded at the top of this file.
    function setCarrier(address next) external onlyOwner {
        emit CarrierChanged(carrier, next);
        carrier = next;
    }

    // --------------------------------------------------------- erc20, plainly

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "to zero");
        require(balanceOf[from] >= value, "balance");

        _checkSlowExit(from, value);
        balanceOf[from] -= value;
        _checkCeiling(to, value);
        _credit(to, value);

        // The taint is applied after the transfer, never before, so it cannot
        // affect the limits on the transfer that created it. A marked address
        // marks whoever it sends to, which is what makes this cover a cluster
        // rather than a single address.
        //
        // Except a contract. Without that exception this badge destroys the
        // token it is meant to protect: the creator adds liquidity, the pool
        // receives from a marked address and is marked itself, and from then on
        // every single buyer is marked by the pool that sold to them. Everybody
        // who ever bought would be held to the creator's limits. A badge that
        // catches everyone has caught no one, and it would have shipped looking
        // like it worked, because a pool is the one recipient the tests did not
        // have.
        //
        // A contract is not somebody's wallet. What this gives up is a creator
        // who routes through a contract they wrote; what it keeps is the token
        // being usable at all.
        if (badges.taintFollows && restricted[from] && !restricted[to]
                && to.code.length == 0) {
            restricted[to] = true;
            emit Restricted(to, from);
        }

        emit Transfer(from, to, value);
    }

    /// The creator, and anybody the creator handed tokens to, may move only a
    /// share of what they hold per window.
    ///
    /// The cap is on every outgoing transfer rather than on sales, and that is
    /// the whole point of it. A cap on selling is escaped by moving to a second
    /// wallet and selling from there. A cap on moving is not, because the move
    /// out is itself capped.
    ///
    /// It does not prevent an exit. At five percent an hour a full exit takes
    /// about a day. It prevents an exit inside one block, before anybody can
    /// react, which is the thing that actually happens.
    function _checkSlowExit(address from, uint256 value) private {
        if (badges.slowExitBps == 0 || !restricted[from]) return;

        uint256 windowStart = windowStartedAt[from];
        uint256 movedSoFar = movedInWindow[from];
        if (block.timestamp >= windowStart + badges.slowExitWindow) {
            windowStart = block.timestamp;
            movedSoFar = 0;
        }

        // A share of what is held now plus what has already gone this window,
        // so spending the allowance does not shrink the allowance underneath
        // itself and leave a dust amount unmovable.
        uint256 allowed = ((balanceOf[from] + movedSoFar) * badges.slowExitBps) / 10000;
        if (movedSoFar + value > allowed) {
            revert MovingTooFast(value, allowed > movedSoFar ? allowed - movedSoFar : 0);
        }

        windowStartedAt[from] = windowStart;
        movedInWindow[from] = movedSoFar + value;
    }

    /// The creator may never hold more than their share of supply. Checked on
    /// the way in, so it binds a buy-back as well as the original allocation.
    ///
    /// This one is close to decoration on its own: a creator who wanted a bigger
    /// bag would hold it elsewhere. It is worth something alongside the taint,
    /// which makes "the creator" a set of addresses rather than one, and
    /// alongside a holder list a buyer can read.
    function _checkCeiling(address to, uint256 value) private view {
        if (badges.creatorCeilingBps == 0 || to != owner) return;
        uint256 ceiling = (totalSupply * badges.creatorCeilingBps) / 10000;
        uint256 wouldHold = balanceOf[to] + value;
        if (wouldHold > ceiling) revert OverCreatorCeiling(wouldHold, ceiling);
    }

    function _credit(address who, uint256 value) private {
        if (!known[who]) {
            known[who] = true;
            holders.push(who);
        }
        balanceOf[who] += value;
    }

    // ------------------------------------------------------- reading a badge

    /// What a buyer needs to judge the badges, in one call.
    ///
    /// `movable` is what this address could send right now, which is the only
    /// number that answers the question somebody actually has. A badge that
    /// reported only its percentage would leave every reader doing arithmetic
    /// against a balance they have to fetch separately.
    function badgeView(address who)
        external
        view
        returns (
            uint256 creatorCeilingBps,
            uint256 slowExitBps,
            uint256 slowExitWindow,
            bool taintFollows,
            bool isRestricted,
            uint256 movable,
            uint256 windowEndsAt
        )
    {
        creatorCeilingBps = badges.creatorCeilingBps;
        slowExitBps = badges.slowExitBps;
        slowExitWindow = badges.slowExitWindow;
        taintFollows = badges.taintFollows;
        isRestricted = restricted[who];

        if (badges.slowExitBps == 0 || !restricted[who]) {
            return (creatorCeilingBps, slowExitBps, slowExitWindow, taintFollows,
                    isRestricted, balanceOf[who], 0);
        }

        uint256 movedSoFar = movedInWindow[who];
        uint256 windowStart = windowStartedAt[who];
        if (block.timestamp >= windowStart + badges.slowExitWindow) {
            movedSoFar = 0;
            windowStart = block.timestamp;
        }
        uint256 allowed = ((balanceOf[who] + movedSoFar) * badges.slowExitBps) / 10000;
        uint256 left = allowed > movedSoFar ? allowed - movedSoFar : 0;
        movable = left > balanceOf[who] ? balanceOf[who] : left;
        windowEndsAt = windowStart + badges.slowExitWindow;
    }
}
