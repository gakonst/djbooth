// Ported from apps/dj-monitor/src/BoothVisuals.tsx: the booth's built-in line visual,
// with etched spectral ribbons, pumpkin meridians and cobweb portals.
import type { MusicLane, SceneEngine } from "../scenes.js";
import { createWaveformPulse } from "../music/waveform-pulse.js";

const vertex = `
attribute vec3 seed;
uniform float time,aspect,pixelRatio,activity,dance,palette;
uniform vec4 energy[3],motion[3];
uniform vec2 origins[3];
uniform sampler2D waveforms;
varying vec3 ink;
varying float opacity;
vec3 orbit(float t,float shape){
 vec3 knot=vec3(sin(t)+.32*sin(3.*t),.65*sin(2.*t),.4*cos(3.*t));
 vec3 loop=vec3(cos(t)*(1.+.2*cos(3.*t)),sin(t)*.75,.42*sin(2.*t));
 vec3 vine=vec3(cos(t)*(1.+.12*cos(t*7.)),sin(t)*.8,.3*sin(t*3.));
 return mix(mix(knot,loop,shape),vine,.45);
}
void main(){
 int lane=int(seed.z); vec4 e=energy[0];vec4 m=motion[0];vec2 origin=origins[0];vec3 color=vec3(.12,.86,1.);
 if(lane==1){e=energy[1];m=motion[1];origin=origins[1];color=vec3(1.,.2,.55);}
 if(lane==2){e=energy[2];m=motion[2];origin=origins[2];color=vec3(1.,.65,.12);}
 float u=seed.x;
 float family=floor(seed.y*3.);
 float v=fract(seed.y*3.);
 vec4 signal=texture2D(waveforms,vec2(u,(seed.z+.5)/3.));
 float amplitude=signal.a;
 vec3 amber=vec3(.9,.37,.07), ectoplasm=vec3(.29,.68,.47), violet=vec3(.51,.28,.75);
 color=mix(amber,violet,.5+.5*sin(u*6.283+palette*.15));
 if(lane==1)color=mix(amber,vec3(.85,.65,.27),u);
 if(lane==2)color=mix(ectoplasm,violet,.5+.5*sin(u*12.56));
 color=mix(color,signal.rgb,.12);
 float beatPulse=exp(-fract(m.w)*10.)*min(1.,sqrt(max(0.,e.x))*4.);
 float travelingPulse=exp(-fract(m.w-u*8.)*9.);
 float phase=time*.055+seed.z*2.094;
 float spread=sqrt(aspect);
 vec3 p;vec2 root=vec2(0.);float weight=1.;
 if(family<.5){
   // A traveling waveform follows a morphing knot, displaced along the
   // curve normal. Its origin stays attached to the corresponding deck.
   float row=floor(v*24.);
   float shell=(row-11.5)/11.5;
   float shape=.5+.5*sin(time*.043+seed.z*.7);
   float t=u*6.283185+phase+seed.z*.5;
   vec3 curve=orbit(t,shape);
   vec3 tangent=normalize(orbit(t+.01,shape)-orbit(t-.01,shape));
   vec3 normal=normalize(cross(tangent,vec3(0.,0.,1.)));
   float wave=(amplitude-.5)*(.35+e.y*.9+dance*.5)*(1.+m.y);
   float enter=smoothstep(0.,.22,u);
   p=curve*enter;
   p+=normal*(wave+shell*(.035+amplitude*.2)*(1.+travelingPulse*1.6+dance*.8))*enter;
   p.z+=shell*.12*enter+m.x*sin(t)*.18;
   p.x*=spread;
   root=origin*(1.-enter);
   weight=(1.-smoothstep(.9,1.,u))*(.95-abs(shell)*.35);
 }else if(family<1.5){
   // Orderly contour sections of a slowly folding shared surface.
   // Latitudinal engraving over a lobed pumpkin silhouette.
   float theta=u*6.283185;
   float phi=(floor(v*24.)+.5)/24.*3.14159;
   float lobe=1.+.085*cos(theta*10.);
   float radius=sin(phi)*lobe*(.86+amplitude*.09);
   p=vec3(cos(theta)*radius*spread,cos(phi)*.82,sin(theta)*radius*.55);
   float swivel=sin(time*.12+seed.z)*.24;
   p.xz=mat2(cos(swivel),-sin(swivel),sin(swivel),cos(swivel))*p.xz;
   p.y+=.08*cos(theta*2.)*sin(phi);
   weight=.65;
 }else{
   // Nested square portals create a precise architectural vanishing point.
   // Fade at both ends of travel so recycling a portal never flashes.
   float travel=fract(floor(v*24.)/24.+time*.012);
   // Scalloped silk threads stretched between eight radial web supports.
   float angle=u*6.283185;
   float sector=fract(u*8.);
   float scallop=1.-.16*sin(sector*3.14159);
   vec2 q=vec2(cos(angle),sin(angle))*scallop;
   float scale=.25+travel*1.35;
   float twist=sin(time*.15)*.3+travel*.6+seed.z*.035+dance*sin(travel*6.283185)*.35;
   q=mat2(cos(twist),-sin(twist),sin(twist),cos(twist))*q;
   p=vec3(q*vec2(spread,1.)*scale,travel*.3);
   p.z+=(amplitude-.5)*.05;
   p.xy+=vec2(sin(time*.055),cos(time*.041))*(1.-travel)*.3;
   weight=sin(travel*3.14159)*.4;
 }
 // Each player owns a recognizable family even when WebGPU is unavailable:
 // CDJ 1 ribbons, CDJ 2 folding contours, CDJ 3 square wave portals.
 weight*=abs(family-float(lane))<.5 ? 1. : .08;
 p*=1.+beatPulse*(.025+amplitude*.04)+dance*.04;
 p.xy+=vec2(sin(u*18.+time*1.4),cos(u*14.-time))*.08*dance;
 float tilt=sin(time*.045)*.16;
 p.yz=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p.yz;
 float perspective=1./(1.+p.z*.55);
 gl_Position=vec4(root+vec2(p.x/aspect,p.y)*perspective,0.,1.);
 float accent=(.88+travelingPulse*.12)*(family<.5 ? 1. : .35);
 vec3 tint=color/max(.004,max(color.r,max(color.g,color.b)));
 float patina=.72+.28*sin(u*260.+seed.y*70.);
 ink=mix(vec3(.55,.41,.27),tint,.8)*(.32+amplitude*.25+travelingPulse*.2+dance*.3)*patina;
 ink*=.75+.25*perspective;
 opacity=min(1.,sqrt(max(0.,e.x))*3.2)*weight*(.65+beatPulse*.35+dance*.5);
 opacity+=activity*.008;

}`;
const fragment = `precision mediump float;varying vec3 ink;varying float opacity;
float threshold(vec2 p){vec2 a=mod(floor(p),2.);vec2 b=mod(floor(p/2.),2.);float x=mod(a.x+a.y,2.)*2.+a.y;float y=mod(b.x+b.y,2.)*2.+b.y;return (x*4.+y+.5)/16.;}
void main(){gl_FragColor=vec4(ink,opacity*(.85+.15*threshold(gl_FragCoord.xy)));}`;

// Three families of 24 contours per deck, as in the original.
const contours = 72;
const segments = 256;
const verticesPerLane = contours * segments * 2;

export function createLinesBooth(host: HTMLCanvasElement): SceneEngine {
  const pulse = createWaveformPulse();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let music: MusicLane[] = [];
  let previousTime: number | undefined;
  let clock = 0;
  const canvas = document.createElement("canvas");
  host.after(canvas);
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL unavailable");
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed");
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "Shader link failed");
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "waveforms"), 0);
  const seeds = new Float32Array(verticesPerLane * 9);
  for (let lane = 0; lane < 3; lane++)
    for (let row = 0; row < contours; row++)
      for (let segment = 0; segment < segments; segment++)
        for (let end = 0; end < 2; end++) {
          const offset = (lane * verticesPerLane + (row * segments + segment) * 2 + end) * 3;
          seeds[offset] = (segment + end) / segments;
          seeds[offset + 1] = (row + 0.5) / contours;
          seeds[offset + 2] = lane;
        }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, "seed");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = {
    time: uniform("time"),
    aspect: uniform("aspect"),
    pixelRatio: uniform("pixelRatio"),
    activity: uniform("activity"),
    dance: uniform("dance"),
    palette: uniform("palette"),
    energy: uniform("energy[0]"),
    motion: uniform("motion[0]"),
    origins: uniform("origins[0]"),
  };
  return {
    setMusic(lanes) {
      music = lanes;
    },
    draw(time, rgba, energy, motion, origins) {
      const response = pulse.update(music, previousTime === undefined ? 0 : time - previousTime);
      clock +=
        (previousTime === undefined ? 0 : Math.min(0.05, Math.max(0, time - previousTime))) *
        (reduced.matches ? 0 : 1);
      previousTime = time;
      const ratio = Math.min(devicePixelRatio, 1.5);
      const w = Math.round(innerWidth * ratio),
        h = Math.round(innerHeight * ratio);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.clearColor(0.018, 0.01, 0.028, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.time, clock);
      gl.uniform1f(uniforms.activity, 0);
      gl.uniform1f(uniforms.dance, response.pulse * (reduced.matches ? 0.15 : 1));
      gl.uniform1f(uniforms.palette, reduced.matches ? 0 : (response.hue * Math.PI) / 180);
      gl.uniform1f(uniforms.aspect, w / h);
      gl.uniform1f(uniforms.pixelRatio, ratio);
      gl.uniform4fv(uniforms.energy, energy);
      gl.uniform4fv(uniforms.motion, motion);
      gl.uniform2fv(uniforms.origins, origins);
      gl.drawArrays(gl.LINES, 0, verticesPerLane * 3);
    },
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
