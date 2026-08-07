import type { StyleSpecification } from 'maplibre-gl';

/**
 * The basemap the race is drawn on.
 *
 * Built here rather than pointed at a hosted style URL because no off-the-shelf
 * style is right for this: cartographic styles (the previous OpenFreeMap
 * Liberty) are designed for wayfinding — dense POI icons, transit markers,
 * neighbourhood labels, pale building fills — and none of that survives contact
 * with a racing game. Terrain in particular never reads as landscape when what
 * is draped over it is a road map; it needs imagery.
 *
 * So: satellite imagery for the ground, and the vector tiles kept only for the
 * two things imagery cannot give — building geometry to extrude, and a thin
 * layer of place labels for orientation.
 *
 * There is deliberately no hillshade layer. One was tried and removed: profiled
 * at 10.8 ms of a 20.8 ms frame with terrain on — more than the terrain mesh,
 * the buildings and the camera pitch put together — while adding almost nothing
 * over imagery that already carries real sun shading and cast shadows. Relief
 * here comes from the terrain mesh itself.
 */

// Esri's World Imagery service. Free to use with attribution, no key, and the
// tile scheme is plain XYZ. Note {z}/{y}/{x} — Esri orders row before column,
// unlike almost every other XYZ endpoint.
const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ATTRIBUTION =
  'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';

// Imagery stops resolving past this in most places; MapLibre overzooms beyond
// it rather than requesting tiles that would 404.
const SATELLITE_MAX_ZOOM = 19;

// OpenFreeMap's planet vector tiles — the same source the old Liberty style
// used, kept purely for `building` and `place` layers.
const VECTOR_TILE_URL = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export const TERRAIN_SOURCE_ID = 'terrain-dem';

// Mapterhorn's public DEM tiles — the source MapLibre's own 3D-terrain example
// uses. Spelled out rather than loaded from its TileJSON purely so
// TERRAIN_MAX_DEM_ZOOM can be set; encoding/tileSize are copied from it.
const TERRAIN_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

// The TileJSON declares no maxzoom, so MapLibre defaults to 22 and fetches and
// terrarium-decodes a DEM tile for every screen tile at chase-camera zoom. Pure
// waste: the underlying data is ~30 m SRTM with no real detail past ~z12, and
// MapLibre overzooms the z12 tile for closer views. Capping this is the single
// biggest terrain saving — DEM decode is per-pixel CPU work on the main thread.
const TERRAIN_MAX_DEM_ZOOM = 12;

export function buildBasemapStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'gis-race satellite',
    glyphs: GLYPHS,
    sources: {
      satellite: {
        type: 'raster',
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        maxzoom: SATELLITE_MAX_ZOOM,
        attribution: SATELLITE_ATTRIBUTION,
      },
      openmaptiles: {
        type: 'vector',
        url: VECTOR_TILE_URL,
      },
      // Registered but not enabled — map.ts leaves setTerrain to the
      // TerrainControl, so DEM tiles are only fetched once terrain is asked for.
      [TERRAIN_SOURCE_ID]: {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 512,
        maxzoom: TERRAIN_MAX_DEM_ZOOM,
        attribution: "<a href='https://mapterhorn.com/attribution'>© Mapterhorn</a>",
      },
    },
    // Directional light, so extruded buildings are shaded rather than flat
    // slabs of one colour. Anchored to the map (not the viewport) so the
    // lighting stays put as the chase camera swings through corners — viewport
    // anchoring makes every building appear to rotate its own shadow.
    light: {
      anchor: 'map',
      position: [1.5, 210, 30],
      intensity: 0.3,
    },
    layers: [
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite',
        paint: { 'raster-opacity': 1 },
      },
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        // Same gate the Liberty style used: below this the footprints are too
        // generalised to extrude into anything meaningful.
        minzoom: 14,
        paint: {
          // Slightly translucent and desaturated so buildings sit *on* the
          // imagery rather than obscuring it — at 75° pitch a solid opaque
          // block wall would hide the road ahead through a town.
          'fill-extrusion-color': '#d8d4cc',
          'fill-extrusion-opacity': 0.85,
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'render_min_height'],
          // Fade in across the zoom the buildings appear at, so they don't pop
          // into existence as a solid wall while the camera is moving.
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        // Towns and above only. The old style's every-neighbourhood labelling
        // ("JARDIM MORUMBI III E IV") is exactly the clutter being removed.
        filter: ['in', 'class', 'city', 'town', 'village'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 14, 15],
          'text-max-width': 8,
          // Labels are for orientation, not decoration — let MapLibre drop them
          // rather than crowd the view when the camera is low and pitched.
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': '#ffffff',
          // Imagery is high-contrast and unpredictable; without a heavy dark
          // halo white text is unreadable over pale ground.
          'text-halo-color': 'rgba(0,0,0,0.75)',
          'text-halo-width': 1.6,
        },
      },
    ],
  };
}
