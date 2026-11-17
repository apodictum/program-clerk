// The nearest-tag ranking behind the triage worksheet for `new_tag`, kept pure so its test pins it.
//
// Alias or mint is a nearest-string question, but `/tags` orders by `record_count`, so the canonical
// a new candidate most likely duplicates, itself rarely used, sorts last and is the first cut. The
// whole prefix window is fetched and ranked here; the server caps `limit` at 100, and `total` says
// when a window no longer fits instead of silently dropping the neighbour that mattered.
//
// One window per word, not one per candidate: no prefix reaches `build-vs-buy` from
// `adopt-vs-build`, and `/tags` lists canonicals only, so a word-order alias is invisible to a single
// prefix query. A second distance on the token multiset ranks what shares words ahead of what merely
// shares letters.
export const NEIGHBOR_WINDOW = 100;
export const NEIGHBOR_KEEP = 10;
// A 2-character prefix is a bucket, not a neighbourhood.
const PREFIX = 3;

const round = x => Number(x.toFixed(2));

export const editDistance = (a, b) => {
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; ++i) {
    const row = [i];
    for (let j = 1; j <= b.length; ++j)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
};

const tokens = tag => tag.split('-').filter(Boolean);

/** The candidate's own prefix, plus one per token long enough to be a word, deduplicated. */
export const neighborPrefixes = tag => {
  const prefixes = new Set([tag.slice(0, PREFIX)]);
  for (const token of tokens(tag)) if (token.length >= PREFIX) prefixes.add(token.slice(0, PREFIX));
  return [...prefixes];
};

/** Jaccard distance on the token multisets: 0 for a reordering, 1 when no token is shared. */
export const tokenDistance = (a, b) => {
  const left = new Map();
  for (const token of tokens(a)) left.set(token, (left.get(token) ?? 0) + 1);
  let shared = 0,
    size = 0;
  for (const token of tokens(b)) {
    ++size;
    const n = left.get(token) ?? 0;
    if (n > 0) {
      ++shared;
      left.set(token, n - 1);
    }
  }
  for (const n of left.values()) size += n;
  return size ? 1 - shared / size : 0;
};

// Edit distance is normalized by the longer string: a raw count buries the suffix and compound
// families duplicate detection looks for (`config` to `configuration` is 7 edits).
const nearness = entry => Math.min(entry.distance, entry.token_distance);

export const nearestTags = (tag, tags) =>
  tags
    .map(entry => {
      const edits = editDistance(tag, entry.tag);
      return {
        ...entry,
        edits,
        distance: round(edits / Math.max(tag.length, entry.tag.length)),
        token_distance: round(tokenDistance(tag, entry.tag))
      };
    })
    .sort(
      (x, y) =>
        nearness(x) - nearness(y) || y.record_count - x.record_count || (x.tag < y.tag ? -1 : 1)
    )
    .slice(0, NEIGHBOR_KEEP);
