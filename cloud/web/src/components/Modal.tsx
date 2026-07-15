import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  maxWidth?: string;
  children: ReactNode;
}

export default function Modal({ title, onClose, maxWidth = 'max-w-md', children }: Props) {
  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
    >
      <motion.div
        className={`glass-strong flex max-h-[90vh] w-full ${maxWidth} flex-col overflow-hidden rounded-2xl`}
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-50">{title}</h2>
          <motion.button
            type="button"
            aria-label="Close"
            onClick={onClose}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            className="rounded-md p-1 text-ink-400 hover:bg-white/10 hover:text-ink-100"
          >
            <X size={16} />
          </motion.button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </motion.div>
    </motion.div>
  );
}
