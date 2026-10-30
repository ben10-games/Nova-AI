import "server-only";

/**
 * Scene specs for Blender builds.
 *
 * The model decides WHAT goes in the scene: objects with real-world sizes,
 * materials, and how objects relate ("coffee table in front of the sofa").
 * This module decides WHERE, deterministically: a layout solver turns the
 * relations into explicit, non-overlapping positions; the floor is fitted
 * under everything; lights and camera are placed from the scene bounds and
 * the camera is framed. The result compiles into exact Blender tool calls.
 *
 * Conventions: 1 Blender unit = 1 metre, Z up, floor at z = 0,
 * "front" = -Y (towards the default camera), "right" = +X.
 */

export type Vec3 = [number, number, number];
export type Shape = "box" | "sphere" | "cylinder" | "cone" | "plane";
export type Relation = "anchor" | "in_front_of" | "behind" | "left_of" | "right_of" | "on_top_of" | "floor_under_all";
export type LightRole = "key" | "fill" | "rim" | "sun";
export type CameraView = "front" | "front_left" | "front_right" | "top";

export type SpecObject = {
  id: string;
  name: string;
  purpose: string;
  shape: Shape;
  /** Size in metres along x (width), y (depth), z (height). */
  size: Vec3;
  material: string;
  relation: Relation;
  /** The object this one is placed relative to (not used by anchor / floor_under_all). */
  reference: string;
  /** Clear gap to the reference in metres (side relations). */
  gap_m: number;
  rotation_z_deg: number;
};

export type SpecMaterial = { id: string; name: string; color: Vec3; metallic: number; roughness: number };
export type SpecLight = { role: LightRole; energy: number; color: Vec3 };
export type SceneSpec = {
  theme: string;
  objects: SpecObject[];
  materials: SpecMaterial[];
  lights: SpecLight[];
  camera: { view: CameraView; lens_mm: number };
};

/** An object already in the scene, approximated by an axis-aligned box. */
export type Obstacle = { name: string; center: Vec3; size: Vec3 };

export const SHAPE_TO_PRIMITIVE: Record<Shape, string> = { box: "cube", sphere: "uv_sphere", cylinder: "cylinder", cone: "cone", plane: "plane" };
/** Real dimensions of each primitive created with size = 1 (measured in Blender 5.2). */
const BASE_DIMS: Record<Shape, Vec3> = { box: [1, 1, 1], sphere: [1, 1, 1], cylinder: [1, 1, 2], cone: [1, 1, 2], plane: [1, 1, 0] };

const RELATIONS: Relation[] = ["anchor", "in_front_of", "behind", "left_of", "right_of", "on_top_of", "floor_under_all"];
const MAX_OBJECTS = 12;
const FLAT = 0.02; // thinner than this: rugs / planes, may be overlapped
const TOUCH = 0.01; // 1 cm tolerance for touching surfaces
const FLOOR_MARGIN = 0.75; // floor extends this far beyond the furniture
const RENDER_ASPECT = 9 / 16;

// ---------------------------------------------------------------------------
// JSON schema the model must follow (enforced by structured output)
// ---------------------------------------------------------------------------

const num = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const vec3 = (minimum: number, maximum: number) => ({ type: "array", items: num(minimum, maximum), minItems: 3, maxItems: 3 });
const id = { type: "string" }; // format checked in checkStructure (some providers' grammars lack regex support)

export const SCENE_SPEC_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string" },
    objects: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBJECTS,
      items: {
        type: "object",
        properties: {
          id,
          name: { type: "string" },
          purpose: { type: "string" },
          shape: { type: "string", enum: ["box", "sphere", "cylinder", "cone", "plane"] },
          size: vec3(0, 50),
          material: { type: "string" },
          relation: { type: "string", enum: RELATIONS },
          reference: { type: "string" },
          gap_m: num(0, 5),
          rotation_z_deg: num(-360, 360),
        },
        required: ["id", "name", "purpose", "shape", "size", "material", "relation", "reference", "gap_m", "rotation_z_deg"],
      },
    },
    materials: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: { id, name: { type: "string" }, color: vec3(0, 1), metallic: num(0, 1), roughness: num(0, 1) },
        required: ["id", "name", "color", "metallic", "roughness"],
      },
    },
    lights: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: { role: { type: "string", enum: ["key", "fill", "rim", "sun"] }, color: vec3(0, 1) },
        required: ["role", "color"],
      },
    },
    camera: {
      type: "object",
      properties: { view: { type: "string", enum: ["front", "front_left", "front_right", "top"] }, lens_mm: num(10, 200) },
      required: ["view", "lens_mm"],
    },
  },
  required: ["theme", "objects", "materials", "lights", "camera"],
};

// ---------------------------------------------------------------------------
// Normalization (unambiguous variants in how models write values)
// ---------------------------------------------------------------------------

const CAMERA_OR_LIGHT = /^(camera|cam|main[ _]?camera|light|lights|lighting|sun|sunlight|key[ _]?light|fill[ _]?light|rim[ _]?light|area[ _]?light|point[ _]?light|spot[ _]?light|soft[ _]?light)$/i;

export function normalizeSpec(raw: unknown): { raw: unknown; notes: string[] } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).objects)) return { raw, notes: [] };
  const r = raw as Record<string, unknown>;
  const notes: string[] = [];
  // Cameras and lights have their own fields; an object literally called "light"/"camera" is one of those.
  const objects = (r.objects as Record<string, unknown>[])
    .filter((o) => {
      const misplaced = CAMERA_OR_LIGHT.test(String(o.id ?? "")) || CAMERA_OR_LIGHT.test(String(o.name ?? ""));
      if (misplaced) notes.push(`Removed "${String(o.id ?? o.name)}" from the objects: lights and the camera are set up separately.`);
      return !misplaced;
    })
    .map((o) => ({ ...o }));
  const ids = new Set(objects.map((o) => o.id));
  const byName = new Map(objects.map((o) => [String(o.name ?? "").trim().toLowerCase(), o.id]));
  for (const o of objects) {
    if (typeof o.reference === "string" && o.reference && !ids.has(o.reference) && byName.has(o.reference.trim().toLowerCase())) {
      o.reference = byName.get(o.reference.trim().toLowerCase());
    }
    if (o.gap_m === undefined || o.gap_m === null) o.gap_m = o.relation === "on_top_of" ? 0 : 0.3;
    if (o.rotation_z_deg === undefined || o.rotation_z_deg === null) o.rotation_z_deg = 0;
  }
  const unit = (color: unknown, where: string) => {
    if (Array.isArray(color) && color.length >= 3 && color.every((c) => typeof c === "number" && c >= 0 && c <= 255) && color.some((c) => (c as number) > 1)) {
      notes.push(`${where}: colour ${JSON.stringify(color)} read as 0-255 and converted to 0-1.`);
      return (color as number[]).slice(0, 3).map((c) => Math.round((c / 255) * 1000) / 1000);
    }
    return Array.isArray(color) ? color.slice(0, 3) : color;
  };
  const materials = Array.isArray(r.materials) ? (r.materials as Record<string, unknown>[]).map((m) => ({ ...m, color: unit(m.color, `Material "${String(m.id)}"`) })) : r.materials;
  const lights = Array.isArray(r.lights) ? (r.lights as Record<string, unknown>[]).map((l, i) => ({ ...l, color: unit(l.color, `Light ${i + 1}`) })) : r.lights;
  return { raw: { ...r, objects, materials, lights }, notes };
}

// ---------------------------------------------------------------------------
// Structure validation
// ---------------------------------------------------------------------------

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isVec = (v: unknown, n: number, lo: number, hi: number) => Array.isArray(v) && v.length === n && v.every((x) => isNum(x, lo, hi));
const cleanName = (s: unknown) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 40) : "");

/** Checks shape and references. Returns problems in plain language (empty = valid). */
export function checkStructure(raw: unknown): { spec: SceneSpec | null; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return { spec: null, problems: ["The spec is not a JSON object."] };
  const r = raw as Record<string, unknown>;
  const objects = Array.isArray(r.objects) ? (r.objects as Record<string, unknown>[]) : [];
  const materials = Array.isArray(r.materials) ? (r.materials as Record<string, unknown>[]) : [];
  const lights = Array.isArray(r.lights) ? (r.lights as Record<string, unknown>[]) : [];
  const cam = (r.camera ?? {}) as Record<string, unknown>;
  if (objects.length === 0) problems.push("The spec has no objects.");
  if (objects.length > MAX_OBJECTS) problems.push(`Too many objects (${objects.length}); use at most ${MAX_OBJECTS}. A small, polished scene is better.`);
  if (materials.length === 0) problems.push("The spec has no materials.");
  if (lights.length === 0) problems.push("The spec has no lights.");

  const matIds = new Set<string>();
  for (const m of materials) {
    if (typeof m.id !== "string" || !m.id) problems.push("A material has no id.");
    else if (matIds.has(m.id)) problems.push(`Material id "${m.id}" is used twice.`);
    else matIds.add(m.id);
    if (!isVec(m.color, 3, 0, 1)) problems.push(`Material "${String(m.id)}" needs color [r, g, b] with values 0-1.`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  let anchors = 0;
  let floors = 0;
  for (const o of objects) {
    const label = `Object "${String(o.id ?? o.name ?? "?")}"`;
    if (typeof o.id !== "string" || !/^[a-z][a-z0-9_]{0,23}$/.test(o.id)) problems.push(`${label} needs an id like "coffee_table".`);
    else if (ids.has(o.id)) problems.push(`Object id "${o.id}" is used twice.`);
    else ids.add(o.id);
    const name = cleanName(o.name);
    if (!name) problems.push(`${label} needs a name.`);
    else if (names.has(name.toLowerCase())) problems.push(`Object name "${name}" is used twice.`);
    else names.add(name.toLowerCase());
    if (typeof o.purpose !== "string" || o.purpose.trim().length < 3) problems.push(`${label} needs a purpose explaining why it is in the design.`);
    if (!(typeof o.shape === "string" && o.shape in SHAPE_TO_PRIMITIVE)) problems.push(`${label} has an unsupported shape; use box, sphere, cylinder, cone or plane.`);
    if (!isVec(o.size, 3, 0, 50)) problems.push(`${label} needs size [width, depth, height] in metres (0-50).`);
    else {
      const [w, d, h] = o.size as number[];
      if (w < 0.01 || d < 0.01) problems.push(`${label} is too small (width and depth must be at least 0.01 m).`);
      if (o.shape !== "plane" && h < 0.005) problems.push(`${label} needs a height of at least 0.005 m (only planes are flat).`);
    }
    if (typeof o.material !== "string" || !matIds.has(o.material)) problems.push(`${label} uses material "${String(o.material)}", which is not defined in materials.`);
    if (!RELATIONS.includes(o.relation as Relation)) problems.push(`${label} needs relation: one of ${RELATIONS.join(", ")}.`);
    if (o.relation === "anchor") anchors++;
    if (o.relation === "floor_under_all") floors++;
    if (!isNum(o.gap_m, 0, 5)) problems.push(`${label} needs gap_m between 0 and 5.`);
    if (!isNum(o.rotation_z_deg, -360, 360)) problems.push(`${label} needs rotation_z_deg between -360 and 360.`);
  }
  for (const o of objects) {
    if (o.relation === "anchor" || o.relation === "floor_under_all") continue;
    if (typeof o.reference !== "string" || !ids.has(o.reference)) problems.push(`Object "${String(o.id)}" is placed ${String(o.relation)} "${String(o.reference)}", which is not an object id.`);
    else if (o.reference === o.id) problems.push(`Object "${String(o.id)}" cannot be placed relative to itself.`);
  }
  if (anchors !== 1) problems.push(`Exactly one object must have relation "anchor" (the main piece, placed at the centre); found ${anchors}.`);
  if (floors > 1) problems.push(`Only one object can be "floor_under_all"; found ${floors}.`);
  lights.forEach((l, i) => {
    if (!["key", "fill", "rim", "sun"].includes(String(l.role))) problems.push(`Light ${i + 1} needs role key, fill, rim or sun.`);
    if (!isVec(l.color, 3, 0, 1)) problems.push(`Light ${i + 1} needs color [r, g, b] 0-1.`);
  });
  if (!["front", "front_left", "front_right", "top"].includes(String(cam.view)) || !isNum(cam.lens_mm, 10, 200)) {
    problems.push("The camera needs view (front, front_left, front_right or top) and lens_mm (10-200).");
  }
  if (problems.length) return { spec: null, problems };

  return {
    spec: {
      theme: String(r.theme ?? "").slice(0, 200),
      objects: objects.map((o) => ({
        id: o.id as string,
        name: cleanName(o.name),
        purpose: String(o.purpose).slice(0, 160),
        shape: o.shape as Shape,
        size: [...(o.size as number[])] as Vec3,
        material: o.material as string,
        relation: o.relation as Relation,
        reference: typeof o.reference === "string" ? o.reference : "",
        gap_m: o.gap_m as number,
        rotation_z_deg: o.rotation_z_deg as number,
      })),
      materials: materials.map((m) => ({
        id: m.id as string,
        name: cleanName(m.name) || (m.id as string),
        color: [...(m.color as number[])] as Vec3,
        metallic: isNum(m.metallic, 0, 1) ? m.metallic : 0,
        roughness: isNum(m.roughness, 0, 1) ? m.roughness : 0.5,
      })),
      // energy is only a hint: Syntaz sets exposure from the scene size (see rig()).
      lights: lights.map((l) => ({ role: l.role as LightRole, energy: isNum(l.energy, 0, 1e9) ? l.energy : 0, color: [...(l.color as number[])] as Vec3 })),
      camera: { view: cam.view as CameraView, lens_mm: cam.lens_mm as number },
    },
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export type Box = { min: Vec3; max: Vec3 };

/** World-space box of an object centred at `center`, rotated about Z. */
export function boxOf(center: Vec3, size: Vec3, rotZdeg: number): Box {
  const a = (rotZdeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const ex = (c * size[0] + s * size[1]) / 2;
  const ey = (s * size[0] + c * size[1]) / 2;
  const ez = size[2] / 2;
  return { min: [center[0] - ex, center[1] - ey, center[2] - ez], max: [center[0] + ex, center[1] + ey, center[2] + ez] };
}

const depth = (a: Box, b: Box, i: number) => Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]);
export const overlaps = (a: Box, b: Box) => depth(a, b, 0) > TOUCH && depth(a, b, 1) > TOUCH && depth(a, b, 2) > TOUCH;
const round = (v: number, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const fmt = (v: number[]) => `[${v.map((x) => round(x, 2)).join(", ")}]`;

export type Placed = SpecObject & { center: Vec3; box: Box; base: number };

const halfExtents = (o: SpecObject) => {
  const b = boxOf([0, 0, 0], o.size, o.rotation_z_deg);
  return [b.max[0], b.max[1]] as const;
};
export const isFloor = (o: SpecObject) => o.relation === "floor_under_all";
/** A floor slab (box) sits with its top at z = 0; a floor plane lies at z = 0. */
const floorBase = (o: SpecObject) => (o.shape === "plane" ? 0 : -o.size[2]);

/**
 * Layout solver: turns relations into explicit positions. Side relations are placed
 * just beyond the reference's edge plus the gap; if that still collides with something
 * already placed, the object is pushed further in the same direction.
 */
export function layout(spec: SceneSpec): { placed: Placed[]; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const byId = new Map(spec.objects.map((o) => [o.id, o]));
  const placed = new Map<string, Placed>();
  const order: SpecObject[] = [];
  const visiting = new Set<string>();
  const visit = (o: SpecObject) => {
    if (order.includes(o)) return;
    if (visiting.has(o.id)) {
      problems.push(`Objects are placed relative to each other in a loop (involving "${o.id}").`);
      return;
    }
    visiting.add(o.id);
    if (o.relation !== "anchor" && !isFloor(o)) {
      const ref = byId.get(o.reference)!;
      if (isFloor(ref)) problems.push(`"${o.name}" is placed relative to the floor; place it relative to a piece of furniture (the floor is fitted automatically).`);
      else visit(ref);
    }
    visiting.delete(o.id);
    order.push(o);
  };
  spec.objects.filter((o) => !isFloor(o)).forEach(visit);
  if (problems.length) return { placed: [], problems, notes };

  const place = (o: SpecObject, x: number, y: number, base: number): Placed => {
    const center: Vec3 = [round(x), round(y), round(base + o.size[2] / 2)];
    return { ...o, base, center, box: boxOf(center, o.size, o.rotation_z_deg) };
  };
  const collides = (p: Placed) =>
    p.size[2] > FLAT && [...placed.values()].some((q) => q.size[2] > FLAT && q.id !== p.reference && q.reference !== p.id && overlaps(p.box, q.box));

  for (const o of order) {
    const [hx, hy] = halfExtents(o);
    if (o.relation === "anchor") {
      placed.set(o.id, place(o, 0, 0, 0));
      continue;
    }
    const ref = placed.get(o.reference)!;
    if (o.relation === "on_top_of") {
      const [rx, ry] = halfExtents(ref);
      if (hx > rx + 0.05 || hy > ry + 0.05) problems.push(`"${o.name}" (${fmt(o.size)} m) is too big to stand on "${ref.name}" (${fmt(ref.size)} m).`);
      placed.set(o.id, place(o, ref.center[0], ref.center[1], ref.base + ref.size[2]));
      continue;
    }
    const dir: Record<string, [number, number]> = { in_front_of: [0, -1], behind: [0, 1], left_of: [-1, 0], right_of: [1, 0] };
    const [dx, dy] = dir[o.relation];
    const gap = o.gap_m;
    let x = dx === 0 ? ref.center[0] : dx > 0 ? ref.box.max[0] + gap + hx : ref.box.min[0] - gap - hx;
    let y = dy === 0 ? ref.center[1] : dy > 0 ? ref.box.max[1] + gap + hy : ref.box.min[1] - gap - hy;
    let p = place(o, x, y, 0);
    let pushed = 0;
    while (collides(p) && pushed < 50) {
      x += dx * 0.1;
      y += dy * 0.1;
      p = place(o, x, y, 0);
      pushed++;
    }
    if (pushed >= 50) problems.push(`Could not find free space for "${o.name}" ${o.relation.replace(/_/g, " ")} "${ref.name}".`);
    else if (pushed > 0) notes.push(`Moved "${o.name}" ${round(pushed * 0.1, 1)} m further ${o.relation.replace(/_/g, " ")} "${ref.name}" to avoid an overlap.`);
    placed.set(o.id, p);
  }

  // The floor covers the furniture with a margin, centred under it.
  const floor = spec.objects.find(isFloor);
  if (floor && placed.size > 0) {
    const all = [...placed.values()];
    const min = [Math.min(...all.map((p) => p.box.min[0])), Math.min(...all.map((p) => p.box.min[1]))];
    const max = [Math.max(...all.map((p) => p.box.max[0])), Math.max(...all.map((p) => p.box.max[1]))];
    const need = [max[0] - min[0] + 2 * FLOOR_MARGIN, max[1] - min[1] + 2 * FLOOR_MARGIN];
    const size: Vec3 = [round(Math.max(floor.size[0], need[0]), 2), round(Math.max(floor.size[1], need[1]), 2), floor.shape === "plane" ? 0 : Math.min(Math.max(floor.size[2], 0.02), 0.3)];
    if (size[0] !== floor.size[0] || size[1] !== floor.size[1]) notes.push(`Enlarged "${floor.name}" to ${size[0]} x ${size[1]} m so it extends under all furniture.`);
    const f: SpecObject = { ...floor, size, rotation_z_deg: 0 };
    placed.set(f.id, place(f, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, floorBase(f)));
  }
  return { placed: spec.objects.map((o) => placed.get(o.id)!).filter(Boolean), problems, notes };
}

/** Final safety net: no two solid objects may intersect (supports and floors excepted). */
export function findCollisions(placed: Placed[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (a.size[2] <= FLAT || b.size[2] <= FLAT || isFloor(a) || isFloor(b)) continue;
      if (a.reference === b.id || b.reference === a.id) continue;
      if (overlaps(a.box, b.box)) out.push(`"${a.name}" and "${b.name}" intersect.`);
    }
  }
  return out;
}

function shift(placed: Placed[], dx: number, dy: number): Placed[] {
  return placed.map((p) => {
    const center: Vec3 = [round(p.center[0] + dx), round(p.center[1] + dy), p.center[2]];
    return { ...p, center, box: boxOf(center, p.size, p.rotation_z_deg) };
  });
}

/** Finds the smallest shift (whole metres) that keeps the design clear of existing objects. */
export function clearOfObstacles(placed: Placed[], obstacles: Obstacle[]): { placed: Placed[]; offset: [number, number] | null; blocked: string[] } {
  const solid = obstacles.filter((o) => o.size[2] > FLAT && o.size[0] > 0 && o.size[1] > 0).map((o) => ({ name: o.name, box: boxOf(o.center, o.size, 0) }));
  const hits = (ps: Placed[]) => {
    const out: string[] = [];
    for (const p of ps) {
      const box = p.size[2] <= FLAT || isFloor(p) ? { min: [p.box.min[0], p.box.min[1], -TOUCH * 2] as Vec3, max: [p.box.max[0], p.box.max[1], Math.max(p.box.max[2], TOUCH * 2)] as Vec3 } : p.box;
      for (const o of solid) if (overlaps(box, o.box)) out.push(`"${p.name}" would intersect existing object "${o.name}"`);
    }
    return out;
  };
  const initial = hits(placed);
  if (initial.length === 0) return { placed, offset: null, blocked: [] };
  for (let r = 1; r <= 30; r++) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
      const moved = shift(placed, dx, dy);
      if (hits(moved).length === 0) return { placed: moved, offset: [dx, dy], blocked: [] };
    }
  }
  return { placed, offset: null, blocked: initial };
}

// ---------------------------------------------------------------------------
// Lights + camera from the scene bounds
// ---------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const norm = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Euler XYZ rotation (degrees) that points a camera/light (which looks down its -Z) from `from` at `to`. */
export function aimRotation(from: Vec3, to: Vec3): Vec3 {
  const d = norm(sub(to, from));
  const rx = Math.acos(Math.max(-1, Math.min(1, -d[2])));
  const rz = Math.atan2(-d[0], d[1]);
  return [round((rx * 180) / Math.PI), 0, round((rz * 180) / Math.PI)];
}

function corners(b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** True if every point is inside the camera's view (with a 5% margin). */
export function inView(position: Vec3, target: Vec3, lensMm: number, points: Vec3[]): boolean {
  const f = norm(sub(target, position));
  let r = cross(f, [0, 0, 1]);
  if (len(r) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  const u = cross(r, f);
  const tanH = 18 / lensMm; // 36 mm sensor width
  const tanV = tanH * RENDER_ASPECT;
  return points.every((p) => {
    const v = sub(p, position);
    const z = dot(v, f);
    return z > 0.05 && Math.abs(dot(v, r) / z) <= tanH * 0.95 && Math.abs(dot(v, u) / z) <= tanV * 0.95;
  });
}

export type RigLight = { role: LightRole; type: "AREA" | "SUN"; position: Vec3; target: Vec3; energy: number; color: Vec3 };
export type Rig = { lights: RigLight[]; camera: { position: Vec3; target: Vec3; lens_mm: number; framed: boolean } };

const VIEW_DIR: Record<CameraView, Vec3> = { front: [0, -1, 0.35], front_left: [-0.7, -0.85, 0.45], front_right: [0.7, -0.85, 0.45], top: [0.0001, -0.15, 1] };
const LIGHT_DIR: Record<LightRole, Vec3> = { key: [-0.8, -1, 1.1], fill: [1, -0.8, 0.6], rim: [0.3, 1, 1.2], sun: [-0.5, -0.6, 1] };

/** Places lights around the design and frames the camera on it. */
export function rig(spec: SceneSpec, placed: Placed[]): Rig {
  const furniture = placed.filter((p) => !isFloor(p));
  const subject = furniture.length ? furniture : placed;
  const min = [0, 1, 2].map((i) => Math.min(...subject.map((p) => p.box.min[i]))) as Vec3;
  const max = [0, 1, 2].map((i) => Math.max(...subject.map((p) => p.box.max[i]))) as Vec3;
  const target: Vec3 = [round((min[0] + max[0]) / 2), round((min[1] + max[1]) / 2), round(Math.max(0, (min[2] + max[2]) / 2))];
  const radius = Math.max(1, len(sub(max, min)) / 2);

  // Exposure is set by Syntaz, not the model: area lights are scaled to their distance so the
  // subject receives roughly the light of a 3 W/m^2 sun (key), with fill/rim as fractions of it.
  const distance0 = radius * 2.5;
  const keyWatts = 9.4 * distance0 * distance0;
  const hasSun = spec.lights.some((l) => l.role === "sun");
  const hasArea = spec.lights.some((l) => l.role !== "sun");
  const ROLE_SHARE: Record<LightRole, number> = { key: 1, fill: 0.35, rim: 0.5, sun: 0 };
  const lights = spec.lights.map((l): RigLight => {
    const d = norm(LIGHT_DIR[l.role]);
    const position = [0, 1, 2].map((i) => round(target[i] + d[i] * distance0)) as Vec3;
    const type = l.role === "sun" ? "SUN" : "AREA";
    const energy = type === "SUN" ? (hasArea ? 2 : 3) : keyWatts * ROLE_SHARE[l.role] * (hasSun ? 0.6 : 1);
    return { role: l.role, type, position, target, energy: round(energy, 1), color: l.color };
  });

  const points = subject.flatMap((p) => corners(p.box));
  const dir = norm(VIEW_DIR[spec.camera.view]);
  let distance = radius;
  let position = [0, 1, 2].map((i) => target[i] + dir[i] * distance) as Vec3;
  for (let i = 0; i < 60 && !inView(position, target, spec.camera.lens_mm, points); i++) {
    distance *= 1.1;
    position = [0, 1, 2].map((k) => target[k] + dir[k] * distance) as Vec3;
  }
  const framed = inView(position, target, spec.camera.lens_mm, points);
  return { lights, camera: { position: position.map((v) => round(v)) as Vec3, target, lens_mm: spec.camera.lens_mm, framed } };
}

// ---------------------------------------------------------------------------
// Compilation into real Blender MCP tool calls
// ---------------------------------------------------------------------------

export type Phase = "geometry" | "materials" | "lighting" | "camera" | "render";
export type CompiledCall = {
  phase: Phase;
  tool: string; // Blender MCP tool name (without the mcp__blender__ prefix)
  args: Record<string, unknown>;
  /** Spec object this call creates. */
  objectId?: string;
  /** Spec object id (or "camera") this call depends on. */
  dependsOn?: string;
  label: string;
};

export type CompiledPlan = { spec: SceneSpec; placed: Placed[]; rig: Rig; calls: CompiledCall[]; notes: string[] };

export function compile(spec: SceneSpec, placed: Placed[], sceneRig: Rig, renderName: string, notes: string[]): CompiledPlan {
  const calls: CompiledCall[] = [];
  const mats = new Map(spec.materials.map((m) => [m.id, m]));
  for (const p of placed) {
    const base = BASE_DIMS[p.shape];
    const scale = p.size.map((s, i) => (base[i] === 0 ? 1 : round(s / base[i], 4))) as Vec3;
    calls.push({
      phase: "geometry",
      tool: "create_primitive",
      objectId: p.id,
      label: `${p.name}: ${p.shape} ${fmt(p.size)} m at ${fmt(p.center)}`,
      args: { kind: SHAPE_TO_PRIMITIVE[p.shape], name: p.name, location: p.center, rotation_deg: [0, 0, round(p.rotation_z_deg)], scale, size: 1 },
    });
  }
  for (const p of placed) {
    const m = mats.get(p.material)!;
    calls.push({
      phase: "materials",
      tool: "set_material",
      dependsOn: p.id,
      label: `${p.name} -> ${m.name}`,
      args: { object: p.name, material: m.name, base_color: [...m.color.map((c) => round(c)), 1], metallic: round(m.metallic), roughness: round(m.roughness) },
    });
  }
  for (const l of sceneRig.lights) {
    calls.push({
      phase: "lighting",
      tool: "add_light",
      label: `${l.role} light (${l.type}) at ${fmt(l.position)}`,
      args: { kind: l.type, name: `Syntaz ${l.role} light`, location: l.position, rotation_deg: aimRotation(l.position, l.target), energy: l.energy, color: l.color.map((c) => round(c)) },
    });
  }
  calls.push({
    phase: "camera",
    tool: "add_camera",
    label: `camera (${spec.camera.view}) at ${fmt(sceneRig.camera.position)}`,
    args: { name: "Syntaz Camera", location: sceneRig.camera.position, rotation_deg: aimRotation(sceneRig.camera.position, sceneRig.camera.target), lens_mm: round(spec.camera.lens_mm), make_active: true },
  });
  calls.push({ phase: "render", tool: "render_image", dependsOn: "camera", label: `preview ${renderName}`, args: { filename: renderName, resolution_x: 960, resolution_y: 540, samples: 32 } });
  return { spec, placed, rig: sceneRig, calls, notes };
}
