import { useEffect, useRef } from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

type Props = {
  height?: number;
  className?: string;
};

export function BeachScene({ height = 420, className }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    if (typeof window === "undefined") return;

    const width = mount.clientWidth || mount.offsetWidth || 402;

    // ─── Renderer ───────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0xa3d9ff, 1);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = `${height}px`;

    // ─── Scene + camera ─────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xc9e9ff, 18, 80);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 200);
    camera.position.set(0, 3.4, 9);
    camera.lookAt(0, 1.7, 0);

    // ─── Sky gradient (large back plane) ────────────────────────────────
    const skyGeo = new THREE.PlaneGeometry(120, 60);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x6cb8ff) },
        bottomColor: { value: new THREE.Color(0xd8eeff) },
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

    // ─── Sun ────────────────────────────────────────────────────────────
    const sunGeo = new THREE.CircleGeometry(2.4, 48);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xffe7a8,
      transparent: true,
      opacity: 0.9,
    });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(-7, 7, -22);
    scene.add(sun);

    // Sun glow halo
    const haloGeo = new THREE.CircleGeometry(4.0, 48);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xfff6c8,
      transparent: true,
      opacity: 0.18,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.copy(sun.position);
    halo.position.z -= 0.1;
    scene.add(halo);

    // ─── Cloud puffs (sprites of soft white circles) ────────────────────
    const cloudTexture = makeCloudTexture();
    const cloudMat = new THREE.SpriteMaterial({
      map: cloudTexture,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const clouds: THREE.Sprite[] = [];
    const cloudPositions: Array<[number, number, number, number]> = [
      [-3, 6.4, -16, 4.5],
      [2.5, 6.0, -14, 5.2],
      [5, 5.4, -18, 4.0],
      [-6, 5.0, -19, 3.4],
    ];
    for (const [x, y, z, s] of cloudPositions) {
      const sprite = new THREE.Sprite(cloudMat);
      sprite.scale.set(s, s * 0.55, 1);
      sprite.position.set(x, y, z);
      scene.add(sprite);
      clouds.push(sprite);
    }

    // ─── Sea ────────────────────────────────────────────────────────────
    const seaGeo = new THREE.PlaneGeometry(60, 30, 80, 40);
    const seaMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        deep: { value: new THREE.Color(0x0e5266) },
        shallow: { value: new THREE.Color(0x2eb6c2) },
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
          // Subtle horizontal banding for "wave glints"
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
    const sandGeo = new THREE.PlaneGeometry(60, 14);
    const sandMat = new THREE.MeshBasicMaterial({ color: 0xd9c79a });
    const sand = new THREE.Mesh(sandGeo, sandMat);
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(0, 0.0, 4);
    scene.add(sand);

    // ─── Palm trees ─────────────────────────────────────────────────────
    // Disabled until the geometry looks right; mockup palms were stubs.
    // scene.add(makePalm(-2.4, 0, 1.5, 1));
    // scene.add(makePalm(2.0, 0, 0.5, 0.85));

    // ─── Animation loop ─────────────────────────────────────────────────
    let raf = 0;
    let disposed = false;
    const start = performance.now();
    const tick = () => {
      if (disposed) return;
      const t = (performance.now() - start) / 1000;
      seaMat.uniforms.time.value = t;
      // Slow cloud drift
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.position.x += 0.0006 * (i % 2 === 0 ? 1 : -1);
        if (c.position.x > 10) c.position.x = -10;
        if (c.position.x < -10) c.position.x = 10;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // ─── Resize observer ────────────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width || width;
        renderer.setSize(w, height, false);
        camera.aspect = w / height;
        camera.updateProjectionMatrix();
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
      cloudTexture.dispose();
      cloudMat.dispose();
      seaGeo.dispose();
      seaMat.dispose();
      sandGeo.dispose();
      sandMat.dispose();
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

