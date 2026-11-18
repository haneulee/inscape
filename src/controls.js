import * as THREE from 'three';

/**
 * Orbit-around-the-diorama controls.
 * drag → orbit · scroll/pinch → dolly (all the way inside) · WASD → move · Q/E → down/up.
 * A slow sway + cursor parallax sit on top so the volume is always turning a little.
 */
export class OrbitFly {
  constructor(camera, dom) {
    this.camera = camera;
    this.enabled = true;
    this.target = new THREE.Vector3();
    this.theta = 0;      // yaw around target
    this.phi = 0;        // elevation
    this.radius = 8;
    this.v = { theta: 0, phi: 0, radius: 0 };
    this.move = new THREE.Vector3();
    this.keys = new Set();
    this.pointers = new Map();
    this.pinch = 0;
    this.onMove = null;
    this.t = 0;
    this.sway = 1;
    this.hover = new THREE.Vector2();
    this.hoverEased = new THREE.Vector2();
    this.minR = 0.25;
    this.maxR = 45;

    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinch = this.#pinchDist();
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && this.pointers.size === 0) {
        this.hover.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.enabled && this.pointers.size === 1) {
        const s = e.pointerType === 'touch' ? 0.006 : 0.004;
        this.v.theta -= (e.clientX - p.x) * s;
        this.v.phi += (e.clientY - p.y) * s;
        this.onMove?.();
      }
      p.x = e.clientX; p.y = e.clientY;
      if (this.enabled && this.pointers.size === 2) {
        const d = this.#pinchDist();
        this.v.radius -= (d - this.pinch) * 0.004;
        this.pinch = d;
        this.onMove?.();
      }
    });
    const up = (e) => { this.pointers.delete(e.pointerId); };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.v.radius += Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0016;
      this.onMove?.();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  #pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  set(target, theta, phi, radius) {
    this.target.copy(target);
    this.theta = theta; this.phi = phi; this.radius = radius;
    this.v = { theta: 0, phi: 0, radius: 0 };
    this.move.set(0, 0, 0);
  }

  update(dt) {
    this.t += dt;
    if (this.enabled) {
      const k = this.keys, a = 7 * dt;
      let x = 0, y = 0, z = 0;
      if (k.has('KeyW') || k.has('ArrowUp')) z -= a;
      if (k.has('KeyS') || k.has('ArrowDown')) z += a;
      if (k.has('KeyA') || k.has('ArrowLeft')) x -= a;
      if (k.has('KeyD') || k.has('ArrowRight')) x += a;
      if (k.has('KeyE') || k.has('Space')) y += a;
      if (k.has('KeyQ') || k.has('ShiftLeft')) y -= a;
      if (x || y || z) {
        const v = new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.theta);
        v.y = y;
        this.move.add(v);
        this.onMove?.();
      }
      // inertia
      const f = 1 - Math.exp(-dt * 7);
      this.theta += this.v.theta * f; this.v.theta *= 1 - f;
      this.phi += this.v.phi * f; this.v.phi *= 1 - f;
      this.radius *= Math.exp(this.v.radius * f); this.v.radius *= 1 - f;
      this.phi = Math.max(-1.2, Math.min(1.35, this.phi));
      this.radius = Math.max(this.minR, Math.min(this.maxR, this.radius));
      this.target.addScaledVector(this.move, dt);
      this.move.multiplyScalar(Math.exp(-dt * 3.5));
    }

    // life: slow sway + cursor parallax (not accumulated)
    this.hoverEased.lerp(this.hover, 1 - Math.exp(-dt * 2.5));
    const th = this.theta + this.sway * (Math.sin(this.t * 0.16) * 0.1 + this.hoverEased.x * 0.12);
    const ph = this.phi + this.sway * (Math.sin(this.t * 0.11 + 1) * 0.03 - this.hoverEased.y * 0.06);
    const r = this.radius;
    this.camera.position.set(
      this.target.x + Math.sin(th) * Math.cos(ph) * r,
      this.target.y + Math.sin(ph) * r,
      this.target.z + Math.cos(th) * Math.cos(ph) * r,
    );
    this.camera.lookAt(this.target);
  }
}
