import type Transport from "@ledgerhq/hw-transport";
import Device from "./interactions/common/device";
import {
  getAppName,
  getExtendedPublicKey,
  getAppVersion,
  deriveAddress,
  showAddress,
} from "./interactions";
import {
  AppName,
  AttestedBoxFrame,
  Box,
  DerivedAddress,
  ExtendedPublicKey,
  Version,
} from "./types/public";
import { assert } from "./validations/assert";
import { isValidErgoPath } from "./validations/parse";
import { pathStringToArray } from "./interactions/common/serialization";
import { attestInput } from "./interactions/attestInput";

export * from "./errors";
export * from "./types/public";
export const CLA = 0xe0;

const CHANGE_PATH_INDEX = 3;

/**
 * Ergo's Ledger hardware wallet API
 */
export default class ErgoApp {
  private _device: Device;
  private _authToken: number;

  constructor(transport: Transport, authToken = 0, scrambleKey = "ERG") {
    const methods = [
      "getAppVersion",
      "getAppName",
      "getExtendedPublicKey",
      "deriveAddress",
      "showAddress",
      "attestInput",
    ];
    transport.decorateAppAPIMethods(this, methods, scrambleKey);

    this._device = new Device(transport, CLA);
    this._authToken = authToken;
    if (this._authToken == 0) {
      this.newAuthToken();
    }
  }

  private newAuthToken(): void {
    let newToken = 0;
    do {
      newToken = Math.floor(Math.random() * 0xffffffff) + 1;
    } while (newToken === this._authToken);

    this._authToken = newToken;
  }

  /**
   * Get application version.
   * @returns a Promise with the Ledger Application version.
   */
  public async getAppVersion(): Promise<Version> {
    return getAppVersion(this._device);
  }

  /**
   * Get application name.
   * @returns a Promise with the Ledger Application name.
   */
  public async getAppName(): Promise<AppName> {
    return getAppName(this._device);
  }

  /**
   * Get the extended public key.
   * @param path BIP32 path.
   * @param useAuthToken use an authorization token to keep session opened.
   * @returns a Promise with the **chain code** and the **public key** for provided BIP32 path.
   */
  public async getExtendedPublicKey(
    path: string,
    useAuthToken: boolean = false
  ): Promise<ExtendedPublicKey> {
    const pathArray = pathStringToArray(path);
    assert(isValidErgoPath(pathArray), "Invalid Ergo path.");

    return getExtendedPublicKey(this._device, pathArray, this.getAuthToken(useAuthToken));
  }

  /**
   * Derive the address for a given Bip44 path.
   * @param path Bip44 path.
   * @param useAuthToken use an authorization token to keep session opened.
   * @returns a Promise with the derived address in hex format.
   */
  public async deriveAddress(path: string, useAuthToken = false): Promise<DerivedAddress> {
    const pathArray = this.getDerivationPathArray(path);
    return deriveAddress(this._device, pathArray, this.getAuthToken(useAuthToken));
  }

  /**
   * Derive and show the address on device screen for a given Bip44 path.
   * @param path Bip44 path.
   * @param useAuthToken use an authorization token to keep session opened.
   * @returns a Promise with true if the user accepts or throws an exception if it get rejected.
   */
  public async showAddress(path: string, useAuthToken = false): Promise<boolean> {
    const pathArray = this.getDerivationPathArray(path);
    return showAddress(this._device, pathArray, this.getAuthToken(useAuthToken));
  }

  private getDerivationPathArray(path: string) {
    const pathArray = pathStringToArray(path);
    assert(isValidErgoPath(pathArray), "Invalid Ergo path.");
    assert(pathArray.length >= 5, "Invalid path lenght.");
    assert(pathArray[CHANGE_PATH_INDEX] in [0, 1], "Invalid change path value.");

    return pathArray;
  }

  public async attestInput(box: Box, useAuthToken = false): Promise<AttestedBoxFrame[]> {
    return attestInput(this._device, box, this.getAuthToken(useAuthToken));
  }

  private getAuthToken(useAuthToken: boolean): number | undefined {
    return useAuthToken ? this._authToken : undefined;
  }

  /**
   * Close device transport.
   * @return a Promise that end when the transport is closed.
   */
  public closeTransport(): Promise<void> {
    return this._device.Transport.close();
  }
}
