import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ConversationView } from '../../chat/ConversationView';

export default function ConversationScreen() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  return <ConversationView uuid={String(uuid)} />;
}
