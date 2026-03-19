// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {ISP1Verifier} from "../interfaces/ISP1Verifier.sol";
import {IThassaVerifier} from "../interfaces/IThassaVerifier.sol";

contract ThassaSP1Verifier is IThassaVerifier {
    uint8 public constant PROOF_SCHEME_SP1 = 2;

    error ZeroVerifierAddress();
    error ZeroProgramVKey();

    address public immutable sp1Verifier;
    bytes32 public immutable programVKey;

    constructor(address sp1Verifier_, bytes32 programVKey_) {
        if (sp1Verifier_ == address(0)) {
            revert ZeroVerifierAddress();
        }
        if (programVKey_ == bytes32(0)) {
            revert ZeroProgramVKey();
        }

        sp1Verifier = sp1Verifier_;
        programVKey = programVKey_;
    }

    function verifyUpdate(
        bytes32 digest,
        uint256 bidId,
        bool autoFlow,
        IThassaHub.UpdateEnvelope calldata update,
        IThassaHub.ProofEnvelope calldata proof
    ) external view returns (bool) {
        if (proof.scheme != PROOF_SCHEME_SP1) {
            return false;
        }
        if (update.client == address(0) || update.fulfiller == address(0)) {
            return false;
        }
        if (proof.publicValues.length != 14 * 32) {
            return false;
        }

        try ISP1Verifier(sp1Verifier).verifyProof(programVKey, proof.publicValues, proof.proof) {
        } catch {
            return false;
        }

        IThassaHub.ProofCommitment memory commitment = abi.decode(proof.publicValues, (IThassaHub.ProofCommitment));

        return commitment.digest == digest && commitment.bidId == bidId && commitment.autoFlow == autoFlow
            && commitment.client == update.client && commitment.fulfiller == update.fulfiller
            && commitment.queryHash == update.queryHash && commitment.shapeHash == update.shapeHash
            && commitment.modelHash == update.modelHash && commitment.clientVersion == update.clientVersion
            && commitment.requestTimestamp == update.requestTimestamp && commitment.expiry == update.expiry
            && commitment.nonce == update.nonce
            && commitment.callbackHash == keccak256(update.callbackData);
    }
}
