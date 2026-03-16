// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IThassaHub} from "./IThassaHub.sol";

interface IThassaVerifier {
    function verifyUpdate(bytes32 digest, IThassaHub.SignedUpdate calldata update) external view returns (bool);
}
