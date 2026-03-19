// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IThassaHub {
    struct UpdateEnvelope {
        address client;
        bytes callbackData;
        bytes32 queryHash;
        bytes32 shapeHash;
        bytes32 modelHash;
        uint64 clientVersion;
        uint64 requestTimestamp;
        uint64 expiry;
        uint256 nonce;
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
        uint64 clientVersion;
        uint64 requestTimestamp;
        uint64 expiry;
        uint256 nonce;
        bytes32 callbackHash;
    }

    struct Bid {
        address requester;
        address client;
        uint256 amount;
        bool isOpen;
    }

    error ZeroAddress();
    error InvalidPaymentTokenDecimals(uint8 decimals);
    error AmountTooLow(uint256 minimum, uint256 provided);
    error BidNotOpen(uint256 bidId);
    error NotBidRequester(uint256 bidId, address caller);
    error BidClientMismatch(address expectedClient, address providedClient);
    error AutoFlowFulfillerMismatch(address expectedFulfiller, address caller);
    error UpdateTimestampInFuture(uint64 requestTimestamp, uint64 currentTimestamp);
    error UpdateExpired(uint64 expiry, uint64 currentTimestamp);
    error ClientAlreadyFulfilled(address client);
    error InvalidFulfillmentMarker();
    error UnfulfilledResult(address client);
    error Replay(bytes32 digest);
    error SpecMismatch(address client);
    error InvalidProof(address verifierModule);

    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event VerifierModuleUpdated(address indexed oldVerifierModule, address indexed newVerifierModule);
    event BidPlaced(uint256 indexed bidId, address indexed requester, address indexed client, uint256 amount);
    event BidCancelled(uint256 indexed bidId, address indexed requester, uint256 amount);
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
    function baseProtocolFee() external view returns (uint256);
    function autoFlowLockup() external view returns (uint256);
    function feeCollector() external view returns (address);
    function verifierModule() external view returns (address);
    function nextBidId() external view returns (uint256);
    function getBid(uint256 bidId) external view returns (Bid memory);
    function consumedDigests(bytes32 digest) external view returns (bool);

    function setFeeCollector(address newCollector) external;
    function setVerifierModule(address newVerifierModule) external;

    function placeBid(address client, uint256 bidAmount) external returns (uint256 bidId);
    function cancelBid(uint256 bidId) external;

    function submitManualUpdate(UpdateEnvelope calldata update, ProofEnvelope calldata proof) external;
    function submitAutoUpdate(uint256 bidId, UpdateEnvelope calldata update, ProofEnvelope calldata proof) external;

    function computeUpdateDigest(UpdateEnvelope calldata update, uint256 bidId, bool autoFlow)
        external
        view
        returns (bytes32);
}
