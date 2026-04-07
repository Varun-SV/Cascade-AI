// ─────────────────────────────────────────────
//  Cascade AI — Approval Prompt
// ─────────────────────────────────────────────

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, Theme } from '../../../types.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  theme: Theme;
  onDecision: (decision: { approved: boolean; always: boolean }) => void;
}

export function ApprovalPrompt({ request, theme, onDecision }: ApprovalPromptProps): React.ReactElement {
  const [decided, setDecided] = useState(false);

  useInput((input, key) => {
    if (decided) return;
    if (input === 'a' || input === 'A') {
      setDecided(true);
      onDecision({ approved: true, always: true });
    } else if (input === 'y' || input === 'Y') {
      setDecided(true);
      onDecision({ approved: true, always: false });
    } else if (input === 'n' || input === 'N' || key.escape) {
      setDecided(true);
      onDecision({ approved: false, always: false });
    }
  });

  const borderColor = request.isDangerous ? theme.colors.error : theme.colors.warning;
  const icon = request.isDangerous ? '⚠' : '?';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text color={borderColor} bold>{icon} Approval Required</Text>
      <Text color={theme.colors.muted}>Agent: {request.tierId}</Text>
      <Text color={theme.colors.foreground} bold>Tool: {request.toolName}</Text>
      <Box marginTop={1} height={4}>
        <Text color={theme.colors.muted}>Input: </Text>
        <Text>{JSON.stringify(request.input, null, 2).slice(0, 200).split('\n').slice(0, 4).join('\n')}</Text>
      </Box>
      <Box marginTop={1}>
        {!decided ? (
          <Text>
            <Text color={theme.colors.success} bold>[a]</Text>
            <Text color={theme.colors.muted}> Allow Always  </Text>
            <Text color={theme.colors.success} bold>[y]</Text>
            <Text color={theme.colors.muted}> Allow  </Text>
            <Text color={theme.colors.error} bold>[n]</Text>
            <Text color={theme.colors.muted}> Deny  </Text>
            <Text color={theme.colors.muted}>[Esc] Deny</Text>
          </Text>
        ) : (
          <Text color={theme.colors.muted}>Responding...</Text>
        )}
      </Box>
    </Box>
  );
}
