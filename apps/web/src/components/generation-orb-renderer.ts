// Independent shader authored for the workbench from the visible Agentic Ball motion reference.
// Reference: https://pro.reactbits.dev/docs/components/agentic-ball (no Pro source is used).
const vertexSource = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;
const fragmentSource = `
precision mediump float;
uniform vec2 uResolution;
uniform float uTime;
void main() {
  vec2 p = (gl_FragCoord.xy * 2.0 - uResolution) / min(uResolution.x, uResolution.y) / 0.84;
  float radius = length(p);
  if (radius > 1.0) { gl_FragColor = vec4(0.0); return; }
  float z = sqrt(max(0.0, 1.0 - dot(p, p)));
  vec3 normal = vec3(p, z);
  float turn = uTime * 0.13;
  mat2 rotation = mat2(cos(turn), -sin(turn), sin(turn), cos(turn));
  vec2 inside = rotation * p;
  // A broad curved fold travels inside the fixed sphere, without moving its silhouette.
  float fold = inside.x + 0.40 * sin(inside.y * 4.0 + z * 2.4 + uTime * 0.10);
  float seam = exp(-pow(fold * 7.0, 2.0));
  float flow = smoothstep(-0.7, 0.7, fold);
  vec3 navy = vec3(0.043, 0.122, 0.322);
  vec3 violet = vec3(0.357, 0.373, 0.839);
  vec3 mist = vec3(0.933, 0.941, 0.980);
  vec3 lime = vec3(0.800, 0.973, 0.400);
  vec3 material = mix(violet, mix(violet, mist, 0.55), flow);
  material = mix(material, navy, seam * 0.48);
  float diffuse = 0.43 + 0.52 * max(0.0, dot(normal, normalize(vec3(-0.45, 0.65, 1.0))));
  vec3 color = material * diffuse;
  float rim = pow(1.0 - z, 3.0);
  color = mix(color, mist, rim * 0.58);
  float gloss = pow(max(0.0, dot(normal, normalize(vec3(-0.34, 0.48, 1.0)))), 30.0);
  color = mix(color, vec3(1.0), gloss * 0.84);
  float accent = exp(-pow((fold + 0.08) * 16.0, 2.0)) * smoothstep(0.2, 0.8, inside.y) * 0.25;
  color = mix(color, lime, accent);
  float alpha = 1.0 - smoothstep(0.985, 1.0, radius);
  gl_FragColor = vec4(color, alpha);
}
`;

export interface GenerationOrbRenderer { dispose(): void }

export function createGenerationOrbRenderer(canvas: HTMLCanvasElement, unavailable: () => void): GenerationOrbRenderer | undefined {
  let gl: WebGLRenderingContext | null;
  try { gl = canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' }); }
  catch { unavailable(); return undefined; }
  if (!gl) { unavailable(); return undefined; }
  const context = gl, owner = canvas.ownerDocument, host = owner.defaultView!;
  let frame = 0, stopped = false, elapsed = 0, previous = 0, lastDraw = 0;
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
  const shaders: WebGLShader[] = [];
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    host.cancelAnimationFrame(frame);
    observer?.disconnect();
    owner.removeEventListener('visibilitychange', visibility);
    canvas.removeEventListener('webglcontextlost', lost);
    if (buffer) context.deleteBuffer(buffer);
    if (program) context.deleteProgram(program);
    for (const shader of shaders) context.deleteShader(shader);
    context.getExtension('WEBGL_lose_context')?.loseContext();
  };
  const lost = (event: Event) => { event.preventDefault(); dispose(); unavailable(); };
  const visibility = () => {
    host.cancelAnimationFrame(frame);
    previous = 0;
    if (!stopped && owner.visibilityState !== 'hidden') frame = host.requestAnimationFrame(draw);
  };
  const resize = () => {
    const size = canvas.getBoundingClientRect(), ratio = Math.min(host.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(size.width * ratio));
    canvas.height = Math.max(1, Math.round(size.height * ratio));
    context.viewport(0, 0, canvas.width, canvas.height);
  };
  let observer: ResizeObserver | undefined;
  let resolution: WebGLUniformLocation | null = null, time: WebGLUniformLocation | null = null;
  const draw = (now: number) => {
    if (stopped || owner.visibilityState === 'hidden') return;
    if (previous) elapsed += Math.min((now - previous) / 1000, 0.05);
    previous = now;
    if (now - lastDraw >= 1000 / 30) {
      lastDraw = now;
      context.uniform2f(resolution, canvas.width, canvas.height);
      context.uniform1f(time, elapsed);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    }
    frame = host.requestAnimationFrame(draw);
  };
  try {
    for (const [type, source] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = context.createShader(type);
      if (!shader) throw new Error('Shader unavailable');
      shaders.push(shader); context.shaderSource(shader, source); context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error('Shader compilation unavailable');
    }
    program = context.createProgram();
    if (!program) throw new Error('Program unavailable');
    for (const shader of shaders) context.attachShader(program, shader);
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error('Shader linking unavailable');
    context.useProgram(program);
    buffer = context.createBuffer();
    if (!buffer) throw new Error('Buffer unavailable');
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), context.STATIC_DRAW);
    const position = context.getAttribLocation(program, 'aPosition');
    context.enableVertexAttribArray(position); context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    resolution = context.getUniformLocation(program, 'uResolution'); time = context.getUniformLocation(program, 'uTime');
    resize();
    observer = new host.ResizeObserver(resize); observer.observe(canvas);
    canvas.addEventListener('webglcontextlost', lost);
    owner.addEventListener('visibilitychange', visibility);
    frame = host.requestAnimationFrame(draw);
    return { dispose };
  } catch { dispose(); unavailable(); return undefined; }
}
