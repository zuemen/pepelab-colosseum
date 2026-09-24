// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/SpendPermissionMarginFunder.sol";

/// Extra SpendPermissionManager functions the test needs (the funder itself only calls spend).
interface ISpendPermissionManagerFull is ISpendPermissionManager {
    function approve(SpendPermission calldata spendPermission) external returns (bool);
    function revoke(SpendPermission calldata spendPermission) external;
}

interface ICoinbaseSmartWalletFactory {
    function createAccount(bytes[] calldata owners, uint256 nonce) external payable returns (address account);
}

interface IExchangeAdmin {
    function owner() external view returns (address);
    function setAgentAuthorized(address agent, bool authorized) external;
    function freeMargin(address user) external view returns (uint256);
    function authorizedAgents(address agent) external view returns (bool);
}

/// @notice Runs against a fork of Base Sepolia with the real SpendPermissionManager, the real
///         Coinbase Smart Wallet factory, and this repo's deployed exchange and MockUSDC.
///         Nothing is broadcast: every state change lives only in the local fork.
/// @dev    Skipped unless RUN_FORK_TESTS=true, so CI does not depend on a public RPC.
///         Run: RUN_FORK_TESTS=true forge test --match-path test/fork/SpendPermissionMarginFunder.fork.t.sol -vv
contract SpendPermissionMarginFunderForkTest is Test {
    ISpendPermissionManagerFull constant SPM = ISpendPermissionManagerFull(0xf85210B21cC50302F477BA56686d2019dC9b67Ad);
    ICoinbaseSmartWalletFactory constant FACTORY = ICoinbaseSmartWalletFactory(0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a);
    IExchangeAdmin constant EXCHANGE = IExchangeAdmin(0xC45dEd77F4A30658e3c52E6fB4809E502e3D3B0E);
    IERC20 constant MUSDC = IERC20(0x0910e965B06845BD3871860d522952a44a574058);

    uint160 constant ALLOWANCE = 100e18; // per period
    uint48 constant PERIOD = 1 days;

    bool forked;
    SpendPermissionMarginFunder funder;
    address walletOwner = makeAddr("walletOwner");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");
    address wallet;
    ISpendPermissionManager.SpendPermission permission;

    function setUp() public {
        forked = vm.envOr("RUN_FORK_TESTS", false);
        if (!forked) return;
        vm.createSelectFork(vm.envOr("FORK_URL", string("https://base-sepolia-rpc.publicnode.com")));

        funder = new SpendPermissionMarginFunder(SPM, IMarginExchange(address(EXCHANGE)), MUSDC);
        // The one owner transaction a real deployment would need.
        vm.prank(EXCHANGE.owner());
        EXCHANGE.setAgentAuthorized(address(funder), true);

        // A Base Account (Coinbase Smart Wallet) owned by an EOA and by the SpendPermissionManager,
        // which is how Base Accounts let the manager move tokens.
        bytes[] memory owners = new bytes[](2);
        owners[0] = abi.encode(walletOwner);
        owners[1] = abi.encode(address(SPM));
        wallet = FACTORY.createAccount(owners, uint256(keccak256("pepelab-fork-test")));
        deal(address(MUSDC), wallet, 1_000e18);

        permission = ISpendPermissionManager.SpendPermission({
            account: wallet,
            spender: address(funder),
            token: address(MUSDC),
            allowance: ALLOWANCE,
            period: PERIOD,
            start: uint48(block.timestamp),
            end: type(uint48).max,
            salt: 0,
            extraData: ""
        });
        vm.startPrank(wallet);
        SPM.approve(permission);
        funder.setTopUpAgent(agent);
        vm.stopPrank();
    }

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function test_agentTopsUpWithinAllowance() public onlyFork {
        uint256 marginBefore = EXCHANGE.freeMargin(wallet);
        uint256 walletBefore = MUSDC.balanceOf(wallet);

        vm.prank(agent);
        funder.topUp(permission, 60e18);

        assertEq(EXCHANGE.freeMargin(wallet), marginBefore + 60e18, "margin credited to the account");
        assertEq(MUSDC.balanceOf(wallet), walletBefore - 60e18, "tokens left the wallet");
        assertEq(EXCHANGE.freeMargin(agent), 0, "the agent itself received nothing");
        assertEq(MUSDC.balanceOf(address(funder)), 0, "the funder keeps nothing");
    }

    function test_revertsAboveTheAllowanceInOnePeriod() public onlyFork {
        vm.startPrank(agent);
        funder.topUp(permission, 60e18);
        vm.expectPartialRevert(bytes4(keccak256("ExceededSpendPermission(uint256,uint256)")));
        funder.topUp(permission, 50e18); // 110 > 100 in the same period
        vm.stopPrank();
    }

    function test_allowanceResetsNextPeriod() public onlyFork {
        vm.prank(agent);
        funder.topUp(permission, ALLOWANCE);

        vm.warp(block.timestamp + PERIOD);
        vm.prank(agent);
        funder.topUp(permission, ALLOWANCE);

        assertEq(MUSDC.balanceOf(wallet), 1_000e18 - 2 * uint256(ALLOWANCE));
    }

    function test_strangerCannotTopUp() public onlyFork {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendPermissionMarginFunder.NotAccountOrAgent.selector, stranger, wallet));
        funder.topUp(permission, 10e18);
    }

    function test_accountCanTopUpItself() public onlyFork {
        vm.prank(wallet);
        funder.topUp(permission, 10e18);
        assertEq(MUSDC.balanceOf(wallet), 990e18);
    }

    function test_revokedPermissionStopsTopUps() public onlyFork {
        vm.prank(wallet);
        SPM.revoke(permission);

        vm.prank(agent);
        vm.expectPartialRevert(bytes4(keccak256("UnauthorizedSpendPermission()")));
        funder.topUp(permission, 10e18);
    }

    function test_rejectsAPermissionForAnotherToken() public onlyFork {
        ISpendPermissionManager.SpendPermission memory other = permission;
        other.token = address(0xBEEF);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPermissionMarginFunder.WrongToken.selector, address(0xBEEF)));
        funder.topUp(other, 10e18);
    }

    function test_removingTheAgentStopsItsTopUps() public onlyFork {
        vm.prank(wallet);
        funder.setTopUpAgent(address(0));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPermissionMarginFunder.NotAccountOrAgent.selector, agent, wallet));
        funder.topUp(permission, 10e18);
    }
}
