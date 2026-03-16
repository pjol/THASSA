// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IThassaHub} from "../interfaces/IThassaHub.sol";
import {IThassaOracle} from "../interfaces/IThassaOracle.sol";

abstract contract ThassaOracle is IThassaOracle {
    using SafeERC20 for IERC20;

    address public immutable override thassaHub;

    string private _query;
    string private _expectedShape;
    string private _model;
    uint64 public immutable clientVersion;

    constructor(
        address thassaHub_,
        string memory query_,
        string memory expectedShape_,
        string memory model_,
        uint64 clientVersion_
    ) {
        if (thassaHub_ == address(0)) {
            revert ZeroHubAddress();
        }

        thassaHub = thassaHub_;
        _query = query_;
        _expectedShape = expectedShape_;
        _model = model_;
        clientVersion = clientVersion_;
    }

    function query() external view override returns (string memory) {
        return _query;
    }

    function expectedShape() external view override returns (string memory) {
        return _expectedShape;
    }

    function model() external view override returns (string memory) {
        return _model;
    }

    function oracleSpec() external view override returns (OracleSpec memory) {
        return OracleSpec({query: _query, expectedShape: _expectedShape, model: _model, clientVersion: clientVersion});
    }

    function placeBid(uint256 bidAmount) external override returns (uint256 bidId) {
        IERC20 paymentToken = IERC20(IThassaHub(thassaHub).paymentToken());
        paymentToken.safeTransferFrom(msg.sender, address(this), bidAmount);
        paymentToken.forceApprove(thassaHub, bidAmount);

        bidId = IThassaHub(thassaHub).placeBid(address(this), bidAmount);
        emit BidForwarded(msg.sender, bidId, bidAmount);
    }

    function updateOracle(bytes calldata callbackData) external override {
        if (msg.sender != thassaHub) {
            revert UnauthorizedHub(msg.sender);
        }

        _updateOracle(callbackData);
    }

    function _updateOracle(bytes calldata callbackData) internal virtual;
}
