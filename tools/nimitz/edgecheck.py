"""Deck-edge catwalk, life-raft and catapult control cab checks on nimitz-clean.glb: the generated
catwalk, its railings and braces, and the raft racks must hang together and on the ship - every failure
the authored-raft attempts (v57-v74) produced is a check here. Run after any change to
build_carrier.py's 1c/2a/4b, to its cabs or to cabs.py;
exits non-zero on any failure.
  count     exactly RAFTS canisters
  supported every canister rests on its cradle arms (no float, no sink)
  hung      every canister hangs beside the catwalk's outer edge
  aligned   every canister lies along the deck edge it hangs on, within 2 degrees, level
  clear     no canister, rack or catwalk piece passes through the hull, skirt or authored geometry,
            and no authored plate lies in a catwalk slab's own plane (they would z-fight)
  attached  every catwalk slab's inboard edge is on the skirt or the ship's side, every railing post
            stands on a slab, every brace runs from under a slab to the skirt or the ship's side
  outward   every face of every generated piece faces out (single-sided materials are culled)
  cabs      each catapult control cab stands where cabs.py puts it, at its size, its walls starting
            just under the deck, on a painted plate with a red/yellow border in the deck texture,
            and at least WHEEL_CLEAR from every catapult's centreline over the jet's whole run (its
            main wheels at the launch spot to the end of the stroke; engine.ts carrier data); the
            original bow cab is gone, and every cab face faces out
Usage: edgecheck.py [-v] [glb]   (default nimitz-clean.glb; -v lists where each failure is)"""
import json, struct, sys
import numpy as np
ARGS=[a for a in sys.argv[1:] if a!='-v']
GLB=ARGS[0] if ARGS else 'nimitz-clean.glb'
RAFTS=242
CX,CZ,DECKY,S=6361.3,-469.3,776.0,0.025
GENERATED={'deck_baked','deck_underside','deck_skirt','railings','iccs_cab','iccs_glass',
           'catwalk','catwalk_railings','catwalk_braces','raft_racks','raft_straps','raft_canisters'}
d=open(GLB,'rb').read()
cl=struct.unpack('<I',d[12:16])[0]
G=json.loads(d[20:20+cl]); bin0=d[20+cl+8:]
CT={5121:np.uint8,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC={'SCALAR':1,'VEC2':2,'VEC3':3}
def readA(ai):
    a=G['accessors'][ai]; bv=G['bufferViews'][a['bufferView']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    arr=np.frombuffer(bin0,dtype=CT[a['componentType']],count=a['count']*NC[a['type']],offset=off)
    return arr.reshape(a['count'],NC[a['type']]) if NC[a['type']]>1 else arr
def trs(n):
    if 'matrix' in n: return np.array(n['matrix'],dtype=np.float64).reshape(4,4).T
    M=np.eye(4); t=n.get('translation',[0,0,0]); r=n.get('rotation',[0,0,0,1]); s=n.get('scale',[1,1,1])
    x,y,z,w=r
    R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    M[:3,:3]=R*np.array(s)[None,:]; M[:3,3]=t
    return M
W={}
def walk(i,P):
    W[i]=P@trs(G['nodes'][i])
    for c in G['nodes'][i].get('children',[]): walk(c,W[i])
for r in G['scenes'][G.get('scene',0)]['nodes']: walk(r,np.eye(4))
def deck(w): return np.stack([(w[...,0]-CX)*S,(w[...,2]-CZ)*S,(w[...,1]-DECKY)*S],-1)
tris={}; verts={}; faces={}
for ni,n in enumerate(G['nodes']):
    if 'mesh' not in n: continue
    name=G['meshes'][n['mesh']].get('name') or ''
    for p in G['meshes'][n['mesh']]['primitives']:
        v=readA(p['attributes']['POSITION']).astype(np.float64)
        w=(W[ni][:3,:3]@v.T).T+W[ni][:3,3]
        idx=readA(p['indices']).ravel().astype(np.int64) if 'indices' in p else np.arange(len(w))
        idx=idx[:len(idx)//3*3]
        # the deck frame (fa, lat, h) mirrors the model frame: reverse the winding so a
        # normal computed here faces where the renderer's does
        t=deck(w[idx].reshape(-1,3,3))[:,[0,2,1]]
        if name in GENERATED: key=name
        else: key='authored'
        tris.setdefault(key,[]).append(t)
        if name=='raft_canisters': verts[key]=deck(w); faces[key]=idx.reshape(-1,3)[:,[0,2,1]]
tris={k:np.concatenate(v) for k,v in tris.items()}
failures=[]
WHERE={}
VERBOSE='-v' in sys.argv
def check(name,ok,detail):
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    if not ok: failures.append(name)
O=json.load(open('outline.json')); OUT=np.array(O['OUT'],np.float64); NS=O['NS']
def edge_project(f,l):
    # nearest point on the deck outline: (distance, unit direction of that edge, outward offset sign)
    P=np.vstack([OUT,OUT[:1]]); a=P[:-1]; dd=P[1:]-a; L2=(dd**2).sum(1)+1e-12
    t=np.clip(((f-a[:,0])*dd[:,0]+(l-a[:,1])*dd[:,1])/L2,0,1)
    q=a+t[:,None]*dd; dist=np.hypot(f-q[:,0],l-q[:,1]); k=int(dist.argmin())
    return dist[k], dd[k]/np.sqrt(L2[k])
def OUTLINE_POINT(f,l):
    P=np.vstack([OUT,OUT[:1]]); a=P[:-1]; dd=P[1:]-a; L2=(dd**2).sum(1)+1e-12
    t=np.clip(((f-a[:,0])*dd[:,0]+(l-a[:,1])*dd[:,1])/L2,0,1)
    q=a+t[:,None]*dd; return q[np.hypot(f-q[:,0],l-q[:,1]).argmin()]
def inside_outline(f,l):
    P=OUT; P2=np.roll(P,-1,0); c=False
    cross=(P[:,1]>l)!=(P2[:,1]>l)
    xi=P[:,0]+(l-P[:,1])*(P2[:,0]-P[:,0])/np.where(P2[:,1]!=P[:,1],P2[:,1]-P[:,1],1)
    return (np.sum(cross&(f<xi))%2)==1

if 'raft_canisters' not in verts:
    check('count',False,'no raft_canisters mesh'); print('\nFAILED'); sys.exit(1)

# --- canisters: 34 vertices each (four rings of eight, then two end tips) ---
V=verts['raft_canisters']; F=faces['raft_canisters']
n_can=len(V)//34
check('count',n_can==RAFTS and len(V)%34==0,f"{n_can} canisters (want {RAFTS})")
cans=[]
for k in range(n_can):
    c=V[34*k:34*k+34]; tip0,tip1=c[32],c[33]; axis=(tip1-tip0)/np.linalg.norm(tip1-tip0); mid=(tip0+tip1)/2
    ring=c[8:16]; R=np.mean(np.linalg.norm((ring-mid)-np.outer((ring-mid)@axis,axis),axis=1))
    cans.append((mid,axis,R,np.linalg.norm(tip1-tip0)/2))
racks=tris.get('raft_racks',np.zeros((0,3,3)))
floor=tris.get('catwalk',np.zeros((0,3,3)))
def ray_down(T,TC,p,reach):
    # height of the highest triangle of T straight below p within reach, or None
    near=np.where(np.hypot(TC[:,0]-p[0],TC[:,1]-p[1])<1.2)[0]
    if not len(near): return None
    a=T[near,0]; e1=T[near,1]-a; e2=T[near,2]-a; dv=np.array([0,0,-1.0])
    pv=np.cross(dv,e2); det=np.einsum('ij,ij->i',e1,pv); m=np.abs(det)>1e-12
    inv=np.zeros_like(det); inv[m]=1/det[m]; s_=p-a
    u=np.einsum('ij,ij->i',s_,pv)*inv; q=np.cross(s_,e1); w=np.einsum('j,ij->i',dv,q)*inv; t=np.einsum('ij,ij->i',e2,q)*inv
    ok=m&(u>=-1e-6)&(w>=-1e-6)&(u+w<=1+1e-6)&(t>=-0.01)&(t<reach)
    return float(p[2]-t[ok].min()) if ok.any() else None
def floor_edge_distance(f,l):
    # 2D distance from (f, l) to the nearest edge of any slab's top face
    best=9.0
    for sl in floor.reshape(-1,12,3,3) if len(floor)%12==0 else []:
        P=sl.reshape(-1,3); top=P[P[:,2]>P[:,2].max()-0.05][:,:2]
        if len(top)<3 or np.hypot(*(top.mean(0)-[f,l]))>4: continue
        for i in range(len(top)):
            for j in range(i+1,len(top)):
                a=top[i]; b=top[j]; d_=b-a; t=np.clip(((np.array([f,l])-a)@d_)/max(d_@d_,1e-12),0,1)
                best=min(best,float(np.hypot(*(a+t*d_-[f,l]))))
    return best
RC=racks.mean(1) if len(racks) else np.zeros((0,3))
bad_support=[]; bad_hung=[]; bad_align=[]
for k,(mid,axis,R,L) in enumerate(cans):
    # cradle: rays down from the canister's underside meet the rack within 3 cm, at two places at least
    gaps=[]
    for x in np.linspace(-L+0.2,L-0.2,15):
        p=mid+axis*x-np.array([0,0,R-0.001]); h=ray_down(racks,RC,p,0.3)
        if h is not None: gaps.append(p[2]-h)
    if sum(1 for g in gaps if -0.005<=g<=0.03)<2: bad_support.append((k,[round(g,3) for g in gaps[:3]]))
    # hung beside the catwalk: the canister's inboard side within 0.25 m of a slab's outer edge
    dd=floor_edge_distance(mid[0],mid[1])-R
    if dd>0.25: bad_hung.append((k,round(dd,2)))
    # aligned: along the deck edge under it (its two ends' nearest outline points), and level
    e0=OUTLINE_POINT(*(mid-axis*L)[:2]); e1=OUTLINE_POINT(*(mid+axis*L)[:2]); e=(e1-e0)/np.linalg.norm(e1-e0)
    ang=np.degrees(np.arccos(min(1.0,abs(axis[0]*e[0]+axis[1]*e[1])/np.hypot(axis[0],axis[1]))))
    tilt=np.degrees(np.arcsin(min(1.0,abs(axis[2]))))
    if ang>2.0 or tilt>0.5: bad_align.append((k,round(float(ang),2),round(float(tilt),2)))
check('supported',not bad_support,f"{len(bad_support)} canisters off their cradles {bad_support[:4]}")
check('hung',not bad_hung,f"{len(bad_hung)} canisters away from the catwalk {bad_hung[:4]}")
check('aligned',not bad_align,f"{len(bad_align)} canisters askew of the deck edge {bad_align[:4]}")

# --- clear: generated segments against authored triangles and the deck/skirt ---
A=tris['authored']; AA=A[:,0]; AE1=A[:,1]-A[:,0]; AE2=A[:,2]-A[:,0]; AC=A.mean(1)
def crossings(p0,p1,near):
    dv=p1-p0; Ld=np.linalg.norm(dv); dv=dv/Ld; a=AA[near]; e1=AE1[near]; e2=AE2[near]
    pv=np.cross(dv,e2); det=np.einsum('ij,ij->i',e1,pv); m=np.abs(det)>1e-12
    inv=np.zeros_like(det); inv[m]=1/det[m]; s=p0-a
    u=np.einsum('ij,ij->i',s,pv)*inv; q=np.cross(s,e1); w=np.einsum('j,ij->i',dv,q)*inv; t=np.einsum('ij,ij->i',e2,q)*inv
    return int((m&(u>=0)&(w>=0)&(u+w<=1)&(t>0.002)&(t<Ld-0.002)).sum())
bad_clear=[]
for k,(mid,axis,R,L) in enumerate(cans):
    near=np.where(np.linalg.norm(AC-mid,axis=1)<L+R+6)[0]
    side=np.cross(np.array([0,0,1.0]),axis); up=np.array([0,0,1.0])
    segs=[(mid-axis*L,mid+axis*L)]
    for q in np.arange(8)*np.pi/4:
        off=R*0.98*(np.cos(q)*side+np.sin(q)*up); segs.append((mid-axis*(L-0.25)+off,mid+axis*(L-0.25)+off))
        segs.append((mid+off*0.0,mid+off))   # spokes, axis out to the shell
    hits=sum(crossings(p0,p1,near) for p0,p1 in segs) if len(near) else 0
    dist,_=edge_project(mid[0],mid[1])
    if hits or inside_outline(mid[0],mid[1]) or dist<R: bad_clear.append((k,hits,round(float(dist),2)))
def piece_clear(name):
    T=tris.get(name,np.zeros((0,3,3))); bad=0
    for t in T[::2]:   # one triangle of each quad: its three edges
        c=t.mean(0); near=np.where(np.linalg.norm(AC-c,axis=1)<4)[0]
        if len(near) and sum(crossings(t[i],t[(i+1)%3],near) for i in range(3)):
            bad+=1; WHERE.setdefault('crossing '+name,[]).append(tuple(np.round(c,1)))
    return bad
clear_pieces={nm:piece_clear(nm) for nm in ('catwalk','catwalk_railings','raft_racks')}
def polygons_overlap(a,b):
    for poly in (a,b):
        for i in range(len(poly)):
            e=poly[(i+1)%len(poly)]-poly[i]; ax=np.array([-e[1],e[0]])
            pa=a@ax; pb=b@ax
            if pa.max()<=pb.min()+1e-4 or pb.max()<=pa.min()+1e-4: return False
    return True
# a flat authored plate in a slab's own plane over its footprint: they would z-fight
AN=np.cross(A[:,1]-A[:,0],A[:,2]-A[:,0]); AFLAT=np.abs(AN[:,2])/(np.linalg.norm(AN,axis=1)+1e-12)>0.97
zfight=0
for sl in (floor.reshape(-1,12,3,3) if len(floor)%12==0 else []):
    pts=sl.reshape(-1,3); h0=pts[:,2].min(); h1=pts[:,2].max()
    top=pts[pts[:,2]>h1-0.05][:,:2]; c=pts.mean(0)
    quad=top[np.argsort(np.arctan2(*(top-top.mean(0)).T[::-1]))]
    near=np.where(AFLAT&(np.linalg.norm(AC-c,axis=1)<6)&(A[:,:,2].min(1)>h0-0.06)&(A[:,:,2].max(1)<h1+0.06))[0]
    if any(polygons_overlap(A[j][:,:2],quad) for j in near):
        zfight+=1; WHERE.setdefault('z-fight',[]).append(tuple(np.round(c,1)))
clear_pieces['coplanar plates']=zfight
check('clear',not bad_clear and not any(clear_pieces.values()),
      f"{len(bad_clear)} canisters through the ship {bad_clear[:4]}; pieces crossing authored geometry {clear_pieces}")

# --- attached ---
slabs=floor.reshape(-1,12,3,3) if len(floor)%12==0 else None
def on_side(p,tol=0.05):
    # on the skirt (the deck outline) or on an authored surface (the ship's side where it
    # stands outboard of the outline)
    if edge_project(p[0],p[1])[0]<tol: return True
    near=np.where(np.linalg.norm(AC-p,axis=1)<8)[0]
    if not len(near): return False
    t=A[near]; e1=t[:,1]-t[:,0]; e2=t[:,2]-t[:,0]; nrm=np.cross(e1,e2); nl=np.linalg.norm(nrm,axis=1)+1e-12
    dist=np.abs(((p-t[:,0])*nrm).sum(1))/nl
    # foot of the perpendicular inside the triangle
    f=p-(((p-t[:,0])*nrm).sum(1)/nl**2)[:,None]*nrm; r=f-t[:,0]
    d00=(e1*e1).sum(1); d01=(e1*e2).sum(1); d11=(e2*e2).sum(1); d20=(r*e1).sum(1); d21=(r*e2).sum(1)
    den=d00*d11-d01*d01; den[np.abs(den)<1e-12]=1e-12
    v=(d11*d20-d01*d21)/den; w=(d00*d21-d01*d20)/den
    return bool(((dist<tol+0.01)&(v>=-0.02)&(w>=-0.02)&(v+w<=1.02)).any())
bad_slab=0
if slabs is not None:
    for sl in slabs:
        pts=sl.reshape(-1,3); top=pts[:,2].max()
        dist=np.array([edge_project(p[0],p[1])[0] for p in pts])
        inner=pts[np.argsort(dist)[:4]]   # the four inboard corners
        if sum(on_side(p) for p in inner)<4:
            bad_slab+=1; WHERE.setdefault('slab',[]).append(tuple(np.round(inner.mean(0),1)))
rails=tris.get('catwalk_railings',np.zeros((0,3,3))).reshape(-1,3)
posts=[]; bad_post=0
# posts are the railing pieces 1.05 m tall: their lowest vertices must sit on a slab top
RT=tris.get('catwalk_railings',np.zeros((0,3,3)))
def components(T):
    # triangles sharing an edge belong to one piece (pieces that only touch at a corner, a
    # post under a rail end, stay apart)
    key=np.round(T.reshape(-1,3)*1e4).astype(np.int64)
    _,inv=np.unique(key,axis=0,return_inverse=True); inv=inv.reshape(-1,3)
    parent=np.arange(len(inv))
    def find(x):
        while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
        return x
    owner={}
    for ti,(a,b,c) in enumerate(inv):
        for e in ((a,b),(b,c),(c,a)):
            e=(min(e),max(e))
            if e in owner: parent[find(ti)]=find(owner[e])
            else: owner[e]=ti
    roots=np.array([find(t) for t in range(len(inv))])
    return [np.where(roots==r)[0] for r in np.unique(roots)]
FT=floor; FTC=FT.mean(1) if len(FT) else np.zeros((0,3))
def slab_top_at(f,l):
    near=np.where(np.hypot(FTC[:,0]-f,FTC[:,1]-l)<5.0)[0]   # slab faces run a whole segment
    best=None
    for i in near:
        t=FT[i]; nrm=np.cross(t[1]-t[0],t[2]-t[0])
        if nrm[2]<=0.5*np.linalg.norm(nrm): continue
        # point in triangle (2D)
        a,b,c=t[:,:2]; v0=c-a; v1=b-a; v2=np.array([f,l])-a
        d00,d01,d02,d11,d12=v0@v0,v0@v1,v0@v2,v1@v1,v1@v2; den=d00*d11-d01*d01
        if abs(den)<1e-12: continue
        u=(d11*d02-d01*d12)/den; v=(d00*d12-d01*d02)/den
        if u>=-1e-3 and v>=-1e-3 and u+v<=1+1e-3:
            h=t[0,2]+u*(t[2,2]-t[0,2])+v*(t[1,2]-t[0,2]); best=h if best is None else max(best,h)
    return best
for comp in components(RT):
    P=RT[comp].reshape(-1,3); hspan=P[:,2].max()-P[:,2].min(); fp=np.ptp(P[:,0])+np.ptp(P[:,1])
    if hspan>0.9 and fp<0.3:   # a post
        c=P.mean(0); top=slab_top_at(c[0],c[1])
        if top is None or abs(P[:,2].min()-top)>0.02:
            bad_post+=1; WHERE.setdefault('post',[]).append((tuple(np.round(c,1)),None if top is None else round(float(P[:,2].min()-top),3)))
        posts.append(1)
BT=tris.get('catwalk_braces',np.zeros((0,3,3))); bad_brace=0; nbrace=0
for comp in components(BT):
    P=BT[comp].reshape(-1,3); nbrace+=1
    lo=P[P[:,2]<P[:,2].min()+0.08].mean(0); hi=P[P[:,2]>P[:,2].max()-0.08].mean(0)
    top=slab_top_at(hi[0],hi[1])
    foot=lo+np.array([0,0,-0.03])
    if not (on_side(foot,0.10) or on_side(lo,0.10)) or top is None or not (-0.2<hi[2]-(top-0.10)<0.05):
        bad_brace+=1; WHERE.setdefault('brace',[]).append((tuple(np.round(lo,2)),None if top is None else round(float(hi[2]-(top-0.10)),3)))
check('attached',slabs is not None and bad_slab==0 and bad_post==0 and bad_brace==0 and len(posts)>0,
      f"{0 if slabs is None else len(slabs)} slabs ({bad_slab} off the skirt), {len(posts)} posts ({bad_post} not on a slab), {nbrace} braces ({bad_brace} not slab-to-skirt)")

# --- outward ---
bad_out={}
for name in ('catwalk','catwalk_railings','catwalk_braces','raft_racks','raft_straps'):
    T=tris.get(name)
    if T is None: continue
    n=0
    for comp in components(T):
        t=T[comp]; m=t.mean(1); nrm=np.cross(t[:,1]-t[:,0],t[:,2]-t[:,0]); P=t.reshape(-1,3)
        if np.ptp(P,axis=0).max()<=2.0: c=np.broadcast_to(P.mean(0),m.shape)
        else:   # a chain of collinear rails along a curve: each face against its own stretch
            c=np.array([m[np.linalg.norm(m-x,axis=1)<0.25].mean(0) for x in m])
        n+=int((((m-c)*nrm).sum(1)<0).sum())
    bad_out[name]=n
nc=0
for k,(mid,axis,R,L) in enumerate(cans):
    f=F[(F>=34*k).all(1)&(F<34*k+34).all(1)]; t=V[f]; nrm=np.cross(t[:,1]-t[:,0],t[:,2]-t[:,0])
    m=t.mean(1); q=mid+np.outer((m-mid)@axis,axis); radial=m-q
    endcap=np.abs((m-mid)@axis)>L-0.3   # domed ends face along the axis as well as out
    out=np.where(endcap,((m-mid)*nrm).sum(1),(radial*nrm).sum(1))
    nc+=int((out<0).sum())
bad_out['raft_canisters']=nc
check('outward',not any(bad_out.values()),f"inward faces per mesh {bad_out}")

# --- cabs ---
from cabs import CABS, axes as cab_axes, footprint as cab_footprint, LENGTH as CAB_L, WIDTH as CAB_W, HEIGHT as CAB_H, \
    PLATE as CAB_PLATE, BORDER as CAB_BORDER, HATCH as CAB_HATCH, WHEEL_CLEAR
import os, re
_engine=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','web','src','game','engine.ts')).read()
_nimitz=_engine[_engine.index('nimitz:{'):]
STROKE=float(re.search(r'stroke:([\d.]+)',_nimitz).group(1))
SHUTTLES=[tuple(map(float,m)) for m in re.findall(r'\{x:([-\d.]+), z:([-\d.]+), h:([-\d.]+)\}',_nimitz[:_nimitz.index(']')])]
MAIN_WHEELS=6.0   # the main wheels sit this far aft of the nose wheel on the shuttle (F/A-18C wheelbase 5.4 m)
def track_distance(points,shuttle):
    # least distance from the points to the catapult's centreline over the jet's run (heading + = to
    # port): for a straight run past a convex cab the nearest point of the cab is one of its corners
    x,z,h=shuttle; d=np.array([np.cos(np.radians(h)),-np.sin(np.radians(h))])
    a=np.array([x,z])-MAIN_WHEELS*d; q=points[:,:2]-a; s=np.clip(q@d,0,MAIN_WHEELS+STROKE)
    return float(np.hypot(*(q-s[:,None]*d).T).min())
from PIL import Image
CABT=np.concatenate([tris[k] for k in ('iccs_cab','iccs_glass') if k in tris]+[np.zeros((0,3,3))]); CC=CABT.mean(1)
DT=tris.get('deck_baked',np.zeros((0,3,3))); DTC=DT.mean(1)
TEX=np.asarray(Image.open('decktex12.png').convert('RGB')).astype(int)
def texel(p): return TEX[int((p[1]+52)/100*TEX.shape[0]), int((p[0]+172)/344*TEX.shape[1])]
def ring(cab,grow): q=cab_footprint(cab,grow); return [q[k]+(q[(k+1)%8]-q[k])*t for k in range(8) for t in np.linspace(0.1,0.9,5)]
PLATE_GREY=np.array([150,152,153])   # bake_decktex.py
def deck_height(p):
    # the drawn deck strip's height straight below p: its triangles are metres across, so test them all
    a=DT[:,0,:2]; e1=DT[:,1,:2]-a; e2=DT[:,2,:2]-a; q=p-a
    det=e1[:,0]*e2[:,1]-e1[:,1]*e2[:,0]; ok=np.abs(det)>1e-12; det=np.where(ok,det,1)
    s=(q[:,0]*e2[:,1]-q[:,1]*e2[:,0])/det; t=(e1[:,0]*q[:,1]-e1[:,1]*q[:,0])/det
    hit=ok&(s>=-1e-9)&(t>=-1e-9)&(s+t<=1+1e-9)
    if not hit.any(): return None
    z=DT[hit,0,2]+s[hit]*(DT[hit,1,2]-DT[hit,0,2])+t[hit]*(DT[hit,2,2]-DT[hit,0,2]); return float(z.max())
claimed=np.zeros(len(CABT),bool); bad_cab=[]; cab_inward=0
for i,cab in enumerate(CABS):
    c,u,w=cab_axes(cab); mine=np.hypot(CC[:,0]-c[0],CC[:,1]-c[1])<4.0; claimed|=mine
    if not mine.any(): bad_cab.append((i,'missing')); continue
    T=CABT[mine]; P=T.reshape(-1,3)
    x=(P[:,0]-c[0])*u[0]+(P[:,1]-c[1])*u[1]; y=(P[:,0]-c[0])*w[0]+(P[:,1]-c[1])*w[1]
    deckh=deck_height(c)
    if deckh is None: bad_cab.append((i,'no deck under it')); continue
    got=np.round([x.max()-x.min(),y.max()-y.min(),(x.max()+x.min())/2,(y.max()+y.min())/2,P[:,2].max()-deckh,P[:,2].min()-deckh],3)
    want=[CAB_L,CAB_W,0.0,0.0,CAB_H+CAB_HATCH[2]]
    if any(abs(g-v)>0.02 for g,v in zip(got,want)) or not -0.10<got[5]<=0.0: bad_cab.append((i,'size/place',list(got)))
    if any(np.abs(texel(p)-PLATE_GREY).max()>6 for p in ring(cab,(CAB_PLATE-CAB_BORDER)/2)): bad_cab.append((i,'no plate round the base'))
    if any(np.ptp(texel(p))<80 for p in ring(cab,CAB_PLATE-CAB_BORDER/2)): bad_cab.append((i,'no red/yellow border round the plate'))
    near=[round(track_distance(P,s),2) for s in SHUTTLES]
    if min(near)<WHEEL_CLEAR: bad_cab.append((i,'a catapult runs too close',near))
    # every face away from the cab's middle, the hatch's faces away from the hatch's
    hc=c+u*CAB_HATCH[0]; m=T.mean(1); nrm=np.cross(T[:,1]-T[:,0],T[:,2]-T[:,0])
    roof=P[:,2].max()-CAB_HATCH[2]
    hatch=(np.hypot(m[:,0]-hc[0],m[:,1]-hc[1])<CAB_HATCH[1]+0.02)&(m[:,2]>roof+0.001)
    ctr=np.where(hatch[:,None],[hc[0],hc[1],roof+CAB_HATCH[2]/2],[c[0],c[1],roof-CAB_H/2])
    cab_inward+=int((((m-ctr)*nrm).sum(1)<=0).sum())
if not claimed.all(): bad_cab.append(('stray cab faces',int((~claimed).sum())))
if cab_inward: bad_cab.append(('inward cab faces',cab_inward))
# the original bow cab stood at fa 67-70: nothing but the deck may stand there now
old=[k for k,T in tris.items() if k not in ('deck_baked','deck_underside') and
     (((T[...,0]>66.5)&(T[...,0]<71)&(T[...,1]>5.5)&(T[...,1]<9.5)&(T[...,2]>0.71)).any())]
if old: bad_cab.append(('old bow cab still there',old))
check('cabs',not bad_cab,f"{len(CABS)} cabs {bad_cab[:4] if bad_cab else 'placed, sized, on their plates, facing out; old bow cab gone'}")

if VERBOSE:
    for k,v in WHERE.items(): print(f'  {k}: {v[:30]}')
print('\nALL PASS' if not failures else f"\nFAILED: {', '.join(failures)}")
sys.exit(1 if failures else 0)
