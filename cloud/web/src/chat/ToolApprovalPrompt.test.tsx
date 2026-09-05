// ─────────────────────────────────────────────
//  Cascade Cloud — the approval prompt
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToolApprovalPrompt } from './ToolApprovalPrompt.js';

const req = (over: Partial<Parameters<typeof ToolApprovalPrompt>[0]['approvals'][number]> = {}) => ({
  requestId: 'req-1', toolName: 'browser_control', input: { action: 'click', selector: '#submit' }, ...over,
});

describe('ToolApprovalPrompt', () => {
  it('shows nothing when nothing is waiting', () => {
    const { container } = render(<ToolApprovalPrompt approvals={[]} onDecide={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the tool and shows what it was asked to do', () => {
    // "Approve this tool" without the arguments is not consent — the selector
    // is the difference between clicking Search and clicking Delete.
    render(<ToolApprovalPrompt approvals={[req()]} onDecide={() => {}} />);
    expect(screen.getByText('browser_control')).toBeInTheDocument();
    expect(screen.getByText(/#submit/)).toBeInTheDocument();
  });

  it('answers once for this call', () => {
    const onDecide = vi.fn();
    render(<ToolApprovalPrompt approvals={[req()]} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /allow once/i }));
    expect(onDecide).toHaveBeenCalledWith('req-1', true);
  });

  it('offers "for this run", which is what makes a sequence one prompt', () => {
    // Without it a ten-step form fill is ten prompts, and people stop reading
    // prompts they see ten of.
    const onDecide = vi.fn();
    render(<ToolApprovalPrompt approvals={[req()]} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /for this run/i }));
    expect(onDecide).toHaveBeenCalledWith('req-1', true, true);
  });

  it('can deny', () => {
    const onDecide = vi.fn();
    render(<ToolApprovalPrompt approvals={[req()]} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onDecide).toHaveBeenCalledWith('req-1', false);
  });

  it('says how many more are waiting behind this one', () => {
    // A queue nobody can see looks like a stuck run.
    render(
      <ToolApprovalPrompt
        approvals={[req(), req({ requestId: 'req-2' }), req({ requestId: 'req-3' })]}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/2 more waiting/i)).toBeInTheDocument();
  });

  it('answers the oldest request first', () => {
    // Answering the newest while the rest time out is the failure this exists
    // to replace.
    const onDecide = vi.fn();
    render(<ToolApprovalPrompt approvals={[req(), req({ requestId: 'req-2' })]} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /allow once/i }));
    expect(onDecide).toHaveBeenCalledWith('req-1', true);
  });
});
