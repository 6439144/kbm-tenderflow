// UI strings of the demo feature (English is the source; every key must exist in Arabic too).
export const en = {
  'demo.placeholder': 'demo',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'demo.placeholder': 'demo',
};
