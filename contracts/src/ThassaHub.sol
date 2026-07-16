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
        keccak256("ProofUpdateV2(address hub,uint256 chainId,bytes32 payloadHash,uint256 bidId,bool autoFlow)");
    bytes32 private constant DEFAULT_INPUT_DATA_HASH = keccak256(bytes("{}"));
    bytes32 private constant RESPONSE_ID_TYPEHASH =
        keccak256("ThassaResponseId(address hub,uint256 chainId,uint256 bidId,address requester,address client)");
    uint64 public constant DEFAULT_MINIMUM_ATTESTATION_AGE = 10 minutes;

    IERC20 private immutable _paymentToken;

    uint256 public immutable override baseProtocolFee;
    uint256 public immutable override autoFlowLockup;
    address public override verifierModule;
    uint64 public override minimumAttestationAge = DEFAULT_MINIMUM_ATTESTATION_AGE;
    uint256 public override nextBidId = 1;
    uint256 public override totalProtocolFeesAccrued;
    uint256 public override totalNodeFeesAccrued;
    uint256 public override totalStakeWeight;

    struct NodeRecord {
        bool registered;
        bool active;
        bytes32 metadataHash;
        uint256 selfStake;
        uint256 delegatedStake;
        uint256 fulfilledCount;
        uint256 earnedFees;
    }

    address private _protocolVault;
    mapping(uint256 => Bid) private _bids;
    mapping(address => NodeRecord) private _nodes;
    mapping(address => mapping(address => uint256)) public override delegatedStake;
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
        _protocolVault = feeCollector_;
        verifierModule = verifierModule_;
        baseProtocolFee = oneCent;
        autoFlowLockup = oneCent;
    }

    function paymentToken() external view override returns (address) {
        return address(_paymentToken);
    }

    function baseFee() external view override returns (uint256) {
        return baseProtocolFee;
    }

    function feeCollector() external view override returns (address) {
        return _protocolVault;
    }

    function protocolVault() external view override returns (address) {
        return _protocolVault;
    }

    function getBid(uint256 bidId) external view override returns (Bid memory) {
        return _bids[bidId];
    }

    function nodeInfo(address node) external view override returns (NodeInfo memory info) {
        NodeRecord storage record = _nodes[node];
        info = NodeInfo({
            registered: record.registered,
            active: record.active,
            metadataHash: record.metadataHash,
            selfStake: record.selfStake,
            delegatedStake: record.delegatedStake,
            stakeWeight: record.selfStake + record.delegatedStake,
            fulfilledCount: record.fulfilledCount,
            earnedFees: record.earnedFees
        });
    }

    function quoteFees(uint256 priorityFee) external view override returns (FeeQuote memory) {
        return _quoteFees(priorityFee);
    }

    function quoteBid(uint256 bidAmount) external view override returns (FeeQuote memory) {
        return _quoteBid(bidAmount);
    }

    function setFeeCollector(address newCollector) external override onlyOwner {
        address oldCollector = _setProtocolVault(newCollector);

        emit FeeCollectorUpdated(oldCollector, newCollector);
        emit ProtocolVaultUpdated(oldCollector, newCollector);
    }

    function setProtocolVault(address newVault) external override onlyOwner {
        address oldVault = _setProtocolVault(newVault);

        emit ProtocolVaultUpdated(oldVault, newVault);
        emit FeeCollectorUpdated(oldVault, newVault);
    }

    function setVerifierModule(address newVerifierModule) external override onlyOwner {
        if (newVerifierModule == address(0)) {
            revert ZeroAddress();
        }

        address oldVerifierModule = verifierModule;
        verifierModule = newVerifierModule;

        emit VerifierModuleUpdated(oldVerifierModule, newVerifierModule);
    }

    function setMinimumAttestationAge(uint64 newMinimum) external override onlyOwner {
        uint64 oldMinimum = minimumAttestationAge;
        minimumAttestationAge = newMinimum;

        emit MinimumAttestationAgeUpdated(oldMinimum, newMinimum);
    }

    function placeBid(address client, uint256 bidAmount) external override nonReentrant returns (uint256 bidId) {
        return _placeBid(msg.sender, msg.sender, client, bidAmount, DEFAULT_INPUT_DATA_HASH);
    }

    function placeBidWithPriority(address client, uint256 priorityFee)
        external
        override
        nonReentrant
        returns (uint256 bidId)
    {
        return _placeBid(msg.sender, msg.sender, client, baseProtocolFee + priorityFee, DEFAULT_INPUT_DATA_HASH);
    }

    function placeBidWithInputData(address client, uint256 bidAmount, bytes calldata inputData)
        external
        override
        nonReentrant
        returns (uint256 bidId)
    {
        return _placeBid(msg.sender, msg.sender, client, bidAmount, keccak256(inputData));
    }

    function placeBidWithPriorityAndInputData(address client, uint256 priorityFee, bytes calldata inputData)
        external
        override
        nonReentrant
        returns (uint256 bidId)
    {
        return _placeBid(msg.sender, msg.sender, client, baseProtocolFee + priorityFee, keccak256(inputData));
    }

    function placeBidFor(address requester, address client, uint256 bidAmount)
        external
        override
        nonReentrant
        returns (uint256 bidId)
    {
        if (requester == address(0)) {
            revert ZeroAddress();
        }

        return _placeBid(msg.sender, requester, client, bidAmount, DEFAULT_INPUT_DATA_HASH);
    }

    function placeBidForWithInputData(address requester, address client, uint256 bidAmount, bytes calldata inputData)
        external
        override
        nonReentrant
        returns (uint256 bidId)
    {
        if (requester == address(0)) {
            revert ZeroAddress();
        }

        return _placeBid(msg.sender, requester, client, bidAmount, keccak256(inputData));
    }

    function _placeBid(address payer, address requester, address client, uint256 bidAmount, bytes32 inputDataHash)
        internal
        returns (uint256 bidId)
    {
        if (client == address(0)) {
            revert ZeroAddress();
        }
        FeeQuote memory quote = _quoteBid(bidAmount);

        bidId = nextBidId;
        nextBidId = bidId + 1;
        bytes32 responseId = _deriveResponseId(bidId, requester, client);

        _bids[bidId] = Bid({
            requester: requester,
            client: client,
            amount: bidAmount,
            isOpen: true,
            baseFee: quote.baseFee,
            priorityFee: quote.priorityFee,
            protocolFee: quote.protocolFee,
            nodeFee: quote.nodeFee,
            allocatedNode: address(0),
            inputDataHash: inputDataHash,
            responseId: responseId
        });

        _paymentToken.safeTransferFrom(payer, address(this), bidAmount);

        emit BidPlaced(bidId, requester, client, bidAmount);
        emit BidFeeConfigured(bidId, quote.baseFee, quote.priorityFee, quote.protocolFee, quote.nodeFee);
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

    function allocateBid(uint256 bidId, address node) external override {
        Bid storage bid = _bids[bidId];
        if (!bid.isOpen) {
            revert BidNotOpen(bidId);
        }
        if (msg.sender != bid.requester && msg.sender != owner()) {
            revert NotBidAllocator(bidId, msg.sender);
        }
        if (node != address(0)) {
            _requireActiveNode(node);
        }

        address previousNode = bid.allocatedNode;
        bid.allocatedNode = node;

        emit BidAllocated(bidId, msg.sender, previousNode, node, _stakeWeight(node));
    }

    function registerNode(bytes32 metadataHash) external override {
        NodeRecord storage node = _nodes[msg.sender];
        if (node.registered) {
            revert NodeAlreadyRegistered(msg.sender);
        }

        node.registered = true;
        node.active = true;
        node.metadataHash = metadataHash;

        emit NodeRegistered(msg.sender, metadataHash);
        emit NodeActiveUpdated(msg.sender, true);
    }

    function setNodeMetadata(bytes32 metadataHash) external override {
        NodeRecord storage node = _requireRegisteredNode(msg.sender);
        bytes32 oldMetadataHash = node.metadataHash;
        node.metadataHash = metadataHash;

        emit NodeMetadataUpdated(msg.sender, oldMetadataHash, metadataHash);
    }

    function setNodeActive(bool active) external override {
        NodeRecord storage node = _requireRegisteredNode(msg.sender);
        node.active = active;

        emit NodeActiveUpdated(msg.sender, active);
    }

    function stake(uint256 amount) external override nonReentrant {
        _increaseStake(msg.sender, msg.sender, amount, true);
    }

    function unstake(uint256 amount) external override nonReentrant {
        _decreaseStake(msg.sender, msg.sender, amount, true);
    }

    function delegateStake(address node, uint256 amount) external override nonReentrant {
        _increaseStake(msg.sender, node, amount, msg.sender == node);
    }

    function undelegateStake(address node, uint256 amount) external override nonReentrant {
        _decreaseStake(msg.sender, node, amount, msg.sender == node);
    }

    function submitManualUpdate(UpdateEnvelope calldata update, ProofEnvelope calldata proof)
        external
        override
        nonReentrant
    {
        _submitManualUpdate(update, proof, 0);
    }

    function submitManualUpdateWithPriority(
        UpdateEnvelope calldata update,
        ProofEnvelope calldata proof,
        uint256 priorityFee
    ) external override nonReentrant {
        _submitManualUpdate(update, proof, priorityFee);
    }

    function _submitManualUpdate(UpdateEnvelope calldata update, ProofEnvelope calldata proof, uint256 priorityFee)
        internal
    {
        bytes32 digest = _validateAndConsumeUpdate(update, proof, 0, false);
        FeeQuote memory quote = _quoteFees(priorityFee);

        _settleFeesFromPayer(0, msg.sender, update.client, update.fulfiller, quote);

        bool callbackSuccess = _dispatchUpdate(update.client, update.callbackData);
        if (!callbackSuccess) {
            revert OracleCallbackFailed(update.client);
        }

        emit ManualUpdateSubmitted(msg.sender, update.client, update.fulfiller, digest, callbackSuccess);
    }

    function submitAutoUpdate(uint256 bidId, UpdateEnvelope calldata update, ProofEnvelope calldata proof)
        external
        override
        nonReentrant
    {
        Bid storage bid = _bids[bidId];
        if (!bid.isOpen) {
            revert BidNotOpen(bidId);
        }
        if (bid.client != update.client) {
            revert BidClientMismatch(bid.client, update.client);
        }
        if (msg.sender != update.fulfiller) {
            revert AutoFlowFulfillerMismatch(update.fulfiller, msg.sender);
        }
        if (bid.allocatedNode != address(0) && bid.allocatedNode != update.fulfiller) {
            revert BidAllocatedToDifferentNode(bidId, bid.allocatedNode, update.fulfiller);
        }
        if (bid.allocatedNode != address(0)) {
            _requireActiveNode(bid.allocatedNode);
        }
        bytes32 providedInputDataHash = keccak256(update.inputData);
        if (providedInputDataHash != bid.inputDataHash) {
            revert BidInputDataMismatch(bidId, bid.inputDataHash, providedInputDataHash);
        }
        if (update.responseId != bid.responseId) {
            revert BidResponseIdMismatch(bidId, bid.responseId, update.responseId);
        }

        _paymentToken.safeTransferFrom(msg.sender, address(this), autoFlowLockup);

        bytes32 digest = _validateAndConsumeUpdate(update, proof, bidId, true);
        bid.isOpen = false;

        bool callbackSuccess = _dispatchUpdate(update.client, update.callbackData);
        if (!callbackSuccess) {
            revert OracleCallbackFailed(update.client);
        }

        uint256 nodePayout = bid.nodeFee;

        _settleFeesFromHub(bidId, update.client, update.fulfiller, bid.protocolFee, nodePayout);
        if (nodePayout > 0) {
            _paymentToken.safeTransfer(update.fulfiller, nodePayout);
        }
        _paymentToken.safeTransfer(update.fulfiller, autoFlowLockup);

        emit AutoUpdateSubmitted(
            bidId,
            bid.requester,
            msg.sender,
            update.client,
            update.fulfiller,
            digest,
            callbackSuccess,
            bid.protocolFee,
            nodePayout
        );
    }

    function computeUpdateDigest(UpdateEnvelope calldata update, uint256 bidId, bool autoFlow)
        external
        view
        override
        returns (bytes32)
    {
        return _computeUpdateDigest(update, bidId, autoFlow);
    }

    function _validateAndConsumeUpdate(
        UpdateEnvelope calldata update,
        ProofEnvelope calldata proof,
        uint256 bidId,
        bool autoFlow
    ) internal returns (bytes32 digest) {
        if (update.client == address(0) || update.fulfiller == address(0)) {
            revert ZeroAddress();
        }
        if (update.requestTimestamp > uint64(block.timestamp)) {
            revert UpdateTimestampInFuture(update.requestTimestamp, uint64(block.timestamp));
        }

        _validateOracleSpec(update);
        _validateAttestationWindow(update);
        _requireFulfilledResult(update.client, proof.publicValues);

        digest = _computeUpdateDigest(update, bidId, autoFlow);
        if (consumedDigests[digest]) {
            revert Replay(digest);
        }

        bool isValidProof = IThassaVerifier(verifierModule).verifyUpdate(digest, bidId, autoFlow, update, proof);
        if (!isValidProof) {
            revert InvalidProof(verifierModule);
        }

        consumedDigests[digest] = true;
    }

    function _validateOracleSpec(UpdateEnvelope calldata update) internal view {
        IThassaOracle.OracleSpec memory spec = IThassaOracle(update.client).oracleSpec();

        bool matchesSpec = keccak256(bytes(spec.query)) == update.queryHash
            && keccak256(bytes(spec.expectedShape)) == update.shapeHash
            && keccak256(bytes(spec.model)) == update.modelHash && spec.clientVersion == update.clientVersion;

        if (!matchesSpec) {
            revert SpecMismatch(update.client);
        }
    }

    function _validateAttestationWindow(UpdateEnvelope calldata update) internal view {
        uint64 maxAge = IThassaOracle(update.client).maxAttestationAge();
        uint64 minimumAge = minimumAttestationAge;
        if (maxAge < minimumAge) {
            revert AttestationWindowTooShort(update.client, maxAge, minimumAge);
        }

        if (uint256(update.requestTimestamp) + uint256(maxAge) < block.timestamp) {
            revert AttestationExpired(update.client, update.requestTimestamp, uint64(block.timestamp), maxAge);
        }
    }

    function _requireFulfilledResult(address client, bytes calldata publicValues) internal pure {
        if (publicValues.length < 32) {
            revert InvalidFulfillmentMarker();
        }

        uint256 markerWord;
        assembly {
            markerWord := calldataload(publicValues.offset)
        }

        if (markerWord > 1) {
            revert InvalidFulfillmentMarker();
        }
        if (markerWord == 0) {
            revert UnfulfilledResult(client);
        }
    }

    function _computeUpdateDigest(UpdateEnvelope calldata update, uint256 bidId, bool autoFlow)
        internal
        view
        returns (bytes32)
    {
        bytes32 payloadHash = keccak256(
            abi.encode(
                update.client,
                keccak256(update.callbackData),
                keccak256(update.inputData),
                update.responseId,
                update.queryHash,
                update.shapeHash,
                update.modelHash,
                update.clientVersion,
                update.requestTimestamp,
                update.fulfiller
            )
        );

        return keccak256(abi.encode(UPDATE_TYPEHASH, address(this), block.chainid, payloadHash, bidId, autoFlow));
    }

    function _deriveResponseId(uint256 bidId, address requester, address client) internal view returns (bytes32) {
        return keccak256(abi.encode(RESPONSE_ID_TYPEHASH, address(this), block.chainid, bidId, requester, client));
    }

    function _dispatchUpdate(address client, bytes calldata callbackData) internal returns (bool callbackSuccess) {
        try IThassaOracle(client).updateOracle(callbackData) {
            callbackSuccess = true;
        } catch {
            callbackSuccess = false;
        }
    }

    function _setProtocolVault(address newVault) internal returns (address oldVault) {
        if (newVault == address(0)) {
            revert ZeroAddress();
        }

        oldVault = _protocolVault;
        _protocolVault = newVault;
    }

    function _quoteBid(uint256 bidAmount) internal view returns (FeeQuote memory quote) {
        if (bidAmount < baseProtocolFee) {
            revert AmountTooLow(baseProtocolFee, bidAmount);
        }

        quote = _quoteFees(bidAmount - baseProtocolFee);
    }

    function _quoteFees(uint256 priorityFee) internal view returns (FeeQuote memory quote) {
        uint256 protocolBaseFee = baseProtocolFee / 2;
        uint256 nodeBaseFee = baseProtocolFee - protocolBaseFee;
        uint256 protocolPriorityFee = priorityFee / 2;
        uint256 nodePriorityFee = priorityFee - protocolPriorityFee;

        quote = FeeQuote({
            baseFee: baseProtocolFee,
            priorityFee: priorityFee,
            protocolFee: protocolBaseFee + protocolPriorityFee,
            nodeFee: nodeBaseFee + nodePriorityFee
        });
    }

    function _settleFeesFromPayer(uint256 bidId, address payer, address client, address node, FeeQuote memory quote)
        internal
    {
        if (quote.protocolFee > 0) {
            _paymentToken.safeTransferFrom(payer, _protocolVault, quote.protocolFee);
        }
        if (quote.nodeFee > 0) {
            _paymentToken.safeTransferFrom(payer, node, quote.nodeFee);
        }

        _recordFeeSettlement(bidId, client, node, quote.protocolFee, quote.nodeFee);
    }

    function _settleFeesFromHub(uint256 bidId, address client, address node, uint256 protocolFee, uint256 nodeFee)
        internal
    {
        if (protocolFee > 0) {
            _paymentToken.safeTransfer(_protocolVault, protocolFee);
        }

        _recordFeeSettlement(bidId, client, node, protocolFee, nodeFee);
    }

    function _recordFeeSettlement(uint256 bidId, address client, address node, uint256 protocolFee, uint256 nodeFee)
        internal
    {
        totalProtocolFeesAccrued += protocolFee;
        totalNodeFeesAccrued += nodeFee;

        NodeRecord storage nodeRecord = _nodes[node];
        if (nodeRecord.registered) {
            nodeRecord.fulfilledCount += 1;
            nodeRecord.earnedFees += nodeFee;
        }

        emit FeesSettled(bidId, client, node, _protocolVault, protocolFee, nodeFee);
    }

    function _increaseStake(address delegator, address nodeAddress, uint256 amount, bool selfStake) internal {
        if (amount == 0) {
            revert AmountIsZero();
        }
        if (nodeAddress == address(0)) {
            revert ZeroAddress();
        }

        NodeRecord storage node = _nodes[nodeAddress];
        if (!node.registered) {
            revert NodeNotRegistered(nodeAddress);
        }
        if (!selfStake && !node.active) {
            revert NodeNotActive(nodeAddress);
        }

        if (selfStake) {
            node.selfStake += amount;
        } else {
            delegatedStake[delegator][nodeAddress] += amount;
            node.delegatedStake += amount;
        }
        totalStakeWeight += amount;

        _paymentToken.safeTransferFrom(delegator, address(this), amount);

        emit StakeDelegated(delegator, nodeAddress, amount);
        _emitStakeWeightUpdated(nodeAddress);
    }

    function _decreaseStake(address delegator, address nodeAddress, uint256 amount, bool selfStake) internal {
        if (amount == 0) {
            revert AmountIsZero();
        }
        if (nodeAddress == address(0)) {
            revert ZeroAddress();
        }

        NodeRecord storage node = _requireRegisteredNode(nodeAddress);
        uint256 available;
        if (selfStake) {
            available = node.selfStake;
            if (available < amount) {
                revert InsufficientStake(delegator, nodeAddress, available, amount);
            }
            node.selfStake = available - amount;
        } else {
            available = delegatedStake[delegator][nodeAddress];
            if (available < amount) {
                revert InsufficientStake(delegator, nodeAddress, available, amount);
            }
            delegatedStake[delegator][nodeAddress] = available - amount;
            node.delegatedStake -= amount;
        }
        totalStakeWeight -= amount;

        _paymentToken.safeTransfer(delegator, amount);

        emit StakeWithdrawn(delegator, nodeAddress, amount);
        _emitStakeWeightUpdated(nodeAddress);
    }

    function _requireRegisteredNode(address nodeAddress) internal view returns (NodeRecord storage node) {
        node = _nodes[nodeAddress];
        if (!node.registered) {
            revert NodeNotRegistered(nodeAddress);
        }
    }

    function _requireActiveNode(address nodeAddress) internal view returns (NodeRecord storage node) {
        node = _requireRegisteredNode(nodeAddress);
        if (!node.active) {
            revert NodeNotActive(nodeAddress);
        }
    }

    function _stakeWeight(address nodeAddress) internal view returns (uint256) {
        NodeRecord storage node = _nodes[nodeAddress];
        return node.selfStake + node.delegatedStake;
    }

    function _emitStakeWeightUpdated(address nodeAddress) internal {
        NodeRecord storage node = _nodes[nodeAddress];
        emit StakeWeightUpdated(
            nodeAddress, node.selfStake, node.delegatedStake, node.selfStake + node.delegatedStake, totalStakeWeight
        );
    }
}
