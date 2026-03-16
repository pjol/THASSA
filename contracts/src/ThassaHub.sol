// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaOracle} from "../interfaces/IThassaOracle.sol";
import {IThassaVerifier} from "../interfaces/IThassaVerifier.sol";

contract ThassaHub is IThassaHub, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant UPDATE_TYPEHASH =
        keccak256("SignedUpdate(address hub,uint256 chainId,bytes32 payloadHash,uint256 bidId,bool autoFlow)");

    IERC20 private immutable _paymentToken;

    uint256 public immutable override baseProtocolFee;
    uint256 public immutable override autoFlowLockup;
    address public override feeCollector;
    address public override verifierModule;
    uint256 public override nextBidId = 1;

    mapping(uint256 => Bid) private _bids;
    mapping(bytes32 => bool) public override consumedDigests;

    constructor(address paymentToken_, address feeCollector_, address verifierModule_) Ownable(msg.sender) {
        if (paymentToken_ == address(0) || feeCollector_ == address(0) || verifierModule_ == address(0)) {
            revert ZeroAddress();
        }

        IERC20Metadata paymentTokenMetadata = IERC20Metadata(paymentToken_);
        uint8 tokenDecimals = paymentTokenMetadata.decimals();
        if (tokenDecimals > 77) {
            revert InvalidPaymentTokenDecimals(tokenDecimals);
        }

        uint256 oneToken = 10 ** uint256(tokenDecimals);
        uint256 oneCent = oneToken / 100;
        if (oneCent == 0) {
            revert InvalidPaymentTokenDecimals(tokenDecimals);
        }

        _paymentToken = IERC20(paymentToken_);
        feeCollector = feeCollector_;
        verifierModule = verifierModule_;
        baseProtocolFee = oneCent;
        autoFlowLockup = oneCent;
    }

    function paymentToken() external view override returns (address) {
        return address(_paymentToken);
    }

    function getBid(uint256 bidId) external view override returns (Bid memory) {
        return _bids[bidId];
    }

    function setFeeCollector(address newCollector) external override onlyOwner {
        if (newCollector == address(0)) {
            revert ZeroAddress();
        }

        address oldCollector = feeCollector;
        feeCollector = newCollector;

        emit FeeCollectorUpdated(oldCollector, newCollector);
    }

    function setVerifierModule(address newVerifierModule) external override onlyOwner {
        if (newVerifierModule == address(0)) {
            revert ZeroAddress();
        }

        address oldVerifierModule = verifierModule;
        verifierModule = newVerifierModule;

        emit VerifierModuleUpdated(oldVerifierModule, newVerifierModule);
    }

    function placeBid(address client, uint256 bidAmount) external override nonReentrant returns (uint256 bidId) {
        return _placeBid(client, bidAmount);
    }

    function _placeBid(address client, uint256 bidAmount) internal returns (uint256 bidId) {
        if (client == address(0)) {
            revert ZeroAddress();
        }
        if (bidAmount < baseProtocolFee) {
            revert AmountTooLow(baseProtocolFee, bidAmount);
        }

        bidId = nextBidId;
        nextBidId = bidId + 1;

        _bids[bidId] = Bid({requester: msg.sender, client: client, amount: bidAmount, isOpen: true});

        _paymentToken.safeTransferFrom(msg.sender, address(this), bidAmount);

        emit BidPlaced(bidId, msg.sender, client, bidAmount);
    }

    function cancelBid(uint256 bidId) external override nonReentrant {
        Bid storage bid = _bids[bidId];
        if (!bid.isOpen) {
            revert BidNotOpen(bidId);
        }
        if (bid.requester != msg.sender) {
            revert NotBidRequester(bidId, msg.sender);
        }

        uint256 bidAmount = bid.amount;
        bid.isOpen = false;

        _paymentToken.safeTransfer(msg.sender, bidAmount);

        emit BidCancelled(bidId, msg.sender, bidAmount);
    }

    function submitManualUpdate(SignedUpdate calldata update) external override nonReentrant {
        bytes32 digest = _validateAndConsumeUpdate(update, 0, false);

        _paymentToken.safeTransferFrom(msg.sender, feeCollector, baseProtocolFee);

        bool callbackSuccess = _dispatchUpdate(update.client, update.callbackData);

        emit ManualUpdateSubmitted(msg.sender, update.client, update.signer, digest, callbackSuccess);
    }

    function submitAutoUpdate(uint256 bidId, SignedUpdate calldata update) external override nonReentrant {
        Bid storage bid = _bids[bidId];
        if (!bid.isOpen) {
            revert BidNotOpen(bidId);
        }
        if (bid.client != update.client) {
            revert BidClientMismatch(bid.client, update.client);
        }

        _paymentToken.safeTransferFrom(msg.sender, address(this), autoFlowLockup);

        bytes32 digest = _validateAndConsumeUpdate(update, bidId, true);
        bid.isOpen = false;

        bool callbackSuccess = _dispatchUpdate(update.client, update.callbackData);

        uint256 nodePayout = bid.amount - baseProtocolFee;

        _paymentToken.safeTransfer(feeCollector, baseProtocolFee);
        if (nodePayout > 0) {
            _paymentToken.safeTransfer(msg.sender, nodePayout);
        }
        _paymentToken.safeTransfer(msg.sender, autoFlowLockup);

        emit AutoUpdateSubmitted(
            bidId, bid.requester, msg.sender, update.client, digest, callbackSuccess, baseProtocolFee, nodePayout
        );
    }

    function computeUpdateDigest(SignedUpdate calldata update, uint256 bidId, bool autoFlow)
        external
        view
        override
        returns (bytes32)
    {
        return _computeUpdateDigest(update, bidId, autoFlow);
    }

    function _validateAndConsumeUpdate(SignedUpdate calldata update, uint256 bidId, bool autoFlow)
        internal
        returns (bytes32 digest)
    {
        if (update.client == address(0) || update.signer == address(0)) {
            revert ZeroAddress();
        }
        if (update.expiry < block.timestamp) {
            revert SignatureExpired(update.expiry, uint64(block.timestamp));
        }

        _validateOracleSpec(update);

        digest = _computeUpdateDigest(update, bidId, autoFlow);
        if (consumedDigests[digest]) {
            revert Replay(digest);
        }

        bool isValidProof = IThassaVerifier(verifierModule).verifyUpdate(digest, update);
        if (!isValidProof) {
            revert InvalidProof(verifierModule);
        }

        consumedDigests[digest] = true;
    }

    function _validateOracleSpec(SignedUpdate calldata update) internal view {
        IThassaOracle.OracleSpec memory spec = IThassaOracle(update.client).oracleSpec();

        bool matchesSpec = keccak256(bytes(spec.query)) == update.queryHash
            && keccak256(bytes(spec.expectedShape)) == update.shapeHash
            && keccak256(bytes(spec.model)) == update.modelHash && spec.clientVersion == update.clientVersion;

        if (!matchesSpec) {
            revert SpecMismatch(update.client);
        }
    }

    function _computeUpdateDigest(SignedUpdate calldata update, uint256 bidId, bool autoFlow)
        internal
        view
        returns (bytes32)
    {
        bytes32 payloadHash = keccak256(
            abi.encode(
                update.client,
                keccak256(update.callbackData),
                update.queryHash,
                update.shapeHash,
                update.modelHash,
                update.clientVersion,
                update.expiry,
                update.nonce,
                update.signer
            )
        );

        return keccak256(abi.encode(UPDATE_TYPEHASH, address(this), block.chainid, payloadHash, bidId, autoFlow));
    }

    function _dispatchUpdate(address client, bytes calldata callbackData) internal returns (bool callbackSuccess) {
        try IThassaOracle(client).updateOracle(callbackData) {
            callbackSuccess = true;
        } catch {
            callbackSuccess = false;
        }
    }
}
