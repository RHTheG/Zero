require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/**
 * Hardhat configuration.
 *
 * Dependency surface is deliberately explicit rather than pulling in
 * `hardhat-toolbox`: fewer transitive packages means a smaller supply-chain
 * attack surface for a contract that will custody value.
 *
 * SECRETS: never inline a key here. Everything sensitive is read from `.env`,
 * which is git-ignored. See `.env.example`.
 */

const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

/**
 * Normalises a private key to the 0x-prefixed form Hardhat expects and drops
 * anything malformed, so a typo in `.env` surfaces as "no accounts configured"
 * instead of an opaque signer error mid-deploy.
 */
function accounts() {
  if (!DEPLOYER_PRIVATE_KEY) return [];
  const key = DEPLOYER_PRIVATE_KEY.startsWith("0x")
    ? DEPLOYER_PRIVATE_KEY
    : `0x${DEPLOYER_PRIVATE_KEY}`;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? [key] : [];
}

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // `paris` keeps the bytecode free of PUSH0, which some L2s and
      // side-chains still do not implement. Sepolia accepts either.
      evmVersion: "paris",
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts: accounts(),
      chainId: 11155111,
    },
  },

  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY || "",
    },
  },

  sourcify: {
    enabled: false,
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  mocha: {
    timeout: 60_000,
  },
};
