// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaVerifier} from "../interfaces/IThassaVerifier.sol";

/// @notice Proof-of-authority verifier module: same verification semantics as
///         `ThassaSignatureVerifier` (scheme 1, EIP-191 personal_sign over the hub
///         ProofUpdateV2 digest, 32-byte fulfilled marker), but the single immutable
///         admin signer is generalized to an owner-managed signer set.
contract ThassaPoAVerifier is IThassaVerifier, Ownable {
    using MessageHashUtils for bytes32;

    uint8 public constant PROOF_SCHEME_SIGNATURE = 1;

    error ZeroSignerAddress();
    error SignerAlreadyAuthorized(address signer);
    error SignerNotAuthorized(address signer);

    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);

    mapping(address => bool) private _signers;
    uint256 private _signerCount;

    constructor(address owner_, address[] memory initialSigners) Ownable(owner_) {
        for (uint256 i = 0; i < initialSigners.length; i++) {
            _addSigner(initialSigners[i]);
        }
    }

    function addSigner(address signer) external onlyOwner {
        _addSigner(signer);
    }

    function removeSigner(address signer) external onlyOwner {
        if (!_signers[signer]) {
            revert SignerNotAuthorized(signer);
        }

        _signers[signer] = false;
        _signerCount -= 1;

        emit SignerRemoved(signer);
    }

    function isSigner(address signer) external view returns (bool) {
        return _signers[signer];
    }

    function signerCount() external view returns (uint256) {
        return _signerCount;
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
        if (!_signers[update.fulfiller]) {
            return false;
        }

        (address recoveredSigner, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(digest.toEthSignedMessageHash(), proof.proof);

        if (recoverError != ECDSA.RecoverError.NoError) {
            return false;
        }

        return recoveredSigner == update.fulfiller;
    }

    function _addSigner(address signer) internal {
        if (signer == address(0)) {
            revert ZeroSignerAddress();
        }
        if (_signers[signer]) {
            revert SignerAlreadyAuthorized(signer);
        }

        _signers[signer] = true;
        _signerCount += 1;

        emit SignerAdded(signer);
    }
}
