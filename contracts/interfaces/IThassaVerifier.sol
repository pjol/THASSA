// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IThassaHub} from "./IThassaHub.sol";

interface IThassaVerifier {
    function verifyUpdate(
        bytes32 digest,
        uint256 bidId,
        bool autoFlow,
        IThassaHub.UpdateEnvelope calldata update,
        IThassaHub.ProofEnvelope calldata proof
    ) external view returns (bool);
}
