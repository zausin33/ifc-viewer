import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import Stats from "stats.js";
import MarkerSystem, { type WorldLike } from "./MarkerSystem";
import SketchViewer from "./SketchViewer";

const FRAGMENTS_WORKER_URL = "https://thatopen.github.io/engine_fragment/resources/worker.mjs";
const WEB_IFC_PATH = "https://unpkg.com/web-ifc@0.0.74/";
const DEFAULT_IFC_PATH = "/7936501_0.ifc";

export default function IFCViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMarkerMode, setIsMarkerMode] = useState(false);

  // Refs to Three.js/OBC objects so MarkerSystem can access them after mount
  const worldRef = useRef<WorldLike | null>(null);
  const fragmentsRef = useRef<OBC.FragmentsManager | null>(null);
  const markersRef = useRef<THREE.Mesh[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);

    const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    worldRef.current = world;

    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = null;

    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.OrthoPerspectiveCamera(components);

    components.init();

    world.camera.controls.setLookAt(78, 20, -2.2, 26, -4, 25);
    components.get(OBC.Grids).create(world);

    // Capture camera and scene refs before any async work (avoids "No camera initialized" when world ref is stale)
    const cameraRef = world.camera;
    const sceneRef = world.scene;

    // Fragments worker and manager
    const fragments = components.get(OBC.FragmentsManager);
    fragmentsRef.current = fragments;
    let workerUrl: string | null = null;

    const initAndLoad = async () => {
      try {
        const fetchedUrl = await fetch(FRAGMENTS_WORKER_URL);
        const workerBlob = await fetchedUrl.blob();
        const workerFile = new File([workerBlob], "worker.mjs", {
          type: "text/javascript",
        });
        workerUrl = URL.createObjectURL(workerFile);
        fragments.init(workerUrl);

        cameraRef.controls.addEventListener("update", () => fragments.core.update());

        fragments.list.onItemSet.add(({ value: model }) => {
          model.useCamera(cameraRef.three);
          sceneRef.three.add(model.object);
          fragments.core.update(true);
        });

        fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
          if (!("isLodMaterial" in material && material.isLodMaterial)) {
            material.polygonOffset = true;
            material.polygonOffsetUnits = 1;
            material.polygonOffsetFactor = Math.random();
          }
        });

        const ifcLoader = components.get(OBC.IfcLoader);
        await ifcLoader.setup({
          autoSetWasm: false,
          wasm: {
            path: WEB_IFC_PATH,
            absolute: true,
          },
        });

        const file = await fetch(DEFAULT_IFC_PATH);
        const data = await file.arrayBuffer();
        const buffer = new Uint8Array(data);

        await ifcLoader.load(buffer, false, "7936501_0", {
          processData: {
            progressCallback: (progress) => console.log("IFC load progress:", progress),
          },
        });

        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load IFC");
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    initAndLoad();

    const stats = new Stats();
    stats.showPanel(2);
    container.appendChild(stats.dom);
    stats.dom.style.left = "0px";
    stats.dom.style.top = "0px";
    stats.dom.style.right = "auto";
    stats.dom.style.zIndex = "10";
    world.renderer.onBeforeUpdate.add(() => stats.begin());
    world.renderer.onAfterUpdate.add(() => stats.end());

    return () => {
      worldRef.current = null;
      fragmentsRef.current = null;
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      components.dispose();
    };
  }, []);

  return (
    <div className="ifc-viewer-wrapper">
      <div ref={containerRef} className="ifc-viewer-container" />

      {/* Marker mode toggle button */}
      <button
        className={`marker-toggle-btn${isMarkerMode ? " marker-toggle-btn--active" : ""}`}
        title={isMarkerMode ? "Disable marker placement" : "Enable marker placement"}
        onClick={() => setIsMarkerMode((prev) => !prev)}
      >
        📍 {isMarkerMode ? "Marker: ON" : "Marker: OFF"}
      </button>

      {/* Marker mode hint */}
      {isMarkerMode && (
        <div className="marker-hint">
          Click on the model to place a damage marker · Drag an existing marker to reposition it
        </div>
      )}

      {/* Marker system — renders into the Three.js scene, no DOM output */}
      <MarkerSystem
        worldRef={worldRef}
        fragmentsRef={fragmentsRef}
        containerRef={containerRef}
        active={isMarkerMode}
        markersRef={markersRef}
      />

      {/* Sketch views panel */}
      <SketchViewer worldRef={worldRef} fragmentsRef={fragmentsRef} markersRef={markersRef} />

      {loading && <div className="ifc-viewer-loading">Loading IFC model…</div>}
      {error && <div className="ifc-viewer-error">{error}</div>}
    </div>
  );
}
