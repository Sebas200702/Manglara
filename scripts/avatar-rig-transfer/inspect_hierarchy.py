import bpy
import sys

path = sys.argv[sys.argv.index("--") + 1]

# Clear and import
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False, confirm=False)
bpy.ops.import_scene.gltf(filepath=path)

print("\n=== HIERARCHY ===")
for obj in bpy.data.objects:
    parent = obj.parent.name if obj.parent else "None"
    print(f"{obj.name} (type={obj.type}) parent={parent}")

print("\n=== SCENE ROOTS ===")
for obj in bpy.context.scene.objects:
    if obj.parent is None:
        print(f"Root: {obj.name} type={obj.type}")
        for child in obj.children:
            print(f"  Child: {child.name} type={child.type}")
