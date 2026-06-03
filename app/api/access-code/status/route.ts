import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/app/api/access-code/verify/route';
import { clearErpSessionCookies, getErpAuthStatus } from '@/lib/server/erp-auth';

export async function GET(request: NextRequest) {
  const erpStatus = await getErpAuthStatus(request);
  if (erpStatus.enabled) {
    const response = NextResponse.json({
      success: true,
      enabled: true,
      authenticated: erpStatus.authenticated,
      mode: 'erp',
      redirectUrl: erpStatus.redirectUrl,
    });

    if (!erpStatus.authenticated) {
      clearErpSessionCookies(response);
    }

    return response;
  }

  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const token = request.cookies.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return NextResponse.json({
    success: true,
    enabled,
    authenticated,
    mode: enabled ? 'access_code' : 'none',
  });
}
