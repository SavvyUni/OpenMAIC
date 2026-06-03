import { createLogger } from '@/lib/logger';
import type { Scene, Stage } from '@/lib/types/stage';
import { prepareClassroomAssetsForPersistence } from '@/lib/utils/training-course-assets';

const log = createLogger('ClassroomPersistence');

interface PersistClassroomResult {
  success: boolean;
  id?: string;
  url?: string;
  error?: string;
  details?: string;
}

async function parsePersistResponse(response: Response): Promise<PersistClassroomResult> {
  const data = await response
    .json()
    .catch(() => ({ success: false, error: `HTTP ${response.status}` }));

  if (!response.ok || !data.success) {
    const details =
      typeof data.details === 'string' && data.details.trim() ? data.details.trim() : undefined;
    return {
      success: false,
      error:
        details && data.error
          ? `${data.error}: ${details}`
          : data.error || details || `HTTP ${response.status}`,
      details,
    };
  }

  return {
    success: true,
    id: data.id,
    url: data.url,
  };
}

export async function persistClassroomToServer(
  stage: Stage | null | undefined,
  scenes: Scene[],
): Promise<PersistClassroomResult> {
  if (!stage?.id || scenes.length === 0) {
    return {
      success: false,
      error: 'Missing stage id or scenes',
    };
  }

  try {
    const preparedScenes = await prepareClassroomAssetsForPersistence(stage, scenes);
    const response = await fetch('/api/classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, scenes: preparedScenes }),
    });

    const result = await parsePersistResponse(response);
    if (!result.success) {
      const error = result.error || `HTTP ${response.status}`;
      log.warn(`Failed to persist classroom [stageId=${stage.id}, scenes=${scenes.length}]`, error);
      return { success: false, error };
    }

    log.info(`Persisted classroom [stageId=${stage.id}, scenes=${scenes.length}]`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to persist classroom [stageId=${stage.id}, scenes=${scenes.length}]`, error);
    return {
      success: false,
      error: message,
    };
  }
}

export async function renameClassroomOnServer(
  classroomId: string,
  name: string,
  description?: string,
): Promise<PersistClassroomResult> {
  try {
    const response = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(description !== undefined ? { description } : {}),
      }),
    });

    return await parsePersistResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to rename classroom on server [stageId=${classroomId}]`, error);
    return {
      success: false,
      error: message,
    };
  }
}
