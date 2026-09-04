# TaxToken (TTX)

An ERC-20 token built on **OpenZeppelin v5** with a configurable transfer tax, a
per-address fee-exclusion allowlist, and a **hardcoded 5% maximum tax rate** that
no owner action can exceed.

> **Status: unaudited.** This code has not been through a third-party security
> audit. Do not deploy it to mainnet with real value until it has been.

---

## Token parameters

| Parameter | Value |
| --- | --- |
| Name | `TaxToken` |
| Symbol | `TTX` |
| Decimals | `18` |
| Initial supply | `1,000,000 TTX` (minted to the initial owner) |
| Transfer tax | `2.00%` (200 bps), configurable |
| Maximum tax | `5.00%` (500 bps), **hardcoded constant** |
| Tax recipient | `taxWallet`, set in the constructor, owner-updatable |

---

## Architecture

### One hook, not four

OpenZeppelin v5 collapsed all balance mutation into a single internal function:

```solidity
function _update(address from, address to, uint256 value) internal virtual
```

`_mint`, `_burn`, `_transfer`, `transfer` and `transferFrom` all funnel through
it. `TaxToken` overrides **only** `_update` — no custom `transfer`, no custom
`transferFrom`, no reimplemented allowance logic, no SafeMath.

This matters for security: because there is exactly one chokepoint, there is no
code path that can move balances while skipping the tax, and no divergence
between `transfer` and `transferFrom` semantics.

### The tax path

```
_update(from, to, value)
   |
   +-- bypass if: from == 0 (mint)
   |              to   == 0 (burn)
   |              taxRateBps == 0
   |              isExcludedFromFee[from] || isExcludedFromFee[to]
   |        -> super._update(from, to, value)          // untouched
   |
   +-- otherwise:
          fee = value * taxRateBps / 10_000            // floored
          if fee == 0 -> super._update(from, to, value)   // dust guard
          else:
             super._update(from, taxWallet, fee)       // fee leg
             super._update(from, to, value - fee)      // net leg
```

Design notes:

- **Mints and burns are never taxed.** Taxing a mint would silently divert
  supply; taxing a burn would let the owner extract value from deflationary
  actions.
- **The fee leg calls `super._update`, never `_update`.** Recursion is
  structurally impossible.
- **No external calls** are made, so no reentrancy guard is needed.
- **The fee is floored**, so the contract never over-charges the sender.
  `fee < value` always holds because `taxRateBps <= 500 < 10_000`.
- **Two `Transfer` events per taxed transfer** (fee leg, then net leg). This is
  intentional and is what explorers and accounting tools expect.

### Fee exclusion

```solidity
mapping(address account => bool excluded) public isExcludedFromFee;

function setExcludedFromFee(address account, bool excluded) external onlyOwner;
```

Exclusion is **symmetric**: an excluded address pays no tax when sending *and*
triggers no tax when receiving. The initial owner and the tax wallet are
excluded at construction so treasury operations and fee forwarding do not
self-tax.

### Hard cap guardrail

```solidity
uint256 public constant MAX_TAX_BPS = 500; // 5.00%
```

`MAX_TAX_BPS` is a compile-time constant baked into the bytecode. It is checked
in the constructor and in `setTaxRate`, and there is no upgrade proxy — so the
cap is final. `setTaxRate(10_000)` reverts with `TaxRateExceedsCap`.

---

## Security properties

**What the owner *can* do**

- Set the tax anywhere in `[0, 500]` bps.
- Move `taxWallet` to another non-zero address.
- Toggle fee exclusion for any address.

**What the owner *cannot* do — by construction**

| Common rug vector | Status |
| --- | --- |
| Raise tax to 100% (honeypot) | Impossible; capped at 5% in bytecode |
| Blacklist / freeze a holder | Not implemented |
| Pause transfers | Not implemented |
| Max-wallet or max-tx limits | Not implemented |
| "Trading enabled" gate | Not implemented |
| Mint new supply after deploy | No public/owner mint; supply is fixed at construction |
| Upgrade the logic | Not upgradeable; no proxy, no delegatecall |

A holder can always sell, and always receives at least 95% of any transfer.

**Known trade-offs, stated explicitly**

- **Fee-on-transfer semantics.** `transferFrom` spends allowance for the full
  `value`, then the recipient receives `value - fee`. Routers and vaults
  integrating TTX must measure *received* balances, not assume
  `amountIn == amountReceived`. Naive AMM routes will revert on slippage unless
  the pair/router is fee-excluded.
- **Owner is a trusted role.** It is a single EOA by default. Use a multisig or
  timelock for anything holding real value. Calling `renounceOwnership()`
  permanently freezes the tax rate, tax wallet and exclusion list.
- **`setTaxWallet` leaves the outgoing wallet fee-excluded.** Silently
  re-taxing a previously trusted address would be a footgun; revoke it
  explicitly with `setExcludedFromFee` if that is what you want.

---

## Project layout

```
.
├── contracts/
│   └── TaxToken.sol          # the token; overrides _update() only
├── scripts/
│   ├── deploy.js             # deploy + preflight + post-deploy assertions + verify
│   ├── export-abi.js         # artifacts -> frontend/abi (runs on postcompile)
│   └── serve-frontend.js     # zero-dependency static server, 127.0.0.1 only
├── test/
│   └── TaxToken.test.js      # unit tests
├── frontend/                 # vanilla-JS dApp, no build step
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── abi/TaxToken.json     # GENERATED - do not edit
│   └── deployments.json      # written by deploy.js on live networks
├── hardhat.config.js
├── .env.example              # template; copy to .env (git-ignored)
└── .gitignore
```

---

## Setup

Requires **Node.js >= 18.18**.

```bash
npm install
cp .env.example .env      # then fill in .env
npm run compile
npm test
```

### Local deploy against an in-process chain

```bash
npm run deploy:local
```

### Sepolia deploy

Fill in `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and `TAX_WALLET` in `.env`,
fund the deployer with Sepolia ETH, then:

```bash
npm run deploy:sepolia
```

The script fails closed *before* broadcasting if the signer is missing or
underfunded, if `TAX_WALLET` is unset or invalid on a live network, or if the
requested rate exceeds the 5% cap. After deployment it reads the contract back
and asserts every parameter matches what was requested. If `ETHERSCAN_API_KEY`
is set, it waits 5 confirmations and verifies the source.

---

## Frontend (dApp)

A single-page interface for the token. Vanilla JS, no framework, no build step —
`ethers` is the only dependency and it loads from a CDN.

```bash
npm run compile      # also regenerates frontend/abi/TaxToken.json
npm run frontend     # http://127.0.0.1:5173
```

Then connect MetaMask and paste the deployed address (auto-filled on networks
present in `deployments.json`, and remembered per-chain thereafter).

**Features**

- **Wallet** — EIP-1193 connect, address and network pill (Sepolia / Localhost),
  live `accountsChanged` and `chainChanged` handling, and a one-click switch
  prompt on an unsupported chain.
- **Token** — name, symbol, total supply, current tax rate (% and bps), tax
  wallet, owner.
- **Balance & transfer** — your balance, a `Max` button, and a **live tax
  preview** read from the contract's own `previewTransfer(from, to, amount)`
  before you sign. The fee is never recomputed in JavaScript, so the preview
  cannot drift from `_update()`.
- **Admin (owner only)** — set the tax rate, with the 5% cap read from
  `MAX_TAX_BPS()` and enforced client-side before a transaction is sent; toggle
  fee exclusion for any address, showing its current status first.

**Security choices**

- **Nothing is hardcoded.** The ABI is generated from the Hardhat artifacts by
  `scripts/export-abi.js` (never hand-copied, and bytecode is deliberately
  excluded). The contract address comes from `deployments.json` or the address
  field. No private key is ever handled by the page.
- **`ethers` is version-pinned with Subresource Integrity.** The SRI hash was
  computed from the local `node_modules` build and verified byte-identical to
  the CDN copy. A tampered CDN file will not execute.
- **The dev server binds `127.0.0.1` only**, never `0.0.0.0`, and refuses path
  traversal outside `frontend/`.
- **Owner gating is UI convenience only.** `onlyOwner` is enforced on-chain
  regardless of what the page renders.
- All rendering goes through `textContent`, never `innerHTML`.
- Token amounts stay `BigInt` end-to-end; no float arithmetic touches a balance.

**Error handling** — wallet rejection (`ACTION_REJECTED` / 4001), a pending
wallet request (`-32002`), wrong network, insufficient ETH for gas, insufficient
token balance (caught before signing), invalid addresses, over-precision
amounts, and an address that holds no contract on the current chain. Contract
custom errors are decoded through the ABI, so a revert reads as
`Tax rate 600 bps exceeds the hard cap of 500 bps.` rather than a hex blob.

---

## Static analysis

Slither runs on every push and pull request as a separate CI job, in parallel
with the tests, so a security finding and a failing test are independent
signals rather than one masking the other.

**Policy:** `fail-on: medium` — any medium or high severity finding fails the
build. Informational, low and optimization results are printed in the job log
but do not block.

`slither.config.json` deliberately carries no comments: Slither logs every
unrecognised key, which floods the CI output. The rationale lives here instead.

| Setting | Why |
| --- | --- |
| `filter_paths: node_modules` | OpenZeppelin v5 is widely audited and not vendor-patched here. Its findings are unactionable without forking the library. |
| `exclude_informational`, `exclude_low`, `exclude_optimization` | Reported, but not merge-blocking. |
| `exclude_medium: false`, `exclude_high: false` | Explicitly **not** excluded — these are the ones that fail the build. |
| `detectors_to_exclude: naming-convention` | Constructor parameters use the trailing-underscore style (`name_`, `symbol_`) to disambiguate from the ERC20 getters they feed. OpenZeppelin house style, a deliberate readability choice. |
| `detectors_to_exclude: solc-version` | The compiler is pinned to an exact `0.8.24` rather than a floating caret range. Slither flags non-latest pins; an exact pin is the stronger supply-chain position, so the flag runs contrary to intent. |

Nothing that could mask a real vulnerability in `TaxToken.sol` is excluded.
Current status: **10 contracts, 57 detectors, 0 findings.**

### Dependency advisories

`npm audit` reports advisories in the Hardhat toolchain (`adm-zip`, `tmp`,
`undici`, `serialize-javascript`, `@ethersproject/abi`, `ethereumjs-util`).
All of them are **devDependencies** — build and test tooling. The only
production dependency is `@openzeppelin/contracts`, which ships Solidity
source, not JavaScript. None of these advisories reach the deployed contract or
the published frontend, which loads a version-pinned, SRI-verified `ethers`
bundle and nothing else.

---

## Test coverage

`npm test` exercises:

- **Deployment** — metadata, supply, owner, bootstrapped exclusions; constructor
  rejection of a zero tax wallet, zero owner, and an over-cap initial rate.
- **User-to-user tax** — exact 2% deduction, sender debited the full amount,
  both `Transfer` events, supply conservation, `transferFrom` allowance
  semantics, insufficient-balance revert, dust pass-through, floored rounding.
- **Tax wallet accrual** — balance increases by exactly the fee, accumulation
  across multiple transfers, untaxed fee forwarding.
- **Fee exclusion** — sender-excluded, recipient-excluded, owner-excluded,
  revocation restores taxing, event emission, `onlyOwner` gating, zero-address
  and no-op rejection.
- **Hard cap** — 5% accepted, 501 bps rejected, 10,000 bps (honeypot) rejected
  with state left intact, holder still receives 95% at max rate, tax disable via
  rate 0, `onlyOwner` gating.
- **Tax wallet admin** — rerouting, auto-exclusion of the new wallet, guards.
- **Burn** — `burn` and `burnFrom` untaxed, supply reduced.
- **`previewTransfer`** — matches settled amounts.

---

## Contract API

| Function | Access | Description |
| --- | --- | --- |
| `setTaxRate(uint256 bps)` | owner | Set tax in bps; reverts above 500 |
| `setTaxWallet(address)` | owner | Reroute fees; auto-excludes the new wallet |
| `setExcludedFromFee(address, bool)` | owner | Toggle fee exclusion |
| `previewTransfer(from, to, value)` | view | Returns `(fee, net)` for a hypothetical transfer |
| `burn(uint256)` / `burnFrom(address, uint256)` | public | ERC20Burnable; untaxed |
| `taxRateBps()` / `taxWallet()` / `isExcludedFromFee(address)` | view | Current config |
| `MAX_TAX_BPS()` / `BPS_DENOMINATOR()` | pure | `500` / `10_000` |

**Events:** `TaxRateUpdated`, `TaxWalletUpdated`, `FeeExclusionUpdated`, plus
standard `Transfer` / `Approval`.

**Custom errors:** `ZeroAddress`, `TaxRateExceedsCap(requested, max)`,
`NoChange`, plus OpenZeppelin's `OwnableUnauthorizedAccount`,
`OwnableInvalidOwner`, `ERC20InsufficientBalance`, `ERC20InsufficientAllowance`.

---

## License

MIT
