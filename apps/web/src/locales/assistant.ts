// UI strings of the assistant feature (English is the source; every key must exist in Arabic too).
export const en = {
  'assistant.placeholder': 'assistant',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'assistant.placeholder': 'assistant',
};
