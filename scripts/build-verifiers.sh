#!/usr/bin/env bash
#
# Build every Noir circuit under circuits/ and export its Solidity
# verifier into contracts/contracts/verifiers/. Renames the generated
# `HonkVerifier` to a per-circuit name so deployments can wire each
# verifier explicitly.
#
# Requires `nargo` and `bb` (Barretenberg) on PATH. Run from anywhere;
# the script anchors itself to the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUITS_DIR="$REPO_ROOT/circuits"
VERIFIERS_DIR="$REPO_ROOT/contracts/contracts/verifiers"
# Checked-in copy of each compiled circuit JSON. The wallet bundle
# imports from here (shared/classes/{Shield,Transfer,Unshield,
# UnshieldBundled}.ts) so Vercel + any other downstream build doesn't
# need `nargo` on PATH — it just sees the JSON in git. The Noir
# `target/` dir stays gitignored; this script keeps the two in sync
# as part of the verifier build.
SHARED_CIRCUITS_DIR="$REPO_ROOT/shared/circuits"

# Sanity: required tools.
for tool in nargo bb; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: \`$tool\` not on PATH." >&2
    exit 1
  fi
done

mkdir -p "$VERIFIERS_DIR"
mkdir -p "$SHARED_CIRCUITS_DIR"

# (circuit_dir, ContractName) pairs. The circuit dir name doubles as
# the bin name in the circuit's Nargo.toml — so target/<name>.json is
# what nargo compile produces. To add a new verifier: add one line.
CIRCUITS=(
  "deposit:DepositVerifier"
  "transfer:TransferVerifier"
  "transfer_external:TransferExternalVerifier"
  "withdraw:WithdrawVerifier"
  "redeem:RedeemVerifier"
)

build_one() {
  local circuit_name="$1"
  local contract_name="$2"
  local circuit_dir="$CIRCUITS_DIR/$circuit_name"
  local out_path="$VERIFIERS_DIR/$contract_name.sol"

  if [ ! -d "$circuit_dir" ]; then
    echo "Error: circuit directory $circuit_dir not found" >&2
    exit 1
  fi

  (
    cd "$circuit_dir"
    nargo compile
    bb write_vk -b "./target/${circuit_name}.json" -o ./target --oracle_hash keccak
    bb write_solidity_verifier -k ./target/vk -o ./target/contract.sol
  )

  mv "$circuit_dir/target/contract.sol" "$out_path"

  # Rename the generated `contract HonkVerifier` so each circuit's
  # verifier is independently addressable. `sed -i.bak` then rm of the
  # backup is the portable form that works on both macOS BSD sed and
  # GNU sed without needing the empty-string argument macOS demands.
  sed -i.bak "s/contract HonkVerifier/contract ${contract_name}/g" "$out_path"
  rm -f "${out_path}.bak"

  # Sync the compiled circuit JSON into the checked-in shared/circuits
  # location the wallet bundle imports from.
  cp "$circuit_dir/target/${circuit_name}.json" \
     "$SHARED_CIRCUITS_DIR/${circuit_name}.json"

  echo "  -> ${out_path#$REPO_ROOT/}"
  echo "  -> ${SHARED_CIRCUITS_DIR#$REPO_ROOT/}/${circuit_name}.json"
}

total=${#CIRCUITS[@]}
i=1
for entry in "${CIRCUITS[@]}"; do
  circuit="${entry%%:*}"
  contract="${entry##*:}"
  echo "[$i/$total] $circuit -> $contract"
  build_one "$circuit" "$contract"
  i=$((i + 1))
done

echo
echo "Done. ${total} verifiers written to ${VERIFIERS_DIR#$REPO_ROOT/}"
