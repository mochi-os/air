"""Sky-through-ship regression rays: exact Moller-Trumbore casts of straight paths
through the hull volume against the built nimitz-clean.glb. A CLEAR ray = that
sightline shows sky through the ship in game. Run after ANY edit touching the hull,
skirt, deck strip, underside, or band-clear rules; exits non-zero on a clear ray.

KNOWN LIMITATION (the hard lesson of 2026-07-12/13, v76-v80): this ray set is
necessary but NOT sufficient. The v80 build passes all ten rays, yet the user
repeatedly observed sky-through from in-game viewpoints these rays do not
reproduce - four fixes (deck underside, 5 m skirt, hangar walls, closed interior
liner) each eliminated the paths measured here without eliminating what the user
saw. The sky-from-below defect class is ACCEPTED AS UNRESOLVED as of v80 (user
decision; v77-v79 reverted). If it is ever reopened: FIRST reproduce the user's
exact in-game camera (position + orientation, not a guess from the screenshot),
add that ray here, watch it fail, and only then design the fix. skyprobe.py finds
candidate corridors in bulk but over-reports open air under the overhangs/flare."""
import json, struct
import numpy as np
GLB='nimitz-clean.glb'
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
T=[]
for ni,n in enumerate(G['nodes']):
    if 'mesh' not in n: continue
    for p in G['meshes'][n['mesh']]['primitives']:
        v=readA(p['attributes']['POSITION']).astype(np.float64)
        w=(W[ni][:3,:3]@v.T).T+W[ni][:3,3]
        if 'indices' in p:
            idx=readA(p['indices']).ravel().astype(np.int64); idx=idx[:len(idx)//3*3]
            t=w[idx].reshape(-1,3,3)
        else: t=w[:len(w)//3*3].reshape(-1,3,3)
        fa=(t[:,:,0]-CX)*S; la=(t[:,:,2]-CZ)*S; hh=(t[:,:,1]-DECKY)*S
        T.append(np.stack([fa,la,hh],axis=2))
T=np.concatenate(T)
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
        if ok.any(): hits.extend(tt[ok].tolist())
    return sorted(hits)
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
]
allhit=True
for name,o,e in RAYS:
    h=cast(o,e)
    status="HIT %d (first at %.1fm)"%(len(h),h[0]) if h else "*** CLEAR — SEE-THROUGH ***"
    if not h: allhit=False
    print(f"  {name:36s} {status}")
print("\nALL RAYS HIT (necessary, not sufficient - see header)" if allhit else "\nCLEAR RAYS - sky through ship")
import sys
sys.exit(0 if allhit else 1)
