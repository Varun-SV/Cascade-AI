import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ChatPanel from './ChatPanel.js';
import type { ActivityNode, PlanApproval } from './useChatSession.js';

vi.mock('../lib/api.js', () => ({
  fetchMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
  setMcpServerEnabled: vi.fn(),
  uploadImage: vi.fn(),
  uploadDocument: vi.fn(),
  uploadUrl: (id: string) => `/api/uploads/${id}`,
}));

afterEach(cleanup);

const approval: PlanApproval = { t2Count: 2, t3Count: 4, plan: { sections: [{ title: 'Pricing section' }] } };
const activity: ActivityNode[] = [{ tierId: 'T3-1', role: 'T3', label: 'fetch pricing pages', status: 'ACTIVE', order: 0 }];

function renderPanel(over: Partial<React.ComponentProps<typeof ChatPanel>>) {
  const noop = () => {};
  render(
    <ChatPanel
      messages={[{ id: 'u1', role: 'user', content: 'Build a competitor report' }]}
      busy
      error={null}
      status={null}
      hasProviders
      skills={[]}
      skillId="general"
      onSkillChange={noop}
      onSend={noop}
      onStop={noop}
      onRegenerate={noop}
      onEditMessage={noop}
      onDeleteMessage={noop}
      onSelectSibling={noop}
      routingMode="auto"
      onRoutingModeChange={noop}
      forceTier="auto"
      onForceTierChange={noop}
      webSearch={false}
      onWebSearchChange={noop}
      clarifications={[]}
      onAnswerClarification={noop}
      browserMode={false}
      onBrowserModeChange={noop}
      browserAvailable={false}
      runDetail
      approval={approval}
      compactionNotice={null}
      providerNotice={null}
      knowledgeNotice={null}
      activity={activity}
      {...over}
    />,
  );
}

describe('ChatPanel — a live run', () => {
  it('keeps the plan and the tree once the answer starts streaming and the status line clears', () => {
    renderPanel({ status: null });
    expect(screen.getByLabelText('Cascade planned this run')).toBeInTheDocument();
    expect(screen.getByText('fetch pricing pages')).toBeInTheDocument();
  });

  it('shows the status line while there is one', () => {
    renderPanel({ status: 'Planning the work…' });
    expect(screen.getByText('Planning the work…')).toBeInTheDocument();
  });

  it('shows no plan or tree with Run detail off', () => {
    renderPanel({ status: null, runDetail: false });
    expect(screen.queryByLabelText('Cascade planned this run')).not.toBeInTheDocument();
    expect(screen.queryByText('fetch pricing pages')).not.toBeInTheDocument();
  });

  it('shows nothing live once the run has ended', () => {
    renderPanel({ busy: false, status: null });
    expect(screen.queryByLabelText('Cascade planned this run')).not.toBeInTheDocument();
  });
});

describe('ChatPanel — a prompt carried in from the landing page', () => {
  afterEach(() => sessionStorage.clear());

  it('opens with it in the composer after sign-in, including a redirect sign-in, and never sends it', () => {
    // A GitHub/Google sign-in navigates away and back: everything in memory is
    // gone and only the tab's sessionStorage carries the prompt to this mount.
    sessionStorage.setItem('cascade-cloud-pending-prompt', JSON.stringify({ prompt: 'Audit our cloud bill', at: Date.now() }));
    const onSend = vi.fn();
    renderPanel({ messages: [], busy: false, approval: null, activity: [], onSend });
    expect(document.querySelector('textarea')).toHaveValue('Audit our cloud bill');
    expect(onSend).not.toHaveBeenCalled();
    // Taken once: the next chat opened in this tab starts empty.
    expect(sessionStorage.getItem('cascade-cloud-pending-prompt')).toBeNull();
  });

  it('starts empty when nothing was carried in', () => {
    renderPanel({ messages: [], busy: false, approval: null, activity: [] });
    expect(document.querySelector('textarea')).toHaveValue('');
  });
});
