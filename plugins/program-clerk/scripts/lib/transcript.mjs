// The MCP tools under either name: a user's own registration, or this plugin's server.
const TOOL = /^mcp__(?:plugin_program-clerk_)?program-clerk__(.+)$/;
const ONE_PATH = new Set([
  'write_file',
  'append',
  'replace',
  'replace_section',
  'insert_item',
  'remove_item',
  'update_piece',
  'delete_file'
]);
const NOTE = /^[a-z0-9][A-Za-z0-9._/-]*\.md$/;

const pathsOf = use => {
  const input = use.input ?? {};
  const tool = TOOL.exec(use.name ?? '')?.[1];
  if (tool && ONE_PATH.has(tool)) return [input.path];
  if (tool === 'supersede') return [input.old_path, input.new_path ?? input.old_path];
  if (tool === 'move_item') return [input.from_path, input.to_path];
  if (tool === 'move') return [input.from, input.to];
  if (use.name !== 'Bash' || typeof input.command !== 'string') return [];
  // A put script's writes, and a curl wrapper's PUT or DELETE of a note.
  return [
    ...input.command.matchAll(/-put\.mjs +([^ ]+\.md) +--(?:fm|append|replace)/g),
    ...input.command.matchAll(/[a-z]+-curl +\/vault\/([^ ?]+\.md) +-X +(?:PUT|DELETE)/g)
  ].map(match => match[1]);
};

/** {started, wrote} from a transcript's lines. */
export const readTranscript = text => {
  let started = '';
  const wrote = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!started && typeof entry?.timestamp === 'string')
      started = entry.timestamp.slice(0, 19) + 'Z';
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== 'tool_use') continue;
      for (const path of pathsOf(part))
        if (typeof path === 'string' && NOTE.test(path)) wrote.add(path);
    }
  }
  return {started, wrote: [...wrote].sort().slice(0, 20)};
};
