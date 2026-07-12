#!/usr/bin/env python3
"""Canonical furball Nimitz build — FROM THE PRISTINE ORIGINAL, single pass.

    original download  ->  clean playable carrier

Steps:
  1. drop SketchUp edge-line prims (no baseColorFactor -> glTF metallic=1 -> render black)
  2. clear the flight-deck band inside the traced outline (keep-boxed: 5 operator cabs,
     OLS bracket, auto-enumerated tall radomes + glass cabs) with boundary-owned rules:
       - long edges: +2 m ring;  bow/stern round-downs (|fa|>160): exact outline, at/above deck only
       - pokes-through (tall below-deck geometry cresting the plane): base outline on the long
         edges (kills elevator-rim webs), 1.5 m inset at the round-downs (forecastle front faces)
       - crest: up-facing flat plate wholly near deck level (platform tops on below-deck structure)
       - island: apron flats < 1.05 m die, lateral end-wall slices die, dark equipment
         to bridge height repainted steel; deck-zone near-black repainted DECK TONE (+12 m reach)
       - elevator platforms (ELEV_CLEAR): the strip owns the surface, so EVERYTHING in the band
         dies regardless of facing (saturated border paint survives); pale flush plates the kill
         rules miss get DECK-TONE repaint so any survivor merges with the baked deck
  3. one FLAT deck polygon (traced outline) textured with the decktex bake
  4. re-add: authored ICCS cab (verbatim transplant, flush), generated post-and-rail railings
  5. strip empty meshes (safety), GC-repack

Wires, sheaves, shuttles, JBD animation, OLS lights, floods are ENGINE-drawn - not model work.
Output: nimitz-clean.glb

REGEN CHAIN (order matters): build_carrier.py (writes outline.json) -> bake_decktex.py
(reads outline.json -> decktex12.png) -> build_carrier.py (reads decktex12) -> deploy +
splice_outline.py + bump NIMITZ_MODEL_VERSION + make. Needs cab38.npy/cab1.npy (extract_cab.py).
"""
import json, struct
import numpy as np
from collections import defaultdict, deque

ORIG = '/home/alistair/mochi/apps/furball/downloads/uss_nimitz_cvn-68_aircraft_carrier.glb'
TEX  = 'decktex12.png'
OUTFILE = 'nimitz-clean.glb'
S = 0.025; CX, CZ = 6361.3, -469.3; DECKY = 776.0

OUT=[[-166,4.2],[-158,31.2]]   # placeholder; the trace below overwrites OUT/NS entirely
NS = 44
ISL = (-92, -33, 16, 46)
ICCSZONES = [(64.5,73.0,4.5,11.5), (-56.5,-48.5,-37.0,-31.5)]
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
# the two DOME PLATFORMS (port waist + stern stbd): the platform is FILLED by a white geodesic
# radome sphere with a BLACK solid-fence bulwark around it (verified by rendering the original).
# Any geometric kill band through h -0.4..1.2 guts the dome's own mid-shell (it spans the whole
# platform) — three attempts (full box v34-era, perimeter bands v51) all left a floating cap /
# arched shell remnants. The right discriminator is MATERIAL: kill only DARK prims (the black
# bulwark) in the full box; the white dome shell survives whole. The generated railing_ring
# stands in for the removed bulwark.
FENCE_KILL_DARK = [(54.1,57.9,-44.8,-41.1,-0.4,1.2),(-153.3,-148.5,23.0,28.3,-0.4,1.1)]
# aircraft-elevator platform footprints: the strip owns the surface, so EVERYTHING in the
# band dies regardless of facing — the orientation-gated rules leave vertical/metallic
# under-machinery shards visible through part-killed platform tops. Saturated paint
# (red/yellow border strips) survives; keep boxes (OLS bracket overlaps el-4) still win.
ELEV_CLEAR = [(-12,83,26,40.5),(-114,-92.5,25,39.5),(-23,-1,-44.5,-31.5)]   # stbd els 1+2 + staging (one continuous overhang), el3 aft of island, el4 port

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

# --- Stage B: LATERAL SQUASH to the real beam ---
# The flight deck measures 80.0 m max width vs the real 76.8 m (+4.2%); length is exact
# (333 vs 332.8). One uniform lateral scale about the centreline corrects the beam. Known
# trade (PLAN.md acid test): the angled-deck angle scales atan(0.96*tan) 8.99->~8.64 deg vs
# the real 9.05 - a 0.4 deg error nobody can see, in exchange for exact proportions. All
# deck-ops constants (engine shuttles/line/OLS/halfspan and this file's measured boxes)
# are scaled to match, and the bake scales its mark/track lats identically.
# Dome shape-preservation was tried TWICE and abandoned: any blend between "translated"
# (shape-kept) and "squashed" geometry has a transition zone, and the dome clusters are
# dense - the falloff ran through neighbouring pedestals/structures and TORE them (first
# the port-bow whip dome whose shell exceeded its tight box, then the port golf-ball whose
# unpreserved pedestal sat inside a preserved neighbour's falloff: dome floating off its
# mount). Uniform squash distorts a 6-8 m sphere by 24-32 cm (4%) - invisible in game -
# and by construction cannot tear anything. DOME_PRESERVE stays as a knob, empty.
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
ICCSZONES=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in ICCSZONES]
KEEP_HAND=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in KEEP_HAND]
DOME_KEEP=[(f0,f1,_lat(l0),_lat(l1)) for f0,f1,l0,l1 in DOME_KEEP]
FENCE_KILL=[(f0,f1,_lat(l0),_lat(l1),h0,h1) for f0,f1,l0,l1,h0,h1 in FENCE_KILL]
FENCE_KILL_DARK=[(f0,f1,_lat(l0),_lat(l1),h0,h1) for f0,f1,l0,l1,h0,h1 in FENCE_KILL_DARK]
# OLS datum-arm trim (v54): the model's green-datum light bar is 8.1 m wide at
# +0.66 m and overhangs the FLIGHT DECK by ~2.2 m (deck edge -35.2 at fa -21) — a
# deck-clearance violation the real IFLOLS doesn't have; cat-4 wingtips sweep that
# lat during the launch roll. Trim the bar to ±1.8 m about the lens column
# (lat -37.06): a realistic ~3.6 m bar ending just outboard of the edge. Applied
# ONLY to the bar's material (material_5) — the boxes also contain deck plates.
# Coordinates are POST-squash (measured on the built model), so no _lat here.
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
        if inzone(cf,cl,ICCSZONES): continue
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
# the authored racks' 0137_Black is absolute black (0,0,0) — zero reflectance renders as a
# void wherever a face is exposed (end plates, whole black components). The rafts get their
# own dark grey instead; the shared 0137_Black stays untouched for the mast/island parts.
mats.append({'name':'raft_hardware','pbrMetallicRoughness':{'baseColorFactor':[0.15,0.16,0.17,1.0],'metallicFactor':0.1,'roughnessFactor':0.9}})
RAFTDARK=len(mats)-1

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

# --- 1b. life-raft rack REPLACEMENT (v59) --- the authored canister racks straddle the
# rebuilt deck's boundary planes (strip at the sheered rim height + skirt at the outline),
# so any exemption leaves them either beheaded (v57) or clipping through the deck (v58).
# Replace them wholesale: collect the authored canister clusters (material_37 shells) along
# the outline, KILL all three rack materials inside those zones during the band clear, and
# GENERATE clean two-row canister stacks hung below the local deck lip after the railings.
_P=np.array(OUT,np.float64); _SG=np.roll(_P,-1,axis=0)-_P
_SL=np.hypot(_SG[:,0],_SG[:,1]); _AR=np.concatenate([[0.0],np.cumsum(_SL)])[:len(_P)]
def arc_project(f,l):
    d0=f-_P[:,0]; d1=l-_P[:,1]
    tpar=np.clip((d0*_SG[:,0]+d1*_SG[:,1])/(_SL**2+1e-9),0,1)
    q0=_P[:,0]+tpar*_SG[:,0]; q1=_P[:,1]+tpar*_SG[:,1]
    dd=np.hypot(f-q0,l-q1)
    j=int(np.argmin(dd))
    return _AR[j]+tpar[j]*_SL[j], dd[j]
_ccw=(np.sum(_P[:,0]*np.roll(_P[:,1],-1)-np.roll(_P[:,0],-1)*_P[:,1])/2)>0
def arc_signed(f,l):   # signed offset from the outline: positive = outboard (see _SFLIP)
    d0=f-_P[:,0]; d1=l-_P[:,1]
    tpar=np.clip((d0*_SG[:,0]+d1*_SG[:,1])/(_SL**2+1e-9),0,1)
    q0=_P[:,0]+tpar*_SG[:,0]; q1=_P[:,1]+tpar*_SG[:,1]
    dd=(f-q0)**2+(l-q1)**2
    j=int(np.argmin(dd))
    tx,ty=_SG[j,0]/max(_SL[j],1e-9),_SG[j,1]/max(_SL[j],1e-9)
    nx,ny=(ty,-tx) if _ccw else (-ty,tx)
    return _AR[j]+tpar[j]*_SL[j], (f-q0[j])*nx+(l-q1[j])*ny
_SFLIP=-1.0 if arc_signed(0.0,0.0)[1]>0 else 1.0
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
                if -2.0<hh[k]<1.2:
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
print(f"life-raft clusters: {len(RAFT_CLUSTERS)} (authored racks killed in-zone, regenerated)")
RACK_MATS={'material_3','material_37','0137_Black'}

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
        rack=mi>=0 and mats[mi].get('name') in RACK_MATS
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
            for f0,f1,l0,l1 in ICCSZONES: zic|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)
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
            if rack:   # authored life-raft racks: killed in-zone, transplanted after railings
                rz=np.zeros(len(t),bool)
                for f0,f1,l0,l1 in RAFT_ZONES:
                    rz|=(fa>f0)&(fa<f1)&(la>l0)&(la<l1)&(ys>-2.2)&(ys<1.4)
                for i3 in np.where(rz)[0]:
                    # the stbd-forward zone bbox spans the elevator notches: without this
                    # bound it swallows deck-interior fittings up to 19 m inboard
                    if arc_project(fa[i3],la[i3])[1]>3.2: rz[i3]=False
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
                # preserve the deck-edge CATWALK (walkway ledges + racks + railings hanging below
                # and outboard of the deck edge). On the long edges the +2 m ring stripped it -
                # killing 83% of the bow edge while the sides kept theirs. Kill inside the deck
                # outline (base) fully; in the 0..2 m outboard margin kill ONLY what rises above
                # the deck surface (hmax > 0.60, deck top is ~0.66) - the bow walkways sit at
                # ys +0.2..0.4 (just below the deck lip), so a ys-based threshold in the old
                # h=0 frame wiped them while the sides' lower catwalks (-0.35..-1.35) survived.
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
def deck_h(faq):   # deck surface height at this fa (flat cross-section at the rim height). v43
    faarr=[OUT[i][0] for i in range(NS)]   # raised the deck ~0.65 m, so flight-deck features
    i=int(np.clip(np.searchsorted(faarr,faq)-1,0,NS-2))   # (railings, ICCS) must sit ON it, not at h=0
    return (RIMH[i]+RIMH[2*NS-1-i])/2
# flight-deck railings (island walkway + ammo-elevator rings): base on the raised deck. The
# deck-edge/catwalk railings below keep their measured negative bases (the catwalk didn't rise).
R=[railing_run((-89.37,22.58),(-33.76,22.58),deck_h(-61),0.9),
   railing_run((-33.76,22.58),(-33.76,19.2),deck_h(-34),0.9),
   railing_run((-89.37,22.58),(-89.37,19.2),deck_h(-89),0.9),
   railing_ring(-47.81,-43.15,16.63,18.81,deck_h(-45),0.9),
   railing_ring(-60.82,-56.17,20.40,22.58,deck_h(-58),0.9),
   railing_run((-121.3,-32.7),(-120.8,-31.5),-0.53,0.9),
   railing_ring(-153.0,-148.8,23.3,28.0,-0.31,0.9),
   railing_run((-83.4,-38.5),(-81.1,-38.5),-0.49,0.9),
   railing_ring(54.4,57.6,-44.5,-41.4,-0.13,0.9),
   railing_run((43.9,39.75),(45.5,39.75),-0.5,0.9),
   railing_run((-116.1,36.1),(-115.7,36.1),-0.39,0.9),
   railing_run((-72.6,-38.75),(-72.3,-38.75),-0.51,0.9)]
RAILS=np.concatenate(R)
RAILS[:,1]*=S_LAT   # railing sites were measured pre-squash; follow the deck

# --- 4b. generated life-raft canister racks (v59) --- two stacked rows of white
# cylinders per authored cluster, hung on the outline's outboard side BELOW the local
# deck lip (deck-edge clearance like the real racks; nothing touches the strip or
# skirt). Cluster spans come from the authored material_37 shells (step 1b).
def cyl_tris(c,axis,radius,length,nseg=8):
    a=np.array(axis,np.float64); a/=np.linalg.norm(a)
    u=np.cross(a,[0.0,0.0,1.0])
    if np.linalg.norm(u)<1e-6: u=np.cross(a,[0.0,1.0,0.0])
    u/=np.linalg.norm(u); w2=np.cross(a,u)
    c=np.array(c,np.float64)
    e0,e1=c-a*length/2,c+a*length/2
    th=np.linspace(0,2*np.pi,nseg,endpoint=False)
    r0=[e0+(u*np.cos(t)+w2*np.sin(t))*radius for t in th]
    r1=[e1+(u*np.cos(t)+w2*np.sin(t))*radius for t in th]
    T=[]
    for k in range(nseg):
        k2=(k+1)%nseg
        T+=[[r0[k],r0[k2],r1[k2]],[r0[k],r1[k2],r1[k]]]
        T+=[[e0,r0[k2],r0[k]],[e1,r1[k],r1[k2]]]
    return np.array(T).reshape(-1,3)
def outline_at(s):
    j=int(np.clip(np.searchsorted(_AR,s)-1,0,len(_P)-1))
    t=(s-_AR[j])/max(_SL[j],1e-9)
    px=_P[j,0]+t*_SG[j,0]; py=_P[j,1]+t*_SG[j,1]
    tx,ty=_SG[j,0]/max(_SL[j],1e-9),_SG[j,1]/max(_SL[j],1e-9)
    nx,ny2=ty,-tx
    if inpoly_vec(np.array([px+nx*0.8]),np.array([py+ny2*0.8]),P_base)[0]: nx,ny2=-nx,-ny2
    return px,py,nx,ny2,RIMH[j]
# v61: VERBATIM TRANSPLANT of the authored racks (generated approximations — v59
# cylinder rows, v60 capsule stacks — read wrong next to the real thing; the ICCS
# cab precedent applies). Fresh-parse the ORIGINAL, take every rack-material tri in
# the collected clusters, and re-add it with a per-cluster rigid shift: OUTBOARD
# until clear of the skirt/lip (the authored units lean ~0.25 m inside the outline),
# DOWN until the cluster top sits under the LOCAL rim (authored tops are a constant
# +0.66..0.68 while the deck sheers 0.06..0.66, so amidships/aft they poked above
# deck and clipped the strip).
_d2=open(ORIG,'rb').read()
_cl2,_=struct.unpack('<II',_d2[12:20])
_G2=json.loads(_d2[20:20+_cl2]); _bo2=20+_cl2
_bl2,_=struct.unpack('<II',_d2[_bo2:_bo2+8])
_B2=_d2[_bo2+8:_bo2+8+_bl2]
def _readA2(ai):
    a=_G2['accessors'][ai]; bv=_G2['bufferViews'][a['bufferView']]
    comps={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    dt={5126:np.float32,5125:np.uint32,5123:np.uint16,5121:np.uint8,5120:np.int8}[a['componentType']]
    isz=np.dtype(dt).itemsize
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    stride=bv.get('byteStride',comps*isz)
    if stride!=comps*isz:
        raw=np.frombuffer(_B2,np.uint8,a['count']*stride,off).reshape(a['count'],stride)
        return np.ascontiguousarray(raw[:,:comps*isz]).view(dt).reshape(a['count'],comps)
    return np.frombuffer(_B2,dt,a['count']*comps,off).reshape(a['count'],comps)
_w2={}
def _walk2(i,P):
    _w2[i]=P@trs(_G2['nodes'][i])
    for c in _G2['nodes'][i].get('children',[]): _walk2(c,_w2[i])
for r in _G2['scenes'][_G2.get('scene',0)]['nodes']: _walk2(r,np.eye(4))
_m2=_G2['materials']
raftbuckets=defaultdict(list)   # (cluster index, material name) -> [tri verts (fa,lat,h)]
for ni,n in enumerate(_G2['nodes']):
    if 'mesh' not in n: continue
    for p in _G2['meshes'][n['mesh']]['primitives']:
        mi=p.get('material',-1)
        if mi<0 or _m2[mi].get('name') not in RACK_MATS: continue
        v=_readA2(p['attributes']['POSITION']).astype(np.float64)
        w=(_w2[ni][:3,:3]@v.T).T+_w2[ni][:3,3]
        if 'indices' in p: idx=_readA2(p['indices']).ravel().astype(np.int64)
        else: idx=np.arange(len(w),dtype=np.int64)
        idx=idx[:len(idx)//3*3]
        t=w[idx].reshape(-1,3,3)
        fa=(t[:,:,0]-CX)*S; la=(t[:,:,2]-CZ)*S*S_LAT; hh=(t[:,:,1]-DECKY)*S
        cf=fa.mean(1); cl=la.mean(1); ch=hh.mean(1)
        for i2 in range(len(t)):
            # EXACTLY the kill footprint (RAFT_ZONES bboxes + the same height band) —
            # anything looser duplicates or hoists unrelated same-material fittings
            # (the zones extend down the hull side without the height bound)
            if not (-2.2<ch[i2]<1.4): continue
            for k,(f0,f1,l0,l1) in enumerate(RAFT_ZONES):
                if f0<cf[i2]<f1 and l0<cl[i2]<l1:
                    s_arc,dd_arc=arc_project(cf[i2],cl[i2])
                    if dd_arc>3.2: break   # matches the kill bound: interior fittings stay authored
                    raftbuckets[(k,_m2[mi]['name'])].append((s_arc,np.stack([fa[i2],la[i2],hh[i2]],1)))
                    break
# Per-ROW placement: split each cluster at 0.6 m arc gaps into rows, then BEND each row
# smoothly onto the wall — a per-vertex outboard displacement field delta(s) sampled at
# 0.8 m stations (front=P98, back clamped to front-1.5: the mount-arm guard), smoothed
# over ~4 m, applied along the local outline normal, outboard-only, plus the analogous
# smoothed vertical tuck to the local lip. NO segmentation: rigid pieces on this wall
# inherently step at their seams (the offset between the authored rack line and the
# outline varies 0.5-2.9 m along one 56 m row, and some rows are continuous — largest
# natural gap 0.03 m), which sliced packs open (user-reported 2026-07-12). The field's
# gradient after smoothing is a few cm/m — invisible shear, no seams, coincident soup
# vertices get identical displacement (same position -> same s), so nothing tears.
raftsoup=defaultdict(list)
RAFT_PLATES=[]
RAFT_DROPPED=[]
for k,(s0,s1) in enumerate(RAFT_CLUSTERS):
    members=[(sa,mn,t) for (ck,mn),ts in raftbuckets.items() if ck==k for sa,t in ts]
    if not members: continue
    members.sort(key=lambda m:m[0])
    unit=[]; units=[]
    for m in members:
        if unit and m[0]-unit[-1][0]>0.6: units.append(unit); unit=[]
        unit.append(m)
    units.append(unit)
    for unit in units:
        allv=np.concatenate([t for _,_,t in unit])
        V=allv[:,:2].copy()
        H=allv[:,2].copy()
        def field(P):   # vectorised arc_signed over all vertices, chunked
            ssf=np.empty(len(P)); ddf=np.empty(len(P))
            for o in range(0,len(P),8000):
                q=P[o:o+8000]
                d0=q[:,0,None]-_P[None,:,0]; d1=q[:,1,None]-_P[None,:,1]
                tpar=np.clip((d0*_SG[None,:,0]+d1*_SG[None,:,1])/(_SL[None,:]**2+1e-9),0,1)
                q0=_P[None,:,0]+tpar*_SG[None,:,0]; q1=_P[None,:,1]+tpar*_SG[None,:,1]
                dist2=(q[:,0,None]-q0)**2+(q[:,1,None]-q1)**2
                jj=np.argmin(dist2,axis=1)
                rr=np.arange(len(q))
                tx=_SG[jj,0]/np.maximum(_SL[jj],1e-9); ty=_SG[jj,1]/np.maximum(_SL[jj],1e-9)
                nx2,ny3=(ty,-tx) if _ccw else (-ty,tx)
                ssf[o:o+8000]=_AR[jj]+tpar[rr,jj]*_SL[jj]
                ddf[o:o+8000]=((q[:,0]-q0[rr,jj])*nx2+(q[:,1]-q1[rr,jj])*ny3)*_SFLIP
            return ssf,ddf
        def smooth(a):
            if len(a)<3: return a
            w=min(5,len(a)-(1-len(a)%2))
            k2=np.ones(w)
            # edge-corrected moving average: zero-pad 'same' underestimates at the row
            # ends, which left end packs buried
            return np.convolve(a,k2,mode='same')/np.convolve(np.ones(len(a)),k2,mode='same')
        # repeated smoothed-residual passes: one pass cannot meet a stepped wall demand
        # (the smoothing spreads it); iterate until the residual is gone — displacement
        # accumulates smoothly, so the shell bends instead of stepping
        for _pass in range(6):
            ss,dd=field(V)
            st=np.arange(ss.min(),ss.max()+0.4,0.8)
            delta=np.zeros(len(st))
            for i2,sc2 in enumerate(st):
                w=np.abs(ss-sc2)<=1.6
                if w.sum()<6:
                    w=np.abs(ss-sc2)<=3.0
                    if w.sum()<6: continue
                dw=dd[w]
                front=float(np.percentile(dw,98))
                back=max(float(np.percentile(dw,5)),front-1.5)
                delta[i2]=max(0.0,0.02-back)
            delta=smooth(delta)
            dv=np.interp(ss,st,delta)
            if dv.max()<=0.01: break
            nxs=np.empty(len(st)); nys=np.empty(len(st))
            for i2,sc2 in enumerate(st):
                _,_,a1,a2,_=outline_at(sc2); nxs[i2]=a1; nys[i2]=a2
            vx=np.interp(ss,st,nxs); vy=np.interp(ss,st,nys)
            nn=np.hypot(vx,vy)+1e-12
            V=V+np.stack([dv*vx/nn,dv*vy/nn],1)
        # vertical tuck: per-station top envelope vs local rim, smoothed the same way
        ss,dd=field(V)
        st=np.arange(ss.min(),ss.max()+0.4,0.8)
        dzs=np.zeros(len(st)); rims=np.zeros(len(st))
        for i2,sc2 in enumerate(st):
            _,_,_,_,rim2=outline_at(sc2); rims[i2]=rim2
            w=np.abs(ss-sc2)<=1.6
            if w.sum()<3:
                w=np.abs(ss-sc2)<=3.0
                if w.sum()<3: continue
            dzs[i2]=max(-0.9,min(0.0,(rim2-0.12)-float(H[w].max())))
        dzs=smooth(dzs)
        dzv=np.interp(ss,st,dzs)
        H2=H+dzv
        # NEATNESS FILTER (user 2026-07-12: keep the v70 smooth-bend placement, but
        # remove any life raft that does not sit neatly alongside the fascia; keep
        # those that do). Segment the unit into CONNECTED COMPONENTS of the authored
        # geometry (each shell/fitting is its own object — arc-gap chunks mixed
        # multiple shells with the rack rails and mis-measured everything), then
        # judge each component as placed by the smooth field:
        #   bent    — nonlinearly warped (banana): max deviation from the component's
        #             own best rigid fit > 0.35 m (compact) / > 0.10 m per metre of
        #             span (long rows and rails — bending ALONG the wall is their
        #             normal state), or vertical tuck varying > 0.40 m inside it
        #   askew   — long axis not parallel to the wall: > 25 deg (elongated only)
        #   buried  — back face visibly inside the hull: back < -0.20 (or fully in)
        # There is deliberately NO per-component floating test: the outer row of a
        # two-deep rack legitimately stands ~1 m off the wall, and the unit-level
        # field already guarantees the assembly touches the wall.
        # Survivors keep their v70 smooth-mapped positions untouched.
        sa_arr=np.array([m3[0] for m3 in unit])
        parent=list(range(len(unit)))
        def find(a):
            while parent[a]!=a:
                parent[a]=parent[parent[a]]; a=parent[a]
            return a
        vkey={}
        for j in range(len(unit)):
            for v3 in range(3):
                kq=(round(float(allv[3*j+v3,0]),3),round(float(allv[3*j+v3,1]),3),round(float(H[3*j+v3]),3))
                if kq in vkey:
                    ra,rb=find(vkey[kq]),find(j)
                    if ra!=rb: parent[rb]=ra
                else: vkey[kq]=j
        comps=defaultdict(list)
        for j in range(len(unit)): comps[find(j)].append(j)
        kept_lo=None; kept_hi=None
        for cidx in comps.values():
            cidx=np.array(cidx)
            rows=np.concatenate([np.arange(3*j,3*j+3) for j in cidx])
            span=float(sa_arr[cidx].max()-sa_arr[cidx].min())
            reason=None
            X=allv[rows,:2]; Y=V[rows]
            cx=X.mean(0); cy=Y.mean(0)
            Hm=(X-cx).T@(Y-cy)
            U2,S2,Vt=np.linalg.svd(Hm)
            Rm=U2@Vt
            if np.linalg.det(Rm)<0:
                Vt[-1]*=-1; Rm=U2@Vt
            resid=float(np.linalg.norm((X-cx)@Rm+cy-Y,axis=1).max())
            vspread=(H2-H)[rows]
            vsp=float(vspread.max()-vspread.min())
            rlim=0.35 if span<=3.6 else 0.10*span
            if resid>rlim or vsp>0.40: reason=f'bent r={resid:.2f} v={vsp:.2f} span={span:.1f}'
            cdd=dd[rows]
            front=float(np.percentile(cdd,98))
            back=max(float(np.percentile(cdd,5)),front-1.5)
            if reason is None and (back<-0.20 or front<0.05): reason=f'buried b={back:.2f} f={front:.2f}'
            if reason is None and span<=3.6 and len(rows)>=24:
                Xc=Y-cy
                w2,vec=np.linalg.eigh(Xc.T@Xc)
                if w2[1]>2.25*w2[0]:
                    axis=vec[:,1]
                    scm=float(ss[rows].mean())
                    _,_,wnx,wny,_=outline_at(scm)
                    ang=float(np.degrees(np.arcsin(min(1.0,abs(axis@np.array([wnx,wny]))))))
                    if ang>25: reason=f'askew a={ang:.0f}'
            if reason is not None:
                px2,py2,_,_,_=outline_at(float(sa_arr[cidx].mean()))
                RAFT_DROPPED.append((reason,px2,py2,len(cidx)))
                continue
            lo2=float(sa_arr[cidx].min()); hi2=float(sa_arr[cidx].max())
            kept_lo=lo2 if kept_lo is None else min(kept_lo,lo2)
            kept_hi=hi2 if kept_hi is None else max(kept_hi,hi2)
            for j in cidx:
                t2=unit[j][2].copy()
                t2[:,:2]=V[3*j:3*j+3]; t2[:,2]=H2[3*j:3*j+3]
                raftsoup[unit[j][1]].append(t2)
        if kept_lo is None: continue
        # backing plate: a strip of double-sided quads 0.01 outboard of the skirt plane
        # following the row, with per-step local heights — the packs visibly touch
        # fascia-coloured structure even if the back estimate is off by a few cm.
        # Spans only the SURVIVING canisters' arc range.
        s_a=kept_lo-0.15; s_b=kept_hi+0.15
        steps=max(1,int((s_b-s_a)/3.0)+1)
        prev=None
        for q in range(steps+1):
            sq=s_a+(s_b-s_a)*q/steps
            qx,qy,qnx,qny,rim2=outline_at(sq)
            w=np.abs(ss-sq)<=1.8
            if w.sum()<3:
                prev=None; continue
            h0=float(H2[w].min())-0.12; h1=min(float(H2[w].max())+0.12,rim2-0.02)
            if h1<=h0:
                prev=None; continue
            ptop=(qx+qnx*0.01,qy+qny*0.01,h1); pbot=(qx+qnx*0.01,qy+qny*0.01,h0)
            if prev is not None:
                a,b2=prev
                RAFT_PLATES+=[a,ptop,pbot, a,pbot,b2, a,pbot,ptop, a,b2,pbot]
            prev=(ptop,pbot)
print(f"raft transplant: {sum(len(v) for vs in raftsoup.values() for v in vs)//3} tris across {len(RAFT_CLUSTERS)} clusters")
if RAFT_DROPPED:
    print(f"  neatness filter dropped {len(RAFT_DROPPED)} canisters:")
    for reason,px2,py2,nm2 in RAFT_DROPPED:
        print(f"    {reason:7s} fa={px2:7.1f} lat={py2:6.1f} members={nm2}")

def add_soup(verts, mat_idx, name, deckframe):
    global B
    n2=len(verts)
    if n2==0: return
    if deckframe:
        wpos=np.empty_like(verts)
        wpos[:,0]=CX+verts[:,0]/S; wpos[:,1]=DECKY+verts[:,2]/S; wpos[:,2]=CZ+verts[:,1]/S
        pos=wpos.astype(np.float32)
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
for mn,parts in raftsoup.items():
    mi3=RAFTDARK if mn=='0137_Black' else matbyname.get(mn,0)
    add_soup(np.concatenate(parts), mi3, f'rafts_{mn}', True)
add_soup(np.array(RAFT_PLATES,dtype=np.float64), GREY, 'raft_plates', True)
cab38=np.load('cab38.npy'); cab1=np.load('cab1.npy')
# the cab was extracted 'dropped 0.64 m' to sit flush on the OLD interior (h=0); v43 raised the
# deck ~0.65 m, so it was fully buried ('ICCS gone'). Undo the drop so it sits flush on the deck.
ICCS_RAISE=0.64/S
cab38[:,1]+=ICCS_RAISE; cab1[:,1]+=ICCS_RAISE
# the extraction is pre-squash world coords; follow the deck (position + 4% shape, like everything)
cab38[:,2]=CZ+(cab38[:,2]-CZ)*S_LAT; cab1[:,2]=CZ+(cab1[:,2]-CZ)*S_LAT
add_soup(cab38, matbyname.get('material_38',0), 'iccs_cab', False)
add_soup(cab1, matbyname.get('material_1',0), 'iccs_glass', False)

# --- deck-edge fascia skirt ---
# The band clear removes the original deck-edge fascia (near-vertical tris in ys -1.2..1.8),
# but the flat deck strip only replaces the top SURFACE - not the vertical wall below the edge.
# So the deck edge floats above the surviving hull side (which starts below -1.2 m) and you
# see into the dark interior (the starboard-bow black wedge; worst there because the hull steps
# away from the deck edge). A vertical skirt from each outline edge down 2 m closes the gap all
# round. Drawn double-sided (both windings) so it reads solid from any angle; sits at the outline
# (0.30 m inboard of the plate edge, so it never pokes through the hull).
SKIRT_DROP=2.0
skirt=[]
NPOLY=len(OUT)
for i in range(NPOLY):
    j=(i+1)%NPOLY
    (f0,l0),(f1,l1)=OUT[i],OUT[j]; h0=RIMH[i]; h1=RIMH[j]
    p0=(f0,l0,h0); p1=(f1,l1,h1); p2=(f0,l0,h0-SKIRT_DROP); p3=(f1,l1,h1-SKIRT_DROP)
    skirt+=[p0,p1,p3, p0,p3,p2,  p0,p3,p1, p0,p2,p3]   # both windings -> double-sided
add_soup(np.array(skirt,dtype=np.float64), GREY, 'deck_skirt', True)

# --- 3. the deck polygon + texture: FLAT-ISH, NOT HORIZONTAL ---
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
# 4 columns per station, ALL at the measured hull-rim height (flat across each cross-section).
# The earlier design sank the two inner columns to DECKY (h=0) while the edges sat at the
# rim (~0.65 m) - that made every cross-section a shallow BOWL (concave, the user's report).
# The real deck is flat: interior = edges = rim height. The physics contact plane follows
# automatically (CARRIER.deckY is raycast from the drawn deck at the cat spot, which is now
# at the rim height, so wheels sit on the deck). Rim height varies fore-aft (sheer + the
# bow/stern round-downs), so the deck follows the sheer along its length but is flat across.
stbd=OUT[:NS]; port=[OUT[2*NS-1-i] for i in range(NS)]
hs_stbd=[rim_h[i] for i in range(NS)]; hs_port=[rim_h[2*NS-1-i] for i in range(NS)]
APRON=6.0
pos=[]; uv=[]; nrm=[]
for i in range(NS):
    (fs,ls),(fp,lp)=stbd[i],port[i]
    dx,dl=fp-fs,lp-ls
    Lw=max(np.hypot(dx,dl),1e-6)
    a=min(APRON/Lw,0.45)
    cols=[(fs,ls,hs_stbd[i]),
          (fs+dx*a,ls+dl*a,hs_stbd[i]),
          (fp-dx*a,lp-dl*a,hs_port[i]),
          (fp,lp,hs_port[i])]
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
