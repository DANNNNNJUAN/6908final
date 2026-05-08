"use client";

const OPTIONS = [
  { value: 2, zh: "B&W", en: "B&W" },
  { value: 3, zh: "BWR", en: "BWR" },
  { value: 4, zh: "BWRY", en: "BWRY" },
] as const;

interface ColorSelectProps {
  value: number;
  onChange: (v: number) => void;
  tr: (zh: string, en: string) => string;
}

export function ColorSelect({ value, onChange, tr }: ColorSelectProps) {
  return (
    <div className="flex" title={tr("Screen colors", "Screen colors")}>
      {OPTIONS.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2 py-1 text-xs border border-ink/20 transition-colors ${
            i === 0 ? "rounded-l-sm" : ""
          }${i === OPTIONS.length - 1 ? "rounded-r-sm" : ""
          }${i > 0 ? " -ml-px" : ""
          } ${value === o.value
            ? "bg-ink text-white border-ink z-10 relative"
            : "bg-white text-ink hover:bg-ink/5"
          }`}
        >
          {tr(o.zh, o.en)}
        </button>
      ))}
    </div>
  );
}
