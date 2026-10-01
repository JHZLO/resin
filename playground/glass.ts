// The live stage: liquid glass over slow color, painted with WebGL2.
//
// The diagram's SVG is drawn with `stage: false`, so it carries only what sits on the glass (text,
// rules, connectors). This module paints everything under it, every frame:
//   1. the stage: moving color in one of three themes (aurora ribbons, silk, water light), the light
//      that follows the pointer and ripples from taps, into a half-size texture with mipmaps
//   2. that texture on screen, with twinkling stars (aurora), a dot grid that pans and zooms with the
//      tables, grain and a vignette
//   3. a frosted glass panel under every table: the stage blurred (read from the mipmaps) and mostly
//      veiled, a rim band that bends what is behind it, a rim that flares on the side facing the
//      light, an inner bevel, and a soft shadow
// The SVG never repaints while the pointer moves; only this canvas does.

import { CARD_RADIUS, GRID_STEP, type Glass, type Ink, type Stage, type SvgBox } from "../src/svg.ts";

const FOLLOW = 0.14;
const PARALLAX = 0.3;
const TWEEN_MS = 200;
const RIPPLES = 4;
const STYLE = { aurora: 0, silk: 1, caustic: 2 } as const;

const VS_SCREEN = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const NOISE = `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}`;

const FS_STAGE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uSize;
uniform vec2 uPan;
uniform float uTime;
uniform int uStyle;
uniform vec3 uBase;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uK;
uniform vec3 uSpot0;
uniform vec3 uSpot1;
uniform vec3 uSpot2;
uniform vec4 uLight;
uniform vec3 uLightColor;
uniform float uLightK;
uniform vec4 uRipple[${RIPPLES}];
${NOISE}
float caustic(vec2 uv, float time) {
  vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
  vec2 i = p; float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / 0.005), p.y / (cos(i.y + t) / 0.005)));
  }
  c /= 4.0; c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.0);
}
vec2 ripples(vec2 px) {
  vec2 off = vec2(0.0);
  for (int k = 0; k < ${RIPPLES}; k++) {
    vec4 r = uRipple[k];
    if (r.w < 0.5) continue;
    vec2 d = px - r.xy; float dist = length(d) + 1e-4;
    float front = r.z * 380.0;
    float ring = exp(-pow((dist - front) / 36.0, 2.0)) * exp(-r.z * 1.7);
    off += d / dist * sin((dist - front) * 0.11) * 10.0 * ring;
  }
  return off;
}
vec3 field(vec3 base, vec3 col, float k, vec2 q, vec2 c, float r) {
  vec2 d = q - c; return mix(base, col, k * exp(-dot(d, d) / (r * r)));
}
void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  px += ripples(px);
  float R = max(uSize.x, uSize.y);
  vec2 q = (px - uPan) / R;
  float t = uTime;
  vec3 col = uBase;
  if (uStyle == 0) {
    vec2 w = q + 0.07 * vec2(fbm(q * 2.6 + t * 0.04), fbm(q * 2.6 - t * 0.035 + 7.3)) - 0.035;
    col = field(col, uC0, uK.x * 0.35, w, uSpot0.xy + 0.07 * vec2(sin(t * 0.07), cos(t * 0.05)), uSpot0.z * 0.62);
    col = field(col, uC1, uK.y * 0.35, w, uSpot1.xy + 0.07 * vec2(cos(t * 0.06), sin(t * 0.08)), uSpot1.z * 0.62);
    col = field(col, uC2, uK.z * 0.35, w, uSpot2.xy + 0.07 * vec2(sin(t * 0.05 + 1.0), cos(t * 0.07 + 2.0)), uSpot2.z * 0.62);
    // Two ribbons, the second color high and faint above the first; the third color stays a low glow.
    // Each has a bright lower edge that folds and wavers along its length, and light rising from it in
    // fine rays whose folds drift sideways
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      vec3 c = i == 0 ? uC1 : uC0;
      float k = i == 0 ? uK.y : uK.x * 0.8;
      float x = q.x * (1.0 + 0.4 * fi) + fi * 3.7 + t * 0.012 * (1.0 + fi);
      float edge = (i == 0 ? 0.36 : 0.21) + 0.3 * (fbm(vec2(x * 0.7 + t * 0.05, fi * 5.1)) - 0.5);
      float dy = q.y - edge;
      float fold = fbm(vec2(x * 2.5, t * 0.12 + fi * 3.0));
      float rays = 0.55 + 0.45 * sin(x * 70.0 + fold * 14.0 + t * 0.4);
      rays = mix(rays, 1.0, 0.35) * (0.55 + 0.45 * fbm(vec2(x * 4.0 - t * 0.15, fi * 2.3)));
      float curtain = dy > 0.0 ? exp(-pow(dy / 0.024, 2.0)) : exp(dy / (0.12 + 0.06 * fi));
      col = mix(col, c, clamp(curtain * rays * k * 1.3, 0.0, 1.0));
    }
  } else if (uStyle == 1) {
    vec2 p = q * 2.0;
    float a = fbm(p + vec2(t * 0.025, -t * 0.02));
    float b = fbm(p * 1.3 + a * 1.8 + vec2(-t * 0.02, t * 0.024) + 3.1);
    float c = fbm(p * 0.8 + b * 1.5 + 7.7);
    col = mix(col, uC1, smoothstep(0.3, 0.8, a) * uK.y);
    col = mix(col, uC0, smoothstep(0.35, 0.85, c) * uK.x);
    float sheen = pow(max(0.0, 1.0 - abs(b - 0.55) * 4.0), 5.0);
    col = mix(col, uC2, sheen * uK.z);
  } else {
    float depth = fbm(q * 1.6 + vec2(t * 0.02, -t * 0.015));
    col = mix(col, uC0, (0.35 + 0.65 * depth) * uK.x);
    float c = caustic(q * 2.4 + vec2(t * 0.01, t * 0.008), t * 0.32);
    col += uC1 * c * uK.y;
    col = mix(col, uC2, smoothstep(0.55, 0.95, fbm(q * 1.2 - t * 0.02)) * uK.z);
  }
  vec2 dl = px - uLight.xy;
  col += uLightColor * uLightK * uLight.z * exp(-dot(dl, dl) / (uLight.w * uLight.w));
  o = vec4(col, 1.0);
}`;

const FS_SCREEN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uStage;
uniform vec2 uSize;
uniform vec3 uView;
uniform vec4 uGrid;
uniform vec4 uLight;
uniform float uGrain;
uniform float uVignette;
uniform float uDpr;
uniform float uTime;
uniform vec4 uStars;
uniform vec2 uStarPan;
uniform float uDark;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// One star at most per cell, at a random spot, twinkling at its own pace; the brightest flare into a cross
float star(vec2 px) {
  vec2 p = px - uStarPan;
  const float cell = 28.0;
  vec2 id = floor(p / cell);
  if (hash(id) > 0.2) return 0.0;
  vec2 at = id * cell + 8.0 + vec2(hash(id + 11.3), hash(id + 27.1)) * (cell - 16.0);
  vec2 a = abs(p - at);
  float d = length(a);
  float bright = hash(id + 3.7);
  float tw = 0.5 + 0.5 * sin(uTime * (0.7 + 2.3 * hash(id + 5.9)) + 6.2831 * hash(id + 8.2));
  float size = 0.55 + 0.85 * bright;
  float s = ((1.0 - smoothstep(size * 0.45, size, d)) + exp(-d * d / (size * size * 5.0)) * 0.3) * (0.3 + 0.7 * bright) * (0.35 + 0.65 * tw);
  if (bright > 0.88) s += (exp(-a.y * 1.4) * exp(-a.x / 4.5) + exp(-a.x * 1.4) * exp(-a.y / 4.5)) * 0.7 * tw * tw;
  return s;
}
void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  vec3 col = texture(uStage, vUv).rgb;
  if (uStars.a > 0.0) {
    // At night the stars fade where the aurora is bright
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float sky = uDark > 0.5 ? 1.0 - smoothstep(0.12, 0.4, lum) : 1.0;
    col = mix(col, uStars.rgb, clamp(star(px) * uStars.a * sky, 0.0, 1.0));
  }
  if (uGrid.a > 0.0) {
    float step = ${GRID_STEP}.0 * uView.z;
    vec2 cell = floor((px - uView.xy) / step + 0.5);
    float d = length(px - (cell * step + uView.xy));
    bool major = mod(cell.x, 5.0) == 0.0 && mod(cell.y, 5.0) == 0.0;
    float fade = major ? 1.0 : smoothstep(9.0, 20.0, step);
    float size = major ? 1.1 : 0.8;
    float a = 1.0 - smoothstep(size - 0.5, size + 0.5, d);
    vec2 dl = px - uLight.xy;
    float wake = 1.0 + 1.8 * uLight.z * exp(-dot(dl, dl) / (230.0 * 230.0));
    col = mix(col, uGrid.rgb, clamp(a * uGrid.a * fade * wake, 0.0, 1.0));
  }
  col += (hash(floor(px * uDpr)) - 0.5) * uGrain;
  vec2 v = (px / uSize - 0.5) * vec2(uSize.x, uSize.y) / max(uSize.x, uSize.y) * 1.4;
  col *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(v));
  o = vec4(col, 1.0);
}`;

const VS_GLASS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in float aDim;
uniform vec3 uView;
uniform vec2 uSize;
uniform float uMargin;
out vec2 vPx;
flat out vec4 vRect;
flat out float vDim;
void main() {
  vec4 r = vec4(aRect.xy * uView.z + uView.xy, aRect.zw * uView.z);
  vec2 p = r.xy - uMargin + aCorner * (r.zw + 2.0 * uMargin);
  vPx = p; vRect = r; vDim = aDim;
  vec2 clip = p / uSize * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS_GLASS = `#version 300 es
precision highp float;
in vec2 vPx;
flat in vec4 vRect;
flat in float vDim;
out vec4 o;
uniform sampler2D uStage;
uniform vec2 uSize;
uniform float uRadius;
uniform float uScale;
uniform vec4 uLight;
uniform vec4 uVeil;
uniform vec4 uTint;
uniform vec4 uRim;
uniform float uSpec;
uniform float uLens;
uniform float uLod;
uniform vec4 uShadow;
uniform float uOutline;
uniform float uDark;
uniform vec3 uView;
uniform vec4 uGrid;
float sdRR(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec3 frosted(vec2 uv, float lod) {
  vec2 texel = 1.0 / vec2(textureSize(uStage, 0));
  float s = exp2(lod) * 0.6;
  vec3 c = textureLod(uStage, uv, lod).rgb * 0.4;
  c += textureLod(uStage, uv + vec2(s, s) * texel, lod).rgb * 0.15;
  c += textureLod(uStage, uv + vec2(-s, s) * texel, lod).rgb * 0.15;
  c += textureLod(uStage, uv + vec2(s, -s) * texel, lod).rgb * 0.15;
  c += textureLod(uStage, uv + vec2(-s, -s) * texel, lod).rgb * 0.15;
  return c;
}
// The grid seen through the glass, where it is clear enough to show it
float dots(vec2 px) {
  float step = ${GRID_STEP}.0 * uView.z;
  vec2 cell = floor((px - uView.xy) / step + 0.5);
  float d = length(px - (cell * step + uView.xy));
  bool major = mod(cell.x, 5.0) == 0.0 && mod(cell.y, 5.0) == 0.0;
  float fade = major ? 1.0 : smoothstep(9.0, 20.0, step);
  float size = (major ? 1.1 : 0.8) * 1.35;
  return (1.0 - smoothstep(size - 0.6, size + 0.6, d)) * fade;
}
void main() {
  vec2 hb = vRect.zw * 0.5;
  vec2 p = vPx - (vRect.xy + hb);
  float r = min(uRadius, min(hb.x, hb.y));
  float d = sdRR(p, hb, r);
  float cover = 1.0 - smoothstep(-0.6, 0.6, d);

  float ds = sdRR(p - vec2(0.0, 12.0 * uScale + 4.0), hb, r);
  float shadow = (1.0 - smoothstep(-16.0, 30.0 * uScale + 8.0, ds)) * 0.75;
  shadow += (1.0 - smoothstep(-1.0, 3.0, sdRR(p - vec2(0.0, 1.0), hb, r))) * 0.35;
  shadow = clamp(shadow, 0.0, 1.0) * uShadow.a;
  shadow = max(shadow, (1.0 - smoothstep(0.2, 1.4, d)) * uOutline);
  shadow *= 1.0 - cover;

  vec4 glass = vec4(0.0);
  if (cover > 0.0) {
    float e = 0.75;
    vec2 n = vec2(sdRR(p + vec2(e, 0.0), hb, r) - sdRR(p - vec2(e, 0.0), hb, r),
                  sdRR(p + vec2(0.0, e), hb, r) - sdRR(p - vec2(0.0, e), hb, r));
    n /= max(length(n), 1e-4);
    // The rim band is a lens: clearer than the middle, and it bends what is behind it outward,
    // so the stage and the grid dots slide around the edge
    float band = 16.0 * sqrt(uScale);
    float clear = pow(clamp(1.0 + d / band, 0.0, 1.0), 2.0);
    float bend = clear * clear;
    vec2 shift = n * bend * uLens;
    vec2 uv = vec2(vPx.x, uSize.y - vPx.y) / uSize;
    vec2 su = vec2(shift.x, -shift.y) / uSize;
    float lod = mix(uLod, uLod * 0.3, clear);
    vec3 col = vec3(frosted(uv + su * 1.15, lod).r, frosted(uv + su, lod).g, frosted(uv + su * 0.85, lod).b);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, 1.3);
    col = mix(col, uGrid.rgb, dots(vPx - shift * 2.2) * uGrid.a * 1.2 * clear);
    col = mix(col, uVeil.rgb, uVeil.a * (1.0 - 0.22 * clear));
    float ty = clamp((vPx.y - vRect.y) / max(vRect.w, 1.0), 0.0, 1.0);
    col = mix(col, uTint.rgb, uTint.a * (1.0 - ty) * (1.0 - ty));
    vec2 L = uLight.xy - vPx; float ll = length(L);
    L = ll > 1e-3 ? L / ll : vec2(0.0, -1.0);
    float near = exp(-ll * ll / (uLight.w * uLight.w * 2.0));
    float facing = max(dot(n, L), 0.0);
    float away = max(dot(n, -L), 0.0);
    float edge = 1.0 - smoothstep(0.0, 1.4, -d);
    float fixedLight = 0.32 + 0.4 * pow(max(dot(n, vec2(-0.6, -0.8)), 0.0), 1.5);
    float flare = uSpec * uLight.z * (pow(facing, 2.5) * (0.6 + 0.6 * near) + 0.35 * pow(away, 4.0));
    col = mix(col, uRim.rgb, clamp(edge * uRim.a * (fixedLight + flare), 0.0, 1.0));
    // Thickness: light comes in along the top inside edge and the bottom inside edge sits in shade
    float inner = exp(d / 5.0);
    col = mix(col, uRim.rgb, inner * max(-n.y, 0.0) * 0.16 * uRim.a);
    col *= 1.0 - inner * max(n.y, 0.0) * 0.14;
    col += uRim.rgb * exp(d / 10.0) * pow(facing, 2.0) * 0.14 * uLight.z * near;
    glass = vec4(col * cover, cover);
  }
  vec4 sh = vec4(uShadow.rgb * shadow, shadow);
  o = (glass + sh * (1.0 - glass.a)) * vDim;
}`;

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const rgba = ([c, a]: Ink): [number, number, number, number] => [...rgb(c), a];
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader failed");
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  return program;
}

interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export class LiveGlass {
  /** WebGL2 is needed; without it the page shows the still SVG instead */
  static available(): boolean {
    try {
      return document.createElement("canvas").getContext("webgl2") !== null;
    } catch {
      return false;
    }
  }

  private readonly viewport: HTMLElement;
  private readonly canvas = document.createElement("canvas");
  private readonly gl: WebGL2RenderingContext;
  private readonly reduce = matchMedia("(prefers-reduced-motion: reduce)");
  private stagePass!: Program;
  private screenPass!: Program;
  private glassPass!: Program;
  private screenVao!: WebGLVertexArrayObject;
  private glassVao!: WebGLVertexArrayObject;
  private instances!: WebGLBuffer;
  private fbo!: WebGLFramebuffer;
  private tex!: WebGLTexture;
  private texSize = [1, 1];
  private stage: Stage | null = null;
  private glass: Glass | null = null;
  private boxes: SvgBox[] = [];
  private svg: SVGSVGElement | null = null;
  private count = 0;
  private gridOn = true;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private view = { scale: 1, x: 0, y: 0 };
  private shown = { scale: 1, x: 0, y: 0 };
  private tween: { from: { scale: number; x: number; y: number }; start: number } | null = null;
  private target = { x: 0, y: 0 };
  private pos = { x: 0, y: 0 };
  private glow = 0.5;
  private glowTarget = 0.5;
  private ripples: { x: number; y: number; born: number }[] = [];
  private time = 0;
  private last = 0;
  private lastInput = 0;
  private frame = 0;
  private skip = false;
  private paused = false;

  constructor(viewport: HTMLElement, content: HTMLElement) {
    this.viewport = viewport;
    this.canvas.className = "stage-glass";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
    viewport.insertBefore(this.canvas, content);
    const gl = this.canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.init();
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.init();
      this.upload();
      this.kick();
    });
    viewport.addEventListener("pointermove", (e) => this.point(e), { passive: true });
    viewport.addEventListener("pointerleave", () => this.rest());
    new ResizeObserver(() => this.resize()).observe(viewport);
    this.resize();
    this.pos = { ...this.target };
  }

  setLook(stage: Stage | null, glass: Glass | null): void {
    this.stage = stage;
    this.glass = glass;
    this.canvas.hidden = !stage || !glass;
    this.kick();
  }

  /** The cards of the drawing now on the canvas, and the drawing itself (for focus) */
  setBoxes(boxes: SvgBox[], svg: SVGSVGElement | null): void {
    this.boxes = boxes;
    this.svg = svg;
    this.upload();
    this.kick();
  }

  setView(scale: number, x: number, y: number, animate = false): void {
    this.view = { scale, x, y };
    this.tween = animate && !this.reduce.matches ? { from: { ...this.shown }, start: performance.now() } : null;
    if (!this.tween) this.shown = { ...this.view };
    this.lastInput = performance.now();
    this.kick();
  }

  setGrid(on: boolean): void {
    this.gridOn = on;
    this.kick();
  }

  /** A ring through the stage from a tap, at viewport coordinates */
  ripple(x: number, y: number): void {
    if (this.reduce.matches) return;
    this.ripples = [...this.ripples.slice(-(RIPPLES - 1)), { x, y, born: performance.now() }];
    this.lastInput = performance.now();
    this.kick();
  }

  /** Draw again, after the focus changed for instance */
  refresh(): void {
    this.upload();
    this.kick();
  }

  /** Stop drawing while the canvas is out of sight */
  pause(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else {
      this.last = 0;
      this.kick();
    }
  }

  // ---- setup ----

  private init(): void {
    const gl = this.gl;
    const uniforms = (program: WebGLProgram, names: string[]): Program => ({
      program,
      u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])),
    });
    this.stagePass = uniforms(compile(gl, VS_SCREEN, FS_STAGE), [
      "uSize", "uPan", "uTime", "uStyle", "uBase", "uC0", "uC1", "uC2", "uK", "uSpot0", "uSpot1", "uSpot2",
      "uLight", "uLightColor", "uLightK", "uRipple",
    ]);
    this.screenPass = uniforms(compile(gl, VS_SCREEN, FS_SCREEN), [
      "uStage", "uSize", "uView", "uGrid", "uLight", "uGrain", "uVignette", "uDpr", "uTime", "uStars", "uStarPan", "uDark",
    ]);
    this.glassPass = uniforms(compile(gl, VS_GLASS, FS_GLASS), [
      "uStage", "uSize", "uView", "uMargin", "uRadius", "uScale", "uLight", "uVeil", "uTint", "uRim", "uSpec", "uLens",
      "uLod", "uShadow", "uOutline", "uDark", "uGrid",
    ]);

    // One triangle that covers the screen
    this.screenVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.screenVao);
    const tri = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // A unit quad per card, instanced: rect (x, y, w, h) and dim
    this.glassVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.glassVao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
    this.texSize = [0, 0];
  }

  private upload(): void {
    const gl = this.gl;
    const svg = this.svg;
    // A focused drawing keeps faded tables faded
    const on = svg?.classList.contains("is-focus") ? new Set([...svg.querySelectorAll<SVGGElement>(".rz-t.is-on")].map((el) => el.dataset.t)) : null;
    const data = new Float32Array(this.boxes.length * 5);
    this.boxes.forEach((b, i) => data.set([b.x, b.y, b.w, b.h, on && !on.has(b.table) ? 0.14 : 1], i * 5));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.count = this.boxes.length;
  }

  private resize(): void {
    this.w = Math.max(1, this.viewport.clientWidth);
    this.h = Math.max(1, this.viewport.clientHeight);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    const tw = Math.ceil(this.w / 2);
    const th = Math.ceil(this.h / 2);
    if (tw !== this.texSize[0] || th !== this.texSize[1]) {
      const gl = this.gl;
      this.texSize = [tw, th];
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (this.glowTarget < 1) this.rest();
    this.kick();
  }

  // ---- input ----

  private point(e: PointerEvent): void {
    const r = this.viewport.getBoundingClientRect();
    this.target = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.glowTarget = 1;
    this.lastInput = performance.now();
    this.kick();
  }

  /** Without a pointer the light settles high in the middle, a little dimmer */
  private rest(): void {
    this.target = { x: this.w * 0.5, y: this.h * 0.12 };
    this.glowTarget = 0.5;
    this.kick();
  }

  // ---- frame ----

  private kick(): void {
    if (!this.frame && !this.paused) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    this.frame = 0;
    if (!this.stage || !this.glass || this.gl.isContextLost()) return;
    const still = this.reduce.matches;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    // Idle for a while: keep the stage moving, at half the frame rate
    const idle = now - this.lastInput > 4000;
    this.skip = idle ? !this.skip : false;
    if (!still) this.time += dt;
    const k = still ? 1 : FOLLOW;
    this.pos.x += (this.target.x - this.pos.x) * k;
    this.pos.y += (this.target.y - this.pos.y) * k;
    this.glow += (this.glowTarget - this.glow) * (still ? 1 : 0.08);
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / TWEEN_MS);
      const e = easeOut(t);
      const { from } = this.tween;
      this.shown = {
        scale: from.scale + (this.view.scale - from.scale) * e,
        x: from.x + (this.view.x - from.x) * e,
        y: from.y + (this.view.y - from.y) * e,
      };
      if (t >= 1) this.tween = null;
    }
    this.ripples = this.ripples.filter((r) => now - r.born < 2600);
    if (!this.skip || this.tween) this.draw(now);
    // The stage flows on its own; with reduced motion it only redraws when something changes
    const settling = Math.abs(this.target.x - this.pos.x) > 0.3 || Math.abs(this.target.y - this.pos.y) > 0.3 || Math.abs(this.glowTarget - this.glow) > 0.003;
    if (!still || settling || this.tween || this.ripples.length) this.kick();
  }

  private draw(now: number): void {
    const gl = this.gl;
    const S = this.stage!;
    const G = this.glass!;
    const { scale, x, y } = this.shown;
    const light = [this.pos.x, this.pos.y, this.glow, S.light[2]];

    // 1. The stage, into the half-size texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.texSize[0], this.texSize[1]);
    gl.disable(gl.BLEND);
    let p = this.stagePass;
    gl.useProgram(p.program);
    gl.uniform2f(p.u.uSize, this.w, this.h);
    gl.uniform2f(p.u.uPan, x * PARALLAX, y * PARALLAX);
    gl.uniform1f(p.u.uTime, this.time);
    gl.uniform1i(p.u.uStyle, STYLE[S.style]);
    gl.uniform3fv(p.u.uBase, rgb(S.base));
    gl.uniform3fv(p.u.uC0, rgb(S.colors[0][0]));
    gl.uniform3fv(p.u.uC1, rgb(S.colors[1][0]));
    gl.uniform3fv(p.u.uC2, rgb(S.colors[2][0]));
    gl.uniform3f(p.u.uK, S.colors[0][1], S.colors[1][1], S.colors[2][1]);
    gl.uniform3f(p.u.uSpot0, ...S.spots[0]);
    gl.uniform3f(p.u.uSpot1, ...S.spots[1]);
    gl.uniform3f(p.u.uSpot2, ...S.spots[2]);
    gl.uniform4fv(p.u.uLight, light);
    gl.uniform3fv(p.u.uLightColor, rgb(S.light[0]));
    gl.uniform1f(p.u.uLightK, S.light[1]);
    const rip = new Float32Array(RIPPLES * 4);
    this.ripples.forEach((r, i) => rip.set([r.x, r.y, (now - r.born) / 1000, 1], i * 4));
    gl.uniform4fv(p.u.uRipple, rip);
    gl.bindVertexArray(this.screenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2. The stage on screen, with the grid, grain and vignette
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    p = this.screenPass;
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(p.u.uStage, 0);
    gl.uniform2f(p.u.uSize, this.w, this.h);
    gl.uniform3f(p.u.uView, x, y, scale);
    gl.uniform4fv(p.u.uGrid, this.gridOn ? rgba(S.grid) : [0, 0, 0, 0]);
    gl.uniform4fv(p.u.uLight, light);
    gl.uniform1f(p.u.uGrain, S.grain);
    gl.uniform1f(p.u.uVignette, S.vignette);
    gl.uniform1f(p.u.uDpr, this.dpr);
    gl.uniform1f(p.u.uTime, this.time);
    gl.uniform4fv(p.u.uStars, S.stars ? rgba(S.stars) : [0, 0, 0, 0]);
    // Stars are far away: they drift a tenth of a pan
    gl.uniform2f(p.u.uStarPan, x * 0.1, y * 0.1);
    gl.uniform1f(p.u.uDark, S.dark ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. A glass panel under every table
    if (!this.count) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    p = this.glassPass;
    gl.useProgram(p.program);
    gl.uniform1i(p.u.uStage, 0);
    gl.uniform2f(p.u.uSize, this.w, this.h);
    gl.uniform3f(p.u.uView, x, y, scale);
    gl.uniform1f(p.u.uMargin, 30 * scale + 26);
    gl.uniform1f(p.u.uRadius, CARD_RADIUS * scale);
    gl.uniform1f(p.u.uScale, scale);
    gl.uniform4fv(p.u.uLight, light);
    gl.uniform4fv(p.u.uVeil, rgba(G.veil));
    gl.uniform4fv(p.u.uTint, rgba(G.tint));
    gl.uniform4fv(p.u.uRim, rgba(G.rim));
    gl.uniform1f(p.u.uSpec, G.specular);
    gl.uniform1f(p.u.uLens, G.lens * Math.sqrt(scale));
    // Blur radius in stage texels (half size) → mip level
    gl.uniform1f(p.u.uLod, Math.log2(Math.max(1, (G.frost * Math.sqrt(scale)) / 2)));
    gl.uniform4fv(p.u.uShadow, rgba(G.shadow));
    gl.uniform1f(p.u.uOutline, S.dark ? 0.28 : 0.1);
    gl.uniform1f(p.u.uDark, S.dark ? 1 : 0);
    gl.uniform4fv(p.u.uGrid, this.gridOn ? rgba(S.grid) : [0, 0, 0, 0]);
    gl.bindVertexArray(this.glassVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
