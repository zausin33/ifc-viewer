import { useState, useCallback } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { WorldLike } from "./MarkerSystem";

// ─── Constants ───────────────────────────────────────────────────────────────

const CAPTURE_W = 1200;
const CAPTURE_H = 800;
const BACKGROUND_COLOR = new THREE.Color(0xfafafa);

// ─── Types ───────────────────────────────────────────────────────────────────

interface SketchImages {
  top: string | null;
  bottom: string | null;
  front: string | null;
  back: string | null;
  leftWing: string | null;
  rightWing: string | null;
}

export interface SketchViewerProps {
  worldRef: MutableRefObject<WorldLike | null>;
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
  const MARGIN = 1.08;

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
 * Composite three elevation images seamlessly into a single wing sheet,
 * like an unfolded paper drawing — no separator lines between panels.
 *
 *  Left wing:  [front-face left-crop] · [left side view, mirrored] · [back-face left-crop]
 *  Right wing: [back-face right-crop] · [right side view, mirrored] · [front-face right-crop]
 *
 * The side view is always mirrored so the fold edge (where it adjoins the
 * abutment face crop) falls on the correct side of the panel.
 *
 * @param panels   Three data-URLs: [left panel, center panel, right panel]
 * @param labels   Three short label strings shown at the top of each panel
 * @param mirrors  Whether to horizontally flip each panel [left, center, right]
 */
const composeWing = (
  panels: [string, string, string],
  labels: [string, string, string],
  mirrors: [boolean, boolean, boolean],
): Promise<string> => {
  return new Promise((resolve) => {
    const NUM = 3;
    const PANEL_W = Math.round(CAPTURE_W / NUM);
    const H = CAPTURE_H;
    const FULL_W = PANEL_W * NUM;

    const canvas = document.createElement("canvas");
    canvas.width = FULL_W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, FULL_W, H);

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
      for (let i = 0; i < NUM; i++) {
        ctx.fillText(labels[i], PANEL_W * i + PANEL_W / 2, 20);
      }

      resolve(canvas.toDataURL("image/png"));
    };

    panels.forEach((dataUrl, i) => {
      const img = new Image();
      const dstX = PANEL_W * i;
      img.onload = () => {
        ctx.save();
        if (mirrors[i]) {
          ctx.translate(dstX + PANEL_W, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, PANEL_W, H);
        } else {
          ctx.drawImage(img, dstX, 0, PANEL_W, H);
        }
        ctx.restore();
        done();
      };
      img.src = dataUrl;
    });
  });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function SketchViewer({ worldRef }: SketchViewerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [images, setImages] = useState<SketchImages>({
    top: null,
    bottom: null,
    front: null,
    back: null,
    leftWing: null,
    rightWing: null,
  });

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
      // ── 1. Draufsicht (Top View) ────────────────────────────────────────
      // Camera looks straight down; clip at 80% height to show the cross-section
      const topCam = makeOrthoCamera(box, "top");
      const topClipY = box.min.y + size.y * 0.8;
      const topPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), topClipY);
      const topDataUrl = captureView(renderer, scene, topCam, [topPlane]);

      // ── 2. Untersicht (Bottom View) ────────────────────────────
      // Camera looks straight up; clip at 25% height to reveal the Bottom
      const bottomCam = makeOrthoCamera(box, "bottom");
      const bottomClipY = box.min.y + size.y * 0.25;
      const bottomPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -bottomClipY);
      const bottomDataUrl = captureView(renderer, scene, bottomCam, [bottomPlane]);

      // ── 3. Full abutment face views (no lateral clipping) ───────────────
      const frontCam = makeOrthoCamera(box, "front");
      const backCam = makeOrthoCamera(box, "back");
      const frontDataUrl = captureView(renderer, scene, frontCam, []);
      const backDataUrl = captureView(renderer, scene, backCam, []);

      // ── 4. Wing views — unfolded paperwork sheets ──────────────────────
      // Each sheet is 3 panels composited seamlessly (no divider lines):
      //
      //   Left wing:  [front-face left-crop] · [left side, mirrored] · [back-face left-crop]
      //   Right wing: [back-face right-crop] · [right side, mirrored] · [front-face right-crop]
      //
      // Mirroring the side view ensures the fold geometry is continuous at
      // both seams (front-face and back-face neighbours).
      //
      // X clip: ±30 % of full span → excludes the hollow abutment interior.
      const wingHalfX = -4;
      const leftBoundary = center.x - wingHalfX; // keeps x ≤ this value
      const rightBoundary = center.x + wingHalfX; // keeps x ≥ this value

      const leftClip = new THREE.Plane(new THREE.Vector3(1, 0, 0), -leftBoundary);
      const rightClip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), rightBoundary);

      const leftCam = makeOrthoCamera(box, "left");
      const rightCam = makeOrthoCamera(box, "right");

      // Abutment face crops (only wing region visible)
      const leftFrontCrop = captureView(renderer, scene, frontCam, [leftClip]);
      const leftBackCrop = captureView(renderer, scene, backCam, [leftClip]);
      const rightFrontCrop = captureView(renderer, scene, frontCam, [rightClip]);
      const rightBackCrop = captureView(renderer, scene, backCam, [rightClip]);

      // Side end-face views (only wing region visible)
      const leftSideView = captureView(renderer, scene, leftCam, [leftClip]);
      const rightSideView = captureView(renderer, scene, rightCam, [rightClip]);

      // Left wing sheet
      // Panel order:  front-crop (no mirror) · left-side (mirrored) · back-crop (no mirror)
      // Why mirror side: left-cam looks in +X → front(+Z) is on screen-RIGHT;
      // mirroring puts front on screen-LEFT so it adjoins the right edge of the
      // front-crop, and back on screen-RIGHT to adjoin the left edge of the back-crop.
      const leftWingDataUrl = await composeWing(
        [leftFrontCrop, leftSideView, leftBackCrop],
        ["Stirnwand vorne (links)", "Flügelwand links", "Stirnwand hinten (links)"],
        [true, true, true],
      );

      // Right wing sheet
      // Panel order:  back-crop (no mirror) · right-side (mirrored) · front-crop (no mirror)
      // Why mirror side: right-cam looks in -X → back(-Z) is on screen-RIGHT;
      // mirroring puts back on screen-LEFT so it adjoins the right edge of the
      // back-crop, and front on screen-RIGHT to adjoin the left edge of the front-crop.
      const rightWingDataUrl = await composeWing(
        [rightBackCrop, rightSideView, rightFrontCrop],
        ["Stirnwand hinten (rechts)", "Flügelwand rechts", "Stirnwand vorne (rechts)"],
        [true, true, true],
      );

      setImages({
        top: topDataUrl,
        bottom: bottomDataUrl,
        front: frontDataUrl,
        back: backDataUrl,
        leftWing: leftWingDataUrl,
        rightWing: rightWingDataUrl,
      });
    } finally {
      setIsGenerating(false);
    }
  }, [worldRef]);

  const savePng = (dataUrl: string, fileName: string) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = fileName;
    a.click();
  };

  const VIEWS = [
    { key: "top" as const, label: "Draufsicht (Top View)", file: "draufsicht.png" },
    { key: "bottom" as const, label: "Untersicht (Bottom View)", file: "untersicht.png" },
    {
      key: "front" as const,
      label: "Stirnwand – Vorderseite (Front Face)",
      file: "stirnwand-vorne.png",
    },
    {
      key: "back" as const,
      label: "Stirnwand – Rückseite (Back Face)",
      file: "stirnwand-hinten.png",
    },
    {
      key: "leftWing" as const,
      label: "Linke Flügelwand – Abgewickelt (Left Wing Unfolded)",
      file: "fluegel-links.png",
    },
    {
      key: "rightWing" as const,
      label: "Rechte Flügelwand – Abgewickelt (Right Wing Unfolded)",
      file: "fluegel-rechts.png",
    },
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
            sure the model is fully loaded before generating.
          </p>

          <button className="sketch-generate-btn" onClick={generate} disabled={isGenerating}>
            {isGenerating ? "⏳ Rendering views…" : "⚙ Generate All Views"}
          </button>

          {VIEWS.map(({ key, label, file }) => {
            const img = images[key];
            return (
              <div key={key} className="sketch-section">
                <div className="sketch-section-header">
                  <span className="sketch-section-title">{label}</span>
                  {img && (
                    <button
                      className="sketch-save-btn"
                      onClick={() => savePng(img, file)}
                      title={`Save ${label} as PNG`}
                    >
                      💾 PNG
                    </button>
                  )}
                </div>
                <div className="sketch-image-container">
                  {img ? (
                    <img src={img} alt={label} className="sketch-image" />
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
