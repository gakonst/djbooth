// Ported from packages/djbooth/src/visuals-page.ts: the black-and-white "dither engine"
// that `djbooth visuals` serves to a TV. The shader is copied verbatim; here the beat comes
// from the loudest preview deck instead of the CDJ WebSocket.
import type { SceneEngine } from "../scenes.js";

const vertex = "attribute vec2 seed;void main(){gl_Position=vec4(seed,0.,1.);}";
const fragment ='precision highp float;uniform float t,beat,pulse,aspect,scale;'+
'mat2 rot(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}'+
'float shape(vec3 p){p.xz*=rot(t*.18);p.xy*=rot(.28*sin(t*.21));p.yz*=rot(.5);float twist=.65*sin(p.y*1.6+t*.3);p.xz*=rot(twist);float ring=length(vec2(length(p.xy)-.92,p.z))-.26;vec3 q=p;q.yz*=rot(1.5708);float other=length(vec2(length(q.xy)-.92,q.z))-.23;float k=.25;float h=clamp(.5+.5*(other-ring)/k,0.,1.);return mix(other,ring,h)-k*h*(1.-h);}'+
'float b2(vec2 p){p=mod(floor(p),2.);return mod(p.x+2.*p.y,4.)*2.+mod(p.y,2.);}'+
'float threshold(vec2 p){vec2 a=mod(floor(p),2.);vec2 b=mod(floor(p/2.),2.);vec2 c=mod(floor(p/4.),2.);float x=mod(a.x+a.y,2.)*2.+a.y;float y=mod(b.x+b.y,2.)*2.+b.y;float z=mod(c.x+c.y,2.)*2.+c.y;return (x*16.+y*4.+z+.5)/64.;}'+
'void main(){vec2 uv=(gl_FragCoord.xy/vec2(aspect*scale,scale)-.5)*2.;uv.x*=aspect;vec3 ro=vec3(0.,0.,3.7);vec3 rd=normalize(vec3(uv,-2.2));float travel=0.;float d=0.;vec3 p;for(int i=0;i<40;i++){p=ro+rd*travel;d=shape(p);if(d<.003||travel>6.)break;travel+=d*.85;}float lum=0.;if(travel<6.&&d<.02){vec2 e=vec2(.003,0.);vec3 n=normalize(vec3(shape(p+e.xyy)-shape(p-e.xyy),shape(p+e.yxy)-shape(p-e.yxy),shape(p+e.yyx)-shape(p-e.yyx)));float diffuse=max(0.,dot(n,normalize(vec3(-.5,.8,1.))));float rim=pow(1.-max(0.,dot(n,-rd)),2.);float bands=.5+.5*sin(dot(reflect(rd,n),vec3(3.,6.,2.))+t*.3);lum=clamp(.06+diffuse*.55+rim*.45+pow(bands,8.)*.4,0.,.98);lum*=.88+.12*pulse;}float ink=step(threshold(gl_FragCoord.xy),lum);gl_FragColor=vec4(vec3(ink*.96),1.);}';

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
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "Shader link failed");
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, "seed");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0.006, 0.012, 0.022, 1);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = {
    t: uniform("t"),
    beat: uniform("beat"),
    pulse: uniform("pulse"),
    aspect: uniform("aspect"),
    scale: uniform("scale"),
  };
  // The original caps its width at 960px so the raymarch stays smooth on TVs.
  const maxWidth = 960;
  return {
    draw(time, _rgba, _energy, motion, _origins, audibleLevels) {
      const s = Math.min(1, maxWidth / innerWidth);
      const w = Math.round(innerWidth * s),
        h = Math.round(innerHeight * s);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform1f(uniforms.aspect, w / h);
        gl.uniform1f(uniforms.scale, h);
      }
      let lane = 0;
      for (let i = 1; i < 3; i++)
        if ((audibleLevels?.[i] ?? 0) > (audibleLevels?.[lane] ?? 0)) lane = i;
      const beat = motion[lane * 4 + 3] ?? 0;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.t, time);
      gl.uniform1f(uniforms.beat, beat);
      gl.uniform1f(uniforms.pulse, Math.exp(-(((beat % 1) + 1) % 1) * 5));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
