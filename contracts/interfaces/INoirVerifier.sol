// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface INoirVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
