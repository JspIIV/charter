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
        Charter memory charter
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

        totalSupply = supply_;
        uint256 held = (supply_ * treasuryShare) / 100;
        treasury = held;
        _credit(creator_, supply_ - held);
        emit Transfer(address(0), creator_, supply_ - held);

        // Rules that together claim more than the treasury holds could not all
        // be carried out, and a badge for a rule that cannot work is worse than
        // no badge, so it is refused here rather than kept as decoration.
        uint256 claimed;
        for (uint256 i = 0; i < charter.conditions.length; i++) {
            require(charter.actions[i] <= uint8(Action.DISTRIBUTE), "action");
            require(charter.amounts[i] > 0, "amount");
            claimed += charter.amounts[i];
            require(claimed <= held, "over treasury");
            rules.push(Rule({
                when: charter.conditions[i],
                url: charter.urls[i],
                act: Action(charter.actions[i]),
                amount: charter.amounts[i],
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
        balanceOf[from] -= value;
        _credit(to, value);
        emit Transfer(from, to, value);
    }

    function _credit(address who, uint256 value) private {
        if (!known[who]) {
            known[who] = true;
            holders.push(who);
        }
        balanceOf[who] += value;
    }
}
