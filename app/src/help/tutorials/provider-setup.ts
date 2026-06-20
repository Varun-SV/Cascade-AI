import type { Step } from 'react-joyride';

export const VIDEO_ID = ''; // populate after HyperFrames render

export const steps: Step[] = [
  {
    target: '.activity-bar',
    content: 'Open Settings from the bottom of the Activity Bar to manage your API keys.',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '.status-bar',
    content: 'The status bar shows which model each tier is using. A grey dot means no provider is configured for that tier.',
    placement: 'top',
  },
  {
    target: '.model-picker',
    content: 'Use the Model Picker to select a provider and model. Cascade Auto will override this per-subtask when enabled.',
    placement: 'bottom',
  },
];

export const docs = `
# Provider Setup

Cascade AI supports multiple LLM providers. You can configure them in Settings.

## Supported Providers

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4.6, Opus 4.8, Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, Gemini 2.0 Pro |

## Adding an API Key

1. Click the Settings icon at the bottom of the Activity Bar.
2. Navigate to **Providers**.
3. Enter your API key for each provider you want to enable.
4. Click **Save**.

## Cascade Auto Mode

When \`cascadeAuto: true\` is set in your config, Cascade automatically routes each
T2 and T3 agent to the best-fit model for its task type (coding, writing, analysis, etc.).
You don't need to pick a model manually — just configure at least one provider.

## Fallback Behaviour

If a provider API call fails, Cascade falls back to the next configured provider
automatically. Set \`fallbackOrder\` in your config to control the priority.
`;
