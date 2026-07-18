// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pinned external surface of the Thassa prediction-market contract (spec section 9).
///         All platform components (backend, web, mobile) code against this interface.
interface IThassaMarkets {
    /// @notice 0 = YES, 1 = NO.
    enum Side {
        YES,
        NO
    }

    /// @notice EIP-712 signed order for the relayer path.
    ///         Typed data: Order(uint256 marketId,uint8 side,uint8 price,uint80 shares,uint256 maxCost,
    ///         uint256 affiliatePostId,uint64 expiry,uint256 nonce,address maker) under the domain
    ///         {name:"ThassaMarkets", version:"1", chainId, verifyingContract}.
    ///         The maker's signature is carried by the paired `Auth3009`: its `authNonce` MUST equal the
    ///         EIP-712 typed-data digest of the order, so the maker's single EIP-3009 signature commits to
    ///         both the payment and the exact order contents.
    struct SignedOrder {
        uint256 marketId;
        uint8 side; // Side
        uint8 price; // cents, 1..99 (limit price the maker pays per share)
        uint80 shares; // number of $1 shares
        uint256 maxCost; // token units the signer authorizes at most (escrow + fee headroom)
        uint256 affiliatePostId; // 0 = none
        uint64 expiry; // unix seconds
        uint256 nonce; // per-maker sequential
        address maker;
    }

    /// @notice receiveWithAuthorization payload; from = order.maker, to = the markets contract.
    struct Auth3009 {
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 authNonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Market lifecycle record. status: 0 PENDING (unused onchain), 1 OPEN, 2 MATCHED,
    ///         3 SETTLING, 4 SETTLED, 5 VOID.
    struct Market {
        address creator;
        uint64 createdAt;
        uint8 status;
        bool settled; // oracle attachment: settlement recorded
        bool direction; // oracle attachment: true = YES outcome
        uint256 pendingBidId; // hub bid id while SETTLING
        uint256 creatorFeesAccrued; // claimable by creator
        uint256 volumeMatched; // stats, in token units
    }

    error UnknownMarket(uint256 marketId);
    error MarketNotTradeable(uint256 marketId, uint8 status);
    error MarketNotSettleable(uint256 marketId, uint8 status);
    error MarketNotSettling(uint256 marketId);
    error MarketNotRedeemable(uint256 marketId, uint8 status);
    error MarketNotVoidable(uint256 marketId, uint8 status);
    error MarketNotExpired(uint256 marketId);
    error MarketOutcomeNotDeterminable(uint256 marketId);
    error SettlementAlreadyPending(uint256 marketId, uint256 bidId);
    error InvalidSide(uint8 side);
    error InvalidPrice(uint8 price);
    error InvalidShares(uint80 shares);
    error InitialOrderTooSmall(uint256 escrow, uint256 minimumEscrow);
    error InitialOrderMarketMismatch(uint256 expectedMarketId, uint256 providedMarketId);
    error OrderExpired(uint64 expiry, uint64 currentTimestamp);
    error InvalidOrderNonce(address maker, uint256 expectedNonce, uint256 providedNonce);
    error InvalidAuthBinding(bytes32 expectedAuthNonce, bytes32 providedAuthNonce);
    error MaxCostExceeded(uint256 required, uint256 maxCost);
    error InsufficientFreeBalance(address account, uint256 available, uint256 required);
    error BatchLengthMismatch(uint256 ordersLength, uint256 authsLength);
    error NotOrderMaker(uint256 orderId, address caller);
    error NothingToCancel(uint256 orderId);
    error NothingToRedeem(uint256 marketId, address account);
    error NothingToClaim();
    error AmountTooLowForWithdrawalFee(uint256 amount, uint256 withdrawalFlatFee);
    error NotMarketCreator(uint256 marketId, address caller);
    error NotAffiliatePayee(uint256 postId, address caller);
    error NotPlatformRole(address caller);
    error ZeroAddress();
    error InvalidOrderId(uint256 orderId);
    error FeeBpsTooHigh(uint16 bps);

    event MarketCreated(uint256 indexed marketId, address indexed creator, string question, string settlementQuery);
    event OrderPlaced(
        uint256 indexed marketId, uint256 indexed orderId, address indexed maker, uint8 side, uint8 price, uint80 shares
    );
    event OrderMatched(
        uint256 indexed marketId, uint256 takerOrderId, uint256 makerOrderId, uint8 price, uint80 shares, uint256 fee
    );
    event OrderCancelled(uint256 indexed marketId, uint256 indexed orderId);
    event MarketMatched(uint256 indexed marketId); // first fill vs creator's opening order
    event SettlementRequested(uint256 indexed marketId, uint256 bidId, address indexed caller);
    event MarketSettled(uint256 indexed marketId, bool direction);
    event OrderRejected(uint256 indexed marketId, address indexed maker, bytes32 reason);
    event MarketVoided(uint256 indexed marketId);
    event Redeemed(uint256 indexed marketId, address indexed account, uint256 shares, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount, uint256 fee);
    event CreatorFeesClaimed(uint256 indexed marketId, address indexed creator, uint256 amount);
    event AffiliateFeesClaimed(uint256 indexed postId, address indexed payee, uint256 amount);
    event AffiliatePostRegistered(uint256 indexed postId, address indexed payee);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);

    // --- Pinned mutating surface (spec section 9) ---

    function createMarket(
        string calldata question,
        string calldata settlementQuery,
        SignedOrder calldata initialOrder,
        Auth3009 calldata auth
    ) external returns (uint256 marketId); // relayer path

    function createMarketDirect(
        string calldata question,
        string calldata settlementQuery,
        uint8 side,
        uint8 price,
        uint80 shares
    ) external returns (uint256 marketId); // transferFrom path

    function placeOrdersBatch(SignedOrder[] calldata orders, Auth3009[] calldata auths) external; // relayer bundle

    function placeOrder(uint256 marketId, uint8 side, uint8 price, uint80 shares, uint256 affiliatePostId)
        external
        returns (uint256 orderId); // direct path

    function cancelOrder(uint256 marketId, uint256 orderId) external;
    function settleMarket(uint256 marketId) external; // pulls $0.05 via transferFrom
    function redeem(uint256 marketId) external; // winner claims, minus withdrawal fee
    function withdraw(uint256 amount) external; // free balance out, minus withdrawal fee
    function claimCreatorFees(uint256 marketId) external;
    function claimAffiliateFees(uint256 postId) external;
    function registerAffiliatePost(uint256 postId, address payee) external; // platform role

    // --- Pinned views (spec section 9) ---

    function getMarket(uint256 marketId) external view returns (Market memory);
    function bestPrices(uint256 marketId) external view returns (uint8 bestYes, uint8 bestNo);
    function nonces(address maker) external view returns (uint256);

    // --- Supplementary views ---

    function marketQuestion(uint256 marketId) external view returns (string memory);
    function marketSettlementQuery(uint256 marketId) external view returns (string memory);
    function bidInputData(uint256 bidId) external view returns (bytes memory);
    function orderDigest(SignedOrder calldata order) external view returns (bytes32);
    function getOrder(uint256 marketId, uint256 orderId)
        external
        view
        returns (address maker, uint8 side, uint8 price, uint80 sharesRemaining);
    function positionOf(uint256 marketId, address account, uint8 side)
        external
        view
        returns (uint128 shares, uint128 costBasis);
    function freeBalance(address account) external view returns (uint256);
}
