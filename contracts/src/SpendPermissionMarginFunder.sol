// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The subset of Coinbase's SpendPermissionManager used here
///         (github.com/coinbase/spend-permissions; deployed at
///         0xf85210B21cC50302F477BA56686d2019dC9b67Ad on Base and Base Sepolia).
interface ISpendPermissionManager {
    struct SpendPermission {
        address account;
        address spender;
        address token;
        uint160 allowance;
        uint48 period;
        uint48 start;
        uint48 end;
        uint256 salt;
        bytes extraData;
    }

    /// Pulls `value` of `token` from `account` to `spender`; reverts above the
    /// allowance left in the current period. Callable only by the spender.
    function spend(SpendPermission memory spendPermission, uint160 value) external;
}

/// @notice The exchange entry point that credits margin to a user. Only contracts the
///         exchange owner has authorized may call it.
interface IMarginExchange {
    function depositMarginFor(address user, uint256 amount) external;
}

/// @title SpendPermissionMarginFunder
/// @notice Tops up a Base Account's margin on the exchange from a Base Spend Permission.
///
///         Two limits, two layers:
///         - the Spend Permission (set by the user in their Base Account) caps how much of
///           the margin token can leave the wallet per period;
///         - the AgentSessionManager session caps what the agent does with margin once it
///           is on the exchange (per-trade size, budget, leverage, assets, expiry).
///         A Spend Permission alone cannot limit leverage or assets; a session alone cannot
///         limit how much of the wallet is committed over time. Together they bound both.
///
///         The user registers one top-up agent (typically the agent of their session). That
///         agent, or the user, can move at most the Spend Permission's allowance per period
///         from the wallet into the user's own margin account. Funds always land in the
///         account holder's margin, never with the caller.
contract SpendPermissionMarginFunder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISpendPermissionManager public immutable spendPermissionManager;
    IMarginExchange public immutable exchange;
    IERC20 public immutable marginToken;

    /// account => the address allowed to trigger top-ups besides the account itself.
    mapping(address => address) public topUpAgent;

    event TopUpAgentSet(address indexed account, address indexed agent);
    event MarginToppedUp(address indexed account, address indexed caller, uint256 amount);

    error NotAccountOrAgent(address caller, address account);
    error WrongSpender(address spender);
    error WrongToken(address token);

    constructor(ISpendPermissionManager _spendPermissionManager, IMarginExchange _exchange, IERC20 _marginToken) {
        spendPermissionManager = _spendPermissionManager;
        exchange = _exchange;
        marginToken = _marginToken;
    }

    /// @notice The caller (a Base Account) chooses who may trigger its top-ups.
    ///         address(0) removes the agent.
    function setTopUpAgent(address agent) external {
        topUpAgent[msg.sender] = agent;
        emit TopUpAgentSet(msg.sender, agent);
    }

    /// @notice Moves `amount` from `permission.account` into that account's margin.
    /// @dev    The Spend Permission must name this contract as spender and the exchange's
    ///         margin token as token; SpendPermissionManager enforces the approval, the
    ///         start/end window and the per-period allowance.
    function topUp(ISpendPermissionManager.SpendPermission calldata permission, uint160 amount) external nonReentrant {
        address account = permission.account;
        if (msg.sender != account && msg.sender != topUpAgent[account]) revert NotAccountOrAgent(msg.sender, account);
        if (permission.spender != address(this)) revert WrongSpender(permission.spender);
        if (permission.token != address(marginToken)) revert WrongToken(permission.token);

        spendPermissionManager.spend(permission, amount);
        marginToken.forceApprove(address(exchange), amount);
        exchange.depositMarginFor(account, amount);

        emit MarginToppedUp(account, msg.sender, amount);
    }
}
