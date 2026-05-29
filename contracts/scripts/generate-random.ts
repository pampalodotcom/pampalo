import { ethers } from 'ethers'

async function main() {
  const seedPhrase = process.env.RELAYER_MNEMONIC!

  const test = ethers.Wallet.fromPhrase(seedPhrase)
  console.log(test.address)

  // console.log() the addresses of the first 5 accounts
  for (let i = 0; i < 5; i++) {
    const wallet = ethers.HDNodeWallet.fromPhrase(
      seedPhrase,
      undefined,
      `m/44'/60'/0'/0/${i}`,
    )
    console.log(`Account ${i}: ${wallet.address}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
