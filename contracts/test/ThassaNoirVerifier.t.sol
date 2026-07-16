// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {INoirVerifier} from "../interfaces/INoirVerifier.sol";
import {ThassaNoirVerifier} from "../src/ThassaNoirVerifier.sol";

contract ThassaNoirVerifierTest is Test {
    uint8 private constant PROOF_SCHEME_NOIR = 3;
    uint256 private constant PREFIX_PUBLIC_INPUTS = 29;
    uint256 private constant MAX_OPENAI_BASE_URL_CHUNKS = 9;
    uint256 private constant MAX_OPENAI_ENDPOINT_CHUNKS = 5;
    uint256 private constant URL_CHUNK_START = PREFIX_PUBLIC_INPUTS;
    uint256 private constant ENDPOINT_CHUNK_START = URL_CHUNK_START + MAX_OPENAI_BASE_URL_CHUNKS;

    address private client = makeAddr("client");
    address private fulfiller = makeAddr("fulfiller");
    address private attestor = makeAddr("attestor");

    MockNoirVerifier private mockVerifier;
    ThassaNoirVerifier private verifier;

    function setUp() public {
        mockVerifier = new MockNoirVerifier();
        verifier = new ThassaNoirVerifier(address(mockVerifier), attestor);
    }

    function test_VerifyUpdate_AcceptsValidProofAndExtractedPayload() public {
        bytes memory callbackData = abi.encode(uint64(1_741_790_800), int32(1625), string("partly cloudy"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        mockVerifier.setResult(true);
        assertTrue(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsCallbackHashMismatch() public {
        bytes memory callbackData = abi.encode(uint64(10), string("sunny"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        _storeBytes32Split(publicInputs, 21, keccak256("tampered"));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsNoirVerifierFailure() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        mockVerifier.setResult(false);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsUnexpectedAttestor() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        publicInputs[8] = bytes32(uint256(uint160(makeAddr("wrong-attestor"))));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsUnexpectedOpenAiUrl() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        _setChunkedBytes(publicInputs, 25, 26, URL_CHUNK_START, bytes("https://evil.example/v1"));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsUnexpectedOpenAiEndpoint() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        _setChunkedBytes(publicInputs, 27, 28, ENDPOINT_CHUNK_START, bytes("/responses"));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsNonCanonicalUrlChunkHighByte() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        publicInputs[URL_CHUNK_START] = bytes32(uint256(publicInputs[URL_CHUNK_START]) | (uint256(1) << 248));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsDirtyUrlChunkPadding() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        publicInputs[URL_CHUNK_START] = bytes32(uint256(publicInputs[URL_CHUNK_START]) | uint256(1));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsInputDataHashMismatch() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        _storeBytes32Split(publicInputs, 17, keccak256("different input"));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function test_VerifyUpdate_RejectsResponseIdMismatch() public {
        bytes memory callbackData = abi.encode(uint64(10), string("fog"));
        bytes32 digest = keccak256("digest");
        IThassaHub.UpdateEnvelope memory update = _buildUpdateEnvelope(callbackData);
        IThassaHub.ProofEnvelope memory proof = _buildProofEnvelope(digest, 0, false, update);

        bytes32[] memory publicInputs = _decodePackedInputs(proof.publicValues);
        _storeBytes32Split(publicInputs, 19, keccak256("different response"));
        proof.publicValues = _packPublicInputs(publicInputs);

        mockVerifier.setResult(true);
        assertFalse(verifier.verifyUpdate(digest, 0, false, update, proof));
    }

    function _buildUpdateEnvelope(bytes memory callbackData) internal view returns (IThassaHub.UpdateEnvelope memory) {
        return IThassaHub.UpdateEnvelope({
            client: client,
            callbackData: callbackData,
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

    function _buildProofEnvelope(bytes32 digest, uint256 bidId, bool autoFlow, IThassaHub.UpdateEnvelope memory update)
        internal
        view
        returns (IThassaHub.ProofEnvelope memory)
    {
        bytes32[] memory publicInputs = _buildPublicInputs(digest, bidId, autoFlow, update);
        return IThassaHub.ProofEnvelope({
            scheme: PROOF_SCHEME_NOIR, publicValues: _packPublicInputs(publicInputs), proof: hex"1234"
        });
    }

    function _buildPublicInputs(bytes32 digest, uint256 bidId, bool autoFlow, IThassaHub.UpdateEnvelope memory update)
        internal
        view
        returns (bytes32[] memory publicInputs)
    {
        publicInputs = new bytes32[](ENDPOINT_CHUNK_START + MAX_OPENAI_ENDPOINT_CHUNKS);
        bytes memory callbackData = update.callbackData;

        publicInputs[0] = bytes32(uint256(1));
        _storeBytes32Split(publicInputs, 1, digest);
        _storeUint256Split(publicInputs, 3, bidId);
        publicInputs[5] = bytes32(uint256(autoFlow ? 1 : 0));
        publicInputs[6] = bytes32(uint256(uint160(update.client)));
        publicInputs[7] = bytes32(uint256(uint160(update.fulfiller)));
        publicInputs[8] = bytes32(uint256(uint160(attestor)));
        _storeBytes32Split(publicInputs, 9, update.queryHash);
        _storeBytes32Split(publicInputs, 11, update.shapeHash);
        _storeBytes32Split(publicInputs, 13, update.modelHash);
        publicInputs[15] = bytes32(uint256(update.clientVersion));
        publicInputs[16] = bytes32(uint256(update.requestTimestamp));
        _storeBytes32Split(publicInputs, 17, keccak256(update.inputData));
        _storeBytes32Split(publicInputs, 19, update.responseId);
        _storeBytes32Split(publicInputs, 21, keccak256(callbackData));
        publicInputs[23] = bytes32(uint256(uint160(address(this))));
        publicInputs[24] = bytes32(uint256(block.chainid));
        _setChunkedBytes(publicInputs, 25, 26, URL_CHUNK_START, bytes("https://api.openai.com/v1"));
        _setChunkedBytes(publicInputs, 27, 28, ENDPOINT_CHUNK_START, bytes("/chat/completions"));
    }

    function _chunkWord(bytes memory callbackData, uint256 chunkIndex) internal pure returns (bytes32 word) {
        uint256 start = chunkIndex * 31;
        uint256 remaining = callbackData.length - start;
        uint256 copyLength = remaining > 31 ? 31 : remaining;
        bytes memory buffer = new bytes(32);
        for (uint256 i = 0; i < copyLength; ++i) {
            buffer[i + 1] = callbackData[start + i];
        }
        assembly {
            word := mload(add(buffer, 32))
        }
    }

    function _storeChunkedBytes(bytes32[] memory publicInputs, uint256 startIndex, bytes memory data) internal pure {
        uint256 chunkCount = _expectedChunkCount(data.length);
        for (uint256 i = 0; i < chunkCount; ++i) {
            publicInputs[startIndex + i] = _chunkWord(data, i);
        }
    }

    function _setChunkedBytes(
        bytes32[] memory publicInputs,
        uint256 lenIndex,
        uint256 countIndex,
        uint256 startIndex,
        bytes memory data
    ) internal pure {
        publicInputs[lenIndex] = bytes32(uint256(data.length));
        publicInputs[countIndex] = bytes32(uint256(_expectedChunkCount(data.length)));
        _storeChunkedBytes(publicInputs, startIndex, data);
    }

    function _packPublicInputs(bytes32[] memory publicInputs) internal pure returns (bytes memory raw) {
        raw = new bytes(publicInputs.length * 32);
        for (uint256 i = 0; i < publicInputs.length; ++i) {
            bytes32 word = publicInputs[i];
            assembly {
                mstore(add(add(raw, 32), mul(i, 32)), word)
            }
        }
    }

    function _decodePackedInputs(bytes memory raw) internal pure returns (bytes32[] memory publicInputs) {
        publicInputs = new bytes32[](raw.length / 32);
        for (uint256 i = 0; i < publicInputs.length; ++i) {
            bytes32 word;
            assembly {
                word := mload(add(add(raw, 32), mul(i, 32)))
            }
            publicInputs[i] = word;
        }
    }

    function _splitBytes32(bytes32 value) internal pure returns (bytes32 hi, bytes32 lo) {
        return _splitUint256(uint256(value));
    }

    function _splitUint256(uint256 value) internal pure returns (bytes32 hi, bytes32 lo) {
        hi = bytes32(value >> 128);
        lo = bytes32(uint256(uint128(value)));
    }

    function _storeBytes32Split(bytes32[] memory publicInputs, uint256 index, bytes32 value) internal pure {
        (bytes32 hi, bytes32 lo) = _splitBytes32(value);
        publicInputs[index] = hi;
        publicInputs[index + 1] = lo;
    }

    function _storeUint256Split(bytes32[] memory publicInputs, uint256 index, uint256 value) internal pure {
        (bytes32 hi, bytes32 lo) = _splitUint256(value);
        publicInputs[index] = hi;
        publicInputs[index + 1] = lo;
    }

    function _expectedChunkCount(uint256 callbackLength) internal pure returns (uint256) {
        if (callbackLength == 0) {
            return 0;
        }
        return ((callbackLength - 1) / 31) + 1;
    }
}

contract MockNoirVerifier is INoirVerifier {
    bool private result = true;

    function setResult(bool nextResult) external {
        result = nextResult;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return result;
    }
}
