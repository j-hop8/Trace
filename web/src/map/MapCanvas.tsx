import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import baseStyle from '@/map/basemap/style.json';
import { usePmtilesProtocol } from '@/map/usePmtilesProtocol';
import { useDomainLayers } from '@/map/useDomainLayers';

/**
 * The map canvas.
 *
 * Knows nothing about any specific domain: no domain names, no per-domain branch. Data layers are
 * added by iterating the manifest (T-007), so adding a domain never touches this file. That is
 * the invariant that keeps domains modular rather than hardcoded — and it is stated without
 * naming an example, so a grep for domain literals stays a valid check on this file.
 */

/** Taiwan, framed to fill the viewport on first paint. */
const TAIWAN_BOUNDS: [number, number, number, number] = [119.3, 21.85, 122.05, 25.35];

interface MapCanvasProps {
  /** Called once the style has loaded, so callers can add data layers safely. */
  onReady?: (map: maplibregl.Map) => void;
}

export default function MapCanvas({ onReady }: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const protocolReady = usePmtilesProtocol();
  const [error, setError] = useState<string | null>(null);

  // Held in state rather than the ref alone, so layer management re-runs once the style is ready.
  // Adding a source before `load` throws; this is what makes "ready" observable to React.
  const [readyMap, setReadyMap] = useState<maplibregl.Map | null>(null);
  useDomainLayers(readyMap);

  // The callback is held in a ref rather than read from the effect's closure. A parent passing an
  // inline `onReady={() => …}` creates a new function identity on every render, so depending on it
  // would tear down and rebuild the whole map each time — and if the callback set parent state,
  // that becomes an endless reload loop. Map lifetime must not depend on callback identity.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    // The protocol must exist before construction, or the pmtiles:// source silently resolves
    // to nothing and the map renders blank.
    if (!protocolReady || !container.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle as maplibregl.StyleSpecification,
      bounds: TAIWAN_BOUNDS,
      fitBoundsOptions: { padding: 24 },
      attributionControl: false,
      // Taiwan is long and thin; letting the user tilt adds nothing and makes area hard to judge.
      pitchWithRotate: false,
      dragRotate: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }));

    map.on('error', (event) => {
      // MapLibre reports a missing tileset as a non-fatal event and then shows an empty canvas.
      // Surfacing it beats leaving the reader to wonder why Taiwan is missing.
      const message = event.error?.message ?? 'unknown map error';
      setError(message);
    });

    map.on('load', () => {
      setReadyMap(map);
      onReadyRef.current?.(map);
    });

    // MapLibre measures its container once, at construction. In dev the stylesheet can still be
    // in flight at that moment, so the div is 0x0 and the map silently falls back to its 400x300
    // default -- a working map rendered postage-stamp size in the corner, with no error anywhere.
    // Observing the container fixes the initial race and window resizes with the same mechanism.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container.current);

    mapRef.current = map;

    // Dev-only handle. A map that renders "nothing" gives you no stack trace and no failed
    // request to inspect — the only way to tell an empty viewport from an empty tileset is to
    // interrogate the live instance. Stripped from production builds by the DEV guard.
    if (import.meta.env.DEV) {
      (window as unknown as { __traceMap?: maplibregl.Map }).__traceMap = map;
    }

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      setReadyMap(null);
    };
    // Deliberately depends on protocolReady alone: the map is constructed once and lives until
    // unmount. onReady is reached through a ref precisely so it cannot appear here.
  }, [protocolReady]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      {error && (
        <div className="pointer-events-none absolute inset-x-0 top-0 p-4">
          <div className="mx-auto max-w-xl rounded-lg border border-amber-700/50 bg-amber-950/80 p-3 text-sm backdrop-blur">
            <p className="font-medium text-amber-300">The basemap failed to load</p>
            <p className="mt-1 font-mono text-xs leading-relaxed text-amber-100/70">{error}</p>
            <p className="mt-2 text-xs text-amber-100/60">
              Fetch the Taiwan extract into <code>data/taiwan-base.pmtiles</code> — see
              <code> .agents/tickets/done/T-006-web-basemap.md</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
