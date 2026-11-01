import {
  EmulatorPacket,
  Extension,
  asset,
  attachPrevArkTxs,
  buildOffchainTx,
  submitViaEmulator,
  type Arkade,
  type ArkadeContract,
} from "@arkade-os/sdk";
import { planFulfill, type PlanSide } from "./protocol.ts";
import { contractFor, type Session } from "./session.ts";
import type { OfferRecord } from "./protocol.ts";

export type SpendCoin = {
  txid: string;
  vout: number;
  value: number;
  assets: { assetId: string; amount: bigint }[];
};

type CancelBuilder = {
  from(coin: { txid: string; vout: number; value: number }): {
    to(script: Uint8Array, amount: bigint): {
      withAsset(spec: {
        assetId: string;
        inputs: { vin: number; amount: bigint }[];
        outputs: { vout: number; amount: bigint }[];
      }): { send(): Promise<{ txid: string }> };
    };
  };
};

export async function submitFulfill(session: Session, first: { offer: OfferRecord; coin: SpendCoin }, second: { offer: OfferRecord; coin: SpendCoin }) {
  if (session.emulator.match === false) {
    throw new Error("The emulator key pinned in this SDK differs from the emulator serving MutinyNet. Fulfill was not submitted.");
  }
  if (!session.emulator.match) {
    throw new Error(session.emulator.error ?? "The emulator key was not compared, so fulfill was not submitted.");
  }
  const left = contractFor(session.client, first.offer);
  const right = contractFor(session.client, second.offer);
  const plan = planFulfill(sideOf(first), sideOf(second));
  if (plan.problems.length > 0) throw new Error(plan.problems.join(" "));
  const prepared = [
    { contract: left, coin: first.coin },
    { contract: right, coin: second.coin },
  ];
  const leaves = prepared.map((input) => {
    const fn = input.contract.vtxoScript.functionByName("fulfill");
    if (!fn?.arkadeScript) throw new Error("fulfill has no covenant");
    return {
      script: fn.arkadeScript,
      tapLeafScript: fn.tapLeafScript,
      tapTree: input.contract.tapTree,
      coin: input.coin,
    };
  });
  const txInputs = leaves.map((leaf) => ({
    txid: leaf.coin.txid,
    vout: leaf.coin.vout,
    value: leaf.coin.value,
    tapLeafScript: leaf.tapLeafScript,
    tapTree: leaf.tapTree,
  }));
  const txOutputs: { script: Uint8Array; amount: bigint }[] = plan.outputs.map((output) => ({
    script: output.script,
    amount: output.amount,
  }));
  const packet = asset.Packet.create(plan.outputs.map((output, vout) => asset.AssetGroup.create(
    asset.AssetId.fromString(output.assetId),
    null,
    [asset.AssetInput.create(output.vin, output.assetAmount)],
    [asset.AssetOutput.create(vout, output.assetAmount)],
    [],
  )));
  txOutputs.push(Extension.create([
    packet,
    EmulatorPacket.create(leaves.map((leaf, vin) => ({ vin, script: leaf.script }))),
  ]).txOut());
  const offchain = buildOffchainTx(txInputs, txOutputs, session.client.checkpoint);
  if (!session.client.indexer || !session.client.emulator) {
    throw new Error("This session is missing the indexer or the emulator.");
  }
  await attachPrevArkTxs(offchain.arkTx, txInputs.map((input) => input.txid), session.client.indexer);
  if (offchain.arkTx.inputsLength !== 2) throw new Error("Fulfill was built with the wrong number of inputs.");
  for (let vin = 0; vin < 2; vin += 1) {
    const signatures = offchain.arkTx.getInput(vin).tapScriptSig ?? [];
    if (signatures.length !== 0) throw new Error(`A funder signature is present on input ${vin}.`);
  }
  const submitted = await submitViaEmulator(session.client.emulator, offchain, undefined, { inputIndexes: [] });
  return { txid: submitted.txid };
}

export async function submitCancel(session: Session, offer: OfferRecord, coin: SpendCoin): Promise<string> {
  if (!session.client.identity) {
    throw new Error("Cancel needs the maker's signature. The wallet connection returned the address and the public key. This page did not broadcast the cancel.");
  }
  const contract = contractFor(session.client, offer) as ArkadeContract & {
    functions: { cancel(): CancelBuilder };
  };
  const assetAmount = coin.assets[0]?.amount;
  if (coin.assets.length !== 1 || assetAmount === undefined) {
    throw new Error("Cancel spends a coin that carries one asset.");
  }
  const result = await contract.functions
    .cancel()
    .from({ txid: coin.txid, vout: coin.vout, value: coin.value })
    .to(hexScript(offer.payoutScriptHex), BigInt(coin.value))
    .withAsset({
      assetId: coin.assets[0].assetId,
      inputs: [{ vin: 0, amount: assetAmount }],
      outputs: [{ vout: 0, amount: assetAmount }],
    })
    .send();
  return result.txid;
}

function sideOf(input: { offer: OfferRecord; coin: SpendCoin }): PlanSide {
  return {
    offerAssetId: input.offer.offerAssetId,
    offerAmount: BigInt(input.offer.offerAmount),
    wantAssetId: input.offer.wantAssetId,
    wantAmount: BigInt(input.offer.wantAmount),
    payoutScript: hexScript(input.offer.payoutScriptHex),
    coin: input.coin,
  };
}

function hexScript(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
