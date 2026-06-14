// ADR 0022 — the gate that decides whether a retired deployment's notes can be
// **withdrawn** (vs. shown read-only). The web "Withdraw" path proves with the
// bundled `transfer_external` circuit (via `unshieldBundled`); the OLD
// contract's `transferExternalVerifier` only accepts that proof if its vk
// equals the vk of the circuit THIS build bundles. So we gate on a vk-hash
// match between the archived deployment and the current bundle.
//
// Why a build-time constant rather than deriving the vk in the browser: the
// stored hash is bb's hash of the verification key (not the ACIR bytecode the
// client bundles), so an honest runtime comparison would need bb.js to
// materialise + hash the vk — heavy and version-fragile. The seeder already
// hardcodes this same value from `circuits/transfer_external/target/vk_hash`;
// we mirror it. **Bump both together whenever the transfer_external circuit
// changes** (a circuit-breaking redeploy), which correctly flips older
// deployments to read-only.

/** Hex of `circuits/transfer_external/target/vk_hash` for the bundled build.
 *  Must equal `circuitVkHash` in `convex/shieldQueue/seed.ts` DEPLOYMENTS. */
export const BUNDLED_TRANSFER_EXTERNAL_VK_HASH =
  "0x20c678968aada721f23c931227f996a37eb05407959b27f6e6119f6b1faf7085";

/** A retired deployment is withdrawable iff it recorded a circuit vk and that
 *  vk matches the circuit this build can prove with. Missing vk (archived
 *  before ADR 0022, or a circuit-breaking bump) ⇒ read-only. */
export function isRetiredDeploymentWithdrawable(archived: {
  circuitVkHash?: string | null;
}): boolean {
  const vk = archived.circuitVkHash;
  return (
    typeof vk === "string" &&
    vk.toLowerCase() === BUNDLED_TRANSFER_EXTERNAL_VK_HASH.toLowerCase()
  );
}
