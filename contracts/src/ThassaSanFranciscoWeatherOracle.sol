// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ThassaOracle} from "./ThassaOracle.sol";
import {IThassaSanFranciscoWeatherOracle} from "../interfaces/IThassaSanFranciscoWeatherOracle.sol";

contract ThassaSanFranciscoWeatherOracle is ThassaOracle, IThassaSanFranciscoWeatherOracle {
    string private constant WEATHER_QUERY =
        "Provide the current observed weather conditions for San Francisco, California, United States. "
        "Use live web search and only the most recent real observation data from an authoritative direct observation source or station report. "
        "Do not use forecasts, projected values, climatological normals, inferred estimates, or generic search-summary weather cards unless they explicitly expose all required observed fields. "
        "If the first search result is only a summary card or lacks the full observed field set, continue searching for a direct observation page or station report from an authoritative weather source. "
        "If multiple sources are available, prefer the newest direct observation and use that observation time for observationTimestamp. "
        "Set conditionCode to the WMO weather code for the observed condition, not a provider-specific icon code. "
        "Return only the requested schema fields.";

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
