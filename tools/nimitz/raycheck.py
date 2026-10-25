"""Sky-through-ship regression rays: exact Moller-Trumbore casts of straight paths through the hull
volume against nimitz-clean.glb. A ray passes only if the first surface it meets is DRAWN: every ship
material is single-sided, so a face met from behind is culled and shows what lies beyond it. Counting
any triangle as a block is what let the deck underside plate face up, invisible from below, while every
ray here passed (v80-v82: sky through the deck from sea level). Run after any edit touching the hull,
skirt, deck strip, underside or band-clear rules; exits non-zero on a see-through ray. A new sighting:
reproduce the in-game camera as a ray here first, watch it fail, then fix.
Usage: raycheck.py [glb]   (default nimitz-clean.glb)"""
import json, struct, sys
import numpy as np
GLB=sys.argv[1] if len(sys.argv)>1 else 'nimitz-clean.glb'
CX,CZ,DECKY,S=6361.3,-469.3,776.0,0.025
d=open(GLB,'rb').read()
cl=struct.unpack('<I',d[12:16])[0]
G=json.loads(d[20:20+cl]); bin0=d[20+cl+8:]
CT={5121:np.uint8,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC={'SCALAR':1,'VEC2':2,'VEC3':3}
def readA(ai):
    a=G['accessors'][ai]; bv=G['bufferViews'][a['bufferView']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    n=a['count']*NC[a['type']]
    arr=np.frombuffer(bin0,dtype=CT[a['componentType']],count=n,offset=off)
    return arr.reshape(a['count'],NC[a['type']]) if NC[a['type']]>1 else arr
def trs(n):
    if 'matrix' in n: return np.array(n['matrix'],dtype=np.float64).reshape(4,4).T
    M=np.eye(4)
    t=n.get('translation',[0,0,0]); r=n.get('rotation',[0,0,0,1]); s=n.get('scale',[1,1,1])
    x,y,z,w=r
    R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    M[:3,:3]=R*np.array(s)[None,:]; M[:3,3]=t
    return M
W={}
def walk(i,P):
    W[i]=P@trs(G['nodes'][i])
    for c in G['nodes'][i].get('children',[]): walk(c,W[i])
for r in G['scenes'][G.get('scene',0)]['nodes']: walk(r,np.eye(4))
T=[]; NRM=[]; DS=[]
for ni,n in enumerate(G['nodes']):
    if 'mesh' not in n: continue
    det=np.linalg.det(W[ni][:3,:3])
    for p in G['meshes'][n['mesh']]['primitives']:
        v=readA(p['attributes']['POSITION']).astype(np.float64)
        w=(W[ni][:3,:3]@v.T).T+W[ni][:3,3]
        if 'indices' in p:
            idx=readA(p['indices']).ravel().astype(np.int64); idx=idx[:len(idx)//3*3]
            t=w[idx].reshape(-1,3,3)
        else: t=w[:len(w)//3*3].reshape(-1,3,3)
        fa=(t[:,:,0]-CX)*S; la=(t[:,:,2]-CZ)*S; hh=(t[:,:,1]-DECKY)*S
        T.append(np.stack([fa,la,hh],axis=2))
        # front normal from the model-frame winding (a mirrored node flips it, as the renderer
        # does), then the same axis permutation as the points so the facing test can use it
        fn=np.cross(t[:,1]-t[:,0],t[:,2]-t[:,0])*(1 if det>=0 else -1)
        NRM.append(np.stack([fn[:,0],fn[:,2],fn[:,1]],axis=1))
        m=p.get('material'); DS.append(np.full(len(t),bool(m is not None and G['materials'][m].get('doubleSided',False))))
T=np.concatenate(T); NRM=np.concatenate(NRM); DS=np.concatenate(DS)
print(f"tris: {len(T):,}")
A=T[:,0]; E1=T[:,1]-T[:,0]; E2=T[:,2]-T[:,0]
def cast(o,e):
    o=np.array(o,np.float64); e=np.array(e,np.float64)
    dv=e-o; L=np.linalg.norm(dv); dv=dv/L
    hits=[]
    for c0 in range(0,len(T),200000):
        a=A[c0:c0+200000]; e1=E1[c0:c0+200000]; e2=E2[c0:c0+200000]
        p=np.cross(dv,e2)
        det=np.einsum('ij,ij->i',e1,p)
        m=np.abs(det)>1e-12
        inv=np.zeros_like(det); inv[m]=1.0/det[m]
        s=o-a
        u=np.einsum('ij,ij->i',s,p)*inv
        q=np.cross(s,e1)
        vv=np.einsum('j,ij->i',dv,q)*inv
        tt=np.einsum('ij,ij->i',e2,q)*inv
        ok=m&(u>=-1e-9)&(vv>=-1e-9)&(u+vv<=1+1e-9)&(tt>0.01)&(tt<L-0.01)
        for k in np.nonzero(ok)[0]:
            g=c0+k; hits.append((tt[k], bool(DS[g] or NRM[g]@dv<0)))
    return sorted(hits)
def first_drawn(h):
    """the first surface along the ray, faces within 2 cm counted together (the authored model
    pairs most faces back to back): drawn if any of them faces the eye"""
    if not h: return False
    return any(d for t,d in h if t-h[0][0]<0.02)
RAYS=[
 ("el4 diagonal port-aft -> stbd-fwd", (-30,-45,-3),(40,45,-2)),
 ("under-skirt graze at waist",        (-66,-60,-4),(-40,60,-1)),
 ("beam crossing at bow quarter",      (100,-40,-3),(100,40,-3)),
 ("stern quarter diagonal",            (-175,-20,-4),(-140,30,-3)),
 ("steep up from below port quarter",  (-80,-40,-12),(-40,10,5)),
 ("bow overhang beam crossing",        (150,-20,-2),(150,20,-2)),
 ("bow overhang diagonal",             (120,-25,-5),(170,25,-1)),
 ("stern overhang beam",               (-160,-25,-3),(-160,25,-3)),
 ("shallow fore-aft through bow",      (100,-14,-4),(180,0,-2)),
 ("stern low to bow high diagonal",    (-170,-10,-8),(-100,15,0)),
 ("sea level up through port waist",   (-72,-54,-21),(-72,-27.75,6)),   # the user's view: the jet on cat 4 seen through the deck
 ("vertical under port waist overhang",(-72,-36,-21),(-72,-36,10)),
]
allhit=True
for name,o,e in RAYS:
    h=cast(o,e)
    if first_drawn(h): status="HIT %d (first at %.1fm)"%(len(h),h[0][0])
    elif h: status="*** CULLED at %.1fm — SEE-THROUGH ***"%h[0][0]
    else: status="*** CLEAR — SEE-THROUGH ***"
    if not first_drawn(h): allhit=False
    print(f"  {name:36s} {status}")
print("\nALL RAYS HIT (necessary, not sufficient - see header)" if allhit else "\nSEE-THROUGH RAYS - sky through ship")
sys.exit(0 if allhit else 1)
