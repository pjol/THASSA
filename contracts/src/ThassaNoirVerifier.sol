// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {INoirVerifier} from "../interfaces/INoirVerifier.sol";
import {IThassaVerifier} from "../interfaces/IThassaVerifier.sol";

contract ThassaNoirVerifier is IThassaVerifier {
    uint8 public constant PROOF_SCHEME_NOIR = 3;

    uint256 internal constant PREFIX_PUBLIC_INPUTS = 29;
    uint256 internal constant MAX_OPENAI_BASE_URL_BYTES = 256;
    uint256 internal constant MAX_OPENAI_BASE_URL_CHUNKS = 9;
    uint256 internal constant MAX_OPENAI_ENDPOINT_BYTES = 128;
    uint256 internal constant MAX_OPENAI_ENDPOINT_CHUNKS = 5;
    uint256 internal constant URL_CHUNK_START = PREFIX_PUBLIC_INPUTS;
    uint256 internal constant ENDPOINT_CHUNK_START = URL_CHUNK_START + MAX_OPENAI_BASE_URL_CHUNKS;
    uint256 internal constant EXPECTED_PUBLIC_INPUTS = ENDPOINT_CHUNK_START + MAX_OPENAI_ENDPOINT_CHUNKS;

    uint256 internal constant ATTESTOR_INDEX = 8;
    uint256 internal constant INPUT_DATA_HASH_HI_INDEX = 17;
    uint256 internal constant INPUT_DATA_HASH_LO_INDEX = 18;
    uint256 internal constant RESPONSE_ID_HI_INDEX = 19;
    uint256 internal constant RESPONSE_ID_LO_INDEX = 20;
    uint256 internal constant CALLBACK_HASH_HI_INDEX = 21;
    uint256 internal constant CALLBACK_HASH_LO_INDEX = 22;
    uint256 internal constant HUB_INDEX = 23;
    uint256 internal constant CHAIN_ID_INDEX = 24;
    uint256 internal constant URL_LEN_INDEX = 25;
    uint256 internal constant URL_CHUNK_COUNT_INDEX = 26;
    uint256 internal constant ENDPOINT_LEN_INDEX = 27;
    uint256 internal constant ENDPOINT_CHUNK_COUNT_INDEX = 28;

    error ZeroVerifierAddress();
    error ZeroAttestorAddress();

    address public immutable noirVerifier;
    address public immutable expectedAttestor;

    constructor(address noirVerifier_, address expectedAttestor_) {
        if (noirVerifier_ == address(0)) {
            revert ZeroVerifierAddress();
        }
        if (expectedAttestor_ == address(0)) {
            revert ZeroAttestorAddress();
        }

        noirVerifier = noirVerifier_;
        expectedAttestor = expectedAttestor_;
    }

    function verifyUpdate(
        bytes32 digest,
        uint256 bidId,
        bool autoFlow,
        IThassaHub.UpdateEnvelope calldata update,
        IThassaHub.ProofEnvelope calldata proof
    ) external view returns (bool) {
        if (proof.scheme != PROOF_SCHEME_NOIR) {
            return false;
        }
        if (update.client == address(0) || update.fulfiller == address(0)) {
            return false;
        }

        bytes32[] memory publicInputs = _decodePublicInputs(proof.publicValues);
        if (publicInputs.length != EXPECTED_PUBLIC_INPUTS) {
            return false;
        }

        try INoirVerifier(noirVerifier).verify(proof.proof, publicInputs) returns (bool verified) {
            if (!verified) {
                return false;
            }
        } catch {
            return false;
        }

        if (!_validateChunkLayout(publicInputs)) {
            return false;
        }
        if (!_validateExpectedRequestUrl(publicInputs)) {
            return false;
        }
        if (!_validatePrefix(publicInputs, digest, bidId, autoFlow, update)) {
            return false;
        }

        return true;
    }

    function _validatePrefix(
        bytes32[] memory publicInputs,
        bytes32 digest,
        uint256 bidId,
        bool autoFlow,
        IThassaHub.UpdateEnvelope calldata update
    ) internal view returns (bool) {
        if (publicInputs[0] != bytes32(uint256(1))) {
            return false;
        }
        if (!_isU128(publicInputs[1]) || !_isU128(publicInputs[2])) {
            return false;
        }
        if (_combineLimbs(publicInputs[1], publicInputs[2]) != digest) {
            return false;
        }
        if (!_isU128(publicInputs[3]) || !_isU128(publicInputs[4])) {
            return false;
        }
        if (_combineUint256(publicInputs[3], publicInputs[4]) != bidId) {
            return false;
        }
        if (!_matchesBool(publicInputs[5], autoFlow)) {
            return false;
        }
        if (!_matchesAddress(publicInputs[6], update.client)) {
            return false;
        }
        if (!_matchesAddress(publicInputs[7], update.fulfiller)) {
            return false;
        }
        if (!_matchesAddress(publicInputs[ATTESTOR_INDEX], expectedAttestor)) {
            return false;
        }
        if (!_isU128(publicInputs[9]) || !_isU128(publicInputs[10])) {
            return false;
        }
        if (_combineLimbs(publicInputs[9], publicInputs[10]) != update.queryHash) {
            return false;
        }
        if (!_isU128(publicInputs[11]) || !_isU128(publicInputs[12])) {
            return false;
        }
        if (_combineLimbs(publicInputs[11], publicInputs[12]) != update.shapeHash) {
            return false;
        }
        if (!_isU128(publicInputs[13]) || !_isU128(publicInputs[14])) {
            return false;
        }
        if (_combineLimbs(publicInputs[13], publicInputs[14]) != update.modelHash) {
            return false;
        }
        if (uint256(publicInputs[15]) != update.clientVersion) {
            return false;
        }
        if (uint256(publicInputs[16]) != update.requestTimestamp) {
            return false;
        }
        if (!_isU128(publicInputs[INPUT_DATA_HASH_HI_INDEX]) || !_isU128(publicInputs[INPUT_DATA_HASH_LO_INDEX])) {
            return false;
        }
        if (
            _combineLimbs(publicInputs[INPUT_DATA_HASH_HI_INDEX], publicInputs[INPUT_DATA_HASH_LO_INDEX])
                != keccak256(update.inputData)
        ) {
            return false;
        }
        if (!_isU128(publicInputs[RESPONSE_ID_HI_INDEX]) || !_isU128(publicInputs[RESPONSE_ID_LO_INDEX])) {
            return false;
        }
        if (_combineLimbs(publicInputs[RESPONSE_ID_HI_INDEX], publicInputs[RESPONSE_ID_LO_INDEX]) != update.responseId)
        {
            return false;
        }
        if (!_isU128(publicInputs[CALLBACK_HASH_HI_INDEX]) || !_isU128(publicInputs[CALLBACK_HASH_LO_INDEX])) {
            return false;
        }
        if (
            _combineLimbs(publicInputs[CALLBACK_HASH_HI_INDEX], publicInputs[CALLBACK_HASH_LO_INDEX])
                != keccak256(update.callbackData)
        ) {
            return false;
        }
        if (!_matchesAddress(publicInputs[HUB_INDEX], msg.sender)) {
            return false;
        }
        if (uint256(publicInputs[CHAIN_ID_INDEX]) != block.chainid) {
            return false;
        }
        return true;
    }

    function _validateChunkLayout(bytes32[] memory publicInputs) internal pure returns (bool) {
        uint256 urlLength = uint256(publicInputs[URL_LEN_INDEX]);
        uint256 urlChunkCount = uint256(publicInputs[URL_CHUNK_COUNT_INDEX]);
        uint256 endpointLength = uint256(publicInputs[ENDPOINT_LEN_INDEX]);
        uint256 endpointChunkCount = uint256(publicInputs[ENDPOINT_CHUNK_COUNT_INDEX]);

        if (urlLength > MAX_OPENAI_BASE_URL_BYTES || urlChunkCount > MAX_OPENAI_BASE_URL_CHUNKS) {
            return false;
        }
        if (endpointLength > MAX_OPENAI_ENDPOINT_BYTES || endpointChunkCount > MAX_OPENAI_ENDPOINT_CHUNKS) {
            return false;
        }

        if (urlChunkCount != _expectedChunkCount(urlLength)) {
            return false;
        }
        if (endpointChunkCount != _expectedChunkCount(endpointLength)) {
            return false;
        }

        if (!_usedChunksAreCanonical(publicInputs, URL_CHUNK_START, urlLength, urlChunkCount)) {
            return false;
        }
        if (!_usedChunksAreCanonical(publicInputs, ENDPOINT_CHUNK_START, endpointLength, endpointChunkCount)) {
            return false;
        }
        if (!_unusedChunksAreZero(publicInputs, URL_CHUNK_START, urlChunkCount, MAX_OPENAI_BASE_URL_CHUNKS)) {
            return false;
        }
        if (!_unusedChunksAreZero(publicInputs, ENDPOINT_CHUNK_START, endpointChunkCount, MAX_OPENAI_ENDPOINT_CHUNKS)) {
            return false;
        }
        return true;
    }

    function _validateExpectedRequestUrl(bytes32[] memory publicInputs) internal pure returns (bool) {
        uint256 urlLength = uint256(publicInputs[URL_LEN_INDEX]);
        uint256 urlChunkCount = uint256(publicInputs[URL_CHUNK_COUNT_INDEX]);
        uint256 endpointLength = uint256(publicInputs[ENDPOINT_LEN_INDEX]);
        uint256 endpointChunkCount = uint256(publicInputs[ENDPOINT_CHUNK_COUNT_INDEX]);

        bytes memory url =
            _extractChunkedBytes(publicInputs, URL_CHUNK_START, urlLength, urlChunkCount, MAX_OPENAI_BASE_URL_CHUNKS);
        bytes memory endpoint = _extractChunkedBytes(
            publicInputs, ENDPOINT_CHUNK_START, endpointLength, endpointChunkCount, MAX_OPENAI_ENDPOINT_CHUNKS
        );

        return keccak256(url) == keccak256(bytes("https://api.openai.com/v1"))
            && keccak256(endpoint) == keccak256(bytes("/chat/completions"));
    }

    function _extractChunkedBytes(
        bytes32[] memory publicInputs,
        uint256 startIndex,
        uint256 length,
        uint256 chunkCount,
        uint256 maxChunkCount
    ) internal pure returns (bytes memory data) {
        data = new bytes(length);
        uint256 cursor = 0;
        for (uint256 i = 0; i < maxChunkCount; ++i) {
            if (i >= chunkCount) {
                continue;
            }
            bytes32 chunk = publicInputs[startIndex + i];
            uint256 copyLength = length - cursor;
            if (copyLength > 31) {
                copyLength = 31;
            }
            for (uint256 j = 0; j < copyLength; ++j) {
                data[cursor + j] = chunk[j + 1];
            }
            cursor += copyLength;
        }
    }

    function _usedChunksAreCanonical(
        bytes32[] memory publicInputs,
        uint256 start,
        uint256 length,
        uint256 usedChunkCount
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < usedChunkCount; ++i) {
            bytes32 chunk = publicInputs[start + i];
            if (chunk[0] != 0x00) {
                return false;
            }

            if (i == usedChunkCount - 1) {
                uint256 usedBytes = length - (i * 31);
                for (uint256 j = usedBytes + 1; j < 32; ++j) {
                    if (chunk[j] != 0x00) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    function _unusedChunksAreZero(
        bytes32[] memory publicInputs,
        uint256 start,
        uint256 usedChunkCount,
        uint256 maxChunkCount
    ) internal pure returns (bool) {
        for (uint256 i = usedChunkCount; i < maxChunkCount; ++i) {
            if (publicInputs[start + i] != bytes32(0)) {
                return false;
            }
        }
        return true;
    }

    function _decodePublicInputs(bytes calldata raw) internal pure returns (bytes32[] memory publicInputs) {
        if (raw.length % 32 != 0) {
            return new bytes32[](0);
        }

        uint256 words = raw.length / 32;
        publicInputs = new bytes32[](words);
        for (uint256 i = 0; i < words; ++i) {
            bytes32 word;
            assembly {
                word := calldataload(add(raw.offset, mul(i, 32)))
            }
            publicInputs[i] = word;
        }
    }

    function _matchesBool(bytes32 word, bool value) internal pure returns (bool) {
        uint256 raw = uint256(word);
        if (raw > 1) {
            return false;
        }
        return (raw == 1) == value;
    }

    function _matchesAddress(bytes32 word, address value) internal pure returns (bool) {
        uint256 raw = uint256(word);
        if (raw >> 160 != 0) {
            return false;
        }
        return address(uint160(raw)) == value;
    }

    function _isU128(bytes32 word) internal pure returns (bool) {
        return uint256(word) >> 128 == 0;
    }

    function _combineLimbs(bytes32 hiWord, bytes32 loWord) internal pure returns (bytes32) {
        return bytes32(_combineUint256(hiWord, loWord));
    }

    function _combineUint256(bytes32 hiWord, bytes32 loWord) internal pure returns (uint256) {
        return (uint256(hiWord) << 128) | uint256(loWord);
    }

    function _expectedChunkCount(uint256 callbackLength) internal pure returns (uint256) {
        if (callbackLength == 0) {
            return 0;
        }
        return ((callbackLength - 1) / 31) + 1;
    }
}
