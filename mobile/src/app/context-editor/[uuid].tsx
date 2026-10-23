import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ContextEditorScreen } from '../../contexteditor/ContextEditorScreen';

export default function ContextEditorRoute() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  return <ContextEditorScreen uuid={String(uuid)} />;
}
