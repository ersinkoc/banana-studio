import type { GeneratedMedia } from '../../types';
import { SUNBURST_MODEL } from '../images/openaiImage';

export const STUCK_PENDING_MS = 90_000;

/** A pending card that never received a provider handle. Videos need a task ID;
 * legacy fal-queue images need a request ID. Images in the durable server
 * queue (imageQueue/imageStage) and Sunburst are tracked by their job instead.
 * A live video card (videoStage, set only in this tab) is still submitting:
 * uploads and Video Edit preprocessing can take minutes. */
export const isStuckPendingMedia = (item: GeneratedMedia, now: number): boolean => {
  if (item.status !== 'pending' || now - item.createdAt <= STUCK_PENDING_MS) return false;
  if (item.mediaType === 'video') return !item.taskId && !item.videoStage;
  if (item.mediaType !== 'image') return false;
  const durableImage = !!item.imageQueue || !!item.imageStage;
  return !durableImage && item.imageModel !== SUNBURST_MODEL && !item.falRequestId;
};
