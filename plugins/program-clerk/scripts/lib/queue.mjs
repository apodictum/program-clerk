// A project's queue, one note an item: an open item is projects/<p>/queue/<slug>.md with `section`,
// `sequence_key`, and `filed`, the day it entered the queue, and `priority`, `source`, and
// `blocked_by` when set; `queue/_about.md` declares where else the project's work is tracked.
// The server stores and queries the notes; what the fields mean is here.

export const SECTIONS = ['inbox', 'active', 'backlog', 'watching'];
// A source names a ticket a brief checks, and filing replaces the open item that holds it.
export const SOURCE_RE =
  /^(?:github [\w.-]+\/[\w.-]+(?:#[1-9]\d*| discussion#[1-9]\d*| GHSA-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4})|(?:linear|jira) [A-Z][A-Z0-9]{1,9}-[1-9]\d*)$/;
const SPECIAL = new Set(['_about.md', '_lead.md']);
const PAGE = 500;
const SLUG_MAX = 80;

/** An answer's JSON; a missing answer or an error status throws, naming `what`. */
export const expectJson = (answer, what) => {
  if (answer === null) throw new Error(`${what}: no answer`);
  if (answer.status >= 400)
    throw new Error(`${what}: ${answer.status} ${answer.text.slice(0, 300)}`);
  return answer.text ? JSON.parse(answer.text) : {};
};

/** A title as a file name's stem, as the server names a section's piece. */
export const slugOf = title => {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length <= SLUG_MAX) return slug || 'item';
  const cut = slug.slice(0, SLUG_MAX);
  const dash = cut.lastIndexOf('-');
  return dash > 0 ? cut.slice(0, dash) : cut;
};

/** The first of `slug`, `slug-2`, … not in `taken`, added to it. */
export const uniqueName = (slug, taken) => {
  let name = `${slug}.md`;
  for (let n = 2; taken.has(name); ++n) name = `${slug}-${n}.md`;
  taken.add(name);
  return name;
};

/** An open item's frontmatter: the fields a reader wants, the optional ones only when set. */
export const openFields = ({
  title,
  section,
  sequence,
  filed = null,
  priority = 0,
  source = null,
  blockedBy = []
}) => ({
  title,
  type: 'queue-item',
  status: 'active',
  section,
  sequence_key: sequence,
  ...(filed ? {filed} : {}),
  ...(priority ? {priority} : {}),
  ...(source ? {source} : {}),
  ...(blockedBy.length > 0 ? {blocked_by: blockedBy} : {})
});

const folderOf = project => `projects/${project}/queue`;
const closedFolderOf = project => `projects/${project}/queue-archive`;

const queryAll = async (api, folder) => {
  const items = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = expectJson(
      await api('/notes/query', {
        method: 'POST',
        body: {folder, sort: 'sequence_key', limit: PAGE, offset}
      }),
      `query ${folder}`
    );
    items.push(...page.items);
    if (page.items.length < PAGE) return items;
  }
};

const isItem = n => !SPECIAL.has(n.path.slice(n.path.lastIndexOf('/') + 1));

// Where a project's work is tracked, from `trackers:` in `queue/_about.md`. With no declaration the
// queue is the primary tracker; its kind on the wire keeps the product's earlier name.
export const TRACKER_KINDS = ['vault', 'github', 'linear', 'jira'];
const QUEUE_KIND = TRACKER_KINDS[0];
const KINDS = new Set(TRACKER_KINDS);
const ROLES = new Set(['primary', 'secondary']);
const CREATE = new Set(['here', 'none']);
// How a secondary tracker's items reach the queue: reflected as items, taken through the Inbox for
// triage, or not at all. A primary outside tracker takes none.
const INTAKE = new Set(['none', 'reflect', 'triage']);

const QUEUE_PRIMARY = {
  kind: QUEUE_KIND,
  ref: null,
  role: 'primary',
  create: 'here',
  intake: 'none',
  write: [],
  url: null
};

const urlFor = (kind, ref, given) => {
  if (typeof given === 'string' && /^https?:\/\//.test(given)) return given;
  if (kind === 'github' && ref && /^[\w.-]+\/[\w.-]+$/.test(ref)) {
    return `https://github.com/${ref}/issues`;
  }
  return null;
};

const stringIn = (set, value) => (typeof value === 'string' && set.has(value) ? value : null);

/** One declared entry, or null with the reason in `problems`. */
const entryOf = (entry, i, problems) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    problems.push(`trackers[${i}] must be a map`);
    return null;
  }
  const kind = typeof entry.kind === 'string' ? entry.kind : '';
  if (!KINDS.has(kind)) {
    problems.push(
      `trackers[${i}].kind must be one of ${TRACKER_KINDS.join(', ')} (got ${JSON.stringify(entry.kind ?? null)})`
    );
    return null;
  }
  const ref = typeof entry.ref === 'string' && entry.ref.trim() ? entry.ref.trim() : null;
  if (kind !== QUEUE_KIND && ref === null) {
    problems.push(`trackers[${i}] (${kind}) needs a ref`);
    return null;
  }
  if (entry.role === 'mirror') problems.push(`trackers[${i}].role mirror is called secondary now`);
  const role = entry.role === 'mirror' ? 'secondary' : stringIn(ROLES, entry.role);
  if (entry.role !== undefined && role === null) {
    problems.push(`trackers[${i}].role must be primary or secondary`);
    return null;
  }
  const create = stringIn(CREATE, entry.create);
  if (entry.create !== undefined && create === null) {
    problems.push(`trackers[${i}].create must be here or none`);
    return null;
  }
  const intake = stringIn(INTAKE, entry.intake);
  if (entry.intake !== undefined && intake === null) {
    problems.push(`trackers[${i}].intake must be none, reflect, or triage`);
    return null;
  }
  if (intake !== null && intake !== 'none' && kind === QUEUE_KIND) {
    problems.push(`trackers[${i}] (${kind}) takes no intake; it is the queue`);
  }
  return {
    kind,
    ref,
    role: role ?? 'secondary',
    create: create ?? (role === 'primary' ? 'here' : 'none'),
    intake: kind === QUEUE_KIND ? 'none' : (intake ?? 'none'),
    write: Array.isArray(entry.write)
      ? entry.write.filter(w => typeof w === 'string' && w.length > 0)
      : [],
    url: urlFor(kind, ref, entry.url)
  };
};

/** The declaration as written, validated; `raw` is the frontmatter's `trackers` value. */
export const readTrackers = (project, raw) => {
  if (raw === undefined || raw === null) {
    return {
      project,
      declared: false,
      trackers: [QUEUE_PRIMARY],
      primary: QUEUE_PRIMARY,
      problems: []
    };
  }
  const problems = [];
  const trackers = [];
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => {
      const tracker = entryOf(entry, i, problems);
      if (tracker !== null) trackers.push(tracker);
    });
  } else {
    problems.push('trackers must be a list');
  }
  const primaries = trackers.filter(t => t.role === 'primary');
  if (primaries.length > 1) {
    problems.push(`${primaries.length} trackers are primary; the first one counts`);
    for (const t of primaries.slice(1)) t.role = 'secondary';
  }
  const first = primaries[0];
  if (first !== undefined && first.kind !== QUEUE_KIND && first.intake !== 'none') {
    problems.push(
      `the primary (${first.kind} ${first.ref}) takes no intake: the queue records the item in flight, not a mirror`
    );
    first.intake = 'none';
  }
  if (primaries.length === 0) {
    problems.push('no tracker is primary; the queue is');
    const queue = trackers.find(t => t.kind === QUEUE_KIND);
    if (queue === undefined) trackers.unshift({...QUEUE_PRIMARY});
    else queue.role = 'primary';
  }
  const primary = trackers.find(t => t.role === 'primary') ?? QUEUE_PRIMARY;
  return {project, declared: true, trackers, primary, problems};
};

/** The GitHub repositories a declaration names, as `owner/name`. */
export const githubRefs = view =>
  view.trackers
    .filter(t => t.kind === 'github' && /^[^/\s]+\/[^/\s]+$/.test(t.ref ?? ''))
    .map(t => t.ref);

/** The open item notes and the tracker declaration, in one query. */
export const queueOf = async (api, project) => {
  const notes = await queryAll(api, folderOf(project));
  const about = notes.find(n => n.path === `${folderOf(project)}/_about.md`);
  return {
    notes: notes.filter(isItem),
    trackers: readTrackers(project, about?.frontmatter.trackers)
  };
};

const shaped = n => ({
  title: n.frontmatter.title ?? n.title,
  section: n.frontmatter.section ?? null,
  priority: n.frontmatter.priority ?? 0,
  source: n.frontmatter.source ?? null,
  blocked_by: n.frontmatter.blocked_by ?? [],
  filed: n.frontmatter.filed ?? n.frontmatter.created ?? null,
  path: n.path
});

// By section, then the higher priority first; the sort keeps the order within.
const inOrder = items =>
  items.sort(
    (a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || b.priority - a.priority
  );

/** Open item notes as a listing shows them, in order. */
export const itemsFrom = notes => inOrder(notes.map(shaped));

/**
 * What the queue owes a reader: items mirroring a ticket, the Inbox, and the Backlog filed since
 * `since`, each with its kind.
 */
export const owedFrom = (notes, since) => {
  const day = since?.slice(0, 10);
  // The server files its own item for its loop stalls, so nobody places it.
  const filedSince = n =>
    day !== undefined &&
    String(shaped(n).filed) >= day &&
    !String(n.frontmatter.title).startsWith('Loop stalls recorded through ');
  const owed = (kind, picked) => picked.map(n => ({kind, ...shaped(n)}));
  return [
    ...owed(
      'upstream',
      notes.filter(n => n.frontmatter.source)
    ),
    ...owed(
      'triage',
      notes.filter(n => n.frontmatter.section === 'inbox')
    ),
    ...owed(
      'place',
      notes.filter(n => n.frontmatter.section === 'backlog' && filedSince(n))
    )
  ];
};

const writeFolderNotes = async (api, project) => {
  for (const [dir, about, body] of [
    [
      folderOf(project),
      {title: `${project} — Queue`, tags: [project, 'queue']},
      'One note per queue item, read by the frontmatter query; closed items are in `queue-archive/`.\n'
    ],
    [
      closedFolderOf(project),
      {title: `${project} — Queue Archive`, tags: [project, 'queue', 'archive']},
      'One note per closed queue item, read by the frontmatter query; open items are in `queue/`.\n'
    ]
  ]) {
    expectJson(
      await api(`/vault/${dir}/_about.md`, {
        method: 'PUT',
        body: {frontmatter: {...about, type: 'meta', status: 'active'}, body}
      }),
      `the folder note of ${dir}`
    );
  }
};

// A project with no queue starts in this shape.
const readyToFile = async (api, project) => {
  const {items} = expectJson(
    await api('/resolve', {method: 'POST', body: {wikilinks: [`projects/${project}/queue.md`]}}),
    `resolve the queue of ${project}`
  );
  const path = items[0].file_path;
  if (path === `${folderOf(project)}/_about.md`) return;
  if (path !== null) throw new Error(`${path} is one note, which a queue of item notes is not`);
  await writeFolderNotes(api, project);
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Files an item on a project's queue. An open item with the same source or the same title is
 * replaced where it stands, so a repeated call files nothing twice. Answers its path and what it did.
 */
export const fileItem = async (
  api,
  project,
  {title, section = 'backlog', priority = 0, source = null, blockedBy = [], body}
) => {
  if (!SECTIONS.includes(section)) {
    throw new RangeError(`a section is one of ${SECTIONS.join(', ')}`);
  }
  if (!title || !body?.trim()) throw new TypeError('an item needs a title and a body');
  if (source && !SOURCE_RE.test(source)) throw new RangeError(`not a ticket's source: ${source}`);
  await readyToFile(api, project);
  const notes = (await queryAll(api, folderOf(project))).filter(isItem);
  const same = notes.find(
    n => (source && n.frontmatter.source === source) || (n.frontmatter.title ?? n.title) === title
  );
  const folder = folderOf(project);
  const sequence = same
    ? same.frontmatter.sequence_key
    : Math.max(0, ...notes.map(n => n.frontmatter.sequence_key ?? 0)) + 1;
  const path =
    same?.path ??
    `${folder}/${uniqueName(slugOf(title), new Set(notes.map(n => n.path.slice(folder.length + 1))))}`;
  expectJson(
    await api(`/vault/${path}`, {
      method: 'PUT',
      body: {
        frontmatter: openFields({
          title,
          section,
          sequence,
          filed: same?.frontmatter.filed ?? today(),
          priority,
          source,
          blockedBy
        }),
        body: `${body.trim()}\n`
      }
    }),
    `write ${path}`
  );
  return {path, replaced: same !== undefined};
};
