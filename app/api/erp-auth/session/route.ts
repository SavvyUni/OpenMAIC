import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import {
  clearErpSessionCookies,
  fetchErpCurrentUser,
  getErpAuthStatus,
  setErpSessionCookies,
} from '@/lib/server/erp-auth';

const log = createLogger('ErpAuthSession');

export async function GET(request: NextRequest) {
  const status = await getErpAuthStatus(request);
  const response = NextResponse.json({
    success: true,
    enabled: status.enabled,
    authenticated: status.authenticated,
    currentUser: status.currentUser,
    redirectUrl: status.redirectUrl,
  });

  if (status.enabled && !status.authenticated) {
    clearErpSessionCookies(response);
  }

  return response;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';

    if (!token) {
      const response = NextResponse.json(
        { success: false, error: 'Missing ERP token' },
        { status: 400 },
      );
      clearErpSessionCookies(response);
      return response;
    }

    const currentUser = await fetchErpCurrentUser(token);
    if (!currentUser) {
      const response = NextResponse.json(
        { success: false, error: 'Invalid or expired ERP token' },
        { status: 401 },
      );
      clearErpSessionCookies(response);
      return response;
    }

    const response = NextResponse.json({
      success: true,
      authenticated: true,
      currentUser,
    });
    await setErpSessionCookies(response, token, currentUser);
    return response;
  } catch (error) {
    log.error('Failed to bootstrap ERP session:', error);
    const response = NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
    clearErpSessionCookies(response);
    return response;
  }
}
