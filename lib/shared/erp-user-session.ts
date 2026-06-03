const ERP_USER_COOKIE_NAME = 'openmaic_erp_user';

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

async function signValue(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return bufToHex(
    await crypto.subtle.sign('HMAC', key, encode(value).buffer as ArrayBuffer),
  );
}

function getCookieSafeUsername(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, 100);
}

export function getErpUserCookieName() {
  return ERP_USER_COOKIE_NAME;
}

export function getErpUsernameFromCurrentUser(currentUser: Record<string, unknown> | null | undefined) {
  return getCookieSafeUsername(currentUser?.chineseName || currentUser?.username);
}

export async function createSignedErpUserToken(username: string, secret: string) {
  const safeUsername = getCookieSafeUsername(username);
  if (!safeUsername) {
    return '';
  }

  const timestamp = Date.now().toString();
  const encodedUsername = bytesToBase64Url(encode(safeUsername));
  const payload = `${timestamp}.${encodedUsername}`;
  const signature = await signValue(payload, secret);

  return `${payload}.${signature}`;
}

export async function readSignedErpUserToken(
  token: string,
  secret: string,
  maxAgeSeconds?: number,
) {
  const firstDot = token.indexOf('.');
  const lastDot = token.lastIndexOf('.');

  if (firstDot === -1 || lastDot === -1 || firstDot === lastDot) {
    return null;
  }

  const timestamp = token.slice(0, firstDot);
  const encodedUsername = token.slice(firstDot + 1, lastDot);
  const signature = token.slice(lastDot + 1);
  const payload = `${timestamp}.${encodedUsername}`;
  const expectedSignature = await signValue(payload, secret);

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  let mismatch = 0;
  for (let index = 0; index < signature.length; index += 1) {
    mismatch |= signature.charCodeAt(index) ^ expectedSignature.charCodeAt(index);
  }

  if (mismatch !== 0) {
    return null;
  }

  if (maxAgeSeconds) {
    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > maxAgeSeconds * 1000) {
      return null;
    }
  }

  const bytes = base64UrlToBytes(encodedUsername);
  if (!bytes) {
    return null;
  }

  return getCookieSafeUsername(new TextDecoder().decode(bytes));
}
