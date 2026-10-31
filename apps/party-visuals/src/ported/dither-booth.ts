// Sculpted Halloween variant of the booth dither engine; beat follows the loudest preview deck.
import type { SceneEngine } from "../scenes.js";
import { createDanceMotion, type MusicDance } from "../../../dj-monitor/src/music-dance.js";
import { DEFAULT_VISUAL_LOOK } from "../../../dj-monitor/src/visual-presets.js";

const vertex = "attribute vec2 seed;void main(){gl_Position=vec4(seed,0.,1.);}";
// Fixed-cost raymarch with ordered engraving grain, local candlelight and copper skin.
const fragment = `
precision highp float;
uniform float pulse,aspect,scale,detail,theme,lighting;
uniform vec4 groove;
mat2 rot(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
vec3 local(vec3 p){
 // Inverse model transform keeps the carvings and stem attached to the dancing body.
 p.y-=groove.y*.24;
 p.x-=groove.x*.17;
 p.xy*=rot(groove.x*.16);
 p.xz*=rot(groove.z*.32);
 p.yz*=rot(groove.w*.10);
 float squash=1.-pulse*.07;
 p.y/=squash;p.xz*=sqrt(squash);
 return p;
}
float shape(vec3 p){
 p=local(p);
 float a=atan(p.z,p.x);
 float lobes=1.+.065*cos(a*10.);
 float body=(length(vec3(p.x/lobes,p.y*1.16,p.z/lobes))-.94)*.85;
 vec3 q=p-vec3(.04,1.,0.);
 q.x-=q.y*.25;
 float stem=max(length(q.xz)-.105,abs(q.y)-.26);
 return min(body,stem);
}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float threshold(vec2 p){
 vec2 a=mod(floor(p),2.),b=mod(floor(p/2.),2.);
 return (mod(a.x+a.y,2.)*8.+a.y*4.+mod(b.x+b.y,2.)*2.+b.y+.5)/16.;
}
float triangle(vec2 p,vec2 size){
 float slope=size.y/size.x;
 return max((abs(p.x)*slope+p.y-size.y)/sqrt(1.+slope*slope),-p.y);
}
float face(vec3 p){
 float eye=triangle(vec2(abs(p.x)-.34,p.y-.015),vec2(.17,.26));
 float nose=triangle(vec2(p.x,p.y+.17),vec2(.09,.17));
 float smile=max(abs(p.x)-.58,max(-.49+p.x*p.x*.6-p.y,p.y+.25-p.x*p.x*.45));
 float teeth=max(abs(fract((p.x+.6)*7.)-.5)-.23,-p.y-.34);
 smile=max(smile,-teeth);
 return max(min(min(eye,nose),smile),.25-p.z);
}
void main(){
 vec2 uv=(gl_FragCoord.xy/vec2(aspect*scale,scale)-.5)*2.;uv.x*=aspect;
 uv*=max(1.,.92/aspect);
 vec3 ro=vec3(0.,.15,3.8),rd=normalize(vec3(uv,-2.35));
 float travel=0.,d=0.;vec3 p=ro;
 for(int i=0;i<56;i++){p=ro+rd*travel;d=shape(p);if(d<.002||travel>7.)break;travel+=d*.8;}
 float vignette=exp(-dot(uv,uv)*.4);
 vec3 color=vec3(.018,.012,.035)+vec3(.06,.025,.08)*vignette;
 // Soft mist and an engraved halo sit behind the sculpture.
 float halo=exp(-abs(length(uv*vec2(.9,1.))- .87)*100.);
 float rays=pow(.5+.5*cos(atan(uv.y,uv.x)*64.),12.);
 float outer=exp(-abs(length(uv*vec2(.9,1.))-.94)*170.);
 color+=vec3(.25,.13,.06)*(halo*(.4+.6*rays*detail)+outer*.3*detail);
 color+=vec3(.05,.055,.07)*exp(-pow(uv.y+.8,2.)*20.)*vignette;
 // An anchored floor shadow gives the offbeat lift a visible point of contact.
 float shadow=exp(-pow((uv.x-groove.x*.12)*2.4,2.)-pow((uv.y+.72)*13.,2.));
 color*=1.-shadow*.58;
 if(travel<7.&&d<.02){
  vec2 e=vec2(.003,0.);
  vec3 n=normalize(vec3(shape(p+e.xyy)-shape(p-e.xyy),shape(p+e.yxy)-shape(p-e.yxy),shape(p+e.yyx)-shape(p-e.yyx)));
  vec3 q=local(p);
  float diffuse=max(0.,dot(n,normalize(vec3(-.6,.8,1.))));
  float rim=pow(1.-max(0.,dot(n,-rd)),3.);
  float grain=hash(floor(q.xy*320.));
  float pores=hash(floor(q.xy*115.));
  float ribs=.5+.5*cos(atan(q.z,q.x)*10.);
  vec3 skin=mix(vec3(.19,.045,.012),vec3(.65,.24,.045),ribs);
  if(q.y>.76)skin=vec3(.11,.14,.055);
  color=skin*(.19+diffuse*.85)*(.88+grain*.08+pores*.04)+vec3(.3,.15,.55)*rim*.55;
  float spec=pow(max(0.,dot(reflect(rd,n),normalize(vec3(-.6,.8,1.)))),36.);
  color+=vec3(.6,.38,.19)*spec*.4;
  float carving=face(q);
  float cut=(1.-smoothstep(-.002,.004,carving))*theme;
  float bevel=smoothstep(-.038,-.005,carving);
  vec3 candle=vec3(1.,.39,.055)*(.7+pulse*.12);
  vec3 cavity=mix(candle,vec3(.13,.045,.009),bevel);
  color=mix(color,cavity,cut);
  color+=vec3(.3,.085,.008)*exp(-max(0.,carving)*95.)*(1.-cut)*theme*.3;
 }
 // Ordered tonal engraving retains the original dither identity without binary flashing.
 float grain=threshold(gl_FragCoord.xy)-.5;
 color=floor(clamp(color*lighting+grain*.035,0.,1.)*32.)/32.;
 gl_FragColor=vec4(color*vignette,1.);
}`;

export function createDitherBooth(host: HTMLCanvasElement): SceneEngine {
  const canvas = document.createElement("canvas");
  host.after(canvas);
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
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
  const vertexShader = compile(gl.VERTEX_SHADER, vertex);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "Shader link failed");
  gl.useProgram(program);
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const attribute = gl.getAttribLocation(program, "seed");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0.006, 0.012, 0.022, 1);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = {
    pulse: uniform("pulse"),
    aspect: uniform("aspect"),
    scale: uniform("scale"),
    groove: uniform("groove"),
    detail: uniform("detail"),
    theme: uniform("theme"),
    lighting: uniform("lighting"),
  };
  // The original caps its width at 960px so the raymarch stays smooth on TVs.
  const maxWidth = 960;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let previous: number | undefined;
  const dancer = createDanceMotion();
  let suppliedDance: MusicDance | undefined;
  let target = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  return {
    setDance(value) {
      suppliedDance = value;
    },
    setLook(value) {
      target = value;
    },
    status() {
      return "Dancing pumpkin · bass bounce · alternating sway";
    },
    draw(time, _rgba, energy, motion, _origins, audibleLevels) {
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      const blend = 1 - Math.exp(-dt * 4);
      for (const key of ["motion", "intensity", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;
      const bounds = host.getBoundingClientRect();
      const s = Math.min(devicePixelRatio || 1, maxWidth / Math.max(1, bounds.width));
      const w = Math.max(1, Math.round(bounds.width * s)),
        h = Math.max(1, Math.round(bounds.height * s));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform1f(uniforms.aspect, w / h);
        gl.uniform1f(uniforms.scale, h);
      }
      let lane = 0;
      for (let i = 1; i < 3; i++)
        if (
          (audibleLevels?.[i] ?? energy[i * 4] ?? 0) >
          (audibleLevels?.[lane] ?? energy[lane * 4] ?? 0)
        )
          lane = i;
      const beat = motion[lane * 4 + 3] ?? 0;
      const e = lane * 4;
      const dance =
        suppliedDance ??
        dancer.update(
          beat,
          audibleLevels?.[lane] ?? energy[e] ?? 0,
          energy[e + 1] ?? 0,
          energy[e + 2] ?? 0,
          energy[e + 3] ?? 0,
          dt,
        );
      const amount = reduced.matches
        ? 0
        : Math.min(1.5, look.motion) * Math.min(1.5, look.intensity);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.pulse, dance.kick * amount);
      gl.uniform1f(uniforms.detail, Math.max(0, Math.min(1, look.density)));
      gl.uniform1f(uniforms.theme, Math.max(0, Math.min(1, look.halloween)));
      gl.uniform1f(uniforms.lighting, 0.7 + Math.max(0, Math.min(1.5, look.intensity)) * 0.3);
      gl.uniform4f(
        uniforms.groove,
        dance.sway * amount,
        dance.bounce * amount,
        dance.twist * amount,
        dance.nod * amount,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      gl.deleteBuffer(vertices);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
