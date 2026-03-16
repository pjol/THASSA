// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaOracle} from "../interfaces/IThassaOracle.sol";
import {ThassaHub} from "../src/ThassaHub.sol";
import {ThassaOracle} from "../src/ThassaOracle.sol";
import {ThassaSignatureVerifier} from "../src/ThassaSignatureVerifier.sol";

contract ThassaOracleFlowTest is Test {
    using MessageHashUtils for bytes32;

    string private constant QUERY = "What is the latest NAV?";
    string private constant SHAPE = "tuple(nav:uint256,asOf:uint64)";
    string private constant MODEL = "openai:gpt-4.1-mini";
    bytes32 private constant QUERY_HASH = keccak256(bytes(QUERY));
    bytes32 private constant SHAPE_HASH = keccak256(bytes(SHAPE));
    bytes32 private constant MODEL_HASH = keccak256(bytes(MODEL));
    uint64 private constant CLIENT_VERSION = 1;

    uint256 private constant NODE_PRIVATE_KEY = 0xA11CE;
    uint256 private constant INVALID_PRIVATE_KEY = 0xB0B;

    address private user = makeAddr("user");
    address private node = vm.addr(NODE_PRIVATE_KEY);
    address private relayer = makeAddr("relayer");
    address private feeCollector = makeAddr("feeCollector");

    MockPaymentToken private paymentToken;
    ThassaHub private hub;
    MockOracle private oracle;
    ThassaSignatureVerifier private verifier;

    function setUp() public {
        paymentToken = new MockPaymentToken(6);
        verifier = new ThassaSignatureVerifier(node);
        hub = new ThassaHub(address(paymentToken), feeCollector, address(verifier));
        oracle = new MockOracle(address(hub), QUERY, SHAPE, MODEL, CLIENT_VERSION);

        paymentToken.mint(user, 1_000_000_000);
        paymentToken.mint(node, 1_000_000_000);
        paymentToken.mint(relayer, 1_000_000_000);

        vm.prank(user);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(user);
        paymentToken.approve(address(oracle), type(uint256).max);
        vm.prank(node);
        paymentToken.approve(address(hub), type(uint256).max);
        vm.prank(relayer);
        paymentToken.approve(address(hub), type(uint256).max);
    }

    function test_ManualFlow_ChargesProtocolFee_AndUpdatesOracle() public {
        uint256 fee = hub.baseProtocolFee();
        bytes memory callbackData = abi.encode("manual-update");
        IThassaHub.SignedUpdate memory update = _signedUpdate(callbackData, 0, false, 1);

        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(user);
        hub.submitManualUpdate(update);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(oracle.updateCount(), 1);
        assertEq(oracle.lastDataHash(), keccak256(callbackData));
    }

    function test_AutoFlow_UsesBidAndLockup_SettlesFeeAndPayout() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 5;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("auto-update");
        IThassaHub.SignedUpdate memory update = _signedUpdate(callbackData, bidId, true, 2);

        uint256 nodeBalanceBefore = paymentToken.balanceOf(node);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(node);
        hub.submitAutoUpdate(bidId, update);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(paymentToken.balanceOf(node), nodeBalanceBefore + (bidAmount - fee));
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
        IThassaHub.SignedUpdate memory update = _signedUpdate(callbackData, bidId, true, 3);

        uint256 nodeBalanceBefore = paymentToken.balanceOf(node);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(node);
        hub.submitAutoUpdate(bidId, update);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(paymentToken.balanceOf(node), nodeBalanceBefore + (bidAmount - fee));
        assertEq(oracle.updateCount(), 0);
    }

    function test_AutoFlow_PermissionlessSubmitter_SucceedsWithAdminProof() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 4;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("permissionless-auto-update");
        IThassaHub.SignedUpdate memory update = _signedUpdate(callbackData, bidId, true, 99);

        uint256 relayerBalanceBefore = paymentToken.balanceOf(relayer);
        uint256 feeCollectorBalanceBefore = paymentToken.balanceOf(feeCollector);

        vm.prank(relayer);
        hub.submitAutoUpdate(bidId, update);

        assertEq(paymentToken.balanceOf(feeCollector), feeCollectorBalanceBefore + fee);
        assertEq(paymentToken.balanceOf(relayer), relayerBalanceBefore + (bidAmount - fee));
        assertEq(oracle.updateCount(), 1);
    }

    function test_AutoFlow_InvalidProof_Reverts() public {
        uint256 fee = hub.baseProtocolFee();
        uint256 bidAmount = fee * 4;

        vm.prank(user);
        uint256 bidId = hub.placeBid(address(oracle), bidAmount);

        bytes memory callbackData = abi.encode("invalid-proof");
        address invalidSigner = vm.addr(INVALID_PRIVATE_KEY);
        IThassaHub.SignedUpdate memory update =
            _signedUpdateWithKey(callbackData, bidId, true, 123, INVALID_PRIVATE_KEY, invalidSigner);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IThassaHub.InvalidProof.selector, address(verifier)));
        hub.submitAutoUpdate(bidId, update);
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

    function test_OracleSpec_ReturnsFullQueryAndShapeStrings() public view {
        assertEq(oracle.query(), QUERY);
        assertEq(oracle.expectedShape(), SHAPE);
        assertEq(oracle.model(), MODEL);

        IThassaOracle.OracleSpec memory spec = oracle.oracleSpec();
        assertEq(spec.query, QUERY);
        assertEq(spec.expectedShape, SHAPE);
        assertEq(spec.model, MODEL);
    }

    function _signedUpdate(bytes memory callbackData, uint256 bidId, bool autoFlow, uint256 nonce)
        internal
        view
        returns (IThassaHub.SignedUpdate memory update)
    {
        return _signedUpdateWithKey(callbackData, bidId, autoFlow, nonce, NODE_PRIVATE_KEY, node);
    }

    function _signedUpdateWithKey(
        bytes memory callbackData,
        uint256 bidId,
        bool autoFlow,
        uint256 nonce,
        uint256 privateKey,
        address signer
    ) internal view returns (IThassaHub.SignedUpdate memory update) {
        update = IThassaHub.SignedUpdate({
            client: address(oracle),
            callbackData: callbackData,
            queryHash: QUERY_HASH,
            shapeHash: SHAPE_HASH,
            modelHash: MODEL_HASH,
            clientVersion: CLIENT_VERSION,
            expiry: uint64(block.timestamp + 1 hours),
            nonce: nonce,
            signer: signer,
            signature: bytes("")
        });

        bytes32 digest = hub.computeUpdateDigest(update, bidId, autoFlow);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest.toEthSignedMessageHash());
        update.signature = abi.encodePacked(r, s, v);
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
