import AttestedBox from "../models/attestedBox";
import Deserialize from "../serialization/deserialize";
import Serialize from "../serialization/serialize";
import { ChangeMap, BoxCandidate, Token, Network } from "../types/public";
import Device, { COMMAND } from "./common/device";
import { ErgoAddress } from "@fleet-sdk/core";
import { AttestedTx } from "../types/internal";

const MAINNET_MINER_FEE_TREE =
  "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";
const TESTNET_FEE_TREE =
  "1005040004000e36100204900108cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";

const enum P1 {
  START_SIGNING = 0x01,
  START_TRANSACTION = 0x10,
  ADD_TOKEN_IDS = 0x11,
  ADD_INPUT_BOX_FRAME = 0x12,
  ADD_INPUT_BOX_CONTEXT_EXTENSION_CHUNK = 0x13,
  ADD_DATA_INPUTS = 0x14,
  ADD_OUTPUT_BOX_START = 0x15,
  ADD_OUTPUT_BOX_ERGO_TREE_CHUNK = 0x16,
  ADD_OUTPUT_BOX_MINERS_FEE_TREE = 0x17,
  ADD_OUTPUT_BOX_CHANGE_TREE = 0x18,
  ADD_OUTPUT_BOX_TOKENS = 0x19,
  ADD_OUTPUT_BOX_REGISTERS_CHUNK = 0x1a,
  CONFIRM_AND_SIGN = 0x20
}

const enum P2 {
  WITHOUT_TOKEN = 0x01,
  WITH_TOKEN = 0x02
}

export async function signTx(
  device: Device,
  tx: AttestedTx,
  signPath: string,
  network: Network,
  authToken?: number
): Promise<Uint8Array> {
  const sessionId = await sendHeader(device, signPath, authToken);
  await sendStartTx(device, sessionId, tx, tx.distinctTokenIds.length);
  await sendDistinctTokensIds(device, sessionId, tx.distinctTokenIds);
  await sendInputs(device, sessionId, tx.inputs);
  await sendDataInputs(device, sessionId, tx.dataInputs);
  await sendOutputs(device, sessionId, tx.outputs, tx.changeMap, tx.distinctTokenIds, network);
  const signBytes = await sendConfirmAndSign(device, sessionId);

  return new Uint8Array(signBytes);
}

async function sendHeader(device: Device, path: string, authToken?: number): Promise<number> {
  const response = await device.send(
    COMMAND.SIGN_TX,
    P1.START_SIGNING,
    authToken ? P2.WITH_TOKEN : P2.WITHOUT_TOKEN,
    Buffer.concat([
      Serialize.bip32Path(path),
      authToken ? Serialize.uint32(authToken) : Buffer.alloc(0)
    ])
  );

  return response.data[0];
}

async function sendStartTx(
  device: Device,
  sessionId: number,
  tx: AttestedTx,
  uniqueTokenIdsCount: number
): Promise<number> {
  const response = await device.send(
    COMMAND.SIGN_TX,
    P1.START_TRANSACTION,
    sessionId,
    Buffer.concat([
      Serialize.uint16(tx.inputs.length),
      Serialize.uint16(tx.dataInputs.length),
      Serialize.uint8(uniqueTokenIdsCount),
      Serialize.uint16(tx.outputs.length)
    ])
  );

  return response.data[0];
}

async function sendDistinctTokensIds(device: Device, sessionId: number, ids: Uint8Array[]) {
  if (ids.length === 0) {
    return;
  }

  const MAX_PACKET_SIZE = 7;
  const packets = Serialize.arrayAndChunk(ids, MAX_PACKET_SIZE, (id) => Buffer.from(id));

  for (let p of packets) {
    await device.send(COMMAND.SIGN_TX, P1.ADD_TOKEN_IDS, sessionId, p);
  }
}

async function sendInputs(device: Device, sessionId: number, inputBoxes: AttestedBox[]) {
  for (let box of inputBoxes) {
    for (let frame of box.frames) {
      await device.send(COMMAND.SIGN_TX, P1.ADD_INPUT_BOX_FRAME, sessionId, frame.buffer);
    }

    if (box.extension !== undefined && box.extension.length > 0) {
      await sendBoxContextExtension(device, sessionId, box.extension);
    }
  }
}

async function sendBoxContextExtension(device: Device, sessionId: number, extension: Buffer) {
  await device.sendData(
    COMMAND.SIGN_TX,
    P1.ADD_INPUT_BOX_CONTEXT_EXTENSION_CHUNK,
    sessionId,
    extension
  );
}

async function sendDataInputs(device: Device, sessionId: number, boxIds: string[]) {
  const MAX_PACKET_SIZE = 7;
  const packets = Serialize.arrayAndChunk(boxIds, MAX_PACKET_SIZE, (id) => Serialize.hex(id));

  for (let p of packets) {
    await device.send(COMMAND.SIGN_TX, P1.ADD_DATA_INPUTS, sessionId, p);
  }
}

async function sendOutputs(
  device: Device,
  sessionId: number,
  boxes: BoxCandidate[],
  changeMap: ChangeMap,
  distinctTokenIds: Uint8Array[],
  network: Network
) {
  const distinctTokenIdsStr = distinctTokenIds.map((t) => Buffer.from(t).toString("hex"));

  for (let box of boxes) {
    await device.send(
      COMMAND.SIGN_TX,
      P1.ADD_OUTPUT_BOX_START,
      sessionId,
      Buffer.concat([
        Serialize.uint64(box.value),
        Serialize.uint32(box.ergoTree.length),
        Serialize.uint32(box.creationHeight),
        Serialize.uint8(box.tokens.length),
        Serialize.uint32(box.registers.length)
      ])
    );

    const tree = Deserialize.hex(box.ergoTree);
    if (tree === MAINNET_MINER_FEE_TREE || tree === TESTNET_FEE_TREE) {
      await addOutputBoxMinersFeeTree(device, sessionId, network);
    } else if (ErgoAddress.fromErgoTree(tree).toString() === changeMap.address) {
      await addOutputBoxChangeTree(device, sessionId, changeMap.path);
    } else {
      await addOutputBoxErgoTree(device, sessionId, box.ergoTree);
    }

    if (box.tokens && box.tokens.length > 0) {
      await addOutputBoxTokens(device, sessionId, box.tokens, distinctTokenIdsStr);
    }

    if (box.registers.length > 0) {
      await addOutputBoxRegisters(device, sessionId, box.registers);
    }
  }
}

async function addOutputBoxErgoTree(device: Device, sessionId: number, ergoTree: Buffer) {
  await device.sendData(COMMAND.SIGN_TX, P1.ADD_OUTPUT_BOX_ERGO_TREE_CHUNK, sessionId, ergoTree);
}

async function addOutputBoxMinersFeeTree(device: Device, sessionId: number, network: Network) {
  await device.send(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_MINERS_FEE_TREE,
    sessionId,
    Buffer.from([network])
  );
}

async function addOutputBoxChangeTree(device: Device, sessionId: number, path?: string) {
  if (!path) {
    throw new Error("change path is not present");
  }

  await device.send(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_CHANGE_TREE,
    sessionId,
    Serialize.bip32Path(path)
  );
}

async function addOutputBoxTokens(
  device: Device,
  sessionId: number,
  tokens: Token[],
  distinctTokenIds: string[]
) {
  await device.send(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_TOKENS,
    sessionId,
    Serialize.array(tokens, (t) =>
      Buffer.concat([Serialize.uint32(distinctTokenIds.indexOf(t.id)), Serialize.uint64(t.amount)])
    )
  );
}

async function addOutputBoxRegisters(device: Device, sessionId: number, registers: Buffer) {
  await device.sendData(COMMAND.SIGN_TX, P1.ADD_OUTPUT_BOX_REGISTERS_CHUNK, sessionId, registers);
}

async function sendConfirmAndSign(device: Device, sessionId: number): Promise<Buffer> {
  const response = await device.send(
    COMMAND.SIGN_TX,
    P1.CONFIRM_AND_SIGN,
    sessionId,
    Buffer.from([])
  );

  return response.data;
}
