#!/usr/bin/env python3
"""Extract the ICCS cab geometry from the pristine original into cab38.npy / cab1.npy —
the verbatim transplant that build_carrier.py re-adds (dropped 0.64 m flush).

The bow ICCS (ICCSZONES[0] = fa 64.5..73.0, lat 4.5..11.5) is an octagonal cab, 3.1x2.8 m,
0.5 m tall: material_38 walls (~134 tris) + a 16-tri material_1 glass band at h 0.82..0.97.
The originals sit slightly proud with a floating duplicate; build_carrier deletes them via
ICCSZONES and re-adds this extraction dropped 0.64 m so the cab sits flush.

Output is a flat per-triangle WORLD-coordinate vertex soup (n*3, 3) — add_soup(deckframe=False)
consumes it directly. Run once; build_carrier.py loads the .npy files.
"""
import json, struct
import numpy as np

ORIG = '/home/alistair/mochi/apps/air/downloads/uss_nimitz_cvn-68_aircraft_carrier.glb'
S = 0.025; CX, CZ = 6361.3, -469.3; DECKY = 776.0
ZONE = (64.5, 73.0, 4.5, 11.5)   # ICCSZONES[0]
DROP = 0.64 / S                  # 0.64 m flush drop, in world Y units

data = open(ORIG,'rb').read()
clen,_ = struct.unpack('<II', data[12:20])
G = json.loads(data[20:20+clen]); boff = 20+clen
blen,_ = struct.unpack('<II', data[boff:boff+8])
B = data[boff+8:boff+8+blen]
acc=G['accessors']; bvs=G['bufferViews']; nodes=G['nodes']; mats=G['materials']

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
def readA(ai):
    a=acc[ai]; bv=bvs[a['bufferView']]
    comps={'SCALAR':1,'VEC3':3}[a['type']]
    dt={5126:np.float32,5125:np.uint32,5123:np.uint16,5121:np.uint8}[a['componentType']]
    isz=np.dtype(dt).itemsize
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    stride=bv.get('byteStride',comps*isz)
    if stride!=comps*isz:
        raw=np.frombuffer(B,np.uint8,a['count']*stride,off).reshape(a['count'],stride)
        return np.ascontiguousarray(raw[:,:comps*isz]).view(dt).reshape(a['count'],comps)
    return np.frombuffer(B,dt,a['count']*comps,off).reshape(a['count'],comps)

matidx={m.get('name'):i for i,m in enumerate(mats)}
def extract(matname):
    want=matidx[matname]
    soup=[]
    for ni,n in enumerate(nodes):
        if 'mesh' not in n: continue
        for p in G['meshes'][n['mesh']]['primitives']:
            if p.get('material')!=want: continue
            v=readA(p['attributes']['POSITION']).astype(np.float64)
            if 'indices' in p: idx=readA(p['indices']).ravel().astype(np.int64)
            else: idx=np.arange(len(v),dtype=np.int64)
            idx=idx[:len(idx)//3*3]
            w=(world[ni][:3,:3]@v.T).T+world[ni][:3,3]
            t=w[idx].reshape(-1,3,3)
            if not len(t): continue
            c=t.mean(1)
            fa=(c[:,0]-CX)*S; la=(c[:,2]-CZ)*S
            keep=(fa>ZONE[0])&(fa<ZONE[1])&(la>ZONE[2])&(la<ZONE[3])
            if keep.any(): soup.append(t[keep])
    if not soup: return np.zeros((0,3),np.float64)
    T=np.concatenate(soup)
    T[:,:,1]-=DROP           # flush drop
    return T.reshape(-1,3)

cab38=extract('material_38'); np.save('cab38.npy', cab38)
cab1 =extract('material_1');  np.save('cab1.npy',  cab1)
print(f"cab38.npy: {len(cab38)//3} tris   cab1.npy: {len(cab1)//3} tris")
