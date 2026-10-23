/**
 * 产物预览接入点（B4-44）：打开对话包的产物预览页（src/app/artifact.tsx）。
 */
import { router } from 'expo-router';

export type OpenArtifactPreview = (args: { conversationUuid: string; artifactUuid: string; label?: string }) => void;

export const openArtifactPreview: OpenArtifactPreview | null = ({ conversationUuid, artifactUuid, label }) =>
  router.push({ pathname: '/artifact', params: { uuid: conversationUuid, aid: artifactUuid, label: label || '' } });
