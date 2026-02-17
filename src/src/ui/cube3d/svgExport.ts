/**
 * SVG export for CUBE scene graphs.
 * Projects the 3D scene to 2D using isometric projection
 * and renders boxes, pipes, and labels as SVG elements.
 */
import type { SceneGraph, SceneNode, PipeInfo } from './layoutEngine';

// ---- Isometric projection ----
// Matches the default Three.js camera angle (45° around Y, ~35° tilt)

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

/** Project a 3D point to 2D isometric coordinates. */
function project(x: number, y: number, z: number): [number, number] {
  const px = (x - z) * COS30;
  const py = (x + z) * SIN30 - y;
  return [px, py];
}

/** Depth value for sorting (higher = further from camera). */
function depth(x: number, y: number, z: number): number {
  return x + z - y;
}

// ---- SVG helpers ----

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Generate a unique gradient ID from pipe ID. */
function gradientId(pipeId: string): string {
  return `grad-${pipeId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

// ---- Box face rendering ----

interface ProjectedFace {
  points: [number, number][];
  fill: string;
  stroke: string;
  opacity: number;
  depth: number;
}

/** Generate the 3 visible isometric faces of a box (top, left, right). */
function boxFaces(node: SceneNode): ProjectedFace[] {
  const [cx, cy, cz] = node.position;
  const [w, h, d] = node.size;
  const hw = w / 2, hh = h / 2, hd = d / 2;

  // 8 corners
  const corners = [
    [cx - hw, cy - hh, cz - hd], // 0: bottom-left-front
    [cx + hw, cy - hh, cz - hd], // 1: bottom-right-front
    [cx + hw, cy - hh, cz + hd], // 2: bottom-right-back
    [cx - hw, cy - hh, cz + hd], // 3: bottom-left-back
    [cx - hw, cy + hh, cz - hd], // 4: top-left-front
    [cx + hw, cy + hh, cz - hd], // 5: top-right-front
    [cx + hw, cy + hh, cz + hd], // 6: top-right-back
    [cx - hw, cy + hh, cz + hd], // 7: top-left-back
  ] as const;

  const p = (i: number) => project(corners[i][0], corners[i][1], corners[i][2]);
  const d3 = (i: number) => depth(corners[i][0], corners[i][1], corners[i][2]);

  const baseColor = node.color;
  const opacity = node.transparent ? node.opacity : 1.0;

  // Darken/lighten for 3D shading
  const topColor = baseColor;
  const leftColor = shadeColor(baseColor, -0.25);
  const rightColor = shadeColor(baseColor, -0.15);

  const faces: ProjectedFace[] = [];

  // Top face (4,5,6,7)
  faces.push({
    points: [p(4), p(5), p(6), p(7)],
    fill: topColor,
    stroke: shadeColor(baseColor, -0.3),
    opacity,
    depth: (d3(4) + d3(5) + d3(6) + d3(7)) / 4,
  });

  // Left face (0,4,7,3) — visible from left
  faces.push({
    points: [p(0), p(4), p(7), p(3)],
    fill: leftColor,
    stroke: shadeColor(baseColor, -0.3),
    opacity,
    depth: (d3(0) + d3(4) + d3(7) + d3(3)) / 4,
  });

  // Right face (1,5,4,0) — visible from front
  faces.push({
    points: [p(1), p(5), p(4), p(0)],
    fill: rightColor,
    stroke: shadeColor(baseColor, -0.3),
    opacity,
    depth: (d3(1) + d3(5) + d3(4) + d3(0)) / 4,
  });

  return faces;
}

/** Lighten (positive) or darken (negative) a hex color. */
function shadeColor(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  if (factor > 0) {
    return '#' + [r, g, b].map(c => clamp(c + (255 - c) * factor).toString(16).padStart(2, '0')).join('');
  }
  return '#' + [r, g, b].map(c => clamp(c * (1 + factor)).toString(16).padStart(2, '0')).join('');
}

// ---- Pipe rendering ----

interface ProjectedPipe {
  from: [number, number];
  to: [number, number];
  control: [number, number];
  fromColor: string;
  toColor: string;
  id: string;
  depth: number;
}

function projectPipe(pipe: PipeInfo): ProjectedPipe {
  const [fx, fy, fz] = pipe.from;
  const [tx, ty, tz] = pipe.to;
  // Midpoint with upward curve (matching Three.js Pipe component)
  const mx = (fx + tx) / 2;
  const my = (fy + ty) / 2 + 0.3;
  const mz = (fz + tz) / 2;

  return {
    from: project(fx, fy, fz),
    to: project(tx, ty, tz),
    control: project(mx, my, mz),
    fromColor: pipe.fromColor,
    toColor: pipe.toColor,
    id: pipe.id,
    depth: (depth(fx, fy, fz) + depth(tx, ty, tz)) / 2,
  };
}

// ---- Label rendering ----

interface ProjectedLabel {
  pos: [number, number];
  text: string;
  color: string;
  fontSize: number;
  depth: number;
}

function projectLabel(node: SceneNode): ProjectedLabel | null {
  if (!node.label) return null;
  const [x, y, z] = node.position;
  const halfH = node.size[1] / 2;
  // Label above the top face
  const labelY = y + halfH + 0.15;
  return {
    pos: project(x, labelY, z),
    text: node.label,
    color: '#ffffff',
    fontSize: node.type === 'definition' || node.type === 'type_definition' ? 10 : 8,
    depth: depth(x, labelY, z) - 0.01, // slightly in front
  };
}

// ---- Main export ----

/** Scale factor from world units to SVG pixels. */
const SCALE = 40;
const PADDING = 20;

export function sceneGraphToSVG(sceneGraph: SceneGraph): string {
  if (sceneGraph.nodes.length === 0) return '';

  // Collect all projected elements with depth
  const faces: (ProjectedFace & { nodeId: string })[] = [];
  const pipes: ProjectedPipe[] = [];
  const labels: ProjectedLabel[] = [];

  // Only render root and top-level nodes (skip deeply nested children for clarity)
  for (const node of sceneGraph.nodes) {
    for (const face of boxFaces(node)) {
      faces.push({ ...face, nodeId: node.id });
    }
    const label = projectLabel(node);
    if (label) labels.push(label);
  }

  for (const pipe of sceneGraph.pipes) {
    pipes.push(projectPipe(pipe));
  }

  // Compute bounding box of all projected points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const updateBounds = (px: number, py: number) => {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  };

  for (const face of faces) {
    for (const [px, py] of face.points) {
      updateBounds(px * SCALE, py * SCALE);
    }
  }
  for (const pipe of pipes) {
    updateBounds(pipe.from[0] * SCALE, pipe.from[1] * SCALE);
    updateBounds(pipe.to[0] * SCALE, pipe.to[1] * SCALE);
    updateBounds(pipe.control[0] * SCALE, pipe.control[1] * SCALE);
  }
  for (const label of labels) {
    updateBounds(label.pos[0] * SCALE, label.pos[1] * SCALE);
  }

  if (!isFinite(minX)) return '';

  const vbX = minX - PADDING;
  const vbY = minY - PADDING;
  const vbW = maxX - minX + PADDING * 2;
  const vbH = maxY - minY + PADDING * 2;

  // Sort all elements by depth (back to front)
  type Element = { type: 'face'; data: ProjectedFace & { nodeId: string }; depth: number }
    | { type: 'pipe'; data: ProjectedPipe; depth: number }
    | { type: 'label'; data: ProjectedLabel; depth: number };

  const elements: Element[] = [
    ...faces.map(f => ({ type: 'face' as const, data: f, depth: f.depth })),
    ...pipes.map(p => ({ type: 'pipe' as const, data: p, depth: p.depth })),
    ...labels.map(l => ({ type: 'label' as const, data: l, depth: l.depth })),
  ];
  elements.sort((a, b) => b.depth - a.depth);

  // Build SVG
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" style="width:100%;height:100%;background:#1a1a2e">`);

  // Gradient definitions for pipes
  const gradDefs: string[] = [];
  for (const pipe of pipes) {
    const gid = gradientId(pipe.id);
    gradDefs.push(
      `<linearGradient id="${gid}" x1="${(pipe.from[0] * SCALE).toFixed(1)}" y1="${(pipe.from[1] * SCALE).toFixed(1)}" x2="${(pipe.to[0] * SCALE).toFixed(1)}" y2="${(pipe.to[1] * SCALE).toFixed(1)}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0%" stop-color="${pipe.fromColor}"/>` +
      `<stop offset="100%" stop-color="${pipe.toColor}"/>` +
      `</linearGradient>`
    );
  }
  if (gradDefs.length > 0) {
    parts.push(`<defs>${gradDefs.join('')}</defs>`);
  }

  // Render elements in depth order
  for (const el of elements) {
    switch (el.type) {
      case 'face': {
        const f = el.data;
        const pts = f.points.map(([px, py]) => `${(px * SCALE).toFixed(1)},${(py * SCALE).toFixed(1)}`).join(' ');
        parts.push(`<polygon points="${pts}" fill="${f.fill}" stroke="${f.stroke}" stroke-width="0.5" opacity="${f.opacity.toFixed(2)}"/>`);
        break;
      }
      case 'pipe': {
        const p = el.data;
        const gid = gradientId(p.id);
        parts.push(
          `<path d="M${(p.from[0] * SCALE).toFixed(1)},${(p.from[1] * SCALE).toFixed(1)} ` +
          `Q${(p.control[0] * SCALE).toFixed(1)},${(p.control[1] * SCALE).toFixed(1)} ` +
          `${(p.to[0] * SCALE).toFixed(1)},${(p.to[1] * SCALE).toFixed(1)}" ` +
          `fill="none" stroke="url(#${gid})" stroke-width="2" stroke-linecap="round"/>`
        );
        break;
      }
      case 'label': {
        const l = el.data;
        parts.push(
          `<text x="${(l.pos[0] * SCALE).toFixed(1)}" y="${(l.pos[1] * SCALE).toFixed(1)}" ` +
          `fill="${l.color}" font-family="monospace" font-size="${l.fontSize}" ` +
          `text-anchor="middle" dominant-baseline="auto">${escapeXml(l.text)}</text>`
        );
        break;
      }
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}
