// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IThassaHub {
    struct UpdateEnvelope {
        address client;
        bytes callbackData;
        bytes inputData;
        bytes32 responseId;
        bytes32 queryHash;
        bytes32 shapeHash;
        bytes32 modelHash;
        uint64 clientVersion;
        uint64 requestTimestamp;
        address fulfiller;
    }

    struct ProofEnvelope {
        uint8 scheme;
        bytes publicValues;
        bytes proof;
    }

    struct ProofCommitment {
        bool llmFulfilled;
        bytes32 digest;
        uint256 bidId;
        bool autoFlow;
        address client;
        address fulfiller;
        bytes32 queryHash;
        bytes32 shapeHash;
        bytes32 modelHash;
        bytes32 inputDataHash;
        bytes32 responseId;
        uint64 clientVersion;
        uint64 requestTimestamp;
        bytes32 callbackHash;
    }

    struct Bid {
        address requester;
        address client;
        uint256 amount;
        bool isOpen;
        uint256 baseFee;
        uint256 priorityFee;
        uint256 protocolFee;
        uint256 nodeFee;
        address allocatedNode;
        bytes32 inputDataHash;
        bytes32 responseId;
    }

    struct FeeQuote {
        uint256 baseFee;
        uint256 priorityFee;
        uint256 protocolFee;
        uint256 nodeFee;
    }

    struct NodeInfo {
        bool registered;
        bool active;
        bytes32 metadataHash;
        uint256 selfStake;
        uint256 delegatedStake;
        uint256 stakeWeight;
        uint256 fulfilledCount;
        uint256 earnedFees;
    }

    error ZeroAddress();
    error InvalidPaymentTokenDecimals(uint8 decimals);
    error AmountTooLow(uint256 minimum, uint256 provided);
    error AmountIsZero();
    error BidNotOpen(uint256 bidId);
    error NotBidRequester(uint256 bidId, address caller);
    error NotBidAllocator(uint256 bidId, address caller);
    error BidClientMismatch(address expectedClient, address providedClient);
    error AutoFlowFulfillerMismatch(address expectedFulfiller, address caller);
    error BidAllocatedToDifferentNode(uint256 bidId, address allocatedNode, address fulfiller);
    error UpdateTimestampInFuture(uint64 requestTimestamp, uint64 currentTimestamp);
    error AttestationExpired(address client, uint64 requestTimestamp, uint64 currentTimestamp, uint64 maxAge);
    error AttestationWindowTooShort(address client, uint64 providedMaxAge, uint64 minimumMaxAge);
    error OracleCallbackFailed(address client);
    error ClientAlreadyFulfilled(address client);
    error InvalidFulfillmentMarker();
    error UnfulfilledResult(address client);
    error Replay(bytes32 digest);
    error SpecMismatch(address client);
    error InvalidProof(address verifierModule);
    error BidInputDataMismatch(uint256 bidId, bytes32 expectedHash, bytes32 providedHash);
    error BidResponseIdMismatch(uint256 bidId, bytes32 expectedResponseId, bytes32 providedResponseId);
    error NodeAlreadyRegistered(address node);
    error NodeNotRegistered(address node);
    error NodeNotActive(address node);
    error InsufficientStake(address staker, address node, uint256 available, uint256 requested);

    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event ProtocolVaultUpdated(address indexed oldVault, address indexed newVault);
    event VerifierModuleUpdated(address indexed oldVerifierModule, address indexed newVerifierModule);
    event MinimumAttestationAgeUpdated(uint64 oldMinimum, uint64 newMinimum);
    event BidPlaced(uint256 indexed bidId, address indexed requester, address indexed client, uint256 amount);
    event BidFeeConfigured(
        uint256 indexed bidId, uint256 baseFee, uint256 priorityFee, uint256 protocolFee, uint256 nodeFee
    );
    event BidCancelled(uint256 indexed bidId, address indexed requester, uint256 amount);
    event BidAllocated(
        uint256 indexed bidId,
        address indexed allocator,
        address indexed previousNode,
        address newNode,
        uint256 newNodeStakeWeight
    );
    event FeesSettled(
        uint256 indexed bidId,
        address indexed client,
        address indexed node,
        address protocolVault,
        uint256 protocolFee,
        uint256 nodeFee
    );
    event NodeRegistered(address indexed node, bytes32 metadataHash);
    event NodeMetadataUpdated(address indexed node, bytes32 oldMetadataHash, bytes32 newMetadataHash);
    event NodeActiveUpdated(address indexed node, bool active);
    event StakeDelegated(address indexed delegator, address indexed node, uint256 amount);
    event StakeWithdrawn(address indexed delegator, address indexed node, uint256 amount);
    event StakeWeightUpdated(
        address indexed node, uint256 selfStake, uint256 delegatedStake, uint256 stakeWeight, uint256 totalStakeWeight
    );
    event ManualUpdateSubmitted(
        address indexed submitter,
        address indexed client,
        address indexed fulfiller,
        bytes32 digest,
        bool callbackSuccess
    );
    event AutoUpdateSubmitted(
        uint256 indexed bidId,
        address indexed requester,
        address indexed submitter,
        address client,
        address fulfiller,
        bytes32 digest,
        bool callbackSuccess,
        uint256 protocolFee,
        uint256 nodePayout
    );

    function paymentToken() external view returns (address);
    function baseFee() external view returns (uint256);
    function baseProtocolFee() external view returns (uint256);
    function autoFlowLockup() external view returns (uint256);
    function minimumAttestationAge() external view returns (uint64);
    function feeCollector() external view returns (address);
    function protocolVault() external view returns (address);
    function verifierModule() external view returns (address);
    function nextBidId() external view returns (uint256);
    function totalProtocolFeesAccrued() external view returns (uint256);
    function totalNodeFeesAccrued() external view returns (uint256);
    function totalStakeWeight() external view returns (uint256);
    function getBid(uint256 bidId) external view returns (Bid memory);
    function nodeInfo(address node) external view returns (NodeInfo memory);
    function delegatedStake(address delegator, address node) external view returns (uint256);
    function consumedDigests(bytes32 digest) external view returns (bool);
    function quoteFees(uint256 priorityFee) external view returns (FeeQuote memory);
    function quoteBid(uint256 bidAmount) external view returns (FeeQuote memory);

    function setFeeCollector(address newCollector) external;
    function setProtocolVault(address newVault) external;
    function setVerifierModule(address newVerifierModule) external;
    function setMinimumAttestationAge(uint64 newMinimum) external;

    function placeBid(address client, uint256 bidAmount) external returns (uint256 bidId);
    function placeBidWithPriority(address client, uint256 priorityFee) external returns (uint256 bidId);
    function placeBidWithInputData(address client, uint256 bidAmount, bytes calldata inputData)
        external
        returns (uint256 bidId);
    function placeBidWithPriorityAndInputData(address client, uint256 priorityFee, bytes calldata inputData)
        external
        returns (uint256 bidId);
    function placeBidFor(address requester, address client, uint256 bidAmount) external returns (uint256 bidId);
    function placeBidForWithInputData(address requester, address client, uint256 bidAmount, bytes calldata inputData)
        external
        returns (uint256 bidId);
    function cancelBid(uint256 bidId) external;
    function allocateBid(uint256 bidId, address node) external;

    function registerNode(bytes32 metadataHash) external;
    function setNodeMetadata(bytes32 metadataHash) external;
    function setNodeActive(bool active) external;
    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;
    function delegateStake(address node, uint256 amount) external;
    function undelegateStake(address node, uint256 amount) external;

    function submitManualUpdate(UpdateEnvelope calldata update, ProofEnvelope calldata proof) external;
    function submitManualUpdateWithPriority(
        UpdateEnvelope calldata update,
        ProofEnvelope calldata proof,
        uint256 priorityFee
    ) external;
    function submitAutoUpdate(uint256 bidId, UpdateEnvelope calldata update, ProofEnvelope calldata proof) external;

    function computeUpdateDigest(UpdateEnvelope calldata update, uint256 bidId, bool autoFlow)
        external
        view
        returns (bytes32);
}
