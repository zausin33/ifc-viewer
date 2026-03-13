import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import * as OBC from "@thatopen/components";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorldLike {
  camera: {
    three: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    controls: { enabled: boolean };
  };
  renderer: { three: THREE.WebGLRenderer } | null;
  scene: { three: THREE.Scene };
}

/** Minimal interface covering the `raycast` method from @thatopen/fragments models */
interface FragmentModelLike {
  raycast(data: {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    mouse: THREE.Vector2;
    dom: HTMLCanvasElement;
  }): Promise<{ distance: number; point: THREE.Vector3; normal?: THREE.Vector3 } | null>;
}

interface MarkerSystemProps {
  worldRef: MutableRefObject<WorldLike | null>;
  fragmentsRef: MutableRefObject<OBC.FragmentsManager | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  active: boolean;
  markersRef: MutableRefObject<THREE.Mesh[]>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPHERE_RADIUS = 0.3;
const DRAG_THRESHOLD_PX = 5;
const MARKER_COLOR_DEFAULT = "#ff4444";
const MARKER_COLOR_HOVERED = "#ffaa00";
const MARKER_COLOR_DRAGGING = "#ff8800";

// ─── Component ───────────────────────────────────────────────────────────────

export default function MarkerSystem({
  worldRef,
  fragmentsRef,
  containerRef,
  active,
  markersRef,
}: MarkerSystemProps) {
  const dragState = useRef<{
    marker: THREE.Mesh | null;
    dragging: boolean;
    hasMoved: boolean;
    pointerDownPos: { x: number; y: number };
    pointerId: number | null;
  }>({
    marker: null,
    dragging: false,
    hasMoved: false,
    pointerDownPos: { x: 0, y: 0 },
    pointerId: null,
  });

  // Shared geometry (re-used across all spheres)
  const sphereGeoRef = useRef<THREE.SphereGeometry | null>(null);

  useEffect(() => {
    if (!sphereGeoRef.current) {
      sphereGeoRef.current = new THREE.SphereGeometry(SPHERE_RADIUS, 16, 16);
    }
    return () => {
      sphereGeoRef.current?.dispose();
      sphereGeoRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    const world = worldRef.current;
    const fragments = fragmentsRef.current;

    if (!container || !world || !fragments || !sphereGeoRef.current) return;

    const raycaster = new THREE.Raycaster();
    const ndcMouse = new THREE.Vector2();
    const drag = dragState.current; // snapshot for use in cleanup

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Convert pointer event to Normalized Device Coordinates for THREE.Raycaster */
    const toNDC = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      ndcMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      ndcMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    /** Raycast against fragment models (uses clientX/Y as the OBC API expects) */
    const raycastModel = async (event: PointerEvent) => {
      const mouse = new THREE.Vector2(event.clientX, event.clientY);
      const dom = world.renderer?.three.domElement;
      if (!dom) return null;

      const results: Array<{ distance: number; point: THREE.Vector3 }> = [];

      for (const [, model] of fragments.list) {
        const result = await (model as unknown as FragmentModelLike).raycast({
          camera: world.camera.three,
          mouse,
          dom,
        });
        if (result) results.push(result);
      }

      if (results.length === 0) return null;

      return results.reduce((closest, r) => (r.distance < closest.distance ? r : closest));
    };

    /** Raycast against placed marker spheres using THREE.Raycaster */
    const raycastMarkers = (event: PointerEvent) => {
      toNDC(event);
      raycaster.setFromCamera(ndcMouse, world.camera.three);
      const hits = raycaster.intersectObjects(markersRef.current, false);
      return hits.length > 0 ? hits[0] : null;
    };

    const makeMaterial = (color: string) =>
      new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 0.85,
      });

    // ── Event handlers ────────────────────────────────────────────────────────

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;

      dragState.current.pointerDownPos = { x: event.clientX, y: event.clientY };
      dragState.current.hasMoved = false;

      const hit = raycastMarkers(event);
      if (hit) {
        const marker = hit.object as THREE.Mesh;
        dragState.current.marker = marker;
        dragState.current.dragging = true;
        dragState.current.pointerId = event.pointerId;
        (marker.material as THREE.MeshLambertMaterial).color.set(MARKER_COLOR_DRAGGING);
        container.setPointerCapture(event.pointerId);
        // Disable camera controls for the entire drag gesture
        world.camera.controls.enabled = false;
        event.stopPropagation();
      }
    };

    const onPointerMove = async (event: PointerEvent) => {
      const { pointerDownPos } = dragState.current;
      const dx = event.clientX - pointerDownPos.x;
      const dy = event.clientY - pointerDownPos.y;

      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        dragState.current.hasMoved = true;
      }

      if (!dragState.current.dragging || !dragState.current.marker) return;

      // Move the marker to the new surface hit point
      const result = await raycastModel(event);
      if (result) {
        dragState.current.marker.position.copy(result.point);
      }
    };

    const onPointerEnter = (event: PointerEvent) => {
      const hit = raycastMarkers(event);
      if (hit && !dragState.current.dragging) {
        (hit.object as THREE.Mesh).material = makeMaterial(MARKER_COLOR_HOVERED);
      }
    };

    const onPointerUp = async (event: PointerEvent) => {
      if (event.button !== 0) return;

      // End drag
      if (dragState.current.dragging && dragState.current.marker) {
        (dragState.current.marker.material as THREE.MeshLambertMaterial).color.set(
          MARKER_COLOR_DEFAULT,
        );
        if (dragState.current.pointerId !== null) {
          container.releasePointerCapture(dragState.current.pointerId);
        }
        dragState.current.marker = null;
        dragState.current.dragging = false;
        dragState.current.pointerId = null;
        // Re-enable camera controls after drag ends
        world.camera.controls.enabled = true;
        return;
      }

      // Place new marker only on a clean click (no significant movement)
      if (!dragState.current.hasMoved) {
        const result = await raycastModel(event);
        if (!result || !sphereGeoRef.current) return;
        const sphere = new THREE.Mesh(sphereGeoRef.current, makeMaterial(MARKER_COLOR_DEFAULT));
        sphere.position.copy(result.point);
        world.scene.three.add(sphere);
        markersRef.current.push(sphere);
      }
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointerenter", onPointerEnter);

    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointerenter", onPointerEnter);
      // Always restore camera controls when the effect tears down (e.g. toggling off mid-drag)
      world.camera.controls.enabled = true;
      drag.dragging = false;
      drag.marker = null;
    };
  }, [active, worldRef, fragmentsRef, containerRef]);

  return null; // Renders into the Three.js scene, not the DOM
}
