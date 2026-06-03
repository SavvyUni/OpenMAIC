import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { buildErpApiHeaders, buildErpApiUrl } from '@/lib/server/erp-api';
import { isErpAuthEnabled } from '@/lib/shared/erp-auth';
import {
  createSignedErpUserToken,
  getErpUserCookieName,
  getErpUsernameFromCurrentUser,
} from '@/lib/shared/erp-user-session';

const ERP_ACCESS_TOKEN_COOKIE_NAME = 'openmaic_erp_token';
const DEFAULT_ERP_AUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60 * 60;
const log = createLogger('ErpAuth');

type CookieCarrier = Pick<NextRequest, 'cookies'>;

export interface ErpAuthStatus {
  enabled: boolean;
  authenticated: boolean;
  currentUser: Record<string, unknown> | null;
  token: string;
  redirectUrl: string;
}

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

export function getErpAuthRedirectUrl() {
  return process.env.ERP_AUTH_REDIRECT_URL?.trim() || '';
}

export function readErpAccessTokenFromRequest(request: CookieCarrier) {
  return request.cookies.get(ERP_ACCESS_TOKEN_COOKIE_NAME)?.value?.trim() || '';
}

export async function fetchErpCurrentUser(token: string) {
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
  } catch (error) {
    log.warn('Failed to fetch ERP current user:', error);
    return null;
  }
}

export async function getErpAuthStatus(request: NextRequest): Promise<ErpAuthStatus> {
  const redirectUrl = getErpAuthRedirectUrl();
  if (!isErpAuthEnabled()) {
    return {
      enabled: false,
      authenticated: true,
      currentUser: null,
      token: '',
      redirectUrl,
    };
  }

  const token = readErpAccessTokenFromRequest(request);
  if (!token) {
    return {
      enabled: true,
      authenticated: false,
      currentUser: null,
      token: '',
      redirectUrl,
    };
  }

  const currentUser = await fetchErpCurrentUser(token);
  return {
    enabled: true,
    authenticated: !!currentUser,
    currentUser,
    token: currentUser ? token : '',
    redirectUrl,
  };
}

export async function setErpSessionCookies(
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

export function clearErpSessionCookies(response: NextResponse) {
  response.cookies.set(ERP_ACCESS_TOKEN_COOKIE_NAME, '', {
    ...getCookieOptions(),
    maxAge: 0,
  });
  response.cookies.set(getErpUserCookieName(), '', {
    ...getCookieOptions(),
    maxAge: 0,
  });
}
