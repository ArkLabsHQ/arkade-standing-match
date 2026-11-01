import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  OnchainWallet,
  SingleKey,
  Transaction,
  Wallet,
  arkade,
  asset,
  attachPrevArkTxs,
  buildOffchainTx,
  configureEventSource,
  getSequence,
  networks,
  scriptFromTapLeafScript,
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
  assertArtifactFingerprint();
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

    const short = 100n;
    const alpha = await walletA.assetManager.issue({ amount: ASSET_UNITS });
    const beta = await walletB.assetManager.issue({ amount: ASSET_UNITS + short });
    const gamma = await walletA.assetManager.issue({ amount: short });
    console.log("issued", alpha.assetId, beta.assetId, gamma.assetId);
    await waitFor("asset alpha", async () => held(await coinsAt(matcher, traderA.pkScript), alpha.assetId) >= ASSET_UNITS);
    await waitFor("asset beta", async () => held(await coinsAt(matcher, traderB.pkScript), beta.assetId) >= ASSET_UNITS + short);
    await waitFor("asset gamma", async () => held(await coinsAt(matcher, traderA.pkScript), gamma.assetId) >= short);

    const x = traderA.client.contract(program, swapArgs(traderA, alpha.assetId, beta.assetId));
    const y = traderB.client.contract(program, swapArgs(traderB, beta.assetId, alpha.assetId));
    const yShort = traderB.client.contract(program, swapArgs(traderB, beta.assetId, alpha.assetId, short, short));
    const zWrong = traderA.client.contract(program, swapArgs(traderA, gamma.assetId, alpha.assetId, short, short));
    await x.register({ label: "X" });
    await y.register({ label: "Y" });
    await yShort.register({ label: "Y-short" });
    await zWrong.register({ label: "Z-wrong" });

    const coinX = await fundContract(walletA, x, OFFER_SATS, [{ assetId: alpha.assetId, amount: ASSET_UNITS }]);
    const coinY = await fundContract(walletB, y, OFFER_SATS, [{ assetId: beta.assetId, amount: ASSET_UNITS }]);
    const coinShort = await fundContract(walletB, yShort, OFFER_SATS, [{ assetId: beta.assetId, amount: short }]);
    const coinWrong = await fundContract(walletA, zWrong, OFFER_SATS, [{ assetId: gamma.assetId, amount: short }]);
    assert.equal(assetList(coinX).length, 1);
    assert.equal(assetList(coinY).length, 1);
    const alphaIn = assetAmount(coinX, alpha.assetId);
    const betaIn = assetAmount(coinY, beta.assetId);
    assert.equal(alphaIn, ASSET_UNITS);
    assert.equal(betaIn, ASSET_UNITS);
    assert.equal(assetAmount(coinShort, beta.assetId), short);
    assert.equal(assetAmount(coinWrong, gamma.assetId), short);
    console.log("funded", outpoint(coinX), outpoint(coinY));

    await assertRejected("counterparty below wantAmount", () => matchOffers(matcher, [
      { contract: x, coin: coinX },
      { contract: yShort, coin: coinShort },
    ], [
      { script: traderA.pkScript, amount: BigInt(sats(coinX)), assetId: beta.assetId, assetAmount: short, vin: 1 },
      { script: traderB.pkScript, amount: BigInt(sats(coinShort)), assetId: alpha.assetId, assetAmount: alphaIn, vin: 0 },
    ]));
    await assertRejected("wrong asset", () => matchOffers(matcher, [
      { contract: x, coin: coinX },
      { contract: zWrong, coin: coinWrong },
    ], [
      { script: traderA.pkScript, amount: BigInt(sats(coinX)), assetId: gamma.assetId, assetAmount: short, vin: 1 },
      { script: traderA.pkScript, amount: BigInt(sats(coinWrong)), assetId: alpha.assetId, assetAmount: alphaIn, vin: 0 },
    ]));
    const extra = (await coinsAt(matcher, traderA.pkScript)).find((coin) => !spent(coin) && assetList(coin).length === 0 && sats(coin) > 1_000);
    if (!extra) throw new Error("no spare coin for the third input");
    await assertRejected("third input", () => matchOffers(matcher, [
      { contract: x, coin: coinX },
      { contract: y, coin: coinY },
    ], [
      { script: traderA.pkScript, amount: BigInt(sats(coinX)), assetId: beta.assetId, assetAmount: betaIn, vin: 1 },
      { script: traderB.pkScript, amount: BigInt(sats(coinY)), assetId: alpha.assetId, assetAmount: alphaIn, vin: 0 },
    ], [{
      txid: extra.txid,
      vout: extra.vout,
      value: sats(extra),
      tapLeafScript: traderA.vtxo.forfeit(),
      tapTree: traderA.vtxo.encode(),
    }]));
    const stillX = await coinByOutpoint(matcher, coinX);
    const stillY = await coinByOutpoint(matcher, coinY);
    assert.ok(stillX && !spent(stillX) && stillY && !spent(stillY), "rejected fulfills spent a deposit");

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
    await assertRejected("already fulfilled", () => matchOffers(matcher, [
      { contract: x, coin: coinX },
      { contract: y, coin: coinY },
    ], [
      { script: traderA.pkScript, amount: BigInt(sats(coinX)), assetId: beta.assetId, assetAmount: betaIn, vin: 1 },
      { script: traderB.pkScript, amount: BigInt(sats(coinY)), assetId: alpha.assetId, assetAmount: alphaIn, vin: 0 },
    ]));

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
    await proveExit(traderA, matcher, alpha.assetId, beta.assetId);
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
  offerAmount = ASSET_UNITS,
  wantAmount = ASSET_UNITS,
) {
  return {
    makerWP: trader.program,
    user: trader.user,
    offerAssetTxid: internalTxid(offerAssetId),
    offerAssetGroupIndex: groupIndex(offerAssetId),
    offerAmount,
    wantAssetTxid: internalTxid(wantAssetId),
    wantAssetGroupIndex: groupIndex(wantAssetId),
    wantAmount,
  };
}

async function matchOffers(
  matcher: Arkade,
  inputs: { contract: ReturnType<Arkade["contract"]>; coin: VirtualCoin }[],
  outputs: { script: Uint8Array; amount: bigint; assetId: string; assetAmount: bigint; vin: number }[],
  extras: { txid: string; vout: number; value: number; tapLeafScript: ReturnType<DefaultVtxo.Script["forfeit"]>; tapTree: Uint8Array }[] = [],
) {
  assert.equal(inputs.length, 2);
  assert.equal(outputs.length, 2);
  const leaves = inputs.map((input) => {
    const fn = input.contract.vtxoScript.functionByName("fulfill");
    if (!fn?.arkadeScript) throw new Error("fulfill has no covenant");
    return { script: fn.arkadeScript, tapLeafScript: fn.tapLeafScript, tapTree: input.contract.tapTree, coin: input.coin };
  });
  const txInputs = [
    ...leaves.map((leaf) => ({
      txid: leaf.coin.txid,
      vout: leaf.coin.vout,
      value: sats(leaf.coin),
      tapLeafScript: leaf.tapLeafScript,
      tapTree: leaf.tapTree,
    })),
    ...extras,
  ];
  if (extras.length === 0) assert.equal(txInputs.length, 2);
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
  if (extras.length === 0) assert.equal(offchain.arkTx.inputsLength, 2);
  else assert.equal(offchain.arkTx.inputsLength, 2 + extras.length);
  for (let vin = 0; vin < 2; vin++) {
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
    signer,
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

function assertArtifactFingerprint() {
  const raw = readFileSync(new URL("./contracts/matched_swap.artifact.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { fingerprint?: string; updatedAt?: string };
  const expected = parsed.fingerprint;
  delete parsed.fingerprint;
  delete parsed.updatedAt;
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
  assert.equal(digest, expected, "artifact fingerprint does not match the compiler bytes");
}

async function assertRejected(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.log(`${label} rejected: ${commandText(error).split("\n")[0]}`);
    return;
  }
  throw new Error(`${label} was accepted`);
}

async function proveExit(
  trader: Awaited<ReturnType<typeof connectTrader>>,
  matcher: Arkade,
  offerAssetId: string,
  wantAssetId: string,
) {
  const contract = trader.client.contract(program, swapArgs(trader, offerAssetId, wantAssetId));
  await contract.register({ label: "exit" });
  // Exit spends the onchain output, so the deposit's ancestry has to reach a
  // confirmed commitment. Settle the wallet first, then fund from that batch.
  let mining = true;
  const keepMining = (async () => {
    while (mining) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!mining) break;
      await mine(1);
    }
  })();
  try {
    const settled = await trader.wallet.settle();
    console.log("settled", settled);
  } finally {
    mining = false;
    await keepMining;
  }
  await mine(1);
  const deposit = await fundContract(trader.wallet, contract, OFFER_SATS, []);
  const onchain = await OnchainWallet.create(trader.signer, "regtest", new EsploraProvider("http://localhost:3000/api"));
  await exec("node", ["regtest/regtest.mjs", "faucet", onchain.address, "0.05", "--confirm"]);
  await waitFor("onchain fee coins", async () => (await onchain.getBalance()) > 0);
  if (!matcher.indexer) throw new Error("no indexer");
  const { chain } = await matcher.indexer.getVtxoChain({ txid: deposit.txid, vout: deposit.vout });
  await publishExitChain(chain, onchain, matcher.indexer);
  const unrolled = await waitFor("unrolled output", () => esploraTx(deposit.txid));
  const output = unrolled.vout[deposit.vout];
  const value = outputSats(output.value);
  assert.equal(value, sats(deposit), "unrolled value is not the deposit");
  const leaf = contract.vtxoScript.functionByName("exit");
  if (!leaf) throw new Error("exit leaf missing");
  const sequence = getSequence(leaf.tapLeafScript);
  const delay = Number(trader.client.serverExitDelay);
  assert.equal(sequence, delay, "exit sequence is not the operator delay");
  await waitFor("deposit confirmed", () => esploraConfirmed(deposit.txid));
  const exitHex = await exitRaw(contract, deposit, value, sequence, onchain.address, trader.signer);
  assert.ok((await confirmations(deposit.txid)) < delay, "exit delay had already elapsed");
  const early = await sendRaw(exitHex);
  assert.equal(early.ok, false, "exit was accepted before the delay");
  assert.match(early.error, /non-BIP68-final|non-final/i);
  while ((await confirmations(deposit.txid)) < delay) {
    const tooSoon = await sendRaw(exitHex);
    assert.equal(tooSoon.ok, false, "exit was accepted before serverExitDelay");
    assert.match(tooSoon.error, /non-BIP68-final|non-final/i);
    await mine(1);
  }
  const wrongHex = await exitRaw(contract, deposit, value, sequence, onchain.address, SingleKey.fromRandomBytes(), true);
  const wrong = await sendRaw(wrongHex);
  assert.equal(wrong.ok, false, "exit signed by the wrong key was accepted");
  assert.match(wrong.error, /script|signature|witness/i);
  const recovered = await sendRaw(exitHex);
  assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.error);
  await mine(1);
  const spent = await waitFor("exit on esplora", () => esploraTx(recovered.txid));
  assert.equal(spent.vin[0].txid, deposit.txid);
  assert.equal(spent.vin[0].vout, deposit.vout);
  const paid = spent.vout.find((out) => out.scriptpubkey_address === onchain.address);
  assert.ok(paid, "exit did not pay the user");
  const recoveredSats = outputSats(paid.value);
  assert.ok(recoveredSats > 0);
  assert.ok(recoveredSats < value);
  const raw = Transaction.fromRaw(Buffer.from(exitHex, "hex"), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const witness = raw.getInput(0).finalScriptWitness ?? [];
  assert.equal(witness.length, 3, "exit witness is not user signature, script, control block");
  assert.equal(witness[0].length, 64);
  assert.ok(includesBytes(witness[1], trader.user));
  assert.ok(!includesBytes(witness[1], trader.client.serverKey));
  console.log("exit recovered the deposit with the user's signature after the delay");
}

async function exitRaw(
  contract: { pkScript: Uint8Array; vtxoScript: { functionByName(name: string): { tapLeafScript: ReturnType<DefaultVtxo.Script["forfeit"]> } | undefined } },
  deposit: VirtualCoin,
  value: number,
  sequence: number,
  address: string,
  signer: { sign(tx: Transaction, indexes?: number[]): Promise<Transaction>; signMessage?(message: Uint8Array, kind?: string): Promise<Uint8Array> },
  wrongKey = false,
) {
  const leaf = contract.vtxoScript.functionByName("exit");
  if (!leaf) throw new Error("exit leaf missing");
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: deposit.txid,
    index: deposit.vout,
    sequence,
    witnessUtxo: { amount: BigInt(value), script: contract.pkScript },
    tapLeafScript: [leaf.tapLeafScript],
  });
  tx.addOutputAddress(address, BigInt(value - 400), networks.regtest);
  const script = scriptFromTapLeafScript(leaf.tapLeafScript);
  const version = leaf.tapLeafScript[1][leaf.tapLeafScript[1].length - 1];
  const control = encodeControl(leaf.tapLeafScript[0]);
  if (wrongKey) {
    const sighash = tx.preimageWitnessV1(0, [contract.pkScript], 0, [BigInt(value)], undefined, script, version);
    if (!signer.signMessage) throw new Error("wrong key cannot sign a message");
    const signature = await signer.signMessage(sighash, "schnorr");
    tx.updateInput(0, { finalScriptWitness: [signature, script, control] });
    return tx.hex;
  }
  const signed = await signer.sign(tx, [0]);
  const tapScriptSig = signed.getInput(0).tapScriptSig;
  if (!tapScriptSig?.length) throw new Error("user did not sign the exit leaf");
  signed.updateInput(0, { finalScriptWitness: [tapScriptSig[0][1], script, control] });
  return signed.hex;
}

async function publishExitChain(
  chain: { txid: string; type: string }[],
  onchain: OnchainWallet,
  indexer: { getVirtualTxs(txids: string[]): Promise<{ txs: string[] }> },
) {
  await waitForEsploraTip();
  for (let i = chain.length - 1; i >= 0; i--) {
    const item = chain[i];
    if (item.type.includes("COMMITMENT")) {
      await waitFor(`commitment ${item.txid}`, () => esploraConfirmed(item.txid));
      continue;
    }
    let state = await chainTxState(item.txid);
    if (state === "missing") {
      const { txs } = await indexer.getVirtualTxs([item.txid]);
      const psbt = txs.find((raw) => Transaction.fromPSBT(Buffer.from(raw, "base64")).id === item.txid);
      if (!psbt) throw new Error(`indexer has no virtual tx ${item.txid}`);
      const tx = finalizeChainTx(item.type, psbt);
      await onchain.bumpP2A(tx);
      state = await chainTxState(item.txid);
      if (state === "missing") throw new Error(`failed to broadcast ${item.type} ${item.txid}`);
    }
    if (state === "mempool") {
      await mine(1);
      await waitForEsploraTip();
      await waitFor(item.txid, () => esploraConfirmed(item.txid));
    }
  }
}

function finalizeChainTx(type: string, psbt: string) {
  const tx = Transaction.fromPSBT(Buffer.from(psbt, "base64"));
  if (type.includes("TREE")) {
    const input = tx.getInput(0);
    if (!input?.tapKeySig) throw new Error("tree transaction has no key signature");
    tx.updateInput(0, { finalScriptWitness: [input.tapKeySig] });
    return tx;
  }
  tx.finalize();
  return tx;
}

async function chainTxState(txid: string): Promise<"confirmed" | "mempool" | "missing"> {
  try {
    const info = JSON.parse(await bitcoin(["getrawtransaction", txid, "true"])) as { confirmations?: number };
    return (info.confirmations ?? 0) > 0 ? "confirmed" : "mempool";
  } catch {
    const response = await fetch(`http://localhost:3000/api/tx/${txid}/status`);
    if (!response.ok) return "missing";
    const status = await response.json() as { confirmed?: boolean };
    return status.confirmed ? "confirmed" : "mempool";
  }
}

function outputSats(value: number) {
  return value < 1 ? Math.round(value * 1e8) : Math.round(value);
}

function encodeControl(control: { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] }) {
  const out = new Uint8Array(33 + control.merklePath.length * 32);
  out[0] = control.version;
  out.set(control.internalKey, 1);
  control.merklePath.forEach((step, index) => out.set(step, 33 + index * 32));
  return out;
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((byte, offset) => haystack[i + offset] === byte)) return true;
  }
  return false;
}

async function esploraTx(txid: string) {
  const response = await fetch(`http://localhost:3000/api/tx/${txid}`);
  if (!response.ok) return undefined;
  return response.json() as Promise<{
    vin: { txid: string; vout: number }[];
    vout: { value: number; scriptpubkey_address?: string }[];
  }>;
}

async function esploraConfirmed(txid: string) {
  const status = await esploraStatus(txid);
  return status.confirmed ? status : undefined;
}

async function esploraStatus(txid: string) {
  const response = await fetch(`http://localhost:3000/api/tx/${txid}/status`);
  if (!response.ok) return { confirmed: false, block_height: 0 };
  return response.json() as Promise<{ confirmed: boolean; block_height: number }>;
}

async function waitForEsploraTip() {
  const tip = await blockCount();
  await waitFor("esplora tip", async () => {
    const response = await fetch("http://localhost:3000/api/blocks/tip/height");
    if (!response.ok) return undefined;
    const height = Number(await response.text());
    return height >= tip ? height : undefined;
  });
}

async function mine(count: number) {
  await exec("node", ["regtest/regtest.mjs", "mine", String(count)]);
}

async function blockCount() {
  return Number(await bitcoin(["getblockcount"]));
}

async function confirmations(txid: string) {
  const info = JSON.parse(await bitcoin(["getrawtransaction", txid, "true"])) as { confirmations?: number };
  return info.confirmations ?? 0;
}

async function bitcoin(args: string[]) {
  const { stdout } = await exec("docker", [
    "exec", "bitcoin", "bitcoin-cli", "-regtest", "-rpcuser=admin1", "-rpcpassword=123", ...args,
  ]);
  return stdout.trim();
}

async function sendRaw(hex: string): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  try {
    const txid = await bitcoin(["sendrawtransaction", hex]);
    return { ok: true, txid };
  } catch (error) {
    return { ok: false, error: commandText(error) };
  }
}

// Funding commands this file runs, from the bottom of the regtest skill:
// docker exec arkd ark send --to <address> --amount 300000 --password secret
// docker exec arkd arkd note --amount 200000
// docker exec arkd ark redeem-notes -n <note> --password secret
