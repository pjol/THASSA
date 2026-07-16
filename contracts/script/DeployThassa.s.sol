// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {MockUSD} from "../src/MockUSD.sol";
import {ThassaHub} from "../src/ThassaHub.sol";
import {ThassaPoAVerifier} from "../src/ThassaPoAVerifier.sol";
import {ThassaMarkets} from "../src/markets/ThassaMarkets.sol";
import {ThassaSanFranciscoWeatherOracle} from "../src/ThassaSanFranciscoWeatherOracle.sol";

contract DeployThassaScript is Script {
    struct DeployConfig {
        string deployRpcUrl;
        uint256 deployerPrivateKey;
        address nodeSigner;
        address userAccount;
        address platformRole;
        address existingPaymentToken; // PAYMENT_TOKEN_ADDRESS set => reuse it, skip MockUSD
        string oracleModel;
        string marketsModel;
    }

    struct DeploymentAddresses {
        address deployer;
        address nodeSigner;
        address userAccount;
        address platformRole;
        address paymentToken;
        address verifierModule;
        address thassaHub;
        address weatherOracle;
        address thassaMarkets;
    }

    error MissingEnv(string key);

    function run() external returns (DeploymentAddresses memory deployment) {
        DeployConfig memory config = _loadConfig();

        deployment = _deploy(config);

        _writeDeploymentEnv(deployment);
        _logDeployment(config, deployment);
    }

    function _loadConfig() internal view returns (DeployConfig memory config) {
        config = DeployConfig({
            deployRpcUrl: vm.envString("DEPLOY_RPC_URL"),
            deployerPrivateKey: vm.envUint("DEPLOYER_PRIVATE_KEY"),
            nodeSigner: vm.envAddress("NODE_SIGNER_PUBLIC_KEY"),
            userAccount: vm.envAddress("USER_ACCOUNT_PUBLIC_KEY"),
            platformRole: vm.envOr("PLATFORM_ROLE_PUBLIC_KEY", address(0)),
            existingPaymentToken: vm.envOr("PAYMENT_TOKEN_ADDRESS", address(0)),
            oracleModel: vm.envOr("ORACLE_MODEL", string("openai:gpt-5.4-mini")),
            marketsModel: vm.envOr("MARKETS_MODEL", string("openai:gpt-5.4"))
        });

        if (bytes(config.deployRpcUrl).length == 0) {
            revert MissingEnv("DEPLOY_RPC_URL");
        }
        if (config.deployerPrivateKey == 0) {
            revert MissingEnv("DEPLOYER_PRIVATE_KEY");
        }
        if (config.nodeSigner == address(0)) {
            revert MissingEnv("NODE_SIGNER_PUBLIC_KEY");
        }
        if (config.userAccount == address(0)) {
            revert MissingEnv("USER_ACCOUNT_PUBLIC_KEY");
        }

        if (config.platformRole == address(0)) {
            config.platformRole = vm.addr(config.deployerPrivateKey);
        }
    }

    function _deploy(DeployConfig memory config) internal returns (DeploymentAddresses memory deployment) {
        address deployer = vm.addr(config.deployerPrivateKey);

        vm.startBroadcast(config.deployerPrivateKey);

        // PAYMENT_TOKEN_ADDRESS set => reuse the existing token (forked-Tempo runs);
        // otherwise deploy the MockUSD dev token and fund the well-known accounts.
        address paymentToken = config.existingPaymentToken;
        if (paymentToken == address(0)) {
            MockUSD mockUSD = new MockUSD();
            paymentToken = address(mockUSD);

            uint256 initialTokenBalance = 1_000_000 * (10 ** uint256(mockUSD.decimals()));
            mockUSD.mint(deployer, initialTokenBalance);
            mockUSD.mint(config.nodeSigner, initialTokenBalance);
            mockUSD.mint(config.userAccount, initialTokenBalance);
        }

        // The node signer is registered as an authorized PoA signer at construction.
        address[] memory initialSigners = new address[](1);
        initialSigners[0] = config.nodeSigner;
        ThassaPoAVerifier verifierModule = new ThassaPoAVerifier(deployer, initialSigners);

        ThassaHub thassaHub = new ThassaHub(paymentToken, deployer, address(verifierModule));
        ThassaSanFranciscoWeatherOracle weatherOracle =
            new ThassaSanFranciscoWeatherOracle(address(thassaHub), config.oracleModel, 1);
        ThassaMarkets thassaMarkets =
            new ThassaMarkets(address(thassaHub), config.marketsModel, 1, config.platformRole);

        vm.stopBroadcast();

        deployment = DeploymentAddresses({
            deployer: deployer,
            nodeSigner: config.nodeSigner,
            userAccount: config.userAccount,
            platformRole: config.platformRole,
            paymentToken: paymentToken,
            verifierModule: address(verifierModule),
            thassaHub: address(thassaHub),
            weatherOracle: address(weatherOracle),
            thassaMarkets: address(thassaMarkets)
        });
    }

    /// @dev Machine-readable deployment manifest consumed by the repo-root boot tooling.
    function _writeDeploymentEnv(DeploymentAddresses memory deployment) internal {
        string memory manifest = string.concat(
            "PAYMENT_TOKEN_ADDRESS=", vm.toString(deployment.paymentToken), "\n",
            "HUB_ADDRESS=", vm.toString(deployment.thassaHub), "\n",
            "POA_VERIFIER_ADDRESS=", vm.toString(deployment.verifierModule), "\n",
            "MARKETS_CONTRACT_ADDRESS=", vm.toString(deployment.thassaMarkets), "\n",
            "WEATHER_ORACLE_ADDRESS=", vm.toString(deployment.weatherOracle), "\n",
            "NODE_SIGNER_ADDRESS=", vm.toString(deployment.nodeSigner), "\n"
        );

        vm.writeFile("out/deployment.env", manifest);
        console2.log("Deployment manifest written to contracts/out/deployment.env");
    }

    function _logDeployment(DeployConfig memory config, DeploymentAddresses memory deployment) internal pure {
        console2.log("Loaded DEPLOY_RPC_URL:", config.deployRpcUrl);
        console2.log("Deployer:", deployment.deployer);
        console2.log("Node Signer (PoA):", deployment.nodeSigner);
        console2.log("User Account:", deployment.userAccount);
        console2.log("Platform Role:", deployment.platformRole);
        console2.log("Payment Token (MockUSD unless PAYMENT_TOKEN_ADDRESS was set):", deployment.paymentToken);
        console2.log("ThassaPoAVerifier:", deployment.verifierModule);
        console2.log("ThassaHub:", deployment.thassaHub);
        console2.log("ThassaSanFranciscoWeatherOracle:", deployment.weatherOracle);
        console2.log("ThassaMarkets:", deployment.thassaMarkets);
        console2.log("Oracle model:", config.oracleModel);
        console2.log("Markets model:", config.marketsModel);
        console2.log("Initial tokens minted to deployer, node signer, and user account (1,000,000 * 10^decimals)");
    }
}
