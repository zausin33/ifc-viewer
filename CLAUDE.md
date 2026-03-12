# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

- `npm run dev` — Start Vite dev server with HMR
- `npm run build` — TypeScript check + Vite production build (`tsc -b && vite build`)
- `npm run lint` — Run ESLint
- `npm run preview` — Preview production build locally

## What This Project Is

A 3D BIM (Building Information Modeling) viewer for IFC files, built with React 19 + TypeScript + Three.js. Features:
- IFC model loading and visualization via `@thatopen/components` (Open BIM Components / OBC)
- Interactive damage marker placement with drag-to-reposition
- 2D orthographic sketch generation (6 views) with PNG export

## Architecture

**Component hierarchy:**
```
App → IFCViewer → MarkerSystem + SketchViewer
```

- **IFCViewer** (`src/components/IFCViewer.tsx`) — Core orchestrator. Initializes OBC world (scene, camera, renderer), loads IFC models, manages state for markers and sketch panel. Shares Three.js objects to children via React refs (`worldRef`, `fragmentsRef`, `containerRef`).
- **MarkerSystem** (`src/components/MarkerSystem.tsx`) — Handles pointer-based raycasting to place/drag marker spheres in the 3D scene. Receives refs from IFCViewer.
- **SketchViewer** (`src/components/SketchViewer.tsx`) — Generates 6 orthographic projections using off-screen WebGL rendering with clipping planes. Composites multi-panel wing sheets and exports as PNG.

**Key pattern:** Components communicate via React refs to Three.js/OBC objects, avoiding unnecessary re-renders while enabling 3D interaction.

## External Runtime Dependencies

The app fetches these at runtime (not bundled):
- Fragments Worker: `https://thatopen.github.io/engine_fragment/resources/worker.mjs`
- Web-IFC WASM: `https://unpkg.com/web-ifc@0.0.74/`

A sample IFC model is in `public/7936501_0.ifc`.
