"""Retention audit: original (post-squash, post-edge-purge baseline) vs the built
nimitz-clean.glb. Execs build_carrier.py's front half so the baseline and the rule
volumes are the build's own, then looks every baseline triangle up in the built model
and classifies each MISSING one as an intended kill (raft zone, deck band, elevator
clear, fence/dome, OLS trim) or UNEXPLAINED. Run whenever "has the surgery eaten
something?" comes up; review the UNEXPLAINED bucket, which should stay tiny.

v80 result (2026-07-13): 391,597 baseline tris; 159,233 removed, 99.955%% classified
intended; 176 UNEXPLAINED (0.045%%) in 4-14-tri clumps of paired material_38+black
fittings - consistent with the crest/pokes sub-rules this classifier only
approximates (centroid below the band envelope, top cresting into it), matchbox
scale, none visible. The build removes what it was designed to remove."""
import json, struct
import numpy as np
from collections import defaultdict

# exec the build front half: parses ORIG, purges edge lines, applies the squash,
# defines KEEP/FENCE_KILL/OLS_TRIM/ELEV_CLEAR/RAFT_ZONES/arc_project/inpoly/polygons
exec(open('build_carrier.py').read().split("# --- 2. the deck-band clear ---")[0].replace("print(","_p=("))

def tri_keys_from_state():
    keys={}; meta=[]
    for mi2,nis in inst.items():
        for p in G['meshes'][mi2]['primitives']:
            pos_ai=p['attributes'].get('POSITION')
            if pos_ai is None: continue
            mi=p.get('material',-1)
            mname=mats[mi].get('name','?') if mi>=0 else '?'
            v=readA(pos_ai).astype(np.float64)
            if 'indices' in p:
                idx=readA(p['indices']).ravel().astype(np.int64); idx=idx[:len(idx)//3*3]
            else: idx=np.arange(len(v)//3*3,dtype=np.int64)
            for ni in nis:
                w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
                t=w[idx].reshape(-1,3,3)
                c=t.mean(1)
                k=np.round(c/8.0).astype(np.int64)   # 8 world units = 20 cm
                for i2 in range(len(t)):
                    kk=(int(k[i2,0]),int(k[i2,1]),int(k[i2,2]))
                    keys.setdefault(kk,[]).append(len(meta))
                    meta.append((mname,tuple(c[i2])))
    return keys,meta
base_keys,base_meta=tri_keys_from_state()
print(f"baseline tris: {len(base_meta):,}")

GLB='nimitz-clean.glb'
d2=open(GLB,'rb').read()
cl2=struct.unpack('<I',d2[12:16])[0]
G2=json.loads(d2[20:20+cl2]); bin2=d2[20+cl2+8:]
CT2={5121:np.uint8,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC2={'SCALAR':1,'VEC2':2,'VEC3':3}
def readB(ai):
    a=G2['accessors'][ai]; bv=G2['bufferViews'][a['bufferView']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    n=a['count']*NC2[a['type']]
    arr=np.frombuffer(bin2,dtype=CT2[a['componentType']],count=n,offset=off)
    return arr.reshape(a['count'],NC2[a['type']]) if NC2[a['type']]>1 else arr
def trs2(n):
    if 'matrix' in n: return np.array(n['matrix'],dtype=np.float64).reshape(4,4).T
    M=np.eye(4)
    t=n.get('translation',[0,0,0]); r=n.get('rotation',[0,0,0,1]); s=n.get('scale',[1,1,1])
    x,y,z,w2=r
    R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w2),2*(x*z+y*w2)],
                [2*(x*y+z*w2),1-2*(x*x+z*z),2*(y*z-x*w2)],
                [2*(x*z-y*w2),2*(y*z+x*w2),1-2*(x*x+y*y)]])
    M[:3,:3]=R*np.array(s)[None,:]; M[:3,3]=t
    return M
W2={}
def walk2(i,P):
    W2[i]=P@trs2(G2['nodes'][i])
    for c in G2['nodes'][i].get('children',[]): walk2(c,W2[i])
for r in G2['scenes'][G2.get('scene',0)]['nodes']: walk2(r,np.eye(4))
GEN={'deck_skirt','railings','deck_baked','deck_underside','iccs_cab','iccs_glass'}
built=set(); gen_counts=defaultdict(int)
for ni,n in enumerate(G2['nodes']):
    if 'mesh' not in n: continue
    mnm=G2['meshes'][n['mesh']].get('name','')
    for p in G2['meshes'][n['mesh']]['primitives']:
        v=readB(p['attributes']['POSITION']).astype(np.float64)
        w=(W2[ni][:3,:3]@v.T).T+W2[ni][:3,3]
        if 'indices' in p:
            idx=readB(p['indices']).ravel().astype(np.int64); idx=idx[:len(idx)//3*3]
            t=w[idx].reshape(-1,3,3)
        else: t=w[:len(w)//3*3].reshape(-1,3,3)
        if mnm in GEN:
            gen_counts[mnm]+=len(t); continue
        c=t.mean(1)
        k=np.round(c/8.0).astype(np.int64)
        for i2 in range(len(t)):
            built.add((int(k[i2,0]),int(k[i2,1]),int(k[i2,2])))
print(f"built retained-tri cells: {len(built):,}; generated: {dict(gen_counts)}")

# classify missing baseline tris
S_ = S
def classify(c):
    fa=(c[0]-CX)*S_; la=(c[2]-CZ)*S_; ys=(c[1]-DECKY)*S_
    for f0,f1,l0,l1 in RAFT_ZONES:
        if f0<fa<f1 and l0<la<l1 and -2.2<ys<1.4:
            if arc_project(fa,la)[1]<=3.2: return 'raft zone (intended)'
    for f0,f1,l0,l1,h0,h1 in FENCE_KILL:
        if f0<fa<f1 and l0<la<l1 and h0<ys<h1: return 'fence kill (intended)'
    for f0,f1,l0,l1,h0,h1 in FENCE_KILL_DARK:
        if f0<fa<f1 and l0<la<l1 and h0<ys<h1: return 'dome bulwark (intended)'
    for f0,f1,l0,l1,h0,h1 in OLS_TRIM:
        if f0<fa<f1 and l0<la<l1 and h0<ys<h1: return 'OLS trim (intended)'
    for f0,f1,l0,l1 in ELEV_CLEAR:
        if f0<fa<f1 and l0<la<l1 and -2.5<ys<1.3: return 'elevator clear (intended)'
    inring=inpoly_vec(np.array([fa]),np.array([la]),P_ring)[0]
    if inring and (-1.2<ys<1.8): return 'deck band (intended)'
    inbase=inpoly_vec(np.array([fa]),np.array([la]),P_base)[0]
    if inbase and (-2.6<ys<1.8): return 'deck band deep/pokes (intended)'
    return 'UNEXPLAINED'
missing=defaultdict(int)
unexp=defaultdict(int)
nmiss=0
for kk,idxs in base_keys.items():
    if kk in built: continue
    for mi3 in idxs:
        mname,c=base_meta[mi3]
        nmiss+=1
        cls=classify(c)
        missing[cls]+=1
        if cls=='UNEXPLAINED':
            fa=(c[0]-CX)*S_; la=(c[2]-CZ)*S_; ys=(c[1]-DECKY)*S_
            cell=(int(fa//8)*8,int(la//8)*8)
            unexp[(cell,mname)]+=1
print(f"\nmissing baseline tris: {nmiss:,} of {len(base_meta):,}")
for k3,v3 in sorted(missing.items(),key=lambda x:-x[1]):
    print(f"  {k3:32s} {v3:8,d}")
print("\nUNEXPLAINED by 8m cell + material (top 40):")
for (cell,mname),cnt in sorted(unexp.items(),key=lambda x:-x[1])[:40]:
    print(f"  fa {cell[0]:5d} lat {cell[1]:5d}  {mname:18s} {cnt:6d}")
