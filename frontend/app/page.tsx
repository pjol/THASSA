"use client";

import Image from "next/image";
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
  fulfilled: boolean;
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

function shortAddress(value: string | undefined, width = 6) {
  if (!value) return "--";
  return `${value.slice(0, width + 2)}…${value.slice(-4)}`;
}

function formatWeatherValue(weather: WeatherReport | null, fulfilled: boolean) {
  if (!weather || !fulfilled) return null;

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
  const [syncing, setSyncing] = useState(false);
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

  const readSnapshot = useCallback(async (options?: { interactive?: boolean }) => {
    if (!publicClient || !oracleAddress || !hubAddress || !account) return;

    const interactive = options?.interactive ?? false;
    if (interactive) {
      setSyncing(true);
    }

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

      const [oracleHub, query, expectedShape, model, fulfilled, baseProtocolFee, paymentToken] =
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
            address: oracleAddress,
            abi: weatherOracleAbi,
            functionName: "fulfilled"
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
        fulfilled: fulfilled as boolean,
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
      if (interactive) {
        setSyncing(false);
      }
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

  const weather = formatWeatherValue(snapshot?.weather ?? null, snapshot?.fulfilled ?? false);

  if (envErrors.length > 0) {
    return (
      <main className="page">
        <section className="configErrorCard reveal">
          <h1>THASSA Demo</h1>
          <p>Set the frontend env.</p>
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
      <div className="ambient ambientC" />

      <section className="hero reveal">
        <div className="brandRow">
          <div className="brandLockup">
            <div className="logoShell">
              <Image src="/thassa-logo.svg" alt="THASSA logo" width={78} height={78} className="brandLogo" priority />
            </div>
            <div>
              <p className="heroTag">THASSA DEMO</p>
              <h1>Weather Oracle</h1>
              <p className="heroLead">Reading from our onchain weather report.</p>
            </div>
          </div>

          <div className="heroMeta">
            <span className="chip">RPC Live</span>
            <span className="chip">Signer {shortAddress(account?.address)}</span>
            <span className="chip">Hub {shortAddress(hubAddress ?? undefined, 4)}</span>
          </div>
        </div>

        <div className="heroStatus">
          <span className={`chip ${snapshot?.fulfilled ? "chipOk" : "chipPending"}`}>
            {snapshot?.fulfilled ? "Report Live" : "Awaiting First Fill"}
          </span>
          <p>{snapshot?.fulfilled ? "Onchain weather is populated." : "No onchain weather yet."}</p>
        </div>
      </section>

      <section className="grid">
        <article className="card weatherCard reveal">
          <div className="cardHeader">
            <div>
              <p className="eyebrow">Snapshot</p>
              <h2>Live Report</h2>
            </div>
            <button className="ghostButton" onClick={() => void readSnapshot({ interactive: true })} disabled={syncing || requesting}>
              {syncing ? "Syncing..." : "Sync"}
            </button>
          </div>

          <div className="statusRow">
            <span className={`statusBadge ${snapshot?.fulfilled ? "statusOk" : "statusPending"}`}>
              {snapshot?.fulfilled ? "Fulfilled" : "Pending"}
            </span>
            <p className="statusLine">
              {snapshot?.fulfilled
                ? `${weather?.observationDate ?? "No report"} · ${weather?.description ?? "n/a"}`
                : "No report yet."}
            </p>
          </div>

          <div className="weatherGrid">
            <div className="metric">
              <span>Status</span>
              <strong>{snapshot?.fulfilled ? "Yes" : "No"}</strong>
            </div>
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
              <span>Code</span>
              <strong>{weather ? weather.code : "--"}</strong>
            </div>
            <div className="metric">
              <span>Unix Time</span>
              <strong>
                {snapshot?.fulfilled ? snapshot.weather.observationTimestamp.toString() : "--"}
              </strong>
            </div>
          </div>
        </article>

        <article className="card actionCard reveal">
          <p className="eyebrow">Action</p>
          <h2>Queue Update</h2>
          <p>Calls <span className="mono">oracle.placeBid(...)</span> from the demo key.</p>

          <label>
            Bid ({snapshot?.tokenSymbol ?? "TOKEN"})
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

          <button className="primaryButton" onClick={() => void requestAutoUpdate()} disabled={requesting}>
            {requesting ? "Submitting..." : "Queue Auto-Update"}
          </button>
        </article>

        <article className="card bindingsCard reveal">
          <p className="eyebrow">Spec</p>
          <h2>Oracle Config</h2>
          <div className="specStack">
            <div className="specBlock">
              <span className="specLabel">Model</span>
              <p className="mono compact">{snapshot?.model ?? "--"}</p>
            </div>
            <div className="specBlock">
              <span className="specLabel">Query</span>
              <p className="mono compact">{snapshot?.query ?? "--"}</p>
            </div>
            <div className="specBlock">
              <span className="specLabel">Shape</span>
              <p className="mono compact">{snapshot?.expectedShape ?? "--"}</p>
            </div>
          </div>
        </article>

        <article className="card logCard reveal">
          <div className="cardHeader">
            <div>
              <p className="eyebrow">Trace</p>
              <h2>Activity</h2>
            </div>
          </div>
          <div className="logViewport">
            {logs.length === 0 ? (
              <p className="statusLine">No events yet.</p>
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
