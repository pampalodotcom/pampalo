import { useEffect, useRef } from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

type Props = {
  height?: number;
  className?: string;
  theme?: "light" | "dark";
};

// ─── Palettes ─────────────────────────────────────────────────────────────
// Two snapshots; every frame we lerp from light→dark by `themeMix`.

const PAL = {
  light: {
    clear: new THREE.Color(0xa3d9ff),
    skyTop: new THREE.Color(0x6cb8ff),
    skyBottom: new THREE.Color(0xd8eeff),
    fog: new THREE.Color(0xc9e9ff),
    sun: new THREE.Color(0xffe7a8),
    halo: new THREE.Color(0xfff6c8),
    seaShallow: new THREE.Color(0x2eb6c2),
    seaDeep: new THREE.Color(0x0e5266),
    sand: new THREE.Color(0xd9c79a),
    cloud: new THREE.Color(0xffffff),
    sunDy: 0.0,
    cloudOpacity: 0.85,
    starOpacity: 0.0,
    moonGlow: 0.0,
    haloOpacity: 0.18,
  },
  dark: {
    clear: new THREE.Color(0x0a1830),
    skyTop: new THREE.Color(0x050b1c),
    skyBottom: new THREE.Color(0x2a2148),
    fog: new THREE.Color(0x0a1830),
    sun: new THREE.Color(0xeef2ff),
    halo: new THREE.Color(0xb6c4e8),
    seaShallow: new THREE.Color(0x1a4a6a),
    seaDeep: new THREE.Color(0x051428),
    sand: new THREE.Color(0x4a5572),
    cloud: new THREE.Color(0x9eb0d2),
    sunDy: -1.4,
    cloudOpacity: 0.35,
    starOpacity: 1.0,
    moonGlow: 0.9,
    haloOpacity: 0.1,
  },
};

export function BeachScene({
  height = 420,
  className,
  theme = "light",
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const themeTargetRef = useRef<number>(theme === "dark" ? 1 : 0);

  // Update the target without re-mounting the scene when theme flips.
  useEffect(() => {
    themeTargetRef.current = theme === "dark" ? 1 : 0;
  }, [theme]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    if (typeof window === "undefined") return;

    const width = mount.clientWidth || mount.offsetWidth || 402;

    // ─── Renderer ───────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(PAL.light.clear, 1);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = `${height}px`;

    // ─── Scene + camera ─────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(PAL.light.fog, 18, 80);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 200);
    camera.position.set(0, 3.0, 9);
    camera.lookAt(0, 0.4, 0);

    // ─── Sky gradient (large back plane) ────────────────────────────────
    const skyGeo = new THREE.PlaneGeometry(400, 60);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: PAL.light.skyTop.clone() },
        bottomColor: { value: PAL.light.skyBottom.clone() },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        void main() {
          gl_FragColor = vec4(mix(bottomColor, topColor, vUv.y), 1.0);
        }
      `,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.set(0, 8, -25);
    scene.add(sky);

    // ─── Sun (becomes the moon at night) ────────────────────────────────
    const sunGeo = new THREE.CircleGeometry(2.4, 48);
    const sunMat = new THREE.MeshBasicMaterial({
      color: PAL.light.sun.clone(),
      transparent: true,
      opacity: 0.9,
    });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    const SUN_BASE_Y = 7;
    sun.position.set(-7, SUN_BASE_Y, -22);
    scene.add(sun);

    const haloGeo = new THREE.CircleGeometry(4.0, 48);
    const haloMat = new THREE.MeshBasicMaterial({
      color: PAL.light.halo.clone(),
      transparent: true,
      opacity: PAL.light.haloOpacity,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.copy(sun.position);
    halo.position.z -= 0.1;
    scene.add(halo);

    // ─── Stars (visible at night via opacity lerp) ─────────────────────
    const starCount = 240;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3 + 0] = (Math.random() - 0.5) * 60;
      starPos[i * 3 + 1] = 3.5 + Math.random() * 12;
      starPos[i * 3 + 2] = -22 - Math.random() * 6;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xf0f4ff,
      size: 0.08,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // ─── Moon glow pool on the sand ─────────────────────────────────────
    const moonGlowTex = makeRadialTexture(
      "rgba(220,230,255,0.85)",
      "rgba(220,230,255,0)",
    );
    const moonGlowMat = new THREE.MeshBasicMaterial({
      map: moonGlowTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const moonGlowGeo = new THREE.PlaneGeometry(18, 10);
    const moonGlow = new THREE.Mesh(moonGlowGeo, moonGlowMat);
    moonGlow.rotation.x = -Math.PI / 2;
    moonGlow.position.set(-2, 0.02, 5);
    scene.add(moonGlow);

    // ─── Cloud puffs ────────────────────────────────────────────────────
    const cloudTexture = makeCloudTexture();
    const cloudMat = new THREE.SpriteMaterial({
      map: cloudTexture,
      color: PAL.light.cloud.clone(),
      transparent: true,
      opacity: PAL.light.cloudOpacity,
      depthWrite: false,
    });
    const clouds: Array<THREE.Sprite> = [];
    const cloudPositions: Array<[number, number, number, number]> = [
      [-14, 6.4, -16, 4.5],
      [-3, 6.0, -14, 5.2],
      [5, 5.4, -18, 4.0],
      [13, 5.0, -19, 3.4],
      [-22, 5.6, -17, 4.2],
      [22, 6.2, -16, 4.8],
    ];
    for (const [x, y, z, s] of cloudPositions) {
      const sprite = new THREE.Sprite(cloudMat);
      sprite.scale.set(s, s * 0.55, 1);
      sprite.position.set(x, y, z);
      scene.add(sprite);
      clouds.push(sprite);
    }

    // ─── Sea ────────────────────────────────────────────────────────────
    const seaGeo = new THREE.PlaneGeometry(300, 30, 200, 40);
    const seaMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        deep: { value: PAL.light.seaDeep.clone() },
        shallow: { value: PAL.light.seaShallow.clone() },
      },
      vertexShader: `
        uniform float time;
        varying vec2 vUv;
        varying float vDepth;
        void main() {
          vUv = uv;
          vec3 p = position;
          float w = sin((p.x + time * 0.6) * 0.6) * 0.05
                  + sin((p.y + time * 0.5) * 0.8) * 0.04;
          p.z += w;
          vDepth = (p.y + 15.0) / 30.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vDepth;
        uniform vec3 deep;
        uniform vec3 shallow;
        void main() {
          vec3 c = mix(shallow, deep, clamp(1.0 - vUv.y, 0.0, 1.0));
          float band = smoothstep(0.45, 0.5, fract(vUv.y * 9.0)) * 0.08;
          gl_FragColor = vec4(c + band, 1.0);
        }
      `,
    });
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.rotation.x = -Math.PI / 2.2;
    sea.position.set(0, 1.0, -4);
    scene.add(sea);

    // ─── Sand ──────────────────────────────────────────────────────────
    const sandGeo = new THREE.PlaneGeometry(200, 14);
    const sandMat = new THREE.MeshBasicMaterial({
      color: PAL.light.sand.clone(),
    });
    const sand = new THREE.Mesh(sandGeo, sandMat);
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(0, 0.0, 4);
    scene.add(sand);

    // ─── Umbrella ──────────────────────────────────────────────────────
    const umbrella = buildUmbrella();
    scene.add(umbrella.group);

    // ─── Animation loop ─────────────────────────────────────────────────
    const _c = new THREE.Color();
    const lerpColor = (
      out: THREE.Color,
      a: THREE.Color,
      b: THREE.Color,
      t: number,
    ) => out.copy(a).lerp(b, t);
    const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

    let raf = 0;
    let disposed = false;
    let themeMix = themeTargetRef.current;
    const THEME_LERP = 0.045;
    const start = performance.now();

    const tick = () => {
      if (disposed) return;
      const t = (performance.now() - start) / 1000;
      seaMat.uniforms.time.value = t;

      // Cloud drift across the wider viewport.
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.position.x += 0.0006 * (i % 2 === 0 ? 1 : -1);
        if (c.position.x > 30) c.position.x = -30;
        if (c.position.x < -30) c.position.x = 30;
      }

      // Umbrella sway.
      umbrella.group.rotation.z = umbrella.tilt + Math.sin(t * 0.6) * 0.012;

      // Theme interpolation — every animated value is a single lerp call.
      themeMix += (themeTargetRef.current - themeMix) * THEME_LERP;
      const m = themeMix;
      const L = PAL.light;
      const D = PAL.dark;

      lerpColor(_c, L.clear, D.clear, m);
      renderer.setClearColor(_c, 1);
      lerpColor(skyMat.uniforms.topColor.value, L.skyTop, D.skyTop, m);
      lerpColor(skyMat.uniforms.bottomColor.value, L.skyBottom, D.skyBottom, m);
      if (scene.fog) lerpColor(scene.fog.color, L.fog, D.fog, m);

      lerpColor(sunMat.color, L.sun, D.sun, m);
      lerpColor(haloMat.color, L.halo, D.halo, m);
      sun.position.y = SUN_BASE_Y + lerpN(L.sunDy, D.sunDy, m);
      halo.position.y = sun.position.y;
      haloMat.opacity = lerpN(L.haloOpacity, D.haloOpacity, m);

      moonGlowMat.opacity = lerpN(L.moonGlow, D.moonGlow, m);

      lerpColor(seaMat.uniforms.shallow.value, L.seaShallow, D.seaShallow, m);
      lerpColor(seaMat.uniforms.deep.value, L.seaDeep, D.seaDeep, m);

      lerpColor(sandMat.color, L.sand, D.sand, m);

      lerpColor(cloudMat.color, L.cloud, D.cloud, m);
      cloudMat.opacity = lerpN(L.cloudOpacity, D.cloudOpacity, m);

      starMat.opacity = lerpN(L.starOpacity, D.starOpacity, m);
      starMat.size = 0.07 + Math.sin(t * 0.8) * 0.005;

      // Umbrella shadow + warm-sand mound fade out at night — no sun to cast
      // a shadow, and the mound's warm sand colour clashes with the cool
      // moonlit sand.
      umbrella.shadowMat.opacity = lerpN(0.45, 0, m);
      umbrella.moundMat.opacity = lerpN(0.55, 0, m);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // ─── Resize observer ────────────────────────────────────────────────
    const positionUmbrella = (w: number) => {
      const aspect = w / height;
      const tWide = THREE.MathUtils.clamp((aspect - 0.55) / (1.8 - 0.55), 0, 1);
      umbrella.group.position.x = THREE.MathUtils.lerp(0.4, 3.4, tWide);
      umbrella.group.position.z = THREE.MathUtils.lerp(5.2, 4.8, tWide);
      umbrella.group.scale.setScalar(THREE.MathUtils.lerp(0.78, 0.95, tWide));

      // Rotate the canopy around Y so its forward Z-tilt leans toward the
      // camera. Without this, the lean direction (world -X) is fixed and
      // doesn't track the camera-to-umbrella line as the umbrella shifts
      // across aspect ratios — making the visible left/right panels look
      // asymmetric. Derivation: the Z-tilt rotates +Y to (-sin tilt, cos
      // tilt, 0). Rotating that around Y by θ gives XZ direction
      // (-sin tilt · cos θ, sin tilt · sin θ); we solve for θ such that
      // this points along (camera − umbrella) in the XZ plane.
      const camDx = camera.position.x - umbrella.group.position.x;
      const camDz = camera.position.z - umbrella.group.position.z;
      umbrella.group.rotation.y = Math.atan2(camDz, -camDx);
    };
    positionUmbrella(width);

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width || width;
        renderer.setSize(w, height, false);
        camera.aspect = w / height;
        camera.updateProjectionMatrix();
        positionUmbrella(w);
      }
    });
    ro.observe(mount);

    // ─── Cleanup ────────────────────────────────────────────────────────
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      try {
        mount.removeChild(renderer.domElement);
      } catch {
        /* element already gone */
      }
      renderer.dispose();
      skyGeo.dispose();
      skyMat.dispose();
      sunGeo.dispose();
      sunMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      moonGlowGeo.dispose();
      moonGlowMat.dispose();
      moonGlowTex.dispose();
      cloudTexture.dispose();
      cloudMat.dispose();
      seaGeo.dispose();
      seaMat.dispose();
      sandGeo.dispose();
      sandMat.dispose();
      umbrella.dispose();
    };
  }, [height]);

  return (
    <div className={cn("relative", className)} style={{ height }}>
      <div ref={mountRef} className="absolute inset-0" />
      <div className="scene-fade" />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeCloudTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const grd = ctx.createRadialGradient(
    size / 2,
    size / 2,
    8,
    size / 2,
    size / 2,
    size / 2,
  );
  grd.addColorStop(0, "rgba(255,255,255,0.95)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.4)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function makeRadialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    6,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function makeUmbrellaCanopyTexture(): THREE.CanvasTexture {
  const w = 4096;
  const h = 1024;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const segments = 8;
  const seg = w / segments;
  const red = "#E8553A";
  const cream = "#FFFBF0";

  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i % 2 === 0 ? red : cream;
    ctx.fillRect(i * seg, 0, seg, h);
  }

  // Subtle vertical shading along the slope.
  const shade = ctx.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, "rgba(0,0,0,0.16)");
  shade.addColorStop(0.55, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(255,255,255,0.05)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);

  // Wordmark on red bands — right-aligned to each band's right edge,
  // near the rim end of the texture (canvas y ≈ 0.86h → V ≈ 0.14 in shader).
  ctx.fillStyle = "#0C2236";
  ctx.font = '800 90px "Fraunces", "Georgia", serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const inset = seg * 0.06;
  const yPx = h * 0.86;
  for (let i = 0; i < segments; i++) {
    if (i % 2 !== 0) continue;
    ctx.fillText("Pampalo", (i + 1) * seg - inset, yPx);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
}

type Umbrella = {
  group: THREE.Group;
  tilt: number;
  shadowMat: THREE.MeshBasicMaterial;
  moundMat: THREE.MeshBasicMaterial;
  dispose: () => void;
};

function buildUmbrella(): Umbrella {
  const group = new THREE.Group();
  // Pulled forward (higher z) so the umbrella sits well clear of the
  // water line. The resize handler lerps z for narrow vs wide viewports.
  group.position.set(3.0, 0, 5.0);
  // Subtle lean — the dynamic rotation.y (set in positionUmbrella) aims the
  // tilt straight at the camera, so this value reads stronger than it would
  // if the tilt were viewed from the side. 0.10 (~5.7°) keeps the umbrella
  // standing mostly upright with just a hint of beach-day slouch.
  const tilt = 0.1;
  group.rotation.z = tilt;
  group.rotation.y = 0;

  // Canopy.
  const canopyTex = makeUmbrellaCanopyTexture();
  const radius = 1.6;
  const conHeight = 0.95;
  const canopyGeo = new THREE.ConeGeometry(radius, conHeight, 8, 1, true);
  const canopyMat = new THREE.MeshBasicMaterial({
    map: canopyTex,
    side: THREE.DoubleSide,
  });
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  const rimY = 2.4;
  canopy.position.y = rimY + conHeight / 2;
  group.add(canopy);

  // Underside disc — closes the open bottom of the cone. 8 segments so it's
  // octagonal, matching the cone's 8 panels exactly (no overhang past the
  // panel chords, no gap to the corners).
  const underGeo = new THREE.CircleGeometry(radius * 0.995, 8);
  const underMat = new THREE.MeshBasicMaterial({ color: 0xf4d9c4 });
  const under = new THREE.Mesh(underGeo, underMat);
  under.rotation.x = Math.PI / 2;
  under.position.y = rimY + 0.01;
  group.add(under);

  // Rim — octagonal torus (tubularSegments = 8) so its straight edges trace
  // the cone's panel bottoms exactly. A circular rim (48 segments) leaves
  // triangular slivers between each chord-shaped panel bottom and the arc.
  const rimGeo = new THREE.TorusGeometry(radius, 0.028, 8, 8);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xc44530 });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = rimY;
  group.add(rim);

  // Finial + tiny stem at the tip.
  const finialGeo = new THREE.SphereGeometry(0.085, 16, 12);
  const finialMat = new THREE.MeshBasicMaterial({ color: 0x9a3220 });
  const finial = new THREE.Mesh(finialGeo, finialMat);
  finial.position.y = rimY + conHeight + 0.05;
  group.add(finial);

  const stemGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.18, 10);
  const stemMat = new THREE.MeshBasicMaterial({ color: 0x9a3220 });
  const stem = new THREE.Mesh(stemGeo, stemMat);
  stem.position.y = rimY + conHeight;
  group.add(stem);

  // Pole.
  const poleHeight = 2.6;
  const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, poleHeight, 14);
  const poleMat = new THREE.MeshBasicMaterial({ color: 0xe5dcc4 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = rimY - poleHeight / 2 + 0.4;
  group.add(pole);

  // Sand mound where the pole meets the ground.
  const moundGeo = new THREE.CircleGeometry(0.42, 24);
  const moundMat = new THREE.MeshBasicMaterial({
    color: 0xa48a5c,
    transparent: true,
    opacity: 0.55,
  });
  const mound = new THREE.Mesh(moundGeo, moundMat);
  mound.rotation.x = -Math.PI / 2;
  mound.position.set(0, 0.03, 0);
  group.add(mound);

  // Soft drop shadow on the sand.
  const shadowTex = makeRadialTexture("rgba(0,0,0,0.45)", "rgba(0,0,0,0)");
  const shadowGeo = new THREE.PlaneGeometry(3.8, 2.1);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.6, 0.04, 0.4);
  group.add(shadow);

  return {
    group,
    tilt,
    shadowMat,
    moundMat,
    dispose() {
      canopyGeo.dispose();
      canopyMat.dispose();
      canopyTex.dispose();
      underGeo.dispose();
      underMat.dispose();
      rimGeo.dispose();
      rimMat.dispose();
      finialGeo.dispose();
      finialMat.dispose();
      stemGeo.dispose();
      stemMat.dispose();
      poleGeo.dispose();
      poleMat.dispose();
      moundGeo.dispose();
      moundMat.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      shadowTex.dispose();
    },
  };
}
