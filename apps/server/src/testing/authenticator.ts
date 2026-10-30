import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/** A passkey as JSON: its private key as a JWK, so a fixture can carry it between builds. */
export type SavedKey = { id: string; jwk: object; userHandle: string; counter: number };

/**
 * A software passkey authenticator for tests: what a phone's platform authenticator returns
 * to navigator.credentials, built by hand (ES256, "none" attestation, discoverable). The
 * server verifies its output with @simplewebauthn/server exactly as it would a real phone's.
 */
export class SoftAuthenticator {
  readonly #keys = new Map<string, { key: KeyObject; userHandle: string; counter: number }>();

  constructor(readonly origin: string) {}

  /** The passkeys this authenticator holds, as JSON. */
  save(): SavedKey[] {
    return [...this.#keys].map(([id, k]) => ({
      id,
      jwk: k.key.export({ format: 'jwk' }),
      userHandle: k.userHandle,
      counter: k.counter,
    }));
  }

  /** An authenticator holding passkeys saved earlier, e.g. by an older server's test run. */
  static load(origin: string, saved: SavedKey[]): SoftAuthenticator {
    const a = new SoftAuthenticator(origin);
    for (const k of saved) {
      a.#keys.set(k.id, {
        key: createPrivateKey({ key: k.jwk as never, format: 'jwk' }),
        userHandle: k.userHandle,
        counter: k.counter,
      });
    }
    return a;
  }

  /** navigator.credentials.create(): a new passkey for the options' rp and user. */
  create(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialId = randomBytes(16);
    const id = credentialId.toString('base64url');
    this.#keys.set(id, { key: privateKey, userHandle: options.user.id, counter: 0 });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      rpIdHash(options.rp.id!),
      Buffer.from([0x45]), // user present, user verified, attested credential data
      counter(0),
      Buffer.alloc(16), // AAGUID
      idLength,
      credentialId,
      cbor(cose),
    ]);
    const clientData = this.#clientData('webauthn.create', options.challenge);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData.toString('base64url'),
        attestationObject: cbor({ fmt: 'none', attStmt: {}, authData }).toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get(): an assertion from a passkey this authenticator holds. */
  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    id = [...this.#keys.keys()][0]!,
  ): AuthenticationResponseJSON {
    const held = this.#keys.get(id);
    if (!held) throw new Error('No such passkey');
    held.counter += 1;
    const authData = Buffer.concat([
      rpIdHash(options.rpId!),
      Buffer.from([0x05]),
      counter(held.counter),
    ]);
    const clientData = this.#clientData('webauthn.get', options.challenge);
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: sign('sha256', signed, held.key).toString('base64url'),
        userHandle: held.userHandle,
      },
      clientExtensionResults: {},
    };
  }

  #clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }
}

const rpIdHash = (rpId: string) => createHash('sha256').update(rpId).digest();

function counter(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** The CBOR subset WebAuthn needs: integers, byte and text strings, and maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const text = Buffer.from(value);
    return Buffer.concat([head(3, text.length), text]);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}
