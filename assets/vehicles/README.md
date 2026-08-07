# Vehicle model sources

The `.glb` files here are the **inputs** to `npm run bake-meshes`, which
converts them into the flat attribute format `src/render/cars-3d.ts` renders
(`public/models/*.mesh`). They are committed so the bake is reproducible;
nothing in the app loads them directly.

Both are CC0 — public domain, no attribution required — which is a deliberate
constraint rather than a coincidence: a CC-BY model would oblige the app to
carry a credits screen forever, and there were plenty of CC-BY motorcycles to
choose from if that had been acceptable.

| File | Source | Author | Licence |
| --- | --- | --- | --- |
| `car-sedan-sports.glb`, `car-colormap.png` | [Car Kit](https://kenney.nl/assets/car-kit) (v3.1) | Kenney (kenney.nl) | [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) |
| `motorcycle.glb` | ["Cartoony Purple Motorcycle"](https://poly.pizza/m/j20srJUjpB) via Poly Pizza | uploaded to Poly Pizza | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

Kenney asks (but does not require) that you credit 'Kenney' or 'www.kenney.nl'.
Consider this that credit.

## Why they are baked rather than loaded

Three reasons, in order of weight:

1. **Livery colour.** Every vehicle on the grid has its own colour, and the map
   dot, the leaderboard and the 3D model have to agree. A textured glTF drawn
   through deck.gl's `ScenegraphLayer` would render every car in the model's
   own paint — and multiplying the instance colour into a red-textured body
   gives a muddy brown, not a blue car. The bake throws the texture away and
   keeps only its *luminance*, as a per-vertex multiplier: bodywork comes out
   at 1.0 and takes the livery colour exactly, while glass, tyres and grilles
   stay proportionally darker. That is the same convention the hand-built
   meshes used, so nothing downstream changed.
2. **No new runtime dependency.** Loading glTF in the browser means
   `@loaders.gl/gltf` and a scenegraph layer; the bake means a `fetch` and two
   `Float32Array` views over the response.
3. **Cost.** Scene-graph flattening, node transforms and texture sampling
   happen once on a laptop instead of on every page load.
