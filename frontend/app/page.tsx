"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  maxUint256,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, hubAbi, weatherOracleAbi } from "../lib/contracts";

type LogLevel = "info" | "success" | "error";

type LogItem = {
  id: number;
  at: string;
  level: LogLevel;
  message: string;
};

type Numeric = bigint | number;

type WeatherReport = {
  observationTimestamp: Numeric;
  temperatureCentiCelsius: Numeric;
  humidityBps: Numeric;
  windSpeedCms: Numeric;
  windGustCms: Numeric;
  precipitationMicrometers: Numeric;
  pressurePa: Numeric;
  conditionCode: Numeric;
  conditionDescription: string;
};

type Snapshot = {
  weather: WeatherReport;
  query: string;
  expectedShape: string;
  model: string;
  baseProtocolFee: bigint;
  paymentToken: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
  demoBalance: bigint;
};

function asAddress(value: string | undefined): `0x${string}` | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return null;
  return normalized as `0x${string}`;
}

function asPrivateKey(value: string | undefined): `0x${string}` | null {
  if (!value) return null;
  const raw = value.trim();
  const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(withPrefix)) return null;
  return withPrefix as `0x${string}`;
}

function formatWeatherValue(weather: WeatherReport | null) {
  if (!weather) return null;

  const toNumber = (value: Numeric) => (typeof value === "bigint" ? Number(value) : value);
  const observationSeconds = toNumber(weather.observationTimestamp);

  const observationDate =
    observationSeconds > 0
      ? new Date(observationSeconds * 1000).toLocaleString()
      : "No observation submitted yet";

  return {
    observationDate,
    temperatureC: toNumber(weather.temperatureCentiCelsius) / 100,
    humidityPct: toNumber(weather.humidityBps) / 100,
    windMs: toNumber(weather.windSpeedCms) / 100,
    gustMs: toNumber(weather.windGustCms) / 100,
    rainMm: toNumber(weather.precipitationMicrometers) / 1000,
    pressureHpa: toNumber(weather.pressurePa) / 100,
    code: toNumber(weather.conditionCode),
    description: weather.conditionDescription || "n/a"
  };
}

export default function HomePage() {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "";
  const oracleAddress = asAddress(process.env.NEXT_PUBLIC_WEATHER_ORACLE_ADDRESS);
  const hubAddress = asAddress(process.env.NEXT_PUBLIC_HUB_ADDRESS);
  const demoPrivateKey = asPrivateKey(process.env.NEXT_PUBLIC_DEMO_PRIVATE_KEY);

  const envErrors = useMemo(() => {
    const errors: string[] = [];
    if (!rpcUrl) errors.push("NEXT_PUBLIC_RPC_URL is missing.");
    if (!oracleAddress) errors.push("NEXT_PUBLIC_WEATHER_ORACLE_ADDRESS is missing or invalid.");
    if (!hubAddress) errors.push("NEXT_PUBLIC_HUB_ADDRESS is missing or invalid.");
    if (!demoPrivateKey) errors.push("NEXT_PUBLIC_DEMO_PRIVATE_KEY is missing or invalid.");
    return errors;
  }, [demoPrivateKey, hubAddress, oracleAddress, rpcUrl]);

  const account = useMemo(() => {
    if (!demoPrivateKey) return null;
    try {
      return privateKeyToAccount(demoPrivateKey);
    } catch {
      return null;
    }
  }, [demoPrivateKey]);

  const publicClient = useMemo(() => {
    if (!rpcUrl) return null;
    return createPublicClient({ transport: http(rpcUrl) });
  }, [rpcUrl]);

  const walletClient = useMemo(() => {
    if (!rpcUrl || !account) return null;
    return createWalletClient({
      account,
      transport: http(rpcUrl)
    });
  }, [account, rpcUrl]);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [bidAmountInput, setBidAmountInput] = useState("");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const pushLog = useCallback((message: string, level: LogLevel = "info") => {
    setLogs((prev) => {
      const next: LogItem = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        at: new Date().toLocaleTimeString(),
        level,
        message
      };
      return [next, ...prev].slice(0, 10);
    });
  }, []);

  const readSnapshot = useCallback(async () => {
    if (!publicClient || !oracleAddress || !hubAddress || !account) return;

    setLoading(true);
    try {
      const [oracleBytecode, hubBytecode] = await Promise.all([
        publicClient.getBytecode({ address: oracleAddress }),
        publicClient.getBytecode({ address: hubAddress })
      ]);

      if (!oracleBytecode || oracleBytecode === "0x") {
        throw new Error(
          `No contract code at WEATHER_ORACLE address ${oracleAddress}. Re-deploy contracts and update NEXT_PUBLIC_WEATHER_ORACLE_ADDRESS.`
        );
      }
      if (!hubBytecode || hubBytecode === "0x") {
        throw new Error(
          `No contract code at HUB address ${hubAddress}. Re-deploy contracts and update NEXT_PUBLIC_HUB_ADDRESS.`
        );
      }

      const [oracleHub, query, expectedShape, model, baseProtocolFee, paymentToken] =
        await Promise.all([
          publicClient.readContract({
            address: oracleAddress,
            abi: weatherOracleAbi,
            functionName: "thassaHub"
          }),
          publicClient.readContract({
            address: oracleAddress,
            abi: weatherOracleAbi,
            functionName: "query"
          }),
          publicClient.readContract({
            address: oracleAddress,
            abi: weatherOracleAbi,
            functionName: "expectedShape"
          }),
          publicClient.readContract({
            address: oracleAddress,
            abi: weatherOracleAbi,
            functionName: "model"
          }),
          publicClient.readContract({
            address: hubAddress,
            abi: hubAbi,
            functionName: "baseProtocolFee"
          }),
          publicClient.readContract({
            address: hubAddress,
            abi: hubAbi,
            functionName: "paymentToken"
          })
        ]);

      if ((oracleHub as `0x${string}`).toLowerCase() !== hubAddress.toLowerCase()) {
        throw new Error(
          `Address mismatch: oracle.thassaHub()=${oracleHub as string} but NEXT_PUBLIC_HUB_ADDRESS=${hubAddress}.`
        );
      }

      let latestWeatherRaw: unknown;
      try {
        latestWeatherRaw = await publicClient.readContract({
          address: oracleAddress,
          abi: weatherOracleAbi,
          functionName: "latestWeather"
        });
      } catch (weatherReadError) {
        throw new Error(
          `Could not read latestWeather() from ${oracleAddress}. This address is likely not ThassaSanFranciscoWeatherOracle on the current chain. Original error: ${weatherReadError instanceof Error ? weatherReadError.message : "unknown error"}`
        );
      }

      const paymentTokenAddress = paymentToken as `0x${string}`;

      const [tokenSymbol, tokenDecimalsRaw, demoBalance] = await Promise.all([
        publicClient.readContract({
          address: paymentTokenAddress,
          abi: erc20Abi,
          functionName: "symbol"
        }),
        publicClient.readContract({
          address: paymentTokenAddress,
          abi: erc20Abi,
          functionName: "decimals"
        }),
        publicClient.readContract({
          address: paymentTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address]
        })
      ]);

      const tokenDecimals = Number(tokenDecimalsRaw);

      setSnapshot({
        weather: latestWeatherRaw as WeatherReport,
        query: query as string,
        expectedShape: expectedShape as string,
        model: model as string,
        baseProtocolFee: baseProtocolFee as bigint,
        paymentToken: paymentTokenAddress,
        tokenSymbol: tokenSymbol as string,
        tokenDecimals,
        demoBalance: demoBalance as bigint
      });

      setBidAmountInput((current) =>
        current.trim() === "" ? formatUnits((baseProtocolFee as bigint) * 3n, tokenDecimals) : current
      );
    } catch (error) {
      pushLog(
        `Failed to read onchain snapshot: ${error instanceof Error ? error.message : "Unknown error"}`,
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, [account, hubAddress, oracleAddress, publicClient, pushLog]);

  useEffect(() => {
    if (envErrors.length > 0) return;

    void readSnapshot();
    const interval = setInterval(() => setRefreshTick((prev) => prev + 1), 6000);
    return () => clearInterval(interval);
  }, [envErrors.length, readSnapshot]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void readSnapshot();
  }, [readSnapshot, refreshTick]);

  const requestAutoUpdate = useCallback(async () => {
    if (!publicClient || !walletClient || !snapshot || !oracleAddress || !account) return;

    setRequesting(true);
    try {
      const bidAmount = parseUnits(bidAmountInput || "0", snapshot.tokenDecimals);
      if (bidAmount <= 0n) {
        throw new Error("Bid amount must be greater than zero.");
      }
      if (snapshot.demoBalance < bidAmount) {
        throw new Error(
          `Insufficient ${snapshot.tokenSymbol} balance. Need ${formatUnits(bidAmount, snapshot.tokenDecimals)} but only have ${formatUnits(snapshot.demoBalance, snapshot.tokenDecimals)}.`
        );
      }

      const allowance = (await publicClient.readContract({
        address: snapshot.paymentToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, oracleAddress]
      })) as bigint;
      pushLog(
        `Allowance check: owner=${account.address} spender=${oracleAddress} allowance=${formatUnits(allowance, snapshot.tokenDecimals)} ${snapshot.tokenSymbol}`,
        "info"
      );

      if (allowance < bidAmount) {
        pushLog(
          `Allowance insufficient for bid amount ${formatUnits(bidAmount, snapshot.tokenDecimals)} ${snapshot.tokenSymbol}. Sending approve(MAX) to oracle spender...`,
          "info"
        );

        try {
          const approvalTx = await walletClient.writeContract({
            account,
            chain: undefined,
            address: snapshot.paymentToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [oracleAddress, maxUint256]
          });

          pushLog(`Approval tx sent: ${approvalTx}`, "info");
          await publicClient.waitForTransactionReceipt({ hash: approvalTx });
          pushLog("Approval confirmed.", "success");
        } catch (approvalError) {
          pushLog(
            `Direct approve(MAX) failed (${approvalError instanceof Error ? approvalError.message : "unknown"}). Trying reset-to-zero then approve(MAX)...`,
            "info"
          );

          const resetTx = await walletClient.writeContract({
            account,
            chain: undefined,
            address: snapshot.paymentToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [oracleAddress, 0n]
          });
          pushLog(`Reset approval tx sent: ${resetTx}`, "info");
          await publicClient.waitForTransactionReceipt({ hash: resetTx });

          const approvalTx = await walletClient.writeContract({
            account,
            chain: undefined,
            address: snapshot.paymentToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [oracleAddress, maxUint256]
          });
          pushLog(`Approval tx sent: ${approvalTx}`, "info");
          await publicClient.waitForTransactionReceipt({ hash: approvalTx });
          pushLog("Approval confirmed after reset-to-zero.", "success");
        }

        const refreshedAllowance = (await publicClient.readContract({
          address: snapshot.paymentToken,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, oracleAddress]
        })) as bigint;
        if (refreshedAllowance < bidAmount) {
          throw new Error(
            `Approval post-check failed. Allowance is still ${formatUnits(refreshedAllowance, snapshot.tokenDecimals)} ${snapshot.tokenSymbol}.`
          );
        }
        pushLog(
          `Allowance ready: ${formatUnits(refreshedAllowance, snapshot.tokenDecimals)} ${snapshot.tokenSymbol}`,
          "success"
        );
      }

      pushLog("Submitting oracle.placeBid(...) transaction...");
      const bidTx = await walletClient.writeContract({
        account,
        chain: undefined,
        address: oracleAddress,
        abi: weatherOracleAbi,
        functionName: "placeBid",
        args: [bidAmount]
      });

      pushLog(`Bid tx sent: ${bidTx}`, "success");
      await publicClient.waitForTransactionReceipt({ hash: bidTx });
      pushLog("Auto-update request confirmed onchain.", "success");

      await readSnapshot();
    } catch (error) {
      pushLog(
        `Auto-update request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "error"
      );
    } finally {
      setRequesting(false);
    }
  }, [account, bidAmountInput, oracleAddress, publicClient, pushLog, readSnapshot, snapshot, walletClient]);

  const weather = formatWeatherValue(snapshot?.weather ?? null);

  if (envErrors.length > 0) {
    return (
      <main className="page">
        <section className="configErrorCard reveal">
          <h1>THASSA Demo Frontend</h1>
          <p>Set your frontend env first:</p>
          <ul>
            {envErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
          <p className="mono">See: frontend/.env.example</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="ambient ambientA" />
      <div className="ambient ambientB" />

      <section className="hero reveal">
        <p className="heroTag">THASSA PROTOCOL DEMO</p>
        <h1>San Francisco Weather Oracle</h1>
        <p>
          Read the latest weather report from chain and request a fresh auto-update bid in one click.
        </p>
        <div className="heroMeta">
          <span className="chip">Live RPC</span>
          <span className="chip">Demo Signer: {account?.address}</span>
        </div>
      </section>

      <section className="grid">
        <article className="card weatherCard reveal">
          <div className="cardHeader">
            <h2>Current Onchain Report</h2>
            <button className="ghostButton" onClick={() => void readSnapshot()} disabled={loading || requesting}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <p className="statusLine">
            {weather?.observationDate ?? "No report loaded"} · condition{" "}
            <span className="mono">{weather?.description ?? "n/a"}</span>
          </p>

          <div className="weatherGrid">
            <div className="metric">
              <span>Temperature</span>
              <strong>{weather ? `${weather.temperatureC.toFixed(1)}°C` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Humidity</span>
              <strong>{weather ? `${weather.humidityPct.toFixed(1)}%` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Wind</span>
              <strong>{weather ? `${weather.windMs.toFixed(2)} m/s` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Wind Gust</span>
              <strong>{weather ? `${weather.gustMs.toFixed(2)} m/s` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Precipitation</span>
              <strong>{weather ? `${weather.rainMm.toFixed(3)} mm` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Pressure</span>
              <strong>{weather ? `${weather.pressureHpa.toFixed(1)} hPa` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Condition Code</span>
              <strong>{weather ? weather.code : "--"}</strong>
            </div>
            <div className="metric">
              <span>Last Timestamp</span>
              <strong>{snapshot ? snapshot.weather.observationTimestamp.toString() : "--"}</strong>
            </div>
          </div>
        </article>

        <article className="card actionCard reveal">
          <h2>Request Auto-Update</h2>
          <p>
            This submits <span className="mono">oracle.placeBid(bidAmount)</span> from the demo private key.
          </p>

          <label>
            Bid Amount ({snapshot?.tokenSymbol ?? "TOKEN"})
            <input
              value={bidAmountInput}
              onChange={(event) => setBidAmountInput(event.target.value)}
              placeholder="0.0"
              inputMode="decimal"
            />
          </label>

          <div className="metaPanel">
            <div>
              <span>Base Protocol Fee</span>
              <strong>
                {snapshot ? formatUnits(snapshot.baseProtocolFee, snapshot.tokenDecimals) : "--"}{" "}
                {snapshot?.tokenSymbol ?? ""}
              </strong>
            </div>
            <div>
              <span>Demo Balance</span>
              <strong>
                {snapshot ? formatUnits(snapshot.demoBalance, snapshot.tokenDecimals) : "--"}{" "}
                {snapshot?.tokenSymbol ?? ""}
              </strong>
            </div>
          </div>

          <button className="primaryButton" onClick={() => void requestAutoUpdate()} disabled={requesting || loading}>
            {requesting ? "Submitting..." : "Request Contract Auto-Update"}
          </button>
        </article>

        <article className="card bindingsCard reveal">
          <h2>Oracle Bindings</h2>
          <p className="mono compact">{snapshot?.model ?? "--"}</p>
          <p className="mono compact">{snapshot?.query ?? "--"}</p>
          <p className="mono compact">{snapshot?.expectedShape ?? "--"}</p>
        </article>

        <article className="card logCard reveal">
          <h2>Activity</h2>
          <div className="logViewport">
            {logs.length === 0 ? (
              <p className="statusLine">No actions yet.</p>
            ) : (
              <ul className="logList">
                {logs.map((item) => (
                  <li key={item.id} className={`logItem ${item.level}`}>
                    <span className="logTime">{item.at}</span>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}
