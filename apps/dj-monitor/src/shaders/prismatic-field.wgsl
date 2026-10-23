// Shared glass architecture. The three sources illuminate the same continuous surface.
struct Scene {
  resolution: vec2f,
  time: f32,
  aspect: f32,
  audio0: vec4f,
  audio1: vec4f,
  audio2: vec4f,
  motion0: vec4f,
  motion1: vec4f,
  motion2: vec4f,
  booth: vec4f,
  drive: vec4f,
}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var waveforms: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

fn rotate(a: f32) -> mat2x2f {
  return mat2x2f(cos(a), sin(a), -sin(a), cos(a));
}
fn levels() -> vec3f {
  return clamp(sqrt(max(vec3f(scene.audio0.x,scene.audio1.x,scene.audio2.x),vec3f(0.0))) * 1.8,vec3f(0.0),vec3f(1.0));
}
fn pulses() -> vec3f {
  return pow(0.5 + 0.5 * cos(vec3f(scene.motion0.w,scene.motion1.w,scene.motion2.w) * 6.283185),vec3f(8.0)) * levels();
}
fn local_point(p: vec3f) -> vec4f {
  // Translate toward the eye, then rotate a 3D slice through a fourth coordinate.
  // Rotating x/w and y/w makes openings divide and reconnect continuously.
  let z = p.z - scene.drive.x;
  let xy = rotate(z * 0.10 + sin(scene.drive.w) * 0.65) * p.xy;
  let xw = rotate(scene.drive.w * 0.42) * vec2f(xy.x,0.6*sin(z*0.21));
  let yw = rotate(sin(scene.drive.w * 0.67) * 0.8) * vec2f(xy.y,xw.y);
  return vec4f(xw.x,yw.x,z,yw.y);
}
fn distance_field(p: vec3f) -> f32 {
  var q = local_point(p);
  let level = levels();
  let beat = pulses();
  let bass = dot(vec3f(scene.audio0.y,scene.audio1.y,scene.audio2.y),level);
  let mids = dot(vec3f(scene.audio0.z,scene.audio1.z,scene.audio2.z),level);
  let controls = vec3f(scene.motion0.x,scene.motion1.x,scene.motion2.x);
  let warp = dot(controls,level) * 0.14;
  // Independent waveform histories deform different coordinates. A deck can
  // change its own gesture without borrowing another deck's amplitude or phase.
  let wave0 = textureSampleLevel(waveforms,linear_sampler,vec2f(fract(q.z*0.065+q.y*0.04),1.0/6.0),0.0).a * level.x;
  let wave1 = textureSampleLevel(waveforms,linear_sampler,vec2f(fract(q.z*0.09+q.x*0.05),0.5),0.0).a * level.y;
  let wave2 = textureSampleLevel(waveforms,linear_sampler,vec2f(fract(q.z*0.05+length(q.xy)*0.08),5.0/6.0),0.0).a * level.z;
  // CDJ 1: expanding ribs. CDJ 2: twisting folds. CDJ 3: a rippling lattice.
  let ribs = q.xy * (1.0 + wave0*0.28 + beat.x*0.06);
  let folded = rotate(wave1*sin(q.z*0.8+scene.motion1.w*0.35)*0.55) * ribs;
  q = vec4f(folded,q.zw);
  q.z += sin(q.x*3.0+q.y*2.0-scene.motion2.w*0.4)*wave2*0.38;
  q.x += sin(q.y * 0.6 + scene.time * 0.24) * (0.42 + warp);
  q.y += sin(q.x * 0.7 - scene.time * 0.19) * 0.32;
  q.z += sin(q.x * 1.2 + q.y * 0.6 + scene.time * 0.11) * mids * 0.16;
  let frequency = 1.38;
  let v = q * frequency;
  let gyroid = sin(v.x)*cos(v.y) + sin(v.y)*cos(v.z)
    + sin(v.z)*cos(v.x+v.w) + sin(v.w)*0.4;
  let thickness = 0.12 + bass * 0.065 + dot(beat,vec3f(0.055));
  let shell = (abs(gyroid) - thickness) / (frequency * 2.4);
  // An open, bending passage gives a near/middle/far hierarchy and continuous parallax.
  let path = vec2f(sin(p.z*0.24+scene.time*0.16),cos(p.z*0.19-scene.time*0.13)) * 0.52;
  let breathing = 1.05 + sin(p.z*0.5-scene.time*0.23)*0.18;
  let clearing = (breathing-length((p.xy-path)*vec2f(0.82,1.0))) * 0.65;
  return max(shell,clearing);
}
fn surface_normal(p: vec3f) -> vec3f {
  let e = vec2f(0.002,-0.002);
  return normalize(e.xyy * distance_field(p + e.xyy) + e.yyx * distance_field(p + e.yyx)
    + e.yxy * distance_field(p + e.yxy) + e.xxx * distance_field(p + e.xxx));
}
fn source_color(row: f32, u: f32) -> vec3f {
  let rgb = textureSampleLevel(waveforms,linear_sampler,vec2f(clamp(u,0.0,1.0),(row+0.5)/3.0),0.0).rgb;
  return rgb / max(0.02,max(rgb.r,max(rgb.g,rgb.b)));
}
fn lighting(ray: vec3f, point: vec3f) -> vec3f {
  let level = levels();
  let beat = pulses();
  let travel = fract(dot(point,vec3f(0.11,0.09,0.045)) - scene.drive.x * 0.035);
  let c0 = source_color(0.0,travel);
  let c1 = source_color(1.0,travel);
  let c2 = source_color(2.0,travel);
  let keys = vec3f(
    pow(max(0.0,dot(ray,normalize(vec3f(-0.8,0.45,0.6)))),10.0),
    pow(max(0.0,dot(ray,normalize(vec3f(0.8,0.5,0.25)))),12.0),
    pow(max(0.0,dot(ray,normalize(vec3f(-0.1,-0.9,0.7)))),9.0));
  let strength = level * (2.8 + beat * 3.4);
  var color = c0 * keys.x * strength.x + c1 * keys.y * strength.y + c2 * keys.z * strength.z;
  // Long white softboxes supply readable black/chrome structure between colored highlights.
  let strip = pow(max(0.0,1.0-abs(ray.y * 0.82 + ray.x * 0.42 - 0.28)),48.0);
  let edge = pow(max(0.0,1.0-abs(ray.x * 0.38 - ray.z * 0.75 + 0.34)),80.0);
  color += vec3f(1.0) * (strip * 3.4 + edge * 2.0) * (0.20 + dot(level,vec3f(0.32)));
  return color;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let screen = rotate(sin(scene.drive.w*0.4)*0.20) * ((uv * 2.0 - 1.0) * vec2f(scene.aspect,-1.0));
  let origin = vec3f(0.0,0.0,7.8);
  let look = vec2f(sin(scene.drive.w*0.8),cos(scene.drive.w*0.61))*0.12;
  let direction = normalize(vec3f(screen * (0.56+scene.drive.z*0.025)+look,-1.0));
  var travel = 0.25;
  var hit = false;
  var point = origin;
  for (var i = 0; i < 96; i += 1) {
    point = origin + direction * travel;
    let d = distance_field(point);
    if (d < 0.0035) { hit = true; break; }
    travel += max(0.003,d * 0.85);
    if (travel > 28.0) { break; }
  }
  var color = vec3f(0.0);
  var alpha = 1.0;
  let in_booth = all(uv > scene.booth.xy) && all(uv < scene.booth.zw);
  if (hit) {
    let normal = surface_normal(point);
    let facing = clamp(dot(normal,-direction),0.0,1.0);
    let fresnel = 0.08 + 0.92 * pow(1.0-facing,4.0);
    let reflection = lighting(reflect(direction,normal),point);
    // Thin-shell transmission: no expensive internal multi-bounce raymarch.
    let transmitted = lighting(refract(direction,normal,0.66),point + normal * 0.2);
    let ambient = 0.002 + 0.008 * max(0.0,dot(normal,normalize(vec3f(-0.4,0.7,1.0))));
    let ao = clamp(distance_field(point + normal * 0.22) / 0.22,0.25,1.0);
    color = (reflection * (0.40 + fresnel * 0.95) + transmitted * 0.08 + vec3f(ambient)) * ao;
    // Engraved fine waveform contours. All three histories travel through the material.
    let q = local_point(point);
    let lane_level = levels();
    let phase = q.y * 3.1 + q.x * 1.6 + q.z * 0.7 + q.w * 0.5;
    for (var i = 0; i < 3; i += 1) {
      let lane = f32(i);
      let motion = array<vec4f,3>(scene.motion0,scene.motion1,scene.motion2)[i];
      let audio = array<vec4f,3>(scene.audio0,scene.audio1,scene.audio2)[i];
      var gesture = q.y * 3.0 + q.z * 0.75;
      if (i == 1) { gesture = atan2(q.y,q.x) * 2.0 + q.z * 1.4; }
      if (i == 2) { gesture = max(abs(q.x),abs(q.y)) * 4.0 - q.z * 0.8; }
      let u = fract(gesture * 0.12 + lane * 0.17);
      let signal = textureSampleLevel(waveforms,linear_sampler,vec2f(u,(lane+0.5)/3.0),0.0);
      let line = pow(0.5+0.5*cos((gesture+signal.a*0.8)*18.0),24.0);
      // Each beat launches a separate bright front through depth toward the viewer.
      let passing = pow(0.5+0.5*cos(motion.w*6.283185-gesture*1.7),10.0);
      let hue = signal.rgb / max(0.02,max(signal.r,max(signal.g,signal.b)));
      color += hue * line * lane_level[i] * (0.025 + audio.w * 0.35 + passing * 2.4) * (0.35+fresnel);
      color += hue * passing * lane_level[i] * (0.12 + fresnel*0.6);
      color += hue * motion.y * lane_level[i] * pow(0.5+0.5*sin(phase*(3.0+motion.z*0.2)-scene.time),12.0) * 0.5;
    }
    // Distance fades only the far layers; the nearest folds pass the edges at full contrast.
    color *= exp(-max(0.0,travel-2.0)*0.075);
  }
  if (in_booth) {
    // Most of the hardware is protected. Only truly foreground surfaces cross its perimeter.
    let local = (uv-scene.booth.xy)/(scene.booth.zw-scene.booth.xy);
    let rim = max(abs(local.x-0.5)*2.0,abs(local.y-0.5)*2.0);
    alpha = select(0.0,smoothstep(0.90,1.0,rim)*0.8,hit && point.z > 0.8);
  }
  return vec4f(color,alpha);
}
