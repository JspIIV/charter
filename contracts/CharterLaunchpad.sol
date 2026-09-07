// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.26;

import "./CharterToken.sol";

/// @title CharterLaunchpad
/// @notice Launches charter tokens and keeps a list of them.
///
/// Two reasons this exists rather than the app deploying a token straight from
/// the browser, which it could.
///
/// **A launch has to be findable.** A token nobody can list is a token whose
/// badges only help the person already holding the address. The list is on
/// chain and append only, so reading it needs no indexer, no server and no
/// cooperation from us.
///
/// **A launch has to be the same for everybody.** When the app deploys, the app
/// decides what goes in the constructor, and a different app could decide
/// differently while claiming the same badges. Here the arguments are the
/// arguments, and anybody can read what a token was launched with.
///
/// ## What this contract cannot do
///
/// It has no owner and no admin. Nothing here can reach a token after it is
/// deployed: not to change a badge, not to move a balance, not to pause
/// anything. The tokens do not know this contract exists and it holds no
/// authority over them. That is not modesty, it is the point: a launchpad that
/// kept a handle on what it launched would be a single address worth attacking
/// to reach every token it ever made.
///
/// It also does not judge. A token launched with no badges at all is recorded
/// exactly like one launched with three, because refusing to list it would only
/// move that launch somewhere this list cannot see.
contract CharterLaunchpad {
    struct Launch {
        address token;
        address creator;
        string name;
        string symbol;
        uint64 launchedAt;
    }

    Launch[] private launches;

    /// Every token a given address has launched here, so a creator's history is
    /// one call rather than a scan.
    mapping(address => uint256[]) private byCreator;

    event Launched(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 index
    );

    error NothingToLaunch();

    /// @param supply whole tokens, before decimals
    /// @param treasuryShare percent held by the token for its own rules, 0 to 100
    function launch(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        uint256 treasuryShare,
        CharterToken.Badges calldata badges
    ) external returns (address token) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0 || supply == 0) {
            revert NothingToLaunch();
        }

        // The creator is passed explicitly, because this contract is the sender
        // when it deploys and the person who launched it is not. Nothing follows
        // from that field: a creator cannot edit a badge, cannot lift a limit
        // and cannot take anything back. It says who launched it, and the
        // badges are what hold them to anything.
        token = address(new CharterToken(
            name, symbol, supply, treasuryShare,
            msg.sender,
            msg.sender,
            "", "",
            CharterToken.Charter({
                conditions: new string[](0),
                urls: new string[](0),
                actions: new uint8[](0),
                amounts: new uint256[](0)
            }),
            badges
        ));

        uint256 index = launches.length;
        launches.push(Launch({
            token: token,
            creator: msg.sender,
            name: name,
            symbol: symbol,
            launchedAt: uint64(block.timestamp)
        }));
        byCreator[msg.sender].push(index);

        emit Launched(token, msg.sender, name, symbol, index);
    }

    // ------------------------------------------------------------- reading it

    function count() external view returns (uint256) {
        return launches.length;
    }

    function launchAt(uint256 index) external view returns (Launch memory) {
        return launches[index];
    }

    /// Newest first, which is the order anybody actually wants, and paged so a
    /// long list does not have to be fetched to see the top of it.
    function page(uint256 skip, uint256 take)
        external
        view
        returns (Launch[] memory out, uint256 total)
    {
        total = launches.length;
        if (skip >= total || take == 0) return (new Launch[](0), total);
        uint256 n = total - skip;
        if (n > take) n = take;
        out = new Launch[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = launches[total - 1 - skip - i];
        }
    }

    function countByCreator(address creator) external view returns (uint256) {
        return byCreator[creator].length;
    }

    function byCreatorAt(address creator, uint256 index)
        external
        view
        returns (Launch memory)
    {
        return launches[byCreator[creator][index]];
    }
}
