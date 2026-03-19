// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IThassaOracle} from "./IThassaOracle.sol";

interface IThassaSanFranciscoWeatherOracle is IThassaOracle {
    struct WeatherReport {
        uint64 observationTimestamp;
        int32 temperatureCentiCelsius;
        uint16 humidityBps;
        uint32 windSpeedCms;
        uint32 windGustCms;
        uint32 precipitationMicrometers;
        uint32 pressurePa;
        uint16 conditionCode;
        string conditionDescription;
    }

    event WeatherReportUpdated(
        uint64 observationTimestamp,
        int32 temperatureCentiCelsius,
        uint16 humidityBps,
        uint32 windSpeedCms,
        uint32 windGustCms,
        uint32 precipitationMicrometers,
        uint32 pressurePa,
        uint16 conditionCode,
        string conditionDescription
    );

    function latestWeather() external view returns (WeatherReport memory);
}
