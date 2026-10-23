# Booth visual ideas

## Crowd motion as an additional input

Requested during the colored, deck-driven visual experiment (2026-10-11).

Keep each deck's musical identity and the A9's mixing decisions as the primary drivers.
Add a surrounding visual layer influenced by the crowd's dancing: movement intensity
could expand the particle field; rhythmic collective motion could steer flowing trails;
spatial movement could pull color toward different parts of the room.

Prototype with aggregate motion energy and optical flow, processed locally. No facial
recognition or identification is needed. Smooth the signal so a single person crossing
the camera does not flash or disrupt the scene. Keep crowd influence independently
adjustable, and fade it out when the input disappears. Camera source and placement are
still to be decided. A first local motion prototype is now available in the space race
scene; other scenes do not yet consume camera input.

## Halloween space race

Recovered from the 2026-10-22 idea conversation: make the immersive booth react to
audio and cameras, with a haunted Temple Run direction or a race through space.
The final direction was explicit: it should feel like a racing game.

`visual=race` now has a visible spacecraft and chase camera, a banked course, three
rivals with independent travel and overtaking, checkpoint gates, laps, speed and
position. Music builds boost charge; a strong beat releases a short boost when charged.
The existing Halloween, 80s, Y2K and tech-house looks still color the same course.

Enable camera steering in the deck preview controls. Low-resolution frame differences
locate movement in the mirrored view, so the ship steers toward that movement; this
is an aggregate movement signal, not pose tracking or optical flow. Camera frames
stay local. Influence is adjustable, stillness recenters, and disabling capture stops
the camera. Reduced-motion preference or zero speed freezes race travel.

This is an endless interactive racing visual: collisions, win conditions, tracked
crowd silhouettes and cosmic creatures remain future ideas.

Art direction refinement: an '80s arcade space racer rendered in 3D. The race opens
in neon midnight with angular spacecraft, a gridded road, wireframe asteroids,
starfields, a striped sunset and a square arcade HUD. Halloween remains selectable.

## Dense waveform sculpture references

- Ryoji Ikeda, datamatics: https://www.ryojiikeda.com/project/datamatics/
  Mathematical density and a strong relationship between sound and image.
- Max Cooper and collaborating visual artists, Yearning for the Infinite:
  https://www.yearningfortheinfinite.net/
  Nested structures and evolving visual narratives rather than a single repeated motif.
- NONOTAK: https://derivative.ca/community-post/nonotak/66933
  Light structures that make depth and architecture visible.
- 1024 architecture, ORBIS: https://www.1024architecture.net/projects/orbis/
  Sound/light interaction and an astronomical sense of scale.

Current original prototype combines source-anchored waveform lines, folded contour surfaces,
and nested rectangular perspective portals. Each deck retains its own color and waveform;
A9 signals shape the geometry. These are conceptual references, not copied assets.

The dense particle version was rejected as visually noisy. Use continuous geometry,
legible repetition and negative space, with subtle ordered dithering. References within
Yearning for the Infinite include Andy Lomas (Scalar), Kevin McGloughlin (Repetition),
and Jessica In (Void); credit the visual collaborators alongside Max Cooper.

## Spark depth prototype

`visual=spark` selects the lazy-loaded Spark/Three.js procedural splat renderer;
preview controls include a link to switch back to lines. This is procedural content,
not an AI-generated reconstruction. Future generated or captured 3D assets can use
Spark's supported scene formats.

The booth is small and centered. Every deck has three waveform-driven stream families,
starting behind its chassis. Colorless depth planes aligned with the CDJ/A9 DOM bounds
occlude rear splats, while forward splats render across the hardware. RGB comes from
each track's analyzed waveform and pulses use its beat grid. Preview controls collapse
to leave room for the surrounding scene.

The current Spark composition uses continuous tangent-aligned waveform ribbons,
nested rounded-square frames, and folded shell contours. A smooth 64-beat cycle per
deck shifts emphasis between architecture and organic surfaces. This applies the
repetition/scale and folding concepts from Repetition (Kevin McGloughlin) and Scalar
(Andy Lomas), with original geometry driven by our library/deck signals.

Palette direction: black space with silver/white structure. Waveform colors emerge
briefly on strong, beat-aligned passages, primarily in the source ribbons; surrounding
architecture stays nearly monochrome. The hue always comes from the corresponding
track's RGB waveform. Thin continuous surfaces take priority over diffuse particle haze.
