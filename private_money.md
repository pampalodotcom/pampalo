# Private Money in Pampalo

> A user-facing + designer-facing guide to how Pampalo's private payments
> work — from the UTXO accounting model, to notes, to Merkle trees, to the
> zero-knowledge proofs, to the Ethereum smart contracts that tie it all
> together.
>
> **For the designer:** sections marked **🎨 Diagram brief** call out the
> concepts that want a visual. Each brief lists the entities, the
> relationships, and the "aha" the diagram should land. The rest of the
> doc gives you the vocabulary and the ground truth so the diagrams stay
> faithful to the protocol. Canonical nouns (Note, Poseidon identifier,
> Envelope key, etc.) are defined in `CONTEXT.md` — please reuse them
> verbatim in any labels.

---

## 1. The big idea

Pampalo is a **ZK private-money protocol on Ethereum (and EVM L2s)**.
Money enters as ordinary, public ERC-20 / ETH and is converted into
private **notes** that live inside an on-chain **Merkle tree**. Once
inside, value can be split, merged, and sent between users entirely in
the private domain. Nobody watching the chain — not even Pampalo's own
servers — can link who paid whom.

The mental model is *cash in an envelope*, not *a bank ledger*:

- A **bank ledger** tracks balances per account. Everyone's running
  total is a row someone can read.
- **Pampalo** tracks **notes** — discrete chunks of value, each owned by
  a secret only the holder knows. There is no "balance" row anywhere;
  your balance is just the sum of the notes whose secrets you hold.

This is the **UTXO model** (Unspent Transaction Output), the same
accounting Bitcoin uses — but wrapped in zero-knowledge so the notes
reveal nothing about owner or amount linkage.

> **Privacy invariant.** Pampalo's promise is *not* "the server can't
> see your seed phrase" (though that's also true). It is: **the link
> between a user's on-chain notes and their public Ethereum address is
> unbreakable by any observer.** See `CONTEXT.md` for the canonical
> statement.

---

## 2. The UTXO model: sum of inputs == sum of outputs

Every private payment in Pampalo obeys one iron rule:

```
Σ (input note amounts)  ==  Σ (output note amounts)      — per asset
```

You don't "edit a balance." You **destroy** some notes you own (the
*inputs*) and **create** new notes (the *outputs*), and the protocol
forces the totals to match for every asset involved. Value is never
minted or destroyed inside a transfer — only rearranged.

**Worked example — Alice pays Bob 2 USDC, and she only has a 5 USDC note:**

```
INPUTS (Alice destroys)        OUTPUTS (newly created)
┌─────────────────────┐        ┌─────────────────────┐
│ Note A              │        │ Note B → Bob        │
│ 5 USDC              │   ─►   │ 2 USDC              │
│ owner: Alice        │        ├─────────────────────┤
└─────────────────────┘        │ Note C → Alice      │
                               │ 3 USDC  (change)    │
        5 USDC          ==      └─────────────────────┘
                                      2 + 3 = 5 USDC
```

Note C is Alice's **change**, exactly like getting coins back at a shop.
The 5 USDC input note is now *spent* and can never be used again; two
fresh notes exist in its place.

Because the rule is enforced **per asset**, a single transfer can move
multiple distinct assets at once (multi-asset transfers), and the sums
must independently balance for each `asset_id`.

A few important consequences fall straight out of this model:

- **No partial spends.** To pay 2 from a 5-note you must consume the
  whole note and mint change. The note is the atom.
- **Privacy through indistinguishability.** An observer sees "some notes
  were spent, some were created," but the ZK proof hides *which* input
  maps to *which* output and *how much* each is worth.
- **The amounts are hidden, the conservation is proven.** The chain
  never learns the values, yet it is mathematically certain nothing was
  conjured from nothing.

> **🎨 Diagram brief — "Sum in = sum out" (the UTXO core)**
> A clean left→right flow: input notes on the left collapse into a
> transaction "box," output notes emerge on the right. Show the change
> note explicitly. A small `=` badge between the two columns reinforces
> conservation. Use this as the hero diagram for the whole concept —
> it's the one mental model everything else hangs off.

---

## 3. Notes: the unit of private value

A **note** is a four-tuple:

| Field          | Meaning                                                        | Public on-chain? |
| -------------- | ------------------------------------------------------------- | ---------------- |
| `asset_id`     | Which token (ERC-20 address, or the sentinel ETH address)     | — (hidden in commitment) |
| `asset_amount` | How much (bounded to 128 bits — see §6)                       | — (hidden in commitment) |
| `owner`        | The recipient's **Poseidon identifier**                       | — (hidden in commitment) |
| `secret`       | A random per-note value chosen by the note's **creator**      | **Never** — this is the spend key |

### The commitment (the leaf)

The note itself is never published. What goes on-chain is its
**commitment** — a single hash that binds all four fields:

```
leaf = poseidon2( [asset_id, asset_amount, owner, secret] )
```

`poseidon2` is a SNARK-friendly hash over the BN254 scalar field. The
leaf is what gets inserted into the Merkle tree (§4). Anyone can see the
leaf; nobody can invert it to recover the fields, and **only the holder
of `secret` can prove ownership in zero-knowledge** and spend it.

### Who is the `owner`? The Poseidon identifier

`owner` is **not** an Ethereum address. It is the recipient's **Poseidon
identifier**:

```
owner = poseidon2( [owner_secret] )
```

where `owner_secret` is derived deterministically from the user's seed
phrase. This is the unlinkable on-chain identity: it lets a user **prove
inside a SNARK that they own a note** (by demonstrating knowledge of the
`owner_secret` that hashes to `owner`) **without ever revealing their
Ethereum address.**

Each user derives three distinct identities from one seed phrase:

- **EVM address** — the public, gas-paying handle (deposits, withdrawals).
- **Envelope key** — a secp256k1 public key, the ECIES target for
  receiving note secrets (§7).
- **Poseidon identifier** — the ZK-note recipient (`owner` above).

> **🎨 Diagram brief — "Anatomy of a note"**
> A single note card showing the four fields, with a one-way arrow into
> a `poseidon2(...)` hashing element that outputs the leaf commitment.
> Visually distinguish the **secret** (a key/lock motif — it's the spend
> authority) from the other three. A side panel can show the "one seed →
> three identities" fan-out (EVM address / Envelope key / Poseidon
> identifier) since "owner" is the Poseidon one, not an Ethereum address.
> This is a common point of confusion worth designing around.

---

## 4. Trees: where notes live

Every note commitment is a **leaf** in a **Merkle tree** — a binary hash
tree where each parent is `poseidon2(left, right)` of its two children,
all the way up to a single **root**.

### Why a Merkle tree?

The root is a ~32-byte fingerprint of the *entire* set of notes ever
created. To prove "my note is one of the real, accepted notes" you don't
reveal which leaf you are — you provide a **Merkle membership proof**: a
sibling hash for each level from your leaf up to the root. If
re-hashing your leaf up that path reproduces a known root, the note is
provably in the set. The proof reveals nothing about *which* leaf, only
that *some* valid leaf exists.

### Tree shape in Pampalo

| Property              | Value                                                |
| --------------------- | ---------------------------------------------------- |
| Height                | `TREE_HEIGHT = 12` (11 hashing levels above leaves)  |
| Capacity per tree     | `2^11 = 2048` leaves                                 |
| Hash                  | Poseidon2 over BN254                                  |
| Empty-leaf default    | `keccak256("TANGERINE") % PRIME` (the `ZERO_LEAF`)   |

A fresh tree is not "empty" in the zero sense — every unused slot holds
the `ZERO_LEAF` sentinel, and the `zeros[]` table precomputes the root
of an all-empty subtree at each level so insertions are cheap.

### Tree rotation (epochs)

A single 2048-leaf tree fills up. Rather than build one giant tree,
Pampalo uses a **sequence of fixed-height trees**. When the active tree
fills, the contract **rolls over to a new epoch**:

- `epoch` (the **tree index**) increments; `nextIndex` resets to 0.
- The old tree's final root is frozen and **remains valid forever**.

Because of this, every note is addressed by a **pair**: `tree_index`
(which tree) + `leaf_index` (position within it). Both travel with the
note and appear in the `LeafInserted` event.

### Every historical root stays valid

```solidity
mapping(uint256 => bool) public knownRoots; // every root ever, permanently true
```

This is crucial: a membership proof you generated last week against last
week's root is *still* verifiable today, even though many notes have
been added since. You never have to "refresh" your proof against a moving
target. When you spend, you simply prove against *any* root the contract
has ever recorded (`isKnownRoot`).

> **🎨 Diagram brief — "The note tree"**
> A binary Merkle tree, height 12 (you can abbreviate the middle levels
> with a "⋮"). Highlight one leaf in colour and trace its **membership
> path** — the sibling at each level — glowing up to the root. Show
> non-occupied slots as faint `ZERO_LEAF` placeholders. A companion
> "filmstrip" panel shows **epoch rollover**: Tree 0 (full, frozen root)
> → Tree 1 (filling) → Tree 2 (empty), with a note tagged `(tree_index,
> leaf_index)`. The takeaway: trees are append-only and old roots never
> expire.

---

## 5. Nullifiers: spending a note exactly once

Notes are never "deleted" from the tree (the tree is append-only). So how
does the protocol stop someone spending the same note twice?

Each time a note is spent, the spender publishes a **nullifier** — a
deterministic fingerprint of that specific note:

```
nullifier = poseidon2( [leaf_index, owner, secret, asset_id, asset_amount] )
```

The contract keeps a `nullifierUsed` set. Spending a note marks its
nullifier used; any later attempt to spend the same note produces the
same nullifier and is rejected ("Nullifier already spent").

Key properties:

- The nullifier is **unlinkable to the leaf** for outside observers — it
  includes the `secret`, which only the owner knows, so you can't tell
  *which* leaf a nullifier nullifies just by watching.
- It is **deterministic** — the same note always yields the same
  nullifier, which is exactly what makes double-spends detectable.

This is the private-money analogue of "marking a banknote as spent"
without revealing which banknote it was.

> **🎨 Diagram brief — "Spend = nullify"**
> Show a note leaf (stays in the tree, untouched) and a separate
> "nullifier registry" set. A spend action emits a nullifier token that
> drops into the registry. A second spend attempt of the same note
> bounces off (✗) because the nullifier is already present. Emphasise:
> the leaf is *not* removed — spentness lives in a separate set.

---

## 6. Zero-knowledge proofs: the four circuits

Every state-changing private operation is gated by a **ZK-SNARK proof**.
The proofs are written as **Noir circuits** and verified on-chain by
auto-generated Solidity verifier contracts. There are four circuits,
each named after its upstream role (filenames are bytecode-bound, so the
protocol surface translates them to friendlier verbs — see §8):

| Circuit             | Protocol verb        | Proves…                                                              |
| ------------------- | -------------------- | ------------------------------------------------------------------- |
| `deposit`           | **Shield**           | A new leaf correctly commits to `(asset_id, amount, owner, secret)`  |
| `transfer`          | **Transfer**         | Private notes → private notes, balanced, owned, in-tree              |
| `transfer_external` | **Unshield (bundled)** | Like transfer, but some outputs exit to public EVM addresses       |
| `withdraw`          | **Unshield**         | Private notes → pure public payout (no internal change notes)        |

All circuits share a single source of truth (`pum_lib`) for the leaf
hash, the Merkle-root computation, the nullifier hash, and `HEIGHT`, so
they can never drift apart on tree layout.

### What the transfer circuit proves (the heart of it)

For each of up to **`NOTE_COUNT = 3`** input notes and 3 output notes
(unused slots are "empty" notes with `asset_amount == 0`):

1. **Ownership.** `poseidon2([owner_secret]) == owner` — the prover
   knows the secret behind the note's owner identifier.
2. **Membership.** The input note's leaf re-hashes up its Merkle path to
   the public `root`. (The note is real and accepted.)
3. **Nullifier correctness.** The published nullifier matches the note's
   contents.
4. **Output commitment.** Each output's leaf equals the public
   `output_hashes[i]` the contract will insert.
5. **Balance.** For every `asset_id` on either side, Σ inputs == Σ
   outputs (§2).

All of this is proven **without revealing** the notes, the amounts, the
owners, or the Merkle paths. The contract sees only the *public inputs*:
the `root`, the `nullifiers`, and the `output_hashes`.

### The "mint from nothing" attack and the 128-bit guard

The balance check sums amounts as field elements over BN254 (modulus
`p ≈ 2^254`). A naive sum is exploitable: an attacker could pick two
output amounts `N` and `p − N` that wrap around to `0 mod p`, balancing
against an empty input set and **minting a note worth `N` out of thin
air.**

Pampalo closes this by bounding **every** amount to **128 bits**
(`assert_max_bit_size::<128>()`):

- 128 bits is comfortably above any real token supply (max-supply
  18-decimal tokens fit under 2^96; USDC's supply is ~2^54).
- But it makes `p − N` (a ~254-bit number) unrepresentable, so the
  overflow trick can't be constructed.

This bound is enforced at ingress (`deposit`) **and** re-asserted in
every spending circuit as belt-and-braces. There's even a
`should_fail` regression test wired into CI so the guard can never be
silently removed.

### Front-run resistance on exits

When value leaves to a public address (unshield), the recipient address
is a public input — a mempool watcher could try to rewrite it to steal
the payout. The circuit defends this by committing to
`poseidon2([exit_address]) == exit_address_hash`. Change the address in
the mempool and the proof no longer verifies.

> **🎨 Diagram brief — "The ZK proof as a sealed box"**
> A box labelled "Transfer proof." **Private witnesses go in** (input
> notes, secrets, Merkle paths, output notes) — draw these entering a
> sealed/locked side. **Public inputs come out** (root, nullifiers,
> output hashes) — the only things the chain sees. A checklist on the box
> face shows the 5 guarantees (owned ✓, in-tree ✓, balanced ✓, nullifier
> ✓, outputs committed ✓). The story: *the contract learns the rules
> were followed, and nothing else.* Optionally a second small panel for
> the field-overflow guard (a "128-bit fence" stopping the `p−N` trick).

---

## 7. How notes reach their recipient (encrypted payloads)

There's a chicken-and-egg problem: to spend a note, the recipient needs
its `secret` — but the secret must never be public, or anyone could spend
the note.

Solution: the note's **creator** generates the `secret`, then
**ECIES-encrypts it to the recipient's Envelope key** (a secp256k1 public
key the recipient publishes). The ciphertext is emitted on-chain
alongside the leaf:

- On **shield**, in the `ShieldQueued` event's `encryptedPayload`.
- On **transfer / unshieldBundled**, via the `NotePayload` event.

The recipient's wallet **scans** these events, tries to ECIES-decrypt
each payload with their Envelope *private* key, and on success learns the
`secret` — then stores the full note locally (IndexedDB) so it can spend
it later. Until a recipient successfully decrypts, no observer (not even
the recipient) can link that leaf to any address.

> Only the `secret` needs encrypting in the on-chain payload — `owner`,
> `asset_id`, and `asset_amount` for that emit are already public values;
> it's the `secret` that confers spend authority.

A human-readable receiving handle, **`name.pampalo.eth`** (an ENS
subname on L1), resolves to a recipient's Envelope key + Poseidon
identifier — so a sender types `alice.pampalo.eth` instead of pasting two
hex blobs. It deliberately does **not** publish the EVM address.

> **🎨 Diagram brief — "Sending a note's secret"**
> Sender side: creates a note, encrypts the secret to the recipient's
> **Envelope key** (padlock keyed to the recipient). The encrypted blob
> rides along with the on-chain leaf (show it attached to the tree
> insert / event). Recipient side: their wallet **scans** chain events
> and unlocks the secret with their Envelope private key, then files the
> note into local storage. Stress that the server/relayer never sees the
> plaintext secret. A small inset can show `alice.pampalo.eth` resolving
> to (Envelope key + Poseidon identifier).

---

## 8. The smart contracts on Ethereum

The on-chain layer is the `Pampalo` contract (which *is* the
`PoseidonMerkleTree`), plus four verifier contracts and a Poseidon2
hasher. One full set per chain is a **Pampalo deployment**.

```
                         ┌───────────────────────────────────────┐
                         │              Pampalo.sol               │
                         │   (extends PoseidonMerkleTree,         │
                         │    AccessControlEnumerable)            │
                         ├───────────────────────────────────────┤
   shield / shieldNative │  • shield queue + escrow              │
   ───────────────────►  │  • Merkle tree (leaves, roots, epochs)│
   transfer              │  • nullifier set                      │
   ───────────────────►  │  • monthly USD caps + price oracles   │
   unshield(Bundled)     │  • roles / compliance guards          │
   ───────────────────►  │  • kill switch                        │
                         └───────────────┬───────────────────────┘
                                         │ verify(proof, publicInputs)
                  ┌──────────────────────┼──────────────────────┐
                  ▼            ▼          ▼          ▼
            Deposit      Transfer    Withdraw   TransferExternal
            Verifier     Verifier    Verifier     Verifier
```

### The four protocol verbs

- **Shield** — public ERC-20/ETH → new private note. Depositor approves
  the contract, calls `shield(...)` (or `shieldNative` for ETH). The
  contract pulls the funds, verifies the `deposit` proof, and **queues**
  the note.
- **Transfer** — private note(s) → private note(s), entirely inside the
  tree. Spends inputs (via nullifiers), inserts output leaves. Verified
  by the `transfer` circuit. *Permissionless* — anyone (including a
  relayer, §9) may submit a valid transfer.
- **Unshield** — private note → public ERC-20/ETH at an arbitrary EVM
  address. Verified by the `withdraw` circuit.
- **Unshield (bundled)** — one proof that both creates internal change
  notes *and* pays out to public addresses. Verified by the
  `transfer_external` circuit.

> **Vocabulary note.** Upstream (`commbank.eth`) calls these
> deposit/withdraw; Pampalo's user- and protocol-facing copy uses
> **shield / unshield / transfer**. The circuit *filenames* stay
> upstream-named because they're bound to deployed bytecode.

### The shield queue + 1-hour wait (on-chain compliance)

Shielding is **not** instant. To give the protocol a compliance window,
a shielded asset is **escrowed** and a **wait** (`shieldWaitTime`,
default **1 hour**, floor 1 minute) begins before the leaf is inserted:

```
shield(...)  ──►  [ PendingShield: escrowed, unlockTime = now + 1h ]
                         │
        ┌────────────────┼────────────────────────────┐
        ▼                ▼                             ▼
  cancelShield     contestShield                  executeShield
  (shielder,       (VIGILANT_CITIZEN_ROLE,        (anyone, after wait)
   before unlock)   any time before execute)       └► leaf inserted ✓
        │                │
        └──── refund escrow + cap ────┘          executeShieldImmediate
                                                  (BOOTH_OPERATOR_ROLE,
                                                   bypass wait)
```

- **`executeShield(id)`** — callable by **anyone** once the wait
  elapses; inserts the leaf into the tree.
- **`cancelShield(id)`** — the shielder's own opt-out during the wait;
  refunds escrow.
- **`contestShield(id, reason)`** — a `VIGILANT_CITIZEN_ROLE` action that
  cancels a pending shield and **refunds the shielder inline** (e.g. a
  flagged source address). The refund is push-style — funds are back in
  the shielder's public wallet the moment `ShieldContested` fires; no
  "claim" step.
- **`executeShieldImmediate(id)`** — a `BOOTH_OPERATOR_ROLE` bypass of
  the wait (e.g. an in-person booth where compliance already happened).

The public `/sentry` route renders this **shield queue** across all
deployments.

### Monthly USD caps + price oracles

The two **crossover paths** (public↔private: shield and unshield) are
gated by a **per-address monthly USD cap** (default **$100.00**).
Each crossover is priced via a Chainlink-style `IPriceOracle`
(`priceUsdCents(amount, decimals)`), and the cents are charged against
the caller's monthly bucket (`shieldUsage` / `unshieldUsage`), which
resets each UTC month. Cancel/contest **refund** the shield cap.

> Note the asymmetry: **transfers inside the tree are uncapped and
> need no oracle** — they never touch the public layer, so they carry no
> USD-denominated compliance surface. Only the on/off ramps are metered.

### Roles & kill switch

| Role                    | Powers                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `DEFAULT_ADMIN_ROLE`    | Role administration (held by a Safe in production)          |
| `FINANCE_MANAGER_ROLE`  | Supported assets, caps, wait time, kill switch              |
| `VIGILANT_CITIZEN_ROLE` | `contestShield` (compliance cancels)                        |
| `BOOTH_OPERATOR_ROLE`   | `executeShieldImmediate` (wait bypass)                      |

A **kill switch** (`weAreFull` / `weFoundRoom`) can halt new shields
without freezing existing notes — holders can always still transfer and
unshield.

> **🎨 Diagram brief — "Smart-contract consensus / lifecycle"**
> Two complementary visuals:
> 1. **Contract topology** — the `Pampalo` hub with the four verifiers as
>    spokes; each entry point (shield / transfer / unshield / bundled)
>    routes its proof to its verifier before mutating tree / nullifier
>    state. Show the Merkle tree and nullifier set as the two pieces of
>    contract storage that change.
> 2. **Shield queue state machine** — states `Queued → Executed`,
>    `Queued → Cancelled`, `Queued → Contested`, with the actors and the
>    1-hour gate annotated on the transitions (use the ASCII flow above
>    as the skeleton). This is the clearest "consensus/compliance"
>    story: the wait window is where the protocol's social/legal layer
>    sits, enforced by code.

---

## 9. Relayers: paying gas without revealing yourself

There's a subtle leak even in a private transfer: **someone has to pay
the gas**, and the gas-payer's EVM address is public in the transaction.
If you broadcast your own transfer, you've just linked your EVM address
to that on-chain event — undermining the very unlinkability the notes
provide.

Pampalo's answer is the **relayer** (a.k.a. *gas sponsor*):

- The backend runs a pool of **5 interchangeable EOAs per sponsoring
  chain**, derived from a single `RELAYER_MNEMONIC` at
  `m/44'/60'/0'/0/{0..4}`.
- The user builds and proves the transfer **client-side**, then hands the
  *proof + public inputs + encrypted payloads* to a relayer, which
  broadcasts `Pampalo.transfer(...)` and pays the gas.
- Because `transfer` is **permissionless**, the relayer holds **no
  on-chain privilege** — its only "power" is having ETH for gas. It
  cannot alter the transfer, cannot see the notes, and cannot censor
  selectively without simply declining (at which point the user falls
  back).
- Account selection is **LRU among idle, funded accounts**, gated by an
  atomic Convex mutation so concurrent transfers on the same chain never
  collide on the same EOA.

A **sponsoring chain** is a deployment with `sponsoringTxs = true`; there
the transfer UI defaults to private (relayer-paid) broadcasting.

**Self-broadcast fallback.** If the chain isn't a sponsoring chain, or
the relayer pool is busy/exhausted, the wallet can pay gas and sign the
transfer itself. This works — but it **publicly links the user's EVM
address to the transfer event**, so the UI always surfaces an explicit
confirm dialog first; it's never silent.

> **🎨 Diagram brief — "The relayer breaks the gas link"**
> Two side-by-side scenarios.
> **(a) Self-broadcast:** user's EVM address → transaction → contract,
> with a red dotted "link!" lasso tying the address to the on-chain
> event.
> **(b) Relayer:** user (client-side, behind a privacy boundary)
> produces *proof + payload*, hands it to a relayer pool (5 EOAs, one
> picked LRU), and **the relayer's** address appears on-chain instead.
> The user's EVM address never touches the event. Annotate that the
> relayer can't read notes or change the transfer — it only pays gas.
> This pairs naturally with the §2 hero diagram as the "and nobody sees
> who sent it" capstone.

---

## 10. End-to-end: a payment's full journey

Putting it all together — Alice shields, then privately pays Bob:

```
1. SHIELD (Alice, public → private)
   Alice approves USDC → shield(proof, publicInputs, encPayload)
   → escrowed, 1-hour wait → executeShield → leaf in tree (Note A, 5 USDC)
   → Alice's wallet decrypts the payload, files Note A locally.

2. TRANSFER (Alice → Bob, private → private)
   Alice's wallet, client-side:
     • picks Note A as input, builds outputs: Note B (2→Bob) + Note C (3→Alice change)
     • encrypts Note B's secret to Bob's Envelope key, Note C's to her own
     • generates a `transfer` ZK proof (balanced, owned, in-tree)
   → hands proof + payloads to a RELAYER
   → relayer broadcasts transfer(...) and pays gas
   → contract: verifies proof, records Note A's nullifier (spent),
     inserts leaves B and C, emits NotePayload for each.
   → Bob's wallet scans, decrypts Note B's secret, files it. Bob is paid.
     No on-chain link from Alice's EVM address to Bob's, or to the amount.

3. UNSHIELD (Bob, private → public — later, optional)
   Bob proves `withdraw`, pays out Note B's value to any EVM address.
   Monthly USD cap applies; the exit address is front-run-protected.
```

At no point did Pampalo's server (Convex) see a plaintext note, a
secret, or the link between Alice's and Bob's addresses. The chain saw
balanced, valid proofs and a set of opaque commitments and nullifiers.

> **🎨 Diagram brief — "The full journey" (optional master swimlane)**
> A horizontal swimlane with three lanes: **Public chain**, **Pampalo
> contract / tree**, **Client (wallet)**. Walk the three steps above
> left→right. This is the "one diagram to rule them all" for an overview
> page — it can link out to the focused diagrams (§2 UTXO, §4 tree, §6
> proof, §9 relayer) as you drill in.

---

## Appendix: glossary quick-reference

| Term                    | One-liner                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| **Note**                | The unit of private value: `(asset_id, asset_amount, owner, secret)`.    |
| **Leaf / commitment**   | `poseidon2(asset_id, asset_amount, owner, secret)` — the note on-chain.  |
| **Secret**              | Per-note random spend key, known only to the holder.                     |
| **Poseidon identifier** | `poseidon2(owner_secret)` — the note's `owner`; unlinkable ZK identity.  |
| **Envelope key**        | secp256k1 public key; ECIES target for receiving a note's secret.        |
| **EVM address**         | Public, gas-paying Ethereum handle. Never the note `owner`.              |
| **Nullifier**           | `poseidon2(leaf_index, owner, secret, asset_id, asset_amount)`; spends a note once. |
| **Merkle tree**         | Append-only Poseidon2 tree of leaves; height 12, 2048 leaves/epoch.      |
| **Epoch / tree_index**  | Which tree; rolls over when full, old roots stay valid forever.          |
| **Shield**              | Public ERC-20/ETH → new private note (queued, 1-hour wait).              |
| **Transfer**            | Private note(s) → private note(s), inside the tree (relayer-broadcastable). |
| **Unshield**            | Private note → public payout at an EVM address.                          |
| **Relayer / gas sponsor** | Backend EOA that broadcasts a transfer so the user's EVM address stays unlinked. |

*Ground truth for this document lives in `circuits/`, `contracts/contracts/Pampalo.sol`, `contracts/contracts/PoseidonMerkleTree.sol`, and `CONTEXT.md`. Keep labels consistent with the canonical nouns defined there.*
