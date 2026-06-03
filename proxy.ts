import { NextRequest, NextResponse } from 'next/server';
import { buildErpApiHeaders, buildErpApiUrl } from '@/lib/server/erp-api';
import { isErpAuthEnabled } from '@/lib/shared/erp-auth';
import {
  createSignedErpUserToken,
  getErpUserCookieName,
  getErpUsernameFromCurrentUser,
} from '@/lib/shared/erp-user-session';

// ---- Access code helpers (migrated from middleware.ts) ----

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verify an HMAC-signed token using Web Crypto API (Edge-compatible) */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  // Constant-length comparison (not truly constant-time in JS, but sufficient here)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---- ERP auth helpers ----

const ERP_ACCESS_TOKEN_COOKIE_NAME = 'openmaic_erp_token';
const DEFAULT_ERP_AUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60 * 60;

function getErpCookieMaxAgeSeconds() {
  const configured = Number(process.env.ERP_AUTH_COOKIE_MAX_AGE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_ERP_AUTH_COOKIE_MAX_AGE_SECONDS;
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: getErpCookieMaxAgeSeconds(),
  };
}

function getErpAuthRedirectUrl() {
  return process.env.ERP_AUTH_REDIRECT_URL?.trim() || '';
}

async function fetchErpCurrentUser(token: string) {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return null;
  }

  try {
    const response = await fetch(buildErpApiUrl('/api/auth/currentUser'), {
      method: 'GET',
      headers: buildErpApiHeaders({}, normalizedToken),
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    const currentUser = await response.json().catch(() => null);
    return currentUser && typeof currentUser === 'object' ? currentUser : null;
  } catch {
    return null;
  }
}

async function setErpSessionCookies(
  response: NextResponse,
  token: string,
  currentUser: Record<string, unknown> | null,
) {
  response.cookies.set(ERP_ACCESS_TOKEN_COOKIE_NAME, token, getCookieOptions());

  const secret = process.env.ERP_AUTH_SECRET?.trim();
  if (!secret || !currentUser) {
    return;
  }

  const username = getErpUsernameFromCurrentUser(currentUser);
  const signedToken = await createSignedErpUserToken(username, secret);
  if (!signedToken) {
    return;
  }

  response.cookies.set(getErpUserCookieName(), signedToken, getCookieOptions());
}

function clearErpSessionCookies(response: NextResponse) {
  response.cookies.set(ERP_ACCESS_TOKEN_COOKIE_NAME, '', {
    ...getCookieOptions(),
    maxAge: 0,
  });
  response.cookies.set(getErpUserCookieName(), '', {
    ...getCookieOptions(),
    maxAge: 0,
  });
}

function buildUnauthorizedResponse() {
  const redirectUrl = getErpAuthRedirectUrl();
  const response = redirectUrl
    ? NextResponse.redirect(new URL(redirectUrl))
    : new NextResponse('ERP authentication required', { status: 401 });

  clearErpSessionCookies(response);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/api/access-code/') ||
    pathname.startsWith('/api/erp-auth/') ||
    pathname === '/api/health'
  ) {
    return NextResponse.next();
  }

  // ---- Access code gate ----
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode) {
    // Check cookie — validate HMAC signature, not just existence
    const cookie = request.cookies.get('openmaic_access');
    if (!cookie?.value || !(await verifyToken(cookie.value, accessCode))) {
      // API requests without valid cookie → 401
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
          { status: 401 },
        );
      }
      // Page requests → let through, frontend shows modal
    }
  }

  // ---- ERP auth gate ----
  if (!isErpAuthEnabled()) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const bootstrapToken = request.nextUrl.searchParams.get('erp_token')?.trim();
  if (bootstrapToken) {
    const currentUser = await fetchErpCurrentUser(bootstrapToken);
    if (!currentUser) {
      return buildUnauthorizedResponse();
    }

    const targetUrl = request.nextUrl.clone();
    targetUrl.searchParams.delete('erp_token');
    targetUrl.searchParams.delete('erp_ip');

    const response = NextResponse.redirect(targetUrl);
    await setErpSessionCookies(response, bootstrapToken, currentUser);
    return response;
  }

  const cookieToken = request.cookies.get(ERP_ACCESS_TOKEN_COOKIE_NAME)?.value?.trim();
  if (!cookieToken) {
    return buildUnauthorizedResponse();
  }

  const currentUser = await fetchErpCurrentUser(cookieToken);
  if (!currentUser) {
    return buildUnauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
