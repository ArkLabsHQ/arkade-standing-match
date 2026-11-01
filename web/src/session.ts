import artifact from "../../contracts/matched_swap.artifact.json" with { type: "json" };
import {
  ArkAddress,
  Arkade,
  DefaultVtxo,
  IndexedDBContractRepository,
  InMemoryContractRepository,
  ReadonlyAssetManager,
  RestIndexerProvider,
  arkade,
  networks,
  type ContractRepository,
  type IContractManager,
} from "@arkade-os/sdk";
import {
  EMULATOR_URL,
  OPERATOR_URL,
  BITCOIN_DECIMALS,
  bytesToHex,
  canonicalAssetId,
  errorText,
  groupIndex,
  hexToBytes,
  holdingsFromCoins,
  internalTxid,
  usableDecimals,
  type OfferRecord,
} from "./protocol.ts";

export const program = arkade.programFromArtifact(artifact);

export type Session = {
  client: Arkade;
  storageNote?: string;
  emulator: { pinned: string; served?: string; match?: boolean; error?: string };
  exitDelay?: bigint;
};

type Refreshable = Pick<IContractManager, "refreshVtxos">;

export async function openSession(): Promise<Session> {
  try {
    return await connectRepository(new IndexedDBContractRepository("standing-match"));
  } catch (error) {
    if (!/IndexedDB/i.test(errorText(error))) throw error;
    const session = await connectRepository(new InMemoryContractRepository());
    session.storageNote = "Contract storage is in memory for this tab.";
    return session;
  }
}

async function connectRepository(repository: ContractRepository): Promise<Session> {
  const client = await Arkade.connect({
    service: { operatorUrl: OPERATOR_URL, emulatorUrl: EMULATOR_URL },
    storage: { contractRepository: repository },
    network: networks.mutinynet,
  });
  const pinned = client.emulatorKey ? bytesToHex(client.emulatorKey) : "";
  const emulator: Session["emulator"] = { pinned };
  try {
    const response = await fetch(`${EMULATOR_URL}/v1/info`);
    if (!response.ok) throw new Error(`The emulator info request returned ${response.status}.`);
    const body = await response.json() as { signerPubkey?: string };
    if (!body.signerPubkey) throw new Error("The emulator did not report a signer key.");
    emulator.served = body.signerPubkey;
    emulator.match = body.signerPubkey.toLowerCase() === pinned.toLowerCase();
  } catch (error) {
    emulator.error = errorText(error);
  }
  return { client, emulator, exitDelay: client.serverExitDelay };
}

export async function refreshScript(client: Arkade, scriptHex: string): Promise<void> {
  const manager = client.contractManager as Refreshable | undefined;
  if (!manager) throw new Error("This session has no contract manager.");
  await manager.refreshVtxos({ scripts: [scriptHex], after: 0 });
}

export function contractFor(client: Arkade, offer: OfferRecord) {
  return client.contract(program, {
    makerWP: hexToBytes(offer.makerProgramHex),
    user: hexToBytes(offer.userHex),
    offerAssetTxid: internalTxid(offer.offerAssetId),
    offerAssetGroupIndex: groupIndex(offer.offerAssetId),
    offerAmount: BigInt(offer.offerAmount),
    wantAssetTxid: internalTxid(offer.wantAssetId),
    wantAssetGroupIndex: groupIndex(offer.wantAssetId),
    wantAmount: BigInt(offer.wantAmount),
  });
}

export function sameBinding(session: Session, offer: OfferRecord): boolean {
  const server = bytesToHex(session.client.serverKey);
  const delay = session.exitDelay === undefined ? "" : session.exitDelay.toString();
  return server.toLowerCase() === offer.serverKeyHex.toLowerCase() && delay === offer.exitDelay;
}

export type WalletAsset = {
  id: string;
  sats: bigint;
  ticker?: string;
  name?: string;
};

export async function walletAssets(session: Session, identity: WalletIdentity): Promise<WalletAsset[]> {
  if (!session.client.indexer) throw new Error("This session has no indexer.");
  const { vtxos } = await session.client.indexer.getVtxos({
    scripts: [bytesToHex(identity.pkScript)],
    spendableOnly: true,
  });
  const held = holdingsFromCoins(vtxos.map((coin) => ({
    isSpent: coin.isSpent,
    spentBy: coin.spentBy,
    assets: coin.assets,
  })));
  return Promise.all(held.map(async (entry) => {
    try {
      const details = await assetDetails(entry.id);
      const ticker = details.metadata?.ticker;
      const name = details.metadata?.name;
      return {
        ...entry,
        ...(typeof ticker === "string" && ticker ? { ticker } : {}),
        ...(typeof name === "string" && name ? { name } : {}),
      };
    } catch {
      return entry;
    }
  }));
}

export type WalletIdentity = {
  address: string;
  pubkeyHex: string;
  program: Uint8Array;
  user: Uint8Array;
  pkScript: Uint8Array;
};

export function walletIdentity(session: Session, address: string, pubkeyHex: string): WalletIdentity {
  if (session.exitDelay === undefined) {
    throw new Error("The operator did not report the exit delay.");
  }
  const decoded = ArkAddress.decode(address);
  const user = hexToBytes(pubkeyHex);
  if (user.length !== 32) throw new Error("The wallet returned a public key that is not 32 bytes.");
  const delay = session.exitDelay;
  const script = new DefaultVtxo.Script({
    pubKey: user,
    serverPubKey: session.client.serverKey,
    csvTimelock: delay < 512n ? { type: "blocks", value: delay } : { type: "seconds", value: delay },
  });
  if (bytesToHex(script.pkScript) !== bytesToHex(decoded.pkScript)) {
    throw new Error("This address and public key do not form the default Arkade script for this operator.");
  }
  if (decoded.vtxoTaprootKey.length !== 32) throw new Error("The Arkade address has no 32-byte program.");
  return {
    address,
    pubkeyHex: pubkeyHex.toLowerCase(),
    program: decoded.vtxoTaprootKey,
    user,
    pkScript: decoded.pkScript,
  };
}

let assetReader: ReadonlyAssetManager | undefined;

async function assetDetails(assetId: string) {
  const id = canonicalAssetId(assetId);
  assetReader ??= new ReadonlyAssetManager(new RestIndexerProvider(OPERATOR_URL));
  try {
    return await assetReader.getAssetDetails(id);
  } catch (error) {
    throw new Error(`The indexer did not return asset ${id}. ${errorText(error)}`);
  }
}

export async function bitcoinPrecisionAsset(assetId: string): Promise<string> {
  const details = await assetDetails(assetId);
  const decimals = usableDecimals(details.metadata?.decimals);
  if (details.metadata?.decimals === undefined || decimals !== BITCOIN_DECIMALS) {
    throw new Error(`The indexer did not report bitcoin precision for ${details.assetId}. Amounts on this page are satoshis.`);
  }
  return canonicalAssetId(details.assetId);
}
