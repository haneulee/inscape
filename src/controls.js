import * as THREE from 'three';

/**
 * Drag-to-look + WASD/scroll/pinch flying with inertia.
 * On top of the "body" position it adds a constant float (breathing drift) and a
 * cursor-following head offset, so there is always parallax — that's what sells depth.
 */
export class FlyControls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = true;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.look = { yaw: 0, pitch: 0 };
    this.keys = new Set();
    this.pointers = new Map();
    this.pinch = 0;
    this.onMove = null;
    this.limit = 30;
    this.t = 0;
    this.hover = new THREE.Vector2();
    this.hoverEased = new THREE.Vector2();
    this.offset = new THREE.Vector3();

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
        const s = e.pointerType === 'touch' ? 0.0042 : 0.0028;
        this.look.yaw += (e.clientX - p.x) * s;
        this.look.pitch += (e.clientY - p.y) * s;
        this.onMove?.();
      }
      p.x = e.clientX; p.y = e.clientY;
      if (this.enabled && this.pointers.size === 2) {
        const d = this.#pinchDist();
        this.#push(0, 0, -(d - this.pinch) * 0.03);
        this.pinch = d;
      }
    });
    const up = (e) => { this.pointers.delete(e.pointerId); };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.#push(0, 0, Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.012);
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

  #push(x, y, z) {
    const v = new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    v.y = y;
    this.vel.add(v);
    this.onMove?.();
  }

  reset(pos, yaw, pitch) {
    this.pos.copy(pos);
    this.yaw = yaw; this.pitch = pitch;
    this.look.yaw = 0; this.look.pitch = 0;
    this.vel.set(0, 0, 0);
    this.apply();
  }

  apply() {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.position.copy(this.pos).add(this.offset);
  }

  update(dt) {
    this.t += dt;
    if (this.enabled) {
      const k = this.keys;
      const a = 9 * dt;
      let x = 0, y = 0, z = 0;
      if (k.has('KeyW') || k.has('ArrowUp')) z -= a;
      if (k.has('KeyS') || k.has('ArrowDown')) z += a;
      if (k.has('KeyA') || k.has('ArrowLeft')) x -= a;
      if (k.has('KeyD') || k.has('ArrowRight')) x += a;
      if (k.has('KeyE') || k.has('Space')) y += a;
      if (k.has('KeyQ') || k.has('ShiftLeft')) y -= a;
      if (x || y || z) this.#push(x, y, z);

      const lk = 1 - Math.exp(-dt * 14);
      const dy = this.look.yaw * lk, dp = this.look.pitch * lk;
      this.yaw += dy; this.pitch += dp;
      this.look.yaw -= dy; this.look.pitch -= dp;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

      this.pos.addScaledVector(this.vel, dt);
      this.vel.multiplyScalar(Math.exp(-dt * 3.2));
      if (this.pos.length() > this.limit) this.pos.setLength(this.limit);
    }

    // head: float + cursor parallax, in view space
    this.hoverEased.lerp(this.hover, 1 - Math.exp(-dt * 2.5));
    const t = this.t;
    const local = new THREE.Vector3(
      Math.sin(t * 0.23) * 0.22 + this.hoverEased.x * 0.45,
      Math.sin(t * 0.31 + 1.3) * 0.1 - this.hoverEased.y * 0.25,
      Math.sin(t * 0.17 + 0.4) * 0.25,
    );
    this.offset.copy(local.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
    this.apply();
  }
}
