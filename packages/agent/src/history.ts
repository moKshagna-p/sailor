import type { ChatHistoryItem } from '@sailor/core';
import { modelMessageSchema } from 'ai';

export function toChatHistory(values: unknown[]): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];

  for (const value of values) {
    const message = modelMessageSchema.parse(value);
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
    if (text) history.push({ kind: message.role === 'user' ? 'user' : 'agent', text });
  }

  return history;
}
