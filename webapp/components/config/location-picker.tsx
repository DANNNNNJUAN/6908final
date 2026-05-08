"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  cacheLocationResults,
  cleanLocationValue,
  describeLocation,
  getCachedLocationResults,
  getStoredRecentLocations,
  saveRecentLocation,
  type LocationOption,
  type LocationValue,
} from "@/lib/locations";

export function LocationPicker({
  value,
  onChange,
  placeholder,
  locale,
  helperText,
  className = "",
  autoFocus = false,
}: {
  value: Partial<LocationValue> | null | undefined;
  onChange: (next: LocationValue) => void;
  placeholder: string;
  locale: "zh" | "en";
  helperText?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const cleanedValue = useMemo(() => cleanLocationValue(value), [value]);
  const [query, setQuery] = useState(cleanedValue.city || "");
  const [options, setOptions] = useState<LocationOption[]>([]);
  const [recentOptions, setRecentOptions] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setRecentOptions(getStoredRecentLocations());
  }, []);

  useEffect(() => {
    setQuery(cleanedValue.city || "");
  }, [cleanedValue.city]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (event.target instanceof Node && wrapperRef.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setOptions(recentOptions);
      setMessage(
        recentOptions.length
          ? ""
          : locale === "zh"
          ? "Search directly and choose a place from the list. Frequently used places stay here."
          : "Search and pick a place from the list. Recent places will stay here.",
      );
      setLoading(false);
      return;
    }

    const cachedItems = getCachedLocationResults(keyword, locale);
    if (cachedItems?.length) {
      setOptions(cachedItems);
      setMessage("");
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const res = await fetch(`/api/locations/search?q=${encodeURIComponent(keyword)}&limit=8&locale=${encodeURIComponent(locale)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items?: LocationOption[] };
        if (seq !== requestSeqRef.current) return;
        const items = Array.isArray(data.items) ? data.items : [];
        const cached = cacheLocationResults(keyword, items, locale);
        setOptions(cached);
        setMessage(
          items.length
            ? ""
            : locale === "zh"
            ? "No matching place found. Keep typing a more complete name."
            : "No matching place found. Try a more specific name.",
        );
      } catch {
        if (seq !== requestSeqRef.current) return;
        setOptions([]);
        setMessage("Location search is temporarily unavailable.");
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [locale, query, recentOptions]);

  const selectedSummary = describeLocation(cleanedValue);
  const hasCoordinates = typeof cleanedValue.latitude === "number" && typeof cleanedValue.longitude === "number";

  return (
    <div className="space-y-2" ref={wrapperRef}>
      <div className="relative">
        <input
          value={query}
          autoFocus={autoFocus}
          onFocus={() => {
            setRecentOptions(getStoredRecentLocations());
            setOpen(true);
          }}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setOpen(true);
            onChange({ city: nextQuery.trim() });
          }}
          placeholder={placeholder}
          className={className || "w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"}
        />
        {open && (query.trim() || recentOptions.length > 0) ? (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-sm border border-ink/15 bg-white shadow-lg">
            {loading ? (
              <div className="px-3 py-2 text-xs text-ink-light">
                {"Searching places..."}
              </div>
            ) : options.length ? (
              <>
                {!query.trim() ? (
                  <div className="px-3 py-2 text-[11px] font-medium tracking-wide text-ink-light">
                    {"Recent Places"}
                  </div>
                ) : null}
                {options.map((option) => {
                const optionSummary = describeLocation(option);
                const isSelected =
                  option.city === cleanedValue.city &&
                  option.latitude === cleanedValue.latitude &&
                  option.longitude === cleanedValue.longitude;
                return (
                  <button
                    key={`${option.city}:${option.latitude}:${option.longitude}`}
                    type="button"
                    onClick={() => {
                      const nextRecent = saveRecentLocation(option);
                      setRecentOptions(nextRecent);
                      onChange(cleanLocationValue(option));
                      setQuery(option.city);
                      setOpen(false);
                    }}
                    className={`block w-full border-b border-ink/10 px-3 py-2 text-left last:border-b-0 ${
                      isSelected ? "bg-paper-dark" : "hover:bg-paper-dark"
                    }`}
                  >
                    <div className="text-sm text-ink">{option.display_name || optionSummary || option.city}</div>
                  </button>
                );
                })}
              </>
            ) : (
              <div className="px-3 py-2 text-xs text-ink-light">{message}</div>
            )}
          </div>
        ) : null}
      </div>
      <div className="min-h-[1.25rem] text-xs text-ink-light">
        {hasCoordinates
          ? `Selected: ${selectedSummary}`
          : helperText || "Pick a result from the list. Domestic and international places are supported."
      </div>
    </div>
  );
}
