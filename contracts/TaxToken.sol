// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title  TaxToken (TTX)
 * @notice ERC-20 with a configurable transfer tax routed to a `taxWallet`, plus a
 *         per-address fee-exclusion allowlist.
 *
 * @dev SECURITY MODEL
 *      -----------------------------------------------------------------------
 *      1. NO CUSTOM TRANSFER LOGIC. All balance movement is delegated to
 *         OpenZeppelin v5 `ERC20`. This contract overrides exactly one hook,
 *         `_update()`, which in OZ v5 is the single funnel through which every
 *         mint, burn and transfer passes. Overriding it (rather than
 *         `transfer` / `transferFrom`) guarantees the tax cannot be bypassed by
 *         any code path, present or future.
 *      2. HARD CAP. `MAX_TAX_BPS` is a `constant` (5.00%) baked into bytecode.
 *         It is unreachable by any setter, so the owner can never escalate the
 *         tax toward a honeypot. There is no upgrade proxy; the cap is final.
 *      3. NO HIDDEN BLOCKLIST. There is no blacklist, no max-wallet, no
 *         max-transaction, no trading-enabled flag and no pause. A holder can
 *         always sell. The only owner powers are: adjust tax within [0, 5%],
 *         move the tax destination, and toggle fee exclusions.
 *      4. NO SafeMath. Solidity >=0.8 has checked arithmetic natively.
 *
 * @dev ALLOWANCE SEMANTICS (important for integrators)
 *      `transferFrom` spends allowance for the FULL `value` before `_update`
 *      runs. The tax is then deducted from that `value`, so the recipient
 *      receives `value - fee` while `value` is debited from the sender. This is
 *      standard fee-on-transfer behaviour; routers and vaults integrating this
 *      token MUST measure received balances rather than assuming that
 *      `amountIn == amountReceived`.
 */
contract TaxToken is ERC20, ERC20Burnable, Ownable {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Basis-point denominator. 10_000 bps == 100%.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Immutable guardrail: the tax can never exceed 5.00%.
    /// @dev Enforced in the constructor AND in `setTaxRate`. A compile-time
    ///      constant, so it cannot be modified by the owner.
    uint256 public constant MAX_TAX_BPS = 500;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Current transfer tax in basis points (200 == 2.00%).
    uint256 public taxRateBps;

    /// @notice Destination that accrues the transfer tax.
    address public taxWallet;

    /// @notice Addresses that neither pay nor trigger the transfer tax.
    mapping(address account => bool excluded) public isExcludedFromFee;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event TaxRateUpdated(uint256 oldRateBps, uint256 newRateBps);
    event TaxWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event FeeExclusionUpdated(address indexed account, bool excluded);

    // ---------------------------------------------------------------------
    // Errors (cheaper than revert strings; OZ v5 idiom)
    // ---------------------------------------------------------------------

    /// @dev Thrown when a supplied address is the zero address.
    error ZeroAddress();
    /// @dev Thrown when a requested tax rate exceeds `MAX_TAX_BPS`.
    error TaxRateExceedsCap(uint256 requestedBps, uint256 maxBps);
    /// @dev Thrown when a setter would be a no-op (saves gas, keeps logs clean).
    error NoChange();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param name_          Token name, e.g. "TaxToken".
     * @param symbol_        Token symbol, e.g. "TTX".
     * @param initialSupply_ Whole-token supply; scaled by `decimals()` here.
     * @param initialOwner_  Owner address (OZ v5 `Ownable` requires it explicitly).
     * @param taxWallet_     Address that receives the transfer tax.
     * @param taxRateBps_    Initial tax in bps; MUST be <= `MAX_TAX_BPS`.
     *
     * @dev The full supply is minted to `initialOwner_`. Minting routes through
     *      `_update` with `from == address(0)` and is therefore untaxed.
     *      The owner and the tax wallet are excluded from fees by default so
     *      that treasury operations and tax forwarding do not self-tax.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_,
        address initialOwner_,
        address taxWallet_,
        uint256 taxRateBps_
    ) ERC20(name_, symbol_) Ownable(initialOwner_) {
        // `Ownable(initialOwner_)` already reverts on a zero owner.
        if (taxWallet_ == address(0)) revert ZeroAddress();
        if (taxRateBps_ > MAX_TAX_BPS) {
            revert TaxRateExceedsCap(taxRateBps_, MAX_TAX_BPS);
        }

        taxWallet = taxWallet_;
        taxRateBps = taxRateBps_;

        // Bootstrap exclusions. Emitting events keeps off-chain indexers in sync
        // from block 0 rather than leaving the state implicit.
        isExcludedFromFee[initialOwner_] = true;
        emit FeeExclusionUpdated(initialOwner_, true);

        if (!isExcludedFromFee[taxWallet_]) {
            isExcludedFromFee[taxWallet_] = true;
            emit FeeExclusionUpdated(taxWallet_, true);
        }

        emit TaxWalletUpdated(address(0), taxWallet_);
        emit TaxRateUpdated(0, taxRateBps_);

        _mint(initialOwner_, initialSupply_ * (10 ** decimals()));
    }

    // ---------------------------------------------------------------------
    // Core hook: the ONLY overridden transfer logic
    // ---------------------------------------------------------------------

    /**
     * @notice Applies the transfer tax.
     * @dev Overrides the OZ v5 single mutation funnel. Invoked by `_mint`,
     *      `_burn` and `_transfer` (and therefore `transfer` / `transferFrom`).
     *
     *      Tax is SKIPPED when any of the following holds:
     *        - `from == address(0)`  -> mint. Taxing a mint would silently
     *                                   divert supply and break supply math.
     *        - `to == address(0)`    -> burn. Taxing a burn would let the owner
     *                                   siphon value from deflationary actions.
     *        - `taxRateBps == 0`     -> tax disabled.
     *        - either party excluded -> allowlisted (treasury, LP manager, ...).
     *
     *      Otherwise the fee is split off and settled as a SEPARATE
     *      `super._update` call, which emits its own `Transfer` event to the
     *      tax wallet. Two events per taxed transfer is intentional and is what
     *      block explorers and accounting tooling expect.
     *
     *      Reentrancy: `super._update` makes no external calls, so no guard is
     *      required. Recursion is impossible because the fee leg calls
     *      `super._update` directly, never `_update`.
     *
     *      Rounding: integer division floors the fee, so the protocol never
     *      over-charges the user.
     */
    function _update(address from, address to, uint256 value)
        internal
        virtual
        override(ERC20)
    {
        uint256 rate = taxRateBps;

        if (
            from == address(0) ||
            to == address(0) ||
            rate == 0 ||
            isExcludedFromFee[from] ||
            isExcludedFromFee[to]
        ) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * rate) / BPS_DENOMINATOR;

        // Dust guard: a `value` small enough to floor the fee to zero is passed
        // through whole rather than wasting gas on a zero-value Transfer event.
        if (fee == 0) {
            super._update(from, to, value);
            return;
        }

        // Fee leg first, then the net leg. `super._update` debits `from` on each
        // call, so an insufficient balance still reverts with OZ's
        // `ERC20InsufficientBalance`.
        super._update(from, taxWallet, fee);

        unchecked {
            // Safe: rate <= MAX_TAX_BPS (500) < BPS_DENOMINATOR, so fee < value.
            super._update(from, to, value - fee);
        }
    }

    // ---------------------------------------------------------------------
    // Owner controls (all capped, all evented)
    // ---------------------------------------------------------------------

    /**
     * @notice Sets the transfer tax rate.
     * @param newRateBps New rate in basis points. MUST be <= `MAX_TAX_BPS` (500).
     * @dev Anti-honeypot: a 100% (10_000 bps) rate is unreachable — the check
     *      below reverts anything above 5.00%. Pass 0 to disable the tax.
     */
    function setTaxRate(uint256 newRateBps) external onlyOwner {
        if (newRateBps > MAX_TAX_BPS) {
            revert TaxRateExceedsCap(newRateBps, MAX_TAX_BPS);
        }
        uint256 oldRateBps = taxRateBps;
        if (oldRateBps == newRateBps) revert NoChange();

        taxRateBps = newRateBps;
        emit TaxRateUpdated(oldRateBps, newRateBps);
    }

    /**
     * @notice Moves the tax destination.
     * @param newTaxWallet New recipient of transfer taxes. Cannot be zero.
     * @dev The incoming wallet is auto-excluded from fees so that forwarding
     *      collected tax does not re-tax it. The OUTGOING wallet is deliberately
     *      left excluded — silently re-taxing a previously trusted address is a
     *      footgun; revoke it explicitly with `setExcludedFromFee` if desired.
     */
    function setTaxWallet(address newTaxWallet) external onlyOwner {
        if (newTaxWallet == address(0)) revert ZeroAddress();
        address oldTaxWallet = taxWallet;
        if (oldTaxWallet == newTaxWallet) revert NoChange();

        taxWallet = newTaxWallet;

        if (!isExcludedFromFee[newTaxWallet]) {
            isExcludedFromFee[newTaxWallet] = true;
            emit FeeExclusionUpdated(newTaxWallet, true);
        }

        emit TaxWalletUpdated(oldTaxWallet, newTaxWallet);
    }

    /**
     * @notice Adds or removes an address from the fee-exclusion allowlist.
     * @param account  Address to update. Cannot be zero.
     * @param excluded `true` to bypass the tax, `false` to tax normally.
     * @dev Exclusion is symmetric: an excluded address pays no tax when SENDING
     *      and triggers no tax when RECEIVING.
     */
    function setExcludedFromFee(address account, bool excluded) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (isExcludedFromFee[account] == excluded) revert NoChange();

        isExcludedFromFee[account] = excluded;
        emit FeeExclusionUpdated(account, excluded);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Previews the fee and net amount for a hypothetical transfer.
     * @dev Read-only helper for front-ends and routers. Mirrors the `_update`
     *      predicate exactly; keep the two in sync if either is modified.
     */
    function previewTransfer(address from, address to, uint256 value)
        external
        view
        returns (uint256 fee, uint256 net)
    {
        uint256 rate = taxRateBps;

        if (
            from == address(0) ||
            to == address(0) ||
            rate == 0 ||
            isExcludedFromFee[from] ||
            isExcludedFromFee[to]
        ) {
            return (0, value);
        }

        fee = (value * rate) / BPS_DENOMINATOR;
        net = value - fee;
    }
}
