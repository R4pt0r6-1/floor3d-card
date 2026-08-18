import { LitElement, html, css, TemplateResult } from 'lit';
import { property, customElement, state } from 'lit/decorators';
import { HomeAssistant, LovelaceCardEditor, fireEvent, navigate as haNavigate } from 'custom-card-helpers';
import { HassEntity } from 'home-assistant-js-websocket';
import { getLovelace } from './helpers';

type JsonObject = Record<string, unknown>;

type CommandOption = {
  value: string;
  group: string;
  label: string;
  service: string;
  serviceEntity?: string;
  target?: JsonObject;
};

type NavigationTarget = {
  path: string;
  label: string;
};

type Floor3dPosterActionCardConfig = {
  type: string;
  name?: string;
  secondary?: string;
  image?: string;
  image_fit?: 'cover' | 'contain';
  aspect_ratio?: string;
  icon?: string;
  service?: string;
  service_entity?: string;
  service_data?: JsonObject;
  target?: JsonObject;
  navigation_path?: string;
  navigation_delay_ms?: number;
  disabled?: boolean;
};

const CARD_TYPE = 'custom:floor3d-poster-action-card';
const DEFAULT_DELAY_MS = 300;
const ENTITY_COMMAND_DOMAINS = ['script', 'automation', 'scene', 'button', 'input_button'];
const SERVICE_COMMAND_DOMAINS = ['rest_command'];
const MANUAL_VALUE = '__manual__';

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'floor3d-poster-action-card',
  name: 'Floor3D Poster Action Card',
  preview: true,
  description: 'Poster button that runs a Home Assistant command and then navigates',
});

function entityDomain(entityId?: string): string {
  return String(entityId || '').split('.')[0] || '';
}

function defaultServiceForEntity(entityId?: string): string {
  switch (entityDomain(entityId)) {
    case 'script':
      return 'script.turn_on';
    case 'automation':
      return 'automation.trigger';
    case 'scene':
      return 'scene.turn_on';
    case 'button':
      return 'button.press';
    case 'input_button':
      return 'input_button.press';
    default:
      return entityId ? 'homeassistant.turn_on' : '';
  }
}

function humanize(value: string): string {
  return value
    .replace(/^rest_command\./, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function hasKeys(value?: JsonObject): boolean {
  return !!value && Object.keys(value).length > 0;
}

function normalizeNavigationPath(path?: string): string {
  const value = String(path || '').trim();
  if (!value) {
    return '';
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function dashboardBasePath(hass?: HomeAssistant): string {
  const panelUrl = normalizeNavigationPath((hass as any)?.panelUrl || '');
  if (panelUrl && panelUrl != '/') {
    return panelUrl.replace(/\/$/, '');
  }

  const firstPathPart = window.location.pathname.split('/').filter(Boolean)[0];
  return firstPathPart ? `/${firstPathPart}` : '/lovelace';
}

function addNavigationTarget(targets: NavigationTarget[], path: string, label: string): void {
  const normalized = normalizeNavigationPath(path);
  if (!normalized || targets.some((target) => target.path == normalized)) {
    return;
  }
  targets.push({ path: normalized, label });
}

@customElement('floor3d-poster-action-card')
export class Floor3dPosterActionCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config!: Floor3dPosterActionCardConfig;
  @state() private _running = false;
  @state() private _error = '';

  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('floor3d-poster-action-card-editor') as LovelaceCardEditor;
  }

  public static getStubConfig(): Floor3dPosterActionCardConfig {
    return {
      type: CARD_TYPE,
      name: 'Movie',
      image_fit: 'cover',
      aspect_ratio: '2 / 3',
      navigation_delay_ms: DEFAULT_DELAY_MS,
    };
  }

  public setConfig(config: Floor3dPosterActionCardConfig): void {
    if (!config) {
      throw new Error('Invalid Floor3D poster action card configuration.');
    }
    this._config = {
      ...Floor3dPosterActionCard.getStubConfig(),
      ...config,
      type: CARD_TYPE,
    };
  }

  public getCardSize(): number {
    return 3;
  }

  protected render(): TemplateResult {
    if (!this._config) {
      return html``;
    }

    const name = this._config.name || this._config.service_entity || this._config.service || 'Poster action';
    const image = this._config.image || '';
    const fit = this._config.image_fit || 'cover';
    const aspectRatio = String(this._config.aspect_ratio || '2 / 3').replace(':', ' / ');
    const secondary = this._secondaryText();

    return html`
      <ha-card
        class=${this._config.disabled || this._running ? 'disabled' : ''}
        style=${`--poster-ratio:${aspectRatio};--poster-fit:${fit};`}
        tabindex=${this._config.disabled ? '-1' : '0'}
        role="button"
        aria-label=${name}
        @click=${this._handleTap}
        @keydown=${this._handleKeydown}
      >
        <div class="poster">
          ${image
            ? html`<img src=${image} alt=${name} />`
            : html`<div class="placeholder"><ha-icon .icon=${this._config.icon || 'mdi:movie-open'}></ha-icon></div>`}
          <div class="shade"></div>
          <div class="caption">
            <div class="name">${name}</div>
            ${secondary ? html`<div class=${this._error ? 'secondary error' : 'secondary'}>${secondary}</div>` : ''}
          </div>
        </div>
      </ha-card>
    `;
  }

  private _secondaryText(): string {
    if (this._running) {
      return 'Running...';
    }
    if (this._error) {
      return this._error;
    }
    if (this._config.secondary !== undefined) {
      return this._config.secondary;
    }
    if (this._config.navigation_path) {
      return 'Tap to start';
    }
    return '';
  }

  private async _run(): Promise<void> {
    if (!this.hass || this._config.disabled || this._running) {
      return;
    }

    this._running = true;
    this._error = '';
    try {
      await this._callConfiguredService();
      const path = normalizeNavigationPath(this._config.navigation_path);
      if (path) {
        const delay = Number(this._config.navigation_delay_ms ?? DEFAULT_DELAY_MS);
        if (delay > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
        haNavigate(this, path);
      }
    } catch (error: any) {
      this._error = error?.message || 'Action failed';
      console.error('Floor3D poster action failed:', error);
    } finally {
      this._running = false;
    }
  }

  private async _callConfiguredService(): Promise<void> {
    const service = this._config.service || defaultServiceForEntity(this._config.service_entity);
    if (!service) {
      return;
    }

    const [domain, serviceName] = service.split('.', 2);
    if (!domain || !serviceName) {
      throw new Error(`Invalid service: ${service}`);
    }

    const serviceData = { ...(this._config.service_data || {}) };
    const target = hasKeys(this._config.target)
      ? this._config.target
      : this._config.service_entity
        ? { entity_id: this._config.service_entity }
        : undefined;

    await this.hass?.callService(domain, serviceName, serviceData, target);
  }

  private _handleTap(ev: Event): void {
    ev.stopPropagation();
    this._run();
  }

  private _handleKeydown(ev: KeyboardEvent): void {
    if (ev.key != 'Enter' && ev.key != ' ') {
      return;
    }
    ev.preventDefault();
    this._run();
  }

  static get styles() {
    return css`
      :host {
        display: block;
      }

      ha-card {
        overflow: hidden;
        cursor: pointer;
        outline: none;
        user-select: none;
      }

      ha-card:focus-visible {
        box-shadow: 0 0 0 2px var(--primary-color);
      }

      ha-card.disabled {
        opacity: 0.68;
        cursor: default;
      }

      .poster {
        position: relative;
        aspect-ratio: var(--poster-ratio);
        min-height: 150px;
        background: var(--secondary-background-color);
      }

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: var(--poster-fit);
        background: #101418;
      }

      .placeholder {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: var(--secondary-text-color);
        background: linear-gradient(145deg, #171d23, #2a3038);
      }

      .placeholder ha-icon {
        --mdc-icon-size: 48px;
      }

      .shade {
        position: absolute;
        inset: auto 0 0;
        height: 42%;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0));
        pointer-events: none;
      }

      .caption {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 28px 12px 12px;
        color: white;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
      }

      .name {
        font-size: 15px;
        font-weight: 600;
        line-height: 19px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .secondary {
        margin-top: 2px;
        font-size: 12px;
        line-height: 16px;
        opacity: 0.86;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .error {
        color: #ffb4ab;
      }
    `;
  }
}

@customElement('floor3d-poster-action-card-editor')
export class Floor3dPosterActionCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config: Floor3dPosterActionCardConfig = Floor3dPosterActionCard.getStubConfig();
  @state() private _serviceDataError = '';
  @state() private _targetError = '';
  @state() private _imageError = '';

  public setConfig(config: Floor3dPosterActionCardConfig): void {
    this._config = {
      ...Floor3dPosterActionCard.getStubConfig(),
      ...config,
      type: CARD_TYPE,
    };
  }

  protected render(): TemplateResult {
    const commandOptions = this._commandOptions();
    const navigationTargets = this._navigationTargets();
    const serviceDataText = JSON.stringify(this._config.service_data || {}, null, 2);
    const targetText = JSON.stringify(this._config.target || {}, null, 2);

    return html`
      <div class="editor">
        <label>Name</label>
        <input .value=${this._config.name || ''} @input=${(ev: Event) => this._update({ name: this._value(ev) })} />

        <label>Poster image</label>
        <input
          .value=${this._config.image || ''}
          placeholder="/local/posters/movie.jpg"
          @input=${(ev: Event) => this._update({ image: this._value(ev) })}
        />
        <input type="file" accept="image/*" @change=${this._imageSelected} />
        ${this._imageError ? html`<div class="error">${this._imageError}</div>` : ''}
        ${this._config.image
          ? html`
              <div class="preview">
                <img src=${this._config.image} alt="Poster preview" />
                <button type="button" @click=${() => this._update({ image: '' })}>Clear image</button>
              </div>
            `
          : ''}

        <div class="row">
          <div>
            <label>Image fit</label>
            <select
              .value=${this._config.image_fit || 'cover'}
              @change=${(ev: Event) => this._update({ image_fit: this._value(ev) as 'cover' | 'contain' })}
            >
              <option value="cover">Cover</option>
              <option value="contain">Contain</option>
            </select>
          </div>
          <div>
            <label>Aspect ratio</label>
            <input
              .value=${this._config.aspect_ratio || '2 / 3'}
              placeholder="2 / 3"
              @input=${(ev: Event) => this._update({ aspect_ratio: this._value(ev) })}
            />
          </div>
        </div>

        <label>Command to run</label>
        <select .value=${this._commandValue(commandOptions)} @change=${this._commandChanged}>
          <option value="">No command</option>
          ${this._renderCommandGroups(commandOptions)}
          <option value=${MANUAL_VALUE}>Manual service</option>
        </select>

        <label>Service</label>
        <input
          .value=${this._config.service || ''}
          placeholder="rest_command.start_movie"
          @input=${(ev: Event) => this._update({ service: this._value(ev), service_entity: '' })}
        />

        <label>Service data JSON</label>
        <textarea
          class=${this._serviceDataError ? 'invalid' : ''}
          .value=${serviceDataText}
          @input=${(ev: Event) => this._jsonChanged('service_data', ev)}
        ></textarea>
        ${this._serviceDataError ? html`<div class="error">${this._serviceDataError}</div>` : ''}

        <label>Target JSON</label>
        <textarea
          class=${this._targetError ? 'invalid' : ''}
          .value=${targetText}
          @input=${(ev: Event) => this._jsonChanged('target', ev)}
        ></textarea>
        ${this._targetError ? html`<div class="error">${this._targetError}</div>` : ''}

        <label>Navigate after command</label>
        <select .value=${this._navigationValue(navigationTargets)} @change=${this._navigationChanged}>
          <option value="">No navigation</option>
          ${navigationTargets.map((target) => html`<option value=${target.path}>${target.label} - ${target.path}</option>`)}
          <option value=${MANUAL_VALUE}>Manual path</option>
        </select>

        <label>Manual navigation path</label>
        <input
          .value=${this._config.navigation_path || ''}
          placeholder="/3d-testing/office-floorplan"
          @input=${(ev: Event) => this._update({ navigation_path: this._value(ev) })}
        />

        <label>Delay before navigate (ms)</label>
        <input
          type="number"
          min="0"
          step="50"
          .value=${String(this._config.navigation_delay_ms ?? DEFAULT_DELAY_MS)}
          @input=${(ev: Event) => this._update({ navigation_delay_ms: Number(this._value(ev)) })}
        />

        <label>Secondary text</label>
        <input .value=${this._config.secondary || ''} @input=${(ev: Event) => this._update({ secondary: this._value(ev) })} />
      </div>
    `;
  }

  private _value(ev: Event): string {
    return String((ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || '');
  }

  private _update(changes: Partial<Floor3dPosterActionCardConfig>): void {
    this._config = { ...this._config, ...changes, type: CARD_TYPE };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _commandValue(options: CommandOption[]): string {
    const value = this._config.service_entity
      ? `entity:${this._config.service_entity}`
      : this._config.service
        ? `service:${this._config.service}`
        : '';
    if (!value || options.some((option) => option.value == value)) {
      return value;
    }
    return MANUAL_VALUE;
  }

  private _commandChanged(ev: Event): void {
    const value = this._value(ev);
    if (!value) {
      this._update({ service: '', service_entity: '', target: {} });
      return;
    }
    if (value == MANUAL_VALUE) {
      this._update({ service_entity: '' });
      return;
    }

    const option = this._commandOptions().find((candidate) => candidate.value == value);
    if (!option) {
      return;
    }

    const changes: Partial<Floor3dPosterActionCardConfig> = {
      service: option.service,
      service_entity: option.serviceEntity || '',
      target: option.target || {},
    };
    if (!this._config.name) {
      changes.name = option.label;
    }
    this._update(changes);
  }

  private _navigationValue(targets: NavigationTarget[]): string {
    const path = normalizeNavigationPath(this._config.navigation_path);
    if (!path || targets.some((target) => target.path == path)) {
      return path;
    }
    return MANUAL_VALUE;
  }

  private _navigationChanged(ev: Event): void {
    const value = this._value(ev);
    if (value == MANUAL_VALUE) {
      return;
    }
    this._update({ navigation_path: value });
  }

  private _jsonChanged(key: 'service_data' | 'target', ev: Event): void {
    try {
      const value = JSON.parse(this._value(ev) || '{}');
      if (!value || typeof value != 'object' || Array.isArray(value)) {
        throw new Error('JSON must be an object.');
      }
      if (key == 'service_data') {
        this._serviceDataError = '';
        this._update({ service_data: value });
      } else {
        this._targetError = '';
        this._update({ target: value });
      }
    } catch (error: any) {
      if (key == 'service_data') {
        this._serviceDataError = error?.message || 'Invalid JSON';
      } else {
        this._targetError = error?.message || 'Invalid JSON';
      }
    }
  }

  private _imageSelected(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      this._imageError = 'Choose an image file.';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this._imageError = '';
      this._update({ image: String(reader.result || '') });
    };
    reader.onerror = () => {
      this._imageError = 'Image upload failed.';
    };
    reader.readAsDataURL(file);
  }

  private _commandOptions(): CommandOption[] {
    if (!this.hass) {
      return [];
    }

    const options: CommandOption[] = [];
    for (const domain of SERVICE_COMMAND_DOMAINS) {
      const services = (this.hass.services as any)?.[domain] || {};
      for (const service of Object.keys(services).sort()) {
        const serviceInfo = services[service] || {};
        const label = serviceInfo.name || humanize(service);
        options.push({
          value: `service:${domain}.${service}`,
          group: domain == 'rest_command' ? 'REST commands' : humanize(domain),
          label,
          service: `${domain}.${service}`,
        });
      }
    }

    for (const entity of Object.values(this.hass.states)) {
      const domain = entityDomain(entity.entity_id);
      if (!ENTITY_COMMAND_DOMAINS.includes(domain)) {
        continue;
      }
      options.push(this._entityCommandOption(entity, domain));
    }

    return options.sort((a, b) => `${a.group} ${a.label}`.localeCompare(`${b.group} ${b.label}`));
  }

  private _entityCommandOption(entity: HassEntity, domain: string): CommandOption {
    return {
      value: `entity:${entity.entity_id}`,
      group: humanize(domain),
      label: String(entity.attributes.friendly_name || entity.entity_id),
      service: defaultServiceForEntity(entity.entity_id),
      serviceEntity: entity.entity_id,
      target: { entity_id: entity.entity_id },
    };
  }

  private _renderCommandGroups(options: CommandOption[]): TemplateResult[] {
    const groups = [...new Set(options.map((option) => option.group))];
    return groups.map(
      (group) => html`
        <optgroup label=${group}>
          ${options
            .filter((option) => option.group == group)
            .map((option) => html`<option value=${option.value}>${option.label}</option>`)}
        </optgroup>
      `
    );
  }

  private _navigationTargets(): NavigationTarget[] {
    const targets: NavigationTarget[] = [];
    const basePath = dashboardBasePath(this.hass);
    const lovelace = getLovelace() as any;
    const views = lovelace?.config?.views || [];

    views.forEach((view: any, index: number) => {
      const viewPath = view.path || String(index);
      addNavigationTarget(targets, `${basePath}/${viewPath}`, view.title || `View ${index + 1}`);
    });

    for (const [key, panel] of Object.entries((this.hass as any)?.panels || {})) {
      const panelConfig = panel as any;
      const urlPath = panelConfig.url_path || key;
      const title = panelConfig.title || humanize(urlPath);
      const summary = `${urlPath} ${title} ${panelConfig.component_name || ''}`;
      if (/lovelace|dashboard|floorplan|map|remote|source|theater|theatre/i.test(summary)) {
        addNavigationTarget(targets, `/${urlPath}`, title);
      }
    }

    if (this._config.navigation_path) {
      addNavigationTarget(targets, this._config.navigation_path, 'Configured path');
    }

    return targets.sort((a, b) => a.label.localeCompare(b.label));
  }

  static get styles() {
    return css`
      .editor {
        display: grid;
        gap: 8px;
      }

      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
      }

      label {
        color: var(--secondary-text-color);
        font-size: 12px;
        font-weight: 500;
        margin-top: 8px;
      }

      input,
      select,
      textarea,
      button {
        width: 100%;
        box-sizing: border-box;
        color: var(--primary-text-color);
        background: var(--secondary-background-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
        padding: 10px;
        font: inherit;
      }

      input[type='file'] {
        padding: 8px;
      }

      textarea {
        min-height: 82px;
        font-family: var(--code-font-family, monospace);
        font-size: 12px;
      }

      button {
        cursor: pointer;
      }

      .preview {
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr);
        gap: 10px;
        align-items: center;
      }

      .preview img {
        width: 64px;
        aspect-ratio: 2 / 3;
        object-fit: cover;
        border-radius: 6px;
        background: #101418;
      }

      .invalid {
        border-color: var(--error-color);
      }

      .error {
        color: var(--error-color);
        font-size: 12px;
      }
    `;
  }
}
