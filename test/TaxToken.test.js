const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * TaxToken (TTX) test suite.
 *
 * Coverage focus, in order of security relevance:
 *   1. Tax accounting is exact and conserves supply.
 *   2. Fee exclusions are honoured symmetrically (sender OR recipient).
 *   3. The 5% hard cap is unreachable (anti-honeypot).
 *   4. Every owner control is access-gated.
 *   5. Mints and burns are never taxed.
 */
describe("TaxToken", function () {
  const NAME = "TaxToken";
  const SYMBOL = "TTX";
  const INITIAL_SUPPLY = 1_000_000n; // whole tokens; contract scales by decimals()
  const TAX_BPS = 200n; // 2.00%
  const MAX_TAX_BPS = 500n; // 5.00% hard cap
  const BPS_DENOMINATOR = 10_000n;

  const ZERO = ethers.ZeroAddress;

  /** Expected fee for a raw (already-scaled) amount at a given bps rate. */
  const feeFor = (amount, bps = TAX_BPS) => (amount * bps) / BPS_DENOMINATOR;

  async function deployFixture() {
    const [owner, taxWallet, alice, bob, carol] = await ethers.getSigners();

    const TaxToken = await ethers.getContractFactory("TaxToken");
    const token = await TaxToken.deploy(
      NAME,
      SYMBOL,
      INITIAL_SUPPLY,
      owner.address,
      taxWallet.address,
      TAX_BPS
    );
    await token.waitForDeployment();

    const one = 10n ** (await token.decimals());
    const totalSupply = INITIAL_SUPPLY * one;

    return { token, TaxToken, owner, taxWallet, alice, bob, carol, one, totalSupply };
  }

  /**
   * Funds a non-excluded user from the owner (owner is fee-excluded, so this
   * transfer is untaxed and the user receives the exact amount).
   */
  async function fund(token, owner, user, amount) {
    await token.connect(owner).transfer(user.address, amount);
    expect(await token.balanceOf(user.address)).to.equal(amount);
  }

  // -------------------------------------------------------------------------
  describe("Deployment", function () {
    it("sets metadata and mints the full supply to the initial owner", async function () {
      const { token, owner, totalSupply } = await loadFixture(deployFixture);

      expect(await token.name()).to.equal(NAME);
      expect(await token.symbol()).to.equal(SYMBOL);
      expect(await token.decimals()).to.equal(18n);
      expect(await token.totalSupply()).to.equal(totalSupply);
      expect(await token.balanceOf(owner.address)).to.equal(totalSupply);
      expect(await token.owner()).to.equal(owner.address);
    });

    it("configures the tax rate, tax wallet and hard cap", async function () {
      const { token, taxWallet } = await loadFixture(deployFixture);

      expect(await token.taxRateBps()).to.equal(TAX_BPS);
      expect(await token.taxWallet()).to.equal(taxWallet.address);
      expect(await token.MAX_TAX_BPS()).to.equal(MAX_TAX_BPS);
      expect(await token.BPS_DENOMINATOR()).to.equal(BPS_DENOMINATOR);
    });

    it("bootstraps fee exclusions for the owner and the tax wallet", async function () {
      const { token, owner, taxWallet, alice } = await loadFixture(deployFixture);

      expect(await token.isExcludedFromFee(owner.address)).to.be.true;
      expect(await token.isExcludedFromFee(taxWallet.address)).to.be.true;
      expect(await token.isExcludedFromFee(alice.address)).to.be.false;
    });

    it("does not tax the initial mint", async function () {
      const { token, taxWallet } = await loadFixture(deployFixture);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("rejects a zero tax wallet", async function () {
      const { TaxToken, owner } = await loadFixture(deployFixture);

      await expect(
        TaxToken.deploy(NAME, SYMBOL, INITIAL_SUPPLY, owner.address, ZERO, TAX_BPS)
      ).to.be.revertedWithCustomError(TaxToken, "ZeroAddress");
    });

    it("rejects a zero owner", async function () {
      const { TaxToken, taxWallet } = await loadFixture(deployFixture);

      await expect(
        TaxToken.deploy(NAME, SYMBOL, INITIAL_SUPPLY, ZERO, taxWallet.address, TAX_BPS)
      ).to.be.revertedWithCustomError(TaxToken, "OwnableInvalidOwner");
    });

    it("rejects an initial tax rate above the hard cap", async function () {
      const { TaxToken, owner, taxWallet } = await loadFixture(deployFixture);

      await expect(
        TaxToken.deploy(
          NAME,
          SYMBOL,
          INITIAL_SUPPLY,
          owner.address,
          taxWallet.address,
          MAX_TAX_BPS + 1n
        )
      )
        .to.be.revertedWithCustomError(TaxToken, "TaxRateExceedsCap")
        .withArgs(MAX_TAX_BPS + 1n, MAX_TAX_BPS);
    });
  });

  // -------------------------------------------------------------------------
  describe("Standard user-to-user transfer tax", function () {
    it("deducts 2% from a transfer between two non-excluded users", async function () {
      const { token, owner, alice, bob, one } = await loadFixture(deployFixture);

      const funded = 1_000n * one;
      const sent = 100n * one;
      const fee = feeFor(sent); // 2 tokens
      const net = sent - fee; // 98 tokens

      await fund(token, owner, alice, funded);
      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(bob.address)).to.equal(net);
      expect(await token.balanceOf(alice.address)).to.equal(funded - sent);
      expect(fee).to.equal(2n * one);
      expect(net).to.equal(98n * one);
    });

    it("debits the sender the full amount, not just the net", async function () {
      const { token, owner, alice, bob, one } = await loadFixture(deployFixture);

      const funded = 500n * one;
      const sent = 250n * one;

      await fund(token, owner, alice, funded);
      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(alice.address)).to.equal(funded - sent);
    });

    it("emits two Transfer events: the fee leg and the net leg", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      const fee = feeFor(sent);

      await fund(token, owner, alice, 1_000n * one);

      await expect(token.connect(alice).transfer(bob.address, sent))
        .to.emit(token, "Transfer")
        .withArgs(alice.address, taxWallet.address, fee)
        .and.to.emit(token, "Transfer")
        .withArgs(alice.address, bob.address, sent - fee);
    });

    it("conserves total supply across a taxed transfer", async function () {
      const { token, owner, alice, bob, one, totalSupply } = await loadFixture(deployFixture);

      await fund(token, owner, alice, 1_000n * one);
      await token.connect(alice).transfer(bob.address, 777n * one);

      expect(await token.totalSupply()).to.equal(totalSupply);
    });

    it("taxes transferFrom while spending allowance for the full amount", async function () {
      const { token, owner, taxWallet, alice, bob, carol, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      const fee = feeFor(sent);

      await fund(token, owner, alice, 1_000n * one);
      await token.connect(alice).approve(carol.address, sent);
      await token.connect(carol).transferFrom(alice.address, bob.address, sent);

      // Allowance is consumed for `sent`, but only `sent - fee` lands on bob.
      expect(await token.allowance(alice.address, carol.address)).to.equal(0n);
      expect(await token.balanceOf(bob.address)).to.equal(sent - fee);
      expect(await token.balanceOf(taxWallet.address)).to.equal(fee);
    });

    it("reverts on insufficient balance rather than under-taxing", async function () {
      const { token, owner, alice, bob, one } = await loadFixture(deployFixture);

      await fund(token, owner, alice, 10n * one);

      await expect(
        token.connect(alice).transfer(bob.address, 11n * one)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });

    it("passes dust through untaxed when the fee floors to zero", async function () {
      const { token, owner, taxWallet, alice, bob } = await loadFixture(deployFixture);

      // 49 wei * 200 / 10_000 == 0 after integer division.
      await fund(token, owner, alice, 100n);
      await token.connect(alice).transfer(bob.address, 49n);

      expect(await token.balanceOf(bob.address)).to.equal(49n);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("rounds the fee down, never over-charging the sender", async function () {
      const { token, owner, taxWallet, alice, bob } = await loadFixture(deployFixture);

      // 1_050 * 200 / 10_000 == 21 exactly; 1_049 -> 20 (floored).
      await fund(token, owner, alice, 10_000n);
      await token.connect(alice).transfer(bob.address, 1_049n);

      expect(await token.balanceOf(taxWallet.address)).to.equal(20n);
      expect(await token.balanceOf(bob.address)).to.equal(1_029n);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tax wallet accrual", function () {
    it("increases the tax wallet balance by exactly the fee", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      const fee = feeFor(sent);

      await fund(token, owner, alice, 1_000n * one);

      const before = await token.balanceOf(taxWallet.address);
      await token.connect(alice).transfer(bob.address, sent);
      const after = await token.balanceOf(taxWallet.address);

      expect(after - before).to.equal(fee);
      expect(after).to.equal(2n * one);
    });

    it("accumulates fees across multiple transfers", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      await fund(token, owner, alice, 1_000n * one);

      const amounts = [100n * one, 250n * one, 50n * one];
      let expected = 0n;

      for (const amount of amounts) {
        await token.connect(alice).transfer(bob.address, amount);
        expected += feeFor(amount);
      }

      expect(await token.balanceOf(taxWallet.address)).to.equal(expected);
      expect(expected).to.equal(8n * one); // 2 + 5 + 1
    });

    it("does not tax the tax wallet when it forwards collected fees", async function () {
      const { token, owner, taxWallet, alice, bob, carol, one } = await loadFixture(deployFixture);

      await fund(token, owner, alice, 1_000n * one);
      await token.connect(alice).transfer(bob.address, 100n * one);

      const collected = await token.balanceOf(taxWallet.address);
      await token.connect(taxWallet).transfer(carol.address, collected);

      // Tax wallet is fee-excluded, so the forward is untaxed and fully lands.
      expect(await token.balanceOf(carol.address)).to.equal(collected);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  describe("Fee exclusion", function () {
    it("exempts a transfer when the SENDER is excluded", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      await fund(token, owner, alice, 1_000n * one);
      await token.connect(owner).setExcludedFromFee(alice.address, true);

      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(bob.address)).to.equal(sent);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("exempts a transfer when the RECIPIENT is excluded", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      await fund(token, owner, alice, 1_000n * one);
      await token.connect(owner).setExcludedFromFee(bob.address, true);

      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(bob.address)).to.equal(sent);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("does not tax the owner, who is excluded at construction", async function () {
      const { token, owner, taxWallet, alice, one } = await loadFixture(deployFixture);

      const sent = 1_000n * one;
      await token.connect(owner).transfer(alice.address, sent);

      expect(await token.balanceOf(alice.address)).to.equal(sent);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("re-applies the tax once an exclusion is revoked", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      await fund(token, owner, alice, 1_000n * one);

      await token.connect(owner).setExcludedFromFee(alice.address, true);
      await token.connect(alice).transfer(bob.address, sent);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);

      await token.connect(owner).setExcludedFromFee(alice.address, false);
      await token.connect(alice).transfer(bob.address, sent);
      expect(await token.balanceOf(taxWallet.address)).to.equal(feeFor(sent));
    });

    it("emits FeeExclusionUpdated", async function () {
      const { token, owner, alice } = await loadFixture(deployFixture);

      await expect(token.connect(owner).setExcludedFromFee(alice.address, true))
        .to.emit(token, "FeeExclusionUpdated")
        .withArgs(alice.address, true);
    });

    it("rejects a non-owner caller", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);

      await expect(token.connect(alice).setExcludedFromFee(bob.address, true))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("rejects the zero address and no-op writes", async function () {
      const { token, owner, alice } = await loadFixture(deployFixture);

      await expect(
        token.connect(owner).setExcludedFromFee(ZERO, true)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");

      await expect(
        token.connect(owner).setExcludedFromFee(alice.address, false)
      ).to.be.revertedWithCustomError(token, "NoChange");
    });
  });

  // -------------------------------------------------------------------------
  describe("Hard cap guardrail (anti-honeypot)", function () {
    it("allows a rate change up to and including 5%", async function () {
      const { token, owner } = await loadFixture(deployFixture);

      await expect(token.connect(owner).setTaxRate(MAX_TAX_BPS))
        .to.emit(token, "TaxRateUpdated")
        .withArgs(TAX_BPS, MAX_TAX_BPS);

      expect(await token.taxRateBps()).to.equal(MAX_TAX_BPS);
    });

    it("reverts one basis point above the cap", async function () {
      const { token, owner } = await loadFixture(deployFixture);

      await expect(token.connect(owner).setTaxRate(MAX_TAX_BPS + 1n))
        .to.be.revertedWithCustomError(token, "TaxRateExceedsCap")
        .withArgs(MAX_TAX_BPS + 1n, MAX_TAX_BPS);
    });

    it("makes a 100% honeypot rate unreachable", async function () {
      const { token, owner, alice, bob, one } = await loadFixture(deployFixture);

      await expect(token.connect(owner).setTaxRate(BPS_DENOMINATOR))
        .to.be.revertedWithCustomError(token, "TaxRateExceedsCap")
        .withArgs(BPS_DENOMINATOR, MAX_TAX_BPS);

      // The rate is untouched, so holders can still move value.
      expect(await token.taxRateBps()).to.equal(TAX_BPS);

      await fund(token, owner, alice, 1_000n * one);
      await token.connect(alice).transfer(bob.address, 100n * one);
      expect(await token.balanceOf(bob.address)).to.equal(98n * one);
    });

    it("caps the tax even at the maximum rate: a holder always receives >= 95%", async function () {
      const { token, owner, alice, bob, one } = await loadFixture(deployFixture);

      await token.connect(owner).setTaxRate(MAX_TAX_BPS);
      await fund(token, owner, alice, 1_000n * one);

      const sent = 100n * one;
      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(bob.address)).to.equal(95n * one);
    });

    it("supports disabling the tax entirely", async function () {
      const { token, owner, taxWallet, alice, bob, one } = await loadFixture(deployFixture);

      await token.connect(owner).setTaxRate(0n);
      await fund(token, owner, alice, 1_000n * one);

      const sent = 100n * one;
      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(bob.address)).to.equal(sent);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("rejects a non-owner rate change and no-op writes", async function () {
      const { token, owner, alice } = await loadFixture(deployFixture);

      await expect(token.connect(alice).setTaxRate(100n))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(
        token.connect(owner).setTaxRate(TAX_BPS)
      ).to.be.revertedWithCustomError(token, "NoChange");
    });
  });

  // -------------------------------------------------------------------------
  describe("Tax wallet administration", function () {
    it("routes fees to the new wallet and auto-excludes it", async function () {
      const { token, owner, taxWallet, alice, bob, carol, one } = await loadFixture(deployFixture);

      await expect(token.connect(owner).setTaxWallet(carol.address))
        .to.emit(token, "TaxWalletUpdated")
        .withArgs(taxWallet.address, carol.address)
        .and.to.emit(token, "FeeExclusionUpdated")
        .withArgs(carol.address, true);

      expect(await token.taxWallet()).to.equal(carol.address);
      expect(await token.isExcludedFromFee(carol.address)).to.be.true;

      await fund(token, owner, alice, 1_000n * one);
      const sent = 100n * one;
      await token.connect(alice).transfer(bob.address, sent);

      expect(await token.balanceOf(carol.address)).to.equal(feeFor(sent));
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("rejects the zero address, no-op writes and non-owner callers", async function () {
      const { token, owner, taxWallet, alice, carol } = await loadFixture(deployFixture);

      await expect(
        token.connect(owner).setTaxWallet(ZERO)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");

      await expect(
        token.connect(owner).setTaxWallet(taxWallet.address)
      ).to.be.revertedWithCustomError(token, "NoChange");

      await expect(token.connect(alice).setTaxWallet(carol.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });
  });

  // -------------------------------------------------------------------------
  describe("Burn", function () {
    it("burns without taxing and reduces total supply", async function () {
      const { token, owner, taxWallet, alice, one, totalSupply } = await loadFixture(deployFixture);

      const funded = 1_000n * one;
      const burned = 400n * one;

      await fund(token, owner, alice, funded);
      await token.connect(alice).burn(burned);

      expect(await token.balanceOf(alice.address)).to.equal(funded - burned);
      expect(await token.totalSupply()).to.equal(totalSupply - burned);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });

    it("burnFrom respects allowance and stays untaxed", async function () {
      const { token, owner, taxWallet, alice, bob, one, totalSupply } = await loadFixture(deployFixture);

      const burned = 100n * one;

      await fund(token, owner, alice, 1_000n * one);
      await token.connect(alice).approve(bob.address, burned);
      await token.connect(bob).burnFrom(alice.address, burned);

      expect(await token.totalSupply()).to.equal(totalSupply - burned);
      expect(await token.balanceOf(taxWallet.address)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  describe("previewTransfer", function () {
    it("matches the settled amounts for a taxed transfer", async function () {
      const { token, owner, alice, bob, one } = await loadFixture(deployFixture);

      const sent = 333n * one;
      await fund(token, owner, alice, 1_000n * one);

      const [fee, net] = await token.previewTransfer(alice.address, bob.address, sent);
      await token.connect(alice).transfer(bob.address, sent);

      expect(fee).to.equal(feeFor(sent));
      expect(await token.balanceOf(bob.address)).to.equal(net);
    });

    it("reports a zero fee for an excluded party", async function () {
      const { token, owner, alice, one } = await loadFixture(deployFixture);

      const sent = 100n * one;
      const [fee, net] = await token.previewTransfer(owner.address, alice.address, sent);

      expect(fee).to.equal(0n);
      expect(net).to.equal(sent);
    });
  });
});
