import { COMMAND, RETURN_CODE, type Device } from "../device";
import type { DerivedAddress } from "../types/public";
import type { DeviceResponse } from "../types/internal";
import { pathToArray, serialize } from "../serialization/serialize";
import { deserialize } from "../serialization/deserialize";
import type { Network } from "@fleet-sdk/common";

const enum ReturnType {
  Return = 0x01,
  Display = 0x02
}

const enum P1 {
  RETURN = 0x01,
  DISPLAY = 0x02
}

const enum P2 {
  WITHOUT_TOKEN = 0x01,
  WITH_TOKEN = 0x02
}

const CHANGE_PATH_INDEX = 3;
const ALLOWED_CHANGE_PATHS = [0, 1];

function sendDeriveAddress(
  device: Device,
  network: Network,
  path: string,
  returnType: ReturnType,
  authToken?: number
): Promise<DeviceResponse> {
  const pathArray = pathToArray(path);
  if (pathArray.length < 5) {
    throw new Error(`Invalid path length. ${pathArray.length}`);
  }

  const change = pathArray[CHANGE_PATH_INDEX];
  if (!ALLOWED_CHANGE_PATHS.includes(change)) {
    throw new Error(`Invalid change path: ${change}`);
  }

  const data = Buffer.concat([
    Buffer.alloc(1, network),
    serialize.path(pathArray)
  ]);

  return device.send(
    COMMAND.DERIVE_ADDRESS,
    returnType === ReturnType.Return ? P1.RETURN : P1.DISPLAY,
    authToken ? P2.WITH_TOKEN : P2.WITHOUT_TOKEN,
    authToken ? Buffer.concat([data, serialize.uint32(authToken)]) : data
  );
}

export async function deriveAddress(
  device: Device,
  network: Network,
  path: string,
  authToken?: number
): Promise<DerivedAddress> {
  const response = await sendDeriveAddress(
    device,
    network,
    path,
    ReturnType.Return,
    authToken
  );
  return { addressHex: deserialize.hex(response.data) };
}

export async function showAddress(
  device: Device,
  network: Network,
  path: string,
  authToken?: number
): Promise<boolean> {
  const response = await sendDeriveAddress(
    device,
    network,
    path,
    ReturnType.Display,
    authToken
  );
  return response.returnCode === RETURN_CODE.OK;
}
