import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const DB_PATH = path.join(os.homedir(), '.opencode', 'realmemory', 'data.db');

const db = new Database(DB_PATH);

const columns = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
const colNames = new Set(columns.map(c => c.name));

if (!colNames.has('domain')) {
  db.exec('ALTER TABLE memories ADD COLUMN domain TEXT');
}
if (!colNames.has('source')) {
  db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT '{}'");
}
if (!colNames.has('category')) {
  db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain)');
db.exec('CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)');

const DOMAIN_MAP: [string, string][] = [
  ['aws', 'aws'],
  ['terraform', 'terraform'],
  ['opencode', 'opencode'],
  ['vercel', 'vercel'],
  ['testing', 'testing'],
  ['guacamole', 'guacamole'],
  ['supabase', 'supabase'],
  ['docker', 'docker'],
  ['ansible', 'ansible'],
  ['anymake', 'anymake'],
  ['lambda', 'aws'],
  ['python', 'python'],
  ['realhax', 'realhax'],
  ['realvol', 'realvol'],
  ['real-agent', 'opencode'],
  ['mission-control', 'opencode'],
];

function parseTags(raw: any): string[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function extractDomain(tags: string[]): string | null {
  const lower = tags.map(t => t.toLowerCase());
  for (const [tag, domain] of DOMAIN_MAP) {
    if (lower.includes(tag)) return domain;
  }
  return null;
}

function extractCategory(content: string): string {
  const has = (...needles: string[]) => needles.some(n => content.includes(n));
  if (content.includes('silent') && (content.includes('fail') || content.includes('no-op') || content.includes('rejects'))) return 'gotcha';
  if (has('billing', 'cost', '$', 'orphan', 'leak')) return 'cost';
  if (has('NEVER', 'destructive', 'terminate', 'data loss') || (content.includes('stop') && content.includes('instance'))) return 'safety';
  if (has('key mismatch', 'format mismatch', 'cross-system', 'Lambda returns', 'DB stores')) return 'integration';
  if (has('tracking', 'PHASE_STATE', 'GitHub issue', 'PARKING_LOT', 'resume', 'closed-issue')) return 'process';
  if (has('timeout', '120s', 'background') || (content.includes('context') && content.includes('exhaust'))) return 'tooling';
  if (has('plugin', 'version', 'broken', 'compat')) return 'tooling';
  if (has('permission', 'chmod', 'bind-mount', 'UID')) return 'gotcha';
  if (has('URL', '403', 'vendor', 'drift')) return 'tooling';
  return 'process';
}

interface Source { project?: string; ref?: string; refType?: string; }
interface ReinforcedEntry { date: string | null; context: string; }

function extractSource(content: string): { source: Source; learnedDate?: string; learnedProject?: string } {
  const source: Source = {};
  let learnedDate: string | undefined;
  let learnedProject: string | undefined;

  const learnedMatch = content.match(/Learned:\s*(\d{4}-\d{2}-\d{2})\s*\(([^)]+)\)/);
  if (learnedMatch) {
    learnedDate = learnedMatch[1];
    const inside = learnedMatch[2].trim();
    learnedProject = inside.split(/\s+/)[0];
    source.project = learnedProject;
  }

  const issueMatch = content.match(/#(\d+)/);
  if (issueMatch) {
    source.ref = '#' + issueMatch[1];
    source.refType = 'issue';
  }

  return { source, learnedDate, learnedProject };
}

function parseSections(content: string) {
  const result: {
    assumed?: string;
    reality?: string;
    lesson?: string;
    reinforced: ReinforcedEntry[];
    generalized?: string;
  } = { reinforced: [] };

  const headerRegex = /(?:^|\n)[ \t]*(Assumed|Reality|Lesson|Reinforced|Re-hit|Generalized):[ \t]*/g;
  const matches: { header: string; headerStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(content)) !== null) {
    matches.push({ header: m[1], headerStart: m.index, contentStart: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const section = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].headerStart : content.length;
    const text = content.slice(section.contentStart, nextStart).trim();
    if (!text) continue;
    switch (section.header) {
      case 'Assumed': result.assumed = text; break;
      case 'Reality': result.reality = text; break;
      case 'Lesson': result.lesson = text; break;
      case 'Reinforced':
      case 'Re-hit': {
        const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : null;
        const context = dateMatch ? text.slice(dateMatch.index! + dateMatch[0].length).trim() : text;
        result.reinforced.push({ date, context });
        break;
      }
      case 'Generalized':
        result.generalized = (result.generalized ? result.generalized + '\n' : '') + text;
        break;
    }
  }
  return result;
}

const memories = db.prepare('SELECT id, type, content, tags, metadata, source, domain, category FROM memories').all() as any[];

const updates: { id: any; domain: string | null; category: string | null; source: string; metadata: string }[] = [];
const examples: { id: any; type: string; before: any; after: any }[] = [];

for (const mem of memories) {
  const content = mem.content || '';
  const tags = parseTags(mem.tags);
  const domain = extractDomain(tags);
  const isLesson = mem.type === 'lesson_learned';
  const category = isLesson ? extractCategory(content) : null;

  const { source, learnedDate, learnedProject } = extractSource(content);

  let metadata: any = {};
  try {
    metadata = typeof mem.metadata === 'string' && mem.metadata ? JSON.parse(mem.metadata) : {};
  } catch {
    metadata = {};
  }
  if (!metadata || typeof metadata !== 'object') metadata = {};

  if (learnedDate) metadata.learnedDate = learnedDate;
  if (learnedProject) metadata.learnedProject = learnedProject;

  if (isLesson) {
    const sections = parseSections(content);
    if (sections.assumed) metadata.assumed = sections.assumed;
    if (sections.reality) metadata.reality = sections.reality;
    if (sections.lesson) {
      metadata.lesson = sections.generalized ? sections.lesson + '\n' + sections.generalized : sections.lesson;
    } else if (sections.generalized) {
      metadata.lesson = sections.generalized;
    }
    if (sections.reinforced.length) metadata.reinforced = sections.reinforced;
  }

  updates.push({
    id: mem.id,
    domain,
    category,
    source: JSON.stringify(source),
    metadata: JSON.stringify(metadata),
  });

  if (examples.length < 5) {
    examples.push({
      id: mem.id,
      type: mem.type,
      before: { domain: mem.domain, category: mem.category, source: mem.source, metadata: mem.metadata },
      after: { domain, category, source, metadata },
    });
  }
}

const updateMany = db.transaction((rows: typeof updates) => {
  const stmt = db.prepare('UPDATE memories SET domain = ?, category = ?, source = ?, metadata = ? WHERE id = ?');
  for (const r of rows) {
    stmt.run(r.domain, r.category, r.source, r.metadata, r.id);
  }
});
updateMany(updates);

const totalUpdated = updates.length;
const domainNotNull = updates.filter(u => u.domain !== null).length;
const byDomain = db.prepare('SELECT domain, COUNT(*) AS n FROM memories GROUP BY domain').all() as any[];
const byCategory = db.prepare('SELECT category, COUNT(*) AS n FROM memories GROUP BY category').all() as any[];

console.log('=== Migration v3 complete ===');
console.log(`Total memories updated: ${totalUpdated}`);
console.log(`Memories with a domain assigned: ${domainNotNull}`);
console.log('\nCount by domain:');
for (const r of byDomain) console.log(`  ${r.domain ?? '(null)'}: ${r.n}`);
console.log('\nCount by category:');
for (const r of byCategory) console.log(`  ${r.category ?? '(null)'}: ${r.n}`);
console.log('\nExample rows (before -> after):');
for (const ex of examples) {
  console.log(`\n  [id=${ex.id} type=${ex.type}]`);
  console.log(`    BEFORE: domain=${ex.before.domain} category=${ex.before.category} source=${ex.before.source}`);
  console.log(`    AFTER:  domain=${ex.after.domain} category=${ex.after.category} source=${JSON.stringify(ex.after.source)}`);
  console.log(`    metadata: ${JSON.stringify(ex.after.metadata)}`);
}

db.close();
