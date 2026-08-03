# Avatar Rig Transfer Pipeline

Reproducible headless Blender pipeline that takes a static humanoid mesh and a TalkingHead-compatible reference GLB, then produces a TalkingHead-ready GLB with:

- Mixamo-compatible armature (copied from reference)
- Vertex group / skin weights (Data Transfer)
- 52 ARKit + 15 Oculus + 5 extra blend shapes (Surface Deform transfer)
- Correct bone rolls and character scale

## Files

```
scripts/avatar-rig-transfer/
├── run.ps1                 # PowerShell wrapper
├── transfer_rig.py         # Main Blender Python script
├── validate_glb.py         # GLB validation script
├── refs/                   # Downloaded reference assets
│   ├── brunette.glb        # TalkingHead reference avatar
│   ├── talkinghead-addon.py
│   ├── build-visemes-from-arkit.py
│   ├── build-extras-from-arkit.py
│   ├── build-avatarsdk-eyes.py
│   └── rename-mixamo-bones.py
└── output/
    └── custom_avatar.glb   # Pipeline output
```

## Quick run

```batch
cd scripts/avatar-rig-transfer
run.bat
```

The default output is `../../web/public/custom_avatar.glb`.

## Customization

Edit `run.bat` defaults, or run `transfer_rig.py` directly with custom paths.

| Variable | Default | Description |
|-----------|---------|-------------|
| `TARGET` | `C:\Users\sebas\Downloads\manglara.glb` | Input static humanoid mesh |
| `REF` | `refs\brunette.glb` | TalkingHead reference avatar |
| `OUTPUT` | `..\..\web\public\custom_avatar.glb` | Output GLB |
| `DECIMATE` | `0.02` | Mesh polygon reduction ratio (0.0-1.0) |

## Manual Blender invocation

```powershell
blender -b -noaudio -P transfer_rig.py -- `
  --ref refs\brunette.glb `
  --target "C:\Users\sebas\Downloads\manglara.glb" `
  --output ..\..\web\public\custom_avatar.glb `
  --addon refs\talkinghead-addon.py `
  --decimate-ratio 0.02
```

## Validate output

```powershell
blender -b -noaudio -P validate_glb.py -- --glb output\custom_avatar.glb
```

## How it works

1. **Import**: load reference (`brunette.glb`) + target mesh.
2. **Decimate**: reduce target polygon count to web-friendly levels.
3. **Align**: scale/position target to match reference bounding box.
4. **Armature transfer**: duplicate reference armature, rename to `Armature`.
5. **Weight transfer**: parent target to armature with empty groups, then use
   Blender's Data Transfer modifier (Nearest Face Interpolated) to copy skin weights.
6. **Blendshape transfer**: for each shape key on the reference, use Surface Deform
   modifier to project the deformation onto the target mesh (works across different
   topologies), then bake as a new shape key.
7. **Post-process**: apply TalkingHead addon operators (`scale_character`,
   `fix_bone_axes_a`), rebuild convenience extras, remove stray objects.
8. **Export**: GLB with armature + morph targets.

## Notes

- The target mesh should be humanoid (head, body, arms, legs) for best results.
- Decimation is required because AI-generated meshes are often multi-million-polygon
  and would produce a multi-GB GLB. Tune `DecimateRatio` to balance quality vs size.
- For further size reduction, run `gltf-transform optimize` on the output:
  ```
  npx gltf-transform optimize output\custom_avatar.glb output\custom_avatar-opt.glb --compress meshopt --texture-compress webp
  ```
- After generating, update `web/src/components/avatar/avatar-controller.ts`:
  ```ts
  const AVATAR_URL = "/custom_avatar.glb";
  ```

## Troubleshooting

- **Blender not found**: update `BLENDER` in `run.bat`.
- **Target file not found**: update `-Target` path.
- **Surface Deform bind fails**: meshes may be too dissimilar; try aligning them
  manually in Blender first, or use a smaller `decimate_ratio`.
