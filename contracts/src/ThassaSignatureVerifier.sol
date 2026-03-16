// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaVerifier} from "../interfaces/IThassaVerifier.sol";

contract ThassaSignatureVerifier is IThassaVerifier {
    using MessageHashUtils for bytes32;

    error ZeroSignerAddress();

    address public immutable adminSigner;

    constructor(address adminSigner_) {
        if (adminSigner_ == address(0)) {
            revert ZeroSignerAddress();
        }

        adminSigner = adminSigner_;
    }

    function verifyUpdate(bytes32 digest, IThassaHub.SignedUpdate calldata update) external view returns (bool) {
        (address recoveredSigner, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(digest.toEthSignedMessageHash(), update.signature);

        if (recoverError != ECDSA.RecoverError.NoError) {
            return false;
        }

        return recoveredSigner == adminSigner;
    }
}
