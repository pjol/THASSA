## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ cp .env.example .env
$ ./script/deploy_thassa.sh
```

The deploy runner:
- loads `contracts/.env`
- requires `DEPLOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `NODE_SIGNER_PUBLIC_KEY`, `USER_ACCOUNT_PUBLIC_KEY`
- broadcasts with `--rpc-url "$DEPLOY_RPC_URL"` so transactions are sent to the chain defined in the env file

Deploy only the weather oracle (against an existing hub):

```shell
$ cp .env.example .env
$ ./script/deploy_weather_oracle.sh
```

The weather-only deploy runner:
- loads `contracts/.env`
- requires `DEPLOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `THASSA_HUB_ADDRESS`
- broadcasts with `--rpc-url "$DEPLOY_RPC_URL"` so transactions are sent to the chain defined in the env file

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
