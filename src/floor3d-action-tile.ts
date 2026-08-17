import { LitElement, html, css, TemplateResult } from 'lit';
import { property, customElement, state } from 'lit/decorators';
import { HomeAssistant, fireEvent, navigate as haNavigate, toggleEntity } from 'custom-card-helpers';
import { HassEntity } from 'home-assistant-js-websocket';

type TileAction = {
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
  actions?: TileAction[];
  sequence?: TileAction[];
};

type Floor3dActionTileConfig = {
  type: string;
  entity?: string;
  name?: string;
  icon?: string;
  secondary?: string;
  color?: string;
  show_state?: boolean;
  disabled?: boolean;
  tap_action?: TileAction;
  tap_actions?: TileAction[];
  hold_action?: TileAction;
  hold_actions?: TileAction[];
  double_tap_action?: TileAction;
  double_tap_actions?: TileAction[];
};

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'floor3d-action-tile',
  name: 'Floor3D Action Tile',
  preview: true,
  description: 'A tile-style card that can run multiple Home Assistant actions in sequence',
});

@customElement('floor3d-action-tile')
export class Floor3dActionTile extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config!: Floor3dActionTileConfig;
  private _holdTimer?: number;
  private _holdFired = false;

  public setConfig(config: Floor3dActionTileConfig): void {
    if (!config) {
      throw new Error('Invalid Floor3D action tile configuration.');
    }
    this._config = config;
  }

  public getCardSize(): number {
    return 1;
  }

  protected render(): TemplateResult {
    if (!this._config) {
      return html``;
    }

    const stateObj = this._stateObj();
    const name = this._config.name || stateObj?.attributes.friendly_name || this._config.entity || 'Action';
    const icon = this._config.icon || stateObj?.attributes.icon || 'mdi:gesture-tap-button';
    const secondary = this._secondaryText(stateObj);
    const color = this._config.color || 'var(--state-icon-color, var(--secondary-text-color))';

    return html`
      <ha-card
        class=${this._config.disabled ? 'disabled' : ''}
        tabindex=${this._config.disabled ? '-1' : '0'}
        role="button"
        @click=${this._handleTap}
        @dblclick=${this._handleDoubleTap}
        @keydown=${this._handleKeydown}
        @pointerdown=${this._handlePointerDown}
        @pointerup=${this._clearHoldTimer}
        @pointercancel=${this._clearHoldTimer}
        @pointerleave=${this._clearHoldTimer}
        @contextmenu=${this._handleContextMenu}
      >
        <div class="icon" style=${`--tile-color:${color}`}>
          <ha-icon .icon=${icon}></ha-icon>
        </div>
        <div class="text">
          <div class="primary">${name}</div>
          ${secondary ? html`<div class="secondary">${secondary}</div>` : ''}
        </div>
      </ha-card>
    `;
  }

  private _stateObj(): HassEntity | undefined {
    return this._config.entity && this.hass ? this.hass.states[this._config.entity] : undefined;
  }

  private _secondaryText(stateObj?: HassEntity): string {
    if (this._config.secondary !== undefined) {
      return this._config.secondary;
    }
    if (this._config.show_state === false || !stateObj) {
      return '';
    }
    const unit = stateObj.attributes.unit_of_measurement ? ` ${stateObj.attributes.unit_of_measurement}` : '';
    return `${stateObj.state}${unit}`;
  }

  private _actionsFor(kind: 'tap' | 'hold' | 'double_tap'): TileAction[] {
    const pluralKey = `${kind}_actions` as keyof Floor3dActionTileConfig;
    const singleKey = `${kind}_action` as keyof Floor3dActionTileConfig;
    const plural = this._config[pluralKey];
    if (Array.isArray(plural)) {
      return plural;
    }

    const single = this._config[singleKey] as TileAction | undefined;
    if (single?.action == 'sequence') {
      return single.actions || single.sequence || [];
    }
    if (single) {
      return [single];
    }
    if (kind == 'tap' && this._config.entity) {
      return [{ action: 'more-info' }];
    }
    return [];
  }

  private async _run(kind: 'tap' | 'hold' | 'double_tap'): Promise<void> {
    if (this._config.disabled || !this.hass) {
      return;
    }

    const actions = this._actionsFor(kind);
    for (const action of actions) {
      await this._runAction(action);
    }
  }

  private async _runAction(action: TileAction): Promise<void> {
    const actionType = action.action || 'none';
    switch (actionType) {
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
        throw new Error(`Unsupported Floor3D action tile action: ${actionType}`);
    }
  }

  private async _callService(action: TileAction): Promise<void> {
    if (!this.hass || !action.service) {
      return;
    }

    const [domain, service] = action.service.split('.', 2);
    if (!domain || !service) {
      throw new Error(`Invalid service: ${action.service}`);
    }

    const serviceData = { ...(action.service_data || action.data || {}) };
    const entityId = action.entity_id || action.entity;
    if (entityId && serviceData.entity_id === undefined) {
      serviceData.entity_id = entityId;
    }
    await this.hass.callService(domain, service, serviceData, action.target);
  }

  private _handleTap(ev: Event): void {
    ev.stopPropagation();
    if (this._holdFired) {
      this._holdFired = false;
      return;
    }
    this._run('tap').catch((error) => console.error('Floor3D action tile tap failed:', error));
  }

  private _handleDoubleTap(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    const actions = this._actionsFor('double_tap');
    if (actions.length) {
      this._run('double_tap').catch((error) => console.error('Floor3D action tile double tap failed:', error));
    }
  }

  private _handlePointerDown(): void {
    this._clearHoldTimer();
    if (!this._actionsFor('hold').length) {
      return;
    }
    this._holdTimer = window.setTimeout(() => {
      this._holdFired = true;
      this._run('hold').catch((error) => console.error('Floor3D action tile hold failed:', error));
    }, 650);
  }

  private _clearHoldTimer(): void {
    if (this._holdTimer) {
      window.clearTimeout(this._holdTimer);
      this._holdTimer = undefined;
    }
  }

  private _handleContextMenu(ev: Event): void {
    if (this._actionsFor('hold').length) {
      ev.preventDefault();
      this._run('hold').catch((error) => console.error('Floor3D action tile context action failed:', error));
    }
  }

  private _handleKeydown(ev: KeyboardEvent): void {
    if (ev.key != 'Enter' && ev.key != ' ') {
      return;
    }
    ev.preventDefault();
    this._run('tap').catch((error) => console.error('Floor3D action tile keyboard tap failed:', error));
  }

  static get styles() {
    return css`
      :host {
        display: block;
      }

      ha-card {
        min-height: 64px;
        padding: 12px 16px;
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr);
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
        opacity: 0.45;
        cursor: default;
        pointer-events: none;
      }

      .icon {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        color: var(--tile-color);
        background: color-mix(in srgb, var(--tile-color) 18%, transparent);
      }

      ha-icon {
        --mdc-icon-size: 22px;
      }

      .text {
        min-width: 0;
      }

      .primary {
        color: var(--primary-text-color);
        font-weight: 500;
        line-height: 20px;
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
