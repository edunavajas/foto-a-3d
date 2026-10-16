"""Run with: blender --background --factory-startup --python test/blender_addon_check.py"""

from pathlib import Path
import tempfile
import zipfile

import bpy


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "dist" / "foto_a_3d.zip"
SOURCE = ROOT / "blender_addon" / "foto_a_3d" / "__init__.py"


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


with tempfile.TemporaryDirectory(prefix="foto-a-3d-blender-") as temporary:
    with zipfile.ZipFile(PACKAGE) as archive:
        assert archive.read("foto_a_3d/__init__.py") == SOURCE.read_bytes(), "Packaged add-on is stale"
    temporary = Path(temporary)
    models = temporary / "models"
    models.mkdir()

    clear_scene()
    for number in (1, 2):
        bpy.ops.mesh.primitive_cube_add(size=number)
        bpy.ops.export_scene.gltf(
            filepath=str(models / f"sample-{number}.glb"),
            export_format="GLB",
            use_selection=True,
        )
        clear_scene()

    bpy.ops.preferences.addon_install(filepath=str(PACKAGE), overwrite=True)
    bpy.ops.preferences.addon_enable(module="foto_a_3d")
    import foto_a_3d

    assert bpy.app.timers.is_registered(foto_a_3d._watch_directory)
    bpy.context.preferences.addons["foto_a_3d"].preferences.output_directory = str(models)

    # The first pass observes file stability; the second imports completed files.
    foto_a_3d._watch_directory()
    foto_a_3d._watch_directory()
    bpy.context.view_layer.update()
    anchors = [obj for obj in bpy.context.scene.objects if obj.get("foto_a_3d_source")]
    assert len(anchors) == 2, f"Expected two imports, found {len(anchors)}"
    bounds = []
    for anchor in anchors:
        children = [obj for obj in anchor.children if obj.type == "MESH"]
        assert children, "Imported model has no mesh"
        points = [obj.matrix_world @ __import__("mathutils").Vector(corner)
                  for obj in children for corner in obj.bound_box]
        bounds.append((min(point.x for point in points), max(point.x for point in points)))
    bounds.sort()
    assert bounds[0][1] < bounds[1][0], f"Models overlap on X: {bounds}"

    foto_a_3d._watch_directory()
    assert len([obj for obj in bpy.context.scene.objects if obj.get("foto_a_3d_source")]) == 2
    bpy.ops.preferences.addon_disable(module="foto_a_3d")
    assert not bpy.app.timers.is_registered(foto_a_3d._watch_directory)
    print("ADDON_CHECK_PASS: installation, two GLB imports, spacing, idempotency, timer cleanup")
