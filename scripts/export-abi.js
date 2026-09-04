#!/usr/bin/env node
/**
 * Exports the TaxToken ABI from the Hardhat build artifacts into the frontend.
 *
 *   node scripts/export-abi.js      (or: npm run abi)
 *
 * The frontend never carries a hand-copied ABI. A stale or hand-edited ABI is a
 * real hazard: encoded calldata silently stops matching the deployed contract,
 * and the resulting reverts are opaque. This script is the only writer of
 * `frontend/abi/TaxToken.json`, and it is re-run on every `npm run compile`.
 *
 * Only the ABI is emitted - not the bytecode. The frontend has no business
 * shipping deployable bytecode.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACT = path.join(
  ROOT,
  "artifacts",
  "contracts",
  "TaxToken.sol",
  "TaxToken.json"
);
const OUT_DIR = path.join(ROOT, "frontend", "abi");
const OUT_FILE = path.join(OUT_DIR, "TaxToken.json");

function main() {
  if (!fs.existsSync(ARTIFACT)) {
    console.error(
      `\n  Artifact not found: ${path.relative(ROOT, ARTIFACT)}\n` +
        "  Run `npx hardhat compile` first.\n"
    );
    process.exitCode = 1;
    return;
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));

  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    console.error("\n  Artifact contains no ABI - aborting.\n");
    process.exitCode = 1;
    return;
  }

  const payload = {
    _comment:
      "GENERATED FILE - do not edit. Produced by scripts/export-abi.js from " +
      "artifacts/contracts/TaxToken.sol/TaxToken.json. Run `npm run abi`.",
    contractName: artifact.contractName,
    abi: artifact.abi,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const fns = artifact.abi.filter((f) => f.type === "function").length;
  const events = artifact.abi.filter((f) => f.type === "event").length;
  const errors = artifact.abi.filter((f) => f.type === "error").length;

  console.log(
    `  ABI -> ${path.relative(ROOT, OUT_FILE)} ` +
      `(${fns} functions, ${events} events, ${errors} custom errors)`
  );
}

main();
