import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ProgramMaterialDefinition, ProgramToolDefinition } from '@services/tools/SimulationMetadata';
import { getInsertPickPoints, ToolGeometryFactory } from './ToolGeometryFactory';
import { getMaterialPickPoints, MaterialGeometryFactory, type MaterialPickPoint } from './MaterialGeometryFactory';

export type PreviewView = '3d' | 'xy' | 'xz' | 'yz';

/** Camera direction and screen-up per plane; X-Z looks down -Y with +Z pointing down the screen. */
const PLANE_VIEWS: Record<Exclude<PreviewView, '3d'>, { dir: [number, number, number]; up: [number, number, number] }> = {
  xy: { dir: [0, 0, 1], up: [0, 1, 0] },
  xz: { dir: [0, 1, 0], up: [0, 0, -1] },
  yz: { dir: [1, 0, 0], up: [0, 1, 0] },
};
const VIEW_LABELS: Record<PreviewView, string> = { '3d': '3D', xy: 'X–Y', xz: 'X–Z', yz: 'Y–Z' };
const CLICK_TOLERANCE_PX = 5;

const STYLE = `
  :host { display:block; }
  .bar { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:6px; }
  button { padding:3px 8px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:3px; cursor:pointer;
    color:var(--vscode-button-secondaryForeground,#24292f); background:var(--vscode-button-secondaryBackground,#eaeef2); font-size:11px; }
  button.active { color:var(--vscode-button-foreground,#fff); background:var(--vscode-button-background,#0969da); }
  .stage { position:relative; height:260px; overflow:hidden; border:1px solid var(--vscode-widget-border,#d0d7de);
    background:var(--vscode-editor-background,#1e1e1e); }
  .stage canvas { display:block; width:100%; height:100%; }
  .fallback { padding:12px; font-size:11px; color:var(--vscode-descriptionForeground,#57606a); }
  .note { min-height:16px; margin-top:4px; font-size:11px; color:var(--vscode-descriptionForeground,#57606a); }
  .note.error { color:var(--vscode-inputValidation-errorBackground,#cf222e); }
`;

function disposeObject(root: THREE.Object3D, ownMaterials: boolean): void {
  root.traverse((object) => {
    const item = object as THREE.Mesh;
    item.geometry?.dispose();
    if (!ownMaterials || !item.material) return;
    (Array.isArray(item.material) ? item.material : [item.material]).forEach((material) => {
      (material as THREE.SpriteMaterial).map?.dispose();
      material.dispose();
    });
  });
}

/** Live 3D tool preview with world axes; outline vertices of the plate can be clicked to pick the zero point. */
export class NCToolPreview extends HTMLElement {
  private tool?: ProgramToolDefinition;
  private material?: ProgramMaterialDefinition;
  private view: PreviewView = 'xz';
  private message = '';
  private messageIsError = false;
  private readonly factory = new ToolGeometryFactory();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
  private renderer?: THREE.WebGLRenderer;
  private controls?: OrbitControls;
  private toolGroup?: THREE.Group;
  private decor?: THREE.Group;
  private markers: THREE.Mesh[] = [];
  private observer?: ResizeObserver;
  private frame = 0;
  private fitted = false;
  private initialized = false;
  private pointerDown?: [number, number];

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.buildShell();
    this.initRenderer();
    this.rebuild(true);
  }

  disconnectedCallback(): void {
    // The manager re-parents this element while re-rendering; only tear down if it stays detached.
    queueMicrotask(() => {
      if (!this.isConnected) this.teardown();
    });
  }

  getTool(): ProgramToolDefinition | undefined {
    return this.tool;
  }

  getView(): PreviewView {
    return this.view;
  }

  setTool(tool: ProgramToolDefinition | undefined): void {
    this.tool = tool;
    this.material = undefined;
    this.message = '';
    if (this.initialized) this.rebuild(false);
  }

  getMaterial(): ProgramMaterialDefinition | undefined {
    return this.material;
  }

  setMaterial(material: ProgramMaterialDefinition): void {
    this.material = material;
    this.tool = undefined;
    this.message = '';
    if (this.initialized) this.rebuild(false);
  }

  /** Shown under the preview, for example while the form is incomplete; the last valid tool stays visible. */
  setMessage(message: string, isError = false): void {
    this.message = message;
    this.messageIsError = isError;
    this.updateNote();
  }

  setView(view: PreviewView): void {
    this.view = view;
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === view);
    });
    this.fit();
    this.requestRender();
  }

  /** Requests a new zero vertex for the plate; the owner decides whether to store it. */
  pickVertex(index: number): void {
    this.dispatchEvent(new CustomEvent('zero-vertex-pick', { detail: { index } }));
  }

  private buildShell(): void {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="bar">${(Object.keys(VIEW_LABELS) as PreviewView[]).map((view) =>
        `<button type="button" data-view="${view}" class="${view === this.view ? 'active' : ''}">${VIEW_LABELS[view]}</button>`).join('')}
        <button type="button" data-action="fit">Fit</button></div>
      <div class="stage"></div><div class="note"></div>`;
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view as PreviewView));
    });
    root.querySelector('[data-action="fit"]')?.addEventListener('click', () => {
      this.fit();
      this.requestRender();
    });
  }

  private initRenderer(): void {
    const stage = this.shadowRoot?.querySelector<HTMLElement>('.stage');
    if (!stage) return;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      stage.innerHTML = '<div class="fallback">3D preview unavailable: WebGL could not be created.</div>';
      return;
    }
    this.renderer.setPixelRatio(window.devicePixelRatio);
    stage.appendChild(this.renderer.domElement);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(30, 60, 40);
    this.scene.add(light);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.requestRender());
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => { this.pointerDown = [event.clientX, event.clientY]; });
    canvas.addEventListener('pointerup', (event) => this.handlePointerUp(event));
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(stage);
    }
    this.resize();
  }

  private teardown(): void {
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.controls?.dispose();
    this.disposeTool();
    this.disposeDecor();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = undefined;
    this.controls = undefined;
    this.observer = undefined;
    this.fitted = false;
    this.initialized = false;
  }

  private disposeTool(): void {
    if (this.toolGroup) {
      // Tool materials are shared factory constants; markers own theirs.
      this.markers.forEach((marker) => disposeObject(marker, true));
      disposeObject(this.toolGroup, false);
      this.scene.remove(this.toolGroup);
    }
    this.toolGroup = undefined;
    this.markers = [];
  }

  private disposeDecor(): void {
    if (!this.decor) return;
    disposeObject(this.decor, true);
    this.scene.remove(this.decor);
    this.decor = undefined;
  }

  private rebuild(forceFit: boolean): void {
    this.disposeTool();
    const group = this.material ? new MaterialGeometryFactory().create(this.material) :
      this.tool ? this.factory.create(this.tool) : undefined;
    if (group) {
      this.toolGroup = group;
      this.scene.add(group);
      this.addMarkers(group, this.material ? getMaterialPickPoints(this.material) :
        this.tool ? getInsertPickPoints(this.tool) : []);
    }
    this.updateDecor();
    if (group && (forceFit || !this.fitted)) {
      this.fit();
      this.fitted = true;
    }
    this.updateNote();
    this.requestRender();
  }

  private bounds(): THREE.Sphere {
    const box = new THREE.Box3();
    if (this.toolGroup) box.setFromObject(this.toolGroup);
    box.expandByPoint(new THREE.Vector3());
    return box.getBoundingSphere(new THREE.Sphere());
  }

  private addMarkers(group: THREE.Group, points: MaterialPickPoint[]): void {
    if (!points.length) return;
    const size = Math.min(1, Math.max(0.15, this.bounds().radius * 0.025));
    const geometry = new THREE.SphereGeometry(size, 12, 8);
    points.forEach((point) => {
      const marker = new THREE.Mesh(
        point.active ? new THREE.SphereGeometry(size * 1.6, 12, 8) : geometry,
        new THREE.MeshBasicMaterial({ color: point.active ? 0x2ecc71 : 0xffffff, depthTest: false }),
      );
      marker.position.fromArray(point.position);
      marker.renderOrder = 999;
      marker.userData.vertexIndex = point.index;
      group.add(marker);
      this.markers.push(marker);
    });
  }

  private updateDecor(): void {
    this.disposeDecor();
    if (!this.renderer) return;
    const size = Math.max(10, this.bounds().radius * 0.9);
    const decor = new THREE.Group();
    decor.add(new THREE.AxesHelper(size));
    ([['X', 0xff5555, [size, 0, 0]], ['Y', 0x55dd55, [0, size, 0]], ['Z', 0x5599ff, [0, 0, size]]] as const).forEach(([text, color, at]) => {
      const sprite = this.label(text, color, size * 0.14);
      if (sprite) {
        sprite.position.fromArray(at).multiplyScalar(1.08);
        decor.add(sprite);
      }
    });
    this.decor = decor;
    this.scene.add(decor);
  }

  private label(text: string, color: number, scale: number): THREE.Sprite | undefined {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.font = 'bold 44px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    sprite.scale.set(scale, scale, 1);
    sprite.renderOrder = 998;
    return sprite;
  }

  private fit(): void {
    const sphere = this.bounds();
    const radius = Math.max(sphere.radius, 5);
    const dir = this.view === '3d' ? new THREE.Vector3(1, 0.8, 1).normalize() : new THREE.Vector3(...PLANE_VIEWS[this.view].dir);
    const up = this.view === '3d' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(...PLANE_VIEWS[this.view].up);
    this.camera.up.copy(up);
    this.camera.position.copy(sphere.center).addScaledVector(dir, radius * 4);
    this.camera.zoom = 1;
    this.controls?.target.copy(sphere.center);
    if (this.controls) this.controls.enableRotate = this.view === '3d';
    this.camera.lookAt(sphere.center);
    this.resize(radius * 1.25);
    this.controls?.update();
  }

  private resize(halfHeight?: number): void {
    const stage = this.shadowRoot?.querySelector<HTMLElement>('.stage');
    if (!stage || !this.renderer) return;
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    const half = halfHeight ?? (this.camera.top - this.camera.bottom) / 2;
    const aspect = width / height;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.renderer || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer?.render(this.scene, this.camera);
    });
  }

  private handlePointerUp(event: PointerEvent): void {
    const down = this.pointerDown;
    this.pointerDown = undefined;
    if (!down || !this.renderer || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > CLICK_TOLERANCE_PX) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1),
      this.camera,
    );
    const hit = raycaster.intersectObjects(this.markers, false)[0];
    if (hit) this.pickVertex(hit.object.userData.vertexIndex as number);
  }

  private updateNote(): void {
    const note = this.shadowRoot?.querySelector<HTMLElement>('.note');
    if (!note) return;
    const hasPoints = this.markers.length > 0;
    note.classList.toggle('error', this.messageIsError && Boolean(this.message));
    note.textContent = this.message ||
      (hasPoints ? `${this.material?.type === 'cylinder' ? 'Click an end-face centre' :
        this.material ? 'Click a stock corner' : 'Click a plate vertex'} to make it the zero point (green). Axes: X red, Y green, Z blue.` : '');
  }
}

if (!customElements.get('nc-tool-preview')) customElements.define('nc-tool-preview', NCToolPreview);
