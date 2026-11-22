"""
Transforme le logo PNG (poupée au trait gonflé) en modèle 3D .glb.

Principe :
  1. masque du trait à partir de la transparence du PNG
  2. squelette du trait (amincissement Zhang-Suen)
  3. pour chaque point du squelette : sphère de rayon = demi-épaisseur locale du trait
  4. union des sphères par remaillage voxel -> tube "gonflé" lisse
  5. lissage, décimation, matériau rose brillant, export glTF binaire

Usage :
  blender -b --python tools/logo_to_glb.py -- <logo.png> <sortie.glb> [rendu_apercu.png]
"""
import sys, math
import numpy as np
import bpy, bmesh
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
PREVIEW = argv[2] if len(argv) > 2 else None

HEIGHT = 2.0          # hauteur finale du modèle (unités Three.js)
SAMPLE_STEP = 1       # garder 1 point de squelette sur N
TARGET_TRIS = 40000
MIN_RADIUS_PX = 3.5   # épaissit les détails fins (croix des yeux, coutures de la bouche)

# ---------------------------------------------------------------- 1. masque
img = bpy.data.images.load(SRC)
w, h = img.size
px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)  # ligne 0 = bas
mask = px[..., 3] > 0.5

# léger lissage du masque pour éviter les barbules du squelette
def box3(m):
    p = np.pad(m.astype(np.float32), 1)
    return sum(p[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
# mask = box3(mask) > 0.5  # désactivé : effaçait les croix des yeux

# couleur moyenne du trait (pour le matériau)
col = np.median(px[mask][:, :3], axis=0)

# ---------------------------------------------------------------- 2. squelette
def zhang_suen(m):
    m = m.astype(np.uint8).copy()
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            P = np.pad(m, 1)
            p2 = P[:-2, 1:-1]; p3 = P[:-2, 2:]; p4 = P[1:-1, 2:]; p5 = P[2:, 2:]
            p6 = P[2:, 1:-1]; p7 = P[2:, :-2]; p8 = P[1:-1, :-2]; p9 = P[:-2, :-2]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            B = sum(x.astype(np.int32) for x in nb[:8])
            A = sum(((nb[i] == 0) & (nb[i + 1] == 1)).astype(np.int32) for i in range(8))
            if step == 0:
                c = ((p2 * p4 * p6) == 0) & ((p4 * p6 * p8) == 0)
            else:
                c = ((p2 * p4 * p8) == 0) & ((p2 * p6 * p8) == 0)
            rm = (m == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if rm.any():
                m[rm] = 0
                changed = True
    return m.astype(bool)

skel = zhang_suen(mask)
sy, sx = np.nonzero(skel)
sy, sx = sy[::SAMPLE_STEP], sx[::SAMPLE_STEP]

# ---------------------------------------------------------------- distance au bord (euclidienne exacte)
P = np.pad(mask, 1)
inner = P[:-2, 1:-1] & P[2:, 1:-1] & P[1:-1, :-2] & P[1:-1, 2:]
edge = mask & ~inner
ey, ex = np.nonzero(edge)
E = np.stack([ex, ey], 1).astype(np.float32)
S = np.stack([sx, sy], 1).astype(np.float32)
R = np.empty(len(S), np.float32)
for i in range(0, len(S), 512):
    d = ((S[i:i + 512, None, :] - E[None, :, :]) ** 2).sum(-1)
    R[i:i + 512] = np.sqrt(d.min(1)) + 0.5
# lissage des rayons (moyenne des points du squelette à moins de 4 px) -> tube régulier
Rs = np.empty_like(R)
for i in range(0, len(S), 512):
    d = ((S[i:i + 512, None, :] - S[None, :, :]) ** 2).sum(-1)
    wgt = (d < 16).astype(np.float32)
    Rs[i:i + 512] = (wgt * R[None, :]).sum(1) / wgt.sum(1)
R = Rs
print(f"[logo] squelette: {len(S)} points, rayon px min/med/max = {R.min():.1f}/{np.median(R):.1f}/{R.max():.1f}")

# ---------------------------------------------------------------- 3. sphères
ys, xs = np.nonzero(mask)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
scale = HEIGHT / (ys.max() - ys.min() + 2 * np.median(R))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

bm = bmesh.new()
for (x, y), r in zip(S, R):
    rr = max(r, MIN_RADIUS_PX) * scale
    M = Matrix.Translation(((x - cx) * scale, 0, (y - cy) * scale)) @ Matrix.Scale(rr, 4)
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0, matrix=M)
me = bpy.data.meshes.new("PoupeeParfaite")
bm.to_mesh(me); bm.free()
obj = bpy.data.objects.new("PoupeeParfaite", me)
bpy.context.scene.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)

# ---------------------------------------------------------------- 4/5. union, lissage, décimation
px_size = scale
rem = obj.modifiers.new("remesh", "REMESH")
rem.mode = "VOXEL"
rem.voxel_size = px_size * 0.6
bpy.ops.object.modifier_apply(modifier=rem.name)

sm = obj.modifiers.new("smooth", "CORRECTIVE_SMOOTH")
sm.iterations = 25
sm.use_only_smooth = True
bpy.ops.object.modifier_apply(modifier=sm.name)

tris = sum(len(p.vertices) - 2 for p in me.polygons)
if tris > TARGET_TRIS:
    dec = obj.modifiers.new("decimate", "DECIMATE")
    dec.ratio = TARGET_TRIS / tris
    bpy.ops.object.modifier_apply(modifier=dec.name)
for p in me.polygons:
    p.use_smooth = True
print(f"[logo] maillage final: {len(me.vertices)} sommets, {len(me.polygons)} faces")

# matériau
def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
mat = bpy.data.materials.new("RosePoupee")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (*[srgb_to_lin(float(c)) for c in col], 1.0)
bsdf.inputs["Roughness"].default_value = 0.25
me.materials.append(mat)

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True,
                          export_apply=True, export_yup=True)
print("[logo] exporté ->", OUT)

# ---------------------------------------------------------------- aperçu (optionnel)
if PREVIEW:
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 900, 900
    sc.render.film_transparent = False
    sc.world = bpy.data.worlds.new("w"); sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.02, 0.02, 0.03, 1)
    sc.world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam); sc.camera = cam
    cam.location = (1.2, -3.6, 0.4)
    cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    for loc, en in (((3, -3, 4), 800), ((-4, -1, 1), 300), ((0, 4, 2), 400)):
        L = bpy.data.objects.new("l", bpy.data.lights.new("l", "POINT"))
        L.data.energy = en; L.location = loc; sc.collection.objects.link(L)
    sc.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print("[logo] aperçu ->", PREVIEW)
