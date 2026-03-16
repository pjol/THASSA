// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ThassaSanFranciscoWeatherOracle} from "../src/ThassaSanFranciscoWeatherOracle.sol";
import {IThassaSanFranciscoWeatherOracle} from "../interfaces/IThassaSanFranciscoWeatherOracle.sol";

contract ThassaSanFranciscoWeatherOracleTest is Test {
    string private constant QUERY = "Provide current real-time weather conditions for San Francisco, California, United States, "
        "using latest available observations. Return only the requested schema fields.";

    string private constant SHAPE = "tuple(observationTimestamp:uint64,temperatureCentiCelsius:int32,humidityBps:uint16,windSpeedCms:uint32,"
        "windGustCms:uint32,precipitationMicrometers:uint32,pressurePa:uint32,conditionCode:uint16,"
        "conditionDescription:string)";

    address private hub = makeAddr("hub");
    ThassaSanFranciscoWeatherOracle private weatherOracle;

    function setUp() public {
        weatherOracle = new ThassaSanFranciscoWeatherOracle(hub, "openai:gpt-4.1-mini", 1);
    }

    function test_MetadataIsConfiguredForSanFranciscoWeather() public view {
        assertEq(weatherOracle.query(), QUERY);
        assertEq(weatherOracle.expectedShape(), SHAPE);
        assertEq(weatherOracle.model(), "openai:gpt-4.1-mini");
    }

    function test_UpdateOracle_StoresLatestWeatherReport() public {
        bytes memory callbackData = abi.encode(
            uint64(1_741_790_800),
            int32(1625),
            uint16(7850),
            uint32(420),
            uint32(650),
            uint32(0),
            uint32(101_325),
            uint16(1000),
            string("partly cloudy")
        );

        vm.prank(hub);
        weatherOracle.updateOracle(callbackData);

        IThassaSanFranciscoWeatherOracle.WeatherReport memory weather = weatherOracle.latestWeather();
        assertEq(weather.observationTimestamp, 1_741_790_800);
        assertEq(weather.temperatureCentiCelsius, 1625);
        assertEq(weather.humidityBps, 7850);
        assertEq(weather.windSpeedCms, 420);
        assertEq(weather.windGustCms, 650);
        assertEq(weather.precipitationMicrometers, 0);
        assertEq(weather.pressurePa, 101_325);
        assertEq(weather.conditionCode, 1000);
        assertEq(weather.conditionDescription, "partly cloudy");
    }
}
