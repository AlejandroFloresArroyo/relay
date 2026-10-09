import type { ModelOption } from '../../../protocol/protocol.ts';

export function filterModelOptions(models: readonly ModelOption[], query: string, provider: string | null): ModelOption[] {
  const term = query.trim().toLowerCase();
  return models.filter((option) => (provider === null || option.provider === provider)
    && (!term || option.label.toLowerCase().includes(term) || option.model.toLowerCase().includes(term)));
}
