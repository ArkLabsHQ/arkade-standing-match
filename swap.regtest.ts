import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { strict as assert } from "node:assert";
import { EventSource } from "eventsource";
import {
  Arkade,
  ArkAddress,
  DefaultVtxo,
  EmulatorPacket,
  Extension,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
  arkade,
  asset,
  attachPrevArkTxs,
  buildOffchainTx,
  configureEventSource,
  networks,
  submitViaEmulator,
  type VirtualCoin,
} from "@arkade-os/sdk";

configureEventSource((url) => new EventSource(url));

const OPERATOR = "http://localhost:7070";
const ADMIN = "http://localhost:7071";
const EMULATOR = "http://localhost:7073";
const ASSET_UNITS = 1000n;
const OFFER_SATS = 2_000;
const FAUCET_SATS = 300_000;
const DIRECT_SEND_SATS = 4_000;

const exec = promisify(execFile);
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const positions = new Map<string, Set<string>>();

const program = arkade.programFromArtifact(
  JSON.parse(readFileSync(new URL("./contracts/matched_swap.artifact.json", import.meta.url), "utf8")),
);

await main();

async function main() {
  await waitForStack();
  const info = await (await fetch(`${OPERATOR}/v1/info`)).json() as { signerPubkey: string };
  const emulatorInfo = await (await fetch(`${EMULATOR}/v1/info`)).json() as { signerPubkey: string };
  console.log("regtest is up", info.signerPubkey);

  const walletA = await makeWallet();
  const walletB = await makeWallet();
  const traderA = await connectTrader(walletA);
  const traderB = await connectTrader(walletB);
  const matcher = await Arkade.connect({
    service: { operatorUrl: OPERATOR, emulatorUrl: EMULATOR },
    storage: { contractRepository: new InMemoryContractRepository() },
    network: networks.regtest,
  });

  try {
    const pinned = encode(matcher.emulatorKey!);
    assert.equal(
      pinned,
      emulatorInfo.signerPubkey,
      `emulator key mismatch: pinned ${pinned}, served ${emulatorInfo.signerPubkey}`,
    );
    await fundOffchain(traderA.address, FAUCET_SATS);
    await fundOffchain(traderB.address, FAUCET_SATS);
    await waitFor("trader A sats", async () => (await walletA.getBalance()).available >= 100_000);
    await waitFor("trader B sats", async () => (await walletB.getBalance()).available >= 100_000);

    const alpha = await walletA.assetManager.issue({ amount: ASSET_UNITS });
    const beta = await walletB.assetManager.issue({ amount: ASSET_UNITS });
    console.log("issued", alpha.assetId, beta.assetId);
    await waitFor("asset alpha", async () => held(await coinsAt(matcher, traderA.pkScript), alpha.assetId) >= ASSET_UNITS);
    await waitFor("asset beta", async () => held(await coinsAt(matcher, traderB.pkScript), beta.assetId) >= ASSET_UNITS);

    const x = traderA.client.contract(program, swapArgs(traderA, alpha.assetId, beta.assetId));
    const y = traderB.client.contract(program, swapArgs(traderB, beta.assetId, alpha.assetId));
    await x.register({ label: "X" });
    await y.register({ label: "Y" });

    const coinX = await fundContract(walletA, x, OFFER_SATS, [{ assetId: alpha.assetId, amount: ASSET_UNITS }]);
    const coinY = await fundContract(walletB, y, OFFER_SATS, [{ assetId: beta.assetId, amount: ASSET_UNITS }]);
    assert.equal(assetList(coinX).length, 1);
    assert.equal(assetList(coinY).length, 1);
    const alphaIn = assetAmount(coinX, alpha.assetId);
    const betaIn = assetAmount(coinY, beta.assetId);
    assert.equal(alphaIn, ASSET_UNITS);
    assert.equal(betaIn, ASSET_UNITS);
    console.log("funded", outpoint(coinX), outpoint(coinY));

    const matched = await matchOffers(matcher, [
      { contract: x, coin: coinX },
      { contract: y, coin: coinY },
    ], [
      { script: traderA.pkScript, amount: BigInt(sats(coinX)), assetId: beta.assetId, assetAmount: betaIn, vin: 1 },
      { script: traderB.pkScript, amount: BigInt(sats(coinY)), assetId: alpha.assetId, assetAmount: alphaIn, vin: 0 },
    ]);
    console.log("matched", matched.txid);

    await waitFor("X spent", async () => {
      const coin = await coinByOutpoint(matcher, coinX);
      return coin && spent(coin) ? coin : undefined;
    });
    await waitFor("Y spent", async () => {
      const coin = await coinByOutpoint(matcher, coinY);
      return coin && spent(coin) ? coin : undefined;
    });
    const paidA = await waitFor("A holds B's full input", async () => {
      const coins = await coinsAt(matcher, traderA.pkScript);
      return coins.find((coin) => coin.txid === matched.txid && assetAmount(coin, beta.assetId) === betaIn && sats(coin) >= sats(coinX));
    });
    const paidB = await waitFor("B holds A's full input", async () => {
      const coins = await coinsAt(matcher, traderB.pkScript);
      return coins.find((coin) => coin.txid === matched.txid && assetAmount(coin, alpha.assetId) === alphaIn && sats(coin) >= sats(coinY));
    });
    assert.equal(assetAmount(paidA, beta.assetId), betaIn);
    assert.equal(assetAmount(paidB, alpha.assetId), alphaIn);
    console.log("indexer: both deposits spent, each trader holds the other's full input");

    const cancelOffer = traderA.client.contract(program, swapArgs(traderA, beta.assetId, alpha.assetId));
    await cancelOffer.register({ label: "cancel-X" });
    const locked = ASSET_UNITS;
    const cancelCoin = await fundContract(walletA, cancelOffer, OFFER_SATS, [{ assetId: beta.assetId, amount: locked }]);
    assert.equal(assetAmount(cancelCoin, beta.assetId), locked);
    const cancelled = await cancelOffer.functions
      .cancel()
      .from(asUtxo(cancelCoin))
      .to(traderA.pkScript, BigInt(sats(cancelCoin)))
      .withAsset({
        assetId: beta.assetId,
        inputs: [{ vin: 0, amount: locked }],
        outputs: [{ vout: 0, amount: locked }],
      })
      .send();
    console.log("cancelled", cancelled.txid);
    await waitFor("cancel spent", async () => {
      const coin = await coinByOutpoint(matcher, cancelCoin);
      return coin && spent(coin) ? coin : undefined;
    });
    await waitFor("deposit back on A", async () => held(await coinsAt(matcher, traderA.pkScript), beta.assetId) >= locked);
    assert.ok(held(await coinsAt(matcher, traderA.pkScript), beta.assetId) >= locked);
    console.log("cancel returned the deposit with no counterparty offer");

    const strayTxid = await walletA.send({
      recipients: [{ address: cancelOffer.address, amount: DIRECT_SEND_SATS }],
    });
    const stray = await waitFor("direct send", async () => {
      const coins = await coinsAt(matcher, cancelOffer.pkScript);
      return coins.find((coin) => !spent(coin) && coin.txid === strayTxid);
    });
    const unspent = (await coinsAt(matcher, cancelOffer.pkScript)).filter((coin) => !spent(coin));
    const open = unspent.filter((coin) => isPosition(cancelOffer.pkScript, coin));
    assert.equal(open.length, 0);
    assert.equal(isPosition(cancelOffer.pkScript, stray), false);
    assert.ok(unspent.some((coin) => coin.txid === stray.txid));
    console.log("direct send is a second coin, not the position");
    console.log("matched swap passed");
  } finally {
    matcher.dispose();
    traderA.client.dispose();
    traderB.client.dispose();
    await walletA.dispose();
    await walletB.dispose();
  }
}

function swapArgs(
  trader: { program: Uint8Array; user: Uint8Array },
  offerAssetId: string,
  wantAssetId: string,
) {
  return {
    makerWP: trader.program,
    user: trader.user,
    offerAssetTxid: internalTxid(offerAssetId),
    offerAssetGroupIndex: groupIndex(offerAssetId),
    offerAmount: ASSET_UNITS,
    wantAssetTxid: internalTxid(wantAssetId),
    wantAssetGroupIndex: groupIndex(wantAssetId),
    wantAmount: ASSET_UNITS,
  };
}

async function matchOffers(
  matcher: Arkade,
  inputs: { contract: ReturnType<Arkade["contract"]>; coin: VirtualCoin }[],
  outputs: { script: Uint8Array; amount: bigint; assetId: string; assetAmount: bigint; vin: number }[],
) {
  assert.equal(inputs.length, 2);
  assert.equal(outputs.length, 2);
  const leaves = inputs.map((input) => {
    const fn = input.contract.vtxoScript.functionByName("fulfill");
    if (!fn?.arkadeScript) throw new Error("fulfill has no covenant");
    return { script: fn.arkadeScript, tapLeafScript: fn.tapLeafScript, tapTree: input.contract.tapTree, coin: input.coin };
  });
  const txInputs = leaves.map((leaf) => ({
    txid: leaf.coin.txid,
    vout: leaf.coin.vout,
    value: sats(leaf.coin),
    tapLeafScript: leaf.tapLeafScript,
    tapTree: leaf.tapTree,
  }));
  const txOutputs = outputs.map((output) => ({ script: output.script, amount: output.amount }));
  const packet = asset.Packet.create(outputs.map((output, vout) => asset.AssetGroup.create(
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
  const offchain = buildOffchainTx(txInputs, txOutputs, matcher.checkpoint);
  if (!matcher.indexer || !matcher.emulator) throw new Error("matcher is missing the indexer or the emulator");
  await attachPrevArkTxs(offchain.arkTx, txInputs.map((input) => input.txid), matcher.indexer);
  assert.equal(offchain.arkTx.inputsLength, 2);
  for (let vin = 0; vin < txInputs.length; vin++) {
    const signatures = offchain.arkTx.getInput(vin).tapScriptSig ?? [];
    assert.equal(signatures.length, 0, `trader signature present on input ${vin}`);
  }
  return submitViaEmulator(matcher.emulator, offchain, undefined, { inputIndexes: [] });
}

async function connectTrader(wallet: Wallet) {
  const descriptor = await wallet.getNextSigningDescriptor();
  if (!descriptor) throw new Error("wallet did not offer a signing descriptor");
  const signer = await wallet.signerForDescriptor(descriptor);
  const client = await Arkade.connect({
    service: { operatorUrl: OPERATOR, emulatorUrl: EMULATOR },
    identity: signer,
    storage: { contractRepository: new InMemoryContractRepository() },
    network: networks.regtest,
  });
  const address = await wallet.getAddress();
  const decoded = ArkAddress.decode(address);
  const user = await signer.xOnlyPublicKey();
  const delay = client.serverExitDelay!;
  const vtxo = new DefaultVtxo.Script({
    pubKey: user,
    serverPubKey: client.serverKey,
    csvTimelock: delay < 512n ? { type: "blocks", value: delay } : { type: "seconds", value: delay },
  });
  assert.equal(encode(vtxo.pkScript), encode(decoded.pkScript), "wallet script is not the default virtual-output script");
  assert.equal(decoded.vtxoTaprootKey.length, 32);
  assert.equal(encode(decoded.pkScript), `5120${encode(decoded.vtxoTaprootKey)}`);
  return {
    wallet,
    client,
    address,
    user,
    program: decoded.vtxoTaprootKey,
    pkScript: decoded.pkScript,
    vtxo,
  };
}

async function makeWallet() {
  return Wallet.create({
    identity: SingleKey.fromRandomBytes(),
    service: { operatorUrl: OPERATOR },
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  });
}

async function fundContract(
  wallet: Wallet,
  contract: { address: string; pkScript: Uint8Array; tapTree: Uint8Array; client: Arkade },
  amount: number,
  assets: { assetId: string; amount: bigint }[],
) {
  const txid = await wallet.send({
    recipients: [{
      address: contract.address,
      amount,
      ...(assets.length > 0 ? { assets } : {}),
      tapTree: contract.tapTree,
    }],
  });
  const coin = await waitFor(`funding ${txid}`, async () => {
    const coins = await coinsAt(contract.client, contract.pkScript);
    return coins.find((candidate) => candidate.txid === txid && !spent(candidate));
  });
  const key = encode(contract.pkScript);
  const set = positions.get(key) ?? new Set<string>();
  set.add(outpoint(coin));
  positions.set(key, set);
  return coin;
}

function isPosition(script: Uint8Array, coin: VirtualCoin) {
  return positions.get(encode(script))?.has(outpoint(coin)) === true && !spent(coin);
}

async function coinsAt(holder: { indexer?: { getVtxos(opts: { scripts: string[] }): Promise<{ vtxos: VirtualCoin[] }> } }, script: Uint8Array) {
  if (!holder.indexer) throw new Error("no indexer");
  const { vtxos } = await holder.indexer.getVtxos({ scripts: [encode(script)] });
  return vtxos;
}

async function coinByOutpoint(holder: { indexer?: { getVtxos(opts: { outpoints: { txid: string; vout: number }[] }): Promise<{ vtxos: VirtualCoin[] }> } }, coin: VirtualCoin) {
  if (!holder.indexer) throw new Error("no indexer");
  const { vtxos } = await holder.indexer.getVtxos({ outpoints: [{ txid: coin.txid, vout: coin.vout }] });
  return vtxos[0];
}

function held(coins: VirtualCoin[], assetId: string) {
  return coins.filter((coin) => !spent(coin)).reduce((sum, coin) => sum + assetAmount(coin, assetId), 0n);
}

function assetAmount(coin: VirtualCoin, assetId: string) {
  const hit = assetList(coin).find((entry) => entry.assetId === assetId);
  if (!hit) return 0n;
  return typeof hit.amount === "bigint" ? hit.amount : BigInt(hit.amount);
}

function assetList(coin: VirtualCoin) {
  return coin.assets ?? [];
}

function spent(coin: VirtualCoin) {
  return coin.isSpent === true || Boolean(coin.spentBy);
}

function sats(coin: VirtualCoin) {
  return typeof coin.value === "number" ? coin.value : Number(coin.value);
}

function outpoint(coin: VirtualCoin) {
  return `${coin.txid}:${coin.vout}`;
}

function asUtxo(coin: VirtualCoin) {
  return { txid: coin.txid, vout: coin.vout, value: sats(coin) };
}

function internalTxid(assetId: string) {
  return Uint8Array.from(asset.AssetId.fromString(assetId).txid).reverse();
}

function groupIndex(assetId: string) {
  return BigInt(asset.AssetId.fromString(assetId).groupIndex);
}

async function waitForStack() {
  await waitFor("arkd", async () => {
    const response = await fetch(`${OPERATOR}/v1/info`);
    if (!response.ok) return undefined;
    const body = await response.json() as { signerPubkey?: string };
    return body.signerPubkey ? body : undefined;
  }, 240_000);
  await waitFor("emulator", async () => {
    const response = await fetch(`${EMULATOR}/v1/info`);
    if (!response.ok) return undefined;
    const body = await response.json() as { signerPubkey?: string };
    return body.signerPubkey ? body : undefined;
  }, 240_000);
}

async function fundOffchain(address: string, amount: number) {
  const args = ["exec", "arkd", "ark", "send", "--to", address, "--amount", String(amount), "--password", "secret"];
  try {
    const { stdout, stderr } = await exec("docker", args);
    console.log(stdout || stderr);
  } catch (error) {
    const text = commandText(error);
    if (!text.includes("not enough funds")) throw error;
    await postFees("0.0");
    try {
      const note = await exec("docker", ["exec", "arkd", "arkd", "note", "--amount", String(Math.max(amount * 4, 1_000_000))]);
      const found = `${note.stdout}\n${note.stderr}`.match(/arknote\S+/);
      if (!found) throw error;
      await exec("docker", ["exec", "arkd", "ark", "redeem-notes", "-n", found[0], "--password", "secret"]);
    } finally {
      await postFees("amount * 0.01");
    }
    const { stdout, stderr } = await exec("docker", args);
    console.log(stdout || stderr);
  }
}

async function postFees(offchainInput: string) {
  const response = await fetch(`${ADMIN}/v1/admin/intentFees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fees: {
        offchainInputFee: offchainInput,
        onchainInputFee: offchainInput,
        offchainOutputFee: "0.0",
        onchainOutputFee: offchainInput === "0.0" ? "0.0" : "250.0",
      },
    }),
  });
  if (!response.ok) throw new Error(`intent fees ${response.status}`);
}

function commandText(error: unknown) {
  if (error && typeof error === "object") {
    const out = "stdout" in error ? String(error.stdout ?? "") : "";
    const err = "stderr" in error ? String(error.stderr ?? "") : "";
    return `${String(error)}\n${out}\n${err}`;
  }
  return String(error);
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined | false | null | 0>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  let last = "not ready";
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${label}: ${last}`);
}

// Funding commands this file runs, from the bottom of the regtest skill:
// docker exec arkd ark send --to <address> --amount 300000 --password secret
// docker exec arkd arkd note --amount 200000
// docker exec arkd ark redeem-notes -n <note> --password secret
