// Loads Razorpay's hosted Checkout script on demand and opens it for a
// subscription. The script is only fetched when the user actually clicks
// Subscribe — never on initial load.

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayCtor {
  new (options: Record<string, unknown>): { open: () => void };
}

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let loading: Promise<RazorpayCtor> | null = null;

function loadCheckout(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!loading) {
    loading = new Promise<RazorpayCtor>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHECKOUT_SRC;
      s.async = true;
      s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay failed to load')));
      s.onerror = () => reject(new Error('Could not load Razorpay Checkout'));
      document.head.appendChild(s);
    }).catch((e) => {
      loading = null; // allow a retry on the next click
      throw e;
    });
  }
  return loading;
}

export interface CheckoutOptions {
  keyId: string;
  subscriptionId: string;
  name?: string;
  description?: string;
  prefillEmail?: string | null;
  onSuccess: () => void;
  onDismiss?: () => void;
}

/** Opens Razorpay Checkout for a subscription; resolves once it's open. */
export async function openSubscriptionCheckout(opts: CheckoutOptions): Promise<void> {
  const Razorpay = await loadCheckout();
  const rzp = new Razorpay({
    key: opts.keyId,
    subscription_id: opts.subscriptionId,
    name: opts.name ?? 'Cascade Cloud',
    description: opts.description ?? 'Pro subscription',
    prefill: opts.prefillEmail ? { email: opts.prefillEmail } : undefined,
    theme: { color: '#ff8a3d' },
    // Payment succeeded on the client — the webhook is what actually flips the
    // plan, so just refresh billing state.
    handler: () => opts.onSuccess(),
    modal: { ondismiss: () => opts.onDismiss?.() },
  });
  rzp.open();
}
