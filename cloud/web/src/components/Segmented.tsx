/** The prototype's segmented control: a sunken well, the chosen option raised. */
export default function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; label: string;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-sunk p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-[7px] px-[11px] py-1 text-[13px] font-medium ${
            value === o.value ? 'bg-card text-ink-50 shadow-[0_1px_2px_rgba(0,0,0,0.1)]' : 'text-ink-300 hover:text-ink-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
