import { useState, useCallback } from 'react';
import Joyride, { type CallBackProps, STATUS } from 'react-joyride';
import type { Step } from 'react-joyride';
import { Play } from 'lucide-react';

interface Props { steps: Step[]; context: string }

export function WalkthroughEngine({ steps, context }: Props) {
  const [running, setRunning] = useState(false);

  const handleCallback = useCallback(({ status }: CallBackProps) => {
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      setRunning(false);
    }
  }, []);

  return (
    <div>
      <Joyride
        steps={steps}
        run={running}
        continuous
        showSkipButton
        showProgress
        callback={handleCallback}
        styles={{
          options: {
            primaryColor: '#7c6af7',
            backgroundColor: '#1a1a22',
            textColor: '#e8e8ec',
            arrowColor: '#1a1a22',
            overlayColor: 'rgba(0,0,0,0.65)',
            zIndex: 9000,
          },
          tooltip: { borderRadius: 10 },
          buttonNext: { borderRadius: 6, fontSize: 12 },
          buttonBack: { borderRadius: 6, fontSize: 12, color: '#a0a0b0' },
          buttonSkip: { color: '#a0a0b0', fontSize: 11 },
        }}
        locale={{
          back: 'Back',
          close: 'Close',
          last: 'Done',
          next: 'Next',
          open: 'Start tour',
          skip: 'Skip tour',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
          This interactive tour highlights the key parts of the <strong style={{ color: 'var(--text)' }}>{context}</strong> view
          and explains what each element does. You can skip at any time.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#7c6af7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ color: '#fff', fontSize: 9, fontWeight: 700 }}>{steps.length}</span>
          </div>
          steps in this tour
        </div>

        <button
          onClick={() => setRunning(true)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8,
            background: '#7c6af7', border: 'none', cursor: 'pointer',
            color: '#fff', fontSize: 13, fontWeight: 600,
          }}
        >
          <Play size={14} />
          Start Tour
        </button>
      </div>
    </div>
  );
}
