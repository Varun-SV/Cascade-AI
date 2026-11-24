import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import WorkspaceRunCard from './WorkspaceRunCard.js';
import { applyWorkspaceEvent, type WorkspaceEvent, type WorkspaceRunView } from '../lib/workspaceRun.js';

afterEach(cleanup);

function viewOf(...events: WorkspaceEvent[]): WorkspaceRunView {
  let v: WorkspaceRunView | undefined;
  for (const e of events) v = applyWorkspaceEvent(v, e);
  return v!;
}
const attached: WorkspaceEvent = { type: 'attached', runId: 'r1', label: 'my-project', device: { id: 'd1', name: 'Work PC' } };

describe('WorkspaceRunCard', () => {
  it('shows nothing for a cloud run', () => {
    const { container } = render(<WorkspaceRunCard view={undefined} awaitingConsent={false} awaitingDeviceName="x" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('says the computer is being asked, before the workspace attaches', () => {
    render(<WorkspaceRunCard view={undefined} awaitingConsent awaitingDeviceName="Work PC" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for Work PC to allow this run…');
  });
  it('shows the folder label and the computer, then the approval wait, then marks the run ended', () => {
    const { rerender } = render(<WorkspaceRunCard view={viewOf(attached)} awaitingConsent={false} awaitingDeviceName="x" />);
    expect(screen.getByText(/Working in/)).toHaveTextContent('Working in my-project on Work PC');
    rerender(<WorkspaceRunCard view={viewOf(attached, { type: 'waiting', runId: 'r1', tool: 'shell' })} awaitingConsent={false} awaitingDeviceName="x" />);
    expect(screen.getByText('Waiting for your approval on Work PC (shell)')).toBeInTheDocument();
    rerender(<WorkspaceRunCard view={viewOf(attached, { type: 'detached', runId: 'r1' })} awaitingConsent={false} awaitingDeviceName="x" />);
    expect(screen.queryByText(/Waiting for your approval/)).toBeNull();
    expect(screen.getByText(/Worked in/)).toBeInTheDocument();
    expect(screen.getByText('· ended')).toBeInTheDocument();
  });
  it('lists the changed files, with a red/green diff for an edit, new content for a write, and "deleted"', () => {
    const view = viewOf(
      attached,
      { type: 'call', runId: 'r1', id: '1', tool: 'file_edit', change: { kind: 'edit', path: 'src/a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' } },
      { type: 'call', runId: 'r1', id: '2', tool: 'file_write', change: { kind: 'write', path: 'notes.md', content: 'brand new text' } },
      { type: 'call', runId: 'r1', id: '3', tool: 'file_delete', change: { kind: 'delete', path: 'old.txt' } },
    );
    const { container } = render(<WorkspaceRunCard view={view} awaitingConsent={false} awaitingDeviceName="x" />);
    expect(screen.getByRole('region', { name: 'Files changed in your workspace' })).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('old.txt').parentElement).toHaveTextContent('deleted');
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(container.querySelector('[data-diff="del"]')).toHaveTextContent('const a = 1;');
    expect(container.querySelector('[data-diff="add"]')).toHaveTextContent('const a = 2;');
    fireEvent.click(screen.getByText('notes.md'));
    expect(screen.getByText('New content')).toBeInTheDocument();
  });
  it('surfaces the changed-since-read note', () => {
    const note = '[Files in the workspace changed since you read them: a.txt — read them again before relying on them.]';
    render(<WorkspaceRunCard view={viewOf(attached, { type: 'result', runId: 'r1', id: '1', tool: 'file_read', ok: true, note })} awaitingConsent={false} awaitingDeviceName="x" />);
    expect(screen.getByText(/changed on your computer since the run read them: a\.txt/)).toBeInTheDocument();
  });
});
