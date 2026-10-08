/**
 * Generate a VAPID keypair for web push.
 *
 * VAPID is how a push service knows that the thing asking it to wake a device
 * is the same party the device subscribed to. The browser is handed the public
 * key at subscribe time; the Worker signs a short-lived JWT with the private
 * half on every send.
 *
 * No dependency: Node's WebCrypto generates P-256 and exports JWK, which is
 * the same shape the Worker imports. The usual `web-push` CLI emits a raw
 * base64url scalar instead, which WebCrypto cannot import without hand-built
 * PKCS#8 — so this script deliberately emits the JWK and the Worker reads it
 * directly.
 *
 *   node scripts/gen-vapid.mjs
 *
 * Run it ONCE. Regenerating invalidates every existing subscription, and every
 * device has to re-enable notifications.
 */
import { webcrypto } from 'node:crypto';

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/*
  The public key goes on the wire as the uncompressed EC point — 0x04 followed
  by X and Y, 65 bytes — which is exactly what WebCrypto's "raw" export gives,
  and exactly what `applicationServerKey` and the VAPID `k=` parameter expect.
*/
const rawPublic = await webcrypto.subtle.exportKey('raw', publicKey);
const jwkPrivate = await webcrypto.subtle.exportKey('jwk', privateKey);

// `key_ops` and `ext` travel badly through some JSON round-trips and the
// Worker does not need them; importKey supplies its own usages.
delete jwkPrivate.key_ops;
delete jwkPrivate.ext;

console.log(`
VAPID keypair generated. Set both as Worker secrets, from the worker/ directory:

  wrangler secret put VAPID_PUBLIC_KEY
  ${b64url(rawPublic)}

  wrangler secret put VAPID_PRIVATE_JWK
  ${JSON.stringify(jwkPrivate)}

Keep the private half secret. Anyone holding it can wake every device that has
subscribed to this Worker. It is never sent to the browser.
`);
