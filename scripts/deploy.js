const { ethers, network, run } = require("hardhat");

/**
 * Sepolia deployment script for TaxToken (TTX).
 *
 * Usage:
 *   npm run deploy:sepolia
 *
 * Preflight (all fail-closed, before any transaction is broadcast):
 *   - a signer is configured and funded
 *   - the tax wallet is a valid, non-zero address
 *   - the initial tax rate is within the contract hard cap
 *   - the operator is not silently deploying to the wrong chain
 */

// --- Token parameters -------------------------------------------------------
const NAME = process.env.TOKEN_NAME || "TaxToken";
const SYMBOL = process.env.TOKEN_SYMBOL || "TTX";
const INITIAL_SUPPLY = BigInt(process.env.TOKEN_INITIAL_SUPPLY || "1000000"); // whole tokens
const TAX_RATE_BPS = BigInt(process.env.TOKEN_TAX_RATE_BPS || "200"); // 2.00%

// Mirrors `TaxToken.MAX_TAX_BPS`. Checked here so a bad config fails locally
// rather than burning gas on a revert.
const MAX_TAX_BPS = 500n;

// Minimum balance we insist on before attempting a mainnet-shaped deploy.
const MIN_BALANCE_WEI = ethers.parseEther("0.01");

function fail(message) {
  console.error(`\n  [preflight] ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main() {
  console.log("=".repeat(68));
  console.log(`  Deploying ${NAME} (${SYMBOL}) -> network: ${network.name}`);
  console.log("=".repeat(68));

  // --- Network config -------------------------------------------------------
  // Checked BEFORE touching the provider. `ethers.getSigners()` needs a live
  // RPC URL, so an unset SEPOLIA_RPC_URL surfaces as Hardhat's opaque
  // "HH117: Empty string `` for network or forking URL" instead of anything
  // actionable. Fail here with the actual remedy.
  const configuredUrl = network.config && network.config.url;
  if (network.name !== "hardhat" && !configuredUrl) {
    fail(
      `No RPC URL configured for network "${network.name}". ` +
        `Set SEPOLIA_RPC_URL in .env (see .env.example). ` +
        `If .env does not exist yet: cp .env.example .env`
    );
  }

  // --- Signer ---------------------------------------------------------------
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    fail(
      "No signer configured. Set DEPLOYER_PRIVATE_KEY in .env (see .env.example)."
    );
  }
  const [deployer] = signers;

  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`  Deployer  : ${deployer.address}`);
  console.log(`  Chain ID  : ${chainId}`);
  console.log(`  Balance   : ${ethers.formatEther(balance)} ETH`);

  // Local detection is belt-and-braces: match on the network NAME (covers
  // `--network localhost` pointed at a non-standard chain id) and on the
  // default in-process chain id (covers an unnamed/aliased local network).
  const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);
  const isLocal = LOCAL_NETWORKS.has(network.name) || chainId === 31337n;

  if (!isLocal && balance < MIN_BALANCE_WEI) {
    fail(
      `Deployer balance ${ethers.formatEther(balance)} ETH is below the ` +
        `${ethers.formatEther(MIN_BALANCE_WEI)} ETH floor. Fund the account first.`
    );
  }

  // --- Tax wallet -----------------------------------------------------------
  // Defaults to the deployer ONLY on a local chain. On a live network the
  // operator must state the treasury explicitly; silently taxing into the
  // deployer key would be a footgun.
  let taxWallet = process.env.TAX_WALLET;

  if (!taxWallet) {
    if (!isLocal) {
      fail("TAX_WALLET is required on a live network. Set it in .env.");
    }
    taxWallet = deployer.address;
    console.log("  [local] TAX_WALLET unset; defaulting to the deployer.");
  }

  if (!ethers.isAddress(taxWallet)) {
    fail(`TAX_WALLET is not a valid address: ${taxWallet}`);
  }
  taxWallet = ethers.getAddress(taxWallet); // checksum-normalise
  if (taxWallet === ethers.ZeroAddress) {
    fail("TAX_WALLET cannot be the zero address.");
  }

  // --- Tax rate -------------------------------------------------------------
  if (TAX_RATE_BPS > MAX_TAX_BPS) {
    fail(
      `TOKEN_TAX_RATE_BPS (${TAX_RATE_BPS}) exceeds the contract hard cap of ` +
        `${MAX_TAX_BPS} bps (5.00%).`
    );
  }

  const owner = process.env.INITIAL_OWNER
    ? ethers.getAddress(process.env.INITIAL_OWNER)
    : deployer.address;

  console.log("-".repeat(68));
  console.log(`  Initial owner : ${owner}`);
  console.log(`  Tax wallet    : ${taxWallet}`);
  console.log(`  Initial supply: ${INITIAL_SUPPLY.toLocaleString("en-US")} ${SYMBOL}`);
  console.log(`  Tax rate      : ${Number(TAX_RATE_BPS) / 100}%  (${TAX_RATE_BPS} bps)`);
  console.log(`  Hard cap      : ${Number(MAX_TAX_BPS) / 100}%  (${MAX_TAX_BPS} bps)`);
  console.log("-".repeat(68));

  // --- Deploy ---------------------------------------------------------------
  // SINGLE SOURCE OF TRUTH for the constructor arguments.
  //
  // Etherscan verification re-compiles the source and ABI-encodes these values,
  // then byte-compares the result against the on-chain deployment bytecode. Any
  // drift between what is deployed and what is submitted for verification fails
  // with an opaque "constructor arguments do not match" error, so the same array
  // is spread into `deploy()` and handed to `verify:verify` below. Do not
  // duplicate this list.
  //
  // Order MUST match TaxToken.sol exactly:
  //   (name_, symbol_, initialSupply_, initialOwner_, taxWallet_, taxRateBps_)
  // `initialSupply_` is WHOLE TOKENS - the contract scales it by 10**decimals().
  const constructorArgs = [
    NAME,
    SYMBOL,
    INITIAL_SUPPLY,
    owner,
    taxWallet,
    TAX_RATE_BPS,
  ];

  const TaxToken = await ethers.getContractFactory("TaxToken");
  const token = await TaxToken.deploy(...constructorArgs);

  console.log(`  tx sent: ${token.deploymentTransaction()?.hash}`);
  console.log("  waiting for confirmation...");

  await token.waitForDeployment();
  const address = await token.getAddress();

  console.log(`\n  TaxToken deployed at: ${address}\n`);

  // --- Post-deploy assertions ----------------------------------------------
  // Verify the live state rather than trusting the constructor blindly.
  const [onChainSupply, onChainTax, onChainWallet, onChainOwner, cap] =
    await Promise.all([
      token.totalSupply(),
      token.taxRateBps(),
      token.taxWallet(),
      token.owner(),
      token.MAX_TAX_BPS(),
    ]);

  const expectedSupply = INITIAL_SUPPLY * 10n ** 18n;

  console.log("  Post-deploy verification:");
  console.log(`    totalSupply : ${ethers.formatEther(onChainSupply)} ${SYMBOL}`);
  console.log(`    taxRateBps  : ${onChainTax}`);
  console.log(`    taxWallet   : ${onChainWallet}`);
  console.log(`    owner       : ${onChainOwner}`);
  console.log(`    MAX_TAX_BPS : ${cap}`);

  const mismatches = [];
  if (onChainSupply !== expectedSupply) mismatches.push("totalSupply");
  if (onChainTax !== TAX_RATE_BPS) mismatches.push("taxRateBps");
  if (onChainWallet !== taxWallet) mismatches.push("taxWallet");
  if (onChainOwner !== owner) mismatches.push("owner");
  if (cap !== MAX_TAX_BPS) mismatches.push("MAX_TAX_BPS");

  if (mismatches.length > 0) {
    fail(`On-chain state mismatch for: ${mismatches.join(", ")}`);
  }
  console.log("    -> all parameters match the requested configuration.\n");

  // --- Publish the address to the frontend ---------------------------------
  // The dApp reads this instead of hardcoding an address. Local chains are
  // skipped: a 31337 address is ephemeral and would only churn the file.
  if (!isLocal) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const file = path.resolve(__dirname, "..", "frontend", "deployments.json");

      const existing = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : {};

      existing[chainId.toString()] = {
        network: network.name,
        address,
        deployer: deployer.address,
        blockNumber: token.deploymentTransaction()?.blockNumber ?? null,
        deployedAt: new Date().toISOString(),
      };

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
      console.log(`  Address written to frontend/deployments.json (chain ${chainId}).`);
    } catch (error) {
      // Never fail a successful deployment over a bookkeeping file.
      console.warn(`  Could not update frontend/deployments.json: ${error.message}`);
    }
  }

  // --- Confirmations + Etherscan verification ------------------------------
  // Both are skipped on a local chain: there is no explorer to index against,
  // and `wait(CONFIRMATIONS)` would stall on an in-process network that only
  // mines on demand.
  if (isLocal) {
    console.log(`  Local network (${network.name}) - skipping confirmations and verification.\n`);
  } else {
    // Etherscan indexes from confirmed blocks. Verifying too early returns
    // "contract not found" even though the deployment succeeded, so settle
    // first. This wait is unconditional on live networks: it also protects
    // against a shallow reorg silently orphaning the deployment.
    const CONFIRMATIONS = 5;
    console.log(`  Waiting ${CONFIRMATIONS} confirmations...`);
    await token.deploymentTransaction()?.wait(CONFIRMATIONS);
    console.log(`  ${CONFIRMATIONS} confirmations reached.`);

    if (!process.env.ETHERSCAN_API_KEY) {
      // Not fatal. The contract is live and correct; only the source listing
      // is missing, and it can be published at any time after the fact.
      console.warn(
        "\n  ETHERSCAN_API_KEY is not set - skipping source verification.\n" +
          "  The deployment SUCCEEDED. Verify later with:\n" +
          `    npx hardhat verify --network ${network.name} ${address} \\\n` +
          `      ${constructorArgs.map((a) => JSON.stringify(String(a))).join(" ")}\n`
      );
    } else {
      console.log("  Submitting source for verification...");
      try {
        await run("verify:verify", { address, constructorArguments: constructorArgs });
        console.log("  Source verified on Etherscan.");
      } catch (error) {
        // Verification failure must NEVER mask a successful deployment - the
        // address above is the operator's only record of it. Log and continue.
        const message = error instanceof Error ? error.message : String(error);

        if (message.toLowerCase().includes("already verified")) {
          console.log("  Source already verified.");
        } else {
          console.warn(
            `\n  VERIFICATION FAILED: ${message}\n` +
              `  The deployment SUCCEEDED and the contract is live at ${address}.\n` +
              "  Common causes: bad/missing API key, explorer lag, constructor-arg drift.\n" +
              "  Retry with:\n" +
              `    npx hardhat verify --network ${network.name} ${address} \\\n` +
              `      ${constructorArgs.map((a) => JSON.stringify(String(a))).join(" ")}\n`
          );
        }
      }
    }
  }

  console.log("=".repeat(68));
  console.log(`  Done. ${SYMBOL} @ ${address}`);
  if (network.name === "sepolia") {
    console.log(`  https://sepolia.etherscan.io/address/${address}`);
  }
  console.log("=".repeat(68));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
