import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaneZoomer } from '../../src/herdr/zoom.ts';
import { silentLogger } from '../../src/log.ts';

/** A herdr whose tabs remember their zoom state, answering `pane.zoom` the way herdr 0.8.0 does (docs/herdr-findings.md). */
function harness(opts: { single?: Set<string>; zoomed?: Set<string>; fail?: boolean } = {}) {
  const zoomed = opts.zoomed ?? new Set<string>();
  const single = opts.single ?? new Set<string>();
  const calls: string[] = [];
  const zoomer = new PaneZoomer({
    request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (opts.fail) throw new Error('unknown method pane.zoom');
      const pane = params['pane_id'] as string;
      const mode = params['mode'] as string;
      calls.push(`${mode} ${pane}`);
      assert.equal(method, 'pane.zoom');
      if (single.has(pane)) return { zoom: { changed: false, zoom_changed: false, focus_changed: false, pane_id: pane, zoomed: false, reason: 'single_pane' } } as T;
      const was = zoomed.has(pane);
      const want = mode === 'on' ? true : mode === 'off' ? false : !was;
      if (want) zoomed.add(pane);
      else zoomed.delete(pane);
      const reason = was === want ? (want ? 'already_zoomed' : 'already_unzoomed') : null;
      return { zoom: { changed: was !== want, zoom_changed: was !== want, focus_changed: false, pane_id: pane, zoomed: want, reason } } as T;
    },
    log: silentLogger,
  });
  return { zoomer, calls, zoomed };
}

test('apply zooms the pane and release unzooms it; both idempotent per owner', async () => {
  const h = harness();
  const phone = {};
  assert.equal(await h.zoomer.apply('w1:pA', phone), true);
  assert.ok(h.zoomer.owns('w1:pA'));
  assert.deepEqual(h.zoomer.panesOf(phone), ['w1:pA']);
  await h.zoomer.release('w1:pA', phone);
  await h.zoomer.release('w1:pA', phone); // nothing held any more: no request
  assert.deepEqual(h.calls, ['on w1:pA', 'off w1:pA']);
  assert.equal(h.zoomed.has('w1:pA'), false);
  assert.equal(h.zoomer.owns('w1:pA'), false);
});

test('a zoom the desktop user made is not ours: leaving does not unzoom it', async () => {
  const h = harness({ zoomed: new Set(['w1:pA']) });
  const phone = {};
  assert.equal(await h.zoomer.apply('w1:pA', phone), true); // already_zoomed
  assert.equal(h.zoomer.owns('w1:pA'), false);
  await h.zoomer.release('w1:pA', phone);
  assert.deepEqual(h.calls, ['on w1:pA']);
  assert.equal(h.zoomed.has('w1:pA'), true, 'the desktop keeps its zoom');
});

test('a single-pane tab cannot zoom: zoomed:false and nothing to restore', async () => {
  const h = harness({ single: new Set(['w1:pS']) });
  const phone = {};
  assert.equal(await h.zoomer.apply('w1:pS', phone), false);
  assert.equal(h.zoomer.owns('w1:pS'), false);
  await h.zoomer.release('w1:pS', phone);
  assert.deepEqual(h.calls, ['on w1:pS']);
});

test('two phones on one pane: the zoom stays until the last one leaves; a re-watch after reconnect keeps ownership', async () => {
  const h = harness();
  const a = {};
  const b = {};
  await h.zoomer.apply('w1:pA', a);
  assert.equal(await h.zoomer.apply('w1:pA', b), true); // already_zoomed, but by us → co-owned
  await h.zoomer.apply('w1:pA', a); // same phone again (reconnect): still one owner entry
  await h.zoomer.release('w1:pA', a);
  assert.equal(h.zoomed.has('w1:pA'), true, 'b still looks at it');
  await h.zoomer.releaseAll(b);
  assert.equal(h.zoomed.has('w1:pA'), false);
  assert.deepEqual(h.calls, ['on w1:pA', 'on w1:pA', 'on w1:pA', 'off w1:pA']);
});

test('a desktop user who unzooms meanwhile is left alone (off is a harmless no-op) and reset forgets everything', async () => {
  const h = harness();
  const phone = {};
  await h.zoomer.apply('w1:pA', phone);
  h.zoomed.delete('w1:pA'); // unzoomed on the desktop
  await h.zoomer.release('w1:pA', phone);
  assert.deepEqual(h.calls, ['on w1:pA', 'off w1:pA']);
  await h.zoomer.apply('w1:pB', phone);
  h.zoomer.reset();
  assert.deepEqual(h.zoomer.panesOf(phone), []);
  await h.zoomer.release('w1:pB', phone);
  assert.deepEqual(h.calls, ['on w1:pA', 'off w1:pA', 'on w1:pB']);
});

test('an old herdr without pane.zoom: apply rejects and nothing is recorded', async () => {
  const h = harness({ fail: true });
  await assert.rejects(h.zoomer.apply('w1:pA', {}), /unknown method/);
  assert.equal(h.zoomer.owns('w1:pA'), false);
});

test('restoreAll (bridge shutdown) unzooms every pane the bridge zoomed and leaves the desktop\'s own zooms alone', async () => {
  const h = harness({ zoomed: new Set(['w1:pC']) });
  const phone = {};
  const other = {};
  await h.zoomer.apply('w1:pA', phone);
  await h.zoomer.apply('w1:pB', other);
  await h.zoomer.apply('w1:pC', phone); // already zoomed on the desktop: not ours
  await h.zoomer.restoreAll();
  assert.deepEqual(h.calls.slice(3).sort(), ['off w1:pA', 'off w1:pB']);
  assert.equal(h.zoomed.has('w1:pA'), false);
  assert.equal(h.zoomed.has('w1:pC'), true);
  assert.equal(h.zoomer.owns('w1:pA'), false);
  await h.zoomer.release('w1:pA', phone); // nothing held any more: no request
  assert.equal(h.calls.length, 5);
});
