export const ESG_PAGE_TYPES = new Set([
  'domain', 'canonical-item', 'standard', 'source', 'requirement-ref',
  'concept', 'crosswalk', 'contradiction', 'open-question', 'methodology', 'query',
  // Compatibility during the pilot. New ESG pages should prefer the typed set above.
  'entity', 'summary',
]);

export const ESG_REVIEW_STATES = new Set(['ai-compiled', 'human-reviewed', 'superseded']);
export const ESG_ACCESS_CLASSES = new Set(['PUBLIC', 'APPROVED-PROJECT']);
export const ESG_UPDATE_KINDS = new Set(['new', 'reinforce', 'extend', 'conflict', 'supersede']);

export const ESG_DIRS = [
  'raw',
  'raw/public',
  'raw/approved-project',
  'wiki',
  'wiki/domains',
  'wiki/canonical-items',
  'wiki/standards',
  'wiki/concepts',
  'wiki/crosswalks',
  'wiki/sources',
  'wiki/methodologies',
  'wiki/control',
  'wiki/queries',
  'wiki/.history',
] as const;

export const ESG_INDEX_CONTENT = `# Wiki Index\n\n## Domains\n\n## Canonical Items\n\n## Standards\n\n## Concepts\n\n## Crosswalks\n\n## Sources\n\n## Methodologies\n\n## Control\n`;

export const ESG_AGENTS_CONTENT = `# AGENTS.md\n\n## Role\n\nThis wiki is a **Shadow Knowledge Layer** for ESG disclosure work. It is not an official source of truth.\n\n## Authority\n\n1. Official primary source / evidence\n2. Structured External Requirement Backbone\n3. Approved Notion Project SSoT\n4. Approved Company Information Master\n5. This Shadow Wiki\n\n## Mandatory controls\n\n- Every page must have status: shadow.\n- Allowed review_state: ai-compiled, human-reviewed, superseded.\n- Never use approved or final as Wiki review states.\n- Do not invent Requirement IDs.\n- Do not infer non-public company facts.\n- PUBLIC and APPROVED-PROJECT are the only source access classes allowed in P0.\n- Never silently overwrite material synthesis. Preserve history and record conflicts.\n- No automatic write-back to Notion, databases, Google Drive, or submission systems.\n- Direct/Partial/Additional/No-direct-equivalent mappings require evidence; otherwise keep TBD/proposed.\n`;

export interface EsgFrontmatter {
  type?: string;
  title?: string;
  status?: string;
  review_state?: string;
  source_refs?: string[];
  requirement_ids?: string[];
  authority_scope?: string;
  source_locator?: string;
  [key: string]: unknown;
}

export function normalizeEsgFrontmatter(input: EsgFrontmatter): EsgFrontmatter {
  const fm: EsgFrontmatter = { ...input };
  if (fm.type && !ESG_PAGE_TYPES.has(fm.type)) throw new Error(`Unsupported ESG page type: ${fm.type}`);
  const requested = String(input.review_state ?? 'ai-compiled').toLowerCase();
  if (requested === 'approved' || requested === 'final') {
    throw new Error(`Official-sounding review_state is forbidden in Shadow Wiki: ${requested}`);
  }
  fm.status = 'shadow';
  fm.review_state = ESG_REVIEW_STATES.has(requested) ? requested : 'ai-compiled';
  return fm;
}

export function assertEsgAccessClass(value: string): void {
  if (!ESG_ACCESS_CLASSES.has(value)) {
    throw new Error(`ESG P0 rejects access_classification=${value}. Allowed: PUBLIC, APPROVED-PROJECT`);
  }
}

export function classifyEsgSourcePath(sourcePath: string, wikiRoot: string): 'PUBLIC' | 'APPROVED-PROJECT' {
  const normalized = sourcePath.replace(/\\/g, '/');
  const root = wikiRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.startsWith(`${root}/raw/public/`)) return 'PUBLIC';
  if (normalized.startsWith(`${root}/raw/approved-project/`)) return 'APPROVED-PROJECT';
  throw new Error('ESG P0 only ingests sources staged under raw/public or raw/approved-project.');
}
