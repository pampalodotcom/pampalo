import { ethers } from "ethers";

// Tiny ERC-20 approval helper for tests. Pulls gas price from the
// connected provider so it works against forked mainnet too.

export const approve = async (
  account: ethers.Signer,
  erc20Address: string,
  spender: string,
  amount: bigint,
) => {
  const provider = account.provider;
  if (!provider) throw new Error("Signer has no provider");
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;

  const erc20 = new ethers.Contract(
    erc20Address,
    [
      {
        constant: false,
        inputs: [
          { name: "_spender", type: "address" },
          { name: "_value", type: "uint256" },
        ],
        name: "approve",
        outputs: [{ name: "", type: "bool" }],
        payable: false,
        stateMutability: "nonpayable",
        type: "function",
      },
    ],
    account,
  );

  const tx = await erc20.approve(spender, amount, { gasPrice });

  return tx;
};
