import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { buildErpApiHeaders, buildErpApiUrl } from '@/lib/server/erp-api';
import { readErpAccessTokenFromRequest } from '@/lib/server/erp-auth';
import { isErpAuthEnabled } from '@/lib/shared/erp-auth';

const log = createLogger('TrainingCourseAssets');

export async function POST(request: NextRequest) {
  try {
    const erpAccessToken = readErpAccessTokenFromRequest(request);
    if (isErpAuthEnabled() && !erpAccessToken) {
      return NextResponse.json({ error: 'Missing ERP session' }, { status: 401 });
    }

    const formData = await request.formData();

    const erpResponse = await fetch(buildErpApiUrl('/api/upload/file'), {
      method: 'POST',
      headers: buildErpApiHeaders({}, erpAccessToken),
      body: formData,
    });

    const data = await erpResponse.json().catch(() => ({}));

    if (!erpResponse.ok) {
      return NextResponse.json(
        { error: data?.message || data?.error || `ERP upload failed with HTTP ${erpResponse.status}` },
        { status: erpResponse.status },
      );
    }

    return NextResponse.json(data, { status: erpResponse.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Training course asset upload failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
