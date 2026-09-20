/**
 * `sharedTiles` — one fetch per tile, however many sources read the archive.
 *
 * A domain is read through one source per kind, and both ask for the same tiles. What is pinned
 * here is the accounting that makes sharing safe rather than merely cheaper: that a reader is
 * handed bytes no transfer of another reader's can detach, that an entry lives exactly as long as
 * its readers need it, and that one reader giving up on a tile neither cancels it for the other
 * nor keeps a fetch running that nobody wants.
 */

import { describe, expect, it, vi } from 'vitest';

import { sharedTiles } from '@/map/usePmtilesProtocol';
import type { ProtocolAction } from '@/map/usePmtilesProtocol';

const bytes = (...values: number[]) => new Uint8Array(values);

const tile = (url: string, type: 'arrayBuffer' | 'json' = 'arrayBuffer') => ({ url, type });

/**
 * A stand-in for the pmtiles protocol: answers every request with fresh bytes, and lets a test
 * hold a request open. Records what it was asked and with which controller.
 */
function fakeLoad() {
  const calls: { url: string; controller: AbortController }[] = [];
  const pending = new Map<string, (response: { data: Uint8Array }) => void>();
  const load: ProtocolAction = (params, controller) => {
    calls.push({ url: params.url, controller });
    return new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
      pending.set(params.url, resolve);
    });
  };
  const answer = (url: string, data = bytes(1, 2, 3)) => {
    pending.get(url)?.({ data });
    pending.delete(url);
  };
  return { load, calls, answer };
}

/** What MapLibre does with the bytes it is handed: transfers them, which detaches the buffer. */
const transfer = (data: unknown) => {
  const view = data as Uint8Array;
  structuredClone(view.buffer, { transfer: [view.buffer] });
  return view;
};

describe('sharedTiles', () => {
  it('serves the second reader from the first reader’s fetch', async () => {
    const { load, calls, answer } = fakeLoad();
    const shared = sharedTiles(load, 2);

    const first = shared(tile('a/1/2/3'), new AbortController());
    answer('a/1/2/3');
    const firstData = transfer((await first).data);

    const second = await shared(tile('a/1/2/3'), new AbortController());

    expect(calls).toHaveLength(1);
    // The first reader's transfer detached its own buffer and nobody else's.
    expect(firstData.byteLength).toBe(0);
    expect(second.data).toEqual(bytes(1, 2, 3));
  });

  it('forgets a tile once its last reader has taken it', async () => {
    const { load, calls, answer } = fakeLoad();
    const shared = sharedTiles(load, 2);

    const first = shared(tile('a/1/2/3'), new AbortController());
    answer('a/1/2/3');
    await first;
    await shared(tile('a/1/2/3'), new AbortController());

    const third = shared(tile('a/1/2/3'), new AbortController());
    answer('a/1/2/3', bytes(9));
    expect((await third).data).toEqual(bytes(9));
    expect(calls).toHaveLength(2);
  });

  it('shares a fetch still in flight, as two sources asking in the same frame do', async () => {
    const { load, calls, answer } = fakeLoad();
    const shared = sharedTiles(load, 2);

    const first = shared(tile('a/1/2/3'), new AbortController());
    const second = shared(tile('a/1/2/3'), new AbortController());
    answer('a/1/2/3');

    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a.data).toEqual(bytes(1, 2, 3));
    expect(b.data).toEqual(bytes(1, 2, 3));
    // Distinct buffers: transferring one leaves the other whole.
    transfer(a.data);
    expect((b.data as Uint8Array).byteLength).toBe(3);
  });

  it('keeps the fetch running when one of two readers gives up on it', async () => {
    const { load, calls, answer } = fakeLoad();
    const shared = sharedTiles(load, 2);

    const gone = new AbortController();
    const first = shared(tile('a/1/2/3'), gone);
    const second = shared(tile('a/1/2/3'), new AbortController());
    gone.abort();

    expect(calls[0]?.controller.signal.aborted).toBe(false);
    answer('a/1/2/3');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((await second).data).toEqual(bytes(1, 2, 3));
  });

  it('cancels the fetch once every reader has given up on it', async () => {
    const { load, calls } = fakeLoad();
    const shared = sharedTiles(load, 2);

    const one = new AbortController();
    const two = new AbortController();
    const first = shared(tile('a/1/2/3'), one);
    const second = shared(tile('a/1/2/3'), two);
    one.abort();
    expect(calls[0]?.controller.signal.aborted).toBe(false);
    two.abort();
    expect(calls[0]?.controller.signal.aborted).toBe(true);

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not keep a fetch that failed', async () => {
    const load = vi
      .fn<ProtocolAction>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: bytes(4) });
    const shared = sharedTiles(load, 2);

    await expect(shared(tile('a/1/2/3'), new AbortController())).rejects.toThrow('offline');
    expect((await shared(tile('a/1/2/3'), new AbortController())).data).toEqual(bytes(4));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets the oldest tile go past its capacity, so a lone reader cannot fill it', async () => {
    const { load, calls, answer } = fakeLoad();
    const shared = sharedTiles(load, 2, 2);

    for (const url of ['a/1', 'a/2', 'a/3']) {
      const request = shared(tile(url), new AbortController());
      answer(url);
      await request;
    }

    // The first was let go to make room for the third; the second is still held.
    await shared(tile('a/2'), new AbortController());
    expect(calls.map((c) => c.url)).toEqual(['a/1', 'a/2', 'a/3']);

    const again = shared(tile('a/1'), new AbortController());
    answer('a/1');
    await again;
    expect(calls.map((c) => c.url)).toEqual(['a/1', 'a/2', 'a/3', 'a/1']);
  });

  it('passes anything but tile bytes straight through', async () => {
    const load = vi.fn<ProtocolAction>().mockResolvedValue({ data: { tiles: [] } });
    const shared = sharedTiles(load, 2);

    await shared(tile('a', 'json'), new AbortController());
    await shared(tile('a', 'json'), new AbortController());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('is a plain pass-through for an archive with one reader', async () => {
    const load = vi.fn<ProtocolAction>().mockResolvedValue({ data: bytes(1) });
    const shared = sharedTiles(load, 1);

    await shared(tile('a/1/2/3'), new AbortController());
    await shared(tile('a/1/2/3'), new AbortController());
    expect(load).toHaveBeenCalledTimes(2);
  });
});
