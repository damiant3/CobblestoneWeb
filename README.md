# CobblestoneWeb

The Cobblestone Project's web surface, as one deployable static bundle:

- `landing.html` -- the Cobblestone landing page
- `compile/prism.html` -- Prism: Codex through every backend lens, packaged
  standalone, with the compiler's own source on board for the self-compile
- the applications the landing page links to, each Codex compiled to
  WebAssembly: `games/`, `c64/`, `mathbook/`, `data/`, `starmap/`, and the
  `graphics/` gallery over `gpushow/`, `fireworks/`, `globe/`, `fishtank/`
  and `safari/`
- the photography the landing page tells its story with

This repository is a **published artifact, not a source tree**. Everything
here is assembled by `apps/landing/build.ps1` in
[damiant3/Cobblestone](https://github.com/damiant3/Cobblestone) from
`LandingPage.codex` and the wasm plug. Edit there, rebuild, republish;
hand edits here are overwritten by the next publish.

The live backends (Prism's compile-on-demand server and the online REPL)
are servers, not pages, and do not live here. The REPL is Steve Howell's
[essay-repl-server](https://github.com/showell/essay-repl-server).

Built with Codex.
