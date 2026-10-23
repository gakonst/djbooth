/*
Adapted from vercel-labs/vgpu, glass-sculpture bloom pass.
MIT License

Copyright (c) 2025 Vercel, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
struct BloomBlurParams {
  direction: vec2f,
  padding: vec2f,
}

@group(0) @binding(0) var<uniform> params: BloomBlurParams;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var color = textureSampleLevel(source, linear_sampler, uv, 0.0).rgb * weights[0];
  for (var i = 1; i < 5; i += 1) {
    let offset = params.direction * f32(i) * 1.5;
    color += textureSampleLevel(source, linear_sampler, uv + offset, 0.0).rgb * weights[i];
    color += textureSampleLevel(source, linear_sampler, uv - offset, 0.0).rgb * weights[i];
  }
  return vec4f(color, 1.0);
}
