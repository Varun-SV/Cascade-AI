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

  it('hides Drive sync by default (non-Google users, or no client id configured)', () => {
    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} />);
    expect(screen.queryByText(/sync your keys across devices/i)).not.toBeInTheDocument();

    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} driveSyncEnabled={true} googleClientId={null} />);
    expect(screen.queryByText(/sync your keys across devices/i)).not.toBeInTheDocument();
  });

  it('shows Drive sync only when enabled AND a Google client id is configured', () => {
    render(<KeyVault keys={[]} onChange={vi.fn()} webSearch={null} onWebSearchChange={vi.fn()} driveSyncEnabled={true} googleClientId="test-client-id" />);
    expect(screen.getByText(/sync your keys across devices/i)).toBeInTheDocument();
  });
});
