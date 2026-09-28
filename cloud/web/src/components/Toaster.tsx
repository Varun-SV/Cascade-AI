import { useEffect, useState } from 'react';
import { TOAST_EVENT } from '../lib/toast.js';

/** Shows the latest toast for a moment; a new one replaces it. */
export default function Toaster() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onToast = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(null), 2600);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => { window.removeEventListener(TOAST_EVENT, onToast); clearTimeout(timer); };
  }, []);

  if (!message) return null;
  return <div role="status" className="cz-toast">{message}</div>;
}
