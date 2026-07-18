// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaMarkets} from "../interfaces/IThassaMarkets.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {ThassaHub} from "../src/ThassaHub.sol";
import {ThassaMarkets} from "../src/markets/ThassaMarkets.sol";
import {ThassaPoAVerifier} from "../src/ThassaPoAVerifier.sol";

contract ThassaMarketsTest is Test {
    using MessageHashUtils for bytes32;

    uint256 private constant POA_PRIVATE_KEY = 0xA11CE;
    uint256 private constant MAKER_A_PRIVATE_KEY = 0xAAA1;
    uint256 private constant MAKER_B_PRIVATE_KEY = 0xBBB1;

    uint256 private constant UNIT = 1e6; // 6-decimal dollar unit
    uint256 private constant CENT = 1e4;

    string private constant MODEL = "openai:gpt-5.4";
    string private constant QUESTION = "Will it rain in San Francisco tomorrow?";
    string private constant SETTLEMENT_QUERY =
        "Did measurable precipitation (>= 0.01 in) fall at station KSFO on 2026-07-17 UTC per NWS records?";

    address private feeCollector = makeAddr("feeCollector");
    address private platformRole = makeAddr("platformRole");
    address private creator = makeAddr("creator");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");
    address private carol = makeAddr("carol");
    address private relayer = makeAddr("relayer");
    address private poaSigner = vm.addr(POA_PRIVATE_KEY);
    address private makerA = vm.addr(MAKER_A_PRIVATE_KEY);
    address private makerB = vm.addr(MAKER_B_PRIVATE_KEY);

    MockUSD private token;
    ThassaPoAVerifier private verifier;
    ThassaHub private hub;
    ThassaMarkets private markets;

    function setUp() public {
        token = new MockUSD();

        address[] memory signers = new address[](1);
        signers[0] = poaSigner;
        verifier = new ThassaPoAVerifier(address(this), signers);

        hub = new ThassaHub(address(token), feeCollector, address(verifier));
        markets = new ThassaMarkets(address(hub), MODEL, 1, platformRole);

        address[7] memory funded = [creator, alice, bob, carol, relayer, poaSigner, makerA];
        for (uint256 i = 0; i < funded.length; i++) {
            token.mint(funded[i], 1_000_000 * UNIT);
        }
        token.mint(makerB, 1_000_000 * UNIT);

        vm.prank(creator);
        token.approve(address(markets), type(uint256).max);
        vm.prank(alice);
        token.approve(address(markets), type(uint256).max);
        vm.prank(bob);
        token.approve(address(markets), type(uint256).max);
        vm.prank(carol);
        token.approve(address(markets), type(uint256).max);
        vm.prank(poaSigner);
        token.approve(address(hub), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Market creation
    // ------------------------------------------------------------------

    function test_CreateMarketDirect_RequiresOneDollarInitialEscrow() public {
        // 9 shares @ 11c = $0.99 < $1.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InitialOrderTooSmall.selector, 99 * CENT, UNIT));
        markets.createMarketDirect(QUESTION, SETTLEMENT_QUERY, uint8(IThassaMarkets.Side.NO), 11, 9);

        // Exactly $1 passes.
        vm.prank(creator);
        uint256 marketId = markets.createMarketDirect(QUESTION, SETTLEMENT_QUERY, uint8(IThassaMarkets.Side.NO), 10, 10);
        assertEq(marketId, 1);
    }

    function test_CreateMarketDirect_IsFeeFree_AndStoresState() public {
        uint256 creatorBalanceBefore = token.balanceOf(creator);

        vm.prank(creator);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.MarketCreated(1, creator, QUESTION, SETTLEMENT_QUERY);
        uint256 marketId = markets.createMarketDirect(QUESTION, SETTLEMENT_QUERY, uint8(IThassaMarkets.Side.NO), 40, 100);

        // Creation charges the order escrow only: no protocol fee.
        assertEq(creatorBalanceBefore - token.balanceOf(creator), 40 * 100 * CENT);
        assertEq(markets.protocolFeesAccrued(), 0);

        IThassaMarkets.Market memory market = markets.getMarket(marketId);
        assertEq(market.creator, creator);
        assertEq(market.createdAt, uint64(block.timestamp));
        assertEq(market.status, markets.STATUS_OPEN());
        assertFalse(market.settled);
        assertEq(market.volumeMatched, 0);

        assertEq(markets.marketQuestion(marketId), QUESTION);
        assertEq(markets.marketSettlementQuery(marketId), SETTLEMENT_QUERY);

        (uint8 bestYes, uint8 bestNo) = markets.bestPrices(marketId);
        assertEq(bestYes, 0);
        assertEq(bestNo, 40);

        (address maker,, uint8 price, uint80 sharesRemaining) =
            markets.getOrder(marketId, markets.openingOrderId(marketId));
        assertEq(maker, creator);
        assertEq(price, 40);
        assertEq(sharesRemaining, 100);
    }

    function test_CreateMarket_RelayerPath_WithSignedOrderAndAuth() public {
        uint256 expectedMarketId = markets.nextMarketId();
        uint256 escrow = 50 * 30 * CENT; // $15

        // Cross-component convention: the opening order is signed with marketId = 0.
        IThassaMarkets.SignedOrder memory order =
            _buildSignedOrder(0, uint8(IThassaMarkets.Side.YES), 50, 30, escrow + 5 * UNIT, 0, makerA);
        // Over-funded auth: surplus must land in the maker's free balance.
        IThassaMarkets.Auth3009 memory auth = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, order, escrow + 2 * UNIT);

        uint256 makerBalanceBefore = token.balanceOf(makerA);

        vm.prank(relayer);
        uint256 marketId = markets.createMarket(QUESTION, SETTLEMENT_QUERY, order, auth);

        assertEq(marketId, expectedMarketId);
        assertEq(markets.getMarket(marketId).creator, makerA);
        assertEq(markets.getMarket(marketId).status, markets.STATUS_OPEN());
        assertEq(markets.nonces(makerA), 1);
        assertEq(token.balanceOf(makerA), makerBalanceBefore - escrow - 2 * UNIT);
        assertEq(markets.freeBalance(makerA), 2 * UNIT);

        (uint8 bestYes,) = markets.bestPrices(marketId);
        assertEq(bestYes, 50);
    }

    function test_CreateMarket_RelayerPath_RejectsWrongMarketIdOrSmallEscrow() public {
        IThassaMarkets.SignedOrder memory order =
            _buildSignedOrder(99, uint8(IThassaMarkets.Side.YES), 50, 30, 20 * UNIT, 0, makerA);
        IThassaMarkets.Auth3009 memory auth = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, order, 15 * UNIT);

        // Opening orders must be signed with marketId = 0.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InitialOrderMarketMismatch.selector, 0, 99));
        markets.createMarket(QUESTION, SETTLEMENT_QUERY, order, auth);

        // $0.99 initial order.
        order = _buildSignedOrder(0, uint8(IThassaMarkets.Side.YES), 33, 3, 20 * UNIT, 0, makerA);
        auth = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, order, UNIT);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InitialOrderTooSmall.selector, 99 * CENT, UNIT));
        markets.createMarket(QUESTION, SETTLEMENT_QUERY, order, auth);
    }

    // ------------------------------------------------------------------
    // Direct order placement and matching
    // ------------------------------------------------------------------

    function test_PlaceOrder_RestsWhenNothingCrosses() public {
        uint256 marketId = _createDefaultMarket(); // creator NO @ 40 x 100

        // YES @ 55 does not cross NO @ 40 (55 + 40 < 100).
        vm.prank(alice);
        uint256 orderId = markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 55, 20, 0);

        (address maker,,, uint80 remaining) = markets.getOrder(marketId, orderId);
        assertEq(maker, alice);
        assertEq(remaining, 20);

        (uint8 bestYes, uint8 bestNo) = markets.bestPrices(marketId);
        assertEq(bestYes, 55);
        assertEq(bestNo, 40);
    }

    function test_PlaceOrder_MatchesAcrossLevels_AtMakerImpliedPrice() public {
        uint256 marketId = _createDefaultMarket(); // creator NO @ 40 x 100

        vm.prank(alice);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.NO), 45, 50, 0);

        uint256 bobBalanceBefore = token.balanceOf(bob);

        // YES @ 60 x 120 crosses NO >= 40. Best maker level first: NO 45 => exec 55,
        // then NO 40 => exec 60. 50 + 70 fills, nothing rests.
        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 120, 0);

        uint256 fee55 = _takerFee(50, 55);
        uint256 fee60 = _takerFee(70, 60);
        assertEq(fee55, 866_250); // ceil(700 * 50 * 55 * 45 * 1e6 / 1e8)
        assertEq(fee60, 1_176_000);

        uint256 expectedCost = 55 * 50 * CENT + 60 * 70 * CENT + fee55 + fee60;
        assertEq(bobBalanceBefore - token.balanceOf(bob), expectedCost);

        (uint128 bobYesShares,) = markets.positionOf(marketId, bob, uint8(IThassaMarkets.Side.YES));
        (uint128 aliceNoShares,) = markets.positionOf(marketId, alice, uint8(IThassaMarkets.Side.NO));
        (uint128 creatorNoShares,) = markets.positionOf(marketId, creator, uint8(IThassaMarkets.Side.NO));
        assertEq(bobYesShares, 120);
        assertEq(aliceNoShares, 50);
        assertEq(creatorNoShares, 70);

        // Creator has 30 unfilled shares resting at 40; the 45 level is drained.
        (uint8 bestYes, uint8 bestNo) = markets.bestPrices(marketId);
        assertEq(bestYes, 0);
        assertEq(bestNo, 40);

        IThassaMarkets.Market memory market = markets.getMarket(marketId);
        assertEq(market.status, markets.STATUS_MATCHED());
        assertEq(market.volumeMatched, 120 * UNIT);
    }

    function test_PlaceOrder_PriceTimePriority_FIFOWithinLevel() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(alice);
        uint256 aliceOrderId = markets.placeOrder(marketId, uint8(IThassaMarkets.Side.NO), 45, 50, 0);
        vm.prank(carol);
        uint256 carolOrderId = markets.placeOrder(marketId, uint8(IThassaMarkets.Side.NO), 45, 30, 0);

        // Taker consumes alice fully (first in), then 10 of carol.
        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 55, 60, 0);

        (,,, uint80 aliceRemaining) = markets.getOrder(marketId, aliceOrderId);
        (,,, uint80 carolRemaining) = markets.getOrder(marketId, carolOrderId);
        assertEq(aliceRemaining, 0);
        assertEq(carolRemaining, 20);
    }

    function test_PlaceOrder_PartialFill_RestsRemainderAtLimit() public {
        uint256 marketId = _createDefaultMarket(); // NO @ 40 x 100

        uint256 bobBalanceBefore = token.balanceOf(bob);

        vm.prank(bob);
        uint256 orderId = markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 62, 150, 0);

        // 100 filled at exec 60, 50 rest at 62.
        (,,, uint80 remaining) = markets.getOrder(marketId, orderId);
        assertEq(remaining, 50);

        uint256 expectedCost = 60 * 100 * CENT + _takerFee(100, 60) + 62 * 50 * CENT;
        assertEq(bobBalanceBefore - token.balanceOf(bob), expectedCost);

        (uint8 bestYes, uint8 bestNo) = markets.bestPrices(marketId);
        assertEq(bestYes, 62);
        assertEq(bestNo, 0);
    }

    function test_PlaceOrder_EmitsMarketMatchedOnFirstCreatorFill() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit IThassaMarkets.MarketMatched(marketId);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 0);

        assertEq(markets.getMarket(marketId).status, markets.STATUS_MATCHED());

        // Second fill against the creator does not re-emit (status already MATCHED).
        vm.recordLogs();
        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != IThassaMarkets.MarketMatched.selector);
        }
    }

    function test_PlaceOrder_RevertsOnBadParamsOrUnknownMarket() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.UnknownMarket.selector, 42));
        markets.placeOrder(42, 0, 50, 10, 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InvalidPrice.selector, 100));
        markets.placeOrder(marketId, 0, 100, 10, 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InvalidPrice.selector, 0));
        markets.placeOrder(marketId, 0, 0, 10, 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InvalidSide.selector, 2));
        markets.placeOrder(marketId, 2, 50, 10, 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InvalidShares.selector, 0));
        markets.placeOrder(marketId, 0, 50, 0, 0);
    }

    // ------------------------------------------------------------------
    // Taker-fee math and splits
    // ------------------------------------------------------------------

    function test_TakerFee_RoundsUp() public {
        // 703 bps makes the fee non-integral: ceil(703 * 1 * 33 * 67 * 1e6 / 1e8) = 15544.
        markets.setTakerFeeBps(703);

        vm.prank(creator);
        uint256 marketId = markets.createMarketDirect(QUESTION, SETTLEMENT_QUERY, uint8(IThassaMarkets.Side.NO), 67, 3);

        uint256 bobBalanceBefore = token.balanceOf(bob);

        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 33, 1, 0);

        uint256 exactTimes100 = 703 * 1 * 33 * 67; // fee * 100 in token units for a 6-decimal token
        assertEq(exactTimes100 % 100 != 0, true);
        uint256 expectedFee = exactTimes100 / 100 + 1; // 15544, rounded up
        assertEq(bobBalanceBefore - token.balanceOf(bob), 33 * CENT + expectedFee);
    }

    function test_FeeSplits_CreatorAffiliateProtocol() public {
        uint256 marketId = _createDefaultMarket(); // NO @ 40 x 100

        vm.prank(platformRole);
        markets.registerAffiliatePost(777, carol);

        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 50, 777);

        uint256 fee = _takerFee(50, 60);
        uint256 creatorShare = (fee * 1000) / 10000;
        uint256 affiliateShare = (fee * 1000) / 10000;
        uint256 protocolShare = fee - creatorShare - affiliateShare;

        assertEq(markets.getMarket(marketId).creatorFeesAccrued, creatorShare);
        assertEq(markets.affiliateFeesAccrued(777), affiliateShare);
        assertEq(markets.protocolFeesAccrued(), protocolShare);

        // Claims transfer the accruals out.
        uint256 creatorBalanceBefore = token.balanceOf(creator);
        vm.prank(creator);
        markets.claimCreatorFees(marketId);
        assertEq(token.balanceOf(creator) - creatorBalanceBefore, creatorShare);
        assertEq(markets.getMarket(marketId).creatorFeesAccrued, 0);

        uint256 carolBalanceBefore = token.balanceOf(carol);
        vm.prank(carol);
        markets.claimAffiliateFees(777);
        assertEq(token.balanceOf(carol) - carolBalanceBefore, affiliateShare);

        uint256 collectorBalanceBefore = token.balanceOf(feeCollector);
        markets.withdrawProtocolFees(feeCollector);
        assertEq(token.balanceOf(feeCollector) - collectorBalanceBefore, protocolShare);
    }

    function test_FeeSplits_UnregisteredAffiliateGoesToProtocol() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 50, 999); // 999 never registered

        uint256 fee = _takerFee(50, 60);
        uint256 creatorShare = (fee * 1000) / 10000;
        assertEq(markets.affiliateFeesAccrued(999), 0);
        assertEq(markets.protocolFeesAccrued(), fee - creatorShare);
    }

    function test_RegisterAffiliatePost_GatedToPlatformRoleOrOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.NotPlatformRole.selector, alice));
        markets.registerAffiliatePost(1, alice);

        // Owner (this test contract) and platform role both may register.
        markets.registerAffiliatePost(1, alice);
        vm.prank(platformRole);
        markets.registerAffiliatePost(2, bob);
        assertEq(markets.affiliatePayee(1), alice);
        assertEq(markets.affiliatePayee(2), bob);
    }

    // ------------------------------------------------------------------
    // Cancel / withdraw
    // ------------------------------------------------------------------

    function test_CancelOrder_RefundsToFreeBalance_WithdrawTakesFlatFee() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(alice);
        uint256 orderId = markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 55, 20, 0);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.OrderCancelled(marketId, orderId);
        markets.cancelOrder(marketId, orderId);

        uint256 refund = 55 * 20 * CENT;
        assertEq(markets.freeBalance(alice), refund);

        (uint8 bestYes,) = markets.bestPrices(marketId);
        assertEq(bestYes, 0);

        // Cancelled orders cannot match afterwards nor be cancelled twice.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.NothingToCancel.selector, orderId));
        markets.cancelOrder(marketId, orderId);

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        vm.prank(alice);
        markets.withdraw(refund);
        assertEq(token.balanceOf(alice) - aliceBalanceBefore, refund - 10 * CENT);
        assertEq(markets.freeBalance(alice), 0);
        assertEq(markets.protocolFeesAccrued(), 10 * CENT);
    }

    function test_CancelOrder_OnlyMaker() public {
        uint256 marketId = _createDefaultMarket();
        uint256 openingOrderId = markets.openingOrderId(marketId);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.NotOrderMaker.selector, openingOrderId, bob));
        markets.cancelOrder(marketId, openingOrderId);
    }

    function test_Withdraw_RequiresBalanceAndMoreThanFee() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.AmountTooLowForWithdrawalFee.selector, 5 * CENT, 10 * CENT));
        markets.withdraw(5 * CENT);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.InsufficientFreeBalance.selector, alice, 0, UNIT));
        markets.withdraw(UNIT);
    }

    // ------------------------------------------------------------------
    // Relayer batch path
    // ------------------------------------------------------------------

    function test_PlaceOrdersBatch_SignedAndFundedViaEIP3009() public {
        uint256 marketId = _createDefaultMarket(); // creator NO @ 40 x 100

        IThassaMarkets.SignedOrder[] memory orders = new IThassaMarkets.SignedOrder[](2);
        IThassaMarkets.Auth3009[] memory auths = new IThassaMarkets.Auth3009[](2);

        // makerA takes 30 YES at limit 60 (fills at exec 60 against the creator's NO 40).
        orders[0] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 30, 25 * UNIT, 0, makerA);
        auths[0] = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, orders[0], 25 * UNIT);

        // makerB rests 10 NO at 45.
        orders[1] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.NO), 45, 10, 10 * UNIT, 0, makerB);
        auths[1] = _buildAuthForOrder(MAKER_B_PRIVATE_KEY, orders[1], 10 * UNIT);

        uint256 makerABalanceBefore = token.balanceOf(makerA);

        vm.prank(relayer);
        markets.placeOrdersBatch(orders, auths);

        // makerA: full auth pulled, actual cost deducted from free balance, surplus retained.
        uint256 makerACost = 60 * 30 * CENT + _takerFee(30, 60);
        assertEq(token.balanceOf(makerA), makerABalanceBefore - 25 * UNIT);
        assertEq(markets.freeBalance(makerA), 25 * UNIT - makerACost);
        (uint128 makerAShares,) = markets.positionOf(marketId, makerA, uint8(IThassaMarkets.Side.YES));
        assertEq(makerAShares, 30);

        // makerB rested: escrow deducted, surplus retained.
        assertEq(markets.freeBalance(makerB), 10 * UNIT - 45 * 10 * CENT);
        (, uint8 bestNo) = markets.bestPrices(marketId);
        assertEq(bestNo, 45);

        assertEq(markets.nonces(makerA), 1);
        assertEq(markets.nonces(makerB), 1);
    }

    function test_PlaceOrdersBatch_BadOrderSkippedOthersProcessed() public {
        uint256 marketId = _createDefaultMarket();

        IThassaMarkets.SignedOrder[] memory orders = new IThassaMarkets.SignedOrder[](3);
        IThassaMarkets.Auth3009[] memory auths = new IThassaMarkets.Auth3009[](3);

        // Bad: wrong nonce.
        orders[0] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 10 * UNIT, 0, makerA);
        orders[0].nonce = 5;
        auths[0] = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, orders[0], 10 * UNIT);

        // Bad: tampered price after signing (auth binds the original digest).
        orders[1] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 10 * UNIT, 0, makerB);
        auths[1] = _buildAuthForOrder(MAKER_B_PRIVATE_KEY, orders[1], 10 * UNIT);
        orders[1].price = 70;

        // Good order.
        orders[2] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 10 * UNIT, 0, makerA);
        auths[2] = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, orders[2], 10 * UNIT);

        vm.prank(relayer);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.OrderRejected(marketId, makerA, bytes32("NONCE"));
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.OrderRejected(marketId, makerB, bytes32("AUTH_BINDING"));
        markets.placeOrdersBatch(orders, auths);

        (uint128 makerAShares,) = markets.positionOf(marketId, makerA, uint8(IThassaMarkets.Side.YES));
        (uint128 makerBShares,) = markets.positionOf(marketId, makerB, uint8(IThassaMarkets.Side.YES));
        assertEq(makerAShares, 10);
        assertEq(makerBShares, 0);
        assertEq(markets.nonces(makerA), 1);
        assertEq(markets.nonces(makerB), 0);
    }

    function test_PlaceOrdersBatch_ForgedAuthSignatureRejected() public {
        uint256 marketId = _createDefaultMarket();

        IThassaMarkets.SignedOrder[] memory orders = new IThassaMarkets.SignedOrder[](1);
        IThassaMarkets.Auth3009[] memory auths = new IThassaMarkets.Auth3009[](1);

        orders[0] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 10 * UNIT, 0, makerA);
        // Signed with the wrong key: token rejects the authorization.
        auths[0] = _buildAuth(MAKER_B_PRIVATE_KEY, makerA, 10 * UNIT, markets.orderDigest(orders[0]));

        vm.prank(relayer);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.OrderRejected(marketId, makerA, bytes32("AUTH"));
        markets.placeOrdersBatch(orders, auths);

        assertEq(markets.nonces(makerA), 0);
        assertEq(markets.freeBalance(makerA), 0);
    }

    function test_PlaceOrdersBatch_NonceReplayRejected() public {
        uint256 marketId = _createDefaultMarket();

        IThassaMarkets.SignedOrder[] memory orders = new IThassaMarkets.SignedOrder[](1);
        IThassaMarkets.Auth3009[] memory auths = new IThassaMarkets.Auth3009[](1);
        orders[0] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 10 * UNIT, 0, makerA);
        auths[0] = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, orders[0], 10 * UNIT);

        vm.prank(relayer);
        markets.placeOrdersBatch(orders, auths);
        assertEq(markets.nonces(makerA), 1);

        // Replaying the exact same signed order fails the sequential-nonce check.
        vm.prank(relayer);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.OrderRejected(marketId, makerA, bytes32("NONCE"));
        markets.placeOrdersBatch(orders, auths);

        (uint128 makerAShares,) = markets.positionOf(marketId, makerA, uint8(IThassaMarkets.Side.YES));
        assertEq(makerAShares, 10);
    }

    function test_PlaceOrdersBatch_InsufficientAuthValueKeepsFundsInFreeBalance() public {
        uint256 marketId = _createDefaultMarket();

        IThassaMarkets.SignedOrder[] memory orders = new IThassaMarkets.SignedOrder[](1);
        IThassaMarkets.Auth3009[] memory auths = new IThassaMarkets.Auth3009[](1);
        orders[0] = _buildSignedOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 10, 10 * UNIT, 0, makerA);
        // Auth pays far less than the worst-case cost bound.
        auths[0] = _buildAuthForOrder(MAKER_A_PRIVATE_KEY, orders[0], 1 * UNIT);

        vm.prank(relayer);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.OrderRejected(marketId, makerA, bytes32("FUNDS"));
        markets.placeOrdersBatch(orders, auths);

        // The pulled funds stay withdrawable in the maker ledger.
        assertEq(markets.freeBalance(makerA), 1 * UNIT);
        assertEq(markets.nonces(makerA), 0);
    }

    function test_PlaceOrdersBatch_LengthMismatchReverts() public {
        IThassaMarkets.SignedOrder[] memory orders = new IThassaMarkets.SignedOrder[](2);
        IThassaMarkets.Auth3009[] memory auths = new IThassaMarkets.Auth3009[](1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.BatchLengthMismatch.selector, 2, 1));
        markets.placeOrdersBatch(orders, auths);
    }

    // ------------------------------------------------------------------
    // Settlement through the real hub + PoA verifier
    // ------------------------------------------------------------------

    function test_Settlement_FullRoundTripThroughHub() public {
        uint256 marketId = _createDefaultMarket(); // creator NO @ 40 x 100

        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 100, 0); // fills all

        // Anyone triggers settlement paying the $0.05 fee.
        uint256 carolBalanceBefore = token.balanceOf(carol);
        vm.prank(carol);
        vm.expectEmit(true, false, true, false);
        emit IThassaMarkets.SettlementRequested(marketId, 0, carol);
        markets.settleMarket(marketId);
        assertEq(carolBalanceBefore - token.balanceOf(carol), 5 * CENT);

        IThassaMarkets.Market memory market = markets.getMarket(marketId);
        assertEq(market.status, markets.STATUS_SETTLING());
        uint256 bidId = market.pendingBidId;
        assertTrue(bidId != 0);

        // The bid carries abi.encode(marketId, settlementQuery) as bound inputData.
        bytes memory inputData = markets.bidInputData(bidId);
        assertEq(keccak256(inputData), hub.getBid(bidId).inputDataHash);
        (uint256 decodedMarketId, string memory decodedQuery) = abi.decode(inputData, (uint256, string));
        assertEq(decodedMarketId, marketId);
        assertEq(decodedQuery, SETTLEMENT_QUERY);

        // PoA node signs the hub digest and submits the auto update (YES outcome).
        vm.expectEmit(true, false, false, true);
        emit IThassaMarkets.MarketSettled(marketId, true);
        _submitSettlementUpdate(marketId, bidId, true, true);

        market = markets.getMarket(marketId);
        assertEq(market.status, markets.STATUS_SETTLED());
        assertTrue(market.settled);
        assertTrue(market.direction);
        assertFalse(hub.getBid(bidId).isOpen);
    }

    function test_SettleMarketWithAuth_RelayedEIP3009FeePayment() public {
        uint256 marketId = _createDefaultMarket();

        // makerA signs a 6c authorization; the relayer submits it. Surplus above the 5c fee
        // accrues to makerA's free balance.
        IThassaMarkets.Auth3009 memory auth =
            _buildAuth(MAKER_A_PRIVATE_KEY, makerA, 6 * CENT, keccak256("settle-auth-1"));

        uint256 makerABalanceBefore = token.balanceOf(makerA);

        vm.prank(relayer);
        markets.settleMarketWithAuth(marketId, makerA, auth);

        assertEq(markets.getMarket(marketId).status, markets.STATUS_SETTLING());
        assertEq(makerABalanceBefore - token.balanceOf(makerA), 6 * CENT);
        assertEq(markets.freeBalance(makerA), 1 * CENT);

        // Underfunded auth reverts.
        uint256 pendingBidId = markets.getMarket(marketId).pendingBidId;
        vm.prank(address(markets));
        hub.cancelBid(pendingBidId);
        IThassaMarkets.Auth3009 memory smallAuth =
            _buildAuth(MAKER_A_PRIVATE_KEY, makerA, 4 * CENT, keccak256("settle-auth-2"));
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IThassaMarkets.InsufficientFreeBalance.selector, makerA, 4 * CENT, 5 * CENT)
        );
        markets.settleMarketWithAuth(marketId, makerA, smallAuth);
    }

    function test_Settlement_CallbackRejectedWhenNotSettling() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(carol);
        markets.settleMarket(marketId);
        uint256 bidId = markets.getMarket(marketId).pendingBidId;

        _submitSettlementUpdate(marketId, bidId, true, false);
        assertEq(markets.getMarket(marketId).status, markets.STATUS_SETTLED());
        assertFalse(markets.getMarket(marketId).direction);

        // A second settlement attempt for the settled market reverts.
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(IThassaMarkets.MarketNotSettleable.selector, marketId, markets.STATUS_SETTLED())
        );
        markets.settleMarket(marketId);
    }

    function test_Settlement_NotRetriggerableWhileBidOpen_RetriggerableAfterCancel() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(carol);
        markets.settleMarket(marketId);
        uint256 bidId = markets.getMarket(marketId).pendingBidId;

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.SettlementAlreadyPending.selector, marketId, bidId));
        markets.settleMarket(marketId);

        // The markets contract is the bid requester; the owner path is not available here, so
        // simulate expiry by cancelling from the markets contract address.
        vm.prank(address(markets));
        hub.cancelBid(bidId);

        vm.prank(carol);
        markets.settleMarket(marketId);
        uint256 newBidId = markets.getMarket(marketId).pendingBidId;
        assertTrue(newBidId != bidId);
        assertEq(markets.getMarket(marketId).status, markets.STATUS_SETTLING());
    }

    // ------------------------------------------------------------------
    // Redeem / void
    // ------------------------------------------------------------------

    function test_Redeem_WinnersPaidLosersNot_WithWithdrawalFee() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 100, 0);

        vm.prank(carol);
        markets.settleMarket(marketId);
        _submitSettlementUpdate(marketId, markets.getMarket(marketId).pendingBidId, true, true); // YES wins

        uint256 bobBalanceBefore = token.balanceOf(bob);
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit IThassaMarkets.Redeemed(marketId, bob, 100, 100 * UNIT - 10 * CENT);
        markets.redeem(marketId);
        assertEq(token.balanceOf(bob) - bobBalanceBefore, 100 * UNIT - 10 * CENT);

        // Double redeem and loser redeem both revert.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.NothingToRedeem.selector, marketId, bob));
        markets.redeem(marketId);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IThassaMarkets.NothingToRedeem.selector, marketId, creator));
        markets.redeem(marketId);
    }

    function test_Redeem_RevertsWhileMarketLive() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IThassaMarkets.MarketNotRedeemable.selector, marketId, markets.STATUS_OPEN())
        );
        markets.redeem(marketId);
    }

    function test_VoidMarket_RefundsMatchedEscrowAtCostBasis() public {
        uint256 marketId = _createDefaultMarket(); // creator NO @ 40 x 100

        vm.prank(bob);
        markets.placeOrder(marketId, uint8(IThassaMarkets.Side.YES), 60, 40, 0); // 40 filled at 60

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        markets.voidMarket(marketId);

        vm.expectEmit(true, false, false, true);
        emit IThassaMarkets.MarketVoided(marketId);
        markets.voidMarket(marketId);
        assertEq(markets.getMarket(marketId).status, markets.STATUS_VOID());

        // Taker refunds cost basis (execution escrow, fees not refunded).
        uint256 bobBalanceBefore = token.balanceOf(bob);
        vm.prank(bob);
        markets.redeem(marketId);
        assertEq(token.balanceOf(bob) - bobBalanceBefore, 60 * 40 * CENT - 10 * CENT);

        // Maker refunds cost basis for the matched part; the resting 60 shares via cancel.
        uint256 creatorBalanceBefore = token.balanceOf(creator);
        vm.prank(creator);
        markets.redeem(marketId);
        assertEq(token.balanceOf(creator) - creatorBalanceBefore, 40 * 40 * CENT - 10 * CENT);

        uint256 restingOrderId = markets.openingOrderId(marketId);
        vm.prank(creator);
        markets.cancelOrder(marketId, restingOrderId);
        assertEq(markets.freeBalance(creator), 40 * 60 * CENT);
    }

    function test_VoidMarket_DuringSettling_CancelsOpenBid() public {
        uint256 marketId = _createDefaultMarket();

        vm.prank(carol);
        markets.settleMarket(marketId);
        uint256 bidId = markets.getMarket(marketId).pendingBidId;
        assertTrue(hub.getBid(bidId).isOpen);

        uint256 protocolFeesBefore = markets.protocolFeesAccrued();
        markets.voidMarket(marketId);

        assertFalse(hub.getBid(bidId).isOpen);
        assertEq(markets.protocolFeesAccrued() - protocolFeesBefore, 5 * CENT);
        assertEq(markets.getMarket(marketId).status, markets.STATUS_VOID());
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _createDefaultMarket() internal returns (uint256 marketId) {
        vm.prank(creator);
        marketId = markets.createMarketDirect(QUESTION, SETTLEMENT_QUERY, uint8(IThassaMarkets.Side.NO), 40, 100);
    }

    /// @dev fee = ceil(takerFeeBps * shares * p * (100 - p) * unit / 1e8) at the default 700 bps.
    function _takerFee(uint256 shares, uint256 execPrice) internal pure returns (uint256) {
        uint256 numerator = 700 * shares * execPrice * (100 - execPrice) * UNIT;
        return (numerator + 1e8 - 1) / 1e8;
    }

    function _buildSignedOrder(
        uint256 marketId,
        uint8 side,
        uint8 price,
        uint80 shares,
        uint256 maxCost,
        uint256 affiliatePostId,
        address maker
    ) internal view returns (IThassaMarkets.SignedOrder memory) {
        return IThassaMarkets.SignedOrder({
            marketId: marketId,
            side: side,
            price: price,
            shares: shares,
            maxCost: maxCost,
            affiliatePostId: affiliatePostId,
            expiry: uint64(block.timestamp + 1 hours),
            nonce: markets.nonces(maker),
            maker: maker
        });
    }

    /// @dev The maker's EIP-3009 authorization doubles as the order signature by using the
    ///      order's EIP-712 digest as the authorization nonce.
    function _buildAuthForOrder(uint256 privateKey, IThassaMarkets.SignedOrder memory order, uint256 value)
        internal
        view
        returns (IThassaMarkets.Auth3009 memory)
    {
        return _buildAuth(privateKey, order.maker, value, markets.orderDigest(order));
    }

    function _buildAuth(uint256 privateKey, address from, uint256 value, bytes32 authNonce)
        internal
        view
        returns (IThassaMarkets.Auth3009 memory auth)
    {
        auth.value = value;
        auth.validAfter = 0;
        auth.validBefore = type(uint256).max;
        auth.authNonce = authNonce;

        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(markets),
                value,
                auth.validAfter,
                auth.validBefore,
                authNonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_tokenDomainSeparator(), structHash);
        (auth.v, auth.r, auth.s) = vm.sign(privateKey, digest);
    }

    function _tokenDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Mock USD")),
                keccak256(bytes("1")),
                block.chainid,
                address(token)
            )
        );
    }

    /// @dev Builds, signs (EIP-191 over the hub ProofUpdateV2 digest), and submits the PoA node's
    ///      auto update for a settlement bid.
    function _submitSettlementUpdate(uint256 marketId, uint256 bidId, bool settled, bool direction) internal {
        IThassaHub.UpdateEnvelope memory update = IThassaHub.UpdateEnvelope({
            client: address(markets),
            callbackData: abi.encode(marketId, settled, direction),
            inputData: markets.bidInputData(bidId),
            responseId: hub.getBid(bidId).responseId,
            queryHash: keccak256(bytes(markets.query())),
            shapeHash: keccak256(bytes(markets.expectedShape())),
            modelHash: keccak256(bytes(markets.model())),
            clientVersion: 1,
            requestTimestamp: uint64(block.timestamp),
            fulfiller: poaSigner
        });

        bytes32 digest = hub.computeUpdateDigest(update, bidId, true);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(POA_PRIVATE_KEY, digest.toEthSignedMessageHash());

        IThassaHub.ProofEnvelope memory proof = IThassaHub.ProofEnvelope({
            scheme: 1,
            publicValues: abi.encode(uint256(1)),
            proof: abi.encodePacked(r, s, v)
        });

        vm.prank(poaSigner);
        hub.submitAutoUpdate(bidId, update, proof);
    }
}
