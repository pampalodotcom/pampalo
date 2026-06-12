import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { alchemyUrl, rpc } from "../lib/alchemy";

// Balance reconciliation cron (TRANSFERS.md §5). Default runtime — only
// needs fetch (no signing). Overwrites each relayer account's tracked
// balance with the true on-chain value, correcting optimistic-deduction
// drift, catching manual operator top-ups, and unwinding dropped txs.
//
// Separate from the shield-queue indexer so it can be paused independently
// when Alchemy is flaky. The ONLY writer of balanceLastReconciledAt.

export const reconcileBalances = internalAction({
  args: {},
  handler: async (ctx): Promise<{ reconciled: number }> => {
    const chains = await ctx.runQuery(
      internal.relayer.store._sponsoringChains,
      {},
    );
    const subByChain = new Map(chains.map((c) => [c.chainId, c.alchemySubdomain]));
    if (subByChain.size === 0) return { reconciled: 0 };

    const accounts = await ctx.runQuery(api.relayer.store.listRelayerAccounts, {});
    let reconciled = 0;
    for (const acct of accounts) {
      const subdomain = subByChain.get(acct.chainId);
      if (!subdomain) continue;
      try {
        const balHex = await rpc<string>(alchemyUrl(subdomain), "eth_getBalance", [
          acct.address,
          "latest",
        ]);
        await ctx.runMutation(internal.relayer.store.setReconciledBalance, {
          chainId: acct.chainId,
          accountIndex: acct.accountIndex,
          balanceWei: BigInt(balHex).toString(),
        });
        reconciled += 1;
      } catch {
        // Transient RPC failure — leave the stale balance; next tick retries.
      }
    }

    // Also refresh the compliance signer (Vigilant Citizen bot) per chain.
    for (const [chainId, subdomain] of subByChain) {
      const signer = await ctx.runQuery(
        internal.compliance.store._complianceSignerForChain,
        { chainId },
      );
      if (!signer) continue;
      try {
        const balHex = await rpc<string>(
          alchemyUrl(subdomain),
          "eth_getBalance",
          [signer.address, "latest"],
        );
        await ctx.runMutation(
          internal.compliance.store.setComplianceSignerBalance,
          { chainId, balanceWei: BigInt(balHex).toString() },
        );
      } catch {
        // Transient — next tick retries.
      }
    }
    return { reconciled };
  },
});
