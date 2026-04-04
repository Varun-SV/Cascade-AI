// ─────────────────────────────────────────────
//  Cascade AI — Interactive Models Display
// ─────────────────────────────────────────────

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { ModelInfo, ProviderType } from '../../../types.js';

interface Props {
  providers: ProviderType[];
  modelsByProvider: Map<ProviderType, ModelInfo[]>;
  onClose: () => void;
}

export const ModelsDisplay: React.FC<Props> = ({ providers, modelsByProvider, onClose }) => {
  const [selectedProvider, setSelectedProvider] = useState<ProviderType | null>(null);

  useInput((_input, key) => {
    if (key.escape) {
      if (selectedProvider) {
        setSelectedProvider(null);
      } else {
        onClose();
      }
    }
  });

  const providerItems = providers.map((p) => ({ label: p, value: p }));
  const modelItems = selectedProvider 
    ? (modelsByProvider.get(selectedProvider) ?? [])
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => ({ 
          label: `${m.id.padEnd(24)} — ${m.name}`, 
          value: m.id 
        }))
    : [];

  if (!selectedProvider) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">◈ SELECT PROVIDER</Text>
          <Text color="muted"> (ESC to Exit)</Text>
        </Box>
        <SelectInput 
          items={providerItems} 
          onSelect={(item) => setSelectedProvider(item.value as ProviderType)} 
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="green">◈ {selectedProvider.toUpperCase()} — MODELS</Text>
        <Text color="muted">[ESC to Back]</Text>
      </Box>
      {modelItems.length === 0 ? (
        <Text italic color="yellow">No supported models discovered for this provider.</Text>
      ) : (
        <SelectInput 
          items={modelItems} 
          limit={10}
          onSelect={() => {}} // Could potentially show details here
        />
      )}
    </Box>
  );
};
