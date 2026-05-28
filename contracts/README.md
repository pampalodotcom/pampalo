# Pampalo Smart Contracts

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
