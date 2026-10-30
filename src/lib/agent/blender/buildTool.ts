import "server-only";
import { ToolError, validateArgs } from "../schema";
import type { ToolContext, ToolDefinition } from "../tools";
import {
  boxOf,
  checkStructure,
  clearOfObstacles,
  compile,
  findCollisions,
  isFloor,
  layout,
  normalizeSpec,
  overlaps,
  rig,
  SCENE_SPEC_SCHEMA,
  type Box,
  type CompiledPlan,
  type Obstacle,
  type Vec3,
} from "./scene";

/**
 * blender_build_scene: inspect -> design (model) -> validate + lay out (Syntaz) ->
 * compile -> ONE approval -> build phase by phase with the real Blender MCP tools
 * -> verify the real scene against the design -> honest report.
 * Only the approved calls run; nothing is deleted.
 */

const REQUIRED = ["scene_info", "object_info", "create_primitive", "set_material", "add_light", "add_camera", "render_image"] as const;
const MAX_DESIGN_ATTEMPTS = 3;
const MAX_OBSTACLES = 20;

/** Plans produced by precheck, keyed by the exact (validated) argument object the user approves. */
const plans = new WeakMap<object, CompiledPlan>();

const DESIGN_SYSTEM = [
  "You design 3D scenes for Blender as JSON. Decide WHAT is in the scene; Syntaz computes exact positions.",
  "Units: metres. size = [width, depth, height] of each object's real-world bounding box (e.g. sofa [2.0, 0.9, 0.8]).",
  'Placement by relation: exactly one main object has relation "anchor"; every other object is "in_front_of", "behind", "left_of", "right_of" or "on_top_of" its reference (an object id), with gap_m the clear space between them.',
  'A floor or ground is ONE object with relation "floor_under_all" (shape box or plane); it is sized and placed under everything automatically.',
  "objects = physical things only. Lights (role key/fill/rim/sun) and the camera (view + lens) have their own fields.",
  "Include only what the request needs, each with a clear purpose. Use simple shapes (box, sphere, cylinder, cone, plane) at realistic sizes and a small, consistent material palette with realistic colours.",
].join("\n");

function parseJson(output: string): Record<string, unknown> {
  try {
    return JSON.parse(output);
  } catch {
    throw new ToolError("Blender returned data Syntaz could not read.");
  }
}

async function inspectScene(tools: Map<string, ToolDefinition>, ctx: ToolContext): Promise<Obstacle[]> {
  const scene = parseJson((await tools.get("mcp__blender__scene_info")!.run({}, ctx)).output);
  const objects = Array.isArray(scene.objects) ? (scene.objects as { name: string; type: string; location: Vec3 }[]) : [];
  const obstacles: Obstacle[] = [];
  for (const o of objects.filter((x) => x.type === "MESH").slice(0, MAX_OBSTACLES)) {
    const info = parseJson((await tools.get("mcp__blender__object_info")!.run({ name: o.name }, ctx)).output);
    if (Array.isArray(info.dimensions)) obstacles.push({ name: o.name, center: o.location, size: info.dimensions as Vec3 });
  }
  return obstacles;
}

/** Asks the model for a spec, then validates and lays it out; validation problems go back to the model. */
async function design(brief: string, obstacles: Obstacle[], ctx: ToolContext, renderName: string): Promise<{ plan: CompiledPlan | null; problems: string[]; attempts: number }> {
  let problems: string[] = [];
  let previous = "";
  for (let attempt = 1; attempt <= MAX_DESIGN_ATTEMPTS; attempt++) {
    ctx.progress?.(
      attempt === 1
        ? "Designing the scene (objects, real sizes, relations, materials, lights, camera view)…"
        : `Design attempt ${attempt} of ${MAX_DESIGN_ATTEMPTS}: fixing ${problems.length} problem(s), e.g. ${problems.slice(0, 2).join(" / ")}`,
    );
    const user = [`Request: ${brief}`, problems.length ? `Your previous spec:\n${previous}\n\nIt has these problems. Return the complete corrected spec:\n- ${problems.join("\n- ")}` : ""].filter(Boolean).join("\n\n");
    const res = await ctx.completeJson!(DESIGN_SYSTEM, user, "scene_spec", SCENE_SPEC_SCHEMA, ctx.signal);
    previous = res.raw.slice(0, 6_000);
    if (process.env.NOVA_DEBUG_SCENE === "true") console.info(`[scene] design attempt ${attempt}: ${previous}`);

    const normalized = normalizeSpec(res.value);
    const structure = checkStructure(normalized.raw);
    if (!structure.spec) {
      problems = structure.problems.slice(0, 12);
      continue;
    }
    const spec = structure.spec;
    const laid = layout(spec);
    const collisions = laid.problems.length ? [] : findCollisions(laid.placed);
    if (laid.problems.length || collisions.length) {
      problems = [...laid.problems, ...collisions].slice(0, 12);
      continue;
    }
    const notes = [...normalized.notes, ...laid.notes];
    const cleared = clearOfObstacles(laid.placed, obstacles);
    if (cleared.blocked.length) {
      problems = cleared.blocked.slice(0, 12);
      continue;
    }
    if (cleared.offset) notes.push(`Moved the whole design by [${cleared.offset.join(", ")}] m so it doesn't intersect existing objects (nothing was deleted).`);
    const sceneRig = rig(spec, cleared.placed);
    if (!sceneRig.camera.framed) notes.push("Warning: the camera could not frame every object.");
    notes.push("Light strengths are set by Syntaz from the scene size (the model chooses which lights).");
    return { plan: compile(spec, cleared.placed, sceneRig, renderName, notes), problems: [], attempts: attempt };
  }
  return { plan: null, problems, attempts: MAX_DESIGN_ATTEMPTS };
}

function preview(plan: CompiledPlan): string {
  const mats = new Map(plan.spec.materials.map((m) => [m.id, m.name]));
  const names = new Map(plan.placed.map((p) => [p.id, p.name]));
  const where = (p: CompiledPlan["placed"][number]) =>
    p.relation === "anchor" ? "main piece" : p.relation === "floor_under_all" ? "floor under everything" : `${p.relation.replace(/_/g, " ")} ${names.get(p.reference)}`;
  return [
    `Build scene: ${plan.spec.theme || "(untitled)"}`,
    `${plan.placed.length} objects, ${plan.spec.materials.length} materials, ${plan.rig.lights.length} light(s), camera (${plan.spec.camera.view} view), 1 preview render. Units: metres. Nothing is deleted.`,
    ...plan.notes.map((n) => `Note: ${n}`),
    "",
    "Objects (size w x d x h, centre position):",
    ...plan.placed.map((p) => `- ${p.name} — ${p.purpose}. ${p.shape} ${p.size.join(" x ")} m at [${p.center.join(", ")}], ${where(p)}, ${mats.get(p.material)}`),
    "",
    "Exact Blender calls, in order:",
    ...plan.calls.map((c, i) => `${i + 1}. [${c.phase}] ${c.tool} ${JSON.stringify(c.args)}`),
  ].join("\n");
}

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export function blenderBuildTool(tools: Map<string, ToolDefinition>): ToolDefinition | null {
  if (!REQUIRED.every((t) => tools.has(`mcp__blender__${t}`))) return null;
  const mcp = (t: string) => tools.get(`mcp__blender__${t}`)!;

  return {
    name: "blender_build_scene",
    description:
      "Design and build a complete Blender scene from a description: plans objects with real sizes and how they relate, materials, lights and a camera; checks and lays out the design; builds it, renders a preview (optionally with the requested file name) and verifies the result. Use this for any request with several objects; use the single-object tools only for small edits.",
    risk: "external",
    requiresApproval: true,
    oncePerRun: true,
    reportInFinal: true,
    timeoutMs: 15 * 60_000,
    needsWorkspace: false,
    parameters: {
      type: "object",
      properties: {
        brief: { type: "string", maxLength: 1500, description: "What to build, in the user's words plus any details (style, colours, layout)" },
        preview_filename: { type: "string", maxLength: 69, description: "Optional file name for the preview render, e.g. room.png" },
      },
      required: ["brief"],
      additionalProperties: false,
    },

    precheck: async (args, ctx) => {
      if (!ctx.completeJson) throw new ToolError("Scene design is not available in this context.");
      ctx.progress?.("Inspecting the current Blender scene…");
      const obstacles = await inspectScene(tools, ctx);
      const requested = typeof args.preview_filename === "string" ? args.preview_filename.trim() : "";
      if (requested && !/^[A-Za-z0-9_-]{1,64}\.png$/.test(requested)) throw new ToolError("preview_filename must look like name.png (letters, digits, - and _ only).");
      const { plan, problems, attempts } = await design(String(args.brief), obstacles, ctx, requested || `nova-scene-${Date.now()}.png`);
      if (!plan) throw new ToolError(`Syntaz could not produce a valid scene design after ${attempts} attempts, so nothing was built. Remaining problems:\n- ${problems.join("\n- ")}`);
      // Every compiled call must satisfy the real Blender tool's schema before the user is asked.
      for (const call of plan.calls) {
        const check = validateArgs(mcp(call.tool).parameters, call.args);
        if (!check.ok) throw new ToolError(`Internal error: compiled ${call.tool} call is invalid (${check.error}). Nothing was built.`);
      }
      plans.set(args, plan);
      return preview(plan);
    },

    run: async (args, ctx) => {
      const plan = plans.get(args);
      if (!plan) throw new ToolError("No approved scene plan was found, so nothing was built.");
      plans.delete(args);

      const actualName = new Map<string, string>(); // spec id -> Blender name
      const done: string[] = [];
      const failed: string[] = [];
      const skipped: string[] = [];
      let cameraOk = false;
      let renderFile: string | null = null;

      for (const phase of ["geometry", "materials", "lighting", "camera", "render"] as const) {
        const calls = plan.calls.filter((c) => c.phase === phase);
        ctx.progress?.(`Building: ${phase} (${calls.length} step${calls.length === 1 ? "" : "s"})…`);
        for (const call of calls) {
          ctx.signal.throwIfAborted();
          const callArgs = { ...call.args };
          if (call.dependsOn === "camera" && !cameraOk) {
            skipped.push(`${call.label} (no camera)`);
            continue;
          }
          if (call.dependsOn && call.dependsOn !== "camera") {
            const name = actualName.get(call.dependsOn);
            if (!name) {
              skipped.push(`${call.label} (its object was not created)`);
              continue;
            }
            callArgs.object = name; // Blender may have renamed the new object (e.g. "Sofa.001")
          }
          try {
            const out = parseJson((await mcp(call.tool).run(callArgs, ctx)).output);
            if (call.objectId) actualName.set(call.objectId, String(out.name));
            if (call.tool === "add_camera") cameraOk = true;
            if (call.tool === "render_image") renderFile = String(out.file);
            done.push(call.label);
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            failed.push(`${call.label}: ${err instanceof Error ? err.message : "failed"}`);
          }
        }
      }

      // ---- Verify the real scene against the design --------------------------
      ctx.progress?.("Verifying the built scene against the design…");
      const deviations: string[] = [];
      const actual: { id: string; name: string; reference: string; skip: boolean; box: Box }[] = [];
      const mats = new Map(plan.spec.materials.map((m) => [m.id, m]));
      for (const p of plan.placed) {
        const name = actualName.get(p.id);
        if (!name) continue;
        let info: Record<string, unknown>;
        try {
          info = parseJson((await mcp("object_info").run({ name }, ctx)).output);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          deviations.push(`${name}: could not be inspected after building`);
          continue;
        }
        const dims = info.dimensions as Vec3;
        const loc = info.location as Vec3;
        const tol = (v: number) => Math.max(0.01, Math.abs(v) * 0.02);
        if (!dims.every((d, i) => close(d, p.size[i], tol(p.size[i])))) deviations.push(`${name}: size is ${JSON.stringify(dims)} m, designed ${JSON.stringify(p.size)} m`);
        if (!loc.every((v, i) => close(v, p.center[i], 0.01))) deviations.push(`${name}: position is ${JSON.stringify(loc)}, designed ${JSON.stringify(p.center)}`);
        const want = mats.get(p.material)!;
        const got = (info.materials as { base_color?: number[] }[] | undefined)?.[0]?.base_color;
        if (!got || !want.color.every((c, i) => close(got[i], c, 0.01))) deviations.push(`${name}: material colour is ${got ? JSON.stringify(got.slice(0, 3)) : "missing"}, designed ${JSON.stringify(want.color)}`);
        const rotZ = Array.isArray(info.rotation_deg) ? Number((info.rotation_deg as number[])[2]) : 0;
        actual.push({ id: p.id, name, reference: p.relation === "on_top_of" ? p.reference : "", skip: isFloor(p) || dims[2] <= 0.02, box: boxOf(loc, dims, rotZ) });
      }
      for (let i = 0; i < actual.length; i++) {
        for (let j = i + 1; j < actual.length; j++) {
          const a = actual[i];
          const b = actual[j];
          if (a.skip || b.skip || a.reference === b.id || b.reference === a.id) continue;
          if (overlaps(a.box, b.box)) deviations.push(`${a.name} and ${b.name} intersect in the built scene`);
        }
      }

      const ok = failed.length === 0 && skipped.length === 0 && deviations.length === 0;
      const report = [
        ok ? `Built "${plan.spec.theme}" as designed: ${done.length} steps completed and verified.` : `Built "${plan.spec.theme}" with problems: ${done.length} of ${plan.calls.length} steps completed.`,
        ...plan.notes,
        `Objects: ${plan.placed.map((p) => `${actualName.get(p.id) ?? `${p.name} (NOT created)`} – ${p.purpose}`).join("; ")}.`,
        failed.length ? `FAILED:\n- ${failed.join("\n- ")}` : "",
        skipped.length ? `SKIPPED (depends on a failed step):\n- ${skipped.join("\n- ")}` : "",
        deviations.length
          ? `DIFFERENCES from the design found when inspecting Blender:\n- ${deviations.join("\n- ")}`
          : "Verification: every created object matches its designed size, position and colour, and no objects intersect.",
        renderFile ? `Preview render: ${renderFile}` : "No preview was rendered.",
        "Visual check: Syntaz did not look at the render image; it verified the scene by measuring the objects in Blender. Open the preview to judge how it looks.",
      ].filter(Boolean);
      if (!ok) throw new ToolError(report.join("\n"));
      return { output: report.join("\n") };
    },
  };
}
