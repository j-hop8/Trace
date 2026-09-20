import { useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { GetResourceResponse, RequestParameters } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

import { KIND_ORDER } from '@/types/feature';

/**
 * Teach MapLibre how to read `pmtiles://` URLs.
 *
 * A PMTiles archive is one file read with HTTP range requests — which is the whole reason Trace
 * has no tile server. MapLibre cannot do that natively, so the protocol handler has to be
 * registered *before* any map is constructed, or the style's source URL resolves to nothing and
 * the map comes up blank with no error.
 *
 * Registration is global and process-wide rather than per-map, so this guards against repeat
 * registration under React StrictMode, which mounts effects twice in development.
 */

let registered = false;

export function usePmtilesProtocol(): boolean {
  const [ready, setReady] = useState(registered);

  useEffect(() => {
    if (registered) {
      setReady(true);
      return;
    }

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', sharedTiles(protocol.tile, KIND_ORDER.length));
    registered = true;
    setReady(true);

    // Deliberately no cleanup. Removing the protocol on unmount would break any other map still
    // mounted, and re-registering on every mount is what the `registered` guard exists to stop.
  }, []);

  return ready;
}

/** What MapLibre hands a protocol: the request, and a controller it aborts when the tile is no longer wanted. */
export type ProtocolAction = (
  params: RequestParameters,
  abortController: AbortController,
) => Promise<GetResourceResponse<unknown>>;

/** A tile's bytes as the pmtiles protocol returns them: a typed array, or an ArrayBuffer. */
type Bytes = ArrayBuffer | ArrayBufferView;

interface SharedTile {
  /** Resolves once the bytes are in. Shared by every requester of the URL while it is pending. */
  promise: Promise<GetResourceResponse<Bytes>>;
  /** Aborts the one fetch, once every requester has given up on it. */
  controller: AbortController;
  /** Requesters still waiting on `promise`. */
  waiting: number;
  /** Requesters served so far, pending or not. */
  reads: number;
  /** Cleared once `promise` has settled. */
  pending: boolean;
}

/** How many tiles are kept for a second reader before the oldest is let go. */
const SHARED_TILE_CAPACITY = 32;

/**
 * Serve each tile's bytes to every source that reads the same archive from one fetch.
 *
 * A domain is read through one MapLibre source per kind — the cover source first, the change
 * source once cover has drawn (`sourceId` in layerSpec) — and each source requests the tiles it
 * needs by URL. Left alone, the second source would download every tile the first one already
 * has: 8 MB per domain at the opening view, and again on every pan, where both sources ask for
 * the same new tile in the same frame. So a URL is fetched once and the bytes handed to
 * `readers` requesters — one per kind, since that is how many sources an archive can have. An
 * entry is dropped when its last reader has taken it; entries a lone source reads once, like the
 * basemap's, are let go oldest-first past `SHARED_TILE_CAPACITY`, which bounds what this holds.
 *
 * Two things make this more than a map of promises. MapLibre *transfers* the buffer it is handed
 * to the worker, which detaches it on this side, so the entry keeps a copy and every reader but
 * the last gets a copy of its own. And each requester comes with its own abort: a tile scrolled
 * out of view is abandoned by one source, and that must neither cancel the fetch the other still
 * wants nor keep it running when nobody does — so the shared fetch has one controller, aborted
 * only when its last waiting requester has gone, and a requester that has gone is told so rather
 * than handed bytes it no longer wants.
 *
 * Only `arrayBuffer` requests — tile bytes — are shared. The TileJSON is a `json` request answered
 * from the archive header, which the pmtiles Protocol already caches per archive.
 */
export function sharedTiles(
  load: ProtocolAction,
  readers: number,
  capacity = SHARED_TILE_CAPACITY,
): ProtocolAction {
  const tiles = new Map<string, SharedTile>();

  const forget = (url: string, tile: SharedTile) => {
    if (tiles.get(url) === tile) tiles.delete(url);
  };

  return async (params, abortController) => {
    if (params.type !== 'arrayBuffer' || readers < 2) return load(params, abortController);

    const { url } = params;
    let tile = tiles.get(url);
    if (!tile) {
      const controller = new AbortController();
      const shared: SharedTile = {
        controller,
        waiting: 0,
        reads: 0,
        pending: true,
        promise: load(params, controller).then((response) => {
          shared.pending = false;
          return { ...response, data: copy(response.data as Bytes) };
        }),
      };
      // A fetch that failed is not a result to hand to the next reader; let it retry.
      shared.promise.catch(() => forget(url, shared));
      tile = shared;
      tiles.set(url, tile);
      // Oldest first. A Map iterates in insertion order, and nothing here re-inserts.
      for (const [oldUrl, old] of tiles) {
        if (tiles.size <= capacity) break;
        if (old.pending) continue;
        tiles.delete(oldUrl);
      }
    }

    tile.waiting += 1;
    let abandoned = false;
    const onAbort = () => {
      abandoned = true;
      tile.waiting -= 1;
      if (tile.waiting === 0 && tile.pending) {
        tile.controller.abort();
        forget(url, tile);
      }
    };
    abortController.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await tile.promise;
      if (abandoned) throw new DOMException('The tile was no longer wanted', 'AbortError');

      tile.reads += 1;
      const last = tile.reads >= readers;
      if (last) forget(url, tile);
      // The last reader takes the kept copy itself; earlier ones get a copy, since what they are
      // handed is transferred away.
      return { ...response, data: last ? response.data : copy(response.data) };
    } finally {
      abortController.signal.removeEventListener('abort', onAbort);
      if (!abandoned) tile.waiting -= 1;
    }
  };
}

/**
 * A copy of the bytes, of the same shape, that no transfer of the original can detach.
 *
 * Anything else — the `null` the protocol returns for a tile the archive does not hold — has
 * nothing to detach and is passed through.
 */
function copy<T>(data: T): T {
  if (data instanceof ArrayBuffer) return data.slice(0) as T;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    ) as T;
  }
  return data;
}
