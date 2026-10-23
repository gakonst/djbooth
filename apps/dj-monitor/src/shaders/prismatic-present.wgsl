struct Present { booth: vec4f, resolution: vec2f, strength: f32, padding: f32 }
@group(0) @binding(0) var<uniform> params: Present;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var linear_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f, @builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let scene = textureSampleLevel(source,linear_sampler,uv,0.0);
  let glow = textureSampleLevel(bloom,linear_sampler,uv,0.0).rgb;
  var rgb = scene.rgb + glow * params.strength;
  // A gentle film curve retains source hue in bright highlights.
  rgb = rgb / (1.0 + rgb);
  rgb = pow(max(rgb,vec3f(0.0)),vec3f(0.454545));
  let vignette = 1.0 - 0.28 * dot(uv-0.5,uv-0.5);
  // Stationary ordered grain: no time-dependent noise or flashing.
  let grain = fract(dot(floor(pixel.xy),vec2f(0.75487766,0.56984029))) - 0.5;
  rgb = floor(clamp(rgb*vignette+grain/48.0,vec3f(0.0),vec3f(1.0))*48.0)/48.0;
  var alpha = scene.a;
  if (all(uv > params.booth.xy) && all(uv < params.booth.zw)) {
    let local = (uv-params.booth.xy)/(params.booth.zw-params.booth.xy);
    let rim = max(abs(local.x-0.5)*2.0,abs(local.y-0.5)*2.0);
    alpha *= smoothstep(0.88,1.0,rim);
  }
  return vec4f(rgb*alpha,alpha);
}
