export class NCSyncControls extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          background: #252526;
          color: #d4d4d4;
          padding: 8px;
        }
      </style>
      <div>Sync Controls</div>
      <!-- TODO: Implement sync controls -->
    `;
  }
}

customElements.define('nc-sync-controls', NCSyncControls);
