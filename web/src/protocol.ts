import { asset } from "@arkade-os/sdk";

export const OPERATOR_URL = "https://mutinynet.arkade.sh";
export const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
export const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh/";
export const WALLET_ORIGIN = "https://arkade.money/";
export const CARRIER_SATS = 330;
/** Asset amounts use bitcoin's 8 decimal places. One satoshi is one base unit. */
export const BITCOIN_DECIMALS = 8;
export const AMOUNT_PRESETS = [10_000n, 100_000n, 1_000_000n] as const;
const MAX_CONVERSION_DECIMALS = 18;

export type OfferRecord = {
  id: string;
  label: string;
  address: string;
  pkScriptHex: string;
  payoutAddress: string;
  payoutScriptHex: string;
  makerProgramHex: string;
  userHex: string;
  offerAssetId: string;
  offerAmount: string;
  wantAssetId: string;
  wantAmount: string;
  serverKeyHex: string;
  emulatorKeyHex: string;
  exitDelay: string;
  fundingTxid?: string;
};

export type WalletReturn = {
  intent?: string;
  offerId?: string;
  address?: string;
  pubkey?: string;
  status?: string;
  txid?: string;
  error?: string;
};

export type PlanSide = {
  offerAssetId: string;
  offerAmount: bigint;
  wantAssetId: string;
  wantAmount: bigint;
  payoutScript: Uint8Array;
  coin: {
    txid: string;
    vout: number;
    value: number;
    assets: { assetId: string; amount: bigint }[];
  };
};

export type PlannedOutput = {
  script: Uint8Array;
  amount: bigint;
  assetId: string;
  assetAmount: bigint;
  vin: number;
};

export type FulfillPlan = {
  problems: string[];
  outputs: PlannedOutput[];
};

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(value: string): Uint8Array {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Expected even-length hex.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function parsePositiveInteger(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(`${label} is a positive number of satoshis.`);
  }
  return BigInt(trimmed);
}

export function formatSats(amount: bigint): string {
  const text = amount.toString();
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function holdingsFromCoins(coins: { isSpent?: boolean; spentBy?: string; assets?: { assetId: string; amount: bigint }[] }[]): { id: string; sats: bigint }[] {
  const totals = new Map<string, bigint>();
  for (const coin of coins) {
    if (coin.isSpent || coin.spentBy) continue;
    for (const entry of coin.assets ?? []) {
      const id = canonicalAssetId(entry.assetId);
      totals.set(id, (totals.get(id) ?? 0n) + entry.amount);
    }
  }
  return [...totals.entries()]
    .filter(([, sats]) => sats > 0n)
    .map(([id, sats]) => ({ id, sats }))
    .sort((left, right) => (left.sats === right.sats ? left.id.localeCompare(right.id) : left.sats > right.sats ? -1 : 1));
}

export function canonicalAssetId(value: string): string {
  try {
    return asset.AssetId.fromString(value.trim()).toString();
  } catch (error) {
    throw new Error(`Asset id: ${errorText(error)}`);
  }
}

export function internalTxid(assetId: string): Uint8Array {
  return Uint8Array.from(asset.AssetId.fromString(assetId).txid).reverse();
}

export function groupIndex(assetId: string): bigint {
  return BigInt(asset.AssetId.fromString(assetId).groupIndex);
}

export function atomicToUnits(atomic: bigint, decimals: number): string {
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_CONVERSION_DECIMALS ? decimals : 0;
  if (places === 0) return atomic.toString();
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(places + 1, "0");
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return `${negative ? "-" : ""}${digits.slice(0, -places)}${fraction ? `.${fraction}` : ""}`;
}

export function usableDecimals(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_CONVERSION_DECIMALS) {
    return value;
  }
  return undefined;
}

export function paymentRequest(address: string, assetId: string, sats: bigint): string {
  if (sats <= 0n) throw new Error("The offer amount has to be a positive number of satoshis.");
  return `bitcoin:?ark=${address}&assetid=${assetId}&amount=${atomicToUnits(sats, BITCOIN_DECIMALS)}`;
}

export function walletConnectUrl(callback: string): string {
  const url = new URL(WALLET_ORIGIN);
  url.searchParams.set("action", "connect");
  url.searchParams.set("callback", callback);
  return url.toString();
}

export function walletSendUrl(callback: string, request: string): string {
  const url = new URL(WALLET_ORIGIN);
  url.searchParams.set("action", "send");
  url.searchParams.set("request", request);
  url.searchParams.set("callback", callback);
  return url.toString();
}

export function parseWalletReturn(search: string): WalletReturn | undefined {
  if (!search || search === "?") return undefined;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const result: WalletReturn = {
    intent: params.get("intent") ?? undefined,
    offerId: params.get("offer") ?? undefined,
    address: params.get("address") ?? undefined,
    pubkey: params.get("pubkey") ?? undefined,
    status: params.get("status") ?? undefined,
    txid: params.get("txid") ?? undefined,
    error: params.get("error") ?? undefined,
  };
  if (!result.intent && !result.address && !result.pubkey && !result.status && !result.txid && !result.error) {
    return undefined;
  }
  return result;
}

export function isXOnlyHex(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

export function isTxid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

const OFFER_FIELDS = [
  "id",
  "label",
  "address",
  "pkScriptHex",
  "payoutAddress",
  "payoutScriptHex",
  "makerProgramHex",
  "userHex",
  "offerAssetId",
  "offerAmount",
  "wantAssetId",
  "wantAmount",
  "serverKeyHex",
  "emulatorKeyHex",
  "exitDelay",
] as const;

export function encodeOffer(offer: OfferRecord): string {
  const bytes = new TextEncoder().encode(JSON.stringify(offer));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeOffer(encoded: string): OfferRecord | undefined {
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((encoded.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<OfferRecord>;
    for (const field of OFFER_FIELDS) {
      if (typeof parsed[field] !== "string" || parsed[field] === "") return undefined;
    }
    if (parsed.fundingTxid !== undefined && !isTxid(parsed.fundingTxid)) return undefined;
    parsePositiveInteger(parsed.offerAmount ?? "", "Offer amount");
    parsePositiveInteger(parsed.wantAmount ?? "", "Want amount");
    return {
      id: parsed.id ?? "",
      label: parsed.label ?? "",
      address: parsed.address ?? "",
      pkScriptHex: parsed.pkScriptHex ?? "",
      payoutAddress: parsed.payoutAddress ?? "",
      payoutScriptHex: parsed.payoutScriptHex ?? "",
      makerProgramHex: parsed.makerProgramHex ?? "",
      userHex: parsed.userHex ?? "",
      offerAssetId: parsed.offerAssetId ?? "",
      offerAmount: parsed.offerAmount ?? "",
      wantAssetId: parsed.wantAssetId ?? "",
      wantAmount: parsed.wantAmount ?? "",
      serverKeyHex: parsed.serverKeyHex ?? "",
      emulatorKeyHex: parsed.emulatorKeyHex ?? "",
      exitDelay: parsed.exitDelay ?? "",
      fundingTxid: parsed.fundingTxid,
    };
  } catch {
    return undefined;
  }
}

function soleAsset(side: PlanSide, name: string): { assetId: string; amount: bigint } | string {
  if (side.coin.assets.length !== 1) return `${name} carries ${side.coin.assets.length} assets. Fulfill requires one.`;
  return side.coin.assets[0];
}

export function planFulfill(first: PlanSide, second: PlanSide): FulfillPlan {
  const problems: string[] = [];
  const left = soleAsset(first, "The first offer");
  const right = soleAsset(second, "The second offer");
  if (typeof left === "string") problems.push(left);
  if (typeof right === "string") problems.push(right);
  if (typeof left === "string" || typeof right === "string") return { problems, outputs: [] };

  if (left.assetId !== first.offerAssetId) {
    problems.push("The first coin's asset is different from the offer asset.");
  }
  if (right.assetId !== second.offerAssetId) {
    problems.push("The second coin's asset is different from the offer asset.");
  }
  if (left.amount !== first.offerAmount) {
    problems.push(`The first coin holds ${left.amount} and the offer records ${first.offerAmount}.`);
  }
  if (right.amount !== second.offerAmount) {
    problems.push(`The second coin holds ${right.amount} and the offer records ${second.offerAmount}.`);
  }
  if (right.assetId !== first.wantAssetId) {
    problems.push("The second offer deposits a different asset from the first offer's want.");
  }
  if (left.assetId !== second.wantAssetId) {
    problems.push("The first offer deposits a different asset from the second offer's want.");
  }
  if (right.amount < first.wantAmount) {
    problems.push(`The second coin holds ${right.amount}, below the first offer's want of ${first.wantAmount}.`);
  }
  if (left.amount < second.wantAmount) {
    problems.push(`The first coin holds ${left.amount}, below the second offer's want of ${second.wantAmount}.`);
  }
  if (first.coin.value <= 0 || second.coin.value <= 0) {
    problems.push("Each standing offer carries a positive number of sats.");
  }
  if (problems.length > 0) return { problems, outputs: [] };

  return {
    problems,
    outputs: [
      {
        script: first.payoutScript,
        amount: BigInt(first.coin.value),
        assetId: right.assetId,
        assetAmount: right.amount,
        vin: 1,
      },
      {
        script: second.payoutScript,
        amount: BigInt(second.coin.value),
        assetId: left.assetId,
        assetAmount: left.amount,
        vin: 0,
      },
    ],
  };
}
