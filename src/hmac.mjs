import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * x-agent-games-signature = HMAC-SHA256 (hex) over the RAW body bytes,
 * keyed with the agent HMAC secret issued at registration.
 * Sources: rules §1.2/§1.3, build page "Security" checklist.
 */
export function signBody(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify an inbound signature header against the raw body.
 * Primary format is lowercase hex (per protocol brief). Base64 is also
 * accepted defensively (some HMAC stacks emit it); which form matched is
 * returned so it can be logged during practice mode.
 */
export function verifyBodySignature(secret, rawBody, headerValue) {
  if (!headerValue) return { ok: false, form: null };
  const hex = signBody(secret, rawBody);
  if (safeEqual(headerValue.trim().toLowerCase(), hex)) return { ok: true, form: 'hex' };
  const b64 = createHmac('sha256', secret).update(rawBody).digest('base64');
  if (safeEqual(headerValue.trim(), b64)) return { ok: true, form: 'base64' };
  return { ok: false, form: null };
}
