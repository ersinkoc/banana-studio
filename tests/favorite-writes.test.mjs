import assert from 'node:assert/strict';
import test from 'node:test';
import { createFavoriteWriter } from '../src/lib/gallery/favoriteWrites.ts';

// A fake backend whose writes resolve or reject only when the test says so.
const harness = () => {
  const calls = [], rollbacks = [], server = new Map();
  const writer = createFavoriteWriter(
    (id, value) => new Promise((resolve, reject) => calls.push({ id, value,
      ok: () => { server.set(id, value); resolve(); }, fail: () => reject(new Error('write failed')) })),
    (id, value) => rollbacks.push({ id, value }),
  );
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { writer, calls, rollbacks, server, tick };
};

test('overlapping toggles that both fail restore the saved value, not a stale one', async () => {
  const { writer, calls, rollbacks, tick } = harness();
  const first = writer('m1', false, true), second = writer('m1', true, false);
  await tick();
  assert.equal(calls.length, 1, 'the second write waits for the first');
  calls[0].fail(); await tick();
  assert.deepEqual(rollbacks, [], 'a newer click is pending, so no rollback yet');
  calls[1].fail(); await Promise.all([first, second]);
  assert.deepEqual(rollbacks, [{ id: 'm1', value: false }]);
});

test('a failed later toggle restores the value the earlier toggle saved', async () => {
  const { writer, calls, rollbacks, server, tick } = harness();
  const first = writer('m1', false, true), second = writer('m1', true, false);
  await tick(); calls[0].ok(); await tick();
  calls[1].fail(); await Promise.all([first, second]);
  assert.equal(server.get('m1'), true);
  assert.deepEqual(rollbacks, [{ id: 'm1', value: true }]);
});

test('writes reach the server in click order and success never rolls back', async () => {
  const { writer, calls, rollbacks, server, tick } = harness();
  const all = [writer('m1', false, true), writer('m1', true, false), writer('m1', false, true)];
  for (let i = 0; i < 3; i++) { await tick(); calls[i].ok(); }
  await Promise.all(all);
  assert.deepEqual(calls.map(c => c.value), [true, false, true]);
  assert.equal(server.get('m1'), true);
  assert.deepEqual(rollbacks, []);
});

test('different media do not wait for each other and a fresh chain starts after settling', async () => {
  const { writer, calls, rollbacks, tick } = harness();
  const a = writer('a', false, true), b = writer('b', true, false);
  await tick();
  assert.deepEqual(calls.map(c => c.id), ['a', 'b']);
  calls[1].fail(); calls[0].ok(); await Promise.all([a, b]);
  assert.deepEqual(rollbacks, [{ id: 'b', value: true }]);
  const again = writer('a', true, false); await tick();
  calls[2].fail(); await again;
  assert.deepEqual(rollbacks.at(-1), { id: 'a', value: true });
});
