// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {ThassaSanFranciscoWeatherOracle} from "../src/ThassaSanFranciscoWeatherOracle.sol";

contract DeployWeatherOracleScript is Script {
    struct DeploymentAddresses {
        address deployer;
        address thassaHub;
        address weatherOracle;
    }

    error MissingEnv(string key);

    function run() external returns (DeploymentAddresses memory deployment) {
        string memory deployRpcUrl = vm.envString("DEPLOY_RPC_URL");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address thassaHub = vm.envAddress("THASSA_HUB_ADDRESS");
        string memory oracleModel = vm.envOr("ORACLE_MODEL", string("openai:gpt-5.4"));

        if (bytes(deployRpcUrl).length == 0) {
            revert MissingEnv("DEPLOY_RPC_URL");
        }
        if (deployerPrivateKey == 0) {
            revert MissingEnv("DEPLOYER_PRIVATE_KEY");
        }
        if (thassaHub == address(0)) {
            revert MissingEnv("THASSA_HUB_ADDRESS");
        }

        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);
        ThassaSanFranciscoWeatherOracle weatherOracle = new ThassaSanFranciscoWeatherOracle(thassaHub, oracleModel, 1);
        vm.stopBroadcast();

        deployment = DeploymentAddresses({deployer: deployer, thassaHub: thassaHub, weatherOracle: address(weatherOracle)});

        console2.log("Loaded DEPLOY_RPC_URL:", deployRpcUrl);
        console2.log("Deployer:", deployment.deployer);
        console2.log("ThassaHub:", deployment.thassaHub);
        console2.log("ThassaSanFranciscoWeatherOracle:", deployment.weatherOracle);
        console2.log("Oracle model:", oracleModel);
    }
}
