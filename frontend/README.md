# THASSA Demo Frontend

Simple Next.js demo UI for:
- reading `latestWeather()` from `ThassaSanFranciscoWeatherOracle`
- submitting `placeBid(bidAmount)` to request auto updates

Approval behavior:
- Frontend signer approves `MockCoin` spender = weather oracle contract address.
- Then it calls `oracle.placeBid(bidAmount)`.

## Run

1. Copy `.env.example` to `.env.local` and fill addresses/key.
2. Install deps:

```bash
npm install
```

3. Start:

```bash
npm run dev
```

## ABI Sync

Frontend ABIs are sourced from contract artifacts and stored in `frontend/abi`.

Regenerate after Solidity changes:

```bash
npm run export:abis
```

## Demo Security Note

This frontend intentionally uses `NEXT_PUBLIC_DEMO_PRIVATE_KEY` in browser code.
That is unsafe in real deployments and is only for local demo use.

## Troubleshooting

If you see `latestWeather returned no data (0x)`, your configured oracle address is not a deployed
`ThassaSanFranciscoWeatherOracle` on the currently running RPC.

Check:
- anvil/local node is running at `NEXT_PUBLIC_RPC_URL`
- contracts were actually broadcast to that chain (not just dry-run)
- `NEXT_PUBLIC_WEATHER_ORACLE_ADDRESS` and `NEXT_PUBLIC_HUB_ADDRESS` match the latest deployment
