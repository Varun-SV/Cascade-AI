import { useEffect, useState, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  maxWidth?: string;
  children: ReactNode;
}

export default function Modal({ title, onClose, maxWidth = 'max-w-md', children }: Props) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className={
          `w-full ${maxWidth} rounded-xl border border-ink-700 bg-ink-900 transition-all duration-150 ` +
          (entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0')
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-ink-400 hover:text-ink-100">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
