---
"@gakonst/rekordbox": minor
"@gakonst/cdj-usb": minor
"@gakonst/music": patch
---

Initialize freshly formatted scoped USB exports with both traditional Device Library and encrypted
OneLibrary indexes, sharing one validated audio/ANLZ tree. Preserve dual-library media on later
playlist appends and make unchanged reruns zero-copy.
