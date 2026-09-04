/**
 * TaxToken (TTX) dApp — vanilla JS + ethers v6 (UMD, SRI-pinned).
 *
 * Design rules:
 *   - No contract address is hardcoded. It comes from `deployments.json`
 *     (written by scripts/deploy.js) for the connected chain, or from the
 *     address field, persisted per-chain in localStorage.
 *   - The ABI is fetched from `abi/TaxToken.json`, generated from the Hardhat
 *     artifacts by scripts/export-abi.js. Never hand-copied.
 *   - Reads go through the wallet's provider; writes go through the signer.
 *     No third-party RPC, no analytics, no key material touched.
 *   - Every on-chain number stays a BigInt until the moment it is rendered.
 *     No float math on token amounts, ever.
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAINS = {
  11155111n: { name: "Sepolia", explorer: "https://sepolia.etherscan.io", supported: true },
  31337n: { name: "Localhost", explorer: null, supported: true },
  1337n: { name: "Localhost", explorer: null, supported: true },
};

/** Chain we offer to switch to when the wallet is on an unsupported network. */
const PREFERRED_CHAIN_ID = "0xaa36a7"; // 11155111

const STORAGE_KEY = "taxtoken.address"; // suffixed with the chain id

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  abi: null,
  deployments: {},
  provider: null,
  signer: null,
  account: null,
  chainId: null,
  read: null, // contract bound to the provider
  write: null, // contract bound to the signer
  token: null, // { name, symbol, decimals, totalSupply, taxRateBps, maxTaxBps, taxWallet, owner }
  balance: 0n,
  excluded: false,
  isOwner: false,
  busy: false,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const show = (el, visible = true) => {
  if (el) el.hidden = !visible;
};

/** Always assign user/chain-derived strings via textContent, never innerHTML. */
const setText = (id, text) => {
  const el = $(id);
  if (el) el.textContent = text;
};

function setStatus(id, message, kind = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = `status${kind ? ` status-${kind}` : ""}`;
}

function banner(message, { kind = "warn", actionLabel = null, onAction = null } = {}) {
  const box = $("banner");
  const btn = $("banner-action");
  setText("banner-text", message);
  box.className = `banner${kind === "err" ? " banner-err" : ""}`;
  show(box, true);

  const fresh = btn.cloneNode(true); // drop previous listeners
  btn.replaceWith(fresh);
  if (actionLabel && onAction) {
    fresh.textContent = actionLabel;
    show(fresh, true);
    fresh.addEventListener("click", onAction);
  } else {
    show(fresh, false);
  }
}

const clearBanner = () => show($("banner"), false);

function log(message, kind = "", href = null) {
  const list = $("log");
  const empty = list.querySelector(".log-empty");
  if (empty) empty.remove();

  const li = document.createElement("li");

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();
  li.append(time);

  const body = document.createElement("span");
  if (kind) body.className = `log-${kind}`;
  body.textContent = message;
  li.append(body);

  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "view ↗";
    li.append(" ", a);
  }

  list.prepend(li);
}

// ---------------------------------------------------------------------------
// Formatting (BigInt in, string out — no float arithmetic)
// ---------------------------------------------------------------------------

function fmtAmount(value, decimals, maxFrac = 6) {
  const raw = ethers.formatUnits(value, decimals);
  const [whole, frac = ""] = raw.split(".");
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  const grouped = BigInt(whole).toLocaleString("en-US");

  // Never render a non-zero dust amount as a flat "0".
  if (grouped === "0" && !trimmed && value > 0n) return `<0.${"0".repeat(maxFrac - 1)}1`;
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

const fmtBps = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Turns a wallet/provider/contract error into something a human can act on.
 * Custom errors are decoded through the contract interface so a revert reads as
 * "Tax rate 800 bps exceeds the 500 bps cap", not a hex blob.
 */
function describeError(err) {
  if (!err) return "Unknown error.";

  const code = err.code ?? err?.info?.error?.code ?? err?.error?.code;

  if (code === "ACTION_REJECTED" || code === 4001) {
    return "Transaction rejected in your wallet.";
  }
  if (code === "INSUFFICIENT_FUNDS") {
    return "Not enough ETH to pay for gas on this network.";
  }
  if (code === "NETWORK_ERROR" || code === "SERVER_ERROR") {
    return "Network error — the RPC endpoint is unreachable.";
  }
  if (code === -32002) {
    return "A wallet request is already pending. Open your wallet to continue.";
  }

  // Decode a custom error if the ABI knows it.
  let revert = err.revert ?? null;
  if (!revert && state.read) {
    const data = err.data ?? err?.info?.error?.data ?? err?.error?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length > 2) {
      try {
        revert = state.read.interface.parseError(data);
      } catch {
        /* not one of ours */
      }
    }
  }

  if (revert) {
    const d = state.token?.decimals ?? 18;
    switch (revert.name) {
      case "ZeroAddress":
        return "The zero address is not allowed here.";
      case "NoChange":
        return "No change — that value is already set.";
      case "TaxRateExceedsCap":
        return `Tax rate ${revert.args[0]} bps exceeds the hard cap of ${revert.args[1]} bps.`;
      case "OwnableUnauthorizedAccount":
        return "Only the contract owner can perform that action.";
      case "ERC20InsufficientBalance":
        return (
          `Insufficient balance: you hold ${fmtAmount(revert.args[1], d)} but ` +
          `tried to send ${fmtAmount(revert.args[2], d)}.`
        );
      case "ERC20InsufficientAllowance":
        return "Insufficient allowance for that transfer.";
      case "ERC20InvalidReceiver":
        return "That recipient address is not valid for this token.";
      default:
        return `${revert.name}(${revert.args.map(String).join(", ")})`;
    }
  }

  return err.shortMessage || err.reason || err.message || String(err);
}

/** Wraps an async action with a busy guard so a double-click can't double-send. */
async function guard(button, statusId, label, fn) {
  if (state.busy) return;
  state.busy = true;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    await fn();
  } catch (err) {
    const message = describeError(err);
    if (statusId) setStatus(statusId, message, "err");
    log(message, "err");
    console.error(err);
  } finally {
    state.busy = false;
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
    refreshTransferButton();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: ABI + deployment map
// ---------------------------------------------------------------------------

async function loadStaticData() {
  const res = await fetch("./abi/TaxToken.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ABI (HTTP ${res.status}). Run: npm run export-abi`);
  state.abi = (await res.json()).abi;

  // Optional. Written by scripts/deploy.js; absent before the first deploy.
  try {
    const dep = await fetch("./deployments.json", { cache: "no-store" });
    if (dep.ok) state.deployments = await dep.json();
  } catch {
    /* fine — the address field is the fallback */
  }
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

function hasWallet() {
  return typeof window.ethereum !== "undefined";
}

async function connect() {
  if (!hasWallet()) {
    banner("No EIP-1193 wallet detected. Install MetaMask to continue.", { kind: "err" });
    return;
  }

  clearBanner();
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts || accounts.length === 0) throw new Error("No account authorised.");

  state.provider = new ethers.BrowserProvider(window.ethereum);
  state.signer = await state.provider.getSigner();
  state.account = ethers.getAddress(accounts[0]);

  const net = await state.provider.getNetwork();
  state.chainId = net.chainId;

  renderWallet();
  log(`Connected ${shortAddr(state.account)}`, "ok");

  await afterNetworkResolved();
}

function renderWallet() {
  const known = CHAINS[state.chainId];
  const pill = $("network-pill");
  const label = known ? known.name : `Chain ${state.chainId}`;

  setText("network-name", label);
  pill.className = `pill ${known?.supported ? "pill-ok" : "pill-warn"}`;
  show(pill, true);

  const btn = $("btn-connect");
  btn.textContent = state.account ? shortAddr(state.account) : "Connect Wallet";
  btn.classList.toggle("btn-primary", !state.account);
}

/** Runs once the chain is known: warn if unsupported, then wire the contract. */
async function afterNetworkResolved() {
  const known = CHAINS[state.chainId];

  if (!known?.supported) {
    banner(
      `Unsupported network (chain ${state.chainId}). Switch to Sepolia or a local node.`,
      {
        kind: "err",
        actionLabel: "Switch to Sepolia",
        onAction: switchToSepolia,
      }
    );
    return;
  }

  clearBanner();

  // Prefer a recorded deployment for this chain; fall back to the last address
  // the user entered on this chain.
  const recorded = state.deployments?.[state.chainId.toString()]?.address;
  const remembered = localStorage.getItem(`${STORAGE_KEY}.${state.chainId}`);
  const field = $("contract-address");

  if (!field.value) field.value = recorded || remembered || "";
  if (field.value) await loadContract();
  else setStatus("contract-status", "Enter the deployed TaxToken address to begin.");
}

async function switchToSepolia() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: PREFERRED_CHAIN_ID }],
    });
  } catch (err) {
    // 4902 = chain unknown to the wallet. Adding it is the user's call, in
    // their wallet UI — we do not inject RPC endpoints on their behalf.
    if (err?.code === 4902) {
      banner("Sepolia is not configured in your wallet. Add it there, then reconnect.", {
        kind: "err",
      });
    } else {
      banner(describeError(err), { kind: "err" });
    }
  }
}

// ---------------------------------------------------------------------------
// Contract wiring
// ---------------------------------------------------------------------------

async function loadContract() {
  const raw = $("contract-address").value.trim();
  const field = $("contract-address");

  if (!ethers.isAddress(raw)) {
    field.setAttribute("aria-invalid", "true");
    setStatus("contract-status", "That is not a valid address.", "err");
    return;
  }
  field.removeAttribute("aria-invalid");

  const address = ethers.getAddress(raw);

  // Guard against pointing at an EOA or at the right address on the wrong
  // chain — otherwise every read returns empty data and the UI shows garbage.
  const code = await state.provider.getCode(address);
  if (code === "0x") {
    setStatus(
      "contract-status",
      `No contract at ${shortAddr(address)} on ${CHAINS[state.chainId]?.name ?? "this network"}.`,
      "err"
    );
    show($("section-token"), false);
    show($("section-wallet"), false);
    show($("section-admin"), false);
    return;
  }

  state.read = new ethers.Contract(address, state.abi, state.provider);
  state.write = state.signer ? state.read.connect(state.signer) : null;
  localStorage.setItem(`${STORAGE_KEY}.${state.chainId}`, address);

  setStatus("contract-status", `Loaded ${address}`, "ok");
  await refreshAll();
}

async function refreshAll() {
  if (!state.read) return;

  const c = state.read;
  const [name, symbol, decimals, totalSupply, taxRateBps, maxTaxBps, taxWallet, owner] =
    await Promise.all([
      c.name(),
      c.symbol(),
      c.decimals(),
      c.totalSupply(),
      c.taxRateBps(),
      c.MAX_TAX_BPS(),
      c.taxWallet(),
      c.owner(),
    ]);

  state.token = {
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply,
    taxRateBps,
    maxTaxBps,
    taxWallet,
    owner,
  };

  setText("t-name", name);
  setText("t-symbol", symbol);
  setText("t-supply", `${fmtAmount(totalSupply, state.token.decimals, 2)} ${symbol}`);
  setText("t-tax", `${fmtBps(taxRateBps)} (${taxRateBps} bps)`);
  setText("t-taxwallet", taxWallet);
  setText("t-owner", owner);
  show($("section-token"), true);

  if (state.account) {
    const [balance, excluded] = await Promise.all([
      c.balanceOf(state.account),
      c.isExcludedFromFee(state.account),
    ]);
    state.balance = balance;
    state.excluded = excluded;

    setText("u-balance", fmtAmount(balance, state.token.decimals));
    document.querySelector(".balance-sym").textContent = symbol;
    show($("fee-status"), excluded);
    show($("section-wallet"), true);

    // Owner gating is a UI convenience only — the contract enforces onlyOwner
    // regardless of what this page chooses to render.
    state.isOwner = owner.toLowerCase() === state.account.toLowerCase();
    show($("section-admin"), state.isOwner);

    if (state.isOwner) {
      const capPct = Number(maxTaxBps) / 100;
      setText("cap-label", String(capPct));
      const rateInput = $("new-rate");
      rateInput.max = String(capPct);
      rateInput.placeholder = (Number(taxRateBps) / 100).toFixed(2);
    }
  }

  await updatePreview();
}

// ---------------------------------------------------------------------------
// Transfer + live preview
// ---------------------------------------------------------------------------

/** Parses the amount field into base units. Returns null when unusable. */
function parseAmount() {
  const raw = $("amount").value.trim();
  if (!raw) return null;
  try {
    const value = ethers.parseUnits(raw, state.token?.decimals ?? 18);
    return value > 0n ? value : null;
  } catch {
    return null; // more decimals than the token supports, or not a number
  }
}

function recipient() {
  const raw = $("to-address").value.trim();
  return ethers.isAddress(raw) ? ethers.getAddress(raw) : null;
}

async function updatePreview() {
  const box = $("preview");
  const to = recipient();
  const amount = parseAmount();

  if (!state.read || !state.account || !to || amount === null) {
    show(box, false);
    refreshTransferButton();
    return;
  }

  try {
    // Ask the contract, rather than recomputing the tax in JS. A local
    // reimplementation would drift from _update() the moment either changes.
    const [fee, net] = await state.read.previewTransfer(state.account, to, amount);
    const d = state.token.decimals;
    const sym = state.token.symbol;

    setText("p-fee", `${fmtAmount(fee, d)} ${sym}`);
    setText("p-net", `${fmtAmount(net, d)} ${sym}`);

    let note = "";
    if (fee === 0n && state.token.taxRateBps > 0n) {
      note = "No tax: sender or recipient is fee-excluded.";
    } else if (fee === 0n) {
      note = "Tax is currently disabled.";
    }
    setText("p-note", note);
    show(box, true);
  } catch (err) {
    show(box, false);
    console.error(err);
  }

  refreshTransferButton();
}

function refreshTransferButton() {
  const btn = $("btn-transfer");
  if (!btn) return;

  const to = recipient();
  const amount = parseAmount();
  const ok =
    !state.busy && !!state.write && !!to && amount !== null && amount <= state.balance;

  btn.disabled = !ok;

  if (amount !== null && amount > state.balance && state.token) {
    setStatus("contract-status", "Amount exceeds your balance.", "err");
  }
}

async function doTransfer() {
  const to = recipient();
  const amount = parseAmount();
  if (!to || amount === null) return;

  // Client-side pre-check. The contract reverts anyway, but failing here saves
  // the user a rejected transaction and a gas estimate round-trip.
  if (amount > state.balance) throw new Error("Amount exceeds your balance.");

  const sym = state.token.symbol;
  log(`Sending ${fmtAmount(amount, state.token.decimals)} ${sym} → ${shortAddr(to)}…`);

  const tx = await state.write.transfer(to, amount);
  const explorer = CHAINS[state.chainId]?.explorer;
  log(`Submitted ${tx.hash.slice(0, 10)}…`, "", explorer ? `${explorer}/tx/${tx.hash}` : null);

  const receipt = await tx.wait();
  log(`Confirmed in block ${receipt.blockNumber}`, "ok");

  $("amount").value = "";
  $("to-address").value = "";
  show($("preview"), false);
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function setTaxRate() {
  const raw = $("new-rate").value.trim();
  if (!raw) throw new Error("Enter a rate.");

  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0) throw new Error("Rate must be a positive number.");

  // Percent -> basis points. Reject sub-bps precision instead of rounding it
  // away silently: 0.005% is not expressible on-chain.
  const bpsFloat = pct * 100;
  if (!Number.isInteger(Math.round(bpsFloat * 1e6) / 1e6)) {
    throw new Error("Rate is limited to two decimal places (1 basis point).");
  }
  const bps = BigInt(Math.round(bpsFloat));

  // Mirror of the on-chain cap. The contract is still the authority; this only
  // avoids burning gas on a revert we can predict.
  if (bps > state.token.maxTaxBps) {
    throw new Error(
      `${pct}% exceeds the hard cap of ${fmtBps(state.token.maxTaxBps)} — rejected before sending.`
    );
  }
  if (bps === state.token.taxRateBps) throw new Error("That is already the current rate.");

  setStatus("rate-status", "Awaiting wallet confirmation…");
  const tx = await state.write.setTaxRate(bps);
  const explorer = CHAINS[state.chainId]?.explorer;
  log(`setTaxRate(${bps})`, "", explorer ? `${explorer}/tx/${tx.hash}` : null);

  await tx.wait();
  setStatus("rate-status", `Tax rate is now ${fmtBps(bps)}.`, "ok");
  log(`Tax rate set to ${fmtBps(bps)}`, "ok");
  $("new-rate").value = "";
  await refreshAll();
}

async function setExclusion(excluded) {
  const to = $("excl-address").value.trim();
  if (!ethers.isAddress(to)) throw new Error("Enter a valid address.");
  const address = ethers.getAddress(to);

  const current = await state.read.isExcludedFromFee(address);
  if (current === excluded) {
    throw new Error(`${shortAddr(address)} is already ${excluded ? "excluded" : "included"}.`);
  }

  setStatus("excl-current", "Awaiting wallet confirmation…");
  const tx = await state.write.setExcludedFromFee(address, excluded);
  const explorer = CHAINS[state.chainId]?.explorer;
  log(
    `setExcludedFromFee(${shortAddr(address)}, ${excluded})`,
    "",
    explorer ? `${explorer}/tx/${tx.hash}` : null
  );

  await tx.wait();
  setStatus(
    "excl-current",
    `${shortAddr(address)} is now ${excluded ? "excluded from" : "subject to"} the fee.`,
    "ok"
  );
  log(`${shortAddr(address)} ${excluded ? "excluded" : "included"}`, "ok");
  await refreshAll();
}

async function showExclusionStatus() {
  const raw = $("excl-address").value.trim();
  if (!ethers.isAddress(raw) || !state.read) {
    setStatus("excl-current", "");
    return;
  }
  try {
    const excluded = await state.read.isExcludedFromFee(ethers.getAddress(raw));
    setStatus("excl-current", excluded ? "Currently fee-excluded." : "Currently pays the fee.");
  } catch {
    setStatus("excl-current", "");
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function wireEvents() {
  // `guard` restores the button's original label in its finally block, which
  // would clobber the address that renderWallet() just wrote. Re-render after.
  $("btn-connect").addEventListener("click", async () => {
    await guard($("btn-connect"), null, "Connecting…", connect);
    renderWallet();
  });

  $("btn-load").addEventListener("click", () =>
    guard($("btn-load"), "contract-status", "Loading…", loadContract)
  );

  $("btn-refresh").addEventListener("click", () =>
    guard($("btn-refresh"), "contract-status", "…", refreshAll)
  );

  $("btn-transfer").addEventListener("click", () =>
    guard($("btn-transfer"), "contract-status", "Confirm in wallet…", doTransfer)
  );

  $("btn-max").addEventListener("click", () => {
    if (!state.token) return;
    $("amount").value = ethers.formatUnits(state.balance, state.token.decimals);
    updatePreview();
  });

  $("btn-set-rate").addEventListener("click", () =>
    guard($("btn-set-rate"), "rate-status", "Confirm…", setTaxRate)
  );

  $("btn-excl-on").addEventListener("click", () =>
    guard($("btn-excl-on"), "excl-current", "Confirm…", () => setExclusion(true))
  );

  $("btn-excl-off").addEventListener("click", () =>
    guard($("btn-excl-off"), "excl-current", "Confirm…", () => setExclusion(false))
  );

  $("btn-clear-log").addEventListener("click", () => {
    const list = $("log");
    list.replaceChildren();
    const li = document.createElement("li");
    li.className = "log-empty";
    li.textContent = "No activity yet.";
    list.append(li);
  });

  const onInput = debounce(updatePreview, 350);
  $("to-address").addEventListener("input", onInput);
  $("amount").addEventListener("input", onInput);
  $("excl-address").addEventListener("input", debounce(showExclusionStatus, 350));

  if (hasWallet()) {
    window.ethereum.on("accountsChanged", async (accounts) => {
      if (!accounts || accounts.length === 0) {
        // Wallet locked or access revoked — drop every derived permission.
        Object.assign(state, {
          account: null,
          signer: null,
          write: null,
          isOwner: false,
          balance: 0n,
        });
        show($("section-wallet"), false);
        show($("section-admin"), false);
        renderWallet();
        log("Wallet disconnected.");
        return;
      }
      state.account = ethers.getAddress(accounts[0]);
      state.signer = await state.provider.getSigner();
      if (state.read) state.write = state.read.connect(state.signer);
      renderWallet();
      log(`Account changed → ${shortAddr(state.account)}`);
      if (state.read) await refreshAll();
    });

    window.ethereum.on("chainChanged", async () => {
      // Rebuild the provider: a stale BrowserProvider keeps the old chain id.
      state.provider = new ethers.BrowserProvider(window.ethereum);
      state.signer = await state.provider.getSigner().catch(() => null);
      state.chainId = (await state.provider.getNetwork()).chainId;
      state.read = null;
      state.write = null;
      show($("section-token"), false);
      show($("section-wallet"), false);
      show($("section-admin"), false);
      $("contract-address").value = "";
      renderWallet();
      log(`Network changed → ${CHAINS[state.chainId]?.name ?? state.chainId}`);
      await afterNetworkResolved();
    });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  wireEvents();

  if (!hasWallet()) {
    banner("No EIP-1193 wallet detected. Install MetaMask to use this dApp.", { kind: "err" });
  }

  try {
    await loadStaticData();
  } catch (err) {
    banner(describeError(err), { kind: "err" });
    return;
  }

  // Reconnect silently if this site is already authorised — no wallet popup.
  if (hasWallet()) {
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts && accounts.length > 0) await connect();
    } catch (err) {
      console.error(err);
    }
  }
})();
