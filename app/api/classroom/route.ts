import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  renamePersistedClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import {
  getErpUserCookieName,
  getErpUsernameFromCurrentUser,
  readSignedErpUserToken,
} from '@/lib/shared/erp-user-session';
import { isErpAuthEnabled } from '@/lib/shared/erp-auth';
import { fetchErpCurrentUser, readErpAccessTokenFromRequest } from '@/lib/server/erp-auth';

const log = createLogger('Classroom API');

async function getCurrentErpUsername(request: NextRequest) {
  const secret = process.env.ERP_AUTH_SECRET?.trim();
  const cookieValue = request.cookies.get(getErpUserCookieName())?.value;
  if (secret && cookieValue) {
    const signedUsername = await readSignedErpUserToken(cookieValue, secret);
    if (signedUsername) {
      return signedUsername;
    }
  }

  const erpAccessToken = readErpAccessTokenFromRequest(request);
  if (!erpAccessToken) {
    return '';
  }

  const currentUser = await fetchErpCurrentUser(erpAccessToken);
  return getErpUsernameFromCurrentUser(currentUser);
}

export async function POST(request: NextRequest) {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    const erpAccessToken = readErpAccessTokenFromRequest(request);
    if (isErpAuthEnabled() && !erpAccessToken) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, 'Missing ERP session');
    }

    const body = await request.json();
    const { stage, scenes } = body;
    stageId = stage?.id;
    sceneCount = scenes?.length;
    console.log(`[POST /api/classroom] stageId=${stageId} hasStage=${!!stage} hasScenes=${!!scenes} erpLessonId=${stage?.erpLessonId}`);

    if (!stage || !scenes) {
      console.log(`[POST /api/classroom] missing fields, returning 400`);
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const id = stage.id || randomUUID();
    const baseUrl = buildRequestOrigin(request);
    const createdBy = await getCurrentErpUsername(request);

    const persisted = await persistClassroom(
      { id, stage: { ...stage, id }, scenes, createdBy, erpAccessToken },
      baseUrl,
    );

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(
      `Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    const erpAccessToken = readErpAccessTokenFromRequest(request);

    if (isErpAuthEnabled() && !erpAccessToken) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, 'Missing ERP session');
    }

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id, { erpAccessToken });
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    return apiSuccess({ classroom });
  } catch (error) {
    log.error(
      `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function PATCH(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  try {
    const erpAccessToken = readErpAccessTokenFromRequest(request);
    if (isErpAuthEnabled() && !erpAccessToken) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, 'Missing ERP session');
    }

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description : undefined;

    if (!name) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required field: name',
      );
    }

    const createdBy = await getCurrentErpUsername(request);
    const classroom = await renamePersistedClassroom(
      id,
      name,
      description,
      createdBy,
      erpAccessToken,
    );
    return apiSuccess({ classroom, synced: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Classroom rename failed [id=${id ?? 'unknown'}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to rename classroom',
      message,
    );
  }
}
