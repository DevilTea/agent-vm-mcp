import { ARTIFACT_VIEWER_URI } from './constants.js';

export function withArtifactViewerMeta(meta = {}) {
  return {
    ...meta,
    ui: {
      ...(meta.ui ?? {}),
      resourceUri: ARTIFACT_VIEWER_URI,
    },
    'ui/resourceUri': ARTIFACT_VIEWER_URI,
    'openai/outputTemplate': ARTIFACT_VIEWER_URI,
  };
}
