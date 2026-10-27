import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLoadedGalleryHistory } from '../src/lib/gallery/galleryHistoryMerge.ts';

const startedAt = 1000;
const row = (id, createdAt, extra = {}) => ({ id, createdAt, isFavorite: false, folderId: null, ...extra });

// Mirrors App: each page callback merges the cumulative snapshot with the IDs delivered before it.
const load = (pages, edits = []) => {
  let state = [], delivered = new Set();
  pages.forEach((page, index) => {
    const before = delivered;
    delivered = new Set([...before, ...page.map(item => item.id)]);
    state = mergeLoadedGalleryHistory(state, page, startedAt, before);
    state = edits[index]?.(state) ?? state;
  });
  return state;
};

test('later history pages keep edits and deletions made to rows already shown', () => {
  const first = [row('A', 900), row('B', 800)];
  const state = load([first, [...first, row('C', 700)]], [
    current => [row('NEW', 1500), ...current.filter(item => item.id !== 'B').map(item => item.id === 'A' ? { ...item, isFavorite: true, folderId: 'f1' } : item)],
  ]);
  assert.deepEqual(state.map(item => item.id), ['NEW', 'A', 'C']);
  assert.equal(state[1].isFavorite, true);
  assert.equal(state[1].folderId, 'f1');
});

test('a single snapshot still shows every row, and a job submitted during loading keeps its newer state', () => {
  assert.deepEqual(load([[row('A', 900), row('B', 800)]]).map(item => item.id), ['A', 'B']);
  const merged = mergeLoadedGalleryHistory([row('J', 1200, { status: 'completed' })], [row('J', 1200, { status: 'processing' })], startedAt, new Set());
  assert.deepEqual(merged.map(item => item.status), ['completed']);
});
