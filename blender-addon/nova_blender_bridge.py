# Nova Blender Bridge - a small, local, token-authenticated bridge between
# Nova AI and Blender. It exposes ONLY the fixed commands below: there is no
# code execution (no exec/eval), no network access and no file access other
# than writing renders into one fixed folder and its own token file.
#
# Security model:
# - Listens on 127.0.0.1 only (not configurable), never on the network.
# - Every request must carry the random token written to
#   ~/.config/nova-blender/token (mode 0600) when you press Start.
# - Every command validates its parameters and rejects unknown ones.
# - Scene changes are pushed as undo steps (Ctrl+Z works).
#
# SPDX-License-Identifier: MIT

bl_info = {
    "name": "Nova Blender Bridge",
    "author": "Nova AI",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > Nova",
    "description": "Local, authenticated bridge for Nova AI with fixed commands (no code execution)",
    "category": "Interface",
}

import hmac
import json
import math
import os
import queue
import re
import secrets
import socket
import tempfile
import threading
import time

import bpy

HOST = "127.0.0.1"  # Never change: the bridge must not be reachable from the network.
DEFAULT_PORT = 9890
MAX_LINE_BYTES = 64 * 1024
MAX_CONNECTIONS = 4
MAIN_THREAD_TIMEOUT = 300.0  # seconds a request may wait for Blender's main thread (renders)
TOKEN_DIR = os.path.join(os.path.expanduser("~"), ".config", "nova-blender")
TOKEN_FILE = os.path.join(TOKEN_DIR, "token")
RENDER_DIR = os.path.join(tempfile.gettempdir(), "nova-blender-renders")
MAX_OBJECTS_LISTED = 200
NAME_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,63}$")
FILENAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.png$")

PRIMITIVES = {
    "cube": "primitive_cube_add",
    "uv_sphere": "primitive_uv_sphere_add",
    "ico_sphere": "primitive_ico_sphere_add",
    "cylinder": "primitive_cylinder_add",
    "cone": "primitive_cone_add",
    "torus": "primitive_torus_add",
    "plane": "primitive_plane_add",
    "monkey": "primitive_monkey_add",
}
LIGHT_TYPES = ("POINT", "SUN", "SPOT", "AREA")


class BridgeError(Exception):
    """An error whose message is safe to send back to Nova."""


# ---------------------------------------------------------------------------
# Parameter validation
# ---------------------------------------------------------------------------

def _check_keys(params, allowed):
    if not isinstance(params, dict):
        raise BridgeError("params must be an object")
    unknown = sorted(set(params) - set(allowed))
    if unknown:
        raise BridgeError(f"unknown parameter(s): {', '.join(unknown)}")


def _num(params, key, default=None, lo=-1e6, hi=1e6, required=False):
    value = params.get(key, default)
    if value is None:
        if required:
            raise BridgeError(f"missing parameter: {key}")
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BridgeError(f"{key} must be a number")
    if value < lo or value > hi:
        raise BridgeError(f"{key} must be between {lo} and {hi}")
    return float(value)


def _vec(params, key, size, default=None, lo=-1e5, hi=1e5):
    value = params.get(key, default)
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or len(value) != size:
        raise BridgeError(f"{key} must be a list of {size} numbers")
    out = []
    for v in value:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < lo or v > hi:
            raise BridgeError(f"{key} must contain {size} numbers between {lo} and {hi}")
        out.append(float(v))
    return out


def _name(params, key, required=False):
    value = params.get(key)
    if value is None:
        if required:
            raise BridgeError(f"missing parameter: {key}")
        return None
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise BridgeError(f"{key} must be 1-63 printable characters")
    return value


def _bool(params, key, default):
    value = params.get(key, default)
    if not isinstance(value, bool):
        raise BridgeError(f"{key} must be true or false")
    return value


def _object(name):
    obj = bpy.data.objects.get(name)
    if obj is None:
        names = ", ".join(o.name for o in list(bpy.data.objects)[:15])
        raise BridgeError(f"no object named {name!r}. Objects: {names or '(none)'}")
    return obj


def _deg(radians):
    return [round(math.degrees(a), 3) for a in radians]


def _rad(degrees):
    return [math.radians(a) for a in degrees]


def _round(values, n=4):
    return [round(v, n) for v in values]


def _undo(message):
    # Undo steps need a window; in background mode this is simply skipped.
    try:
        bpy.ops.ed.undo_push(message=f"Nova: {message}")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Commands (all run on Blender's main thread)
# ---------------------------------------------------------------------------

def cmd_ping(params):
    _check_keys(params, [])
    return {"bridge": ".".join(map(str, bl_info["version"])), "blender": bpy.app.version_string}


def _summary(obj):
    return {
        "name": obj.name,
        "type": obj.type,
        "location": _round(obj.location),
        "rotation_deg": _deg(obj.rotation_euler),
        "scale": _round(obj.scale),
        "parent": obj.parent.name if obj.parent else None,
        "hidden": obj.hide_get() if hasattr(obj, "hide_get") else False,
        "materials": [s.material.name for s in obj.material_slots if s.material],
    }


def cmd_scene_info(params):
    _check_keys(params, [])
    scene = bpy.context.scene
    objects = list(scene.objects)
    render = scene.render
    return {
        "scene": scene.name,
        "file": os.path.basename(bpy.data.filepath) or "(unsaved)",
        "frame_range": [scene.frame_start, scene.frame_end],
        "active_camera": scene.camera.name if scene.camera else None,
        "render": {"engine": render.engine, "resolution": [render.resolution_x, render.resolution_y]},
        "object_count": len(objects),
        "objects": [_summary(o) for o in objects[:MAX_OBJECTS_LISTED]],
        "truncated": len(objects) > MAX_OBJECTS_LISTED,
    }


def _material_info(mat):
    info = {"name": mat.name}
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf:
        info["base_color"] = _round(bsdf.inputs["Base Color"].default_value, 3)
        info["metallic"] = round(bsdf.inputs["Metallic"].default_value, 3)
        info["roughness"] = round(bsdf.inputs["Roughness"].default_value, 3)
    return info


def cmd_object_info(params):
    _check_keys(params, ["name"])
    obj = _object(_name(params, "name", required=True))
    info = _summary(obj)
    info["dimensions"] = _round(obj.dimensions)
    info["modifiers"] = [{"name": m.name, "type": m.type} for m in obj.modifiers]
    info["materials"] = [_material_info(s.material) for s in obj.material_slots if s.material]
    if obj.type == "MESH":
        info["mesh"] = {"vertices": len(obj.data.vertices), "faces": len(obj.data.polygons)}
    elif obj.type == "LIGHT":
        info["light"] = {"type": obj.data.type, "energy": round(obj.data.energy, 3), "color": _round(obj.data.color, 3)}
    elif obj.type == "CAMERA":
        info["camera"] = {"lens_mm": round(obj.data.lens, 3), "active": bpy.context.scene.camera == obj}
    return info


def _new_objects(before):
    return [o for o in bpy.data.objects if o.name not in before]


def cmd_create_primitive(params):
    _check_keys(params, ["kind", "name", "location", "rotation_deg", "scale", "size"])
    kind = params.get("kind")
    if kind not in PRIMITIVES:
        raise BridgeError(f"kind must be one of: {', '.join(PRIMITIVES)}")
    name = _name(params, "name")
    location = _vec(params, "location", 3, [0, 0, 0])
    rotation = _vec(params, "rotation_deg", 3, [0, 0, 0], -36000, 36000)
    scale = _vec(params, "scale", 3, [1, 1, 1], 1e-4, 1e4)
    size = _num(params, "size", 2.0, 1e-4, 1e4)
    before = {o.name for o in bpy.data.objects}
    op = getattr(bpy.ops.mesh, PRIMITIVES[kind])
    kwargs = {"location": location, "rotation": _rad(rotation)}
    if kind in ("cube", "plane", "monkey"):
        kwargs["size"] = size
    else:
        kwargs["radius" if kind in ("uv_sphere", "ico_sphere", "cylinder") else "radius1" if kind == "cone" else "major_radius"] = size / 2
    op(**kwargs)
    created = _new_objects(before)
    if len(created) != 1:
        raise BridgeError("Blender did not create exactly one object")
    obj = created[0]
    obj.scale = scale
    if name:
        obj.name = name
    _undo(f"create {kind}")
    return _summary(obj)


def cmd_transform_object(params):
    _check_keys(params, ["name", "location", "rotation_deg", "scale"])
    obj = _object(_name(params, "name", required=True))
    location = _vec(params, "location", 3)
    rotation = _vec(params, "rotation_deg", 3, None, -36000, 36000)
    scale = _vec(params, "scale", 3, None, 1e-4, 1e4)
    if location is None and rotation is None and scale is None:
        raise BridgeError("give at least one of location, rotation_deg, scale")
    if location is not None:
        obj.location = location
    if rotation is not None:
        obj.rotation_euler = _rad(rotation)
    if scale is not None:
        obj.scale = scale
    _undo(f"transform {obj.name}")
    return _summary(obj)


def cmd_delete_object(params):
    _check_keys(params, ["name"])
    obj = _object(_name(params, "name", required=True))
    name = obj.name
    bpy.data.objects.remove(obj, do_unlink=True)
    _undo(f"delete {name}")
    return {"deleted": name}


def cmd_set_material(params):
    _check_keys(params, ["object", "material", "base_color", "metallic", "roughness"])
    obj = _object(_name(params, "object", required=True))
    if obj.type not in ("MESH", "CURVE", "SURFACE", "META", "FONT"):
        raise BridgeError(f"{obj.name} ({obj.type}) cannot have a material")
    mat_name = _name(params, "material") or f"{obj.name} Material"
    color = _vec(params, "base_color", 4, [0.8, 0.8, 0.8, 1.0], 0.0, 1.0)
    metallic = _num(params, "metallic", 0.0, 0.0, 1.0)
    roughness = _num(params, "roughness", 0.5, 0.0, 1.0)
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    if hasattr(mat, "use_nodes") and not mat.use_nodes:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf is None:
        raise BridgeError(f"material {mat.name!r} has no Principled BSDF node")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = color  # viewport colour
    if obj.material_slots:
        obj.material_slots[0].material = mat
    else:
        obj.data.materials.append(mat)
    _undo(f"material {mat.name}")
    return {"object": obj.name, "material": _material_info(mat)}


def _link(obj):
    bpy.context.scene.collection.objects.link(obj)


def cmd_add_light(params):
    _check_keys(params, ["kind", "name", "location", "rotation_deg", "energy", "color"])
    kind = params.get("kind", "POINT")
    if kind not in LIGHT_TYPES:
        raise BridgeError(f"kind must be one of: {', '.join(LIGHT_TYPES)}")
    name = _name(params, "name") or f"Nova {kind.title()} Light"
    location = _vec(params, "location", 3, [4, -4, 6])
    rotation = _vec(params, "rotation_deg", 3, [0, 0, 0], -36000, 36000)
    energy = _num(params, "energy", 1000.0 if kind != "SUN" else 3.0, 0.0, 1e6)
    color = _vec(params, "color", 3, [1, 1, 1], 0.0, 1.0)
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = _rad(rotation)
    _link(obj)
    _undo(f"add light {obj.name}")
    return _summary(obj)


def cmd_add_camera(params):
    _check_keys(params, ["name", "location", "rotation_deg", "lens_mm", "make_active"])
    name = _name(params, "name") or "Nova Camera"
    location = _vec(params, "location", 3, [7, -7, 5])
    rotation = _vec(params, "rotation_deg", 3, [63, 0, 45], -36000, 36000)
    lens = _num(params, "lens_mm", 50.0, 1.0, 5000.0)
    make_active = _bool(params, "make_active", True)
    data = bpy.data.cameras.new(name)
    data.lens = lens
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = _rad(rotation)
    _link(obj)
    if make_active:
        bpy.context.scene.camera = obj
    _undo(f"add camera {obj.name}")
    return _summary(obj)


def cmd_set_active_camera(params):
    _check_keys(params, ["name"])
    obj = _object(_name(params, "name", required=True))
    if obj.type != "CAMERA":
        raise BridgeError(f"{obj.name} is not a camera")
    bpy.context.scene.camera = obj
    _undo(f"active camera {obj.name}")
    return {"active_camera": obj.name}


def cmd_render_image(params):
    _check_keys(params, ["filename", "resolution_x", "resolution_y", "samples"])
    filename = params.get("filename")
    if not isinstance(filename, str) or not FILENAME_RE.match(filename):
        raise BridgeError("filename must look like name.png (letters, digits, - and _ only)")
    rx = int(_num(params, "resolution_x", 960, 16, 1920))
    ry = int(_num(params, "resolution_y", 540, 16, 1080))
    samples = int(_num(params, "samples", 16, 1, 128))
    scene = bpy.context.scene
    if scene.camera is None:
        raise BridgeError("the scene has no active camera; add one first")
    os.makedirs(RENDER_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(RENDER_DIR, filename)
    if os.path.lexists(path):
        raise BridgeError(f"{filename} already exists in the render folder; choose another name")
    render = scene.render
    saved = (render.filepath, render.resolution_x, render.resolution_y, render.resolution_percentage, render.image_settings.file_format)
    eevee = getattr(scene, "eevee", None)
    saved_samples = getattr(eevee, "taa_render_samples", None) if eevee else None
    saved_cycles = scene.cycles.samples if hasattr(scene, "cycles") else None
    try:
        render.filepath = path
        render.resolution_x, render.resolution_y, render.resolution_percentage = rx, ry, 100
        render.image_settings.file_format = "PNG"
        if saved_samples is not None:
            eevee.taa_render_samples = samples
        if saved_cycles is not None:
            scene.cycles.samples = samples
        started = time.time()
        bpy.ops.render.render(write_still=True)
        seconds = round(time.time() - started, 2)
    finally:
        render.filepath, render.resolution_x, render.resolution_y, render.resolution_percentage, render.image_settings.file_format = saved
        if saved_samples is not None:
            eevee.taa_render_samples = saved_samples
        if saved_cycles is not None:
            scene.cycles.samples = saved_cycles
    if not os.path.isfile(path):
        raise BridgeError("the render finished but no image was written")
    return {"file": path, "resolution": [rx, ry], "engine": render.engine, "samples": samples, "seconds": seconds}


READ_ONLY_COMMANDS = {"ping", "scene_info", "object_info"}


def _require_object_mode():
    # In Edit/Sculpt/... modes, operators act on the edited data instead of the scene.
    mode = getattr(bpy.context, "mode", "OBJECT")
    if mode != "OBJECT":
        raise BridgeError(f"Blender is in {mode.replace('_', ' ').title()} mode. Switch to Object Mode, then try again.")


COMMANDS = {
    "ping": cmd_ping,
    "scene_info": cmd_scene_info,
    "object_info": cmd_object_info,
    "create_primitive": cmd_create_primitive,
    "transform_object": cmd_transform_object,
    "delete_object": cmd_delete_object,
    "set_material": cmd_set_material,
    "add_light": cmd_add_light,
    "add_camera": cmd_add_camera,
    "set_active_camera": cmd_set_active_camera,
    "render_image": cmd_render_image,
}


# ---------------------------------------------------------------------------
# Socket server (background thread) + main-thread queue
# ---------------------------------------------------------------------------

class _Request:
    def __init__(self, command, params):
        self.command, self.params = command, params
        self.done = threading.Event()
        self.response = None


def _write_token(path):
    token = secrets.token_hex(32)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    os.chmod(os.path.dirname(path), 0o700)
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    os.replace(tmp, path)
    return token


class Bridge:
    def __init__(self, port, token_path):
        self.port = port
        self.token_path = token_path
        self.token = None
        self.sock = None
        self.running = False
        self.requests = queue.Queue()
        self.connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.last_error = ""

    def start(self):
        self.token = _write_token(self.token_path)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((HOST, self.port))
        sock.listen(MAX_CONNECTIONS)
        sock.settimeout(0.5)
        self.sock = sock
        self.running = True
        threading.Thread(target=self._accept_loop, name="nova-bridge-accept", daemon=True).start()

    def stop(self):
        self.running = False
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
        try:
            os.remove(self.token_path)
        except OSError:
            pass
        while not self.requests.empty():
            req = self.requests.get_nowait()
            req.response = {"ok": False, "error": "the bridge was stopped"}
            req.done.set()

    def _accept_loop(self):
        while self.running and self.sock:
            try:
                client, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.connections.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=self._serve, args=(client,), name="nova-bridge-conn", daemon=True).start()

    def _serve(self, client):
        try:
            client.settimeout(MAIN_THREAD_TIMEOUT + 30)
            buffer = b""
            while self.running:
                chunk = client.recv(65536)
                if not chunk:
                    return
                buffer += chunk
                if len(buffer) > MAX_LINE_BYTES and b"\n" not in buffer:
                    self._send(client, {"id": None, "ok": False, "error": "request too large"})
                    return
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    response = self._handle_line(line)
                    self._send(client, response)
                    if response.get("auth_failed"):
                        return
        except (OSError, socket.timeout):
            return
        finally:
            client.close()
            self.connections.release()

    def _handle_line(self, line):
        try:
            message = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {"id": None, "ok": False, "error": "invalid JSON"}
        if not isinstance(message, dict):
            return {"id": None, "ok": False, "error": "request must be a JSON object"}
        req_id = message.get("id")
        token = message.get("token")
        if not isinstance(token, str) or not self.token or not hmac.compare_digest(token, self.token):
            return {"id": req_id, "ok": False, "error": "authentication failed", "auth_failed": True}
        command = message.get("command")
        if command not in COMMANDS:
            return {"id": req_id, "ok": False, "error": f"unknown command: {str(command)[:40]}"}
        req = _Request(command, message.get("params") or {})
        self.requests.put(req)
        if not req.done.wait(MAIN_THREAD_TIMEOUT):
            return {"id": req_id, "ok": False, "error": "Blender did not process the request in time (it may be busy)"}
        return {"id": req_id, **req.response}

    @staticmethod
    def _send(client, payload):
        payload.pop("auth_failed", None)
        client.sendall((json.dumps(payload) + "\n").encode("utf-8"))

    def pump(self):
        """Runs queued commands on Blender's main thread."""
        while True:
            try:
                req = self.requests.get_nowait()
            except queue.Empty:
                return
            try:
                if req.command not in READ_ONLY_COMMANDS:
                    _require_object_mode()
                req.response = {"ok": True, "result": COMMANDS[req.command](req.params)}
            except BridgeError as e:
                req.response = {"ok": False, "error": str(e)}
            except Exception as e:  # unexpected Blender error: report type + short message only
                req.response = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
            req.done.set()


_bridge = None


def _timer():
    if _bridge is None or not _bridge.running:
        return None
    _bridge.pump()
    return 0.05


def start_bridge(port=DEFAULT_PORT, token_path=TOKEN_FILE):
    global _bridge
    stop_bridge()
    bridge = Bridge(port, token_path)
    bridge.start()
    _bridge = bridge
    if not bpy.app.background and not bpy.app.timers.is_registered(_timer):
        bpy.app.timers.register(_timer, first_interval=0.05, persistent=True)
    return bridge


def stop_bridge():
    global _bridge
    if _bridge is not None:
        _bridge.stop()
        _bridge = None


def serve_blocking(port, token_path):
    """Headless mode (blender --background): serve until the process is killed."""
    bridge = start_bridge(port, token_path)
    print(f"NOVA_BRIDGE_READY {HOST}:{port}", flush=True)
    while bridge.running:
        bridge.pump()
        time.sleep(0.02)


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

class NovaBridgePreferences(bpy.types.AddonPreferences):
    bl_idname = __name__
    port: bpy.props.IntProperty(name="Port", default=DEFAULT_PORT, min=1024, max=65535)

    def draw(self, context):
        self.layout.prop(self, "port")
        self.layout.label(text="Listens on 127.0.0.1 only. Token: ~/.config/nova-blender/token")


def _prefs():
    addon = bpy.context.preferences.addons.get(__name__)
    return addon.preferences if addon else None


class NOVA_OT_bridge_start(bpy.types.Operator):
    bl_idname = "nova.bridge_start"
    bl_label = "Start Nova Bridge"
    bl_description = "Start the local Nova bridge (127.0.0.1, token-authenticated)"

    def execute(self, context):
        prefs = _prefs()
        try:
            start_bridge(prefs.port if prefs else DEFAULT_PORT)
        except OSError as e:
            self.report({"ERROR"}, f"Could not start: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, "Nova bridge started")
        return {"FINISHED"}


class NOVA_OT_bridge_stop(bpy.types.Operator):
    bl_idname = "nova.bridge_stop"
    bl_label = "Stop Nova Bridge"

    def execute(self, context):
        stop_bridge()
        self.report({"INFO"}, "Nova bridge stopped")
        return {"FINISHED"}


class NOVA_PT_bridge(bpy.types.Panel):
    bl_label = "Nova Bridge"
    bl_idname = "NOVA_PT_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Nova"

    def draw(self, context):
        layout = self.layout
        running = _bridge is not None and _bridge.running
        layout.label(text=f"Status: {'running on 127.0.0.1:' + str(_bridge.port) if running else 'stopped'}")
        layout.operator("nova.bridge_stop" if running else "nova.bridge_start")
        box = layout.box()
        box.label(text="Fixed commands only - no code execution.")
        box.label(text="Nova asks before every change or render.")


_classes = (NovaBridgePreferences, NOVA_OT_bridge_start, NOVA_OT_bridge_stop, NOVA_PT_bridge)


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)


def unregister():
    stop_bridge()
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
