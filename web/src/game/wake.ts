// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The carrier's bow wave and wake, which the sea's shader draws from where the
// ship is and where she has been. Nothing here is a setting or a guess per
// ship: the shapes come from her waterline (the ship file's, so a new hull
// brings its own) and her speed through the water, and the sea's own state
// decides how long the wake lasts.
//
// - The bow wave: a collar of white about the stem, its crests peeling off the
//   hull on either side and flaring out aft, and a white line along the
//   waterline inside them that thins out within the first third of the hull.
//   They grow with the speed from a lip at steerage way, where the flight deck
//   overhanging the bow hides them from above, as it does on the real ship.
// - The sea against her: in a working sea its waves break white where they
//   meet the hull, at any speed, most where the hull faces into them (the bow,
//   when she heads into the wind). The white is thrown out off her and left
//   behind in the water as she steams on.
// - The wake: the screws' wash, about the hull's breadth and spreading slowly,
//   white at the stern, then pale green where the churned water rises, then a
//   long smooth band where it has flattened the ripples. It follows the path
//   the stern swept, so it bends through her turns. The screws churn the water
//   for some distance astern at any speed, so a slow ship's wash is fainter but
//   no shorter; at speed its foam and smooth band last as long as the sea lets
//   them. Its pattern is laid in the water, which she leaves behind.
// - The Kelvin waves: the V of ridges either side of the track, 19.47 degrees
//   off it, their wavelength 2 pi v^2 / g (150 m at 30 kt, 4 m at 5 kt, where
//   the chop hides them). They come from the hull's wave-making, which is
//   nothing at steerage way and grows with the Froude number.
//
// Every host flies the same track (the core's, or the recording's), so every
// player sees the same wake behind the same ship.

export const AGE = 720 // s: how far back the wake is drawn
export const STEP = 2 // s: how often where the ship has been is sampled
export const POINTS = 41 // points of the path the stern swept that the shader reads
export const GROUP = 8 // stretches of the path to a group: the shader skips a group whose reach a point lies past
export const GROUPS = (POINTS - 1) / GROUP
export const HULL = 21 // the shader's waterline: up to 42 stations, two to a vec4
export const REACH = 10 // hull lengths astern of the stem the Kelvin waves are drawn to
export const BAND = 2.6 // the wash's greatest half-width, in hull breadths at its age (see WAKE)
export const STREAK = 400 // m: the length the wash's streaks repeat over along the track
export const LANE = 1200 // m: the same for the long patches its white lies in from afar
export const WANDER = 3000 // m: the same for the wandering of its edges
export const LAID = 60000 // m: how far the stern's travel is counted before it starts again, whole repeats of all three, so it starts again unseen

// Pose is the ship at a moment: her reference point, heading (radians, as the
// flight core counts them: forward is (cos, -sin)) and speed through the water.
// A speed that is not finite is read off where she went.
export interface Pose {
  x: number
  z: number
  heading: number
  speed: number
}

// reading is the ship as the flight core's carrier export answers for a time,
// [x, z, heading, closed, way, known]: her reference point and heading, the
// deck closed (turning, or steaming away from the wind), her speed through the
// water and the earliest time her track covers. A core that predates the
// speed reports none (NaN) and its track as covering every time. Null for
// anything else: no core yet, or one without a ship.
export function reading(
  pose: unknown
): (Pose & { closed: boolean; known: number }) | null {
  if (
    !Array.isArray(pose) ||
    pose.length < 4 ||
    !pose.slice(0, 4).every(Number.isFinite)
  )
    return null
  const speed = pose.length > 4 && Number.isFinite(pose[4]) ? pose[4] : NaN
  const known = pose.length > 5 && !Number.isNaN(pose[5]) ? pose[5] : -Infinity
  return {
    x: pose[0],
    z: pose[1],
    heading: pose[2],
    closed: pose[3] > 0,
    speed,
    known,
  }
}

// Waterline is the ship file's: the waterline's ends in x and its port and
// starboard z at stations evenly spaced from the stern to the stem, in the
// deck frame (x forward, z to starboard).
export interface Waterline {
  stern: number
  stem: number
  sides: number[][]
}

// point is a place in the ship's own frame (fore-aft, to starboard) in the world.
export function point(pose: Pose, fore: number, lateral: number) {
  const c = Math.cos(pose.heading)
  const s = Math.sin(pose.heading)
  return {
    x: pose.x + fore * c + lateral * s,
    z: pose.z - fore * s + lateral * c,
  }
}

// before is where a ship steaming steadily on was seconds earlier: the pose a
// host takes for her before the earliest time her track covers.
export function before(pose: Pose, seconds: number): Pose {
  const back = pose.speed * seconds
  return {
    x: pose.x - Math.cos(pose.heading) * back,
    z: pose.z + Math.sin(pose.heading) * back,
    heading: pose.heading,
    speed: pose.speed,
  }
}

function angle(value: number) {
  return value - 2 * Math.PI * Math.round(value / (2 * Math.PI))
}

// blend is the pose the fraction f of the way from a to b.
function blend(a: Pose, b: Pose, f: number): Pose {
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    heading: a.heading + angle(b.heading - a.heading) * f,
    speed: a.speed + (b.speed - a.speed) * f,
  }
}

// hull is the waterline as the shader reads it: [stern, stem, station
// spacing, stations], the stations two to a vec4, and the greatest breadth.
export function hull(waterline: Waterline) {
  const sides = waterline.sides.slice(0, HULL * 2)
  const count = sides.length
  const stations = new Float32Array(HULL * 4)
  sides.forEach((side, i) => {
    stations[i * 2] = side[0]
    stations[i * 2 + 1] = side[1]
  })
  return {
    span: [
      waterline.stern,
      waterline.stem,
      (waterline.stem - waterline.stern) / Math.max(count - 1, 1),
      count,
    ],
    stations,
    beam: Math.max(...sides.map((side) => side[1] - side[0])),
  }
}

// Wake keeps where the ship has been, sampled every STEP seconds of the clock
// that poses her, and hands the shader the path her stern swept.
export class Wake {
  times: number[] = []
  poses: Pose[] = []
  // How far her stern has gone, counted from where the wake began (wrapped at
  // LAID), and where it was when last counted. A point of the wake the run
  // back from the stern reaches lies this less the run along her stern's way:
  // a place in the water, which the wash's pattern is laid by.
  travelled = 0
  mark: { x: number; z: number; time: number } | null = null

  // follow brings the history up to time from pose_at, the ship at any time
  // (null where there is none). A clock that went back - a new flight, a
  // replay sought back - or leapt past the whole wake starts it over, filled
  // from pose_at as far back as it is drawn.
  follow(time: number, pose_at: (time: number) => Pose | null) {
    const last = this.times.length ? this.times[this.times.length - 1] : NaN
    if (!(time >= last) || time - last > AGE) {
      this.times = []
      this.poses = []
    }
    const from = this.times.length
      ? this.times[this.times.length - 1] + STEP
      : Math.ceil((time - AGE - STEP) / STEP) * STEP
    for (let t = from; t <= time + 1e-9; t += STEP) {
      const pose = pose_at(t)
      if (!pose || ![pose.x, pose.z, pose.heading].every(Number.isFinite))
        continue
      this.times.push(t)
      this.poses.push({ ...pose })
    }
    // Speeds a source does not give are read off the step to the next sample.
    for (let i = 0; i < this.poses.length; i++) {
      if (Number.isFinite(this.poses[i].speed)) continue
      const j = i + 1 < this.poses.length ? i + 1 : i - 1
      if (j < 0) {
        this.poses[i].speed = 0
        continue
      }
      const a = this.poses[Math.min(i, j)]
      const b = this.poses[Math.max(i, j)]
      this.poses[i].speed =
        Math.hypot(b.x - a.x, b.z - a.z) /
        Math.max(this.times[Math.max(i, j)] - this.times[Math.min(i, j)], 1e-6)
    }
    let drop = 0
    while (drop + 1 < this.times.length && this.times[drop + 1] < time - AGE)
      drop++
    if (drop) {
      this.times.splice(0, drop)
      this.poses.splice(0, drop)
    }
  }

  // at is the ship at a time inside the history, between its samples; null
  // before its first.
  at(time: number): Pose | null {
    const n = this.times.length
    if (!n || time < this.times[0] - 1e-9) return null
    let i = n - 1
    while (i > 0 && this.times[i] > time) i--
    const a = this.poses[i]
    if (i === n - 1 || time <= this.times[i]) return { ...a }
    return blend(
      a,
      this.poses[i + 1],
      (time - this.times[i]) / (this.times[i + 1] - this.times[i])
    )
  }

  // path writes the shader's uniforms: points (POINTS of [x, z, run, age]:
  // where her stern was, relative to her reference point now, the distance
  // along the path to it, and
  // how long ago, from now back AGE, closer together near the ship where the
  // wake is busiest), speeds (her speed at each, four to a vec4) and groups
  // (GROUPS of [x, z, radius, reach]: a circle about each run of GROUP
  // stretches, and how far off it anything they draw reaches - the wash, and
  // the Kelvin waves out to REACH hull lengths; a negative radius is a group
  // past the path's end). Returns how many points it wrote, a circle holding
  // everything drawn, the bow wave included, the Kelvin waves' reach, her
  // speed now and how far her stern has travelled.
  path(
    time: number,
    now: Pose,
    waterline: Waterline,
    points: Float32Array,
    speeds: Float32Array,
    groups: Float32Array
  ) {
    const length = waterline.stem - waterline.stern
    const first = waterline.sides[0]
    const lateral = first ? (first[0] + first[1]) / 2 : 0
    const beam = Math.max(...waterline.sides.map((side) => side[1] - side[0]))
    let speed = now.speed
    if (!Number.isFinite(speed))
      speed = this.poses.length ? this.poses[this.poses.length - 1].speed : 0
    const current = { ...now, speed }
    // Her stern's travel since last counted; counting starts over with the wake.
    const stern = point(current, waterline.stern, lateral)
    const mark = this.mark
    if (mark && time >= mark.time && time - mark.time <= AGE)
      this.travelled =
        (this.travelled + Math.hypot(stern.x - mark.x, stern.z - mark.z)) % LAID
    else this.travelled = 0
    this.mark = { x: stern.x, z: stern.z, time }
    // Since the newest sample she has moved on to now: a time between them lies between the two.
    const newest = this.times.length
      ? this.times[this.times.length - 1]
      : -Infinity
    const when = (t: number) => {
      if (t < newest) return this.at(t)
      const sample = this.poses[this.poses.length - 1]
      return sample && time > newest
        ? blend(sample, current, (t - newest) / (time - newest))
        : current
    }
    let count = 0
    let run = 0
    const xs: number[] = []
    const zs: number[] = []
    for (let i = 0; i < POINTS; i++) {
      const age = AGE * (i / (POINTS - 1)) ** 2
      const pose = i === 0 ? current : when(time - age)
      if (!pose) break
      const stern = point(pose, waterline.stern, lateral)
      const x = stern.x - now.x
      const z = stern.z - now.z
      if (count) run += Math.hypot(x - xs[count - 1], z - zs[count - 1])
      points.set([x, z, run, age], count * 4)
      speeds[count] = Math.max(pose.speed, 0)
      xs.push(x)
      zs.push(z)
      count++
    }
    points.fill(0, count * 4)
    speeds.fill(0, count)
    const reach = REACH * length
    const kelvin = (along: number) => 0.3536 * Math.min(along + length, reach)
    const band = BAND * beam * (0.8 + 0.45 * Math.sqrt(AGE / 60)) * 1.6
    let low = [-length - 60, -length - 60]
    let high = [length + 60, length + 60]
    for (let k = 0; k < GROUPS; k++) {
      const from = k * GROUP
      const to = Math.min(from + GROUP, count - 1)
      if (to <= from) {
        groups.set([0, 0, -1, 0], k * 4)
        continue
      }
      let gl = [Infinity, Infinity]
      let gh = [-Infinity, -Infinity]
      for (let i = from; i <= to; i++) {
        gl = [Math.min(gl[0], xs[i]), Math.min(gl[1], zs[i])]
        gh = [Math.max(gh[0], xs[i]), Math.max(gh[1], zs[i])]
      }
      const centre = [(gl[0] + gh[0]) / 2, (gl[1] + gh[1]) / 2]
      const radius = Math.hypot(gh[0] - gl[0], gh[1] - gl[1]) / 2
      const far = Math.max(kelvin(points[to * 4 + 2]), band)
      groups.set([centre[0], centre[1], radius, far], k * 4)
      low = [
        Math.min(low[0], centre[0] - radius - far),
        Math.min(low[1], centre[1] - radius - far),
      ]
      high = [
        Math.max(high[0], centre[0] + radius + far),
        Math.max(high[1], centre[1] + radius + far),
      ]
    }
    const centre = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2]
    const radius = Math.hypot(high[0] - low[0], high[1] - low[1]) / 2
    return { count, centre, radius, reach, speed, travelled: this.travelled }
  }
}

// WAKE is the sea's fragment shader's share: its uniforms, and wake_at, which
// reads what the ship does to the sea at a point (relative to u_wake_origin,
// the ship's reference point) for a pixel px metres across - the foam, the
// churned water's pale green, how far the ripples are smoothed (slick), and
// the Kelvin waves' slope, as the sea's lean (the minus gradient of height).
// It reads the sea's own clock, chart and wind (u_time, u_chart and SEA_TURN's
// u_downwind and sea_drift), so it follows SEA_TURN in the sea's shader.
export const WAKE = `uniform vec4 u_wake[${POINTS}]; uniform vec4 u_wake_speed[${Math.ceil(POINTS / 4)}]; uniform vec4 u_wake_group[${GROUPS}]; uniform float u_wake_count; uniform vec2 u_wake_origin; uniform vec4 u_wake_bounds;
	uniform vec4 u_ship; uniform vec4 u_hull_span; uniform vec4 u_hull[${HULL}]; uniform float u_hull_beam,u_wake_sea,u_wake_travelled;
	float wake_speed(int i){ vec4 v=u_wake_speed[i/4]; int j=i-(i/4)*4; return j==0?v.x:j==1?v.y:j==2?v.z:v.w; }
	vec2 hull_station(int j){ vec4 h=u_hull[j/2]; return j-(j/2)*2==0?h.xy:h.zw; }
	bool hull_at(float fore, out vec2 sides){   // the hull's port and starboard z at a fore-aft station, false off its ends
		float f=(fore-u_hull_span.x)/u_hull_span.z; if(f<0.0||f>u_hull_span.w-1.0) return false;
		float i=min(floor(f),u_hull_span.w-2.0); sides=mix(hull_station(int(i)),hull_station(int(i)+1),f-i); return true; }
	float hull_off(float fore, float across, float middle, out vec2 facing){   // how far a point of her frame lies off her waterline, and which way the hull faces there: ahead of the stem, from the stem, facing forward; astern of the transom, nowhere
		vec2 sides, aft; float back=u_hull_span.y-fore; facing=vec2(1.0,0.0);
		if(!hull_at(fore,sides)) return back>0.0?1.0e3:length(vec2(back,across-middle));
		float board=across>0.5*(sides.x+sides.y)?1.0:-1.0; facing=vec2(0.0,board);   // the side, by the transom
		if(hull_at(fore-4.0,aft)) facing=normalize(board>0.0?vec2(aft.y-sides.y,4.0):vec2(sides.x-aft.x,-4.0));   // the side's outward normal
		return board>0.0?across-sides.y:sides.x-across; }
	void wake_at(vec2 p, float px, out float foam, out float air, out float slick, out vec2 lean){
		foam=0.0; air=0.0; slick=0.0; lean=vec2(0.0);
		if(u_wake_count<1.0||length(p-u_wake_bounds.xy)>u_wake_bounds.z) return;
		float waterline=u_hull_span.y-u_hull_span.x, sea=u_wake_sea; vec2 world=p+u_wake_origin+u_chart;   // the foam's pattern is read where it lies on the sea's chart, which she moves through
		// The bow wave and the sea against her, in the ship's own frame.
		vec2 rel=p-u_ship.xy; float c=cos(u_ship.z), s=sin(u_ship.z), v=u_ship.w;
		float fore=rel.x*c-rel.y*s, across=rel.x*s+rel.y*c, push=clamp(0.45*smoothstep(0.3,2.5,v)+v*v/120.0,0.0,1.0), breaking=smoothstep(5.0,15.0,sea);
		if((push>0.0||breaking>0.0)&&fore>u_hull_span.x-4.0&&fore<u_hull_span.y+50.0&&abs(across)<90.0){
			vec2 stem=hull_station(int(u_hull_span.w)-1); float middle=0.5*(stem.x+stem.y), back=u_hull_span.y-fore;
			vec2 facing; float outside=hull_off(fore,across,middle,facing);
			// The bow wave: the water heaped against the stem, a collar of white about it, and its crests peeling off the
			// hull from the stem on either side and flaring out aft, wider, whiter and further the faster she goes, until
			// they run on unbroken as the Kelvin waves; along the waterline inside them a white line thins out aft.
			float wide=1.0+0.02*v*v, broken=10.0+0.3*v*v, cap=0.0, line=0.0, crest=0.0;
			if(back<0.0) cap=1.0-smoothstep(0.3*wide,wide,length(vec2(1.5*back,across-middle)));
			else if(back<waterline){
				float band=(0.6+0.035*v*v)*exp(-back/(0.08*waterline))+0.4+0.8*push;
				float strength=(0.3+0.7*exp(-back/(0.12*waterline)))*(1.0-smoothstep(0.25*waterline,0.5*waterline,back));
				line=strength*(1.0-smoothstep(0.35*band,band,outside))*step(-0.5,outside);
				float course=back*(0.14+0.33*smoothstep(2.0,12.0,v));   // how far off the hull the crest has flared: ~8 degrees at steerage way, ~25 at speed
				crest=(1.0-smoothstep(0.1*wide,wide,abs(outside-course)))*(1.0-smoothstep(0.1*broken,broken,back))*step(-0.5,outside);
				crest*=mix(1.0,smoothstep(0.4,0.6,texture2D(u_detail,world/31.0).b),min(1.5*back/broken,1.0)); }   // solid at the stem, breaking up into patches aft
			foam=push*max(max(cap,line),crest)*(0.55+0.6*texture2D(u_detail,world/23.0).b);
			if(breaking>0.0&&outside<45.0){   // what is thrown off her never reaches further
				// The sea's crests run downwind at about 0.8 of the wind's speed, a wavelength of 2 pi c^2 / g apart, their
				// lines wandering. Each breaks white against the hull as it meets her, more where the hull faces into it,
				// some crests and stretches of them harder than others, the white thrown out off her as it falls back and
				// gone before the next crest strikes. It is laid in the water where she was when the crest met it, and left
				// behind as she steams on.
				float pace=0.8*sea, wavelength=6.2831853*pace*pace/9.81, period=wavelength/pace;
				vec2 up=-vec2(u_downwind.x*c-u_downwind.y*s,u_downwind.x*s+u_downwind.y*c);   // whence the sea comes, in her frame
				float phase=-dot(world,u_downwind)/wavelength+u_time*sea_drift(vec2(pace/wavelength,0.0)).x+texture2D(u_detail,world/170.0).b-0.5;
				float since=fract(phase)*period;   // how long ago a crest passed this water
				float then=fore+v*since; vec2 faced; float off=hull_off(then,across,middle,faced);   // where it lay off her then
				float forward=exp(-max(u_hull_span.y-then,0.0)/(0.1*waterline));   // the bow, whose flare meets a sea from ahead however fine her waterline is there
				float exposed=max(sqrt(max(dot(faced,up),0.0)),forward*max(up.x,0.0)), spread=1.5+4.0*breaking*exposed*since;
				float hard=smoothstep(0.35,0.65,texture2D(u_detail,vec2(floor(phase)*0.137,dot(world,vec2(-u_downwind.y,u_downwind.x))/120.0)).b);
				float burst=min(2.0*breaking*(0.15+0.85*exposed)*(0.6+0.4*hard)*exp(-since/(1.0+exposed))*smoothstep(0.0,0.6,since),1.0);
				foam=max(foam,burst*(1.0-smoothstep(0.5*spread,spread,off))*step(-0.5,off)*(0.6+0.8*texture2D(u_detail,world/11.0).b)); } }
		if(u_wake_count<2.0) return;
		// The stretch of the path the stern swept nearest the point, skipping each group of stretches whose reach the
		// point lies past. Ahead of the stern the first stretch runs on unclamped, so the hull's own length is
		// measured along it. A point nearer a skipped group than to anything found lies past everything's reach.
		float best=1.0e20, skipped=1.0e20, f=0.0; int nearest=-1;
		for(int k=0;k<${GROUPS};k++){
			vec4 group=u_wake_group[k]; if(group.z<0.0) break;
			float gap=length(p-group.xy)-group.z;
			if(gap>group.w){ skipped=min(skipped,gap); continue; }
			for(int j=0;j<${GROUP};j++){
				int i=k*${GROUP}+j; if(float(i)+1.0>=u_wake_count) break;
				vec2 a=u_wake[i].xy, e=u_wake[i+1].xy-a; float l2=dot(e,e); if(l2<1.0e-4) continue;   // a ship standing still sweeps no path
				float g=dot(p-a,e)/l2; g=i==0?min(g,1.0):clamp(g,0.0,1.0);
				vec2 d=p-a-e*g; float d2=dot(d,d);
				if(d2<best){ best=d2; nearest=i; f=g; } } }
		if(nearest<0||skipped*skipped<best) return;
		// How far astern along the path, how far to one side, how old the water there is and how fast the ship was going
		// when she churned it.
		vec4 a=u_wake[nearest], b=u_wake[nearest+1]; vec2 e=b.xy-a.xy; float l=length(e); vec2 dir=e/l, d=p-a.xy-e*f;
		float along=a.z+f*l, side=dir.x*d.y-dir.y*d.x, y=abs(side), w=clamp(f,0.0,1.0), age=mix(a.w,b.w,w);
		float speed=mix(wake_speed(nearest),wake_speed(nearest+1),w);
		float oldest=u_wake[int(u_wake_count)-1].w, fade=1.0-smoothstep(0.7*oldest,oldest,age);
		// The screws' wash: about the hull's breadth, spreading slowly, its foam and its pale green going with the
		// power the screws turn. The sea undoes it: its foam goes in seconds and its smooth band in minutes in a calm,
		// far sooner in a working sea. The screws go on churning the water for some way astern, so at steerage way,
		// where that takes minutes, the wash lasts as far as that and no further. It lies in streaks along the track
		// with edges that wander along it, so it is read in the path's own frame, at the place in the water the run
		// back from the stern reaches: the pattern stays where it was laid. Its greatest half-width is ${BAND}
		// breadths at its age; past that nothing is read.
		float spread=u_hull_beam*(0.8+0.45*sqrt(age/60.0)), behind=smoothstep(-6.0,6.0,along), core=0.0;
		if(y<${BAND}*spread&&behind>0.0){
			float water=u_wake_travelled-along, churn=clamp(0.35*smoothstep(0.3,2.5,speed)+speed*speed/150.0,0.0,1.0), slow=max(speed,0.3);
			float white=max(35.0/(1.0+sea/20.0),100.0/slow), green=max(70.0/(1.0+sea/20.0),300.0/slow), calm=max(1200.0/(1.0+sea*sea/25.0),600.0/slow);
			float streak=textureGrad(u_detail,vec2(water/${STREAK}.0,side/30.0),vec2(px/${STREAK}.0,0.0),vec2(0.0,px/30.0)).b;   // streaks along the track a few metres across
			float lanes=textureGrad(u_detail,vec2(water/${LANE}.0,side/90.0),vec2(px/${LANE}.0,0.0),vec2(0.0,px/90.0)).b;   // and lanes of them, ten across the wash
			float wander=textureGrad(u_detail,vec2(water/${WANDER}.0,0.31),vec2(px/${WANDER}.0,0.0),vec2(0.0,px/${WANDER}.0)).b;   // the texture's ripples run 6-24 to its tile: a 3 km tile wanders the edges every few hundred metres
			float width=spread*(0.7+0.6*wander)*(1.0+0.35*(texture2D(u_detail,world/53.0).b-0.5)+0.8*(texture2D(u_detail,world/260.0).b-0.5));   // its edges lumpy with eddies about a breadth across
			core=(1.0-smoothstep(0.3*width,0.5*width,y))*behind; float wide=(1.0-smoothstep(0.45*width,0.7*width,y))*behind;
			// Fresh, the wash is white throughout, thinning to boils at steerage way. Its white lies in patches fixed in the
			// water, which thin and go out one by one as it ages: a patch is white while its noise (spread to 0-1 about its
			// middle) stands above what the freshness has fallen to. They are read at the finest scale the pixel resolves:
			// lumps a few metres across close to, patches tens of metres across and streaked along the track from afar.
			// Only beyond that is the white the share of the water they would cover. The white is the screws' race,
			// narrower than the churned water and ragged at its edges. Its pale green wells up in boils.
			float fresh=clamp(1.6*sqrt(churn)*exp(-age/white),0.0,1.0);
			float fine=clamp(0.5+2.5*(0.65*streak+0.35*texture2D(u_detail,world/45.0).b-0.5),0.0,1.0);
			float coarse=clamp(0.5+4.0*(0.5*lanes+0.5*texture2D(u_detail,world/240.0).b-0.5),0.0,1.0);
			float lumps=mix(fine,coarse,smoothstep(0.5,3.0,px));
			float cover=mix(smoothstep(1.0-fresh,1.25-fresh,lumps),smoothstep(0.15,0.85,fresh),smoothstep(8.0,24.0,px));
			float race=(1.0-smoothstep(0.15*width,0.45*width,y*(0.8+0.4*lanes)))*behind;
			float boils=smoothstep(0.3,0.7,texture2D(u_detail,world/150.0).b);
			foam=max(foam,cover*min(1.0,2.0*churn)*race*fade);
			air=sqrt(churn)*exp(-age/green)*core*fade*(0.4+0.3*streak+0.5*boils);
			slick=clamp(0.35*smoothstep(0.3,2.5,speed)+speed/12.0,0.0,1.0)*exp(-age/calm)*wide*fade; }
		// The Kelvin waves, x astern of the stem and y off the track: two systems meet each point inside the
		// 19.47 degree wedge, the transverse and the divergent, each the wave whose phase is stationary there. A
		// wave running at theta to the track keeps pace with the ship at k = k0 / cos^2(theta); for a point off to
		// one side the stationary one leans the other way, tan(theta) = -t, so its phase is k0 (x - y t) q and it
		// slopes along (1, -t) / q.
		float x=along+waterline, steep=0.08*smoothstep(0.06,0.30,speed/sqrt(9.81*waterline));
		if(steep>0.0&&x>0.0&&x<u_wake_bounds.w&&y<0.3536*x){
			float k0=9.81/max(speed*speed,0.25), r=y/x, disc=sqrt(max(1.0-8.0*r*r,0.0));
			float decay=sqrt(waterline/max(x,0.5*waterline))*(1.0-smoothstep(0.6*u_wake_bounds.w,u_wake_bounds.w,x))*(1.0-0.85*core)*fade;
			vec2 off=vec2(-dir.y,dir.x)*(side<0.0?-1.0:1.0);
			float t=2.0*r/(1.0+disc), q=sqrt(1.0+t*t), phase=k0*(x-y*t)*q;
			lean+=0.35*steep*decay*(1.0-smoothstep(0.5,1.5,k0*q*q*px))*sin(phase)*(dir-off*t)/q;
			t=(1.0+disc)/(4.0*max(r,1.0e-4)); q=sqrt(1.0+t*t); phase=k0*(x-y*t)*q;
			lean+=steep*decay*(1.0-smoothstep(0.5,1.5,k0*q*q*px))*sin(phase)*(dir-off*t)/q; } }`
