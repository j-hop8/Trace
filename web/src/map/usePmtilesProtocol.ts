import { useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

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
    maplibregl.addProtocol('pmtiles', protocol.tile);
    registered = true;
    setReady(true);

    // Deliberately no cleanup. Removing the protocol on unmount would break any other map still
    // mounted, and re-registering on every mount is what the `registered` guard exists to stop.
  }, []);

  return ready;
}
