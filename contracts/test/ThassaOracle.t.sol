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
        paymentToken.mint(relayer, 1_000_000_000);

        vm.prank(user);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(user);
        paymentToken.approve(address(oracle), type(uint256).max);
        vm.prank(fulfiller);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(relayer);
        paymentToken.approve(address(hub), type(uint256).max);
    }

    function test_ManualFlow_ChargesProtocolFee_AndUpdatesOracle() public {
        uint256 fee = hub.baseProtocolFee();
        bytes memory callbackData = abi.encode("manual-update");
        (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) =
            _buildUpdateAndProof(callbackData, 0, false, user, 1);
        _configureVerifier(proof, true);

        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(user);
        hub.submitManualUpdate(update, proof);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(oracle.updateCount(), 1);
        assertEq(oracle.lastDataHash(), keccak256(callbackData));
        assertTrue(oracle.fulfilled());
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

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore + (bidAmount - fee));
        assertEq(oracle.updateCount(), 1);
        assertEq(oracle.lastDataHash(), keccak256(callbackData));

        IThassaHub.Bid memory bid = hub.getBid(bidId);
        assertFalse(bid.isOpen);
    }

    function test_AutoFlow_CallbackRevert_DoesNotBlockSettlement() public {
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
        hub.submitAutoUpdate(bidId, update, proof);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(paymentToken.balanceOf(fulfiller), fulfillerBalanceBefore + (bidAmount - fee));
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
        vm.expectRevert(
            abi.encodeWithSelector(IThassaHub.AutoFlowFulfillerMismatch.selector, fulfiller, relayer)
        );
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

    function test_OraclePlaceBid_ForwardsToHubWithOwnAddress() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 2;

        vm.prank(user);
        uint256 bidId = oracle.placeBid(bidAmount);

        IThassaHub.Bid memory bid = hub.getBid(bidId);
        assertEq(bid.requester, address(oracle));
        assertEq(bid.client, address(oracle));
        assertEq(bid.amount, bidAmount);
        assertTrue(bid.isOpen);

        assertEq(paymentToken.balanceOf(address(oracle)), 0);
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
                clientVersion: update.clientVersion,
                requestTimestamp: update.requestTimestamp,
                expiry: update.expiry,
                nonce: update.nonce,
                callbackHash: keccak256(update.callbackData)
            })
        );
        _configureVerifier(proof, true);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.UnfulfilledResult.selector, address(oracle)));
        hub.submitManualUpdate(update, proof);
    }

    function test_OracleSpec_ReturnsFullQueryAndShapeStrings() public view {
        assertEq(oracle.query(), QUERY);
        assertEq(oracle.expectedShape(), SHAPE);
        assertEq(oracle.model(), MODEL);

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
        uint256 nonce
    ) internal view returns (IThassaHub.UpdateEnvelope memory update, IThassaHub.ProofEnvelope memory proof) {
        update = IThassaHub.UpdateEnvelope({
            client: address(oracle),
            callbackData: callbackData,
            queryHash: QUERY_HASH,
            shapeHash: SHAPE_HASH,
            modelHash: MODEL_HASH,
            clientVersion: CLIENT_VERSION,
            requestTimestamp: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 1 hours),
            nonce: nonce,
            fulfiller: updateFulfiller
        });

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
            clientVersion: update.clientVersion,
            requestTimestamp: update.requestTimestamp,
            expiry: update.expiry,
            nonce: update.nonce,
            callbackHash: keccak256(update.callbackData)
        });

        proof = IThassaHub.ProofEnvelope({
            scheme: PROOF_SCHEME_SP1,
            publicValues: abi.encode(commitment),
            proof: abi.encodePacked("sp1-proof", bidId, nonce, update.client, update.fulfiller)
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

    function setExpectation(
        bytes32 programVKey,
        bytes32 publicValuesHash,
        bytes32 proofHash,
        bool result
    ) external {
        expectedProgramVKey = programVKey;
        expectedPublicValuesHash = publicValuesHash;
        expectedProofHash = proofHash;
        expectedResult = result;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes)
        external
        view
    {
        bool matches = expectedResult && programVKey == expectedProgramVKey
            && keccak256(publicValues) == expectedPublicValuesHash && keccak256(proofBytes) == expectedProofHash;

        if (!matches) {
            revert("INVALID_SP1_PROOF");
        }
    }
}
