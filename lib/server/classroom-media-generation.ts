/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * uploads them to ERP OSS, and returns URL mappings.
 */

import { createLogger } from '@/lib/logger';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { buildErpApiHeaders, buildErpApiUrl } from '@/lib/server/erp-api';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { Stage } from '@/lib/types/stage';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';

const log = createLogger('ClassroomMedia');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB
const ERP_UPLOAD_BUCKET = 'savvyuni-intl-erp';

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
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
}) {
  const { stage, kind, assetId, mimeType } = options;
  const scope = sanitizePathSegment(getTrainingCourseScope(stage));
  const stageId = sanitizePathSegment(stage.id);
  const safeAssetId = sanitizePathSegment(assetId);
  const ext = extensionFromMimeType(
    mimeType,
    kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3',
  );

  return `openmaic/${scope}/${stageId}/${kind}/${safeAssetId}.${ext}`;
}

async function uploadGeneratedAsset(options: {
  stage: Stage;
  kind: 'audio' | 'image' | 'video';
  assetId: string;
  mimeType?: string;
  bytes: Buffer;
}): Promise<string> {
  const key = buildAssetKey({
    stage: options.stage,
    kind: options.kind,
    assetId: options.assetId,
    mimeType: options.mimeType,
  });
  const ext = extensionFromMimeType(
    options.mimeType,
    options.kind === 'image' ? 'png' : options.kind === 'video' ? 'mp4' : 'mp3',
  );
  const formData = new FormData();

  formData.set('bucket', ERP_UPLOAD_BUCKET);
  formData.set('key', key);
  formData.set(
    'file',
    new Blob([options.bytes], { type: options.mimeType || 'application/octet-stream' }),
    `${sanitizePathSegment(options.assetId)}.${ext}`,
  );

  const response = await fetch(buildErpApiUrl('/api/upload/file'), {
    method: 'POST',
    headers: buildErpApiHeaders(),
    body: formData,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || `ERP upload failed with HTTP ${response.status}`,
    );
  }

  if (!data?.url) {
    throw new Error('ERP upload API returned an incomplete asset payload');
  }

  return data.url;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  stage: Stage,
): Promise<Record<string, string>> {
  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return {};

  // Resolve providers
  const imageProviderIds = Object.keys(getServerImageProviders());
  const videoProviderIds = Object.keys(getServerVideoProviders());

  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image' && imageProviderIds.length > 0);
  const videoRequests = requests.filter((r) => r.type === 'video' && videoProviderIds.length > 0);

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        const providerId = imageProviderIds[0] as ImageProviderId;
        const apiKey = resolveImageApiKey(providerId);
        const providerConfig = IMAGE_PROVIDERS[providerId];
        if (providerConfig?.requiresApiKey && !apiKey) {
          log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        const model = providerConfig?.models?.[0]?.id;

        const result = await generateImage(
          { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
          { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
        );

        let buf: Buffer;
        let ext: string;
        if (result.base64) {
          buf = Buffer.from(result.base64, 'base64');
          ext = 'png';
        } else if (result.url) {
          buf = await downloadToBuffer(result.url);
          const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
          ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
        } else {
          log.warn(`Image generation returned no data for ${req.elementId}`);
          continue;
        }

        mediaMap[req.elementId] = await uploadGeneratedAsset({
          stage,
          kind: 'image',
          assetId: req.elementId,
          mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
          bytes: buf,
        });
        log.info(`Generated image and uploaded to ERP OSS: ${req.elementId}.${ext}`);
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId}:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        const providerId = videoProviderIds[0] as VideoProviderId;
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) {
          log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = providerConfig?.models?.[0]?.id;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
          normalized,
        );

        const buf = await downloadToBuffer(result.url);
        mediaMap[req.elementId] = await uploadGeneratedAsset({
          stage,
          kind: 'video',
          assetId: req.elementId,
          mimeType: 'video/mp4',
          bytes: buf,
        });
        log.info(`Generated video and uploaded to ERP OSS: ${req.elementId}.mp4`);
      } catch (err) {
        log.warn(`Video generation failed for ${req.elementId}:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  return mediaMap;
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        el.type === 'video' &&
        typeof el.mediaRef === 'string' &&
        mediaMap[el.mediaRef] &&
        (!el.src || isMediaPlaceholder(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

export async function generateTTSForClassroom(
  scenes: Scene[],
  stage: Stage,
): Promise<void> {
  // Resolve TTS provider (exclude browser-native-tts)
  const ttsProviderIds = Object.keys(getServerTTSProviders()).filter(
    (id) => id !== 'browser-native-tts',
  );
  if (ttsProviderIds.length === 0) {
    log.warn('No server TTS provider configured, skipping TTS generation');
    return;
  }

  const providerId = ttsProviderIds[0] as TTSProviderId;
  const apiKey = resolveTTSApiKey(providerId);
  const ttsProvider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (ttsProvider?.requiresApiKey && !apiKey) {
    log.warn(`No API key for TTS provider "${providerId}", skipping TTS generation`);
    return;
  }
  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl;
  const voice = DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default';
  const format = ttsProvider?.supportedFormats?.[0] || 'mp3';
  if (providerId === VOXCPM_TTS_PROVIDER_ID && voice === VOXCPM_AUTO_VOICE_ID) {
    log.warn('VoxCPM Auto Voice requires agent context; skipping server-side TTS generation');
    return;
  }

  for (const scene of scenes) {
    if (!scene.actions) continue;

    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    scene.actions = splitLongSpeechActions(scene.actions, providerId);

    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as SpeechAction;
      // Include scene order in audioId to prevent collision across scenes
      const audioId = `tts_s${sceneOrder}_${action.id}`;

      try {
        const result = await generateTTS(
          {
            providerId,
            modelId: DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
            apiKey,
            baseUrl: ttsBaseUrl,
            voice,
            speed: speechAction.speed,
          },
          speechAction.text,
        );

        speechAction.audioId = audioId;
        speechAction.audioUrl = await uploadGeneratedAsset({
          stage,
          kind: 'audio',
          assetId: audioId,
          mimeType: `audio/${result.format || format}`,
          bytes: result.audio,
        });
        log.info(`Generated TTS and uploaded to ERP OSS: ${audioId} (${result.audio.length} bytes)`);
      } catch (err) {
        log.warn(`TTS generation failed for action ${action.id}:`, err);
      }
    }
  }
}
