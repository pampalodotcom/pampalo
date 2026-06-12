# `@pampalo/contracts`

Pampalo's core Solidity, published as importable source. Add it to any
Hardhat/Foundry project to build contracts that **accept private payments**
the way they accept an ERC-20.

```bash
npm install @pampalo/contracts
```

```solidity
import {PrivatePaymentAcceptor} from "@pampalo/contracts/contracts/PrivatePaymentAcceptor.sol";
import {PampaloPayments} from "@pampalo/contracts/contracts/PampaloPayments.sol";

contract MyShop is PrivatePaymentAcceptor { /* ... */ }
```

The package ships raw `.sol` (no build step); `@openzeppelin/contracts` is the
only dependency, and requires **solc ≥ 0.8.27**. Live Base Sepolia addresses
ship in [`deployments/84532.json`](deployments/84532.json). Full guide: the
Pampalo docs under **Building → Contracts**, and see
[`contracts/mocks/MockShop.sol`](contracts/mocks/MockShop.sol) for a working
reference storefront.

---

The rest of this README covers the protocol and this Hardhat workspace itself.

This `contracts/` directory contains all source code used by pampalo to enable private money, and is a fork of commbank.eth's Private Unstoppable Money protocol, with some key differences. commbank.eth is essentially purely research, pampalo is its applied research (with a few other centralised services).

This is a hardhat v3 project - and uses ethers for it's unit testing/deployments.

#### Compliance

To start, pampalo enforces compliance and safety in many ways.

##### Deposit Wait Times

Whenever a user encrypts their assets - they must wait 1 hour before the deposit is accepted to the protocol (similar to Railgun). Users with the `VIGILANT_CITIZEN_ROLE` role can decline a deposit to the pool if the source is from a bad actor address.

If a deposit is contested (or if the user just doesn't want to wait an hour) - the user can call `cancelDeposit`, which returns their asset amount (reverses the action of their deposit).

To start, `VIGILANT_CITIZEN_ROLE` is centralised, but because of the cool, composable nature of blockchains/the EVM, Pampalo can more or less reuse Railgun and Privacy Pools compliance features/actors.

Note: for ETHGlobal NYC 2026 - this wait time can be accelerated/skipped by visiting the Pampalo booth. This is to enable teams to build more useful apps with private money in what is already quite a time restricted event.

Anyone with the `VIGILANT_CITIZEN_ROLE` has the ability to see a dashboard of all pending deposits - and there is a heap of documentation on how to call this function, depending on what kind of wallet you have.

##### Deposit Limits

A user can only encrypt up to $100 USD/month to their pampalo address, and can only decrypt $100/month to the pampalo address (months starting 1st day of the month, forever).

These limits and prices are kept with chainlink price oracles.

There is a function to heighten deposit limits (`FINANCE_MANAGER_ROLE`) - but the entire protocol needs more testing, auditing, scrutiny and evaluation before it should be accepting more user funds.

##### Only Supported Assets

Pampalo maintains the list of assets that can be encrypted/decrypted in it's platform. This is mainly to ensure that we can track a price associated with that asset (oracle) to maintain deposit limits.

##### 'We're Full' 

Pampalo reserves the right to stop all deposits to the protocol at any given time by calling the `weAreFull()` function. This disables all deposits, but does not cancel all pending deposits.

Users can still transfer and withdraw their funds - but cannot encrypt anymore.

### Note Sharing

Any time that a deposit, transaction or withdrawal transaction inserts a note - the contents of the transaction are encrypted with the users envelope key.

### Libraries

- Noir (for ZK proof generation and proving)
- OpenZeppelin (AccessControlEnumerable)

### Deployment

A single script handles the full chain: token mocks, Pampalo + verifiers,
the Poseidon2 huff hasher, `setPoseidon`, MockOracles, and
`addSupportedAsset` for the launch set. It's safely re-runnable on the
same chain — already-deployed contracts are skipped via Ignition's
deployment records, and post-deploy steps (Poseidon2 setup, asset
registration) check for the already-done state.

Configure `contracts/.env` (or repo-root `.env.local`):

```
MNEMONIC=...               # BIP-39 phrase; accounts[0] must be funded
ALCHEMY_API_KEY=...        # used by every network entry
ETHERSCAN_API_KEY=...      # for Etherscan v2 / Basescan verification
```

Deploy:

```
pnpm --filter @pampalo/contracts deploy:sepolia
pnpm --filter @pampalo/contracts deploy:base-sepolia
```

Outputs land in `contracts/deployments/<chainId>.json`. After the
script finishes, you can mint test tokens to stress-test accounts
(`usdc.mint(addr, amount)`) and bump per-address caps via
`pampalo.setAddressMonthlyCap(addr, usdCents)`.

Mainnet deploys are not yet wired up — swap `MockOracle` for
`ChainlinkOracle` (already implemented) before pointing the script at
Base or Mainnet. See `CONTRACTS_PLAN.md` §4.3 for the launch sets.
