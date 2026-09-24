// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/AgentSessionManager.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Drives one agent session with valid and deliberately invalid actions:
///         orders over the per-trade cap and past the budget, leverage above the
///         session cap, an asset outside the allow-list, orders after revocation or
///         expiry, and orders from an address that is not the agent. The ghost
///         variables record only the orders that SUCCEEDED, so the invariants below
///         prove the contract refused every out-of-mandate one.
/// @dev    The session's maxLeverage (2) is deliberately below the exchange's own
///         MAX_LEVERAGE (5): otherwise the exchange would reject high leverage and
///         the leverage invariant could never catch a missing session check.
contract SessionHandler is Test {
    AgentSessionManager public immutable manager;
    MockOracle public immutable oracle;
    address public immutable user;
    address public immutable agent;
    address public immutable stranger;
    uint256 public immutable sid;

    bytes32 public constant BTC = keccak256("BTC"); // on the allow-list
    bytes32 public constant ETH = keccak256("ETH"); // not on the allow-list
    uint256 public constant BTC_PRICE = 100_000e8;
    uint256 public constant ETH_PRICE = 3_000e8;
    uint256 public constant PER_TRADE = 50e18;

    // Ghosts: facts about successful orders only.
    uint256 public ghostSpent;
    uint256 public ghostOpens;
    uint256 public ghostMaxMargin;
    uint256 public ghostMaxLeverage;
    uint256 public ghostOffListOpens;
    uint256 public ghostOpensAfterEnd;
    uint256 public ghostStrangerOpens;
    uint256[] internal openIds;

    // Call and revert statistics, so a run that never reaches a boundary is visible.
    mapping(bytes4 => uint256) public reverts;
    uint256 public callsOpen;
    uint256 public callsRevoke;
    uint256 public callsWarp;
    uint256 public callsClose;
    uint256 public callsStranger;
    uint256 public callsExpire;

    constructor(AgentSessionManager _manager, MockOracle _oracle, address _user, address _agent, address _stranger, uint256 _sid) {
        manager = _manager;
        oracle = _oracle;
        user = _user;
        agent = _agent;
        stranger = _stranger;
        sid = _sid;
    }

    function _ended() internal view returns (bool) {
        (,,,,,, uint256 expiry, bool revoked) = manager.sessions(sid);
        // Same condition as AgentSessionManager._requireActiveAgent.
        return revoked || block.timestamp > expiry;
    }

    function _selector(bytes memory err) internal pure returns (bytes4 sel) {
        if (err.length >= 4) sel = bytes4(err);
    }

    /// Agent order. The ranges are shaped so that roughly 40% of orders are within the
    /// mandate: enough successes to reach the cumulative budget in most runs, while
    /// ~20% exceed the per-trade cap, a third exceed the leverage cap (3 > 2, still
    /// within the exchange's own limit of 5) and a quarter use an off-list asset.
    function openPosition(uint256 marginSeed, uint256 leverageSeed, uint256 assetSeed, bool isLong) external {
        callsOpen++;
        uint256 margin = bound(marginSeed, 10e18, PER_TRADE + 10e18);
        uint256 leverage = bound(leverageSeed, 1, 3);
        bool offList = uint256(keccak256(abi.encode(assetSeed))) % 4 == 0;
        bytes32 asset = offList ? ETH : BTC;
        bool ended = _ended();

        vm.prank(agent);
        try manager.openPositionForSession(sid, asset, isLong, margin, leverage, address(0)) returns (uint256 pid) {
            ghostSpent += margin;
            ghostOpens++;
            if (margin > ghostMaxMargin) ghostMaxMargin = margin;
            if (leverage > ghostMaxLeverage) ghostMaxLeverage = leverage;
            if (offList) ghostOffListOpens++;
            if (ended) ghostOpensAfterEnd++;
            openIds.push(pid);
        } catch (bytes memory err) {
            reverts[_selector(err)]++;
        }
    }

    /// Someone other than the agent tries a well-formed order.
    function strangerOpen(uint256 marginSeed) external {
        callsStranger++;
        uint256 margin = bound(marginSeed, 10e18, PER_TRADE);
        vm.prank(stranger);
        try manager.openPositionForSession(sid, BTC, true, margin, 1, address(0)) returns (uint256) {
            ghostStrangerOpens++;
        } catch (bytes memory err) {
            reverts[_selector(err)]++;
        }
    }

    /// The user revokes, rarely and never before the 8th order. The fuzzer favours edge
    /// values such as 0, so a plain `seed % n == 0` revoked at once in most runs and every
    /// other limit was then tested only vacuously; hashing the seed removes that bias.
    function revoke(uint256 seed) external {
        if (callsOpen < 8 || uint256(keccak256(abi.encode(seed))) % 8 != 0) return;
        callsRevoke++;
        vm.prank(user);
        manager.revokeSession(sid);
    }

    /// Time passes (possibly past the expiry). Prices are re-written so the exchange's
    /// staleness guard never becomes the reason an order fails.
    function warp(uint256 secondsSeed) external {
        callsWarp++;
        vm.warp(block.timestamp + bound(secondsSeed, 10 minutes, 3 hours));
        oracle.updatePrice(BTC, BTC_PRICE);
        oracle.updatePrice(ETH, ETH_PRICE);
    }

    /// Jumps just past the expiry, rarely and never before the 8th order, so that orders
    /// after expiry are tried while budget is still left. Without this, time reached the
    /// expiry only after the budget was spent, the expiry check was never the one that
    /// refused an order, and removing it went unnoticed (caught by the mutation check).
    function expire(uint256 seed) external {
        if (callsOpen < 8 || uint256(keccak256(abi.encode(seed, "expire"))) % 8 != 0) return;
        callsExpire++;
        (,,,,,, uint256 expiry,) = manager.sessions(sid);
        if (block.timestamp <= expiry) vm.warp(expiry + 1);
        oracle.updatePrice(BTC, BTC_PRICE);
        oracle.updatePrice(ETH, ETH_PRICE);
    }

    /// Closing does not refund budget: totalMarginBudget is cumulative by design.
    function closePosition(uint256 indexSeed) external {
        if (openIds.length == 0) return;
        callsClose++;
        uint256 i = indexSeed % openIds.length;
        vm.prank(agent);
        try manager.closePositionForSession(sid, openIds[i]) {
            openIds[i] = openIds[openIds.length - 1];
            openIds.pop();
        } catch (bytes memory err) {
            reverts[_selector(err)]++;
        }
    }
}

contract AgentSessionInvariantTest is Test {
    PerpetualExchange exchange;
    AgentSessionManager manager;
    MockUSDC usdc;
    MockOracle oracle;
    SessionHandler handler;

    address alice = makeAddr("alice");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");
    address tracker = makeAddr("tracker");

    uint256 constant PER_TRADE = 50e18;
    uint256 constant BUDGET = 150e18;
    uint256 constant MAX_LEVERAGE = 2;
    uint256 sid;

    function setUp() public {
        usdc = new MockUSDC();
        oracle = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        manager = new AgentSessionManager(address(exchange));

        oracle.addAsset(keccak256("BTC"), 100_000e8);
        oracle.addAsset(keccak256("ETH"), 3_000e8);

        usdc.mint(alice, 100_000e18);
        usdc.mint(address(exchange), 1_000_000e18);
        vm.prank(alice);
        usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);
        exchange.setCopyTracker(tracker);
        exchange.setAgentAuthorized(address(manager), true);

        vm.prank(alice);
        exchange.depositMargin(10_000e18);

        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = keccak256("BTC");
        vm.prank(alice);
        sid = manager.createSessionWithAssets(agent, PER_TRADE, BUDGET, MAX_LEVERAGE, block.timestamp + 2 days, allowed);

        handler = new SessionHandler(manager, oracle, alice, agent, stranger, sid);
        oracle.transferOwnership(address(handler)); // the handler refreshes prices after warps

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = SessionHandler.openPosition.selector;
        selectors[1] = SessionHandler.strangerOpen.selector;
        selectors[2] = SessionHandler.revoke.selector;
        selectors[3] = SessionHandler.warp.selector;
        selectors[4] = SessionHandler.closePosition.selector;
        selectors[5] = SessionHandler.expire.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_budgetNeverExceeded() public view {
        assertLe(handler.ghostSpent(), BUDGET, "successful orders exceeded the session budget");
        (,,,, uint256 spent,,,) = manager.sessions(sid);
        assertEq(spent, handler.ghostSpent(), "contract's spentMargin disagrees with successful orders");
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_perTradeCap() public view {
        assertLe(handler.ghostMaxMargin(), PER_TRADE, "an order above the per-trade cap went through");
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_leverageCap() public view {
        assertLe(handler.ghostMaxLeverage(), MAX_LEVERAGE, "an order above the session's leverage cap went through");
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_assetAllowList() public view {
        assertEq(handler.ghostOffListOpens(), 0, "an order on an asset outside the allow-list went through");
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_noOrdersAfterRevocationOrExpiry() public view {
        assertEq(handler.ghostOpensAfterEnd(), 0, "an order went through after revocation or expiry");
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 100
    function invariant_onlyTheAgentCanTrade() public view {
        assertEq(handler.ghostStrangerOpens(), 0, "an address other than the agent traded");
    }

    /// Shows that the fuzzer actually reached each boundary; a run where a counter is
    /// zero exercised that limit only vacuously.
    function afterInvariant() public view {
        console.log("calls open/stranger/revoke/warp/close:", handler.callsOpen(), handler.callsStranger(), handler.callsRevoke());
        console.log("  warp/close/expire:", handler.callsWarp(), handler.callsClose(), handler.callsExpire());
        console.log("successful opens:", handler.ghostOpens());
        console.log("reverts MarginExceedsPerTradeCap:", handler.reverts(AgentSessionManager.MarginExceedsPerTradeCap.selector));
        console.log("reverts BudgetExceeded:", handler.reverts(AgentSessionManager.BudgetExceeded.selector));
        console.log("reverts LeverageExceedsSessionCap:", handler.reverts(AgentSessionManager.LeverageExceedsSessionCap.selector));
        console.log("reverts AssetNotAllowed:", handler.reverts(AgentSessionManager.AssetNotAllowed.selector));
        console.log("reverts SessionIsRevoked:", handler.reverts(AgentSessionManager.SessionIsRevoked.selector));
        console.log("reverts SessionExpired:", handler.reverts(AgentSessionManager.SessionExpired.selector));
        console.log("reverts NotSessionAgent:", handler.reverts(AgentSessionManager.NotSessionAgent.selector));
    }
}
