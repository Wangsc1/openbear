import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { TaskMemoryScreen } from '../../taskmemory/TaskMemoryScreen';

export default function TaskMemoryRoute() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  return <TaskMemoryScreen uuid={String(uuid)} />;
}
