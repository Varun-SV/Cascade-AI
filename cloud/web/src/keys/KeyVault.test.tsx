import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import KeyVault from './KeyVault.js';

describe('KeyVault', () => {
  it('shows the empty state and no privacy-copy tricks when there are no keys', () => {
    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} />);
    expect(screen.getByText(/never stores them on our servers/i)).toBeInTheDocument();
    expect(screen.getByText(/no providers configured yet/i)).toBeInTheDocument();
  });

  it('omits blank optional fields instead of saving them as empty strings', () => {
    const onChange = vi.fn();
    render(<KeyVault keys={[]} onChange={onChange} webSearch={null} onWebSearchChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Add provider'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'openai-compatible' } });
    fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: 'http://127.0.0.1:9999/v1' } });
    // apiKey and model fields are left blank on purpose.
    fireEvent.click(screen.getByText('Save'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0][0];
    expect(saved).toEqual([{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1' }]);
    expect(saved[0]).not.toHaveProperty('apiKey');
    expect(saved[0]).not.toHaveProperty('model');
  });

  it('trims whitespace-only input to omitted rather than a blank string', () => {
    const onChange = vi.fn();
    render(<KeyVault keys={[]} onChange={onChange} webSearch={null} onWebSearchChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Add provider'));
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));

    const saved = onChange.mock.calls[0][0];
    expect(saved[0]).not.toHaveProperty('apiKey');
  });

  it('lists an existing key and removes it on click', () => {
    const onChange = vi.fn();
    render(
      <KeyVault
        keys={[{ type: 'anthropic', apiKey: 'sk-ant-existing' }]}
        onChange={onChange} webSearch={null} onWebSearchChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Anthropic (Claude)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/remove anthropic/i));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('offers GitHub Models with an API key field but no base URL field', () => {
    const onChange = vi.fn();
    render(<KeyVault keys={[]} onChange={onChange} webSearch={null} onWebSearchChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Add provider'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'github-models' } });
    // Fixed endpoint (models.github.ai) — unlike azure/openai-compatible, no
    // base URL field should render for this provider.
    expect(screen.queryByPlaceholderText('https://...')).not.toBeInTheDocument();
    // Fine-grained PATs (github_pat_...), not classic tokens (ghp_...) — the
    // API requires the "models: read" permission, which only fine-grained
    // PATs can scope.
    fireEvent.change(screen.getByPlaceholderText('github_pat_... (fine-grained, "models: read")'), { target: { value: 'github_pat_test123' } });
    fireEvent.click(screen.getByText('Save'));

    expect(onChange).toHaveBeenCalledWith([{ type: 'github-models', apiKey: 'github_pat_test123' }]);
  });

  it('does not offer a Model field for GitHub Models, since nothing in the SDK reads ProviderConfig.model for it', () => {
    // Regression (Codex P2): ProviderConfig.model is only ever consumed by
    // Azure's azureModelForDeployment() (resolving an opaque deployment name
    // to its base model for benchmark/pricing) — no other provider, including
    // github-models, translates it into an actual model selection anywhere in
    // buildCloudConfig() or the SDK. Offering the field here would silently
    // lie: entering "openai/gpt-4o" leaves routing on Auto and may pick a
    // different catalog model. Only render it for providers that act on it.
    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Add provider'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'github-models' } });
    expect(screen.queryByText(/model \(optional/i)).not.toBeInTheDocument();
  });

  it('hides account sync when signed out (no sync enabled)', () => {
    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} />);
    expect(screen.queryByText(/sync your keys across/i)).not.toBeInTheDocument();
  });

  it('shows account sync for a signed-in user', () => {
    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} syncEnabled={true} />);
    expect(screen.getByText(/sync your keys across/i)).toBeInTheDocument();
  });
});
