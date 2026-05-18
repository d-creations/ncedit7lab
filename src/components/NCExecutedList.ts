export class NCExecutedList extends HTMLElement {
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
          background: #1e1e1e;
          color: #d4d4d4;
          padding: 8px;
        }
      </style>
      <div>Executed Code</div>
      <!-- TODO: Implement executed code list -->
    `;
  }
}

customElements.define('nc-executed-list', NCExecutedList);
