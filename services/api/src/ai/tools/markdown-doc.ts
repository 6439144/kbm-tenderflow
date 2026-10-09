// Converts a Markdown file into the DocText shape used by the AI service: "# " = title, "## " = sections.
import type { DocText } from '../types.js';

export function markdownToDocText(documentId: string, markdown: string): DocText {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title = documentId;
  const sections: DocText['sections'] = [];
  let current: { section: string; buf: string[] } | undefined;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && !h2) { title = h1[1].trim(); continue; }
    if (h2) {
      if (current) sections.push({ section: current.section, text: current.buf.join('\n').trim() });
      current = { section: h2[1].trim(), buf: [] };
      continue;
    }
    if (current) current.buf.push(line);
  }
  if (current) sections.push({ section: current.section, text: current.buf.join('\n').trim() });
  return { documentId, title, sections: sections.filter((s) => s.text) };
}
