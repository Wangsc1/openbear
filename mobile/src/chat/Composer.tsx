/**
 * 输入区的入口（ConversationView 从这里导入）。实现已拆到 src/composer/（B3）：
 * Composer.tsx（主体）、parts.tsx（待发送条、用量、插话列表）、sendLogic.ts（发送链路纯逻辑）、
 * hardwareKeyboard.ts（外接键盘检测）、handoff.ts（新会话首次发送交接）。
 */
export { Composer, COMPOSER_OVERLAP, type NewConversationContext } from '../composer/Composer';
