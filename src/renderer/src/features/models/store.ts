import { fetchModels } from '@/shared/lib/api'
import { createScopedDataStore } from '../../app/stores/data-store'
import type { ModelsPayload } from '../../../../shared/schemas/models.js'

/** Models payload, scope-keyed and refresh-tick subscribed. (ADR 0011) */
export const useModelsStore = createScopedDataStore<ModelsPayload>(fetchModels)
