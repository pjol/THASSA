// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaVerifier} from "../interfaces/IThassaVerifier.sol";

contract ThassaSignatureVerifier is IThassaVerifier {
    using MessageHashUtils for bytes32;

    uint8 public constant PROOF_SCHEME_SIGNATURE = 1;

    error ZeroSignerAddress();

    address public immutable adminSigner;

    constructor(address adminSigner_) {
        if (adminSigner_ == address(0)) {
            revert ZeroSignerAddress();
        }

        adminSigner = adminSigner_;
    }

    function verifyUpdate(
        bytes32 digest,
        uint256,
        bool,
        IThassaHub.UpdateEnvelope calldata update,
        IThassaHub.ProofEnvelope calldata proof
    ) external view returns (bool) {
        if (proof.scheme != PROOF_SCHEME_SIGNATURE) {
            return false;
        }
        if (proof.publicValues.length != 32) {
            return false;
        }
        if (update.fulfiller != adminSigner) {
            return false;
        }

        (address recoveredSigner, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(digest.toEthSignedMessageHash(), proof.proof);

        if (recoverError != ECDSA.RecoverError.NoError) {
            return false;
        }

        return recoveredSigner == adminSigner;
    }
}
