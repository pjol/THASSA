// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {ThassaPoAVerifier} from "../src/ThassaPoAVerifier.sol";

contract ThassaPoAVerifierTest is Test {
    using MessageHashUtils for bytes32;

    uint256 private constant SIGNER_PRIVATE_KEY = 0xA11CE;
    uint256 private constant SECOND_SIGNER_PRIVATE_KEY = 0xB0B;
    uint8 private constant PROOF_SCHEME_SIGNATURE = 1;

    address private owner = makeAddr("owner");
    address private signer = vm.addr(SIGNER_PRIVATE_KEY);
    address private secondSigner = vm.addr(SECOND_SIGNER_PRIVATE_KEY);
    ThassaPoAVerifier private verifier;

    function setUp() public {
        address[] memory initialSigners = new address[](1);
        initialSigners[0] = signer;

        verifier = new ThassaPoAVerifier(owner, initialSigners);
    }

    function test_Constructor_RegistersInitialSigners() public view {
        assertTrue(verifier.isSigner(signer));
        assertEq(verifier.signerCount(), 1);
        assertEq(verifier.owner(), owner);
    }

    function test_Constructor_RejectsZeroSigner() public {
        address[] memory initialSigners = new address[](1);
        initialSigners[0] = address(0);

        vm.expectRevert(ThassaPoAVerifier.ZeroSignerAddress.selector);
        new ThassaPoAVerifier(owner, initialSigners);
    }

    function test_Constructor_RejectsDuplicateSigner() public {
        address[] memory initialSigners = new address[](2);
        initialSigners[0] = signer;
        initialSigners[1] = signer;

        vm.expectRevert(abi.encodeWithSelector(ThassaPoAVerifier.SignerAlreadyAuthorized.selector, signer));
        new ThassaPoAVerifier(owner, initialSigners);
    }

    function test_AddSigner_OnlyOwner() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit ThassaPoAVerifier.SignerAdded(secondSigner);
        verifier.addSigner(secondSigner);

        assertTrue(verifier.isSigner(secondSigner));
        assertEq(verifier.signerCount(), 2);

        address intruder = makeAddr("intruder");
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, intruder));
        verifier.addSigner(makeAddr("another"));
    }

    function test_AddSigner_RejectsDuplicateAndZero() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ThassaPoAVerifier.SignerAlreadyAuthorized.selector, signer));
        verifier.addSigner(signer);

        vm.prank(owner);
        vm.expectRevert(ThassaPoAVerifier.ZeroSignerAddress.selector);
        verifier.addSigner(address(0));
    }

    function test_RemoveSigner_OnlyOwnerAndMustExist() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit ThassaPoAVerifier.SignerRemoved(signer);
        verifier.removeSigner(signer);

        assertFalse(verifier.isSigner(signer));
        assertEq(verifier.signerCount(), 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ThassaPoAVerifier.SignerNotAuthorized.selector, signer));
        verifier.removeSigner(signer);

        address intruder = makeAddr("intruder");
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, intruder));
        verifier.removeSigner(signer);
    }

    function test_VerifyUpdate_AcceptsValidSignatureFromAnyAuthorizedSigner() public {
        vm.prank(owner);
        verifier.addSigner(secondSigner);

        bytes32 digest = keccak256("digest");

        assertTrue(
            verifier.verifyUpdate(
                digest, 0, false, _buildUpdateEnvelope(signer), _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY)
            )
        );
        assertTrue(
            verifier.verifyUpdate(
                digest,
                7,
                true,
                _buildUpdateEnvelope(secondSigner),
                _buildProofEnvelope(digest, SECOND_SIGNER_PRIVATE_KEY)
            )
        );
    }

    function test_VerifyUpdate_RejectsWrongScheme() public {
        bytes32 digest = keccak256("digest");
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY);
        proof.scheme = 2;

        assertFalse(verifier.verifyUpdate(digest, 0, false, _buildUpdateEnvelope(signer), proof));
    }

    function test_VerifyUpdate_RejectsInvalidFulfilledMarkerLength() public {
        bytes32 digest = keccak256("digest");
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY);
        proof.publicValues = abi.encodePacked(uint8(1));

        assertFalse(verifier.verifyUpdate(digest, 0, false, _buildUpdateEnvelope(signer), proof));
    }

    function test_VerifyUpdate_RejectsUnauthorizedFulfiller() public {
        bytes32 digest = keccak256("digest");

        assertFalse(
            verifier.verifyUpdate(
                digest, 0, false, _buildUpdateEnvelope(makeAddr("other")), _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY)
            )
        );
    }

    function test_VerifyUpdate_RejectsSignerFulfillerMismatch() public {
        vm.prank(owner);
        verifier.addSigner(secondSigner);

        bytes32 digest = keccak256("digest");

        // secondSigner is authorized, but the signature comes from a different authorized signer.
        assertFalse(
            verifier.verifyUpdate(
                digest, 0, false, _buildUpdateEnvelope(secondSigner), _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY)
            )
        );
    }

    function test_VerifyUpdate_RejectsRemovedSigner() public {
        vm.prank(owner);
        verifier.removeSigner(signer);

        bytes32 digest = keccak256("digest");

        assertFalse(
            verifier.verifyUpdate(
                digest, 0, false, _buildUpdateEnvelope(signer), _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY)
            )
        );
    }

    function test_VerifyUpdate_RejectsMalformedSignature() public {
        bytes32 digest = keccak256("digest");
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, SIGNER_PRIVATE_KEY);
        proof.proof = hex"deadbeef";

        assertFalse(verifier.verifyUpdate(digest, 0, false, _buildUpdateEnvelope(signer), proof));
    }

    function _buildUpdateEnvelope(address fulfiller) internal pure returns (IThassaHub.UpdateEnvelope memory) {
        return IThassaHub.UpdateEnvelope({
            client: address(0x1234),
            callbackData: hex"1234",
            inputData: bytes("{}"),
            responseId: keccak256("response-id"),
            queryHash: keccak256("query"),
            shapeHash: keccak256("shape"),
            modelHash: keccak256("model"),
            clientVersion: 1,
            requestTimestamp: 100,
            fulfiller: fulfiller
        });
    }

    function _buildProofEnvelope(bytes32 digest, uint256 privateKey)
        internal
        pure
        returns (IThassaHub.ProofEnvelope memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest.toEthSignedMessageHash());
        return IThassaHub.ProofEnvelope({
            scheme: PROOF_SCHEME_SIGNATURE,
            publicValues: abi.encode(true),
            proof: abi.encodePacked(r, s, v)
        });
    }
}
