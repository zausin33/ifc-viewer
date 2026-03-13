import { useState, useCallback, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import type { WorldLike } from "./MarkerSystem";

interface FragmentModelLike {
  raycast(data: {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    mouse: THREE.Vector2;
    dom: HTMLCanvasElement;
  }): Promise<{ distance: number; point: THREE.Vector3; normal?: THREE.Vector3 } | null>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CAPTURE_W = 1200;
const CAPTURE_H = 800;
const BACKGROUND_COLOR = new THREE.Color(0xfafafa);

// ─── Types ───────────────────────────────────────────────────────────────────

interface ViewData {
  baseImageUrl: string;
  imageUrl: string;
  camera: THREE.OrthographicCamera;
  clippingPlanes: THREE.Plane[];
}

type ClickableKey =
  | "top" | "bottom" | "front" | "back"
  | "leftFrontCrop" | "leftBackCrop" | "rightFrontCrop" | "rightBackCrop"
  | "leftSideView" | "rightSideView";

interface SketchViewsData {
  top: ViewData | null;
  bottom: ViewData | null;
  front: ViewData | null;
  back: ViewData | null;
  leftWing: string | null;
  rightWing: string | null;

  leftFrontCrop: ViewData | null;
  leftBackCrop: ViewData | null;
  rightFrontCrop: ViewData | null;
  rightBackCrop: ViewData | null;
  leftSideView: ViewData | null;
  rightSideView: ViewData | null;
}

interface WingComposeParams {
  leftPanels: [ClickableKey, ClickableKey, ClickableKey];
  leftLabels: [string, string, string];
  leftMirrors: [boolean, boolean, boolean];
  leftWidths: [number, number, number];
  rightPanels: [ClickableKey, ClickableKey, ClickableKey];
  rightLabels: [string, string, string];
  rightMirrors: [boolean, boolean, boolean];
  rightWidths: [number, number, number];
}

export interface SketchViewerProps {
  worldRef: MutableRefObject<WorldLike | null>;
  fragmentsRef: MutableRefObject<OBC.FragmentsManager | null>;
  markersRef: MutableRefObject<THREE.Mesh[]>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a bounding box from all Mesh objects in the scene, skipping helpers
 * (lines/grid objects used by OBC for visual aids).
 */
const computeSceneBounds = (scene: THREE.Scene): THREE.Box3 => {
  const box = new THREE.Box3();
  scene.traverse((child) => {
    if (
      child instanceof THREE.Mesh &&
      !(child instanceof THREE.LineSegments) &&
      !(child instanceof THREE.Line)
    ) {
      box.expandByObject(child);
    }
  });
  return box;
};

/**
 * Build an orthographic camera whose frustum is sized to fit the entire bounding
 * box when viewed from the requested direction.
 */
const makeOrthoCamera = (
  box: THREE.Box3,
  direction: "top" | "bottom" | "front" | "back" | "left" | "right",
): THREE.OrthographicCamera => {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const aspect = CAPTURE_W / CAPTURE_H;
  const MARGIN = 1;

  let eye: THREE.Vector3;
  let up: THREE.Vector3;
  let frameW: number;
  let frameH: number;

  switch (direction) {
    case "top":
      eye = new THREE.Vector3(center.x, box.max.y + size.y * 2, center.z);
      up = new THREE.Vector3(0, 0, -1);
      frameW = size.x;
      frameH = size.z;
      break;
    case "bottom":
      eye = new THREE.Vector3(center.x, box.min.y - size.y * 2, center.z);
      up = new THREE.Vector3(0, 0, -1);
      frameW = size.x;
      frameH = size.z;
      break;
    case "front":
      eye = new THREE.Vector3(center.x, center.y, box.max.z + size.z * 2);
      up = new THREE.Vector3(0, 1, 0);
      frameW = size.x;
      frameH = size.y;
      break;
    case "back":
      eye = new THREE.Vector3(center.x, center.y, box.min.z - size.z * 2);
      up = new THREE.Vector3(0, 1, 0);
      frameW = size.x;
      frameH = size.y;
      break;
    case "left":
      eye = new THREE.Vector3(box.min.x - size.x * 2, center.y, center.z);
      up = new THREE.Vector3(0, 1, 0);
      frameW = size.z;
      frameH = size.y;
      break;
    case "right":
      eye = new THREE.Vector3(box.max.x + size.x * 2, center.y, center.z);
      up = new THREE.Vector3(0, 1, 0);
      frameW = size.z;
      frameH = size.y;
      break;
  }

  // Scale both dimensions so the geometry always fits inside the viewport
  const uniformHalf = (Math.max(frameW / aspect, frameH) / 2) * MARGIN;
  const halfW = uniformHalf * aspect;
  const halfH = uniformHalf;

  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 200000);
  cam.position.copy(eye);
  cam.up.copy(up);
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  return cam;
};

/**
 * Build an ortho camera for a front/back wing crop that tightly frames
 * the clip region horizontally, and uses a shared halfH for uniform
 * vertical scale across all panels in the wing sheet.
 */
const makeWingCropCamera = (
  fullBox: THREE.Box3,
  clipBox: THREE.Box3,
  direction: "front" | "back",
  sharedHalfH: number,
): THREE.OrthographicCamera => {
  const fullSize = new THREE.Vector3();
  const clipSize = new THREE.Vector3();
  const clipCenter = new THREE.Vector3();
  const fullCenter = new THREE.Vector3();
  fullBox.getSize(fullSize);
  clipBox.getSize(clipSize);
  clipBox.getCenter(clipCenter);
  fullBox.getCenter(fullCenter);

  // Frame the wing's X extent tightly, use shared halfH for uniform Y scale
  const wingAspect = CAPTURE_W / CAPTURE_H;
  const halfW = Math.max(clipSize.x / 2, sharedHalfH * wingAspect);
  const halfH = sharedHalfH;

  let eye: THREE.Vector3;
  if (direction === "front") {
    eye = new THREE.Vector3(clipCenter.x, fullCenter.y, fullBox.max.z + fullSize.z * 2);
  } else {
    eye = new THREE.Vector3(clipCenter.x, fullCenter.y, fullBox.min.z - fullSize.z * 2);
  }
  const lookAt = new THREE.Vector3(clipCenter.x, fullCenter.y, fullCenter.z);

  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 200000);
  cam.position.copy(eye);
  cam.up.set(0, 1, 0);
  cam.lookAt(lookAt);
  cam.updateProjectionMatrix();
  return cam;
};

/**
 * Overlay marker positions onto a captured view image.
 * Projects 3D marker positions through the camera to pixel coords,
 * then draws red dots on a canvas copy of the image.
 */
const overlayMarkers = (
  dataUrl: string,
  camera: THREE.OrthographicCamera,
  markers: THREE.Mesh[],
  clippingPlanes: THREE.Plane[],
  width: number = CAPTURE_W,
  height: number = CAPTURE_H,
): Promise<string> => {
  if (markers.length === 0) return Promise.resolve(dataUrl);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);

      const viewProjection = new THREE.Matrix4();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

      for (const marker of markers) {
        const pos = marker.position.clone();

        // Check if the marker is clipped by any clipping plane
        let clipped = false;
        for (const plane of clippingPlanes) {
          if (plane.distanceToPoint(pos) < 0) {
            clipped = true;
            break;
          }
        }
        if (clipped) continue;

        // Project to NDC
        const ndc = pos.applyMatrix4(viewProjection);

        // NDC to pixel coords
        const px = ((ndc.x + 1) / 2) * width;
        const py = ((1 - ndc.y) / 2) * height;

        // Skip if outside the viewport
        if (px < 0 || px > width || py < 0 || py > height) continue;

        // Draw marker dot
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 68, 68, 0.9)";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      resolve(canvas.toDataURL("image/png"));
    };
    img.src = dataUrl;
  });
};

/**
 * Render the scene to an off-screen WebGLRenderTarget reusing the EXISTING
 * renderer (avoids a second WebGL context). Reads pixels back, flips the Y axis
 * (WebGL is bottom-up), and returns a PNG data URL.
 */
const captureView = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  clippingPlanes: THREE.Plane[] = [],
): string => {
  const W = CAPTURE_W;
  const H = CAPTURE_H;

  // ── Save renderer state ───────────────────────────────────────────────────
  const prevTarget = renderer.getRenderTarget();
  const prevLocalClipping = renderer.localClippingEnabled;
  const prevPlanes = renderer.clippingPlanes;
  const prevClearColor = new THREE.Color();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(prevClearColor);

  // ── Off-screen render ─────────────────────────────────────────────────────
  const target = new THREE.WebGLRenderTarget(W, H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  renderer.localClippingEnabled = clippingPlanes.length > 0;
  renderer.clippingPlanes = clippingPlanes;
  renderer.setRenderTarget(target);
  renderer.setClearColor(BACKGROUND_COLOR, 1);
  renderer.clear();
  renderer.render(scene, camera);

  // ── Read pixels ───────────────────────────────────────────────────────────
  const buffer = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, buffer);

  // ── Restore renderer state ────────────────────────────────────────────────
  renderer.setRenderTarget(prevTarget);
  renderer.localClippingEnabled = prevLocalClipping;
  renderer.clippingPlanes = prevPlanes;
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  target.dispose();

  // ── Flip Y and convert to data URL ────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(W, H);
  for (let row = 0; row < H; row++) {
    const srcRow = H - 1 - row; // flip
    imageData.data.set(buffer.slice(srcRow * W * 4, (srcRow + 1) * W * 4), row * W * 4);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
};

/**
 * Composite three elevation images into a single wing sheet (unfolded paper).
 * Panel widths are proportional to their real-world widths so scale is uniform.
 *
 * @param panels       Three data-URLs: [left panel, center panel, right panel]
 * @param labels       Three short label strings shown at the top of each panel
 * @param mirrors      Whether to horizontally flip each panel
 * @param worldWidths  Real-world widths [left, center, right] — used to compute proportional pixel widths
 */
const composeWing = (
  panels: [string, string, string],
  labels: [string, string, string],
  mirrors: [boolean, boolean, boolean],
  worldWidths: [number, number, number],
): Promise<string> => {
  return new Promise((resolve) => {
    const NUM = 3;
    const totalWorld = worldWidths[0] + worldWidths[1] + worldWidths[2];
    const panelWidths = worldWidths.map((w) => Math.round((w / totalWorld) * CAPTURE_W));
    // Scale each panel's height to preserve the source aspect ratio (CAPTURE_W x CAPTURE_H)
    const panelHeights = panelWidths.map((pw) => Math.round((pw / CAPTURE_W) * CAPTURE_H));
    const FULL_W = panelWidths[0] + panelWidths[1] + panelWidths[2];
    const FULL_H = Math.max(...panelHeights);

    const canvas = document.createElement("canvas");
    canvas.width = FULL_W;
    canvas.height = FULL_H;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, FULL_W, FULL_H);

    let loaded = 0;
    const done = () => {
      loaded++;
      if (loaded < NUM) return;

      // Small label strip at the top of each panel — no dividing lines
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillRect(0, 0, FULL_W, 30);
      ctx.fillStyle = "#222";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      let labelX = 0;
      for (let i = 0; i < NUM; i++) {
        ctx.fillText(labels[i], labelX + panelWidths[i] / 2, 20);
        labelX += panelWidths[i];
      }

      resolve(canvas.toDataURL("image/png"));
    };

    let dstX = 0;
    panels.forEach((dataUrl, i) => {
      const img = new Image();
      const x = dstX;
      const pw = panelWidths[i];
      const ph = panelHeights[i];
      img.onload = () => {
        const yOffset = (FULL_H - ph) / 2;
        ctx.save();
        if (mirrors[i]) {
          ctx.translate(x + pw, yOffset);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, pw, ph);
        } else {
          ctx.drawImage(img, x, yOffset, pw, ph);
        }
        ctx.restore();
        done();
      };
      img.src = dataUrl;
      dstX += pw;
    });
  });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function SketchViewer({ worldRef, fragmentsRef, markersRef }: SketchViewerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [viewsData, setViewsData] = useState<SketchViewsData>({
    top: null,
    bottom: null,
    front: null,
    back: null,
    leftWing: null,
    rightWing: null,

    leftFrontCrop: null,
    leftBackCrop: null,
    rightFrontCrop: null,
    rightBackCrop: null,
    leftSideView: null,
    rightSideView: null,
  });
  const wingParamsRef = useRef<WingComposeParams | null>(null);

  const generate = useCallback(async () => {
    const world = worldRef.current;
    if (!world?.renderer) return;

    setIsGenerating(true);
    try {
      const renderer = world.renderer.three;
      const scene = world.scene.three;

      const box = computeSceneBounds(scene);
      if (box.isEmpty()) {
        console.warn("SketchViewer: bounding box is empty – is the model loaded?");
        return;
      }

      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      console.log("Scene bounds:", { box, size, center });
      const markers = markersRef.current;

      const UPPER_LOWER_BORDER_Y = 0
      
      // Helper: capture a view and build a ViewData (base + overlaid)
      const makeViewData = async (
        cam: THREE.OrthographicCamera,
        planes: THREE.Plane[],
      ): Promise<ViewData> => {
        const baseImageUrl = captureView(renderer, scene, cam, planes);
        const imageUrl = await overlayMarkers(baseImageUrl, cam, markers, planes);
        return { baseImageUrl, imageUrl, camera: cam, clippingPlanes: planes };
      };

      // ── 1. Draufsicht (Top View) ────────────────────────────────────────
      const topCam = makeOrthoCamera(box, "top");
      const topPlanes = [
        new THREE.Plane(new THREE.Vector3(0, 1, 0), UPPER_LOWER_BORDER_Y)
      ];
      const topVD = await makeViewData(topCam, topPlanes);

      // ── 2. Untersicht (Bottom View) ────────────────────────────
      const bottomCam = makeOrthoCamera(box, "bottom");
      const bottomPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), UPPER_LOWER_BORDER_Y)];
      const bottomVD = await makeViewData(bottomCam, bottomPlanes);

      // ── 3. Full abutment face views (no lateral clipping) ───────────────
      const frontCam = makeOrthoCamera(box, "front");
      const backCam = makeOrthoCamera(box, "back");
      const frontVD = await makeViewData(frontCam, []);
      const backVD = await makeViewData(backCam, []);

      // ── 4. Wing views — unfolded paperwork sheets ──────────────────────
      const wingOffset = 4;
      const leftBoundary = center.x + wingOffset;
      const rightBoundary = center.x - wingOffset;

      const leftClipAbutmentStart = new THREE.Plane(new THREE.Vector3(-1, 0, 0), center.x);
      const rightClipAbutmentStart = new THREE.Plane(new THREE.Vector3(1, 0, 0), -center.x);

      const leftClip = new THREE.Plane(new THREE.Vector3(1, 0, 0), -leftBoundary);
      const rightClip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), rightBoundary);

      const leftClipBox = new THREE.Box3(
        new THREE.Vector3(leftBoundary, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      );
      const rightClipBox = new THREE.Box3(
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(rightBoundary, box.max.y, box.max.z),
      );

      const leftWingWidth = box.max.x - leftBoundary;
      const rightWingWidth = rightBoundary - box.min.x;
      const abutmentDepth = size.z;

      const sharedHalfH = size.y / 2;

      const leftCam = makeOrthoCamera(box, "left");
      const rightCam = makeOrthoCamera(box, "right");

      const leftFrontCropCam = makeWingCropCamera(box, leftClipBox, "front", sharedHalfH);
      const leftBackCropCam = makeWingCropCamera(box, leftClipBox, "back", sharedHalfH);
      const rightFrontCropCam = makeWingCropCamera(box, rightClipBox, "front", sharedHalfH);
      const rightBackCropCam = makeWingCropCamera(box, rightClipBox, "back", sharedHalfH);

      const frontZClip = new THREE.Plane(new THREE.Vector3(0, 0, 1), -center.z);
      const backZClip = new THREE.Plane(new THREE.Vector3(0, 0, -1), center.z);

      const leftFrontCropVD = await makeViewData(leftFrontCropCam, [leftClip, frontZClip]);
      const leftBackCropVD = await makeViewData(leftBackCropCam, [leftClip, backZClip]);
      const rightFrontCropVD = await makeViewData(rightFrontCropCam, [rightClip, frontZClip]);
      const rightBackCropVD = await makeViewData(rightBackCropCam, [rightClip, backZClip]);

      const leftAbutmentEndClip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), leftBoundary);
      const rightAbutmentEndClip = new THREE.Plane(new THREE.Vector3(1, 0, 0), -rightBoundary);

      const rightSideViewPlanes = [leftClipAbutmentStart, bottomPlanes[0], rightAbutmentEndClip];
      const rightSideVD = await makeViewData(rightCam, rightSideViewPlanes);

      const leftSideViewPlanes = [rightClipAbutmentStart, bottomPlanes[0], leftAbutmentEndClip];
      const leftSideVD = await makeViewData(leftCam, leftSideViewPlanes);

      // Store wing composition params for refreshMarkerOverlays
      wingParamsRef.current = {
        leftPanels: ["leftBackCrop", "leftSideView", "leftFrontCrop"],
        leftLabels: ["Flügel vorne (links)", "Widerlager links", "Flügel hinten (links)"],
        leftMirrors: [false, false, false],
        leftWidths: [leftWingWidth, abutmentDepth, leftWingWidth],
        rightPanels: ["rightFrontCrop", "rightSideView", "rightBackCrop"],
        rightLabels: ["Flügel hinten (rechts)", "Widerlager rechts", "Flügel vorne (rechts)"],
        rightMirrors: [false, false, false],
        rightWidths: [rightWingWidth, abutmentDepth, rightWingWidth],
      };

      // Compose wing sheets from overlaid individual panels
      const leftWingDataUrl = await composeWing(
        [leftBackCropVD.imageUrl, leftSideVD.imageUrl, leftFrontCropVD.imageUrl],
        wingParamsRef.current.leftLabels,
        wingParamsRef.current.leftMirrors,
        wingParamsRef.current.leftWidths,
      );
      const rightWingDataUrl = await composeWing(
        [rightFrontCropVD.imageUrl, rightSideVD.imageUrl, rightBackCropVD.imageUrl],
        wingParamsRef.current.rightLabels,
        wingParamsRef.current.rightMirrors,
        wingParamsRef.current.rightWidths,
      );

      setViewsData({
        top: topVD,
        bottom: bottomVD,
        front: frontVD,
        back: backVD,
        leftWing: leftWingDataUrl,
        rightWing: rightWingDataUrl,
        leftFrontCrop: leftFrontCropVD,
        leftBackCrop: leftBackCropVD,
        rightFrontCrop: rightFrontCropVD,
        rightBackCrop: rightBackCropVD,
        leftSideView: leftSideVD,
        rightSideView: rightSideVD,
      });
    } finally {
      setIsGenerating(false);
    }
  }, [worldRef, markersRef]);

  // ── Re-overlay markers on cached base images (fast, no WebGL re-render) ──
  const refreshMarkerOverlays = useCallback(async () => {
    setViewsData((prev) => {
      // Kick off async overlay work, then update state when done
      (async () => {
        const markers = markersRef.current;
        const clickableKeys: ClickableKey[] = [
          "top", "bottom", "front", "back",
          "leftFrontCrop", "leftBackCrop", "rightFrontCrop", "rightBackCrop",
          "leftSideView", "rightSideView",
        ];

        const updated: Partial<SketchViewsData> = {};
        for (const key of clickableKeys) {
          const vd = prev[key] as ViewData | null;
          if (!vd) continue;
          const imageUrl = await overlayMarkers(
            vd.baseImageUrl, vd.camera, markers, vd.clippingPlanes,
          );
          updated[key] = { ...vd, imageUrl } as ViewData;
        }

        // Recomposite wing sheets
        const wp = wingParamsRef.current;
        let leftWing = prev.leftWing;
        let rightWing = prev.rightWing;
        if (wp) {
          const getImg = (key: ClickableKey) =>
            (updated[key] as ViewData | undefined)?.imageUrl
            ?? (prev[key] as ViewData | null)?.imageUrl
            ?? "";
          leftWing = await composeWing(
            [getImg(wp.leftPanels[0]), getImg(wp.leftPanels[1]), getImg(wp.leftPanels[2])],
            wp.leftLabels, wp.leftMirrors, wp.leftWidths,
          );
          rightWing = await composeWing(
            [getImg(wp.rightPanels[0]), getImg(wp.rightPanels[1]), getImg(wp.rightPanels[2])],
            wp.rightLabels, wp.rightMirrors, wp.rightWidths,
          );
        }

        setViewsData((curr) => ({
          ...curr,
          ...updated,
          leftWing,
          rightWing,
        }));
      })();

      return prev; // return unchanged for now; async callback will update later
    });
  }, [markersRef]);

  // ── Click on a 2D sketch image → place marker in 3D ─────────────────────
  const handleSketchClick = useCallback(async (
    event: React.MouseEvent<HTMLImageElement>,
    vd: ViewData,
  ) => {
    const world = worldRef.current;
    const fragments = fragmentsRef.current;
    if (!world?.renderer || !fragments) return;
    const scene = world.scene.three;
    const dom = world.renderer.three.domElement;

    const imgEl = event.currentTarget;
    const imgRect = imgEl.getBoundingClientRect();

    // Map display pixel → NDC in the view's orthographic camera space
    const ndcX = ((event.clientX - imgRect.left) / imgRect.width) * 2 - 1;
    const ndcY = -(((event.clientY - imgRect.top) / imgRect.height) * 2 - 1);

    // The OBC fragment raycast API expects clientX/clientY screen coords + canvas DOM.
    // It internally converts: ndc = ((clientX - rect.left) / rect.width) * 2 - 1, etc.
    // So we reverse that to produce fake clientX/clientY that yield our desired NDC.
    const canvasRect = dom.getBoundingClientRect();
    const fakeClientX = canvasRect.left + ((ndcX + 1) / 2) * canvasRect.width;
    const fakeClientY = canvasRect.top + ((1 - ndcY) / 2) * canvasRect.height;
    const fakeMouse = new THREE.Vector2(fakeClientX, fakeClientY);

    // For raycasting, reposition the camera just outside the clipping region.
    // The OBC raycast returns only the CLOSEST hit. If the camera is far away
    // and geometry outside the clipping region is between the camera and the
    // subject, that geometry "blocks" the ray. By advancing the camera along
    // its look direction past any clipping planes it sits on the rejected side
    // of, the closest hit becomes one within the visible region.
    const rayCamera = vd.camera.clone();
    const lookDir = new THREE.Vector3();
    rayCamera.getWorldDirection(lookDir);
    if (vd.clippingPlanes.length > 0) {
      let maxShift = 0;
      for (const plane of vd.clippingPlanes) {
        const dist = plane.distanceToPoint(rayCamera.position);
        if (dist < 0) {
          // Camera is on the rejected side of this clipping plane.
          // Compute shift along look direction to cross the plane.
          const denom = plane.normal.dot(lookDir);
          if (Math.abs(denom) > 0.001) {
            const shift = -dist / denom;
            if (shift > maxShift) maxShift = shift;
          }
        }
      }
      if (maxShift > 0) {
        rayCamera.position.addScaledVector(lookDir, maxShift + 1);
        rayCamera.updateMatrixWorld(true);
      }
    }

    // Raycast against all fragment models using the repositioned camera
    const results: Array<{ distance: number; point: THREE.Vector3 }> = [];
    for (const [, model] of fragments.list) {
      const result = await (model as unknown as FragmentModelLike).raycast({
        camera: rayCamera,
        mouse: fakeMouse,
        dom,
      });
      if (result) results.push(result);
    }

    if (results.length === 0) return;

    // Pick closest hit
    const closest = results.reduce((a, b) => (a.distance < b.distance ? a : b));

    // Check clipping planes — reject if outside visible region
    for (const plane of vd.clippingPlanes) {
      if (plane.distanceToPoint(closest.point) < 0) return;
    }

    // Place marker
    const geo = new THREE.SphereGeometry(0.3, 16, 16);
    const mat = new THREE.MeshLambertMaterial({
      color: "#ff4444",
      transparent: true,
      opacity: 0.85,
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(closest.point);
    scene.add(sphere);
    markersRef.current.push(sphere);

    await refreshMarkerOverlays();
  }, [worldRef, fragmentsRef, markersRef, refreshMarkerOverlays]);

  const savePng = (dataUrl: string, fileName: string) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = fileName;
    a.click();
  };

  const VIEWS: { key: keyof SketchViewsData; label: string; file: string; clickable: boolean }[] = [
    { key: "top", label: "Draufsicht (Top View)", file: "draufsicht.png", clickable: true },
    { key: "bottom", label: "Untersicht (Bottom View)", file: "untersicht.png", clickable: true },
    { key: "front", label: "Stirnwand – Vorderseite (Front Face)", file: "stirnwand-vorne.png", clickable: true },
    { key: "back", label: "Stirnwand – Rückseite (Back Face)", file: "stirnwand-hinten.png", clickable: true },
    { key: "leftWing", label: "Linke Flügelwand – Abgewickelt (Left Wing Unfolded)", file: "fluegel-links.png", clickable: false },
    { key: "rightWing", label: "Rechte Flügelwand – Abgewickelt (Right Wing Unfolded)", file: "fluegel-rechts.png", clickable: false },
    { key: "leftFrontCrop", label: "Linke Flügelwand – Vorne (Left Wing Front Crop)", file: "fluegel-links-vorne.png", clickable: true },
    { key: "leftBackCrop", label: "Linke Flügelwand – Hinten (Left Wing Back Crop)", file: "fluegel-links-hinten.png", clickable: true },
    { key: "rightFrontCrop", label: "Rechte Flügelwand – Vorne (Right Wing Front Crop)", file: "fluegel-rechts-vorne.png", clickable: true },
    { key: "rightBackCrop", label: "Rechte Flügelwand – Hinten (Right Wing Back Crop)", file: "fluegel-rechts-hinten.png", clickable: true },
    { key: "leftSideView", label: "Linke Flügelwand – Seite (Left Wing Side View)", file: "fluegel-links-seite.png", clickable: true },
    { key: "rightSideView", label: "Rechte Flügelwand – Seite (Right Wing Side View)", file: "fluegel-rechts-seite.png", clickable: true },
  ];

  return (
    <>
      {/* ── Toolbar toggle button ─────────────────────────────────────────── */}
      <button
        className={`sketch-toggle-btn${isOpen ? " sketch-toggle-btn--active" : ""}`}
        title="Toggle 2D Sketch Views"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        📐 {isOpen ? "Sketches: ON" : "Sketches: OFF"}
      </button>

      {/* ── Side panel ───────────────────────────────────────────────────── */}
      <div className={`sketch-panel${isOpen ? " sketch-panel--open" : ""}`} aria-hidden={!isOpen}>
        <div className="sketch-panel-header">
          <span>2D Damage Sketches</span>
          <button
            className="sketch-panel-close"
            aria-label="Close sketch panel"
            onClick={() => setIsOpen(false)}
          >
            ✕
          </button>
        </div>

        <div className="sketch-panel-body">
          <p className="sketch-hint">
            Renders orthographic cross-sections from the loaded model using the main renderer. Make
            sure the model is fully loaded before generating. Click on any view (except wing sheets)
            to place a damage marker.
          </p>

          <button className="sketch-generate-btn" onClick={generate} disabled={isGenerating}>
            {isGenerating ? "⏳ Rendering views…" : "⚙ Generate All Views"}
          </button>

          {VIEWS.map(({ key, label, file, clickable }) => {
            const entry = viewsData[key];
            // For clickable views, entry is ViewData | null; for wing sheets, it's string | null
            const imgUrl = entry
              ? typeof entry === "string" ? entry : entry.imageUrl
              : null;
            const vd = clickable && entry && typeof entry !== "string" ? entry : null;
            return (
              <div key={key} className="sketch-section">
                <div className="sketch-section-header">
                  <span className="sketch-section-title">{label}</span>
                  {imgUrl && (
                    <button
                      className="sketch-save-btn"
                      onClick={() => savePng(imgUrl, file)}
                      title={`Save ${label} as PNG`}
                    >
                      💾 PNG
                    </button>
                  )}
                </div>
                <div className="sketch-image-container">
                  {imgUrl ? (
                    <img
                      src={imgUrl}
                      alt={label}
                      className="sketch-image"
                      style={vd ? { cursor: "crosshair" } : undefined}
                      onClick={vd ? (e) => handleSketchClick(e, vd) : undefined}
                    />
                  ) : (
                    <div className="sketch-placeholder">
                      {isGenerating ? "Rendering…" : "Click Generate to render this view"}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
