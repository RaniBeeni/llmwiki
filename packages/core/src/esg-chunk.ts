export interface EsgLocator { page: number | null; heading: string | null; }
export interface EsgChunk { chunk_id: string; locator: EsgLocator; text: string; }

function pageMarker(line: string): number | null {
  let m = line.match(/^\s*(\d+)\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  m = line.match(/^\s*\[?PAGE(?:\s+|:)(\d+)\]?\s*$/i);
  return m ? Number(m[1]) : null;
}

function isHeading(line: string): boolean {
  const t = line.trim();
  return /^#{1,6}\s+\S/.test(line) || (/^[가-힣A-Za-z][^.!?]{0,70}$/.test(t) && t.length > 0);
}

export function structureAwareChunks(text: string, maxChars = 12_000): EsgChunk[] {
  const lines = text.replace(/\r/g, '').split('\n');
  let page: number | null = null;
  let heading: string | null = null;
  let buf: string[] = [];
  const chunks: Array<{ locator: EsgLocator; text: string }> = [];

  const flush = (): void => {
    const body = buf.join('\n').trim();
    if (body) chunks.push({ locator: { page, heading }, text: body });
    buf = [];
  };

  for (const line of lines) {
    const p = pageMarker(line);
    if (p !== null) { flush(); page = p; continue; }
    if (isHeading(line) && buf.join('\n').length > 1200) { flush(); heading = line.trim(); }
    if (line.length > maxChars) {
      flush();
      for (let start = 0; start < line.length; start += maxChars) {
        buf.push(line.slice(start, start + maxChars));
        flush();
      }
    } else {
      buf.push(line);
      if (buf.join('\n').length >= maxChars) flush();
    }
  }
  flush();
  return chunks.map((c, i) => ({ ...c, chunk_id: `chunk-${String(i + 1).padStart(4, '0')}` }));
}
