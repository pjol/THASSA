// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ThassaOracle} from "./ThassaOracle.sol";
import {IThassaSanFranciscoWeatherOracle} from "../interfaces/IThassaSanFranciscoWeatherOracle.sol";

contract ThassaSanFranciscoWeatherOracle is ThassaOracle, IThassaSanFranciscoWeatherOracle {
    string private constant WEATHER_QUERY = "Provide current real-time weather conditions for San Francisco, California, United States, "
        "using latest available observations. Return only the requested schema fields.";

    string private constant WEATHER_SHAPE = "tuple(observationTimestamp:uint64,temperatureCentiCelsius:int32,humidityBps:uint16,windSpeedCms:uint32,"
        "windGustCms:uint32,precipitationMicrometers:uint32,pressurePa:uint32,conditionCode:uint16,"
        "conditionDescription:string)";

    WeatherReport private _latestWeather;

    constructor(address thassaHub_, string memory model_, uint64 clientVersion_)
        ThassaOracle(thassaHub_, WEATHER_QUERY, WEATHER_SHAPE, model_, clientVersion_)
    {}

    function latestWeather() external view override returns (WeatherReport memory) {
        return _latestWeather;
    }

    function _updateOracle(bytes calldata callbackData) internal override {
        (
            uint64 observationTimestamp,
            int32 temperatureCentiCelsius,
            uint16 humidityBps,
            uint32 windSpeedCms,
            uint32 windGustCms,
            uint32 precipitationMicrometers,
            uint32 pressurePa,
            uint16 conditionCode,
            string memory conditionDescription
        ) = abi.decode(callbackData, (uint64, int32, uint16, uint32, uint32, uint32, uint32, uint16, string));

        _latestWeather = WeatherReport({
            observationTimestamp: observationTimestamp,
            temperatureCentiCelsius: temperatureCentiCelsius,
            humidityBps: humidityBps,
            windSpeedCms: windSpeedCms,
            windGustCms: windGustCms,
            precipitationMicrometers: precipitationMicrometers,
            pressurePa: pressurePa,
            conditionCode: conditionCode,
            conditionDescription: conditionDescription
        });

        emit WeatherReportUpdated(
            observationTimestamp,
            temperatureCentiCelsius,
            humidityBps,
            windSpeedCms,
            windGustCms,
            precipitationMicrometers,
            pressurePa,
            conditionCode,
            conditionDescription
        );
    }
}
