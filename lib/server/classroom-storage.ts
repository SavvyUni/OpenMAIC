import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { buildErpApiHeaders, buildErpApiUrl } from '@/lib/server/erp-api';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');
const ERP_LESSON_OPENMAIC_SYNC_PATH = '/api/lessons/openmaic/sync';
const ERP_LESSON_OPENMAIC_CLASSROOM_PATH = '/api/lessons/openmaic/classroom';
const ERP_TRAINING_COURSE_BUCKET = 'savvyuni-intl-erp';

const log = createLogger('ClassroomStorage');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

interface CourseSyncInput {
  lessonId?: number;
  trainingCourseId?: number;
  stage: Stage;
  scenes?: Scene[];
  manifestBucket?: string;
  manifestKey?: string;
  createdBy?: string;
  erpAccessToken?: string;
}

interface UploadedManifest {
  bucket: string;
  key: string;
  url: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isErpManagedStage(stage: Stage | null | undefined) {
  return Boolean(process.env.ERP_API_BASE_URL?.trim() && stage?.erpLessonId);
}

function buildManifestKey(stage: Stage, classroomId: string) {
  const scope = stage.erpLessonId
    ? `lesson-${sanitizePathSegment(String(stage.erpLessonId))}`
    : `stage-${sanitizePathSegment(classroomId)}`;

  return `openmaic/${scope}/${sanitizePathSegment(classroomId)}/manifest/classroom.json`;
}

async function uploadManifestToErp(
  classroomData: PersistedClassroomData,
  stage: Stage,
  erpAccessToken?: string,
): Promise<UploadedManifest> {
  const key = buildManifestKey(stage, classroomData.id);
  const content = JSON.stringify(classroomData, null, 2);
  const formData = new FormData();

  formData.set('bucket', ERP_TRAINING_COURSE_BUCKET);
  formData.set('key', key);
  formData.set(
    'file',
    new Blob([content], { type: 'application/json' }),
    `${sanitizePathSegment(classroomData.id)}.json`,
  );

  const response = await proxyFetch(buildErpApiUrl('/api/upload/file'), {
    method: 'POST',
    headers: buildErpApiHeaders({}, erpAccessToken),
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || `ERP manifest upload failed with HTTP ${response.status}`,
    );
  }

  if (!data?.bucket || !data?.key || !data?.url) {
    throw new Error('ERP manifest upload API returned an incomplete payload');
  }

  return {
    bucket: data.bucket,
    key: data.key,
    url: data.url,
  };
}

async function readLocalClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readErpClassroom(
  id: string,
  erpAccessToken?: string,
): Promise<PersistedClassroomData | null> {
  const url = new URL(buildErpApiUrl(ERP_LESSON_OPENMAIC_CLASSROOM_PATH));
  url.searchParams.set('openmaicId', id);

  const response = await proxyFetch(url.toString(), {
    method: 'GET',
    headers: buildErpApiHeaders({}, erpAccessToken),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `ERP classroom fetch failed with HTTP ${response.status}${
        errorText ? `: ${errorText.slice(0, 200)}` : ''
      }`,
    );
  }

  const data = await response.json().catch(() => null);
  return data?.classroom || null;
}

export async function readClassroom(
  id: string,
  options: { erpAccessToken?: string } = {},
): Promise<PersistedClassroomData | null> {
  if (process.env.ERP_API_BASE_URL?.trim()) {
    const erpClassroom = await readErpClassroom(id, options.erpAccessToken);
    if (erpClassroom) {
      return erpClassroom;
    }
  }

  return readLocalClassroom(id);
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    createdBy?: string;
    erpAccessToken?: string;
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  const courseUrl = `${baseUrl}/classroom/${data.id}`;
  console.log(
    `[persistClassroom] stage.erpLessonId=${data.stage.erpLessonId} erpTrainingCourseId=${data.stage.erpTrainingCourseId}`,
  );

  if (isErpManagedStage(data.stage)) {
    const manifest = await uploadManifestToErp(classroomData, data.stage, data.erpAccessToken);
    await syncCourseToTrainingService(
      data.stage,
      data.scenes,
      manifest.bucket,
      manifest.key,
      data.createdBy,
      data.erpAccessToken,
    );
  } else {
    await ensureClassroomsDir();
    const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
    await writeJsonFileAtomic(filePath, classroomData);

    await syncCourseToTrainingService(
      data.stage,
      data.scenes,
      undefined,
      undefined,
      data.createdBy,
      data.erpAccessToken,
    );
  }

  return {
    ...classroomData,
    url: courseUrl,
  };
}

export async function renamePersistedClassroom(
  id: string,
  name: string,
  description?: string,
  createdBy?: string,
  erpAccessToken?: string,
): Promise<PersistedClassroomData | null> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Classroom name is required');
  }

  const classroom = await readClassroom(id, { erpAccessToken });
  if (!classroom) {
    log.info(`Skipping ERP sync for rename: classroom [id=${id}] not found`);
    return null;
  }

  const updatedStage: Stage = {
    ...classroom.stage,
    name: trimmedName,
    updatedAt: Date.now(),
  };
  const updatedClassroom: PersistedClassroomData = {
    ...classroom,
    stage: updatedStage,
  };

  if (isErpManagedStage(updatedStage)) {
    const manifest = await uploadManifestToErp(updatedClassroom, updatedStage, erpAccessToken);
    await syncCourseToTrainingService(
      updatedStage,
      updatedClassroom.scenes,
      manifest.bucket,
      manifest.key,
      createdBy,
      erpAccessToken,
    );
  } else {
    await ensureClassroomsDir();
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    await writeJsonFileAtomic(filePath, updatedClassroom);
    await syncCourseToTrainingService(
      updatedStage,
      updatedClassroom.scenes,
      undefined,
      undefined,
      createdBy,
      erpAccessToken,
    );
  }

  return updatedClassroom;
}

async function syncCourseToTrainingService(
  stage: Stage,
  scenes?: Scene[],
  manifestBucket?: string,
  manifestKey?: string,
  createdBy?: string,
  erpAccessToken?: string,
) {
  // Skip ERP sync until the classroom is bound to a concrete ERP lesson.
  if (!stage.erpLessonId) {
    console.log(`[syncCourseToTrainingService] SKIP: no erpLessonId for stageId=${stage.id}`);
    return;
  }

  console.log(
    `[syncCourseToTrainingService] syncing stageId=${stage.id} lessonId=${stage.erpLessonId}`,
  );

  await syncCourseMetadataToTrainingService({
    lessonId: stage.erpLessonId,
    trainingCourseId: stage.erpTrainingCourseId,
    stage,
    scenes,
    manifestBucket,
    manifestKey,
    createdBy,
    erpAccessToken,
  });
}

async function syncCourseMetadataToTrainingService(course: CourseSyncInput) {
  const shouldIncludeFullPayload = !(course.manifestBucket && course.manifestKey);
  const body = JSON.stringify({
    lessonId: course.lessonId,
    ...(course.trainingCourseId ? { trainingCourseId: course.trainingCourseId } : {}),
    openmaicId: course.stage.id,
    name: course.stage.name,
    ...(course.stage.description !== undefined ? { description: course.stage.description } : {}),
    ...(course.manifestBucket ? { manifestBucket: course.manifestBucket } : {}),
    ...(course.manifestKey ? { manifestKey: course.manifestKey } : {}),
    ...(course.createdBy ? { createdBy: course.createdBy } : {}),
    ...(shouldIncludeFullPayload ? { stage: course.stage } : {}),
    ...(shouldIncludeFullPayload && course.scenes ? { scenes: course.scenes } : {}),
  });

  const response = await proxyFetch(buildErpApiUrl(ERP_LESSON_OPENMAIC_SYNC_PATH), {
    method: 'POST',
    headers: buildErpApiHeaders({ 'Content-Type': 'application/json' }, course.erpAccessToken),
    body,
  });

  if (response.ok) {
    log.info(`Synced OpenMAIC lesson payload to ERP [stageId=${course.stage.id}]`);
    return;
  }

  const errorText = await response.text().catch(() => '');
  throw new Error(
    `ERP lesson OpenMAIC sync failed with HTTP ${response.status}${
      errorText ? `: ${errorText.slice(0, 200)}` : ''
    }`,
  );
}
