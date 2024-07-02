import { deserialize } from "../serialization/deserialize";
import { serialize } from "../serialization/serialize";
import type { ChangeMap, BoxCandidate, Token } from "../types/public";
import { COMMAND, type Device } from "../device";
import { ErgoAddress, type Network } from "@fleet-sdk/core";
import type { AttestedTransaction } from "../types/internal";
import type { AttestedBox } from "../types/attestedBox";

const MINER_FEE_TREE =
  "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";

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
  tx: AttestedTransaction,
  signPath: string,
  network: Network,
  authToken?: number
): Promise<Uint8Array> {
  const sessionId = await sendHeader(device, network, signPath, authToken);
  await sendStartTx(device, sessionId, tx, tx.distinctTokenIds.length);
  await sendDistinctTokensIds(device, sessionId, tx.distinctTokenIds);
  await sendInputs(device, sessionId, tx.inputs);
  await sendDataInputs(device, sessionId, tx.dataInputs);
  await sendOutputs(
    device,
    sessionId,
    tx.outputs,
    tx.changeMap,
    tx.distinctTokenIds
  );
  const proof = await sendConfirmAndSign(device, sessionId);

  return new Uint8Array(proof);
}

async function sendHeader(
  device: Device,
  network: Network,
  path: string,
  authToken?: number
): Promise<number> {
  const response = await device.send(
    COMMAND.SIGN_TX,
    P1.START_SIGNING,
    authToken ? P2.WITH_TOKEN : P2.WITHOUT_TOKEN,
    Buffer.concat([
      serialize.uint8(network),
      serialize.path(path),
      authToken ? serialize.uint32(authToken) : Buffer.alloc(0)
    ])
  );

  return response.data[0];
}

async function sendStartTx(
  device: Device,
  sessionId: number,
  tx: AttestedTransaction,
  uniqueTokenIdsCount: number
): Promise<number> {
  const response = await device.send(
    COMMAND.SIGN_TX,
    P1.START_TRANSACTION,
    sessionId,
    Buffer.concat([
      serialize.uint16(tx.inputs.length),
      serialize.uint16(tx.dataInputs.length),
      serialize.uint8(uniqueTokenIdsCount),
      serialize.uint16(tx.outputs.length)
    ])
  );

  return response.data[0];
}

async function sendDistinctTokensIds(
  device: Device,
  sessionId: number,
  ids: Uint8Array[]
) {
  if (ids.length === 0) return;

  const MAX_PACKET_SIZE = 7;
  const packets = serialize.arrayAsMappedChunks(ids, MAX_PACKET_SIZE, (id) =>
    Buffer.from(id)
  );

  for (const p of packets) {
    await device.send(COMMAND.SIGN_TX, P1.ADD_TOKEN_IDS, sessionId, p);
  }
}

async function sendInputs(
  device: Device,
  sessionId: number,
  inputs: AttestedBox[]
) {
  for (const input of inputs) {
    for (const frame of input.frames) {
      await device.send(
        COMMAND.SIGN_TX,
        P1.ADD_INPUT_BOX_FRAME,
        sessionId,
        frame.bytes
      );
    }

    if (input.extension !== undefined && input.extension.length > 0) {
      await sendBoxContextExtension(device, sessionId, input.extension);
    }
  }
}

async function sendBoxContextExtension(
  device: Device,
  sessionId: number,
  extension: Buffer
) {
  await device.sendData(
    COMMAND.SIGN_TX,
    P1.ADD_INPUT_BOX_CONTEXT_EXTENSION_CHUNK,
    sessionId,
    extension
  );
}

async function sendDataInputs(
  device: Device,
  sessionId: number,
  boxIds: string[]
) {
  const MAX_PACKET_SIZE = 7;
  const packets = serialize.arrayAsMappedChunks(
    boxIds,
    MAX_PACKET_SIZE,
    serialize.hex
  );

  for (const p of packets) {
    await device.send(COMMAND.SIGN_TX, P1.ADD_DATA_INPUTS, sessionId, p);
  }
}

async function sendOutputs(
  device: Device,
  sessionId: number,
  boxes: BoxCandidate[],
  changeMap: ChangeMap,
  distinctTokenIds: Uint8Array[]
) {
  const distinctTokenIdsStr = distinctTokenIds.map((t) =>
    Buffer.from(t).toString("hex")
  );

  for (const box of boxes) {
    await device.send(
      COMMAND.SIGN_TX,
      P1.ADD_OUTPUT_BOX_START,
      sessionId,
      Buffer.concat([
        serialize.uint64(box.value),
        serialize.uint32(box.ergoTree.length),
        serialize.uint32(box.creationHeight),
        serialize.uint8(box.tokens.length),
        serialize.uint32(box.registers.length)
      ])
    );

    const tree = deserialize.hex(box.ergoTree);
    if (tree === MINER_FEE_TREE) {
      await addOutputBoxMinersFeeTree(device, sessionId);
    } else if (
      ErgoAddress.fromErgoTree(tree).toString() === changeMap.address
    ) {
      await addOutputBoxChangeTree(device, sessionId, changeMap.path);
    } else {
      await addOutputBoxErgoTree(device, sessionId, box.ergoTree);
    }

    if (box.tokens && box.tokens.length > 0) {
      await addOutputBoxTokens(
        device,
        sessionId,
        box.tokens,
        distinctTokenIdsStr
      );
    }

    if (box.registers.length > 0) {
      await addOutputBoxRegisters(device, sessionId, box.registers);
    }
  }
}

async function addOutputBoxErgoTree(
  device: Device,
  sessionId: number,
  ergoTree: Buffer
) {
  await device.sendData(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_ERGO_TREE_CHUNK,
    sessionId,
    ergoTree
  );
}

async function addOutputBoxMinersFeeTree(device: Device, sessionId: number) {
  await device.send(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_MINERS_FEE_TREE,
    sessionId,
    Buffer.from([])
  );
}

async function addOutputBoxChangeTree(
  device: Device,
  sessionId: number,
  path: string
) {
  await device.send(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_CHANGE_TREE,
    sessionId,
    serialize.path(path)
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
    serialize.array(tokens, (t) =>
      Buffer.concat([
        serialize.uint32(distinctTokenIds.indexOf(t.id)),
        serialize.uint64(t.amount)
      ])
    )
  );
}

async function addOutputBoxRegisters(
  device: Device,
  sessionId: number,
  registers: Buffer
) {
  await device.sendData(
    COMMAND.SIGN_TX,
    P1.ADD_OUTPUT_BOX_REGISTERS_CHUNK,
    sessionId,
    registers
  );
}

async function sendConfirmAndSign(
  device: Device,
  sessionId: number
): Promise<Buffer> {
  const response = await device.send(
    COMMAND.SIGN_TX,
    P1.CONFIRM_AND_SIGN,
    sessionId,
    Buffer.from([])
  );

  return response.data;
}
