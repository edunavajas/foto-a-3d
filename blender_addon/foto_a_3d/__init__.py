bl_info = {
    "name": "Foto a 3D Auto Import",
    "author": "Foto a 3D contributors",
    "version": (1, 0, 0),
    "blender": (4, 0, 0),
    "location": "Edit > Preferences > Add-ons",
    "description": "Automatically import new GLB models from a local folder",
    "category": "Import-Export",
}

import os
from pathlib import Path

import bpy
from bpy.props import StringProperty
from bpy.types import AddonPreferences
from mathutils import Vector


POLL_SECONDS = 2.0
_seen_sizes = {}
_failed = {}


class FotoA3DPreferences(AddonPreferences):
    bl_idname = __package__ or __name__

    output_directory: StringProperty(
        name="Models folder",
        description="Folder containing completed GLB models",
        subtype="DIR_PATH",
        default="",
    )

    def draw(self, context):
        self.layout.prop(self, "output_directory")


def _mesh_bounds(objects):
    points = [obj.matrix_world @ Vector(corner)
              for obj in objects if obj.type == "MESH"
              for corner in obj.bound_box]
    if not points:
        return None
    return min(point.x for point in points), max(point.x for point in points)


def _import_model(model_path):
    scene = bpy.context.scene
    before = set(scene.objects)
    try:
        result = bpy.ops.import_scene.gltf(filepath=str(model_path))
        if "FINISHED" not in result:
            raise RuntimeError("Blender did not finish importing the GLB")

        imported = set(scene.objects) - before
        if not imported:
            raise RuntimeError("The GLB contained no importable objects")
        imported_bounds = _mesh_bounds(imported)
        if imported_bounds is None:
            raise RuntimeError("The GLB contained no mesh")

        existing_bounds = _mesh_bounds(before)
        offset_x = 0.0 if existing_bounds is None else existing_bounds[1] + 1.0 - imported_bounds[0]

        anchor = bpy.data.objects.new(f"Foto a 3D · {model_path.stem}", None)
        scene.collection.objects.link(anchor)
        for obj in imported:
            if obj.parent not in imported:
                world_matrix = obj.matrix_world.copy()
                obj.parent = anchor
                obj.matrix_world = world_matrix
        anchor.location.x = offset_x
        anchor["foto_a_3d_source"] = str(model_path.resolve())
        bpy.context.view_layer.update()
        return anchor
    except Exception:
        for obj in set(scene.objects) - before:
            bpy.data.objects.remove(obj, do_unlink=True)
        raise


def _watch_directory():
    addon = bpy.context.preferences.addons.get(__package__ or __name__)
    scene = bpy.context.scene
    if addon is None or scene is None:
        return POLL_SECONDS

    directory = bpy.path.abspath(addon.preferences.output_directory)
    if not addon.preferences.output_directory or not os.path.isdir(directory):
        return POLL_SECONDS

    imported_sources = {obj.get("foto_a_3d_source") for obj in scene.objects
                        if obj.get("foto_a_3d_source")}
    for model_path in sorted(Path(directory).glob("*.glb")):
        resolved = str(model_path.resolve())
        if resolved in imported_sources:
            continue
        signature = None
        try:
            stat = model_path.stat()
            signature = (stat.st_size, stat.st_mtime_ns)
            if stat.st_size == 0 or _seen_sizes.get(resolved) != signature:
                _seen_sizes[resolved] = signature
                continue
            if _failed.get(resolved) == signature:
                continue
            _import_model(model_path)
            imported_sources.add(resolved)
            _failed.pop(resolved, None)
        except Exception as error:
            if signature is not None:
                _failed[resolved] = signature
            print(f"Foto a 3D: could not import {model_path.name}: {error}")
    return POLL_SECONDS


def register():
    bpy.utils.register_class(FotoA3DPreferences)
    if not bpy.app.timers.is_registered(_watch_directory):
        bpy.app.timers.register(_watch_directory, first_interval=POLL_SECONDS, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_watch_directory):
        bpy.app.timers.unregister(_watch_directory)
    bpy.utils.unregister_class(FotoA3DPreferences)


if __name__ == "__main__":
    register()
