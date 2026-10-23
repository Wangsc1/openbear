import { ref } from 'vue';
import { injectedMode, pageSession } from './sessionBoundary.js';

// Known before the app starts: the page carries it (see index.html).
export const authMode = ref(pageSession.initialized ? pageSession.mode : injectedMode());
export const authModeError = ref('');
export function loadAuthMode() { return Promise.resolve(authMode.value); }
export function canManageInstances(mode) { return mode === 'controller'; }
