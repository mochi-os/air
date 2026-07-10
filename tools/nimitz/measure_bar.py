#!/usr/bin/env python3
"""Measure the deployed launch-bar tip fore-aft reach in the OWNSHIP frame, so the shuttle
mesh can be drawn under the bar tip instead of under the nose wheel.

Replicates normalise_model (engine.ts): scale = length/max(static bbox dim), centre on the
static bbox, proto rotation yaw 90 about Y, proto.position.x = nose - wheel. After that the
ownship +X is forward (nose gear at x = nose = 4.9). The bar chain (nose-gear subtree) is
evaluated at the DEPLOYED pose (each animated ancestor at its channel's last keyframe = gear
down + bar hookup); the static bbox uses the authored (gear-up) pose, matching the engine.
"""
import json, struct
import numpy as np

P='web/public/aircraft/fa18c/model.glb'
LENGTH=17.07; YAW=90.0; NOSE=4.9; WHEEL=2.85
D2R=np.pi/180

data=open(P,'rb').read()
clen,_=struct.unpack('<II',data[12:20])
G=json.loads(data[20:20+clen]); boff=20+clen
blen,_=struct.unpack('<II',data[boff:boff+8])
B=data[boff+8:boff+8+blen]
acc=G['accessors']; bvs=G['bufferViews']; nodes=G['nodes']

def readA(ai):
    a=acc[ai]; bv=bvs[a['bufferView']]
    comps={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    dt={5126:np.float32,5125:np.uint32,5123:np.uint16,5121:np.uint8,5120:np.int8}[a['componentType']]
    isz=np.dtype(dt).itemsize
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    stride=bv.get('byteStride',comps*isz)
    if stride!=comps*isz:
        raw=np.frombuffer(B,np.uint8,a['count']*stride,off).reshape(a['count'],stride)
        return np.ascontiguousarray(raw[:,:comps*isz]).view(dt).reshape(a['count'],comps)
    return np.frombuffer(B,dt,a['count']*comps,off).reshape(a['count'],comps)

def compose(t,r,s):
    m=np.eye(4)
    x,y,z,w=r
    m[:3,:3]=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    m[:3,:3]=m[:3,:3]@np.diag(s)
    m[:3,3]=t
    return m
def static_trs(n):
    if 'matrix' in n: return np.array(n['matrix']).reshape(4,4).T
    t=np.array(n.get('translation',[0,0,0]),float)
    r=np.array(n.get('rotation',[0,0,0,1]),float)
    s=np.array(n.get('scale',[1,1,1]),float)
    return compose(t,r,s)

# deployed animated locals: last keyframe of each channel (gear down + bar hookup)
anim=G['animations'][0]
last={}   # node -> {path: value}
for ch in anim['channels']:
    tgt=ch['target']; ni=tgt['node']; path=tgt['path']
    smp=anim['samplers'][ch['sampler']]
    out=readA(smp['output'])
    last.setdefault(ni,{})[path]=out[-1]
def deployed_trs(i):
    n=nodes[i]
    if i in last:
        d=last[i]
        t=d['translation'] if 'translation' in d else np.array(n.get('translation',[0,0,0]),float)
        r=d['rotation'] if 'rotation' in d else np.array(n.get('rotation',[0,0,0,1]),float)
        s=d['scale'] if 'scale' in d else np.array(n.get('scale',[1,1,1]),float)
        return compose(np.array(t,float),np.array(r,float),np.array(s,float))
    return static_trs(n)

parent={}
for i,n in enumerate(nodes):
    for c in n.get('children',[]): parent[c]=i
def chain(i):
    c=[i]
    while c[-1] in parent: c.append(parent[c[-1]])
    return list(reversed(c))
def world_at(i, trs_fn):
    M=np.eye(4)
    for k in chain(i): M=M@trs_fn(k)
    return M

# static world matrices (authored pose) for the bbox
def build_static():
    W={}
    def walk(i,Pm):
        M=Pm@static_trs(nodes[i]); W[i]=M
        for c in nodes[i].get('children',[]): walk(c,M)
    for r in G['scenes'][G.get('scene',0)]['nodes']: walk(r,np.eye(4))
    return W
Wstatic=build_static()

# static bbox over ALL mesh vertices -> scale s + centre ctr (as normalise_model does)
allmin=np.array([1e18]*3); allmax=np.array([-1e18]*3)
for i,n in enumerate(nodes):
    if 'mesh' not in n or i not in Wstatic: continue   # setFromObject(scene) skips orphan nodes
    for p in G['meshes'][n['mesh']]['primitives']:
        v=readA(p['attributes']['POSITION']).astype(np.float64)
        w=(Wstatic[i][:3,:3]@v.T).T+Wstatic[i][:3,3]
        allmin=np.minimum(allmin,w.min(0)); allmax=np.maximum(allmax,w.max(0))
size=allmax-allmin; ctr=(allmax+allmin)/2
s=LENGTH/max(size.max(),1e-3)
print(f"static bbox size {size.round(3)}  ctr {ctr.round(3)}  scale {s:.5f}")

def to_ownship(world_pts):
    # scene: p = s*(v - ctr);  proto Ry(90): x'=p.z, z'=-p.x;  + (nose-wheel, 0, 0)
    p=(world_pts-ctr)*s
    th=YAW*D2R; ca,sa=np.cos(th),np.sin(th)
    x=p[:,2]*sa + p[:,0]*ca*0 + p[:,0]*0   # Ry(90): x' = x*cos + z*sin = z ; keep general:
    ox=p[:,0]*ca + p[:,2]*sa
    oy=p[:,1]
    oz=-p[:,0]*sa + p[:,2]*ca
    ox=ox+(NOSE-WHEEL)
    return np.stack([ox,oy,oz],1)

# deployed world for the launch bar subtree (node 280) + nose tire (258)
def subtree(i):
    out=[i]
    for c in nodes[i].get('children',[]): out+=subtree(c)
    return out
def deployed_world(i):
    # world = product of deployed locals along the chain, then this node's own deployed local
    return world_at(i, deployed_trs)

def tip_of(root, label):
    pts=[]
    for i in subtree(root):
        n=nodes[i]
        if 'mesh' not in n: continue
        Wm=deployed_world(i)
        for p in G['meshes'][n['mesh']]['primitives']:
            v=readA(p['attributes']['POSITION']).astype(np.float64)
            w=(Wm[:3,:3]@v.T).T+Wm[:3,3]
            pts.append(w)
    if not pts:
        print(f"  {label}: no mesh in subtree"); return None
    W=np.concatenate(pts)
    O=to_ownship(W)
    # forward-most (max ownship x) and lowest (min y)
    fwd_i=O[:,0].argmax(); low_i=O[:,1].argmin()
    print(f"  {label}: ownship-x range [{O[:,0].min():.2f},{O[:,0].max():.2f}]  y range [{O[:,1].min():.2f},{O[:,1].max():.2f}]")
    print(f"    forward-most vertex: x={O[fwd_i,0]:.2f} y={O[fwd_i,1]:.2f}")
    print(f"    lowest vertex:       x={O[low_i,0]:.2f} y={O[low_i,1]:.2f}")
    return O

print("nose tire (258) DEPLOYED:")
tire=tip_of(258,'nose tire')

# The bar swings through its keyframes; the last frame may be retracted. Sample the bar
# node's OWN rotation at every keyframe (gear chain held deployed) and find the pose whose
# tip reaches farthest forward+down — that IS the deck hookup, wherever it sits on the timeline.
BARNODE=280
bar_ch=None
for ch in anim['channels']:
    if ch['target']['node']==BARNODE and ch['target']['path']=='rotation':
        bar_ch=anim['samplers'][ch['sampler']]; break
def tip_at_bar_rot(rot):
    # override node 280 rotation with rot, gear chain deployed, everything else deployed
    def trs_fn(k):
        if k==BARNODE:
            n=nodes[k]
            t=np.array(n.get('translation',[0,0,0]),float); s=np.array(n.get('scale',[1,1,1]),float)
            return compose(t,np.array(rot,float),s)
        return deployed_trs(k)
    pts=[]
    for i in subtree(BARNODE):
        n=nodes[i]
        if 'mesh' not in n: continue
        Wm=world_at(i,trs_fn)
        for p in G['meshes'][n['mesh']]['primitives']:
            v=readA(p['attributes']['POSITION']).astype(np.float64)
            w=(Wm[:3,:3]@v.T).T+Wm[:3,3]
            pts.append(w)
    if not pts: return None
    return to_ownship(np.concatenate(pts))
def slerp(q0,q1,t):
    q0=np.array(q0,float); q1=np.array(q1,float)
    d=np.dot(q0,q1)
    if d<0: q1=-q1; d=-d
    if d>0.9995: r=q0+t*(q1-q0); return r/np.linalg.norm(r)
    th=np.arccos(d); s=np.sin(th)
    return (np.sin((1-t)*th)/s)*q0 + (np.sin(t*th)/s)*q1
def rot_at_time(smp_in, smp_out, tq):
    times=readA(smp_in).ravel(); outs=readA(smp_out)
    if tq<=times[0]: return outs[0]
    if tq>=times[-1]: return outs[-1]
    j=np.searchsorted(times,tq)-1
    f=(tq-times[j])/(times[j+1]-times[j])
    return slerp(outs[j],outs[j+1],f)
if bar_ch is not None:
    times=readA(bar_ch['input']).ravel()
    t0,t1=float(times.min()),float(times.max())
    # apply_anim scrubs the bar track to fraction 0.955 of [t0,t1] (line 2619)
    for frac in (0.955, 1.0):
        tq=t0+frac*(t1-t0)
        q=rot_at_time(bar_ch['input'],bar_ch['output'],tq)
        O=tip_at_bar_rot(q)
        low=O[O[:,1].argmin()]
        print(f"  bar fraction {frac} (t={tq:.2f}): tip ownship-x={low[0]:.2f} y={low[1]:.2f}  (x-range {O[:,0].min():.2f}..{O[:,0].max():.2f})")
    tq=t0+0.955*(t1-t0)
    q=rot_at_time(bar_ch['input'],bar_ch['output'],tq)
    O=tip_at_bar_rot(q); low=O[O[:,1].argmin()]
    print(f"\nNOSE GEAR ownship-x = {NOSE} (by construction)")
    print(f"BAR TIP (in-game 0.955) ownship-x = {low[0]:.2f}")
    print(f"=> shuttle should move FORWARD by {low[0]-NOSE:.2f} m from the nose-gear point")
