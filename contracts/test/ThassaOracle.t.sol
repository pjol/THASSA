// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaOracle} from "../interfaces/IThassaOracle.sol";
import {ISP1Verifier} from "../interfaces/ISP1Verifier.sol";
import {ThassaHub} from "../src/ThassaHub.sol";
import {ThassaOracle} from "../src/ThassaOracle.sol";
import {ThassaSP1Verifier} from "../src/ThassaSP1Verifier.sol";

contract ThassaOracleFlowTest is Test {
    bytes32 private constant PROGRAM_VKEY = keccak256("thassa-sp1-program-vkey");
    uint8 private constant PROOF_SCHEME_SP1 = 2;

    string private constant QUERY = "What is the latest NAV?";
    string private constant SHAPE = "tuple(nav:uint256,asOf:uint64)";
    string private constant MODEL = "openai:gpt-4.1-mini";
    bytes32 private constant QUERY_HASH = keccak256(bytes(QUERY));
    bytes32 private constant SHAPE_HASH = keccak256(bytes(SHAPE));
    bytes32 private constant MODEL_HASH = keccak256(bytes(MODEL));
    uint64 private constant CLIENT_VERSION = 1;

    uint256 private constant FULFILLER_PRIVATE_KEY = 0xA11CE;

    address private user = makeAddr("user");
    address private fulfiller = vm.addr(FULFILLER_PRIVATE_KEY);
    address private otherFulfiller = makeAddr("otherFulfiller");
    address private delegator = makeAddr("delegator");
    address private relayer = makeAddr("relayer");
    address private feeCollector = makeAddr("feeCollector");

    MockPaymentToken private paymentToken;
    MockSP1Verifier private sp1Verifier;
    ThassaSP1Verifier private verifier;
    ThassaHub private hub;
    MockOracle private oracle;

    function setUp() public {
        paymentToken = new MockPaymentToken(6);
        sp1Verifier = new MockSP1Verifier();
        verifier = new ThassaSP1Verifier(address(sp1Verifier), PROGRAM_VKEY);
        hub = new ThassaHub(address(paymentToken), feeCollector, address(verifier));
        oracle = new MockOracle(address(hub), QUERY, SHAPE, MODEL, CLIENT_VERSION);

        paymentToken.mint(user, 1_000_000_000);
        paymentToken.mint(fulfiller, 1_000_000_000);
        paymentToken.mint(otherFulfiller, 1_000_000_000);
        paymentToken.mint(delegator, 1_000_000_000);
        paymentToken.mint(relayer, 1_000_000_000);

        vm.prank(user);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(user);
        paymentToken.approve(address(oracle), type(uint256).max);
        vm.prank(fulfiller);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(otherFulfiller);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(delegator);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(relayer);
        paymentToken.approve(address(hub), type(uint256).max);
    }

    function test_ManualFlow_ChargesProtocolFee_AndUpdatesOracle() public {
        IThassaHub.FeeQuote memory quote = hub.quoteFees(0);
        bytes memory callbackData = abi.encode("manual-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, fulfiller, 1);
        _configureVerifier(proof, true);

        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);
        uint256 fulfillerBalanceBefore = paymentToken.balanceOf(fulfiller);

        vm.prank(user);
        hub.submitManualUpdate(update, proof);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + quote.protocolFee);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore + quote.nodeFee);
        assertEq(hub.totalProtocolFeesAccrued(), quote.protocolFee);
        assertEq(hub.totalNodeFeesAccrued(), quote.nodeFee);
        assertEq(oracle.updateCount(), 1);
        assertEq(oracle.lastDataHash(), keccak256(callbackData));
        assertTrue(oracle.fulfilled());
    }

    function test_ManualFlow_RevertsWhenBaseFeeNotApproved() public {
        IThassaHub.FeeQuote memory quote = hub.quoteFees(0);
        bytes memory callbackData = abi.encode("manual-update-no-base-fee");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, fulfiller, 901);
        _configureVerifier(proof, true);

        bytes32 digest = hub.computeUpdateDigest(update, 0, false);
        uint256 userBalanceBefore = paymentToken.balanceOf(user);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);
        uint256 fulfillerBalanceBefore = paymentToken.balanceOf(fulfiller);

        vm.prank(user);
        paymentToken.approve(address(hub), quote.baseFee - 1);

        vm.prank(user);
        vm.expectRevert();
        hub.submitManualUpdate(update, proof);

        assertEq(paymentToken.balanceOf(user), userBalanceBefore);
        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore);
        assertEq(oracle.updateCount(), 0);
        assertFalse(hub.consumedDigests(digest));
    }

    function test_ManualFlow_WithPriority_SplitsBaseAndPriorityFees() public {
        uint256 priorityFee = (hub.baseProtocolFee() * 3) + 1;
        IThassaHub.FeeQuote memory quote = hub.quoteFees(priorityFee);
        bytes memory callbackData = abi.encode("manual-priority-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, fulfiller, 101);
        _configureVerifier(proof, true);

        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);
        uint256 fulfillerBalanceBefore = paymentToken.balanceOf(fulfiller);

        vm.prank(user);
        hub.submitManualUpdateWithPriority(update, proof, priorityFee);

        assertEq(quote.baseFee, hub.baseProtocolFee());
        assertEq(quote.priorityFee, priorityFee);
        assertEq(quote.protocolFee + quote.nodeFee, quote.baseFee + quote.priorityFee);
        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + quote.protocolFee);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore + quote.nodeFee);
    }

    function test_ProtocolVault_SurfaceKeepsLegacyFeeCollectorAlias() public {
        address newVault = makeAddr("newVault");
        address nextVault = makeAddr("nextVault");

        assertEq(hub.baseFee(), hub.baseProtocolFee());
        assertEq(hub.protocolVault(), feeCollector);
        assertEq(hub.feeCollector(), feeCollector);

        hub.setProtocolVault(newVault);
        assertEq(hub.protocolVault(), newVault);
        assertEq(hub.feeCollector(), newVault);

        hub.setFeeCollector(nextVault);
        assertEq(hub.protocolVault(), nextVault);
        assertEq(hub.feeCollector(), nextVault);
    }

    function test_ManualFlow_AllowsSubsequentUpdates() public {
        bytes memory firstCallbackData = abi.encode("manual-update-1");
        (IThassaHub.UpdateEnvelope memory firstUpdate, IThassaHub.ProofEnvelope memory firstProof) =
            _buildUpdateAndProof(firstCallbackData, 0, false, user, 1);
        _configureVerifier(firstProof, true);

        vm.prank(user);
        hub.submitManualUpdate(firstUpdate, firstProof);

        bytes memory secondCallbackData = abi.encode("manual-update-2");
        (IThassaHub.UpdateEnvelope memory secondUpdate, IThassaHub.ProofEnvelope memory secondProof) =
            _buildUpdateAndProof(secondCallbackData, 0, false, user, 2);
        _configureVerifier(secondProof, true);

        vm.prank(user);
        hub.submitManualUpdate(secondUpdate, secondProof);

        assertEq(oracle.updateCount(), 2);
        assertEq(oracle.lastDataHash(), keccak256(secondCallbackData));
    }

    function test_AutoFlow_UsesBidAndLockup_SettlesFeeAndPayout() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 5;
        IThassaHub.FeeQuote memory quote = hub.quoteBid(bidAmount);

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("auto-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 2);
        _configureVerifier(proof, true);

        uint256 fulfillerBalanceBefore = paymentToken.balanceOf(fulfiller);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(fulfiller);
        hub.submitAutoUpdate(bidId, update, proof);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + quote.protocolFee);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore + quote.nodeFee);
        assertEq(oracle.updateCount(), 1);
        assertEq(oracle.lastDataHash(), keccak256(callbackData));

        IThassaHub.Bid memory bid = hub.getBid(bidId);
        assertFalse(bid.isOpen);
    }

    function test_AutoFlow_CallbackRevert_RevertsAndDoesNotSettle() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 3;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        oracle.setShouldRevert(true);

        bytes memory callbackData = abi.encode("reverting-callback");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 3);
        _configureVerifier(proof, true);

        uint256 fulfillerBalanceBefore = paymentToken.balanceOf(fulfiller);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(fulfiller);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.OracleCallbackFailed.selector, address(oracle)));
        hub.submitAutoUpdate(bidId, update, proof);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore);
        assertEq(oracle.updateCount(), 0);
        assertTrue(hub.getBid(bidId).isOpen);
    }

    function test_ManualFlow_CallbackRevert_RevertsAndDoesNotSettle() public {
        oracle.setShouldRevert(true);

        bytes memory callbackData = abi.encode("manual-reverting-callback");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, fulfiller, 301);
        _configureVerifier(proof, true);

        uint256 userBalanceBefore = paymentToken.balanceOf(user);
        uint256 fulfillerBalanceBefore = paymentToken.balanceOf(fulfiller);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.OracleCallbackFailed.selector, address(oracle)));
        hub.submitManualUpdate(update, proof);

        assertEq(paymentToken.balanceOf(user), userBalanceBefore);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore);
        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore);
        assertEq(oracle.updateCount(), 0);
    }

    function test_AutoFlow_RejectsNonFulfillerSubmitter() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 4;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("permissionless-auto-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 99);
        _configureVerifier(proof, true);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.AutoFlowFulfillerMismatch.selector, fulfiller, relayer));
        hub.submitAutoUpdate(bidId, update, proof);
    }

    function test_AutoFlow_InvalidProof_Reverts() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 4;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("invalid-proof");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 123);
        _configureVerifier(proof, false);

        vm.prank(fulfiller);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.InvalidProof.selector, address(verifier)));
        hub.submitAutoUpdate(bidId, update, proof);
    }

    function test_AutoFlow_RejectsWrongBidResponseId() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 4;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("wrong-response-id");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 1);
        update.responseId = keccak256("wrong-response-id");

        vm.expectRevert(
            abi.encodeWithSelector(
                IThassaHub.BidResponseIdMismatch.selector, bidId, hub.getBid(bidId).responseId, update.responseId
            )
        );
        vm.prank(fulfiller);
        hub.submitAutoUpdate(bidId, update, proof);
    }

    function test_AutoFlow_RejectsWrongBidInputData() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 4;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("wrong-input-data");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 1);
        update.inputData = bytes("{\"different\":true}");

        vm.expectRevert(
            abi.encodeWithSelector(
                IThassaHub.BidInputDataMismatch.selector,
                bidId,
                hub.getBid(bidId).inputDataHash,
                keccak256(update.inputData)
            )
        );
        vm.prank(fulfiller);
        hub.submitAutoUpdate(bidId, update, proof);
    }

    function test_OraclePlaceBid_ForwardsToHubWithUserRequester() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 2;

        vm.prank(user);
        uint256 bidId = oracle.placeBid(bidAmount);

        IThassaHub.Bid memory bid = hub.getBid(bidId);
        assertEq(bid.requester, user);
        assertEq(bid.client, address(oracle));
        assertEq(bid.amount, bidAmount);
        assertEq(bid.baseFee, fee);
        assertEq(bid.priorityFee, bidAmount - fee);
        assertTrue(bid.isOpen);

        assertEq(paymentToken.balanceOf(address(oracle)), 0);
    }

    function test_OraclePlaceBid_UserCanCancelForwardedBid() public {
        uint256 bidAmount = hub.baseProtocolFee() * 2;
        uint256 userBalanceBefore = paymentToken.balanceOf(user);

        vm.prank(user);
        uint256 bidId = oracle.placeBid(bidAmount);

        vm.prank(user);
        hub.cancelBid(bidId);

        IThassaHub.Bid memory bid = hub.getBid(bidId);
        assertFalse(bid.isOpen);
        assertEq(paymentToken.balanceOf(user), userBalanceBefore);
    }

    function test_OraclePlaceBid_DoesNotResetFulfillmentStatus() public {
        bytes memory callbackData = abi.encode("manual-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, user, 1);
        _configureVerifier(proof, true);

        vm.prank(user);
        hub.submitManualUpdate(update, proof);

        assertTrue(oracle.fulfilled());

        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 2;

        vm.prank(user);
        oracle.placeBid(bidAmount);

        assertTrue(oracle.fulfilled());
    }

    function test_StakingDelegation_BookkeepsStakeWeights() public {
        bytes32 metadataHash = keccak256("node metadata");
        uint256 selfStake = hub.baseProtocolFee() * 7;
        uint256 delegatedAmount = hub.baseProtocolFee() * 11;

        vm.prank(fulfiller);
        hub.registerNode(metadataHash);

        vm.prank(fulfiller);
        hub.stake(selfStake);

        vm.prank(delegator);
        hub.delegateStake(fulfiller, delegatedAmount);

        IThassaHub.NodeInfo memory info = hub.nodeInfo(fulfiller);
        assertTrue(info.registered);
        assertTrue(info.active);
        assertEq(info.metadataHash, metadataHash);
        assertEq(info.selfStake, selfStake);
        assertEq(info.delegatedStake, delegatedAmount);
        assertEq(info.stakeWeight, selfStake + delegatedAmount);
        assertEq(hub.delegatedStake(delegator, fulfiller), delegatedAmount);
        assertEq(hub.totalStakeWeight(), selfStake + delegatedAmount);

        vm.prank(delegator);
        hub.undelegateStake(fulfiller, delegatedAmount / 2);

        info = hub.nodeInfo(fulfiller);
        assertEq(info.delegatedStake, delegatedAmount - (delegatedAmount / 2));
        assertEq(hub.totalStakeWeight(), selfStake + delegatedAmount - (delegatedAmount / 2));
    }

    function test_Allocation_RestrictsAutoFulfillmentToAssignedNode() public {
        uint256 bidAmount = hub.baseProtocolFee() * 4;
        IThassaHub.FeeQuote memory quote = hub.quoteBid(bidAmount);

        vm.prank(fulfiller);
        hub.registerNode(keccak256("assigned node"));

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        vm.prank(user);
        hub.allocateBid(bidId, fulfiller);

        bytes memory callbackData = abi.encode("allocated-auto-update");
        (IThassaHub.UpdateEnvelope memory wrongUpdate, IThassaHub.ProofEnvelope memory wrongProof) =
            _buildUpdateAndProof(callbackData, bidId, true, otherFulfiller, 201);
        _configureVerifier(wrongProof, true);

        vm.prank(otherFulfiller);
        vm.expectRevert(
            abi.encodeWithSelector(IThassaHub.BidAllocatedToDifferentNode.selector, bidId, fulfiller, otherFulfiller)
        );
        hub.submitAutoUpdate(bidId, wrongUpdate, wrongProof);

        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, bidId, true, fulfiller, 202);
        _configureVerifier(proof, true);

        vm.prank(fulfiller);
        hub.submitAutoUpdate(bidId, update, proof);

        IThassaHub.NodeInfo memory info = hub.nodeInfo(fulfiller);
        assertEq(info.fulfilledCount, 1);
        assertEq(info.earnedFees, quote.nodeFee);
    }

    function test_ManualFlow_RevertsWhenStructuredOutputMarkedUnfulfilled() public {
        bytes memory callbackData = abi.encode("manual-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, user, 1);
        proof.publicValues = abi.encode(
            IThassaHub.ProofCommitment({
                llmFulfilled: false,
                digest: hub.computeUpdateDigest(update, 0, false),
                bidId: 0,
                autoFlow: false,
                client: update.client,
                fulfiller: update.fulfiller,
                queryHash: update.queryHash,
                shapeHash: update.shapeHash,
                modelHash: update.modelHash,
                inputDataHash: keccak256(update.inputData),
                responseId: update.responseId,
                clientVersion: update.clientVersion,
                requestTimestamp: update.requestTimestamp,
                callbackHash: keccak256(update.callbackData)
            })
        );
        _configureVerifier(proof, true);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.UnfulfilledResult.selector, address(oracle)));
        hub.submitManualUpdate(update, proof);
    }

    function test_ManualFlow_RevertsWhenAttestationExpired() public {
        vm.warp(1_000_000);

        bytes memory callbackData = abi.encode("stale-attestation");
        (IThassaHub.UpdateEnvelope memory update,) = _buildUpdateAndProof(callbackData, 0, false, user, 401);
        update.requestTimestamp = uint64(block.timestamp - oracle.maxAttestationAge() - 1);
        IThassaHub.ProofEnvelope memory proof = _buildProofForUpdate(update, 0, false, 402);
        _configureVerifier(proof, true);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IThassaHub.AttestationExpired.selector,
                address(oracle),
                update.requestTimestamp,
                uint64(block.timestamp),
                oracle.maxAttestationAge()
            )
        );
        hub.submitManualUpdate(update, proof);
    }

    function test_ManualFlow_RevertsWhenOracleWindowBelowHubMinimum() public {
        oracle.setMaxAttestationAge(uint64(10 minutes - 1));

        bytes memory callbackData = abi.encode("short-window");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, user, 501);
        _configureVerifier(proof, true);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IThassaHub.AttestationWindowTooShort.selector,
                address(oracle),
                uint64(10 minutes - 1),
                hub.minimumAttestationAge()
            )
        );
        hub.submitManualUpdate(update, proof);
    }

    function test_OwnerCanLowerMinimumAttestationAgeForShorterOracleWindow() public {
        hub.setMinimumAttestationAge(uint64(5 minutes));
        oracle.setMaxAttestationAge(uint64(5 minutes));

        bytes memory callbackData = abi.encode("shorter-window-after-owner-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, user, 601);
        _configureVerifier(proof, true);

        vm.prank(user);
        hub.submitManualUpdate(update, proof);

        assertEq(oracle.updateCount(), 1);
        assertEq(oracle.lastDataHash(), keccak256(callbackData));
    }

    function test_OracleSpec_ReturnsFullQueryAndShapeStrings() public view {
        assertEq(oracle.query(), QUERY);
        assertEq(oracle.expectedShape(), SHAPE);
        assertEq(oracle.model(), MODEL);
        assertEq(oracle.maxAttestationAge(), 10 minutes);
        assertEq(hub.minimumAttestationAge(), 10 minutes);

        IThassaOracle.OracleSpec memory spec = oracle.oracleSpec();
        assertEq(spec.query, QUERY);
        assertEq(spec.expectedShape, SHAPE);
        assertEq(spec.model, MODEL);
    }

    function _buildUpdateAndProof(
        bytes memory callbackData,
        uint256 bidId,
        bool autoFlow,
        address updateFulfiller,
        uint256 proofSalt
    ) internal view returns (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) {
        update = IThassaHub.UpdateEnvelope({
            client: address(oracle),
            callbackData: callbackData,
            inputData: bytes("{}"),
            responseId: autoFlow
                ? hub.getBid(bidId).responseId
                : keccak256(abi.encode("manual-response", callbackData, proofSalt)),
            queryHash: QUERY_HASH,
            shapeHash: SHAPE_HASH,
            modelHash: MODEL_HASH,
            clientVersion: CLIENT_VERSION,
            requestTimestamp: uint64(block.timestamp),
            fulfiller: updateFulfiller
        });

        proof = _buildProofForUpdate(update, bidId, autoFlow, proofSalt);
    }

    function _buildProofForUpdate(
        IThassaHub.UpdateEnvelope memory update,
        uint256 bidId,
        bool autoFlow,
        uint256 proofSalt
    ) internal view returns (IThassaHub.ProofEnvelope memory proof) {
        bytes32 digest = hub.computeUpdateDigest(update, bidId, autoFlow);
        IThassaHub.ProofCommitment memory commitment = IThassaHub.ProofCommitment({
            llmFulfilled: true,
            digest: digest,
            bidId: bidId,
            autoFlow: autoFlow,
            client: update.client,
            fulfiller: update.fulfiller,
            queryHash: update.queryHash,
            shapeHash: update.shapeHash,
            modelHash: update.modelHash,
            inputDataHash: keccak256(update.inputData),
            responseId: update.responseId,
            clientVersion: update.clientVersion,
            requestTimestamp: update.requestTimestamp,
            callbackHash: keccak256(update.callbackData)
        });

        proof = IThassaHub.ProofEnvelope({
            scheme: PROOF_SCHEME_SP1,
            publicValues: abi.encode(commitment),
            proof: abi.encodePacked("sp1-proof", bidId, proofSalt, update.client, update.fulfiller, digest)
        });
    }

    function _configureVerifier(IThassaHub.ProofEnvelope memory proof, bool shouldSucceed) internal {
        sp1Verifier.setExpectation(PROGRAM_VKEY, keccak256(proof.publicValues), keccak256(proof.proof), shouldSucceed);
    }
}

contract MockOracle is ThassaOracle {
    bytes32 public lastDataHash;
    uint256 public updateCount;
    bool public shouldRevert;
    uint64 private _maxAttestationAge = 10 minutes;

    constructor(
        address thassaHub_,
        string memory query_,
        string memory expectedShape_,
        string memory model_,
        uint64 clientVersion_
    ) ThassaOracle(thassaHub_, query_, expectedShape_, model_, clientVersion_) {}

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setMaxAttestationAge(uint64 value) external {
        _maxAttestationAge = value;
    }

    function maxAttestationAge() public view override returns (uint64) {
        return _maxAttestationAge;
    }

    function _updateOracle(bytes calldata callbackData) internal override {
        if (shouldRevert) {
            revert("CALLBACK_REVERT");
        }

        lastDataHash = keccak256(callbackData);
        updateCount += 1;
    }
}

contract MockPaymentToken is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(uint8 tokenDecimals_) ERC20("Mock Payment", "MPAY") {
        _tokenDecimals = tokenDecimals_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }
}

contract MockSP1Verifier is ISP1Verifier {
    bytes32 public expectedProgramVKey;
    bytes32 public expectedPublicValuesHash;
    bytes32 public expectedProofHash;
    bool public expectedResult = true;

    function setExpectation(bytes32 programVKey, bytes32 publicValuesHash, bytes32 proofHash, bool result) external {
        expectedProgramVKey = programVKey;
        expectedPublicValuesHash = publicValuesHash;
        expectedProofHash = proofHash;
        expectedResult = result;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        bool matches = expectedResult && programVKey == expectedProgramVKey
            && keccak256(publicValues) == expectedPublicValuesHash && keccak256(proofBytes) == expectedProofHash;

        if (!matches) {
            revert("INVALID_SP1_PROOF");
        }
    }
}
