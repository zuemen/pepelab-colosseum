// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/SpendPermissionMarginFunder.sol";

interface IExchangeOwnerOps {
    function owner() external view returns (address);
    function setAgentAuthorized(address agent, bool authorized) external;
    function authorizedAgents(address agent) external view returns (bool);
}

/// @notice Deploys SpendPermissionMarginFunder for this repo's Base Sepolia deployment and
///         authorizes it on the exchange. NOT RUN YET: it needs the exchange owner's key and
///         widens the exchange's trusted set (see docs/design/SPEND_PERMISSIONS.md).
///
///   forge script script/DeploySpendPermissionFunder.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
/// Two transactions: the deployment and setAgentAuthorized(funder, true).
contract DeploySpendPermissionFunder is Script {
    // Coinbase SpendPermissionManager (github.com/coinbase/spend-permissions), Base and Base Sepolia.
    address constant SPEND_PERMISSION_MANAGER = 0xf85210B21cC50302F477BA56686d2019dC9b67Ad;
    // This repository's deployment (frontend/src/contracts/addresses.ts), not the capstone's.
    address constant EXCHANGE = 0xC45dEd77F4A30658e3c52E6fB4809E502e3D3B0E;
    address constant MOCK_USDC = 0x0910e965B06845BD3871860d522952a44a574058;

    function run() external {
        require(block.chainid == 84532, "Base Sepolia only");
        IExchangeOwnerOps exchange = IExchangeOwnerOps(EXCHANGE);

        vm.startBroadcast();
        require(exchange.owner() == msg.sender, "broadcaster is not the exchange owner");
        SpendPermissionMarginFunder funder = new SpendPermissionMarginFunder(
            ISpendPermissionManager(SPEND_PERMISSION_MANAGER), IMarginExchange(EXCHANGE), IERC20(MOCK_USDC)
        );
        exchange.setAgentAuthorized(address(funder), true);
        vm.stopBroadcast();

        require(exchange.authorizedAgents(address(funder)), "funder not authorized");
        console.log("SpendPermissionMarginFunder:", address(funder));
        console.log("Set SPEND_PERMISSION_FUNDER_ADDRESS to this address for the agent SDK / MCP server.");
    }
}
