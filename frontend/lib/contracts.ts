import type { Abi } from "viem";
import mockCoinAbiJSON from "../abi/MockCoin.abi.json";
import thassaHubAbiJSON from "../abi/ThassaHub.abi.json";
import weatherOracleAbiJSON from "../abi/ThassaSanFranciscoWeatherOracle.abi.json";

export const weatherOracleAbi = weatherOracleAbiJSON as Abi;
export const hubAbi = thassaHubAbiJSON as Abi;
export const erc20Abi = mockCoinAbiJSON as Abi;
