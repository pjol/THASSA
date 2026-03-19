// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {ThassaSignatureVerifier} from "../src/ThassaSignatureVerifier.sol";

contract ThassaSignatureVerifierTest is Test {
    using MessageHashUtils for bytes32;

    uint256 private constant SIGNER_PRIVATE_KEY = 0xA11CE;
    uint8 private constant PROOF_SCHEME_SIGNATURE = 1;

    address private signer = vm.addr(SIGNER_PRIVATE_KEY);
    ThassaSignatureVerifier private verifier;

    function setUp() public {
        verifier = new ThassaSignatureVerifier(signer);
    }

    function test_VerifyUpdate_AcceptsValidSignatureProof() public {
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(signer);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest);

        assertTrue(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsWrongScheme() public {
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(signer);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest);
        proof.scheme = 2;

        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsFulfillerMismatch() public {
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(makeAddr("other"));
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest);

        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function _buildUpdateEnvelope(address fulfiller) internal pure returns (IThassaHub.UpdateEnvelope memory) {
        return IThassaHub.UpdateEnvelope({
            client: address(0x1234),
            callbackData: hex"1234",
            queryHash: keccak256("query"),
            shapeHash: keccak256("shape"),
            modelHash: keccak256("model"),
            clientVersion: 1,
            requestTimestamp: 100,
            expiry: 200,
            nonce: 300,
            fulfiller: fulfiller
        });
    }

    function _buildProofEnvelope(bytes32 digest) internal returns (IThassaHub.ProofEnvelope memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PRIVATE_KEY, digest.toEthSignedMessageHash());
        return IThassaHub.ProofEnvelope({
            scheme: PROOF_SCHEME_SIGNATURE,
            publicValues: abi.encode(true),
            proof: abi.encodePacked(r, s, v)
        });
    }
}
