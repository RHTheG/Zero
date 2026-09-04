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
│   └── deploy.js             # Sepolia deploy + preflight + post-deploy assertions
├── test/
│   └── TaxToken.test.js      # unit tests
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
