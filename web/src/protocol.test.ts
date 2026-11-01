import { strict as assert } from "node:assert";
import { asset } from "@arkade-os/sdk";
import {
  atomicToUnits,
  canonicalAssetId,
  AMOUNT_PRESETS,
  decodeOffer,
  encodeOffer,
  formatSats,
  groupIndex,
  holdingsFromCoins,
  internalTxid,
  paymentRequest,
  planFulfill,
  parseWalletReturn,
  walletConnectUrl,
  walletSendUrl,
  type OfferRecord,
  type PlanSide,
} from "./protocol.ts";

const genesis = "11".repeat(32);
const assetId = asset.AssetId.create(genesis, 7).toString();

assert.equal(canonicalAssetId(assetId.toUpperCase()), assetId);
assert.equal(groupIndex(assetId), 7n);
assert.deepEqual(internalTxid(assetId), Uint8Array.from(asset.AssetId.fromString(assetId).txid).reverse());
assert.equal(atomicToUnits(150_000_000n, 8), "1.5");
assert.equal(atomicToUnits(1000n, 0), "1000");
assert.equal(formatSats(1_000_000n), "1,000,000");
assert.deepEqual(AMOUNT_PRESETS, [10_000n, 100_000n, 1_000_000n]);
assert.equal(
  paymentRequest("tark1qqexample", assetId, 1000n),
  `bitcoin:?ark=tark1qqexample&assetid=${assetId}&amount=0.00001`,
);
assert.equal(
  paymentRequest("tark1qqexample", assetId, 100_000_000n),
  `bitcoin:?ark=tark1qqexample&assetid=${assetId}&amount=1`,
);
assert.deepEqual(holdingsFromCoins([
  { assets: [{ assetId, amount: 1000n }, { assetId: asset.AssetId.create("22".repeat(32), 1).toString(), amount: 5n }] },
  { assets: [{ assetId: assetId.toUpperCase(), amount: 25n }] },
  { isSpent: true, assets: [{ assetId, amount: 9n }] },
  { spentBy: "ab".repeat(32), assets: [{ assetId, amount: 8n }] },
]), [
  { id: assetId, sats: 1025n },
  { id: asset.AssetId.create("22".repeat(32), 1).toString(), sats: 5n },
]);

const connect = new URL(walletConnectUrl("http://localhost:5173/?intent=connect"));
assert.equal(connect.searchParams.get("action"), "connect");
assert.equal(connect.searchParams.get("callback"), "http://localhost:5173/?intent=connect");
const request = paymentRequest("tark1qqexample", assetId, 5n);
const send = new URL(walletSendUrl("http://127.0.0.1:5173/?intent=fund&offer=abc", request));
assert.equal(send.searchParams.get("action"), "send");
assert.equal(send.searchParams.get("request"), request);
assert.equal(send.searchParams.get("callback"), "http://127.0.0.1:5173/?intent=fund&offer=abc");

const returned = parseWalletReturn("?intent=fund&offer=abc&status=sent&txid=" + "ab".repeat(32));
assert.equal(returned?.offerId, "abc");
assert.equal(returned?.status, "sent");
assert.equal(parseWalletReturn("") , undefined);
assert.equal(parseWalletReturn("?error=denied")?.error, "denied");

const offer: OfferRecord = {
  id: "one",
  label: "Offer 1",
  address: "tark1qqexample",
  pkScriptHex: "aa",
  payoutAddress: "tark1qqmaker",
  payoutScriptHex: "bb",
  makerProgramHex: "cc".repeat(32),
  userHex: "dd".repeat(32),
  offerAssetId: assetId,
  offerAmount: "1000",
  wantAssetId: asset.AssetId.create("22".repeat(32), 1).toString(),
  wantAmount: "1000",
  serverKeyHex: "02" + "ee".repeat(32),
  emulatorKeyHex: "03" + "ff".repeat(32),
  exitDelay: "2048",
  fundingTxid: "ab".repeat(32),
};
assert.deepEqual(decodeOffer(encodeOffer(offer)), offer);
assert.equal(decodeOffer("not-an-offer"), undefined);

function side(partial: Partial<PlanSide> & Pick<PlanSide, "offerAssetId" | "wantAssetId">): PlanSide {
  return {
    offerAmount: 1000n,
    wantAmount: 1000n,
    payoutScript: Uint8Array.of(1, 2, 3),
    coin: {
      txid: "aa".repeat(32),
      vout: 0,
      value: 330,
      assets: [{ assetId: partial.offerAssetId, amount: 1000n }],
    },
    ...partial,
  };
}

const alpha = assetId;
const beta = asset.AssetId.create("33".repeat(32), 2).toString();
const crossed = planFulfill(
  side({ offerAssetId: alpha, wantAssetId: beta, payoutScript: Uint8Array.of(0x51, 0x20) }),
  side({
    offerAssetId: beta,
    wantAssetId: alpha,
    payoutScript: Uint8Array.of(0x51, 0x21),
    coin: { txid: "bb".repeat(32), vout: 1, value: 400, assets: [{ assetId: beta, amount: 1000n }] },
  }),
);
assert.deepEqual(crossed.problems, []);
assert.equal(crossed.outputs.length, 2);
assert.equal(crossed.outputs[0].vin, 1);
assert.equal(crossed.outputs[0].assetId, beta);
assert.equal(crossed.outputs[0].assetAmount, 1000n);
assert.equal(crossed.outputs[0].amount, 330n);
assert.equal(crossed.outputs[1].vin, 0);
assert.equal(crossed.outputs[1].assetId, alpha);
assert.equal(crossed.outputs[1].amount, 400n);

const short = planFulfill(
  side({ offerAssetId: alpha, wantAssetId: beta, wantAmount: 5000n }),
  side({
    offerAssetId: beta,
    wantAssetId: alpha,
    coin: { txid: "bb".repeat(32), vout: 0, value: 330, assets: [{ assetId: beta, amount: 1000n }] },
  }),
);
assert.ok(short.problems.some((problem) => problem.includes("below")));
assert.equal(short.outputs.length, 0);

const extraAsset = planFulfill(
  side({
    offerAssetId: alpha,
    wantAssetId: beta,
    coin: {
      txid: "aa".repeat(32),
      vout: 0,
      value: 330,
      assets: [
        { assetId: alpha, amount: 1000n },
        { assetId: beta, amount: 1n },
      ],
    },
  }),
  side({ offerAssetId: beta, wantAssetId: alpha }),
);
assert.ok(extraAsset.problems.some((problem) => problem.includes("one")));

console.log("protocol checks passed");
