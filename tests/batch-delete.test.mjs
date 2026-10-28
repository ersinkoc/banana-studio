import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// deleteImage removes an item's files only after its row is deleted or queued for
// retry. An item that could be neither is restored by the caller, so its files must remain.
const f = { rowError: false, quota: false, events: [], queued: null };
f.client = {
  from(table) {
    assert.equal(table, 'generations');
    const query = { delete: () => query, eq: () => query, then: (resolve, reject) => {
      f.events.push('row');
      return Promise.resolve({ error: f.rowError ? { message: 'Row delete failed' } : null }).then(resolve, reject);
    } };
    return query;
  },
  storage: { from: () => ({ async remove(paths) { f.events.push(`files:${paths.join('+')}`); return { error: null }; } }) },
};
globalThis.__batchDeleteFixture = f;
const bundle = await build({ stdin: { contents: "export { deleteImages, DeleteImagesError } from './src/services/storageService';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'batch-delete', setup(b) {
    b.onResolve({ filter: /\/authService$|^tus-js-client$/ }, args => ({ path: args.path === 'tus-js-client' ? 'upload' : 'auth', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'upload' ? 'export class Upload {}' : `export const supabase=globalThis.__batchDeleteFixture.client;
      export const getCurrentUserId=async()=>'user-1',SUPABASE_URL='https://example.invalid';` }));
  } }],
});
const { deleteImages, DeleteImagesError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const media = id => ({ id, url: `https://example.invalid/${id}.png`, createdAt: 1 });

function setup(t, options) {
  Object.assign(f, { rowError: false, quota: false, events: [], queued: null }, options);
  const previous = globalThis.localStorage, error = console.error;
  globalThis.localStorage = { getItem: () => f.queued, removeItem() { f.queued = null; }, setItem(_key, value) {
    if (f.quota) throw new Error('QuotaExceededError');
    f.queued = value;
  } };
  console.error = () => {};
  t.after(() => { globalThis.localStorage = previous; console.error = error; });
}

test('a deleted row is removed before its files', async t => {
  setup(t);
  await deleteImages([media('a')]);
  assert.deepEqual(f.events, ['row', 'files:user-1/a.png+user-1/a_thumb.png']);
});

test('a row delete that fails is queued and its files are still removed', async t => {
  setup(t, { rowError: true });
  await deleteImages([media('a')]);
  assert.equal(f.queued, '["a"]');
  assert.equal(f.events.length, 2);
});

test('an item that can be neither deleted nor queued is reported with its files kept', async t => {
  setup(t, { rowError: true, quota: true });
  await assert.rejects(deleteImages([media('a'), media('b')]), error => error instanceof DeleteImagesError && error.failedIds.join() === 'a,b');
  assert.deepEqual(f.events, ['row', 'row']);
});
