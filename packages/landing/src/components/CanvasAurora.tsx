import { useEffect, useRef } from "react";

const vertexShaderSource = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec3 u_color1;
  uniform vec3 u_color2;
  uniform vec3 u_color3;
  uniform float u_speed;
  uniform float u_scale;
  uniform vec2 u_vignetteCenter;

  // Modulo 289 without a division (only multiplications)
  vec3 mod289(vec3 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }

  vec2 mod289(vec2 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }

  // Permutation polynomial: (34x^2 + x) mod 289
  vec3 permute(vec3 x) {
    return mod289(((x * 34.0) + 1.0) * x);
  }

  // Simplex noise function
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                        0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                       -0.577350269189626,  // -1.0 + 2.0 * C.x
                        0.024390243902439); // 1.0 / 41.0
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                   + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    st.x *= aspect;

    // Move the noise field over time
    vec2 pos = vec2(st * u_scale);
    float time = u_time * u_speed;

    // Generate complex flowing noise by layering with strict vec2 coordinates
    // Reduced to 2 octaves for optimal GPU compute savings under high pixelation
    float n = snoise(pos + vec2(time * 0.3, time * 0.2));
    n += 0.5 * snoise(pos * 2.0 - vec2(time * 0.15, time * 0.25));
    
    // Normalize noise to [0, 1]
    n = n * 0.5 + 0.5;

    // Mix the aurora colors based on noise
    vec3 colorMix = mix(u_color2, u_color1, smoothstep(0.3, 0.7, n));
    colorMix = mix(colorMix, u_color3, smoothstep(0.6, 1.0, n));

    // Calculate intensity/alpha band based on noise
    float intensity = smoothstep(0.15, 0.55, n) * smoothstep(1.0, 0.55, n);

    // Add a dark vignette fade centered dynamically based on u_vignetteCenter so it blends into the edges smoothly
    vec2 center = vec2(u_vignetteCenter.x * aspect, u_vignetteCenter.y);
    float vignette = smoothstep(1.2, 0.0, length(st - center));
    
    // Smoothly fade to 0 opacity at the bottom 25% of the canvas height to ensure a seamless transition
    float bottomFade = smoothstep(0.0, 0.25, gl_FragCoord.y / u_resolution.y);
    float finalAlpha = intensity * vignette * bottomFade;

    gl_FragColor = vec4(colorMix * finalAlpha, finalAlpha);
  }
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export interface CanvasAuroraProps {
  color1?: [number, number, number]; // [r, g, b] 0-1
  color2?: [number, number, number];
  color3?: [number, number, number];
  speed?: number;
  scale?: number;
  opacity?: number;
  blur?: string;
  alignment?: [number, number]; // [x, y] in [0, 1] range. Specifies where the glow center is.
  pixelSize?: number; // virtual pixel size, e.g. 8 for 8x8 blocks. 1 is normal resolution.
  className?: string;
}

export function CanvasAurora({
  color1 = [0.85, 0.15, 0.4], // Magenta/Pink
  color2 = [0.2, 0.35, 0.95], // Deep Blue
  color3 = [0.95, 0.6, 0.15], // Vibrant Orange
  speed = 0.2,
  scale = 1.0,
  opacity = 0.7,
  blur = "40px",
  alignment = [0.5, 0.5],
  pixelSize = 1,
  className = "",
}: CanvasAuroraProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({
    color1,
    color2,
    color3,
    speed,
    scale,
    alignment,
    pixelSize,
  });

  useEffect(() => {
    propsRef.current = {
      color1,
      color2,
      color3,
      speed,
      scale,
      alignment,
      pixelSize,
    };
  }, [color1, color2, color3, speed, scale, alignment, pixelSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
    });
    if (!gl) return;

    // Enable standard alpha blending for premultiplied alpha
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(
      gl,
      gl.FRAGMENT_SHADER,
      fragmentShaderSource
    );
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    // Create a full-screen quad
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const timeLocation = gl.getUniformLocation(program, "u_time");
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const color1Location = gl.getUniformLocation(program, "u_color1");
    const color2Location = gl.getUniformLocation(program, "u_color2");
    const color3Location = gl.getUniformLocation(program, "u_color3");
    const speedLocation = gl.getUniformLocation(program, "u_speed");
    const scaleLocation = gl.getUniformLocation(program, "u_scale");
    const vignetteCenterLocation = gl.getUniformLocation(
      program,
      "u_vignetteCenter"
    );

    let animationFrameId: number;
    const startTime = Date.now();
    let lastRenderTime = 0;
    const fpsInterval = 1000 / 20; // Throttle to 20 FPS for authentic retro-console feel and 80% compute savings

    const render = () => {
      animationFrameId = requestAnimationFrame(render);

      const now = Date.now();
      const elapsed = now - lastRenderTime;

      // Skip rendering if the 20 FPS interval hasn't elapsed yet
      if (elapsed < fpsInterval) {
        return;
      }
      lastRenderTime = now - (elapsed % fpsInterval);

      const currentProps = propsRef.current;
      const sizeFactor = Math.max(1, currentProps.pixelSize);

      // Resize canvas to match display size (divided by pixelation factor)
      const displayWidth = Math.max(
        1,
        Math.floor(canvas.clientWidth / sizeFactor)
      );
      const displayHeight = Math.max(
        1,
        Math.floor(canvas.clientHeight / sizeFactor)
      );
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      }

      gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
      gl.uniform1f(timeLocation, (now - startTime) / 1000.0);

      gl.uniform3f(
        color1Location,
        currentProps.color1[0],
        currentProps.color1[1],
        currentProps.color1[2]
      );
      gl.uniform3f(
        color2Location,
        currentProps.color2[0],
        currentProps.color2[1],
        currentProps.color2[2]
      );
      gl.uniform3f(
        color3Location,
        currentProps.color3[0],
        currentProps.color3[1],
        currentProps.color3[2]
      );
      gl.uniform1f(speedLocation, currentProps.speed);
      gl.uniform1f(scaleLocation, currentProps.scale);
      gl.uniform2f(
        vignetteCenterLocation,
        currentProps.alignment[0],
        currentProps.alignment[1]
      );

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        filter: blur ? `blur(${blur})` : undefined,
        opacity: opacity,
        imageRendering: pixelSize > 1 ? "pixelated" : undefined,
        borderRadius: "inherit",
      }}
    />
  );
}
