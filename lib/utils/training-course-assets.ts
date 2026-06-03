import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import type { PPTVideoElement } from '@/lib/types/slides';
import type { Scene, Stage } from '@/lib/types/stage';
import { db, mediaFileKey, type AudioFileRecord, type MediaFileRecord } from '@/lib/utils/database';

const ERP_UPLOAD_ENDPOINT = '/api/training-course-assets';
const ERP_UPLOAD_BUCKET = 'savvyuni-intl-erp';
const pendingUploads = new Map<string, Promise<UploadedAsset>>();

interface UploadedAsset {
  url: string;
  key: string;
  bucket: string;
}

type SlideMediaElement = {
  type?: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

type SpeechAction = {
  id?: string;
  type?: string;
  audioId?: string;
  audioUrl?: string;
};

function isGeneratedMediaRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_(img|vid)_[\w-]+$/i.test(value);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function extensionFromMimeType(mimeType?: string, fallback = 'bin') {
  const normalized = mimeType?.toLowerCase();
  switch (normalized) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mp4':
    case 'audio/aac':
      return 'm4a';
    case 'audio/ogg':
      return 'ogg';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    default:
      return fallback;
  }
}

function getTrainingCourseScope(stage: Stage) {
  return stage.erpLessonId ? `lesson-${stage.erpLessonId}` : `stage-${stage.id}`;
}

function buildAssetKey(options: {
  stage: Stage;
  kind: 'audio' | 'image' | 'video';
  assetId: string;
  mimeType?: string;
  suffix?: string;
}) {
  const { stage, kind, assetId, mimeType, suffix } = options;
  const scope = sanitizePathSegment(getTrainingCourseScope(stage));
  const stageId = sanitizePathSegment(stage.id);
  const safeAssetId = sanitizePathSegment(assetId);
  const ext = extensionFromMimeType(mimeType, kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3');
  const suffixPart = suffix ? `-${sanitizePathSegment(suffix)}` : '';

  return `openmaic/${scope}/${stageId}/${kind}/${safeAssetId}${suffixPart}.${ext}`;
}

async function uploadAsset(options: {
  blob: Blob;
  key: string;
  fileName: string;
}): Promise<UploadedAsset> {
  const formData = new FormData();
  formData.set('bucket', ERP_UPLOAD_BUCKET);
  formData.set('key', options.key);
  formData.set(
    'file',
    new File([options.blob], options.fileName, {
      type: options.blob.type || undefined,
    }),
  );

  const response = await fetch(ERP_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
  }

  if (!data?.url || !data?.key || !data?.bucket) {
    throw new Error('ERP upload API returned an incomplete asset payload');
  }

  return {
    url: data.url,
    key: data.key,
    bucket: data.bucket,
  };
}

async function uploadAssetOnce(cacheKey: string, execute: () => Promise<UploadedAsset>) {
  const existing = pendingUploads.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = execute().finally(() => {
    pendingUploads.delete(cacheKey);
  });
  pendingUploads.set(cacheKey, promise);
  return promise;
}

async function ensureAudioAsset(
  stage: Stage,
  action: SpeechAction,
  audioRecord: AudioFileRecord,
): Promise<void> {
  if (audioRecord.ossKey) {
    action.audioUrl = audioRecord.ossKey;
    return;
  }

  const audioId = action.audioId || audioRecord.id;
  const key = buildAssetKey({
    stage,
    kind: 'audio',
    assetId: audioId,
    mimeType: audioRecord.blob.type || audioRecord.format,
  });
  const fileName = `${sanitizePathSegment(audioId)}.${extensionFromMimeType(
    audioRecord.blob.type || audioRecord.format,
    'mp3',
  )}`;
  const uploaded = await uploadAssetOnce(`audio:${audioRecord.id}`, () =>
    uploadAsset({
      blob: audioRecord.blob,
      key,
      fileName,
    }),
  );

  await db.audioFiles.update(audioRecord.id, { ossKey: uploaded.url });
  action.audioUrl = uploaded.url;
}

async function ensureMediaAsset(
  stage: Stage,
  element: SlideMediaElement,
  mediaRef: string,
  mediaRecord: MediaFileRecord,
): Promise<void> {
  if (mediaRecord.ossKey) {
    element.src = mediaRecord.ossKey;
  } else if (!mediaRecord.error) {
    const mediaKey = buildAssetKey({
      stage,
      kind: mediaRecord.type,
      assetId: mediaRef,
      mimeType: mediaRecord.mimeType,
    });
    const fileName = `${sanitizePathSegment(mediaRef)}.${extensionFromMimeType(
      mediaRecord.mimeType,
      mediaRecord.type === 'image' ? 'png' : 'mp4',
    )}`;
    const uploaded = await uploadAssetOnce(`media:${mediaRecord.id}`, () =>
      uploadAsset({
        blob: mediaRecord.blob,
        key: mediaKey,
        fileName,
      }),
    );
    console.log("🚀 ~ ensureMediaAsset ~ uploaded:", uploaded)

    await db.mediaFiles.update(mediaRecord.id, { ossKey: uploaded.url });
    element.src = uploaded.url;
  }

  if (mediaRecord.type !== 'video') {
    return;
  }

  if (mediaRecord.posterOssKey) {
    element.poster = mediaRecord.posterOssKey;
    return;
  }

  if (!mediaRecord.poster) {
    return;
  }

  const posterKey = buildAssetKey({
    stage,
    kind: 'image',
    assetId: mediaRef,
    mimeType: mediaRecord.poster.type || 'image/jpeg',
    suffix: 'poster',
  });
  const posterFileName = `${sanitizePathSegment(mediaRef)}-poster.${extensionFromMimeType(
    mediaRecord.poster.type,
    'jpg',
  )}`;
  const uploadedPoster = await uploadAssetOnce(`poster:${mediaRecord.id}`, () =>
    uploadAsset({
      blob: mediaRecord.poster as Blob,
      key: posterKey,
      fileName: posterFileName,
    }),
  );
  console.log("🚀 ~ ensureMediaAsset ~ uploadedPoster:", uploadedPoster)

  await db.mediaFiles.update(mediaRecord.id, { posterOssKey: uploadedPoster.url });
  element.poster = uploadedPoster.url;
}

export async function prepareClassroomAssetsForPersistence(
  stage: Stage | null | undefined,
  scenes: Scene[],
): Promise<Scene[]> {
  if (!stage?.id || scenes.length === 0) {
    return scenes;
  }

  const preparedScenes = structuredClone(scenes);

  for (const scene of preparedScenes) {
    const actions = Array.isArray(scene.actions) ? scene.actions : [];
    for (const currentAction of actions as SpeechAction[]) {
      if (currentAction.type !== 'speech' || !currentAction.audioId) {
        continue;
      }

      const audioRecord = await db.audioFiles.get(currentAction.audioId);
      if (!audioRecord) {
        continue;
      }

      await ensureAudioAsset(stage, currentAction, audioRecord);
    }

    if (scene.content?.type !== 'slide') {
      continue;
    }

    const elements = Array.isArray(scene.content.canvas?.elements)
      ? (scene.content.canvas.elements as SlideMediaElement[])
      : [];

    for (const element of elements) {
      const mediaRef =
        element.type === 'image' && isGeneratedMediaRef(element.src)
          ? element.src
          : element.type === 'video'
            ? getVideoMediaRefForElement(element as PPTVideoElement)
            : undefined;

      if (!mediaRef) {
        continue;
      }

      const mediaRecord = await db.mediaFiles.get(mediaFileKey(stage.id, mediaRef));
      console.log("🚀 ~ prepareClassroomAssetsForPersistence ~ mediaRecord:", mediaRecord)
      if (!mediaRecord) {
        continue;
      }

      await ensureMediaAsset(stage, element, mediaRef, mediaRecord);
    }
  }

  return preparedScenes;
}
