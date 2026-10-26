import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { PluginMetadata } from './plugin-persistence.model';
import { upsertPluginMetadata, deletePluginMetadata } from './store/plugin.actions';
import { selectPluginMetadataFeatureState } from './store/plugin-metadata.reducer';
import {
  FLOW_OS_DEFAULT_ENABLED_PLUGINS,
  IS_FLOW_OS_HOST,
} from '../core/flow-os-host/flow-os-host';

/**
 * Service for persisting plugin metadata using NgRx actions.
 * Handles plugin management information like enabled state.
 */
@Injectable({
  providedIn: 'root',
})
export class PluginMetaPersistenceService {
  private _store = inject(Store);

  /**
   * Set plugin enabled/disabled status
   */
  async setPluginEnabled(pluginId: string, isEnabled: boolean): Promise<void> {
    const pluginMetadata: PluginMetadata = { id: pluginId, isEnabled };

    this._store.dispatch(upsertPluginMetadata({ pluginMetadata }));
  }

  /**
   * Check if plugin is enabled
   */
  async isPluginEnabled(pluginId: string): Promise<boolean> {
    const currentState = await firstValueFrom(
      this._store.select(selectPluginMetadataFeatureState),
    );
    const pluginMetadata = currentState.find((item) => item.id === pluginId);

    // Default to false for all plugins that haven't been explicitly enabled
    // This ensures plugins start disabled and must be manually enabled by the user.
    // Flow OS fork: inside Flowstate, Exo AI and Google Calendar default to on;
    // once the user toggles one, its metadata decides.
    const isFlowOsDefault =
      IS_FLOW_OS_HOST && FLOW_OS_DEFAULT_ENABLED_PLUGINS.has(pluginId);
    return pluginMetadata?.isEnabled ?? isFlowOsDefault;
  }

  /**
   * Check if plugin has any persisted metadata (i.e., user has interacted with it before)
   */
  async hasPluginMetadata(pluginId: string): Promise<boolean> {
    const currentState = await firstValueFrom(
      this._store.select(selectPluginMetadataFeatureState),
    );
    return currentState.some((item) => item.id === pluginId);
  }

  /**
   * Get all plugin metadata
   */
  async getAllPluginMetadata(): Promise<PluginMetadata[]> {
    return firstValueFrom(this._store.select(selectPluginMetadataFeatureState));
  }

  /**
   * Remove plugin metadata
   */
  removePluginMetadata(pluginId: string): void {
    this._store.dispatch(deletePluginMetadata({ pluginId }));
  }
}
