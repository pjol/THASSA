// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {MockCoin} from "../src/MockCoin.sol";
import {ThassaHub} from "../src/ThassaHub.sol";
import {ThassaSignatureVerifier} from "../src/ThassaSignatureVerifier.sol";
import {ThassaSanFranciscoWeatherOracle} from "../src/ThassaSanFranciscoWeatherOracle.sol";

contract DeployThassaScript is Script {
    struct DeploymentAddresses {
        address deployer;
        address nodeSigner;
        address userAccount;
        address paymentToken;
        address verifierModule;
        address thassaHub;
        address weatherOracle;
    }

    error MissingEnv(string key);

    function run() external returns (DeploymentAddresses memory deployment) {
        string memory deployRpcUrl = vm.envString("DEPLOY_RPC_URL");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address nodeSigner = vm.envAddress("NODE_SIGNER_PUBLIC_KEY");
        address userAccount = vm.envAddress("USER_ACCOUNT_PUBLIC_KEY");
        string memory oracleModel = vm.envOr("ORACLE_MODEL", string("openai:gpt-5.4-mini"));

        if (bytes(deployRpcUrl).length == 0) {
            revert MissingEnv("DEPLOY_RPC_URL");
        }
        if (deployerPrivateKey == 0) {
            revert MissingEnv("DEPLOYER_PRIVATE_KEY");
        }
        if (nodeSigner == address(0)) {
            revert MissingEnv("NODE_SIGNER_PUBLIC_KEY");
        }
        if (userAccount == address(0)) {
            revert MissingEnv("USER_ACCOUNT_PUBLIC_KEY");
        }

        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        MockCoin paymentToken = new MockCoin("Thassa Mock Coin", "TMCK", 6);
        ThassaSignatureVerifier verifierModule = new ThassaSignatureVerifier(nodeSigner);
        ThassaHub thassaHub = new ThassaHub(address(paymentToken), deployer, address(verifierModule));
        ThassaSanFranciscoWeatherOracle weatherOracle =
            new ThassaSanFranciscoWeatherOracle(address(thassaHub), oracleModel, 1);

        uint256 initialTokenBalance = 1_000_000 * (10 ** uint256(paymentToken.decimals()));
        paymentToken.mint(deployer, initialTokenBalance);
        paymentToken.mint(nodeSigner, initialTokenBalance);
        paymentToken.mint(userAccount, initialTokenBalance);

        vm.stopBroadcast();

        deployment = DeploymentAddresses({
            deployer: deployer,
            nodeSigner: nodeSigner,
            userAccount: userAccount,
            paymentToken: address(paymentToken),
            verifierModule: address(verifierModule),
            thassaHub: address(thassaHub),
            weatherOracle: address(weatherOracle)
        });

        console2.log("Loaded DEPLOY_RPC_URL:", deployRpcUrl);
        console2.log("Deployer:", deployment.deployer);
        console2.log("Node Signer:", deployment.nodeSigner);
        console2.log("User Account:", deployment.userAccount);
        console2.log("MockCoin:", deployment.paymentToken);
        console2.log("ThassaSignatureVerifier:", deployment.verifierModule);
        console2.log("ThassaHub:", deployment.thassaHub);
        console2.log("ThassaSanFranciscoWeatherOracle:", deployment.weatherOracle);
        console2.log("Oracle model:", oracleModel);
        console2.log("Initial tokens minted to deployer, node signer, and user account:", initialTokenBalance);
    }
}
