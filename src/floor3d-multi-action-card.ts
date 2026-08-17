import { LitElement, html, css, TemplateResult } from 'lit';
import { property, customElement, state } from 'lit/decorators';
import { HomeAssistant, LovelaceCardEditor, fireEvent, navigate as haNavigate, toggleEntity } from 'custom-card-helpers';
import { HassEntity } from 'home-assistant-js-websocket';

type MultiAction = {
  action?: string;
  service?: string;
  service_data?: Record<string, unknown>;
  data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  entity?: string;
  entity_id?: string;
  navigation_path?: string;
  url_path?: string;
  delay?: number;
  ms?: number;
};

type Floor3dMultiActionCardConfig = {
  type: string;
  name?: string;
  icon?: string;
  entity?: string;
  service_entity?: string;
  service?: string;
  service_data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  navigation_path?: string;
  navigation_delay_ms?: number;
  secondary?: string;
  color?: string;
  show_state?: boolean;
  disabled?: boolean;
  actions?: MultiAction[];
};

const CARD_TYPE = 'custom:floor3d-multi-action-card';
const DEFAULT_DELAY_MS = 300;
const RUNNABLE_DOMAINS = ['script', 'automation', 'scene', 'button', 'input_button'];

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'floor3d-multi-action-card',
  name: 'Floor3D Multi Action Card',
  preview: true,
  description: 'Run a script, automation, or service, then navigate to another dashboard path',
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

function serviceActionFromConfig(config: Floor3dMultiActionCardConfig): MultiAction | null {
  const entityId = config.service_entity || (RUNNABLE_DOMAINS.includes(entityDomain(config.entity)) ? config.entity : '');
  const service = config.service || defaultServiceForEntity(entityId);
  if (!service) {
    return null;
  }

  const action: MultiAction = {
    action: 'call-service',
    service,
    service_data: { ...(config.service_data || {}) },
  };

  if (config.target) {
    action.target = config.target;
  } else if (entityId) {
    action.target = { entity_id: entityId };
  }

  return action;
}

function defaultActions(config: Floor3dMultiActionCardConfig): MultiAction[] {
  if (Array.isArray(config.actions) && config.actions.length) {
    return config.actions;
  }

  const actions: MultiAction[] = [];
  const serviceAction = serviceActionFromConfig(config);
  if (serviceAction) {
    actions.push(serviceAction);
  }

  if (config.navigation_path) {
    const delay = Number(config.navigation_delay_ms ?? DEFAULT_DELAY_MS);
    if (delay > 0 && actions.length) {
      actions.push({ action: 'delay', ms: delay });
    }
    actions.push({ action: 'navigate', navigation_path: config.navigation_path });
  }

  if (!actions.length && config.entity) {
    actions.push({ action: 'more-info', entity: config.entity });
  }

  return actions;
}

@customElement('floor3d-multi-action-card')
export class Floor3dMultiActionCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config!: Floor3dMultiActionCardConfig;
  @state() private _running = false;
  @state() private _error = '';

  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('floor3d-multi-action-card-editor') as LovelaceCardEditor;
  }

  public static getStubConfig(): Floor3dMultiActionCardConfig {
    return {
      type: CARD_TYPE,
      name: 'Source',
      icon: 'mdi:play-box',
      navigation_delay_ms: DEFAULT_DELAY_MS,
    };
  }

  public setConfig(config: Floor3dMultiActionCardConfig): void {
    if (!config) {
      throw new Error('Invalid Floor3D multi action card configuration.');
    }
    this._config = {
      type: CARD_TYPE,
      navigation_delay_ms: DEFAULT_DELAY_MS,
      ...config,
    };
  }

  public getCardSize(): number {
    return 1;
  }

  protected render(): TemplateResult {
    if (!this._config) {
      return html``;
    }

    const stateObj = this._stateObj();
    const name = this._config.name || stateObj?.attributes.friendly_name || this._config.service_entity || this._config.entity || 'Action';
    const icon = this._config.icon || stateObj?.attributes.icon || this._iconForAction();
    const secondary = this._secondaryText(stateObj);
    const color = this._config.color || 'var(--state-icon-color, var(--secondary-text-color))';

    return html`
      <ha-card
        class=${this._config.disabled || this._running ? 'disabled' : ''}
        tabindex=${this._config.disabled ? '-1' : '0'}
        role="button"
        @click=${this._handleTap}
        @keydown=${this._handleKeydown}
      >
        <div class="icon" style=${`--tile-color:${color}`}>
          <ha-icon .icon=${icon}></ha-icon>
        </div>
        <div class="text">
          <div class="primary">${name}</div>
          <div class="secondary">${secondary}</div>
        </div>
      </ha-card>
    `;
  }

  private _stateObj(): HassEntity | undefined {
    return this._config.entity && this.hass ? this.hass.states[this._config.entity] : undefined;
  }

  private _iconForAction(): string {
    switch (entityDomain(this._config.service_entity || this._config.entity)) {
      case 'automation':
        return 'mdi:robot';
      case 'script':
        return 'mdi:script-text-play';
      case 'scene':
        return 'mdi:palette';
      case 'button':
      case 'input_button':
        return 'mdi:button-pointer';
      default:
        return 'mdi:gesture-tap-button';
    }
  }

  private _secondaryText(stateObj?: HassEntity): string {
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
      return `Then go to ${this._config.navigation_path}`;
    }
    if (this._config.show_state !== false && stateObj) {
      const unit = stateObj.attributes.unit_of_measurement ? ` ${stateObj.attributes.unit_of_measurement}` : '';
      return `${stateObj.state}${unit}`;
    }
    return 'Tap to run';
  }

  private async _run(): Promise<void> {
    if (this._config.disabled || !this.hass || this._running) {
      return;
    }

    this._running = true;
    this._error = '';
    try {
      for (const action of defaultActions(this._config)) {
        await this._runAction(action);
      }
    } catch (error: any) {
      this._error = error?.message || 'Action failed';
      console.error('Floor3D multi action failed:', error);
    } finally {
      this._running = false;
    }
  }

  private async _runAction(action: MultiAction): Promise<void> {
    switch (action.action || 'none') {
      case 'none':
        return;
      case 'delay':
        await new Promise((resolve) => window.setTimeout(resolve, Number(action.delay ?? action.ms ?? 0)));
        return;
      case 'more-info':
        fireEvent(this, 'hass-more-info', { entityId: action.entity || action.entity_id || this._config.entity });
        return;
      case 'navigate':
        if (action.navigation_path) {
          haNavigate(this, action.navigation_path);
        }
        return;
      case 'url':
        if (action.url_path) {
          window.open(action.url_path);
        }
        return;
      case 'toggle':
        if (this.hass && (action.entity || action.entity_id || this._config.entity)) {
          await toggleEntity(this.hass, String(action.entity || action.entity_id || this._config.entity));
        }
        return;
      case 'call-service':
        await this._callService(action);
        return;
      case 'fire-dom-event':
        fireEvent(this, 'll-custom', action);
        return;
      default:
        throw new Error(`Unsupported action: ${action.action}`);
    }
  }

  private async _callService(action: MultiAction): Promise<void> {
    if (!this.hass || !action.service) {
      return;
    }

    const [domain, service] = action.service.split('.', 2);
    if (!domain || !service) {
      throw new Error(`Invalid service: ${action.service}`);
    }

    const serviceData = { ...(action.service_data || action.data || {}) };
    await this.hass.callService(domain, service, serviceData, action.target);
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
        min-height: 68px;
        padding: 12px 16px;
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        gap: 14px;
        align-items: center;
        cursor: pointer;
        user-select: none;
        outline: none;
      }

      ha-card:focus-visible {
        box-shadow: 0 0 0 2px var(--primary-color);
      }

      ha-card.disabled {
        opacity: 0.58;
        cursor: default;
      }

      .icon {
        width: 42px;
        height: 42px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        color: var(--tile-color);
        background: rgba(128, 128, 128, 0.16);
      }

      ha-icon {
        --mdc-icon-size: 23px;
      }

      .text {
        min-width: 0;
      }

      .primary {
        color: var(--primary-text-color);
        font-weight: 500;
        line-height: 21px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .secondary {
        color: var(--secondary-text-color);
        font-size: 13px;
        line-height: 18px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
  }
}

@customElement('floor3d-multi-action-card-editor')
export class Floor3dMultiActionCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config: Floor3dMultiActionCardConfig = Floor3dMultiActionCard.getStubConfig();
  @state() private _serviceDataError = '';
  @state() private _targetError = '';

  public setConfig(config: Floor3dMultiActionCardConfig): void {
    this._config = {
      type: CARD_TYPE,
      navigation_delay_ms: DEFAULT_DELAY_MS,
      ...config,
    };
  }

  protected render(): TemplateResult {
    const serviceDataText = JSON.stringify(this._config.service_data || {}, null, 2);
    const targetText = JSON.stringify(this._config.target || {}, null, 2);

    return html`
      <div class="editor">
        <label>Name</label>
        <input .value=${this._config.name || ''} @input=${(ev: Event) => this._update({ name: this._value(ev) })} />

        <label>Icon</label>
        <input
          .value=${this._config.icon || ''}
          placeholder="mdi:play-box"
          @input=${(ev: Event) => this._update({ icon: this._value(ev) })}
        />

        <label>Display entity</label>
        <input
          .value=${this._config.entity || ''}
          placeholder="media_player.video_wall"
          @input=${(ev: Event) => this._update({ entity: this._value(ev) })}
        />

        <label>Script / automation to run</label>
        <select .value=${this._config.service_entity || ''} @change=${this._serviceEntityChanged}>
          <option value="">Manual service or no action</option>
          ${this._runnableEntities().map(
            (entity) => html`
              <option value=${entity.entity_id}>
                ${entity.attributes.friendly_name || entity.entity_id} - ${entity.entity_id}
              </option>
            `
          )}
        </select>

        <label>Service</label>
        <input
          .value=${this._config.service || ''}
          placeholder="script.turn_on, automation.trigger, media_player.select_source"
          @input=${(ev: Event) => this._update({ service: this._value(ev) })}
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

        <label>Navigate after action</label>
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
      </div>
    `;
  }

  private _value(ev: Event): string {
    return String((ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || '');
  }

  private _update(changes: Partial<Floor3dMultiActionCardConfig>): void {
    this._config = { ...this._config, ...changes };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _serviceEntityChanged(ev: Event): void {
    const serviceEntity = this._value(ev);
    const changes: Partial<Floor3dMultiActionCardConfig> = {
      service_entity: serviceEntity,
      service: defaultServiceForEntity(serviceEntity),
      target: serviceEntity ? { entity_id: serviceEntity } : {},
    };
    if (serviceEntity && !this._config.name) {
      changes.name = this.hass?.states[serviceEntity]?.attributes.friendly_name || serviceEntity;
    }
    if (serviceEntity && !this._config.icon) {
      changes.icon = entityDomain(serviceEntity) == 'automation' ? 'mdi:robot' : 'mdi:script-text-play';
    }
    this._update(changes);
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

  private _runnableEntities(): HassEntity[] {
    if (!this.hass) {
      return [];
    }
    return Object.values(this.hass.states)
      .filter((entity) => RUNNABLE_DOMAINS.includes(entityDomain(entity.entity_id)))
      .sort((a, b) =>
        String(a.attributes.friendly_name || a.entity_id).localeCompare(String(b.attributes.friendly_name || b.entity_id))
      );
  }

  static get styles() {
    return css`
      .editor {
        display: grid;
        gap: 8px;
      }

      label {
        color: var(--secondary-text-color);
        font-size: 12px;
        font-weight: 500;
        margin-top: 8px;
      }

      input,
      select,
      textarea {
        width: 100%;
        box-sizing: border-box;
        color: var(--primary-text-color);
        background: var(--secondary-background-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
        padding: 10px;
        font: inherit;
      }

      textarea {
        min-height: 82px;
        font-family: var(--code-font-family, monospace);
        font-size: 12px;
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
