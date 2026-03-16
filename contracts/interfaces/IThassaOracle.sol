// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IThassaOracle {
    struct OracleSpec {
        string query;
        string expectedShape;
        string model;
        uint64 clientVersion;
    }

    error ZeroHubAddress();
    error UnauthorizedHub(address caller);

    event BidForwarded(address indexed bidder, uint256 indexed bidId, uint256 bidAmount);

    function thassaHub() external view returns (address);
    function query() external view returns (string memory);
    function expectedShape() external view returns (string memory);
    function model() external view returns (string memory);
    function oracleSpec() external view returns (OracleSpec memory);
    function placeBid(uint256 bidAmount) external returns (uint256 bidId);
    function updateOracle(bytes calldata callbackData) external;
}
