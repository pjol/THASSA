// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Six-decimal dev stablecoin with an open mint faucet and EIP-3009
///         (`transferWithAuthorization` / `receiveWithAuthorization`) support to mirror
///         Tempo stablecoins for local development.
contract MockUSD is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    error AuthorizationNotYetValid(uint256 validAfter, uint256 currentTimestamp);
    error AuthorizationExpired(uint256 validBefore, uint256 currentTimestamp);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidAuthorizationSignature(address expectedSigner, address recoveredSigner);
    error CallerMustBePayee(address expectedPayee, address caller);

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    constructor() ERC20("Mock USD", "mUSD") EIP712("Mock USD", "1") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open dev faucet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _consumeAuthorization(from, structHash, nonce, validAfter, validBefore, v, r, s);

        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (msg.sender != to) {
            revert CallerMustBePayee(to, msg.sender);
        }

        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _consumeAuthorization(from, structHash, nonce, validAfter, validBefore, v, r, s);

        _transfer(from, to, value);
    }

    function _consumeAuthorization(
        address authorizer,
        bytes32 structHash,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (block.timestamp <= validAfter) {
            revert AuthorizationNotYetValid(validAfter, block.timestamp);
        }
        if (block.timestamp >= validBefore) {
            revert AuthorizationExpired(validBefore, block.timestamp);
        }
        if (_authorizationStates[authorizer][nonce]) {
            revert AuthorizationAlreadyUsed(authorizer, nonce);
        }

        address recoveredSigner = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        if (recoveredSigner != authorizer) {
            revert InvalidAuthorizationSignature(authorizer, recoveredSigner);
        }

        _authorizationStates[authorizer][nonce] = true;

        emit AuthorizationUsed(authorizer, nonce);
    }
}
