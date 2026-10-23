# Booth visual direction

One continuous musical space surrounds the small, fixed CDJs and A9. Each deck changes
that shared space through its actual waveform RGB, beat position, energy, and mixer
routing. There are no separate objects assigned to individual decks.

## Current composition: prismatic field

The immersive default and `visual=vgpu` use [Vercel's vgpu](https://github.com/vercel-labs/vgpu).
A periodic implicit surface extends into the distance. A bending passage through its
middle exposes overlapping near, middle, and far layers. Forward translation sends
folds from the distance toward the viewer, past the edges of the screen. Rotations
in the x/w and y/w planes change a three-dimensional slice through a four-dimensional
field, so openings divide and reconnect without cuts.

Motion has three different scales: continuous forward travel, individual beat fronts,
and slower spatial rotation. Forward velocity integrates the contributions of all
playing decks; changing levels never multiplies absolute time and teleports the scene.
Each deck launches its own colored light front through depth. Bass expands the surface,
mids bend it, and highs light its finer engravings. Color controls warp it; selected
Beat FX add traveling light patterns. Faders, trim, crossfader routing, and master gain
gate each deck's influence, including the library preview.

The material combines dark surfaces, white reflected strips, waveform-colored lights,
thin-shell transmission, HDR bloom, and stationary ordered dithering. This is an
art-directed glass approximation, not a multi-bounce optical simulation. Hardware stays
readable through a protected central region; nearby folds may cross its perimeter.

The renderer uses native WebGPU, a bounded raymarch, quarter-resolution bloom, adaptive
scene resolution, and at most two submitted frames in flight. Hardware retains its
original DOM resolution. Shader compilation and device loss fall back to line visuals.

## References

The applications below are interpretations of published work, not reproductions of footage.

| Reference | Application |
| --- | --- |
| [Max Cooper / Kevin McGloughlin — Repetition, Yearning for the Infinite](https://www.yearningfortheinfinite.net/) | Repeated structures, strong parallax, and an apparently endless environment. |
| [Max Cooper / Kevin McGloughlin — Resynthesis](https://vimeo.com/groups/bluepepper/videos/241546182) | Time becomes spatial movement; small musical events change local details as well as the whole scene. |
| [Max Cooper / Andy Lomas — Scalar](https://www.yearningfortheinfinite.net/) | One shared structure develops complexity across different spatial scales. |
| [Robert Henke — Lumière III](https://www.roberthenke.com/concerts/lumiere-3.html) | Sharp repeated marks and colored edges against black. |
| [Ryoji Ikeda — data-verse](https://www.ryojiikeda.com/project/x_verse/) | Large-scale order with fine detail and controlled contrast. |
| [Polo & Pan — Ani Kuni, directed by MAY / Werlen Meyer](https://vimeo.com/558963040) | Confident, readable color and fluid forms. |
| [Vercel's prism implementation](https://tympanus.net/codrops/2026/09/03/from-rays-to-meshes-building-vercels-prism-with-vgpu/) | Glass-like reflections, light, bloom, and explicit performance budgets. |

The bloom shaders are adapted from Vercel's MIT-licensed glass-sculpture example. Its
license is retained in `src/shaders/VERCEL-LICENSE` and embedded in the shader source.

## Review criteria

- See one environment at thumbnail size and waveform detail at full size.
- Near folds move faster across the screen than distant structure.
- Independent deck pauses and faders remove the corresponding colored contribution.
- Color persists between beats; beats launch motion and brightness through depth.
- The scene evolves continuously rather than resetting or globally flashing.
- Hardware remains recognizable and accessible.

Earlier scene comparisons remain available through `visual=webgpu` (folded surface),
`visual=spark&composition=architecture`, `visual=spark` (ribbons), and `visual=lines`.
