import { bytesToHex, hexToBytes } from "./protocol.ts";
import { submitCancel, submitFulfill } from "./match.ts";
import {
  bitcoinPrecisionAsset,
  contractFor,
  openSession,
  refreshScript,
  sameBinding,
  walletAssets,
  walletIdentity,
  type Session,
  type WalletAsset,
  type WalletIdentity,
} from "./session.ts";
import {
  AMOUNT_PRESETS,
  CARRIER_SATS,
  EXPLORER_URL,
  OPERATOR_URL,
  decodeOffer,
  encodeOffer,
  errorText,
  formatSats,
  isTxid,
  isXOnlyHex,
  parsePositiveInteger,
  parseWalletReturn,
  paymentRequest,
  planFulfill,
  walletConnectUrl,
  walletSendUrl,
  type OfferRecord,
} from "./protocol.ts";

const OFFERS_KEY = "standing-match.offers.v1";
const WALLET_KEY = "standing-match.wallet.v1";

type ShownCoin = {
  txid: string;
  vout: number;
  value: number;
  isSpent: boolean;
  spentBy?: string;
  isUnrolled?: boolean;
  assets: { assetId: string; amount: bigint }[];
};

type LiveOffer = {
  record: OfferRecord;
  loading: boolean;
  coins?: ShownCoin[];
  error?: string;
  cancelMessage?: string;
  binding: "same" | "different" | "unchecked";
};

type WalletView = { address: string; pubkey: string; identity?: WalletIdentity; error?: string };

const state: {
  session?: Session;
  sessionError?: string;
  wallet?: WalletView;
  holdings?: WalletAsset[];
  holdingsError?: string;
  holdingsLoading: boolean;
  offers: LiveOffer[];
  selected: Set<string>;
  banner?: { kind: "ok" | "error"; text: string };
  pendingUrl?: string;
  matchMessage?: string;
  busy: boolean;
} = {
  offers: [],
  selected: new Set(),
  holdingsLoading: false,
  busy: false,
};

const watched = new Set<string>();

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("missing #app");

app.append(
  el("header", {},
    el("p", { className: "kicker", text: "MutinyNet" }),
    el("h1", { text: "Standing match" }),
    el("p", { className: "lead", text: "Trader A funds MatchedSwap. Trader B funds another instance. Each funding is an ordinary send. A matcher spends the two coins as one transaction. Fulfill has no funder signature." }),
    picturesLink(),
  ),
  section("session", "Session"),
  section("next", "Next"),
  section("fund", "Fund an offer"),
  section("offers", "Offers"),
  section("match", "Matcher"),
);

const sessionBody = app.querySelector("#session .body") as HTMLElement;
const nextBody = app.querySelector("#next .body") as HTMLElement;
const fundBody = app.querySelector("#fund .body") as HTMLElement;
const offersBody = app.querySelector("#offers .body") as HTMLElement;
const matchBody = app.querySelector("#match .body") as HTMLElement;

const assetStatus = el("p", { className: "note" });
const offerAsset = assetSelect("Offer asset");
const offerAmount = satsField("Offer amount");
const wantAsset = assetSelect("Want asset");
const wantAmount = satsField("Want amount");
const fundButton = button("Fund with the wallet", () => { void fund(); });
const fundNote = el("p", { className: "note", text: `Amounts are satoshis. The wallet sends the offer asset. The carrier on that coin is ${CARRIER_SATS} sats.` });
const fundStatus = el("div");
fundBody.append(assetStatus, offerAsset.label, offerAmount.label, wantAsset.label, wantAmount.label, fundNote, fundButton, fundStatus);

loadStored();
importHash();
applyReturn(window.location.search);
render();
void boot();

window.addEventListener("storage", (event) => {
  if (event.key === OFFERS_KEY || event.key === WALLET_KEY) {
    loadStored();
    adoptWallet();
    render();
    void loadHoldings();
    void watchAll();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void loadHoldings();
  void watchAll();
});

async function boot() {
  try {
    state.session = await openSession();
    state.sessionError = undefined;
    adoptWallet();
    render();
    await Promise.all([loadHoldings(), watchAll()]);
  } catch (error) {
    state.sessionError = errorText(error);
    render();
  }
}

function loadStored() {
  state.offers = readOffers().map((record) => ({
    record,
    loading: true,
    binding: "unchecked" as const,
    coins: state.offers.find((offer) => offer.record.id === record.id)?.coins,
    error: state.offers.find((offer) => offer.record.id === record.id)?.error,
    cancelMessage: state.offers.find((offer) => offer.record.id === record.id)?.cancelMessage,
  }));
  const raw = localStorage.getItem(WALLET_KEY);
  if (!raw) {
    state.wallet = undefined;
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { address?: string; pubkey?: string };
    if (parsed.address && isXOnlyHex(parsed.pubkey)) {
      state.wallet = { address: parsed.address, pubkey: parsed.pubkey.toLowerCase() };
      return;
    }
  } catch {
    // The stored wallet is unreadable. The connect flow replaces it.
  }
  state.wallet = undefined;
}

function applyReturn(search: string) {
  const returned = parseWalletReturn(search);
  if (!returned) return;
  if (returned.error === "denied") state.banner = { kind: "error", text: "The wallet declined the request." };
  else if (returned.error) state.banner = { kind: "error", text: `The wallet returned ${returned.error}.` };
  if (returned.address && isXOnlyHex(returned.pubkey)) {
    const wallet = { address: returned.address, pubkey: returned.pubkey.toLowerCase() };
    localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
    state.wallet = wallet;
    if (!returned.error) state.banner = { kind: "ok", text: "The wallet shared this address and public key." };
  }
  if (returned.status === "sent" && returned.offerId) {
    const offer = state.offers.find((item) => item.record.id === returned.offerId);
    if (offer && isTxid(returned.txid)) {
      offer.record.fundingTxid = returned.txid.toLowerCase();
      saveOffers();
      state.banner = { kind: "ok", text: "The wallet reported the funding transaction." };
    } else if (offer) {
      state.banner = { kind: "error", text: "The wallet reported the send and did not return a transaction id. Paste the funding transaction on the offer." };
    }
  }
  const clean = new URL(window.location.href);
  for (const key of ["intent", "offer", "address", "pubkey", "status", "txid", "error"]) clean.searchParams.delete(key);
  window.history.replaceState(null, "", `${clean.pathname}${clean.search}${clean.hash}`);
  importHash();
}

function importHash() {
  const hash = window.location.hash;
  if (!hash.startsWith("#offer=")) return;
  const decoded = decodeOffer(hash.slice("#offer=".length));
  if (!decoded) {
    state.banner = { kind: "error", text: "This offer link could not be read." };
    return;
  }
  upsert(decoded);
}

function render() {
  renderSession();
  renderNext();
  renderOffers();
  renderMatch();
  fundButton.classList.toggle("is-next", nextStep() === "fund");
  const readyAssets = Boolean(state.holdings?.length) && !state.holdingsLoading && !state.holdingsError;
  fundButton.disabled = state.busy || !state.session || !state.wallet?.identity || !readyAssets;
  syncAssets();
}

function renderSession() {
  sessionBody.replaceChildren();
  const session = state.session;
  sessionBody.append(line(`Operator ${OPERATOR_URL}`));
  if (state.sessionError) sessionBody.append(note(state.sessionError, "error"));
  if (!session) {
    sessionBody.append(line("Connecting to MutinyNet."));
    return;
  }
  if (session.storageNote) sessionBody.append(line(session.storageNote));
  const delay = session.exitDelay;
  sessionBody.append(line(delay === undefined
    ? "The operator did not report the exit delay."
    : `Exit is the maker after ${delay.toString()} ${delay < 512n ? "blocks" : "seconds"}, once the coin is unrolled.`));
  if (session.emulator.error) sessionBody.append(note(session.emulator.error, "error"));
  else if (session.emulator.match === false) {
    sessionBody.append(note(`The pinned emulator key ${session.emulator.pinned} differs from the serving key ${session.emulator.served}.`, "error"));
  } else if (session.emulator.match) {
    sessionBody.append(line("The emulator key matches the key pinned for this network."));
  }
  if (!state.wallet) {
    sessionBody.append(line("No Arkade wallet is connected in this browser."));
    if (nextStep() !== "connect") {
      sessionBody.append(button("Connect an Arkade wallet", () => openConnect(), "secondary"));
    }
    return;
  }
  sessionBody.append(line(state.wallet.address));
  sessionBody.append(el("p", { className: "mono", text: state.wallet.pubkey }));
  if (state.wallet.error) sessionBody.append(note(state.wallet.error, "error"));
}

function renderNext() {
  nextBody.replaceChildren();
  if (state.banner) nextBody.append(note(state.banner.text, state.banner.kind === "ok" ? "ok" : "error"));
  const step = nextStep();
  if (step === "wait") {
    nextBody.append(line(state.sessionError ? "MutinyNet did not open a session." : "Waiting for MutinyNet."));
    return;
  }
  if (step === "connect") {
    nextBody.append(line("Connect an Arkade wallet. The wallet asks before it shares an address."));
    const connect = button("Connect an Arkade wallet", () => openConnect());
    connect.classList.add("is-next");
    nextBody.append(connect);
    if (state.pendingUrl) nextBody.append(linkBox(state.pendingUrl));
    return;
  }
  if (step === "cancel") {
    const offer = cancellable();
    nextBody.append(line("This offer is alone. Cancel returns that coin to the maker's Arkade address. The maker and the operator sign it."));
    if (offer) nextBody.append(button("Cancel this offer", () => { void cancel(offer); }, "danger is-next"));
    return;
  }
  if (step === "fulfill") {
    nextBody.append(line("Two standing offers are selected. Submit the fulfill. The funders do not sign it."));
    return;
  }
  nextBody.append(line("Fund an offer. The wallet sends the offer asset to the standing address."));
}

function renderOffers() {
  offersBody.replaceChildren();
  if (state.offers.length === 0) {
    offersBody.append(line("Funded offers show up here. Another browser opens an offer link and watches the same address."));
    return;
  }
  for (const offer of state.offers) {
    const card = el("article", { className: "offer" });
    card.append(el("h3", { text: offer.record.label }));
    card.append(el("p", { className: "mono", text: offer.record.address }));
    card.append(line(`${formatSats(BigInt(offer.record.offerAmount))} sats of ${assetLabel(offer.record.offerAssetId)} for at least ${formatSats(BigInt(offer.record.wantAmount))} sats of ${assetLabel(offer.record.wantAssetId)}`));
    card.append(line(`Pays ${offer.record.payoutAddress}`));
    if (offer.binding === "different") {
      card.append(note("This offer was bound to a different operator key or exit delay. This session derives a different address.", "error"));
    }
    if (offer.loading) card.append(line("Loading coins."));
    if (offer.error) card.append(note(offer.error, "error"));
    if (offer.coins) {
      const position = positionCoin(offer);
      const others = offer.coins.filter((coin) => coin !== position);
      if (offer.record.fundingTxid && !position) {
        card.append(line(`Waiting for funding transaction ${offer.record.fundingTxid}.`));
      }
      if (!offer.record.fundingTxid && offer.coins.length === 0 && !offer.loading) {
        card.append(line("No coin at this address yet."));
      }
      if (position) card.append(coinBlock(offer, position, true));
      for (const coin of others) card.append(coinBlock(offer, coin, false));
      if (!offer.record.fundingTxid && offer.coins.length > 0) {
        card.append(line("These coins are unrecorded. Paste the funding transaction to mark the standing offer."));
      }
    }
    const txInput = document.createElement("input");
    txInput.type = "text";
    txInput.value = offer.record.fundingTxid ?? "";
    txInput.placeholder = "funding transaction";
    txInput.spellcheck = false;
    txInput.addEventListener("change", () => {
      const value = txInput.value.trim();
      if (!value) {
        offer.record.fundingTxid = undefined;
      } else if (isTxid(value)) {
        offer.record.fundingTxid = value.toLowerCase();
      } else {
        offer.error = "A funding transaction is 64 hex characters.";
        renderOffers();
        return;
      }
      offer.error = undefined;
      saveOffers();
      render();
    });
    const txLabel = document.createElement("label");
    txLabel.textContent = "Funding transaction";
    txLabel.append(txInput);
    card.append(txLabel);
    const actions = el("div", { className: "row" });
    actions.append(button("Copy offer link", () => { void copyOffer(offer.record); }, "secondary"));
    actions.append(button("Refresh", () => { void reload(offer); }, "quiet"));
    if (canCancel(offer)) {
      actions.append(button("Cancel this offer", () => { void cancel(offer); }, "danger"));
    }
    card.append(actions);
    if (offer.cancelMessage) card.append(note(offer.cancelMessage, offer.cancelMessage.startsWith("Cancelled") ? "ok" : "error"));
    const open = positionCoin(offer);
    if (open && !open.isSpent && offer.binding !== "different") {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = state.selected.has(offer.record.id);
      box.addEventListener("change", () => {
        if (box.checked) state.selected.add(offer.record.id);
        else state.selected.delete(offer.record.id);
        render();
      });
      const label = document.createElement("label");
      label.className = "check";
      label.append(box, document.createTextNode("Include this standing offer in the fulfill"));
      card.append(label);
    }
    offersBody.append(card);
  }
}

function renderMatch() {
  matchBody.replaceChildren();
  matchBody.append(line("The matcher builds one transaction with the two standing offers. Input 0 and input 1 carry no funder signature."));
  const chosen = selectedOffers();
  if (chosen.length === 2 && state.session) {
    const plan = planFulfill(toSide(chosen[0]), toSide(chosen[1]));
    if (plan.problems.length > 0) {
      for (const problem of plan.problems) matchBody.append(note(problem, "error"));
    } else {
      plan.outputs.forEach((output, index) => {
        matchBody.append(line(`Output ${index} pays ${formatSats(output.amount)} sats and ${formatSats(output.assetAmount)} sats of ${assetLabel(output.assetId)}.`));
      });
    }
  } else {
    matchBody.append(line("Select two open standing offers."));
  }
  const fulfill = button("Submit fulfill", () => { void fulfillSelected(); });
  fulfill.disabled = state.busy || selectedOffers().length !== 2 || nextStep() === "wait";
  fulfill.classList.toggle("is-next", nextStep() === "fulfill");
  matchBody.append(fulfill);
  if (state.matchMessage) {
    const kind = state.matchMessage.startsWith("Fulfilled") ? "ok" : "error";
    matchBody.append(note(state.matchMessage, kind));
  }
  matchBody.append(el("p", { className: "note" }, link(EXPLORER_URL, "Arkade explorer")));
}

function coinBlock(offer: LiveOffer, coin: ShownCoin, position: boolean) {
  const block = el("div", { className: "coin" });
  const title = position ? "Standing offer" : "Direct send";
  block.append(el("p", {}, el("strong", { text: title })));
  if (!position) block.append(line("A direct send sits beside the standing offer. The funded coin is the position."));
  block.append(el("p", { className: "mono", text: `${coin.txid}:${coin.vout}` }));
  const assetText = coin.assets.length === 0
    ? "no asset"
    : coin.assets.map((entry) => `${formatSats(entry.amount)} sats of ${assetLabel(entry.assetId)}`).join(", ");
  block.append(line(`${coin.value} sats, ${assetText}`));
  block.append(line(coin.isSpent ? `Spent${coin.spentBy ? ` by ${coin.spentBy}` : ""}.` : "Open."));
  block.append(line(coin.isUnrolled === undefined
    ? "The indexer did not report whether this coin is unrolled."
    : `Unrolled: ${coin.isUnrolled ? "yes" : "no"}.`));
  const delay = BigInt(offer.record.exitDelay);
  const unit = delay < 512n ? "blocks" : "seconds";
  block.append(line(`Exit is the maker after ${delay.toString()} ${unit}, once this coin is unrolled.`));
  return block;
}

async function watchAll() {
  if (!state.session) return;
  await Promise.all(state.offers.map((offer) => reload(offer)));
}

async function reload(offer: LiveOffer) {
  const session = state.session;
  if (!session) return;
  offer.loading = true;
  offer.binding = sameBinding(session, offer) ? "same" : "different";
  if (offer.binding === "different") {
    offer.loading = false;
    offer.coins = undefined;
    render();
    return;
  }
  try {
    const contract = contractFor(session.client, offer);
    if (contract.address !== offer.record.address) {
      throw new Error("This session derived a different address from the recorded arguments.");
    }
    const script = offer.record.pkScriptHex;
    const listen = !watched.has(script);
    if (listen) watched.add(script);
    try {
      await contract.register({ label: offer.record.label });
      if (listen) {
        await contract.on("vtxo_received", () => { void reload(offer); });
        await contract.on("vtxo_spent", () => { void reload(offer); });
        await contract.on("connection_reset", () => { void reload(offer); });
      }
    } catch (error) {
      if (listen) watched.delete(script);
      throw error;
    }
    await refreshScript(session.client, offer.record.pkScriptHex);
    offer.coins = (await contract.getVtxos()).map(normalizeCoin);
    offer.error = undefined;
  } catch (error) {
    offer.error = errorText(error);
    offer.coins = undefined;
  } finally {
    offer.loading = false;
    render();
  }
}

async function fund() {
  const session = state.session;
  const wallet = state.wallet?.identity;
  if (!session || !wallet) return;
  fundStatus.replaceChildren();
  state.busy = true;
  render();
  try {
    if (!offerAsset.select.value || !wantAsset.select.value) {
      throw new Error("Choose the offer asset and the want asset from this wallet.");
    }
    const offerAssetId = await bitcoinPrecisionAsset(offerAsset.select.value);
    const wantId = await bitcoinPrecisionAsset(wantAsset.select.value);
    const offered = parsePositiveInteger(offerAmount.input.value, "Offer amount");
    const wanted = parsePositiveInteger(wantAmount.input.value, "Want amount");
    const held = state.holdings?.find((entry) => entry.id === offerAssetId);
    if (held && offered > held.sats) {
      throw new Error(`This wallet holds ${formatSats(held.sats)} sats of the offer asset.`);
    }
    const draft: OfferRecord = {
      id: crypto.randomUUID(),
      label: `Offer ${state.offers.length + 1}`,
      address: "",
      pkScriptHex: "",
      payoutAddress: wallet.address,
      payoutScriptHex: bytesToHex(wallet.pkScript),
      makerProgramHex: bytesToHex(wallet.program),
      userHex: bytesToHex(wallet.user),
      offerAssetId,
      offerAmount: offered.toString(),
      wantAssetId: wantId,
      wantAmount: wanted.toString(),
      serverKeyHex: bytesToHex(session.client.serverKey),
      emulatorKeyHex: session.emulator.pinned,
      exitDelay: session.exitDelay?.toString() ?? "",
    };
    const contract = contractFor(session.client, draft);
    draft.address = contract.address;
    draft.pkScriptHex = bytesToHex(contract.pkScript);
    await contract.register({ label: draft.label });
    upsert(draft);
    const request = paymentRequest(contract.address, offerAssetId, offered);
    const callback = callbackUrl({ intent: "fund", offer: draft.id });
    const url = walletSendUrl(callback, request);
    state.pendingUrl = url;
    fundStatus.replaceChildren(
      note(`Standing address ${contract.address}. The wallet has to approve the send.`, "ok"),
      linkBox(url),
    );
    openTab(url);
    await reload(state.offers.find((offer) => offer.record.id === draft.id)!);
  } catch (error) {
    fundStatus.replaceChildren(note(errorText(error), "error"));
  } finally {
    state.busy = false;
    render();
  }
}

function openConnect() {
  const url = walletConnectUrl(callbackUrl({ intent: "connect" }));
  state.pendingUrl = url;
  state.banner = undefined;
  render();
  openTab(url);
}

async function cancel(offer: LiveOffer) {
  const session = state.session;
  const coin = positionCoin(offer);
  if (!session || !coin || coin.isSpent) return;
  state.busy = true;
  offer.cancelMessage = undefined;
  render();
  try {
    const txid = await submitCancel(session, offer.record, coin);
    offer.cancelMessage = `Cancelled ${txid}`;
    state.banner = { kind: "ok", text: offer.cancelMessage };
  } catch (error) {
    offer.cancelMessage = errorText(error);
    state.banner = { kind: "error", text: offer.cancelMessage };
  } finally {
    state.busy = false;
    render();
  }
}

async function fulfillSelected() {
  const session = state.session;
  const chosen = selectedOffers();
  if (!session || chosen.length !== 2) return;
  state.busy = true;
  state.matchMessage = undefined;
  render();
  try {
    const [first, second] = chosen;
    const result = await submitFulfill(session, {
      offer: first.record,
      coin: positionCoin(first)!,
    }, {
      offer: second.record,
      coin: positionCoin(second)!,
    });
    state.matchMessage = `Fulfilled ${result.txid}. The two inputs carried no funder signature.`;
    state.selected.clear();
    await Promise.all(chosen.map((offer) => reload(offer)));
  } catch (error) {
    state.matchMessage = errorText(error);
  } finally {
    state.busy = false;
    render();
  }
}

function openTab(url: string) {
  const tab = window.open(url, "_blank", "noopener");
  if (!tab) {
    state.banner = { kind: "error", text: "The browser blocked the new tab. Open the wallet link shown on this page and approve it there." };
    render();
  }
}

function callbackUrl(params: Record<string, string>): string {
  const url = new URL(import.meta.env.BASE_URL, window.location.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function adoptWallet() {
  if (!state.session || !state.wallet) return;
  try {
    state.wallet.identity = walletIdentity(state.session, state.wallet.address, state.wallet.pubkey);
    state.wallet.error = undefined;
  } catch (error) {
    state.wallet.identity = undefined;
    state.wallet.error = errorText(error);
  }
}

function upsert(record: OfferRecord) {
  const existing = state.offers.find((offer) => offer.record.id === record.id || offer.record.address === record.address);
  if (existing) existing.record = { ...existing.record, ...record };
  else state.offers.push({ record, loading: true, binding: "unchecked" });
  saveOffers();
  render();
}

function saveOffers() {
  localStorage.setItem(OFFERS_KEY, JSON.stringify(state.offers.map((offer) => offer.record)));
}

function readOffers(): OfferRecord[] {
  const raw = localStorage.getItem(OFFERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as OfferRecord[];
    return parsed.filter((offer) => decodeOffer(encodeOffer(offer)));
  } catch {
    return [];
  }
}

function positionCoin(offer: LiveOffer): ShownCoin | undefined {
  if (!offer.record.fundingTxid || !offer.coins) return undefined;
  const matches = offer.coins.filter((coin) => coin.txid === offer.record.fundingTxid);
  return matches.find((coin) => coin.assets.some((entry) => entry.assetId === offer.record.offerAssetId)) ?? matches[0];
}

function canCancel(offer: LiveOffer): boolean {
  const coin = positionCoin(offer);
  return Boolean(coin && !coin.isSpent && state.wallet?.pubkey === offer.record.userHex && offer.binding === "same");
}

function cancellable(): LiveOffer | undefined {
  const open = state.offers.filter(canCancel);
  return open.length === 1 ? open[0] : undefined;
}

function selectedOffers(): LiveOffer[] {
  return state.offers.filter((offer) => {
    const coin = positionCoin(offer);
    return state.selected.has(offer.record.id) && coin && !coin.isSpent && offer.binding === "same";
  });
}

function toSide(offer: LiveOffer) {
  const coin = positionCoin(offer)!;
  return {
    offerAssetId: offer.record.offerAssetId,
    offerAmount: BigInt(offer.record.offerAmount),
    wantAssetId: offer.record.wantAssetId,
    wantAmount: BigInt(offer.record.wantAmount),
    payoutScript: hexToBytes(offer.record.payoutScriptHex),
    coin,
  };
}

function nextStep(): "wait" | "connect" | "fund" | "cancel" | "fulfill" {
  if (!state.session) return "wait";
  if (selectedOffers().length === 2) return "fulfill";
  if (!state.wallet?.identity) return "connect";
  if (cancellable()) return "cancel";
  return "fund";
}

function normalizeCoin(raw: {
  txid: string;
  vout: number;
  value: number | bigint;
  isSpent?: boolean;
  spentBy?: string;
  isUnrolled?: boolean;
  assets?: { assetId: string; amount: bigint | string | number }[];
}): ShownCoin {
  return {
    txid: raw.txid,
    vout: raw.vout,
    value: typeof raw.value === "bigint" ? Number(raw.value) : raw.value,
    isSpent: raw.isSpent === true || Boolean(raw.spentBy),
    spentBy: raw.spentBy || undefined,
    isUnrolled: raw.isUnrolled,
    assets: (raw.assets ?? []).map((entry) => ({
      assetId: entry.assetId,
      amount: typeof entry.amount === "bigint" ? entry.amount : BigInt(entry.amount),
    })),
  };
}

async function copyOffer(record: OfferRecord) {
  const url = new URL(import.meta.env.BASE_URL, window.location.origin);
  url.hash = `offer=${encodeOffer(record)}`;
  try {
    await navigator.clipboard.writeText(url.toString());
    state.banner = { kind: "ok", text: "Offer link copied." };
  } catch (error) {
    state.banner = { kind: "error", text: `${url.toString()} ${errorText(error)}` };
  }
  render();
}

function shortId(id: string): string {
  return id.length < 16 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

let holdingsTicket = 0;

async function loadHoldings() {
  const ticket = ++holdingsTicket;
  const session = state.session;
  const identity = state.wallet?.identity;
  if (!session || !identity) {
    state.holdings = undefined;
    state.holdingsError = undefined;
    state.holdingsLoading = false;
    syncAssets();
    return;
  }
  state.holdingsLoading = true;
  state.holdingsError = undefined;
  render();
  try {
    const assets = await walletAssets(session, identity);
    if (ticket !== holdingsTicket) return;
    state.holdings = assets;
    state.holdingsError = undefined;
  } catch (error) {
    if (ticket !== holdingsTicket) return;
    state.holdings = undefined;
    state.holdingsError = errorText(error);
  } finally {
    if (ticket === holdingsTicket) {
      state.holdingsLoading = false;
      render();
    }
  }
}

function syncAssets() {
  const assets = state.holdings ?? [];
  fillSelect(offerAsset.select, assets);
  fillSelect(wantAsset.select, assets);
  const locked = !state.wallet?.identity || state.holdingsLoading || assets.length === 0;
  offerAsset.select.disabled = locked;
  wantAsset.select.disabled = locked;
  assetStatus.className = state.holdingsError ? "error" : "note";
  if (!state.wallet?.identity) assetStatus.textContent = "Connect a wallet to choose an asset it holds.";
  else if (state.holdingsLoading) assetStatus.textContent = "Loading assets in this wallet.";
  else if (state.holdingsError) assetStatus.textContent = state.holdingsError;
  else if (assets.length === 0) assetStatus.textContent = "This wallet has no asset coins on MutinyNet.";
  else assetStatus.textContent = "Offer and want are assets in this wallet, in satoshis.";
}

function fillSelect(select: HTMLSelectElement, assets: WalletAsset[]) {
  const previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = assets.length ? "Choose an asset" : "No assets in this wallet";
  select.append(placeholder);
  for (const asset of assets) {
    const option = document.createElement("option");
    option.value = asset.id;
    const title = asset.ticker || asset.name || shortId(asset.id);
    option.textContent = `${title} · ${formatSats(asset.sats)} sats`;
    select.append(option);
  }
  if (assets.some((asset) => asset.id === previous)) select.value = previous;
  else if (assets.length === 1) select.value = assets[0].id;
}

function assetLabel(id: string): string {
  const held = state.holdings?.find((asset) => asset.id === id);
  return held?.ticker || held?.name || shortId(id);
}

function picturesLink(): HTMLElement {
  const anchor = document.createElement("a");
  anchor.href = `${import.meta.env.BASE_URL}pictures.html`;
  anchor.textContent = "The four pictures";
  return el("p", { className: "note" }, anchor);
}

function section(id: string, title: string): HTMLElement {
  const body = el("div", { className: "body" });
  const block = el("section", { id }, el("h2", { text: title }), body);
  return block;
}

function assetSelect(name: string): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const select = document.createElement("select");
  const label = document.createElement("label");
  label.append(document.createTextNode(name), select);
  return { label, select };
}

function satsField(name: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  const presets = document.createElement("div");
  presets.className = "presets";
  presets.setAttribute("role", "group");
  presets.setAttribute("aria-label", `${name} presets`);
  for (const preset of AMOUNT_PRESETS) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "preset";
    choice.dataset.sats = preset.toString();
    choice.textContent = `${formatSats(preset)} sats`;
    choice.addEventListener("click", () => {
      input.value = preset.toString();
      markPresets(presets, input.value);
    });
    presets.append(choice);
  }
  input.addEventListener("input", () => markPresets(presets, input.value));
  const label = document.createElement("label");
  label.append(document.createTextNode(`${name} (sats)`), input, presets);
  return { label, input };
}

function markPresets(group: HTMLElement, value: string) {
  for (const choice of group.querySelectorAll("button")) {
    choice.classList.toggle("is-selected", choice.dataset.sats === value);
  }
}

function button(text: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  if (className) node.className = className;
  node.addEventListener("click", onClick);
  return node;
}

function line(text: string): HTMLElement {
  return el("p", { className: "meta", text });
}

function note(text: string, kind: "error" | "ok"): HTMLElement {
  return el("p", { className: kind, text });
}

function link(href: string, text: string): HTMLAnchorElement {
  const node = document.createElement("a");
  node.href = href;
  node.textContent = text;
  node.target = "_blank";
  node.rel = "noopener";
  return node;
}

function linkBox(url: string): HTMLElement {
  const box = el("div", { className: "linkbox" });
  const input = document.createElement("input");
  input.type = "url";
  input.readOnly = true;
  input.value = url;
  box.append(line("Open this wallet link and approve it there."), input, el("p", {}, link(url, "Open the Arkade wallet")));
  return box;
}

function el(tag: string, props: { id?: string; className?: string; text?: string } = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  if (props.id) node.id = props.id;
  if (props.className) node.className = props.className;
  if (props.text) node.textContent = props.text;
  for (const child of children) node.append(child);
  return node;
}
