#!/usr/bin/env python3
"""Nimitz build from the pristine original, single pass: original download -> nimitz-clean.glb.

Steps:
  1. drop SketchUp edge-line prims (no baseColorFactor -> glTF metallic=1 -> render black)
  1c. plan the deck-edge catwalk runs: the long edges aft of the bows, less elevator openings,
     keep boxes and sponsons
  2. clear the flight-deck band inside the traced outline (keep-boxed cabs, OLS bracket, radomes) with
     boundary-owned rules: +2 m ring on the long edges, exact outline at the round-downs; pokes-through,
     crest, island, elevator (ELEV_CLEAR: everything in the band dies) and life-raft (RAFT_ZONES:
     the authored racks die whole) rules
  2a. clear the authored walkway pieces on the planned catwalk runs
  3. one flat-across, sheer-following deck polygon textured with the decktex bake, plus a steel
     underside plate 0.10 m below (the strip is single-sided)
  4. deck-edge skirt, generated catapult control cabs (cabs.py), generated railings
  4b. generated catwalks on the planned runs, and the life-raft racks hung on them
  5. strip empty meshes, GC-repack
Wires, sheaves, shuttles, JBD animation, OLS lights and floods are engine-drawn.

REGEN CHAIN (order matters): build_carrier.py (writes outline.json) -> bake_decktex.py (-> decktex12.png)
-> build_carrier.py -> cp to web/src/assets/nimitz.glb + splice_outline.py + make.

Rules: the 1:200 GA plan is 2D truth for markings, the model is 3D truth, the fascia is generated. The
deck-edge catwalk and the life rafts are generated whole (4b) - never reuse the authored racks, which
belong to the authored catwalk the rebuild deletes (v57-v74) - and edgecheck.py must pass after any
change to 1c, 2a, 4b or the cabs. Every ship material is
single-sided: a generated face must be wound to face the viewer (add_soup restores the winding its
deck-frame axis swap mirrors). A sky sighting: reproduce the in-game camera as a raycheck.py ray first. After rule changes
compare the deleted/repainted counters against the previous run, run raycheck.py after any hull/skirt/deck
edit, and judge cavities in game, not in Cycles. The GLB is a Vite content-hashed asset: after make,
md5-compare dist/assets/nimitz-*.glb against src/assets/nimitz.glb.
"""
import json, struct
import numpy as np
from collections import defaultdict, deque
from cabs import CABS, axes as cab_axes, octagon as cab_octagon, LENGTH as CAB_LENGTH, WIDTH as CAB_WIDTH, CHAMFER as CAB_CHAMFER, HEIGHT as CAB_HEIGHT, HATCH as CAB_HATCH

import os
from pathlib import Path

# Derived, never typed: these scripts are committed, so an absolute home path
# makes the asset pipeline runnable on exactly one machine. flipbook.py already
# resolved its own binary this way.
ROOT = Path(__file__).resolve().parents[4]
APP = ROOT / "apps" / "air"


ORIG = str(APP / "downloads" / "uss_nimitz_cvn-68_aircraft_carrier.glb")
TEX  = 'decktex12.png'
OUTFILE = 'nimitz-clean.glb'
S = 0.025; CX, CZ = 6361.3, -469.3; DECKY = 776.0

OUT=[[-166,4.2],[-158,31.2]]   # placeholder; the trace below overwrites OUT/NS entirely
NS = 44
ISL = (-92, -33, 16, 46)
# no keep box protects what lies here, so the band clear removes it: the original model's bow
# cab (the cabs are generated where the plan puts them, cabs.py), and a 14 m strip of panels and
# glass hidden just under the deck at the port waist, which the glass auto-keep would otherwise save
NO_KEEP = [(64.5,73.0,4.5,11.5), (-56.5,-48.5,-37.0,-31.5)]
KEEP_HAND = [(-28,-14,-46,-34),                                    # OLS bracket
             (122,128.5,-17,-11),(-9.5,-4,-36.5,-31),(-85.5,-79,-36.5,-31),
             (88,94.5,16.5,22),(125,131.5,13.5,19.5)]              # operator cabs
# the 19 radomes, measured once (v14 enumeration) — hand boxes so no classifier drift can bite them
DOME_KEEP = [(-144.7,-141.4,-18.7,-15.4),(100.9,110.5,17.1,24.9),(114.1,116.7,-15.4,-14.0),
             (98.1,106.6,-24.7,-17.7),(-8.5,-3.0,-45.3,-39.8),(-153.7,-148.1,22.9,28.7),
             (-17.9,-9.2,-36.7,-34.9),(98.8,101.2,25.0,27.0),(99.5,106.6,-16.5,-14.7),
             (-2.1,6.6,-36.7,-34.9),(53.7,58.3,-45.2,-40.7),(116.7,124.3,16.1,17.8),
             (-160.9,-156.8,28.9,30.8),(7.6,11.5,-42.1,-38.2),(92.5,94.3,-17.0,-15.6),
             (128.3,130.1,-14.4,-13.0),(-56.1,-54.3,33.8,35.1),(-147.2,-143.7,-21.2,-17.7),
             (108.3,110.1,-15.8,-14.4)]
KEEP_HAND = KEEP_HAND + DOME_KEEP
FENCE_KILL = [(-90.2,-33.2,21.7,23.4,-0.4,1.1),(-48.2,-42.8,16.2,19.2,-0.4,1.1),(-61.2,-55.8,20.0,23.0,-0.4,1.1),
              (-121.6,-120.4,-33.0,-31.2,-0.4,0.9),(-83.7,-80.8,-39.1,-37.8,-0.4,0.9),
              (43.6,45.8,39.3,40.2,-0.4,0.9),(-116.4,-115.4,35.6,36.6,-0.4,1.0),
              (-72.9,-72.0,-39.1,-38.4,-0.4,0.9),
              (-34.6,-33.4,18.5,30.0,-0.4,1.0),(-89.9,-88.6,18.5,30.0,-0.4,1.0)]   # island apron lateral end walls
# the two dome platforms (port waist + stern stbd): a white geodesic radome
# fills the platform inside a black solid-fence bulwark. A geometric kill band
# guts the dome's own mid-shell, so kill only DARK prims (the bulwark) in the
# full box; the generated DOME_RAILS loop stands in for it.
FENCE_KILL_DARK = [(54.1,57.9,-44.8,-41.1,-0.4,1.2),(-153.3,-148.5,23.0,28.3,-0.4,1.1)]
# those two radome platforms' footprints (their DOME_KEEP boxes). The life-raft
# detector clusters white material_37 near the rim, and a radome is white
# material_37 near the rim: unexempted, the port dome read as a raft rack and
# lost its inboard half, the stern dome all of it.
DOME_PLATFORMS = [(53.7,58.3,-45.2,-40.7),(-153.7,-148.1,22.9,28.7)]
# aircraft-elevator platform footprints: the strip owns the surface, so EVERYTHING in the
# band dies regardless of facing — the orientation-gated rules leave vertical/metallic
# under-machinery shards visible through part-killed platform tops. Saturated paint
# (red/yellow border strips) survives; keep boxes (OLS bracket overlaps el-4) still win.
# the four deck-edge aircraft elevators, from their painted platform outlines in the model (the 1:200
# plan and the hangar openings in the hull agree): starboard 1 and 2 forward of the island, 3 aft of it
# (stopping where the island starts at -92), port 4 aft. Fore-aft exactly the painted span - the end
# walls of the openings stand just outside it - and inboard edge to 1.5 m past the deck edge.
ELEV_CLEAR = [(13.1,39.5,21.5,40.5),(-33.4,-3.4,21.5,40.5),(-112.1,-92.5,21.5,40.5),(-117.0,-85.0,-36.5,-18.5)]

data = open(ORIG,'rb').read()
clen,_ = struct.unpack('<II', data[12:20])
G = json.loads(data[20:20+clen]); boff = 20+clen
blen,_ = struct.unpack('<II', data[boff:boff+8])
B = bytearray(data[boff+8:boff+8+blen])
acc=G['accessors']; bvs=G['bufferViews']; nodes=G['nodes']; mats=G['materials']

# --- 1. edge-line purge ---
edgemats = {i for i,m in enumerate(mats) if m.get('name','').startswith('edge_color')}
nedge=0
for mesh in G['meshes']:
    before=len(mesh['primitives'])
    mesh['primitives']=[p for p in mesh['primitives'] if p.get('material') not in edgemats]
    nedge+=before-len(mesh['primitives'])
print(f"edge-line prims removed: {nedge}")

def trs(n):
    m=np.eye(4)
    if 'matrix' in n: return np.array(n['matrix']).reshape(4,4).T
    if 'translation' in n: m[:3,3]=n['translation']
    if 'rotation' in n:
        x,y,z,w=n['rotation']
        m[:3,:3]=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    if 'scale' in n: m[:3,:3]=m[:3,:3]@np.diag(n['scale'])
    return m
world={}
def walk(i,P):
    W=P@trs(nodes[i]); world[i]=W
    for c in nodes[i].get('children',[]): walk(c,W)
for r in G['scenes'][G.get('scene',0)]['nodes']: walk(r,np.eye(4))
def readspan(ai):
    a=acc[ai]; bv=bvs[a['bufferView']]
    comps={'SCALAR':1,'VEC3':3}[a['type']]
    dt={5126:np.float32,5125:np.uint32,5123:np.uint16,5121:np.uint8,5120:np.int8}[a['componentType']]
    isz=np.dtype(dt).itemsize
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    stride=bv.get('byteStride',comps*isz)
    return off,stride,a['count'],dt,comps,isz
def readA(ai):
    off,stride,cnt,dt,comps,isz=readspan(ai)
    if stride!=comps*isz:
        raw=np.frombuffer(bytes(B[off:off+cnt*stride]),np.uint8).reshape(cnt,stride)
        return np.ascontiguousarray(raw[:,:comps*isz]).view(dt).reshape(cnt,comps)
    return np.frombuffer(B[off:off+cnt*comps*isz] if isinstance(B,bytes) else bytes(B[off:off+cnt*comps*isz]),dt).reshape(cnt,comps)
def writeA(ai, arr):
    off,stride,cnt,dt,comps,isz=readspan(ai)
    assert dt==np.float32 and comps==3
    a32=arr.astype(np.float32)
    if stride!=comps*isz:
        for k in range(cnt): B[off+k*stride:off+k*stride+12]=a32[k].tobytes()
    else:
        B[off:off+cnt*12]=a32.ravel().tobytes()
    a=acc[ai]
    if 'min' in a: a['min']=[float(x) for x in a32.min(0)]
    if 'max' in a: a['max']=[float(x) for x in a32.max(0)]

# --- Stage B: LATERAL SQUASH to the real beam --- The flight deck measures 80.0
# m wide vs the real 76.8 m (length is exact); one uniform lateral scale about
# the centreline corrects it, accepting an angled-deck angle of ~8.64 vs 9.05
# deg. Every deck-ops constant here, in the engine and in the bake scales to
# match. DOME_PRESERVE stays empty: a shape-preserving blend has a transition
# zone that tears the dense dome clusters, and the uniform squash distorts a
# sphere by only 4%.
S_LAT=76.8/80.0
DOME_PRESERVE=[]
print(f"lateral squash: S_LAT={S_LAT:.4f} (uniform; dome preservation disabled)")
_sq_done=set()
for ni,n in enumerate(nodes):
    if 'mesh' not in n: continue
    Wm=world[ni]; Winv=np.linalg.inv(Wm)
    for p in G['meshes'][n['mesh']]['primitives']:
        ai=p['attributes'].get('POSITION')
        if ai is None or ai in _sq_done: continue
        _sq_done.add(ai)
        v=readA(ai).astype(np.float64)
        w=(Wm[:3,:3]@v.T).T+Wm[:3,3]
        fa=(w[:,0]-CX)*S; la=(w[:,2]-CZ)*S
        z_final=CZ+(w[:,2]-CZ)*S_LAT          # the squash
        bestwt=np.zeros(len(w))
        for f0,f1,l0,l1 in DOME_PRESERVE:
            cf,cl=(f0+f1)/2,(l0+l1)/2; rf,rl=(f1-f0)/2,(l1-l0)/2
            dist=np.hypot(np.maximum(np.abs(fa-cf)-rf,0), np.maximum(np.abs(la-cl)-rl,0))
            wt=np.clip(1-dist/1.2,0,1)
            m=wt>bestwt
            if m.any():
                z_pres=CZ+(cl*S_LAT+(la[m]-cl))/S   # translate with the squash, keep shape
                z_sq=CZ+la[m]*S_LAT/S
                z_final[m]=z_sq*(1-wt[m])+z_pres*wt[m]
                bestwt[m]=wt[m]
        wnew=w.copy(); wnew[:,2]=z_final
        vl=(Winv[:3,:3]@wnew.T).T+Winv[:3,3]
        writeA(ai, vl)
# every measured deck-frame constant follows the squash (they were measured pre-squash)
def _lat(x): return round(x*S_LAT,2)
ISL=(ISL[0],ISL[1],_lat(ISL[2]),_lat(ISL[3]))
NO_KEEP=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in NO_KEEP]
KEEP_HAND=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in KEEP_HAND]
DOME_KEEP=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in DOME_KEEP]
DOME_PLATFORMS=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in DOME_PLATFORMS]
def on_dome_platform(f,l): return any(f0<f<f1 and l0<l<l1 for f0,f1,l0,l1 in DOME_PLATFORMS)
FENCE_KILL=[(f0,f1,_lat(l0),_lat(l1),h0,h1) for f0,f1,l0,l1,h0,h1 in FENCE_KILL]
FENCE_KILL_DARK=[(f0,f1,_lat(l0),_lat(l1),h0,h1) for f0,f1,l0,l1,h0,h1 in FENCE_KILL_DARK]
# OLS datum-arm trim: the model's green-datum bar (8.1 m) overhangs the flight
# deck by ~2.2 m where cat-4 wingtips sweep; trim it to +-1.8 m about the lens
# column (lat -37.06). Applied only to material_5 (the boxes also contain deck
# plates). Coordinates are post-squash, so no _lat.
OLS_TRIM=[(-22.6,-19.2,-35.35,-32.4,0.50,0.85),(-22.6,-19.2,-41.7,-38.75,0.50,0.85)]
# Life-raft canister racks: v57/v58 tried exempting the authored racks from the
# edge rules, but they straddle the rebuilt deck's boundary planes (sheered strip +
# skirt), so they end up either beheaded or clipping through the deck. v59 replaces
# them: killed inside RAFT_ZONES (collected in step 1b), regenerated after railings.
ELEV_CLEAR=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in ELEV_CLEAR]

# --- auto-trace the deck rim from the PRISTINE geometry. Station every 3 m; the edge is a
# contiguity walk through connected flush deck (a percentile lands ON the elevator-overhang
# boundary and wobbles, stopping the strip short of the deck-edge elevators). Heights measured
# at each traced point. The same outline drives the bake and the engine physics polygon.
print("tracing deck rim...")
pristine=[]
for ni,n in enumerate(nodes):
    if 'mesh' not in n: continue
    for p in G['meshes'][n['mesh']]['primitives']:
        v=readA(p['attributes']['POSITION']).astype(np.float64)
        if 'indices' in p: idx=readA(p['indices']).ravel().astype(np.int64)
        else: idx=np.arange(len(v),dtype=np.int64)
        idx=idx[:len(idx)//3*3]
        w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
        t=w[idx].reshape(-1,3,3)
        if len(t): pristine.append(t)
PT=np.concatenate(pristine)
e1=PT[:,1]-PT[:,0]; e2=PT[:,2]-PT[:,0]
fnP=np.cross(e1,e2); nlP=np.linalg.norm(fnP,axis=1)+1e-12
nyP=np.abs(fnP[:,1]/nlP)
cP=PT.mean(1)
faP=(cP[:,0]-CX)*S; laP=(cP[:,2]-CZ)*S; hP=(cP[:,1]-DECKY)*S
plate=(nyP>0.6)&(hP>-0.8)&(hP<1.4)
# big deck plates have sparse centroids: sample plate SURFACES (~1 m grid) for the trace
sf=[]; sl=[]; sh=[]
PTp=PT[plate]
e1p=PTp[:,1]-PTp[:,0]; e2p=PTp[:,2]-PTp[:,0]
Lp=np.maximum(np.linalg.norm(e1p,axis=1),np.linalg.norm(e2p,axis=1))*S
for i2 in range(len(PTp)):
    n2=max(1,int(Lp[i2])+1)
    us,vs=np.meshgrid(np.linspace(0,1,n2+1),np.linspace(0,1,n2+1))
    mm=(us+vs)<=1.0
    pts=PTp[i2,0][None,:]+np.outer(us[mm],e1p[i2])+np.outer(vs[mm],e2p[i2])
    sf.append((pts[:,0]-CX)*S); sl.append((pts[:,2]-CZ)*S); sh.append((pts[:,1]-DECKY)*S)
faS=np.concatenate(sf); laS=np.concatenate(sl); hS=np.concatenate(sh)
INSET=0.30
# the original flight-deck surface (and the flush elevator/parking overhangs) sits at
# ~+0.65 m above the contact plane; rim heights come from THOSE plates only, so sponson
# decks and below-deck catwalks can't drag a station's rim down (per-station washboard)
FLUSH_LO,FLUSH_HI=0.30,1.00
def flush_walk(lf, side):
    # contiguity walk outward from the median over 1 m bins, gap tolerance 3 m.
    # A percentile fails here: a 12 m flush elevator overhang on a 70 m deck is ~2% of
    # the station's samples, so the 98th percentile lands ON the platform boundary and
    # wobbles — the walk follows connected flush deck to its true edge instead.
    b0=int(np.floor(lf.min())); occ=np.zeros(int(np.ceil(lf.max()))-b0+2,bool)
    occ[(lf-b0).astype(int)]=True
    mid=int(np.clip(int(np.median(lf))-b0,0,len(occ)-1))
    if side>0:
        i=mid; gap=0
        while i+1<len(occ) and gap<=3:
            i+=1; gap=0 if occ[i] else gap+1
        return min(float(b0+(i-gap)+1), float(lf.max()))
    i=mid; gap=0
    while i-1>=0 and gap<=3:
        i-=1; gap=0 if occ[i] else gap+1
    return max(float(b0+(i+gap)), float(lf.min()))
port_pts=[]; stbd_pts=[]
# bow caps: the flight deck extends to fa~165 (measured), but the 3 m grid's last station
# was 163, leaving a ~2 m bow gap. Add finer stations to 165 so the deck reaches the bow.
for f0 in list(np.arange(-167.0, 164.0, 3.0))+[164.0, 165.0]:
    m=(np.abs(faS-f0)<1.5)
    if m.sum()<8: continue
    lats=laS[m]; hs=hS[m]
    flushm=(hs>FLUSH_LO)&(hs<FLUSH_HI)
    lf=lats[flushm]
    if abs(f0)<=150 and len(lf)>=8:
        lp=flush_walk(lf,+1)-INSET; ls_=flush_walk(lf,-1)+INSET
    else:
        # bow/stern round-downs: the tuned percentile rule (flush plates thin out on the curve)
        lp=np.percentile(lats,98)-INSET; ls_=np.percentile(lats,2)+INSET
    def rim(sel):
        flush=sel&(hs>FLUSH_LO)&(hs<FLUSH_HI)
        src=hs[flush] if flush.sum()>=4 else hs[sel]
        return float(np.median(src)) if len(src) else 0.0
    hp=rim(lats>lp-3); hsb=rim(lats<ls_+3)
    port_pts.append((round(f0,1),round(lp,2),round(np.clip(hp,0.0,0.9),2)))
    stbd_pts.append((round(f0,1),round(ls_,2),round(np.clip(hsb,0.0,0.9),2)))
# smooth h with a 5-tap median (kills single-station spikes), then lat and h 3-tap mean
def medh(seq,r=2):
    return [(seq[i][0],seq[i][1],float(np.median([s[2] for s in seq[max(0,i-r):i+r+1]]))) for i in range(len(seq))]
def smooth(seq):
    out2=[]
    for i in range(len(seq)):
        a=seq[max(0,i-1)]; b=seq[i]; c=seq[min(len(seq)-1,i+1)]
        out2.append((b[0], round((a[1]+b[1]+c[1])/3,2), round((a[2]+b[2]+c[2])/3,2)))
    return out2
port_pts=smooth(medh(port_pts)); stbd_pts=smooth(medh(stbd_pts))
OUT=[[f,l] for f,l,_ in port_pts]+[[f,l] for f,l,_ in reversed(stbd_pts)]
RIMH=[h for _,_,h in port_pts]+[h for _,_,h in reversed(stbd_pts)]
NS=len(port_pts)
print(f"  traced {NS} stations/side, fa {port_pts[0][0]}..{port_pts[-1][0]}")
import json as _json
_json.dump({'OUT':OUT,'RIMH':RIMH,'NS':NS}, open('outline.json','w'))

def expand(d):
    return [[f+(d if f>100 else (-d if f<-160 else 0)), l+(d if l>0 else -d)] for f,l in OUT]
def mkpoly(pts):
    poly=np.array(pts,dtype=np.float64)
    return poly[:,0],poly[:,1],np.roll(poly[:,0],-1),np.roll(poly[:,1],-1)
P_ring  = mkpoly(expand(2.0))
P_base  = mkpoly(expand(0.0))
P_inset = mkpoly(expand(-1.5))
P_r12   = mkpoly(expand(12.0))
P_r8    = mkpoly(expand(8.0))
def inpoly_vec(f2,l2,P):
    PX,PY,PX2,PY2=P
    res=np.zeros(len(f2),bool)
    for i in range(len(f2)):
        cross=(PY>l2[i])!=(PY2>l2[i])
        with np.errstate(divide='ignore',invalid='ignore'):
            xi=PX+(l2[i]-PY)*(PX2-PX)/np.where((PY2-PY)!=0,(PY2-PY),1)
        res[i]=(np.sum(cross&(f2[i]<xi))%2)==1
    return res
def inzone(f,l,zones):
    return any(f0<f<f1 and l0<l<l1 for f0,f1,l0,l1 in zones)

# --- auto keep boxes: tall white radomes + glass cabs (measured, not guessed) ---
white=[i for i,m in enumerate(mats) if (lambda c: c and c[0]>0.7 and c[1]>0.7 and c[2]>0.7)(m.get('pbrMetallicRoughness',{}).get('baseColorFactor'))]
glass=[i for i,m in enumerate(mats) if m.get('alphaMode')=='BLEND']
autokeep=[]
def clusters_of(matset,maxdim,hlo,hhi,needtall):
    pts=[]
    for ni,n in enumerate(nodes):
        if 'mesh' not in n: continue
        for p in G['meshes'][n['mesh']]['primitives']:
            if p.get('material') not in matset: continue
            v=readA(p['attributes']['POSITION']).astype(np.float64)
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            fa=(w[:,0]-CX)*S; la=(w[:,2]-CZ)*S; h=(w[:,1]-DECKY)*S
            m=(h>hlo)&(h<hhi)
            pts.extend(zip(fa[m],la[m],h[m]))
    if not pts: return
    pts=np.array(pts)
    bins=defaultdict(list)
    for f2,l2,h2 in pts: bins[(int(f2//1.5),int(l2//1.5))].append((f2,l2,h2))
    keys=set(bins); seen=set()
    for k in keys:
        if k in seen: continue
        q=deque([k]); comp=[]
        while q:
            c2=q.popleft()
            if c2 in seen or c2 not in keys: continue
            seen.add(c2); comp.extend(bins[c2])
            for dx in(-1,0,1):
                for dz in(-1,0,1): q.append((c2[0]+dx,c2[1]+dz))
        A=np.array(comp)
        dim=max(A[:,0].max()-A[:,0].min(), A[:,1].max()-A[:,1].min())
        hspan=A[:,2].max()-A[:,2].min()
        cf,cl=A[:,0].mean(),A[:,1].mean()
        if needtall and (hspan<1.2 or A[:,2].max()<1.0): continue    # panels are not domes
        if inzone(cf,cl,NO_KEEP): continue
        if len(A)>=12 and dim<maxdim and inpoly_vec(np.array([cf]),np.array([cl]),P_r8)[0]:
            autokeep.append((A[:,0].min()-0.6,A[:,0].max()+0.6,A[:,1].min()-0.6,A[:,1].max()+0.6))
clusters_of(set(white),9.0,-1.5,6.0,True)
clusters_of(set(glass),12.0,-1.5,8.0,False)
KEEP=KEEP_HAND+autokeep
print(f"keep boxes: {len(KEEP_HAND)} hand + {len(autokeep)} auto")

mats.append({'name':'steel_repaint','pbrMetallicRoughness':{'baseColorFactor':[0.34,0.36,0.39,1.0],'metallicFactor':0.25,'roughnessFactor':0.8}})
GREY=len(mats)-1
mats.append({'name':'railing','pbrMetallicRoughness':{'baseColorFactor':[0.60,0.62,0.64,1.0],'metallicFactor':0.15,'roughnessFactor':0.7}})
RAIL=len(mats)-1
# the decktex base is sRGB (96,98,94); this is that colour in linear space, same BRDF
# params as deck_baked — repainted plates merge with the baked deck under the same light
mats.append({'name':'deck_repaint','pbrMetallicRoughness':{'baseColorFactor':[0.117,0.122,0.112,1.0],'metallicFactor':0.0,'roughnessFactor':0.92}})
DTONE=len(mats)-1
inst=defaultdict(list)
for ni,n in enumerate(nodes):
    if 'mesh' in n: inst[n['mesh']].append(ni)
def addidx(arr32):
    global B
    while len(B)%4: B.append(0)
    off=len(B); B.extend(arr32.tobytes())
    bvs.append({'buffer':0,'byteOffset':off,'byteLength':arr32.nbytes,'target':34963})
    acc.append({'bufferView':len(bvs)-1,'byteOffset':0,'componentType':5125,'count':len(arr32),'type':'SCALAR'})
    return len(acc)-1

# --- 1b. life-raft rack REMOVAL --- the authored racks straddle the rebuilt
# deck's boundary planes and cannot be kept cleanly; the zones are collected so
# the band clear kills them, nothing is regenerated, and the uniform skirt is
# the fascia everywhere.
_P=np.array(OUT,np.float64); _SG=np.roll(_P,-1,axis=0)-_P
_SL=np.hypot(_SG[:,0],_SG[:,1]); _AR=np.concatenate([[0.0],np.cumsum(_SL)])[:len(_P)]
def arc_project(f,l):
    d0=f-_P[:,0]; d1=l-_P[:,1]
    tpar=np.clip((d0*_SG[:,0]+d1*_SG[:,1])/(_SL**2+1e-9),0,1)
    q0=_P[:,0]+tpar*_SG[:,0]; q1=_P[:,1]+tpar*_SG[:,1]
    dd=np.hypot(f-q0,l-q1)
    j=int(np.argmin(dd))
    return _AR[j]+tpar[j]*_SL[j], dd[j]
raftpts=[]
for mi2,nis in inst.items():
    for p in G['meshes'][mi2]['primitives']:
        mi=p.get('material',-1)
        if mi<0 or mats[mi].get('name')!='material_37': continue
        v=readA(p['attributes'].get('POSITION')).astype(np.float64)
        for ni in nis:
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            fa=(w[:,0]-CX)*S; la=(w[:,2]-CZ)*S; hh=(w[:,1]-DECKY)*S
            for k in range(0,len(w),3):   # sparse sample is enough for clustering
                if -2.0<hh[k]<1.2 and not on_dome_platform(fa[k],la[k]):
                    s,dd=arc_project(fa[k],la[k])
                    if dd<4.0: raftpts.append((s,fa[k],la[k]))
raftpts.sort()
RAFT_CLUSTERS=[]; RAFT_ZONES=[]
if raftpts:
    start=0
    for i in range(1,len(raftpts)+1):
        if i==len(raftpts) or raftpts[i][0]-raftpts[i-1][0]>1.8:
            seg=raftpts[start:i]
            if seg[-1][0]-seg[0][0]>0.8:
                RAFT_CLUSTERS.append((seg[0][0],seg[-1][0]))
                fs=[p[1] for p in seg]; ls=[p[2] for p in seg]
                RAFT_ZONES.append((min(fs)-0.7,max(fs)+0.7,min(ls)-0.7,max(ls)+0.7))
            start=i
print(f"life-raft clusters: {len(RAFT_CLUSTERS)} (authored racks killed in-zone, NOT regenerated)")
# RACK_MATS gate removed: the zone kill is material-blind (brackets span many materials)


# --- 1c. deck-edge catwalk plan ---
# One generated catwalk (4b) runs along every long-edge stretch that is not an elevator
# opening, a keep box or a sponson; 2a clears the authored walkway pieces there (ledges,
# rails, gratings, fittings) so the two never stand side by side. Below the deck the hull
# is never outboard of the deck edge, so authored geometry wholly outboard of the skirt
# within the skirt's band is walkway, never hull. Planned before the band clear so the
# retention audit (audit.py) can classify what 2a removes.
WALK_DROP=1.5      # catwalk floor top below the deck rim
WALK_WIDTH=1.3     # skirt face to the catwalk's outer edge
WALK_THICK=0.10
WALK_RAIL=1.05     # railing height above the floor
WALK_REACH=2.5     # how far out the catwalk and its raft racks reach
WALK_CLEAR=3.6     # authored walkway out to here goes
WALK_FORE=105      # the bows keep their authored walkways: they follow the flare out to 2.9 m, where a
                   # generated catwalk at a fixed drop cuts through them
ELEVATORS=[(11,35,1),(-33,-11,1),(-111,-89,1),(-119,-93,-1)]   # deck-edge elevator openings (fa span, side), as engine.ts marks their edges
def side_line(s):
    # one long edge of the outline, stern to bow: s=+1 starboard (OUT[:NS]), -1 port
    ix=list(range(NS)) if s>0 else list(range(2*NS-1,NS-1,-1))
    return np.array([OUT[i] for i in ix],np.float64), np.array([RIMH[i] for i in ix],np.float64)
def side_normals(P,s):
    d=P[1:]-P[:-1]; L=np.hypot(d[:,0],d[:,1])
    n=np.stack([-d[:,1],d[:,0]],1)/L[:,None]
    return n*np.where(n[:,1]*s<0,-1.0,1.0)[:,None], L
def project(P,n,f,l):
    # nearest segment of polyline P for each point: (segment, along 0..1, signed outboard offset)
    a=P[:-1]; d=P[1:]-a; L2=(d**2).sum(1)+1e-12
    seg=np.empty(len(f),int); t=np.empty(len(f)); off=np.empty(len(f))
    for c0 in range(0,len(f),4000):
        ff=f[c0:c0+4000,None]; ll=l[c0:c0+4000,None]
        tt=np.clip(((ff-a[:,0])*d[:,0]+(ll-a[:,1])*d[:,1])/L2,0,1)
        qf=a[:,0]+tt*d[:,0]; ql=a[:,1]+tt*d[:,1]
        k=np.hypot(ff-qf,ll-ql).argmin(1); r=np.arange(len(k))
        seg[c0:c0+4000]=k; t[c0:c0+4000]=tt[r,k]
        off[c0:c0+4000]=(ff[:,0]-qf[r,k])*n[k,0]+(ll[:,0]-ql[r,k])*n[k,1]
    return seg,t,off
def authored_vertices():
    # every authored vertex in the deck frame (fa, lat, h), as the model stands now
    out=[]
    for mi2,nis in inst.items():
        for p in G['meshes'][mi2]['primitives']:
            pos_ai=p['attributes'].get('POSITION')
            if pos_ai is None: continue
            v=readA(pos_ai).astype(np.float64)
            if 'indices' in p: v=v[np.unique(readA(p['indices']).ravel())]
            for ni in nis:
                w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
                out.append(np.stack([(w[:,0]-CX)*S,(w[:,2]-CZ)*S,(w[:,1]-DECKY)*S],1))
    return np.concatenate(out)
def in_boxes(f,l,boxes,pad=0.0):
    m=np.zeros(len(f),bool)
    for f0,f1,l0,l1 in boxes: m|=(f>f0-pad)&(f<f1+pad)&(l>l0-pad)&(l<l1+pad)
    return m
AV=authored_vertices()
WALK_OK={}
for s in (1,-1):
    P,H=side_line(s); n,L=side_normals(P,s)
    ok=(np.abs(n[:,1])>=0.5)&(np.maximum(P[:-1,0],P[1:,0])<=WALK_FORE)&(np.minimum(P[:-1,0],P[1:,0])>=-164)   # the long edges, not the bow or stern ends
    for f0,f1,es in ELEVATORS:
        if es==s: ok&=~((np.maximum(P[:-1,0],P[1:,0])>f0-0.5)&(np.minimum(P[:-1,0],P[1:,0])<f1+0.5))
    V=AV[(np.sign(AV[:,1])==s)&(np.abs(AV[:,1])>5)&(AV[:,2]>-6.0)&(AV[:,2]<1.8)]
    seg,t,off=project(P,n,V[:,0],V[:,1]); rim=H[seg]+t*(H[seg+1]-H[seg])
    # protected geometry (radomes, cabs, OLS bracket, dome platforms) inside the catwalk's space
    kept=in_boxes(V[:,0],V[:,1],KEEP+DOME_PLATFORMS)&(off>-0.05)&(off<WALK_REACH+0.1)&(V[:,2]>rim-2.3)&(V[:,2]<rim+0.2)
    ok[np.unique(seg[kept])]=False
    # a sponson: structure reaching past the clear, or hanging below the catwalk band -
    # clearing round it would cut it in two, so the catwalk stops a segment short
    beyond=(off>=WALK_CLEAR)&(off<=12)&(V[:,2]>rim-4.5)&(V[:,2]<rim+1.0)
    below=(off>=0.3)&(off<WALK_CLEAR)&(V[:,2]>rim-4.5)&(V[:,2]<rim-2.2)
    ok[np.where((np.bincount(seg[beyond],minlength=len(ok))>=20)|(np.bincount(seg[below],minlength=len(ok))>=20))[0]]=False
    # what reaches from these into the segments either side (a radome's platform, a sponson's
    # deck) is the per-piece crossing and overlap test's to find (4b), not a blanket margin
    WALK_OK[s]=ok
def walkway_zones(vf,vl,vh,planned=True):
    # per point: (in the walkway space, in the walkway band) - the space is outboard of the
    # skirt; the band is the same height range reaching 1 m inboard of it. planned=True
    # also requires a planned catwalk run there.
    inside=np.zeros(len(vf),bool); band=np.zeros(len(vf),bool)
    for s in (1,-1):
        P,H=side_line(s); n,_=side_normals(P,s)
        m=np.where((np.sign(vl)==s)&(np.abs(vl)>5))[0]
        if not len(m): continue
        seg,t,off=project(P,n,vf[m],vl[m])
        rim=H[seg]+t*(H[seg+1]-H[seg])
        ok=(vh[m]>rim-2.2)&(vh[m]<rim+0.15)&~in_boxes(vf[m],vl[m],KEEP+DOME_PLATFORMS)
        if planned: ok&=WALK_OK[s][seg]
        inside[m]=ok&(off>0.1)&(off<WALK_CLEAR)
        band[m]=ok&(off>-1.0)&(off<WALK_CLEAR)
    return inside,band
def in_walkway(tri_f,tri_l,tri_h):
    # triangles (N, 3 corners) 2a clears: centred on a planned run, wholly in the walkway band
    # and reaching into the walkway space. Walkway floors that run on under the deck edge go
    # too: under the deck the skirt hides them, and left in place they sit in the catwalk's
    # own plane. Judged by the centre, so a plate at a run's end goes whole.
    i,b=walkway_zones(tri_f.ravel(),tri_l.ravel(),tri_h.ravel(),planned=False)
    ci,cb=walkway_zones(tri_f.mean(1),tri_l.mean(1),tri_h.mean(1))
    return cb&b.reshape(-1,3).all(1)&i.reshape(-1,3).any(1)

# --- 2. the deck-band clear ---
deleted=0; resplit=0
for mi2,nis in inst.items():
    mesh=G['meshes'][mi2]
    newprims=[]
    for p in list(mesh['primitives']):
        pos_ai=p['attributes'].get('POSITION')
        if pos_ai is None: continue
        mi=p.get('material',-1)
        col=mats[mi].get('pbrMetallicRoughness',{}).get('baseColorFactor') if mi>=0 else None
        dark=(col is not None and max(col[:3])<0.42 and mats[mi].get('alphaMode')!='BLEND')
        # pale-neutral: flush plates the kill rules can miss (giant tris whose centroid
        # falls outside the ring, partial escapes) get DECK-TONE repaint instead — any
        # survivor then merges with the baked deck rather than reading as a pale slab
        pale=(col is not None and (max(col[:3])-min(col[:3]))<=0.12 and max(col[:3])>=0.42 and mats[mi].get('alphaMode')!='BLEND')
        v=readA(pos_ai).astype(np.float64)
        if 'indices' in p:
            idx=readA(p['indices']).ravel().astype(np.int64)
        else:
            idx=np.arange(len(v),dtype=np.int64)
        idx=idx[:len(idx)//3*3]
        killall=None; steelall=None; deckall=None
        for ni in nis:
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            t=w[idx].reshape(-1,3,3)
            hh=(t[:,:,1]-DECKY)*S
            fa=(t[:,:,0]-CX).mean(1)*S; la=(t[:,:,2]-CZ).mean(1)*S; ys=hh.mean(1)
            hmax=hh.max(1); hmin=hh.min(1)
            e1=t[:,1]-t[:,0]; e2=t[:,2]-t[:,0]
            fn=np.cross(e1,e2); nl=np.linalg.norm(fn,axis=1)+1e-12
            ny=fn[:,1]/nl
            keepm=np.zeros(len(t),bool)
            for f0,f1,l0,l1 in KEEP: keepm|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)
            zic=np.zeros(len(t),bool)
            for f0,f1,l0,l1 in NO_KEEP: zic|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)
            keepm&=~zic
            island=(fa>ISL[0])&(fa<ISL[1])&(la>ISL[2])
            # crest: up-facing flat-ish plate wholly near deck level. The mean-height band
            # misses platform tops attached to below-deck structure (elevator/overhang skins
            # average below -1.2 and survived as shredded wedge fans); crest catches them.
            crest=(ny>0.5)&(hmax>0.30)&(hmax<1.6)&(hmin>-0.6)
            band=(((ys>-1.2)&(ys<1.8))|crest)&~keepm
            apron=island&(((ys>-1.2)&(ys<1.05))|crest)&(np.abs(ny)>0.5)&~keepm
            pokes=(hmax>0.05)&(hmax<1.8)&(ys<=-1.2)&~keepm&~island
            fkill=np.zeros(len(t),bool)
            for f0,f1,l0,l1,h0,h1 in FENCE_KILL:
                fkill|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)&(ys>h0)&(ys<h1)
            if dark:   # dome platforms: kill only the black bulwark, never the white dome shell
                for f0,f1,l0,l1,h0,h1 in FENCE_KILL_DARK:
                    fkill|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)&(ys>h0)&(ys<h1)
            if mi>=0 and mats[mi].get('name')=='material_5':   # OLS datum-arm bar only
                for f0,f1,l0,l1,h0,h1 in OLS_TRIM:
                    fkill|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)&(ys>h0)&(ys<h1)
            # life-raft zones: kill everything authored whatever the material -
            # the racks' brackets span materials beyond RACK_MATS and read as
            # junk on the fascia once the rafts are gone. Inside the outline the
            # band rules already kill regardless of colour; this widens only the
            # outboard part.
            rz=np.zeros(len(t),bool)
            for f0,f1,l0,l1 in RAFT_ZONES:
                rz|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)&(ys>-2.2)&(ys<1.4)
            for i3 in np.where(rz)[0]:
                # the stbd-forward zone bbox spans the elevator notches: without this
                # bound it swallows deck-interior fittings up to 19 m inboard
                if arc_project(fa[i3],la[i3])[1]>3.2: rz[i3]=False
                elif on_dome_platform(fa[i3],la[i3]): rz[i3]=False   # a neighbouring rack's zone margin must not reach a radome either
            fkill|=rz
            if not (col is not None and (max(col[:3])-min(col[:3]))>0.12):   # saturated border paint survives
                # any tri touching the platform band dies unless rooted deep (hull fascia
                # spans many metres down; under-platform braces root at -1..-2 and die)
                eband=((ys>-0.10)&(ys<1.3))|((hmax>-0.05)&(hmax<1.3)&(hmin>-2.5))
                for f0,f1,l0,l1 in ELEV_CLEAR:
                    fkill|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)&eband&~keepm
            cand=(band&~island)|apron|pokes
            kill=np.zeros(len(t),bool)
            ci=np.where(cand)[0]
            if len(ci):
                inset=inpoly_vec(fa[ci],la[ci],P_inset)
                ring=inpoly_vec(fa[ci],la[ci],P_ring)
                base=inpoly_vec(fa[ci],la[ci],P_base)
                pk=pokes[ci]
                endzone=np.abs(fa[ci])>150
                abovedeck=ys[ci]>-0.15
                # preserve the deck-edge catwalk (ledges, racks, railings below
                # and outboard of the edge): kill fully inside the outline
                # (base); in the 0..2 m outboard margin kill only what rises
                # above the deck surface (hmax > 0.60, deck top ~0.66). The bow
                # walkways sit at ys +0.2..0.4, so a ys threshold wipes them.
                margin=ring&~base
                bandpoly=np.where(np.abs(fa[ci])>160, base&abovedeck, base|(margin&(hmax[ci]>0.60)))
                # pokes: bow/stern round-downs need the inset (forecastle front faces died
                # without it); on the long edges the base outline is safe (it is already
                # 0.30 m inboard of the plate edge) and kills elevator-rim webs the inset missed
                kill[ci]=np.where(pk, np.where(endzone,inset,base), bandpoly)
            kill|=fkill
            killall=kill if killall is None else (killall&kill)
            if dark:
                isl2=(fa>ISL[0]-3)&(fa<ISL[1]+3)&(la>ISL[2]-3)&(la<50)&(ys>-1)&(ys<14)
                dz=(np.abs(ys)<3.5)
                dm=np.zeros(len(t),bool)
                dj=np.where(dz&~isl2)[0]
                if len(dj): dm[dj]=inpoly_vec(fa[dj],la[dj],P_r12)
                steelall=isl2 if steelall is None else (steelall&isl2)     # island equipment: steel
                deckall=dm if deckall is None else (deckall&dm)            # deck zone: deck tone
            elif pale:
                domebox=np.zeros(len(t),bool)
                for f0,f1,l0,l1 in DOME_KEEP: domebox|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)
                flat=(ny>0.8)&(hmin>-0.35)&(hmax<1.05)&~domebox
                dm=np.zeros(len(t),bool)
                dj=np.where(flat)[0]
                if len(dj): dm[dj]=inpoly_vec(fa[dj],la[dj],P_r12)
                deckall=dm if deckall is None else (deckall&dm)
        if killall is None: continue
        tri=idx.reshape(-1,3)
        smask=steelall if steelall is not None else np.zeros(len(tri),bool)
        dmask=(deckall if deckall is not None else np.zeros(len(tri),bool))&~smask
        steel_tris=tri[smask&~killall]
        deck_tris=tri[dmask&~killall]
        keep_tris=tri[~smask&~dmask&~killall]
        deleted+=int(killall.sum())
        if len(steel_tris):
            resplit+=len(steel_tris)
            newprims.append({'attributes':dict(p['attributes']),'indices':addidx(steel_tris.ravel().astype(np.uint32)),'material':GREY})
        if len(deck_tris):
            resplit+=len(deck_tris)
            newprims.append({'attributes':dict(p['attributes']),'indices':addidx(deck_tris.ravel().astype(np.uint32)),'material':DTONE})
        if len(keep_tris)==0:
            mesh['primitives'].remove(p)
        elif killall.sum() or len(steel_tris) or len(deck_tris):
            p['indices']=addidx(keep_tris.ravel().astype(np.uint32))
    mesh['primitives'].extend(newprims)
print(f"band clear: deleted {deleted}, repainted {resplit}")

# --- 2a. walkway clear (the plan is 1c) ---
walked=0
for mi2,nis in inst.items():
    mesh=G['meshes'][mi2]
    for p in list(mesh['primitives']):
        pos_ai=p['attributes'].get('POSITION')
        if pos_ai is None: continue
        v=readA(pos_ai).astype(np.float64)
        idx=readA(p['indices']).ravel().astype(np.int64) if 'indices' in p else np.arange(len(v),dtype=np.int64)
        idx=idx[:len(idx)//3*3]
        if not len(idx): continue
        killall=None
        for ni in nis:
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            vf=(w[:,0]-CX)*S; vl=(w[:,2]-CZ)*S; vh=(w[:,1]-DECKY)*S
            ti=idx.reshape(-1,3)
            kill=in_walkway(vf[ti],vl[ti],vh[ti])
            killall=kill if killall is None else (killall&kill)
        if killall is None or not killall.any(): continue
        walked+=int(killall.sum())
        keep_tris=idx.reshape(-1,3)[~killall]
        if len(keep_tris): p['indices']=addidx(keep_tris.ravel().astype(np.uint32))
        else: mesh['primitives'].remove(p)
print(f"walkway clear: deleted {walked}; catwalk segments {int(WALK_OK[1].sum())} starboard, {int(WALK_OK[-1].sum())} port")

# --- 2b. interior purge: delete polygons invisible from anywhere outside ---
# Voxelize occupancy (0.75 m), flood "outside air" from the bounds (flows through real
# openings, so anything visible through a hole is reachable and stays). A triangle dies
# ONLY if the probes on BOTH sides of its face land in sealed, unreachable, EMPTY air.
print("interior purge: voxelizing...")
VOX=0.75
allmin=np.array([1e18]*3); allmax=np.array([-1e18]*3)
tri_cache=[]
for mi2,nis in inst.items():
    mesh=G['meshes'][mi2]
    for p in mesh['primitives']:
        pos_ai=p['attributes'].get('POSITION')
        if pos_ai is None: continue
        v=readA(pos_ai).astype(np.float64)
        if 'indices' in p: idx=readA(p['indices']).ravel().astype(np.int64)
        else: idx=np.arange(len(v),dtype=np.int64)
        idx=idx[:len(idx)//3*3]
        for ni in nis:
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            t=(w[idx].reshape(-1,3,3)*S)   # metres
            tri_cache.append((mi2,ni,p,t))
            if len(t):
                allmin=np.minimum(allmin,t.reshape(-1,3).min(0)); allmax=np.maximum(allmax,t.reshape(-1,3).max(0))
orig0=allmin-VOX*2; dims=np.ceil((allmax-orig0)/VOX).astype(int)+3
occ=np.zeros(dims,dtype=bool)
for _,_,_,t in tri_cache:
    if not len(t): continue
    e1=t[:,1]-t[:,0]; e2=t[:,2]-t[:,0]
    L=np.maximum(np.linalg.norm(e1,axis=1),np.linalg.norm(e2,axis=1))
    for i2 in range(len(t)):
        n2=max(1,int(L[i2]/ (VOX*0.6))+1)
        us,vs=np.meshgrid(np.linspace(0,1,n2+1),np.linspace(0,1,n2+1))
        m=(us+vs)<=1.0
        pts=t[i2,0][None,:]+np.outer(us[m],e1[i2])+np.outer(vs[m],e2[i2])
        ijk=((pts-orig0)/VOX).astype(int)
        occ[ijk[:,0],ijk[:,1],ijk[:,2]]=True
print(f"  occupancy {occ.sum():,} voxels of {occ.size:,}")
# the flat deck polygon is added AFTER this pass — voxelize it as a lid now, or the whole
# hull interior is "reachable" through the open deck band and nothing gets purged
dy_vox=int((DECKY*S-orig0[1])/VOX)
gx=np.arange(dims[0])*VOX+orig0[0]+VOX/2
gz=np.arange(dims[2])*VOX+orig0[2]+VOX/2
fa_ax=(gx- CX*S)/1.0; la_ax=(gz- CZ*S)/1.0
FF,LL=np.meshgrid(fa_ax,la_ax,indexing='ij')
flat=np.zeros(FF.shape,bool)
ff=FF.ravel(); ll=LL.ravel()
sel=inpoly_vec(ff,ll,P_base)
flat=sel.reshape(FF.shape)
occ[:,dy_vox,:][flat]=True
occ[:,dy_vox+1,:][flat]=True
print(f"  deck lid voxels added at layer {dy_vox}")
outside=np.zeros(dims,dtype=bool)
outside[0,:,:]=~occ[0,:,:]; outside[-1,:,:]=~occ[-1,:,:]
outside[:,0,:]|=~occ[:,0,:]; outside[:,-1,:]|=~occ[:,-1,:]
outside[:,:,0]|=~occ[:,:,0]; outside[:,:,-1]|=~occ[:,:,-1]
empty=~occ
while True:
    grown=outside.copy()
    grown[1:,:,:]|=outside[:-1,:,:]; grown[:-1,:,:]|=outside[1:,:,:]
    grown[:,1:,:]|=outside[:,:-1,:]; grown[:,:-1,:]|=outside[:,1:,:]
    grown[:,:,1:]|=outside[:,:,:-1]; grown[:,:,:-1]|=outside[:,:,1:]
    grown&=empty
    if grown.sum()==outside.sum(): break
    outside=grown
sealed=empty&~outside
print(f"  outside air {outside.sum():,}, sealed air {sealed.sum():,}")
def vox_state(pts):   # 0=outside/oob, 1=occupied, 2=sealed-empty
    ijk=((pts-orig0)/VOX).astype(int)
    oob=(ijk<0).any(1)|(ijk>=dims[None,:]).any(1)
    ijk=np.clip(ijk,0,np.array(dims)-1)
    st=np.where(occ[ijk[:,0],ijk[:,1],ijk[:,2]],1,np.where(outside[ijk[:,0],ijk[:,1],ijk[:,2]],0,2))
    st[oob]=0
    return st
per_prim={}
for mi2,ni,p,t in tri_cache:
    if not len(t): continue
    e1=t[:,1]-t[:,0]; e2=t[:,2]-t[:,0]
    fn=np.cross(e1,e2); nl=np.linalg.norm(fn,axis=1,keepdims=True)+1e-12
    fn=fn/nl
    c=t.mean(1)
    sA=vox_state(c+fn*0.9); sB=vox_state(c-fn*0.9)
    interior=(sA==2)&(sB==2)
    k=id(p)
    if k in per_prim:
        pm,pmi=per_prim[k]
        per_prim[k]=(pm&interior,pmi)
    else:
        per_prim[k]=(interior,(mi2,p))
purged=0
for k,(interior,(mi2,p)) in per_prim.items():
    if not interior.any(): continue
    if 'indices' in p: idx=readA(p['indices']).ravel().astype(np.int64)
    else:
        v=readA(p['attributes']['POSITION'])
        idx=np.arange(len(v),dtype=np.int64)
    idx=idx[:len(idx)//3*3]
    tri=idx.reshape(-1,3)
    keep_tris=tri[~interior]
    purged+=int(interior.sum())
    if len(keep_tris)==0:
        if p in G['meshes'][mi2]['primitives']: G['meshes'][mi2]['primitives'].remove(p)
    else:
        p['indices']=addidx(keep_tris.ravel().astype(np.uint32))
print(f"interior purge: {purged} sealed-interior tris removed")

# --- 4a. railings ---
def box_tris(cfa,cla,ch,dfa,dla,dh,ang=0.0):
    ca,sa=np.cos(ang),np.sin(ang)
    corners=[]
    for sx in(-1,1):
        for sy in(-1,1):
            for sz in(-1,1):
                x=sx*dfa; y2=sy*dla
                f=cfa+x*ca-y2*sa; l=cla+x*sa+y2*ca
                corners.append((f,l,ch+sz*dh))
    C=np.array(corners)
    F=[(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]
    out=[]
    for a,b2,c2,d2 in F:
        out.append([C[a],C[b2],C[c2]]); out.append([C[a],C[c2],C[d2]])
    return np.array(out).reshape(-1,3)
def railing_run(p0,p1,base=0.0,H=0.9):
    f0,l0=p0; f1,l1=p1
    L=np.hypot(f1-f0,l1-l0)
    if L<0.3: return np.zeros((0,3))
    ang=np.arctan2(l1-l0,f1-f0)
    mfa,mla=(f0+f1)/2,(l0+l1)/2
    parts=[]
    nposts=max(2,int(L/1.4)+1)
    for i in range(nposts):
        t=i/(nposts-1)
        parts.append(box_tris(f0+(f1-f0)*t,l0+(l1-l0)*t,base+H/2,0.035,0.035,H/2))
    parts.append(box_tris(mfa,mla,base+H-0.02,L/2,0.028,0.028,ang))
    parts.append(box_tris(mfa,mla,base+H*0.52,L/2,0.024,0.024,ang))
    return np.concatenate(parts)
def railing_ring(f0,f1,l0,l1,base=0.0,H=0.9):
    return np.concatenate([railing_run((f0,l0),(f1,l0),base,H), railing_run((f1,l0),(f1,l1),base,H),
                           railing_run((f1,l1),(f0,l1),base,H), railing_run((f0,l1),(f0,l0),base,H)])
def railing_loop(points,base=0.0,H=0.9,spacing=1.4):
    # a closed railing round a polygon: both rails along every side, posts walked
    # along the perimeter at about `spacing` (railing_run would double them at each corner)
    P=np.array(points+points[:1],dtype=np.float64); parts=[]
    side=np.hypot(*np.diff(P,axis=0).T); total=side.sum()
    for (f0,l0),(f1,l1),L in zip(P[:-1],P[1:],side):
        ang=np.arctan2(l1-l0,f1-f0); mfa,mla=(f0+f1)/2,(l0+l1)/2
        parts.append(box_tris(mfa,mla,base+H-0.02,L/2,0.028,0.028,ang))
        parts.append(box_tris(mfa,mla,base+H*0.52,L/2,0.024,0.024,ang))
    n=max(3,int(round(total/spacing))); at=np.cumsum(np.r_[0,side])
    for k in range(n):
        d=k*total/n; i=min(int(np.searchsorted(at,d,side='right'))-1,len(side)-1); t=(d-at[i])/side[i]
        parts.append(box_tris(*(P[i]+(P[i+1]-P[i])*t),base+H/2,0.035,0.035,H/2))
    return np.concatenate(parts)
# The two radome platforms' railings stand on the platform and follow its edge 0.15 m
# inboard, no further than 0.6 m beyond the dome (the port platform's outboard corners
# are rounded, and a rectangle overhangs them). Measured from the built GLB by tracing
# the platform edge out from the dome centre every 30 deg at platform height. fa,
# pre-squash lat.
DOME_RAILS=[([(57.69,-42.94),(57.97,-41.75),(57.14,-40.88),(56.0,-40.56),(54.86,-40.88),(54.03,-41.75),
              (54.31,-42.94),(54.54,-43.82),(55.1,-44.55),(56.0,-44.86),(56.9,-44.55),(57.46,-43.82)],-1.483),
            ([(-148.05,25.78),(-148.43,27.25),(-149.7,27.9),(-150.87,27.79),(-151.96,27.74),(-153.31,27.25),
              (-153.69,25.78),(-153.31,24.31),(-152.28,23.25),(-150.87,23.08),(-149.46,23.24),(-148.43,24.31)],-2.16)]
def deck_h(faq):   # deck surface height at this fa (flat cross-section at the rim height). v43
    faarr=[OUT[i][0] for i in range(NS)]   # raised the deck ~0.65 m, so flight-deck features
    i=int(np.clip(np.searchsorted(faarr,faq)-1,0,NS-2))   # (railings, cabs) must sit ON it, not at h=0
    return (RIMH[i]+RIMH[2*NS-1-i])/2
# flight-deck railings (island walkway + ammo-elevator rings): base on the raised deck. No
# deck-edge railings: the catwalks they guarded die in the band clear, so the short runs
# that once stood there hung off the hull with nothing beneath them.
R=[railing_run((-89.37,22.58),(-33.76,22.58),deck_h(-61),0.9),
   railing_run((-33.76,22.58),(-33.76,19.2),deck_h(-34),0.9),
   railing_run((-89.37,22.58),(-89.37,19.2),deck_h(-89),0.9),
   railing_ring(-47.81,-43.15,16.63,18.81,deck_h(-45),0.9),
   railing_ring(-60.82,-56.17,20.40,22.58,deck_h(-58),0.9)]+[railing_loop(p,base) for p,base in DOME_RAILS]
RAILS=np.concatenate(R)
RAILS[:,1]*=S_LAT   # railing sites were measured pre-squash; follow the deck

def add_soup(verts, mat_idx, name, deckframe):
    global B
    n2=len(verts)
    if n2==0: return
    if deckframe:
        wpos=np.empty_like(verts)
        wpos[:,0]=CX+verts[:,0]/S; wpos[:,1]=DECKY+verts[:,2]/S; wpos[:,2]=CZ+verts[:,1]/S
        # (fa, lat, h) -> (x, y, z) swaps two axes, a mirror that reverses every triangle's
        # winding: swap two corners back so a face wound outward in the deck frame faces
        # outward in the model. Without it the underside plate faced up and was culled from
        # below (sky through the deck), and the railings rendered inside out.
        pos=wpos.reshape(-1,3,3)[:,[0,2,1]].reshape(-1,3).astype(np.float32)
    else:
        pos=verts.astype(np.float32)
    tw=pos.reshape(-1,3,3).astype(np.float64)
    e1=tw[:,1]-tw[:,0]; e2=tw[:,2]-tw[:,0]
    fn=np.cross(e1,e2); nl=np.linalg.norm(fn,axis=1,keepdims=True)+1e-12
    nrm=np.repeat(fn/nl,3,axis=0).astype(np.float32)
    while len(B)%4: B.append(0)
    o1=len(B); B.extend(pos.tobytes())
    bvs.append({'buffer':0,'byteOffset':o1,'byteLength':pos.nbytes,'target':34962})
    acc.append({'bufferView':len(bvs)-1,'byteOffset':0,'componentType':5126,'count':n2,'type':'VEC3','min':[float(x) for x in pos.min(0)],'max':[float(x) for x in pos.max(0)]})
    A_P=len(acc)-1
    while len(B)%4: B.append(0)
    o2=len(B); B.extend(nrm.tobytes())
    bvs.append({'buffer':0,'byteOffset':o2,'byteLength':nrm.nbytes,'target':34962})
    acc.append({'bufferView':len(bvs)-1,'byteOffset':0,'componentType':5126,'count':n2,'type':'VEC3'})
    A_N=len(acc)-1
    G['meshes'].append({'name':name,'primitives':[{'attributes':{'POSITION':A_P,'NORMAL':A_N},'material':mat_idx}]})
    nodes.append({'name':name,'mesh':len(G['meshes'])-1})
    G['scenes'][G.get('scene',0)]['nodes'].append(len(nodes)-1)

matbyname={m.get('name'):i for i,m in enumerate(mats)}
add_soup(RAILS, RAIL, 'railings', True)

# --- deck-edge fascia skirt --- The band clear removes the original fascia and
# the flat deck strip replaces only the top surface, so the deck edge would
# float above the hull side with the interior visible below. A vertical skirt
# from each outline edge down 2 m closes the gap: double-sided (both windings),
# at the outline (0.30 m inboard of the plate edge, so it never pokes through
# the hull).
SKIRT_DROP=2.0
skirt=[]
NPOLY=len(OUT)
for i in range(NPOLY):
    j=(i+1)%NPOLY
    (f0,l0),(f1,l1)=OUT[i],OUT[j]; h0=RIMH[i]; h1=RIMH[j]
    p0=(f0,l0,h0); p1=(f1,l1,h1); p2=(f0,l0,h0-SKIRT_DROP); p3=(f1,l1,h1-SKIRT_DROP)
    skirt+=[p0,p1,p3, p0,p3,p2,  p0,p3,p1, p0,p2,p3]   # both windings -> double-sided
add_soup(np.array(skirt,dtype=np.float64), GREY, 'deck_skirt', True)

# --- 4b. deck-edge catwalks and life-raft racks ---
# Generated whole, on the runs 2a planned: a solid floor hung on the skirt WALK_DROP
# below the rim, a railing along its outer edge with returns at each end, braces down to
# the skirt, and in the authored raft zones racks of canisters stacked two high on the
# rail side. Every piece is a convex solid wound away from its own centre, and every
# rack is a rigid straight unit on a straight stretch of edge - nothing bends to follow
# the deck.
RAFT_LEN=1.65; RAFT_R=0.45; RAFT_GAP=0.06; RAFT_RACK=5; RAFT_RACK_GAP=0.25; RAFT_COUNT=242   # 65 x 35 in canisters, 25-person rafts
# where racks may go (fa spans per side): every catwalk aft of the bows, which the
# 2013-2017 photographs show bare. The full complement needs nearly all of it; if the
# catwalks hold more, columns are dropped evenly down to RAFT_COUNT.
RAFT_RUNS={1:[(-170,97)], -1:[(-170,97)]}
def outward(t,centres):
    # wind each triangle away from its piece's centre (one centre, or one per triangle)
    t=np.array(t,np.float64).reshape(-1,3,3)
    c=np.broadcast_to(np.asarray(centres,np.float64),(len(t),3))
    nrm=np.cross(t[:,1]-t[:,0],t[:,2]-t[:,0])
    flip=((t.mean(1)-c)*nrm).sum(1)<0
    t[flip]=t[flip][:,[0,2,1]]
    return t.reshape(-1,3)
# --- catapult control cabs (cabs.py): a steel frame in the island's grey round ten windows of
# dark tinted glass, two on each long side, one on each end and one on each corner; walls
# sloping in to a flat roof with a round hatch (Navy photographs). The glass is opaque: the
# see-through blue the island's windows use made the cab read as a pale glass dome.
CAB_END_IN, CAB_SIDE_IN, CAB_TOP_CHAMFER = 0.33, 0.18, 0.38   # the roof octagon, inset from the base
CAB_SILL, CAB_HEAD = 0.10, 0.50      # the window band, above the deck
CAB_POST, CAB_MULLION = 0.07, 0.12   # frame at each face's ends, and between a long side's two windows
def cab_soup(cab, deck):
    c, u, w = cab_axes(cab)
    def at(q, z): return np.array([c[0]+q[0]*u[0]+q[1]*w[0], c[1]+q[0]*u[1]+q[1]*w[1], z])
    z0, z1 = deck-0.03, deck+CAB_HEIGHT   # the walls start just under the deck surface
    za, zb = deck+CAB_SILL, deck+CAB_HEAD
    lo = cab_octagon(CAB_LENGTH, CAB_WIDTH, CAB_CHAMFER)
    hi = cab_octagon(CAB_LENGTH-2*CAB_END_IN, CAB_WIDTH-2*CAB_SIDE_IN, CAB_TOP_CHAMFER)
    frame, glass = [], []
    def quad(out, a, b, c2, d): out.extend([a, b, c2, a, c2, d])
    for k in range(8):
        windows = 2 if k in (1, 5) else 1   # faces 1 and 5 are the long sides
        def point(s, z):   # s metres along this face from its first corner, at height z
            v = (z-z0)/(z1-z0)
            p0 = lo[k]+(hi[k]-lo[k])*v; p1 = lo[(k+1)%8]+(hi[(k+1)%8]-lo[(k+1)%8])*v
            return at(p0+(p1-p0)*s/np.linalg.norm(p1-p0), z)
        def cuts(z):   # where frame and glass alternate along the face at height z; the last is its length
            v = (z-z0)/(z1-z0)
            n = np.linalg.norm((lo[(k+1)%8]-lo[k])*(1-v)+(hi[(k+1)%8]-hi[k])*v)
            pane = (n-2*CAB_POST-(windows-1)*CAB_MULLION)/windows
            return [0.0]+[x for i in range(windows) for x in (CAB_POST+i*(pane+CAB_MULLION), CAB_POST+i*(pane+CAB_MULLION)+pane)]+[n]
        ca, cb = cuts(za), cuts(zb)
        quad(frame, point(0, z0), point(cuts(z0)[-1], z0), point(ca[-1], za), point(0, za))   # below the windows
        quad(frame, point(0, zb), point(cb[-1], zb), point(cuts(z1)[-1], z1), point(0, z1))   # above them
        for j in range(len(ca)-1):
            quad(glass if j % 2 else frame, point(ca[j], za), point(ca[j+1], za), point(cb[j+1], zb), point(cb[j], zb))
    for k in range(1, 7):   # the roof
        frame.extend([at(hi[0], z1), at(hi[k], z1), at(hi[k+1], z1)])
    middle = np.array([c[0], c[1], deck+0.3])
    frame = list(outward(frame, middle)); glass = list(outward(glass, middle))
    hx, hr, hh = CAB_HATCH; hc = at((hx, 0.0), z1); ring = [hc+hr*np.array([*(np.cos(q)*u+np.sin(q)*w), 0.0]) for q in np.linspace(0, 2*np.pi, 17)[:-1]]
    hatch = []
    for j in range(16):
        a, b = ring[j], ring[(j+1) % 16]; up = np.array([0, 0, hh])
        quad(hatch, a, b, b+up, a+up); hatch.extend([hc+up, a+up, b+up])
    frame += list(outward(hatch, hc+np.array([0, 0, hh/2])))
    return np.array(frame), np.array(glass)
mats.append({'name':'iccs_glass','pbrMetallicRoughness':{'baseColorFactor':[0.035,0.060,0.055,1.0],'metallicFactor':0.0,'roughnessFactor':0.12}})
CAB_GLASS=len(mats)-1
_cabs=[cab_soup(cab, deck_h(cab[0])) for cab in CABS]
add_soup(np.concatenate([f for f,_ in _cabs]), matbyname['material_38'], 'iccs_cab', True)
add_soup(np.concatenate([g for _,g in _cabs]), CAB_GLASS, 'iccs_glass', True)
def hexa(c8,caps=True):
    # convex hexahedron: c8[0:4] one end, c8[4:8] the other, corners in the same order
    b=c8[:4]; u=c8[4:]
    quads=[(b[i],b[(i+1)%4],u[(i+1)%4],u[i]) for i in range(4)]+([(b[0],b[1],b[2],b[3]),(u[0],u[1],u[2],u[3])] if caps else [])
    return outward([v for a,bb,c,d in quads for v in (a,bb,c,a,c,d)],np.mean(c8,0))
def bar(p0,p1,w,h,ref,caps=False):
    # a w x h bar from p0 to p1; ref is a direction the w side lies along when the bar is vertical
    p0=np.asarray(p0,float); p1=np.asarray(p1,float); a=(p1-p0)/np.linalg.norm(p1-p0)
    up=np.array([0,0,1.0]) if abs(a[2])<0.9 else np.asarray(ref,float)
    s1=np.cross(a,up); s1/=np.linalg.norm(s1); s2=np.cross(a,s1)
    return hexa(np.array([p+e1*s1*w/2+e2*s2*h/2 for p in (p0,p1) for e1,e2 in ((1,1),(-1,1),(-1,-1),(1,-1))]),caps)
def add_mesh(pos,nrm,tri,mat_idx,name):
    # an indexed, smooth-normalled mesh from the deck frame (fa, lat, h); the frame swap is a
    # mirror, so the winding is reversed on the way out, as add_soup does
    global B
    wpos=np.stack([CX+pos[:,0]/S,DECKY+pos[:,2]/S,CZ+pos[:,1]/S],1).astype(np.float32)
    wnrm=np.stack([nrm[:,0],nrm[:,2],nrm[:,1]],1).astype(np.float32)
    idx=np.asarray(tri,np.uint32)[:,[0,2,1]].ravel()
    ais=[]
    for arr,target,ctype,typ in ((wpos,34962,5126,'VEC3'),(wnrm,34962,5126,'VEC3'),(idx,34963,5125,'SCALAR')):
        while len(B)%4: B.append(0)
        o=len(B); B.extend(arr.tobytes())
        bvs.append({'buffer':0,'byteOffset':o,'byteLength':arr.nbytes,'target':target})
        a={'bufferView':len(bvs)-1,'byteOffset':0,'componentType':ctype,'count':len(arr),'type':typ}
        if typ=='VEC3' and not ais: a['min']=[float(x) for x in arr.min(0)]; a['max']=[float(x) for x in arr.max(0)]
        acc.append(a); ais.append(len(acc)-1)
    G['meshes'].append({'name':name,'primitives':[{'attributes':{'POSITION':ais[0],'NORMAL':ais[1]},'indices':ais[2],'material':mat_idx}]})
    nodes.append({'name':name,'mesh':len(G['meshes'])-1})
    G['scenes'][G.get('scene',0)]['nodes'].append(len(nodes)-1)
def canister(centre,e,o,pos,nrm,tri,straps):
    # a canister lying along e (horizontal), o its horizontal outward: domed ends, two straps
    z=np.array([0,0,1.0]); k=8; ang=np.arange(k)*2*np.pi/k
    ring=lambda x,r,ax: [(centre+x*e+r*(np.cos(q)*o+np.sin(q)*z), np.cos(ax)*(np.cos(q)*o+np.sin(q)*z)+np.sin(ax)*np.sign(x)*e) for q in ang]
    L=RAFT_LEN/2; R=RAFT_R
    rings=[ring(-L+0.10,0.80*R,0.8),ring(-L+0.24,R,0.0),ring(L-0.24,R,0.0),ring(L-0.10,0.80*R,0.8)]
    base=len(pos)
    for rg in rings:
        for p,n_ in rg: pos.append(p); nrm.append(n_/np.linalg.norm(n_))
    for tipx,sgn in ((-L,-1),(L,1)): pos.append(centre+tipx*e); nrm.append(sgn*e)
    t0,t1=base+4*k,base+4*k+1
    for r_ in range(3):
        for j in range(k):
            a0=base+r_*k+j; a1=base+r_*k+(j+1)%k; b0=a0+k; b1=a1+k
            tri+=[(a0,b0,b1),(a0,b1,a1)]
    for j in range(k):
        tri+=[(t0,base+(j+1)%k,base+j),(t1,base+3*k+j,base+3*k+(j+1)%k)]
    for x in (-0.45,0.45):   # straps: short open tubes just proud of the shell
        c0=centre+(x-0.035)*e; c1=centre+(x+0.035)*e; rr=R+0.012
        q4=[(c+rr*(np.cos(q)*o+np.sin(q)*z)) for c in (c0,c1) for q in ang]
        for j in range(k):
            a0,a1,b0,b1=q4[j],q4[(j+1)%k],q4[k+j],q4[k+(j+1)%k]
            straps.extend(outward([a0,b0,b1,a0,b1,a1],centre+x*e))
def fix_winding(pos,tri,axis_point,axis_dir):
    # every canister triangle faces away from its axis
    P_=np.array(pos); out=[]
    for a,b,c in tri:
        n_=np.cross(P_[b]-P_[a],P_[c]-P_[a]); m=(P_[a]+P_[b]+P_[c])/3
        q=axis_point+np.dot(m-axis_point,axis_dir)*axis_dir
        out.append((a,b,c) if np.dot(n_,m-q)>=0 else (a,c,b))
    return out
WALK_MAT=matbyname['material_42']; RAFT_MAT=matbyname['material_37']; STRAP_MAT=matbyname['Charcoal']
floor=[]; rails=[]; braces=[]; racks=[]; straps=[]; cpos=[]; cnrm=[]; ctri=[]
AV2=authored_vertices()
def authored_triangles():
    # every authored triangle in the deck frame (fa, lat, h), as the model stands now
    out=[]
    for mi2,nis in inst.items():
        for p in G['meshes'][mi2]['primitives']:
            pos_ai=p['attributes'].get('POSITION')
            if pos_ai is None: continue
            v=readA(pos_ai).astype(np.float64)
            idx=readA(p['indices']).ravel().astype(np.int64) if 'indices' in p else np.arange(len(v))
            idx=idx[:len(idx)//3*3]
            for ni in nis:
                w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
                out.append(np.stack([(w[:,0]-CX)*S,(w[:,2]-CZ)*S,(w[:,1]-DECKY)*S],1)[idx].reshape(-1,3,3))
    return np.concatenate(out)
AT=authored_triangles(); ATC=AT.mean(1)
def wall_at(p2,m2,h0,h1,span):
    # the ship's side here: the furthest authored surface out along m2 from the outline point
    # p2, 0 to 1.2 m, standing over the whole height h0..h1 (a wall that stops partway is not
    # one to hang a catwalk on), sampled span either way along the edge - the catwalk starts
    # there, not inside it
    near=np.where(np.hypot(ATC[:,0]-p2[0],ATC[:,1]-p2[1])<6)[0]
    if not len(near): return 0.0
    a=AT[near,0]; e1=AT[near,1]-a; e2=AT[near,2]-a; best=0.0
    dv=np.array([m2[0],m2[1],0.0]); dv/=np.linalg.norm(dv)
    pv=np.cross(dv,e2); det=np.einsum('ij,ij->i',e1,pv); mk=np.abs(det)>1e-12
    inv=np.zeros_like(det); inv[mk]=1/det[mk]
    for side in ((-span,0.0,span) if span else (0.0,)):   # a little along the edge either way
        reach=None
        for hh in sorted({h0,h1}):
            o=np.array([p2[0],p2[1],hh])+side*np.array([-dv[1],dv[0],0.0])-dv*0.3; s_=o-a
            u=np.einsum('ij,ij->i',s_,pv)*inv; q=np.cross(s_,e1); w=np.einsum('j,ij->i',dv,q)*inv; t=np.einsum('ij,ij->i',e2,q)*inv
            hit=mk&(u>=0)&(w>=0)&(u+w<=1)&(t>0.3)&(t<1.5)
            r=float(t[hit].max())-0.3 if hit.any() else None
            reach=r if reach is None else (None if r is None else min(reach,r))
            if reach is None: break
        if reach is not None: best=max(best,reach)
    return best
def flat_overlap(T,quad,h0,h1):
    # a flat authored plate lying in a catwalk slab (h0 bottom .. h1 top, within 6 cm) over its
    # footprint: the two would z-fight, and a segment test cannot see a plane it lies in
    n_=np.cross(T[:,1]-T[:,0],T[:,2]-T[:,0]); nl=np.linalg.norm(n_,axis=1)+1e-12
    flat=(np.abs(n_[:,2])/nl>0.97)&(T[:,:,2].min(1)>h0-0.06)&(T[:,:,2].max(1)<h1+0.06)
    for t in T[flat]:
        if polygons_overlap(t[:,:2],quad): return True
    return False
def polygons_overlap(a,b):
    # two convex polygons (2D, any winding) overlap: separating-axis test
    for poly in (a,b):
        for i in range(len(poly)):
            e=poly[(i+1)%len(poly)]-poly[i]; ax=np.array([-e[1],e[0]])
            pa=a@ax; pb=b@ax
            if pa.max()<=pb.min()+1e-4 or pb.max()<=pa.min()+1e-4: return False
    return True
def slab_crosses(a0,a1,b1,b0,t0,t1):
    # does a catwalk piece (inner a0-a1, outer b0-b1, top heights t0/t1) cross an authored
    # triangle: its slab edges, a diagonal, its railing posts and the walking space over its
    # inner edge, as segments against the ship
    c=[np.array([*a0,t0]),np.array([*a1,t1]),np.array([*b1,t1]),np.array([*b0,t0])]
    lo=[q-np.array([0,0,WALK_THICK]) for q in c]; up=[np.array([*q[:2],q[2]+WALK_RAIL]) for q in c[2:]]
    upin=[np.array([*q[:2],q[2]+WALK_RAIL]) for q in c[:2]]   # the walking space over the inner edge
    segs=[(c[i],c[(i+1)%4]) for i in range(4)]+[(lo[i],lo[(i+1)%4]) for i in range(4)]+[(c[i],lo[i]) for i in range(4)]+[(c[0],c[2]),(c[2],up[0]),(c[3],up[1]),(up[0],up[1]),(c[0],upin[0]),(c[1],upin[1]),(upin[0],upin[1])]
    mid=np.mean(c,0); near=np.where(np.linalg.norm(ATC-mid,axis=1)<6)[0]
    if not len(near): return False
    if flat_overlap(AT[near],np.array([a0,a1,b1,b0]),min(t0,t1)-WALK_THICK,max(t0,t1)): return True
    a=AT[near,0]; e1=AT[near,1]-a; e2=AT[near,2]-a
    for p0,p1 in segs:
        dv=p1-p0; L=np.linalg.norm(dv); dv=dv/L
        pv=np.cross(dv,e2); det=np.einsum('ij,ij->i',e1,pv); m=np.abs(det)>1e-12
        inv=np.zeros_like(det); inv[m]=1/det[m]; s_=p0-a
        u=np.einsum('ij,ij->i',s_,pv)*inv; q=np.cross(s_,e1); w=np.einsum('j,ij->i',dv,q)*inv; t=np.einsum('ij,ij->i',e2,q)*inv
        if (m&(u>=0)&(w>=0)&(u+w<=1)&(t>0.002)&(t<L-0.002)).any(): return True
    return False
def build_run(s,zones,A,Bv,top,Np,Mp,Hp):
    # one stretch of catwalk: floor, railing, braces, end returns and its raft columns
    P,H=side_line(s); n,_=side_normals(P,s)
    for j in range(len(A)-1):   # floor: one closed slab per piece, 1 mm apart
        e=(A[j+1]-A[j])/np.linalg.norm(A[j+1]-A[j])*0.0005
        c8=[]
        for hh in (0.0,-WALK_THICK):
            for pt,tt in ((A[j]+e,top[j]),(A[j+1]-e,top[j+1]),(Bv[j+1]-e,top[j+1]),(Bv[j]+e,top[j])):
                c8.append([pt[0],pt[1],tt+hh])
        floor.extend(hexa(np.array(c8)))
    # the outer edge as a polyline with its arc length, for the railing, braces and racks
    seg_len=np.hypot(*np.diff(Bv,axis=0).T); arc=np.r_[0,np.cumsum(seg_len)]; total=arc[-1]
    def at(d):
        i=int(np.clip(np.searchsorted(arc,d,side='right')-1,0,len(seg_len)-1)); t=(d-arc[i])/max(seg_len[i],1e-9)
        return Bv[i]+(Bv[i+1]-Bv[i])*t, top[i]+(top[i+1]-top[i])*t, Np[i], Hp[i]+(Hp[i+1]-Hp[i])*t, A[i]+(A[i+1]-A[i])*t
    RIN=0.05   # the railing stands this far inboard of the floor's outer edge
    def rail_line(o,i):   # RIN in from the outer edge, along the piece's own inner-to-outer line
        return o-(o-i)*(RIN/WALK_WIDTH)
    for j in range(len(A)-1):   # top and middle rails
        for hh in (WALK_RAIL-0.02,WALK_RAIL*0.52):
            rails.extend(bar([*rail_line(Bv[j],A[j]),top[j]+hh],[*rail_line(Bv[j+1],A[j+1]),top[j+1]+hh],0.05,0.05,[0,0,1]))
    npost=max(2,int(round(total/1.4))+1)
    for q in np.linspace(0,total,npost):
        p_,tp,nn,_,inner=at(q)
        rails.extend(bar([*rail_line(p_,inner),tp],[*rail_line(p_,inner),tp+WALK_RAIL],0.06,0.06,[nn[1],-nn[0],0],caps=True))
    for q in np.linspace(0.6,total-0.6,max(2,int(total/3.0)+1)):   # braces from the floor's outer underside down to the ship's side
        p_,tp,nn,rim,inner=at(q)
        foot_h=rim-SKIRT_DROP+0.05   # the skirt's foot; where the side stands further out, the side at that height
        sg,tt,_=project(P,n,np.array([inner[0]]),np.array([inner[1]]))
        edge=P[sg[0]]+tt[0]*(P[sg[0]+1]-P[sg[0]])
        foot=edge+nn*(wall_at(edge,nn,foot_h,foot_h,0.0)+0.03)
        braces.extend(bar([*(p_-nn*0.15),tp-WALK_THICK],[*foot,foot_h],0.06,0.06,[nn[1],-nn[0],0],caps=True))
    for j in (0,len(A)-1):   # end returns: rails from the outer edge back to the side
        for hh in (WALK_RAIL-0.02,WALK_RAIL*0.52):
            rails.extend(bar([*rail_line(Bv[j],A[j]),top[j]+hh],[*(A[j]+Mp[j]*0.03),top[j]+hh],0.05,0.05,[0,0,1]))
        rails.extend(bar([*(A[j]+Mp[j]*0.06),top[j]],[*(A[j]+Mp[j]*0.06),top[j]+WALK_RAIL],0.06,0.06,[Mp[j][1],-Mp[j][0],0],caps=True))
    # raft columns along this run, inside a raft zone, on straight stretches, clear of authored geometry
    d=0.2; placed=0   # clear of the end returns
    while d+RAFT_LEN<=total-0.2:
        p0=at(d)[0]; p1=at(d+RAFT_LEN)[0]; chord=p1-p0; cl=np.linalg.norm(chord); e2=chord/cl
        if not any(f0<=min(p0[0],p1[0]) and max(p0[0],p1[0])<=f1 for f0,f1 in zones): d+=0.25; continue
        inner=[at(x)[0] for x in np.linspace(d,d+RAFT_LEN,7)]
        dev=max(abs(e2[0]*(q[1]-p0[1])-e2[1]*(q[0]-p0[0])) for q in inner)
        if dev>0.08: d+=0.25; continue   # a straight rack on a gently curving edge: at most 8 cm off it
        o2=np.array([e2[1],-e2[0]]); o2*=np.sign(np.dot(o2,at(d+RAFT_LEN/2)[2]))
        ends=np.array([p0,p1])+o2*(0.08+RAFT_R)   # the canisters' end points
        sg,tt,_=project(P,n,ends[:,0],ends[:,1])
        q=P[sg]+tt[:,None]*(P[sg+1]-P[sg]); ec=(q[1]-q[0])/np.linalg.norm(q[1]-q[0])
        if abs(e2[0]*ec[1]-e2[1]*ec[0])>np.sin(np.radians(1.9)): d+=0.25; continue   # and along the deck edge under them (edgecheck allows 2)
        rim=at(d+RAFT_LEN/2)[3]
        hu=rim-0.05-RAFT_R; hl=hu-2*RAFT_R-0.08
        rel=AV2[:,:2]-p0; ax=rel@e2; ou=rel@o2
        clash=(ax>-0.1)&(ax<cl+0.1)&(ou>-0.05)&(ou<2*RAFT_R+0.2)&(AV2[:,2]>hl-RAFT_R-0.2)&(AV2[:,2]<hu+RAFT_R+0.1)
        if clash.any(): d+=0.25; continue
        columns.append((s,p0,e2,o2,cl,hu,hl)); placed+=1
        d+=RAFT_LEN+RAFT_GAP+(RAFT_RACK_GAP if placed%RAFT_RACK==0 else 0)
columns=[]   # (side, chord start, chord end, rim, outward)
for s in (1,-1):
    P,H=side_line(s); n,Lseg=side_normals(P,s); ok=WALK_OK[s]
    k=0; runs=[]
    while k<len(ok):
        if not ok[k]: k+=1; continue
        k1=k
        while k1<len(ok) and ok[k1]: k1+=1
        if Lseg[k:k1].sum()>=6.0: runs.append((k,k1))   # segments k..k1-1, vertices k..k1; shorter is a stub between sponsons
        k=k1
    zones=RAFT_RUNS[s]
    for k0,k1 in runs:
        V=np.arange(k0,k1+1)
        m=np.zeros((len(V),2))
        for j,v in enumerate(V):   # mitred outward normals: constant width round the bends
            na=n[max(v-1,k0)]; nb=n[min(v,k1-1)]
            m[j]=(na+nb)/max(1+np.dot(na,nb),0.5)
        # the run resampled about every metre, each point measured against the ship's side
        # (the hull fascia stands up to 0.6 m outboard of the outline in places, and varies
        # along a segment): the catwalk starts on whichever is further out, skirt or side
        Pp=[]; Mp=[]; Hp=[]; Sp=[]
        for j in range(len(V)-1):
            v=V[j]; nsub=max(1,int(np.ceil(Lseg[v]/1.0)))
            for q in range(nsub):
                t=q/nsub; Pp.append(P[v]+(P[v+1]-P[v])*t); Hp.append(H[v]+(H[v+1]-H[v])*t)
                Mp.append(m[j] if q==0 else n[v]); Sp.append(v)
        Pp.append(P[V[-1]]); Hp.append(H[V[-1]]); Mp.append(m[-1]); Sp.append(V[-1]-1)
        Pp=np.array(Pp); Mp=np.array(Mp); Hp=np.array(Hp); Np=n[np.array(Sp)]
        top=Hp-WALK_DROP
        wall=np.array([wall_at(Pp[j],Mp[j],top[j]-WALK_THICK,top[j]+0.05,0.5) for j in range(len(Pp))])   # at the floor's own height
        A=Pp+Mp*(wall[:,None]+0.01); Bv=A+Mp*WALK_WIDTH
        # a piece whose slab would cross the ship (a sloping fascia, a platform) is left out
        # and the run split round it: the catwalk never passes through anything
        good=[not slab_crosses(A[j],A[j+1],Bv[j+1],Bv[j],top[j],top[j+1]) for j in range(len(Pp)-1)]
        j0=0
        while j0<len(good):
            if not good[j0]: j0+=1; continue
            j1=j0
            while j1<len(good) and good[j1]: j1+=1
            sl=slice(j0,j1+1)   # points j0..j1
            if np.hypot(*np.diff(Bv[sl],axis=0).T).sum()>=2.0:
                build_run(s,zones,A[sl],Bv[sl],top[sl],Np[sl],Mp[sl],Hp[sl])
            j0=j1
cap=len(columns)
if 2*cap>RAFT_COUNT:   # more room than rafts: drop columns evenly so the racks keep their spacing
    keep=set(np.round(np.linspace(0,cap-1,RAFT_COUNT//2)).astype(int))
    columns=[c for i,c in enumerate(columns) if i in keep]
for s,p0,e2,o2,cl,hu,hl in columns:
    E=np.array([e2[0],e2[1],0.0]); O=np.array([o2[0],o2[1],0.0]); base=np.array([p0[0],p0[1],0.0])
    uc=0.08+RAFT_R   # canister centre: outboard of the inner uprights, clear of the railing
    for hh in (hu,hl):
        c=base+E*(cl/2)+O*uc+np.array([0,0,hh])
        t0=len(ctri); canister(c,E,O,cpos,cnrm,ctri,straps)
        ctri[t0:]=fix_winding(cpos,ctri[t0:],c,E)
    for a in (0.18*cl,0.82*cl):
        foot=base+E*a
        for uu in (0.03,2*RAFT_R+0.13):   # inner and outer uprights, floor to the upper canister
            racks.extend(bar(foot+O*uu+np.array([0,0,hl-RAFT_R-0.10]),foot+O*uu+np.array([0,0,hu]),0.06,0.06,E))
        for hh in (hu,hl):   # cradle arms, their tops at the canister's underside
            racks.extend(bar(foot+np.array([0,0,hh-RAFT_R-0.03]),foot+O*(2*RAFT_R+0.16)+np.array([0,0,hh-RAFT_R-0.03]),0.06,0.06,E))
cpos=np.array(cpos); cnrm=np.array(cnrm); ctri=np.array(ctri)
add_soup(np.array(floor),WALK_MAT,'catwalk',True)
add_soup(np.array(rails),RAIL,'catwalk_railings',True)
add_soup(np.array(braces),GREY,'catwalk_braces',True)
if len(columns):
    add_soup(np.array(racks),GREY,'raft_racks',True)
    add_soup(np.array(straps),STRAP_MAT,'raft_straps',True)
    add_mesh(cpos,cnrm,ctri,RAFT_MAT,'raft_canisters')
print(f"catwalks: {len(floor)//3} floor, {len(rails)//3} railing, {len(braces)//3} brace triangles; "
      f"rafts: {2*len(columns)} canisters on {len(columns)} columns (room for {2*cap}), {len(ctri)+len(straps)//3+len(racks)//3} triangles")
# Give each strip vertex the measured hull rim height, smoothed along the outline — the deck
# stays smooth and effectively flat but meets the hull rim flush (no lip, no sawtooth).
rim_h=np.array(RIMH)
print('  rim heights: min %.2f max %.2f'%(rim_h.min(),rim_h.max()))
png=open(TEX,'rb').read()
while len(B)%4: B.append(0)
imgoff=len(B); B.extend(png)
bvs.append({'buffer':0,'byteOffset':imgoff,'byteLength':len(png)})
G.setdefault('images',[]).append({'mimeType':'image/png','bufferView':len(bvs)-1})
G.setdefault('samplers',[]).append({'magFilter':9729,'minFilter':9987,'wrapS':33071,'wrapT':33071})
G.setdefault('textures',[]).append({'source':len(G['images'])-1,'sampler':len(G['samplers'])-1})
mats.append({'name':'deck_baked','pbrMetallicRoughness':{'baseColorTexture':{'index':len(G['textures'])-1},'metallicFactor':0.0,'roughnessFactor':0.92}})
MDECK=len(mats)-1
FA0,FA1,LA0,LA1=-172.0,172.0,-52.0,48.0
# 4 columns per station, all at the measured hull-rim height: the real deck is
# flat across (sinking the inner columns to DECKY made each cross-section a
# bowl). CARRIER.deckY is raycast from the drawn deck, so physics follows. Rim
# height varies fore-aft (sheer + round-downs), so the deck follows the sheer
# along its length.
stbd=OUT[:NS]; port=[OUT[2*NS-1-i] for i in range(NS)]
hs_stbd=[rim_h[i] for i in range(NS)]; hs_port=[rim_h[2*NS-1-i] for i in range(NS)]
APRON=6.0
pos=[]; uv=[]; nrm=[]; stations=[]
for i in range(NS):
    (fs,ls),(fp,lp)=stbd[i],port[i]
    dx,dl=fp-fs,lp-ls
    Lw=max(np.hypot(dx,dl),1e-6)
    a=min(APRON/Lw,0.45)
    cols=[(fs,ls,hs_stbd[i]),
          (fs+dx*a,ls+dl*a,hs_stbd[i]),
          (fp-dx*a,lp-dl*a,hs_port[i]),
          (fp,lp,hs_port[i])]
    stations.append(cols)
    for f2,l2,hh2 in cols:
        pos.extend([CX+f2/S, DECKY+hh2/S, CZ+l2/S]); uv.extend([(f2-FA0)/(FA1-FA0), (l2-LA0)/(LA1-LA0)]); nrm.extend([0,1,0])
tris=[]
for i in range(NS-1):
    b0=4*i; b1=4*(i+1)
    for c in range(3):
        tris.extend([b0+c, b0+c+1, b1+c,  b1+c, b0+c+1, b1+c+1])
pos=np.array(pos,np.float32).reshape(-1,3); uv=np.array(uv,np.float32).reshape(-1,2)
nrm=np.array(nrm,np.float32).reshape(-1,3); tris=np.array(tris,np.uint16)
a2,b2,c2=pos[tris[0]],pos[tris[1]],pos[tris[2]]
if np.cross(b2-a2,c2-a2)[1]<0: tris=tris.reshape(-1,3)[:,[0,2,1]].ravel()
def pushbuf(payload, target=34962):
    global B
    while len(B)%4: B.append(0)
    off=len(B); B.extend(payload)
    bvs.append({'buffer':0,'byteOffset':off,'byteLength':len(payload),'target':target})
    return len(bvs)-1
pb=pushbuf(pos.tobytes()); acc.append({'bufferView':pb,'byteOffset':0,'componentType':5126,'count':len(pos),'type':'VEC3','min':[float(x) for x in pos.min(0)],'max':[float(x) for x in pos.max(0)]}); A_P=len(acc)-1
nb=pushbuf(nrm.tobytes()); acc.append({'bufferView':nb,'byteOffset':0,'componentType':5126,'count':len(nrm),'type':'VEC3'}); A_N=len(acc)-1
ub=pushbuf(uv.tobytes()); acc.append({'bufferView':ub,'byteOffset':0,'componentType':5126,'count':len(uv),'type':'VEC2'}); A_U=len(acc)-1
ib=pushbuf(tris.tobytes(),target=34963); acc.append({'bufferView':ib,'byteOffset':0,'componentType':5123,'count':len(tris),'type':'SCALAR'}); A_I=len(acc)-1
G['meshes'].append({'name':'deck_baked','primitives':[{'attributes':{'POSITION':A_P,'NORMAL':A_N,'TEXCOORD_0':A_U},'indices':A_I,'material':MDECK}]})
nodes.append({'name':'deck_baked','mesh':len(G['meshes'])-1})
G['scenes'][G.get('scene',0)]['nodes'].append(len(nodes)-1)
# underside: the strip is single-sided (up-facing) — from below the deck you saw SKY
# through it. A steel plate 0.10 m below, wound downward, closes it; the skirt
# (rim down 2 m) covers the 0.10 m edge gap.
under=[]
for i in range(NS-1):
    c0=stations[i]; c1=stations[i+1]
    for c in range(3):
        ua=(c0[c][0],c0[c][1],c0[c][2]-0.10);   ub=(c0[c+1][0],c0[c+1][1],c0[c+1][2]-0.10)
        uc=(c1[c][0],c1[c][1],c1[c][2]-0.10);   ud=(c1[c+1][0],c1[c+1][1],c1[c+1][2]-0.10)
        under+=[ua,uc,ub, ub,uc,ud]
add_soup(np.array(under,dtype=np.float64), GREY, 'deck_underside', True)

# --- 5. empty-mesh strip + GC repack ---
empty={i for i,m in enumerate(G['meshes']) if not m.get('primitives')}
if empty:
    remap2={}; newm=[]
    for i,m in enumerate(G['meshes']):
        if i in empty: continue
        remap2[i]=len(newm); newm.append(m)
    G['meshes']=newm
    for n in nodes:
        if 'mesh' in n:
            if n['mesh'] in empty: del n['mesh']
            else: n['mesh']=remap2[n['mesh']]
    print(f"stripped {len(empty)} empty meshes")
used=set()
for mesh in G.get('meshes',[]):
    for p in mesh['primitives']:
        if 'indices' in p: used.add(p['indices'])
        for v2 in p['attributes'].values(): used.add(v2)
order=sorted(used); remap={o:i for i,o in enumerate(order)}
out=bytearray(); newbvs=[]; newacc=[]
imgmap={}
for im in G.get('images',[]):
    bv=bvs[im['bufferView']]
    while len(out)%4: out.append(0)
    o2=len(out); out.extend(bytes(B[bv['byteOffset']:bv['byteOffset']+bv['byteLength']]))
    newbvs.append({'buffer':0,'byteOffset':o2,'byteLength':bv['byteLength']})
    imgmap[im['bufferView']]=len(newbvs)-1
for im in G.get('images',[]): im['bufferView']=imgmap[im['bufferView']]
for old in order:
    a=dict(acc[old]); bv=bvs[a['bufferView']]
    comps={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    isz={5126:4,5125:4,5123:2,5121:1,5120:1}[a['componentType']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    stride=bv.get('byteStride',comps*isz)
    n2=a['count']
    while len(out)%4: out.append(0)
    o2=len(out)
    if stride!=comps*isz:
        out.extend(bytes(B[off:off+n2*stride]))
        nb2={'buffer':0,'byteOffset':o2,'byteLength':n2*stride,'byteStride':stride}
    else:
        out.extend(bytes(B[off:off+n2*comps*isz]))
        nb2={'buffer':0,'byteOffset':o2,'byteLength':n2*comps*isz}
    if bv.get('target'): nb2['target']=bv['target']
    newbvs.append(nb2); a['bufferView']=len(newbvs)-1; a['byteOffset']=0; newacc.append(a)
for mesh in G.get('meshes',[]):
    for p in mesh['primitives']:
        if 'indices' in p: p['indices']=remap[p['indices']]
        p['attributes']={k:remap[v2] for k,v2 in p['attributes'].items()}
G['accessors']=newacc; G['bufferViews']=newbvs
G['buffers']=[{'byteLength':len(out)}]
js=json.dumps(G,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4)
while len(out)%4: out.append(0)
total=12+8+len(js)+8+len(out)
with open(OUTFILE,'wb') as f:
    f.write(struct.pack('<III',0x46546C67,2,total))
    f.write(struct.pack('<II',len(js),0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II',len(out),0x004E4942)); f.write(bytes(out))
import os
print(f"{OUTFILE}: {os.path.getsize(OUTFILE):,} bytes")
