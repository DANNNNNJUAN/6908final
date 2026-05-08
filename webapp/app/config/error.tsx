"use client";

import { useEffect } from "react";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ConfigError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("Config page error", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center gap-4 px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-neutral-500">
        Config
      </p>
      <h2 className="text-3xl font-semibold text-neutral-900">Config Page Temporarily Unavailable</h2>
      <p className="max-w-2xl text-sm leading-6 text-neutral-600">
        An error occurred while loading or rendering the configuration data. Retry this route to avoid a full-page failure.
      </p>
      <div>
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-neutral-900 px-5 py-2 text-sm font-medium text-white"
        >
          Reload Config Page
        </button>
      </div>
    </div>
  );
}
