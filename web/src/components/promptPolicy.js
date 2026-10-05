// Keep local text distinct from the inherited preview. Whitespace is preserved on save.
export function normalizePromptPolicy(value = {}) {
  return {
    text: typeof value?.text === 'string' ? value.text : '',
    overrideSystemPrompt: value?.overrideSystemPrompt === true,
    toolsEnabled: value?.toolsEnabled === true,
    toolNames: Array.isArray(value?.toolNames) ? [...value.toolNames] : [],
    userMessageTemplateEnabled: value?.userMessageTemplateEnabled === true,
  };
}

export function promptPolicyFlags(value) {
  const {text, ...flags} = normalizePromptPolicy(value);
  return flags;
}

export function conversationPromptPolicy(properties = {}) {
  return normalizePromptPolicy(properties.promptPolicy?.local || {...properties, text: properties.contextText});
}

export function conversationPolicyPayload(properties) {
  const policy = normalizePromptPolicy({...properties, text: properties.contextText});
  return {contextText: policy.text, ...promptPolicyFlags(policy)};
}

export function promptToolGroups(items, selected = []) {
  const available = new Set(items.map(item => item.name));
  return [
    {label: '内置工具', items: items.filter(item => item.source === 'builtin')},
    {label: 'MCP 工具', items: items.filter(item => item.source === 'mcp')},
    {label: '不可用的已选工具', items: selected.filter(name => !available.has(name)).map(name => ({name, description: '不可用', unavailable: true}))},
  ].filter(group => group.items.length);
}
