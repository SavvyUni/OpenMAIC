'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { persistClassroomToServer } from '@/lib/utils/classroom-persistence';
import { toast } from 'sonner';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const classroomId = params?.id as string;
  const erpLessonId = Number(searchParams.get('lesson_id'));
  const normalizedErpLessonId = Number.isInteger(erpLessonId) ? erpLessonId : undefined;
  const erpTrainingCourseId = Number(searchParams.get('training_course_id'));
  const normalizedErpTrainingCourseId = Number.isInteger(erpTrainingCourseId)
    ? erpTrainingCourseId
    : undefined;

  const loadFromStorage = useStageStore.use.loadFromStorage();
  const stage = useStageStore.use.stage();
  const scenes = useStageStore.use.scenes();
  const generatingOutlines = useStageStore.use.generatingOutlines();
  const generationStatus = useStageStore.use.generationStatus();
  const mediaTasks = useMediaGenerationStore((state) => state.tasks);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);
  const lastPersistedSnapshotRef = useRef<string | null>(null);
  const lastPersistErrorRef = useRef<string | null>(null);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(async () => {
    try {
      await loadFromStorage(classroomId);

      // If IndexedDB had no data, try server-side storage (API-generated classrooms)
      if (!useStageStore.getState().stage) {
        log.info('No IndexedDB data, trying server-side storage for:', classroomId);
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.classroom) {
              const { stage, scenes } = json.classroom;
              useStageStore.getState().setStage(stage);
              useStageStore.setState({
                scenes,
                currentSceneId: scenes[0]?.id ?? null,
              });
              log.info('Loaded from server-side storage:', classroomId);

              // Hydrate server-generated agents into IndexedDB + registry.
              // Don't set selectedAgentIds here — the general agent
              // restoration logic below (Path 2) handles it uniformly.
              if (stage.generatedAgentConfigs?.length) {
                const { saveGeneratedAgents } = await import('@/lib/orchestration/registry/store');
                await saveGeneratedAgents(stage.id, stage.generatedAgentConfigs);
                log.info('Hydrated server-generated agents for stage:', stage.id);
              }
            }
          }
        } catch (fetchErr) {
          log.warn('Server-side storage fetch failed:', fetchErr);
        }
      }

      // Restore completed media generation tasks from IndexedDB
      await useMediaGenerationStore.getState().restoreFromDB(classroomId);
      // Restore agents for this stage
      const { loadGeneratedAgentsForStage, useAgentRegistry } =
        await import('@/lib/orchestration/registry/store');
      const generatedAgentIds = await loadGeneratedAgentsForStage(classroomId);
      const { useSettingsStore } = await import('@/lib/store/settings');
      if (generatedAgentIds.length > 0) {
        // Auto mode — use generated agents from IndexedDB
        useSettingsStore.getState().setAgentMode('auto');
        useSettingsStore.getState().setSelectedAgentIds(generatedAgentIds);
      } else {
        // Preset mode — restore agent IDs saved in the stage at creation time.
        // Filter out any stale generated IDs that may have been persisted before
        // the bleed-fix, so they don't resolve against a leftover registry entry.
        const stage = useStageStore.getState().stage;
        const stageAgentIds = stage?.agentIds;
        const registry = useAgentRegistry.getState();
        const cleanIds = stageAgentIds?.filter((id) => {
          const a = registry.getAgent(id);
          return a && !a.isGenerated;
        });
        useSettingsStore.getState().setAgentMode('preset');
        useSettingsStore
          .getState()
          .setSelectedAgentIds(
            cleanIds && cleanIds.length > 0 ? cleanIds : ['default-1', 'default-2', 'default-3'],
          );
      }
    } catch (error) {
      log.error('Failed to load classroom:', error);
      setError(error instanceof Error ? error.message : 'Failed to load classroom');
    } finally {
      setLoading(false);
    }
  }, [classroomId, loadFromStorage]);

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    setLoading(true);
    setError(null);
    generationStartedRef.current = false;
    lastPersistedSnapshotRef.current = null;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    loadClassroom();

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;

    const state = useStageStore.getState();
    const { outlines, scenes, stage } = state;

    // Check if there are pending outlines
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const params = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Reconstruct imageMapping from IndexedDB using pdfImages storageIds
      const storageIds = (params.pdfImages || [])
        .map((img: { storageId?: string }) => img.storageId)
        .filter(Boolean);

      loadImageMapping(storageIds).then((imageMapping) => {
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
          languageDirective: params.languageDirective || stage.languageDirective,
        });
      });
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      generateMediaForOutlines(outlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [loading, error, generateRemaining]);

  useEffect(() => {
    if (loading || error || !stage || scenes.length === 0) return;

    const hasPendingSceneGeneration =
      generatingOutlines.length > 0 || generationStatus === 'generating';
    const hasPendingMediaGeneration = Object.values(mediaTasks).some(
      (task) =>
        task.stageId === classroomId && (task.status === 'pending' || task.status === 'generating'),
    );

    if (hasPendingSceneGeneration || hasPendingMediaGeneration) {
      return;
    }

    const snapshot = JSON.stringify({
      stageId: stage.id,
      stageUpdatedAt: stage.updatedAt,
      sceneIds: scenes.map((scene) => scene.id),
      sceneUpdatedAt: scenes.map((scene) => scene.updatedAt ?? null),
    });

    if (snapshot === lastPersistedSnapshotRef.current) return;
    lastPersistedSnapshotRef.current = snapshot;

    void persistClassroomToServer(stage, scenes).then((result) => {
      if (result.success) {
        lastPersistErrorRef.current = null;
        return;
      }

      const nextError = result.error || 'Failed to persist classroom';
      log.warn(`[Classroom] Failed to persist classroom [stageId=${stage.id}]`, nextError);

      if (lastPersistErrorRef.current === nextError) {
        return;
      }

      lastPersistErrorRef.current = nextError;
      toast.error(nextError);
    });
  }, [
    classroomId,
    error,
    generationStatus,
    generatingOutlines.length,
    loading,
    mediaTasks,
    scenes,
    stage,
  ]);

  useEffect(() => {
    if (!stage || normalizedErpLessonId === undefined) return;
    if (stage.erpLessonId === normalizedErpLessonId) return;

    useStageStore.setState((state) => ({
      stage: state.stage
        ? {
            ...state.stage,
            erpLessonId: normalizedErpLessonId,
            updatedAt: Date.now(),
          }
        : state.stage,
    }));
    void useStageStore.getState().saveToStorage();
  }, [stage, normalizedErpLessonId]);

  useEffect(() => {
    if (!stage || normalizedErpTrainingCourseId === undefined) return;
    if (stage.erpTrainingCourseId === normalizedErpTrainingCourseId) return;

    useStageStore.setState((state) => ({
      stage: state.stage
        ? {
            ...state.stage,
            erpTrainingCourseId: normalizedErpTrainingCourseId,
            updatedAt: Date.now(),
          }
        : state.stage,
    }));
    void useStageStore.getState().saveToStorage();
  }, [stage, normalizedErpTrainingCourseId]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="h-screen flex flex-col overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center text-muted-foreground">
                <p>Loading classroom...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center">
                <p className="text-destructive mb-4">Error: {error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <Stage onRetryOutline={retrySingleOutline} />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
