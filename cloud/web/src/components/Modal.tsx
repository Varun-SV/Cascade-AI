import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  maxWidth?: string;
  children: ReactNode;
  /**
   * Overrides the stacking layer. Every ordinary modal shares `z-40` — which
   * one wins when two are open at once is decided by mount order, since ties
   * paint in DOM order — and `ContextApprovalDialog` sits fixed above all of
   * them at `z-50`. A run-blocking prompt (see EscalationModal) can't rely on
   * either: it has to win regardless of what else happens to be open, so it
   * needs a class strictly higher than z-50, not just "after" in the tree.
   */
  zIndexClassName?: string;
}

export default function Modal({ title, onClose, maxWidth = 'max-w-md', children, zIndexClassName = 'z-40' }: Props) {
  return (
    <motion.div
      className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-[rgba(10,12,16,0.35)] p-4`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[min(86dvh,720px)] w-full ${maxWidth} flex-col overflow-hidden rounded-[18px] bg-card shadow-[var(--glass-shadow-strong)]`}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-[18px]">
          <h2 className="m-0 flex-1 font-serif text-[21px] font-medium text-ink-50">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="cz-ib">
            <X size={17} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </motion.div>
    </motion.div>
  );
}
