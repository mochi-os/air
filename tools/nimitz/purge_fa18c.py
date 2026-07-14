#!/usr/bin/env python3
"""F/A-18C sealed-interior purge — rig-safe byte surgery (NO Blender, NO repack).

Same voxel flood-fill as the carrier, scaled down:
  - 0.15 m voxels; occupancy from OPAQUE primitives only (canopy glass, decals etc.
    neither occlude nor get deleted — the cockpit stays visible through the canopy)
  - outside air floods from the bounds (intakes, exhausts, gear wells with gear down
    are open -> their visible interiors are reachable and survive)
  - a triangle dies only if BOTH ±0.25 m probes land in sealed, unreachable, empty air,
    in EVERY node instance of its primitive
  - the file keeps every node, mesh, accessor and the animation untouched; only new
    index accessors are appended (a shrunk index list per purged primitive)
"""
import json, struct, os
import numpy as np
from collections import defaultdict

PATH='/home/alistair/mochi/apps/air/web/public/aircraft/fa18c/model.glb'
VOX=0.15; PROBE=0.25

data=open(PATH,'rb').read()
clen,_=struct.unpack('<II',data[12:20])
G=json.loads(data[20:20+clen]); boff=20+clen
blen,_=struct.unpack('<II',data[boff:boff+8])
B=bytearray(data[boff+8:boff+8+blen])
acc=G['accessors']; bvs=G['bufferViews']; nodes=G['nodes']; mats=G['materials']
TRANS={i for i,m in enumerate(mats) if m.get('alphaMode') in ('BLEND','MASK')}

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
# some mesh nodes are outside the scene graph (rig helpers): resolve via parent chains,
# orphans get identity — same as the engine's loader behaviour
parent={}
for i,n in enumerate(nodes):
    for c in n.get('children',[]): parent[c]=i
def resolve(i):
    if i in world: return world[i]
    chain=[]; j=i
    while j not in world and j in parent:
        chain.append(j); j=parent[j]
    M=world.get(j,np.eye(4))
    for k in reversed(chain):
        M=M@trs(nodes[k]); world[k]=M
    world[i]=M if i in world else (M if not chain or chain[0]!=i else world[chain[0]])
    if i not in world: world[i]=M
    return world[i]
for i,n in enumerate(nodes):
    if 'mesh' in n and i not in world: resolve(i)
def readspan(ai):
    a=acc[ai]; bv=bvs[a['bufferView']]
    comps={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
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
    return np.frombuffer(bytes(B[off:off+cnt*comps*isz]),dt).reshape(cnt,comps)

inst=defaultdict(list)
for ni,n in enumerate(nodes):
    if 'mesh' in n: inst[n['mesh']].append(ni)

print("voxelizing (opaque only)...")
allmin=np.array([1e18]*3); allmax=np.array([-1e18]*3)
cache=[]
for mi,nis in inst.items():
    for p in G['meshes'][mi]['primitives']:
        pos_ai=p['attributes'].get('POSITION')
        if pos_ai is None: continue
        opaque=p.get('material',-1) not in TRANS
        v=readA(pos_ai).astype(np.float64)
        if 'indices' in p: idx=readA(p['indices']).ravel().astype(np.int64)
        else: idx=np.arange(len(v),dtype=np.int64)
        idx=idx[:len(idx)//3*3]
        for ni in nis:
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            t=w[idx].reshape(-1,3,3)
            cache.append((mi,p,opaque,t))
            if len(t):
                allmin=np.minimum(allmin,t.reshape(-1,3).min(0)); allmax=np.maximum(allmax,t.reshape(-1,3).max(0))
orig0=allmin-VOX*3; dims=np.ceil((allmax-orig0)/VOX).astype(int)+5
occ=np.zeros(dims,dtype=bool)
for _,_,opaque,t in cache:
    if not opaque or not len(t): continue
    e1=t[:,1]-t[:,0]; e2=t[:,2]-t[:,0]
    L=np.maximum(np.linalg.norm(e1,axis=1),np.linalg.norm(e2,axis=1))
    for i2 in range(len(t)):
        n2=max(1,int(L[i2]/(VOX*0.6))+1)
        us,vs=np.meshgrid(np.linspace(0,1,n2+1),np.linspace(0,1,n2+1))
        mm=(us+vs)<=1.0
        pts=t[i2,0][None,:]+np.outer(us[mm],e1[i2])+np.outer(vs[mm],e2[i2])
        ijk=((pts-orig0)/VOX).astype(int)
        occ[ijk[:,0],ijk[:,1],ijk[:,2]]=True
print(f"  occupancy {occ.sum():,} of {occ.size:,} ({dims})")
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
print(f"  outside {outside.sum():,}, sealed {int((empty&~outside).sum()):,}")
def vox_state(pts):
    ijk=((pts-orig0)/VOX).astype(int)
    oob=(ijk<0).any(1)|(ijk>=dims[None,:]).any(1)
    ijk=np.clip(ijk,0,np.array(dims)-1)
    st=np.where(occ[ijk[:,0],ijk[:,1],ijk[:,2]],1,np.where(outside[ijk[:,0],ijk[:,1],ijk[:,2]],0,2))
    st[oob]=0
    return st
per_prim={}
for mi,p,opaque,t in cache:
    if not opaque or not len(t): continue
    e1=t[:,1]-t[:,0]; e2=t[:,2]-t[:,0]
    fn=np.cross(e1,e2); nl=np.linalg.norm(fn,axis=1,keepdims=True)+1e-12
    fn=fn/nl
    c=t.mean(1)
    interior=(vox_state(c+fn*PROBE)==2)&(vox_state(c-fn*PROBE)==2)
    k=id(p)
    if k in per_prim:
        pm,_=per_prim[k]; per_prim[k]=(pm&interior,p)
    else:
        per_prim[k]=(interior,p)
def addidx(arr,ct):
    global B
    while len(B)%4: B.append(0)
    off=len(B)
    if ct==5123: payload=arr.astype(np.uint16).tobytes()
    else: payload=arr.astype(np.uint32).tobytes()
    B.extend(payload)
    bvs.append({'buffer':0,'byteOffset':off,'byteLength':len(payload),'target':34963})
    acc.append({'bufferView':len(bvs)-1,'byteOffset':0,'componentType':ct,'count':len(arr),'type':'SCALAR'})
    return len(acc)-1
purged=0; prims=0
for k,(interior,p) in per_prim.items():
    if not interior.any(): continue
    if 'indices' in p:
        idx=readA(p['indices']).ravel().astype(np.int64)
        ct=acc[p['indices']]['componentType']
    else:
        v=readA(p['attributes']['POSITION'])
        idx=np.arange(len(v),dtype=np.int64); ct=5125
    idx=idx[:len(idx)//3*3]
    tri=idx.reshape(-1,3)
    keep=tri[~interior]
    purged+=int(interior.sum()); prims+=1
    # keep the primitive present even if empty of visible tris (rig safety): one degenerate tri
    if len(keep)==0: keep=tri[:1]*0
    p['indices']=addidx(keep.ravel(), 5125 if keep.max(initial=0)>65535 else ct)
print(f"purged {purged} sealed tris across {prims} prims")
js=json.dumps(G,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4)
while len(B)%4: B.append(0)
total=12+8+len(js)+8+len(B)
with open(PATH,'wb') as f:
    f.write(struct.pack('<III',0x46546C67,2,total))
    f.write(struct.pack('<II',len(js),0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II',len(B),0x004E4942)); f.write(bytes(B))
print(f"written: {os.path.getsize(PATH):,} bytes")
