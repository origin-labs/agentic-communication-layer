import { createHash, X509Certificate } from "node:crypto";
import { type ContactRecord, type TrustPinStatus } from "@acl/acl-types";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32NoPaddingLowercase(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function derivePeerIdFromCertificatePem(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem);
  const spkiDer = certificate.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const digest = createHash("sha256").update(spkiDer).digest();
  return `peer_spki_sha256_${base32NoPaddingLowercase(digest)}`;
}

export function evaluateTrust(contact: ContactRecord | undefined, observedPeerId: string): TrustPinStatus {
  if (!contact?.pinnedPeerId) {
    return { status: "untrusted", observedPeerId };
  }
  if (contact.pinnedPeerId === observedPeerId) {
    return { status: "matched", observedPeerId, expectedPeerId: contact.pinnedPeerId };
  }
  return { status: "mismatch", observedPeerId, expectedPeerId: contact.pinnedPeerId };
}
