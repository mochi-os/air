"""Sky-through-ship corridor finder: voxelize the built nimitz-clean.glb at 0.5 m,
then scan straight lines at every height (0.5 m layers) and angle (5 deg steps) for
free stretches that are flanked by hull on both lateral sides - candidate
see-through corridors. Bulk discovery tool, NOT an acceptance test: it OVER-REPORTS
(open air under the bow/stern deck overhangs and below the hull flare flags as
flanked), and its voxel resolution misses nothing thinner than 0.5 m. Use it to
find candidate families, verify each with an exact ray in raycheck.py, and judge
the visual result in game. See raycheck.py's header for the v76-v80 history and
the accepted-unresolved status of this defect class."""
import json, struct, sys
from collections import defaultdict
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

# collect surface sample points (deck frame, metres)
CELL=0.5
pts=[]
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
        T=np.stack([fa,la,hh],axis=2)   # (n,3verts,3)
        keep=(T[:,:,2].max(1)>-14)&(T[:,:,2].min(1)<1.5)
        T=T[keep]
        if not len(T): continue
        # sample: vertices + edge midpoints + centroid + subdivision by edge length
        A,Bv,C=T[:,0],T[:,1],T[:,2]
        emax=np.maximum(np.linalg.norm(Bv-A,axis=1),np.maximum(np.linalg.norm(C-Bv,axis=1),np.linalg.norm(A-C,axis=1)))
        for sub in range(1,7):
            sel=(emax>CELL*sub*0.9)|(np.zeros(len(T),bool) if sub>1 else np.ones(len(T),bool))
            if not sel.any(): continue
            n2=sub+1
            for i2 in range(n2):
                for j2 in range(n2-i2):
                    u=i2/max(n2-1,1); vv=j2/max(n2-1,1)
                    if u+vv>1.0001: continue
                    pts.append(A[sel]*(1-u-vv)+Bv[sel]*u+C[sel]*vv)
pts=np.concatenate(pts)
print(f"surface samples: {len(pts):,}")
FA0,FA1,LA0,LA1,H0,H1=-175.0,175.0,-46.0,46.0,-14.0,1.5
ix=((pts[:,0]-FA0)/CELL).astype(np.int32); iy=((pts[:,1]-LA0)/CELL).astype(np.int32); iz=((pts[:,2]-H0)/CELL).astype(np.int32)
NX=int((FA1-FA0)/CELL); NY=int((LA1-LA0)/CELL); NZ=int((H1-H0)/CELL)
ok=(ix>=0)&(ix<NX)&(iy>=0)&(iy<NY)&(iz>=0)&(iz<NZ)
occ=np.zeros((NZ,NY,NX),bool)
occ[iz[ok],iy[ok],ix[ok]]=True
print(f"grid {NX}x{NY}x{NZ}, occupied {occ.sum():,}")


# --- flanked-corridor scan ---

# per-layer, per-fa-column lat bounds of occupied voxels
def flanked(zc, f, l):
    xi=int((f-FA0)/CELL); yi=int((l-LA0)/CELL)
    if xi<1 or xi>=NX-1: return False
    for z2 in (zc,min(zc+1,NZ-1)):
        row=occ[z2,:,max(0,xi-1):xi+2]
        ys=np.nonzero(row.any(axis=1))[0]
        if len(ys) and ys.min()<yi-2 and ys.max()>yi+2:
            return True
    return False

corridors=[]
for zc in range(NZ-1):
    h=H0+(zc+0.5)*CELL
    if h>0.4 or h<-11: continue
    layer=occ[zc]|occ[min(zc+1,NZ-1)]
    oy,ox=np.nonzero(layer)
    if not len(ox): continue
    cx2=FA0+(ox+0.5)*CELL; cy2=LA0+(oy+0.5)*CELL
    for deg in range(0,180,5):
        th=np.radians(deg)
        dvec=np.array([np.cos(th),np.sin(th)])
        pv=np.array([-dvec[1],dvec[0]])
        u=cx2*dvec[0]+cy2*dvec[1]; vv=cx2*pv[0]+cy2*pv[1]
        vb=np.round(vv/CELL).astype(np.int32)
        order=np.lexsort((u,vb))
        vb_s=vb[order]; u_s=u[order]
        uniq,starts=np.unique(vb_s,return_index=True)
        for k in range(len(uniq)):
            vbin=uniq[k]
            s0=starts[k]; s1=starts[k+1] if k+1<len(uniq) else len(vb_s)
            us=np.sort(u_s[s0:s1])
            vmid=vbin*CELL
            p0=pv*vmid
            # gaps between occupied stretches + the open ends
            segs=[]
            if len(us)>=2:
                dif=np.diff(us)
                for gi in np.nonzero(dif>6.0)[0]:
                    segs.append((us[gi]+0.5,us[gi+1]-0.5,'between'))
            if len(us)>=1:
                segs.append((us[-1]+0.5,us[-1]+40.0,'exit'))
                segs.append((us[0]-40.0,us[0]-0.5,'enter'))
            for (t0,t1,kind) in segs:
                if t1-t0<6.0: continue
                samples=np.arange(t0+1.0,t1-1.0,1.5)
                if not len(samples): continue
                nfl=0
                for tt in samples:
                    q=p0+dvec*tt
                    if flanked(zc,q[0],q[1]): nfl+=1
                if kind=='between':
                    continue   # bounded both ends by geometry: you see the far wall, not sky
                if nfl>=3:
                    q0=p0+dvec*max(t0, samples[0]); q1=p0+dvec*min(t1,samples[-1])
                    corridors.append((h,deg,tuple(np.round(q0,1)),tuple(np.round(q1,1))))
print(f"open-to-sky flanked corridors: {len(corridors)}")
group=defaultdict(list)
for h,deg,e0,e1 in corridors:
    group[(round((e0[0]+e1[0])/2/10)*10,round((e0[1]+e1[1])/2/10)*10)].append((h,deg,e0,e1))
for k2,v2 in sorted(group.items()):
    hs=[x[0] for x in v2]
    print(f"  mid~fa {k2[0]:5.0f} lat {k2[1]:5.0f}: {len(v2):4d} rays h {min(hs):.1f}..{max(hs):.1f} eg {v2[0][2]}->{v2[0][3]} deg{v2[0][1]}")
