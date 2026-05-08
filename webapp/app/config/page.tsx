"use client";

import { useEffect, useState, useCallback, Suspense, useMemo, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { DeviceInfo } from "@/components/config/device-info";
import { LocationPicker } from "@/components/config/location-picker";
import { ModeSelector } from "@/components/config/mode-selector";
import { ModeComposer, type ComposerPropMeta, type ComposerCatalog, type ComposerFragmentState, type ComposerState, withPropDefaults, findCatalogItem, randomComposerId } from "@/components/config/mode-composer";
import { EInkPreviewPanel } from "@/components/config/eink-preview-panel";
import { CalendarReminders } from "@/components/config/calendar-reminders";
import { TimetableEditor, type TimetableData } from "@/components/config/timetable-editor";
import { RefreshStrategyEditor, TimeSlotRule } from "@/components/config/refresh-strategy-editor";
import { Field, StatCard } from "@/components/config/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Settings,
  Sliders,
  BarChart3,
  RefreshCw,
  Save,
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
  Monitor,
  X,
  Users,
} from "lucide-react";
import { authHeaders, fetchCurrentUser, onAuthChanged } from "@/lib/auth";
import { localeFromPathname, withLocalePath } from "@/lib/i18n";
import {
  buildLocationValue,
  cleanLocationValue,
  describeLocation,
  extractLocationValue,
  locationsEqual,
  type LocationValue,
} from "@/lib/locations";

interface UserDevice {
  mac: string;
  nickname: string;
  bound_at: string;
  last_seen: string | null;
  role?: string;
  status?: string;
}

interface DeviceMember {
  user_id: number;
  username: string;
  role: string;
  status: string;
  nickname?: string;
  created_at: string;
}

interface AccessRequestItem {
  id: number;
  mac: string;
  requester_user_id: number;
  requester_username: string;
  status: string;
  created_at: string;
}

type ModeCatalogItem = {
  mode_id: string;
  category: "core" | "more" | "custom" | string;
  source?: string;
  display_name?: string;
  description?: string;
  settings_schema?: ModeSettingSchemaItem[];
  i18n?: {
    zh?: { name?: string; tip?: string };
    en?: { name?: string; tip?: string };
  };
};

const STRATEGIES: Record<string, string> = {
  random: "Randomly pick from enabled modes",
  cycle: "Cycle through enabled modes in order",
  time_slot: "Show different modes by time slot",
  smart: "Automatically match the best mode by time",
};

const MODE_LANGUAGE_OPTIONS = [
  { value: "zh", label: "Chinese", labelEn: "Chinese" },
  { value: "en", label: "English", labelEn: "English" },
] as const;

const TONE_OPTIONS = [
  { value: "positive", label: "Encouraging" },
  { value: "neutral", label: "Neutral" },
  { value: "deep", label: "Reflective" },
  { value: "humor", label: "Humorous" },
] as const;
const PERSONA_PRESETS = ["Virginia Woolf", "George Orwell", "JARVIS", "Socrates", "Haruki Murakami"] as const;

import { queueImmediateRefreshIfOnline } from "@/lib/device-utils";

function normalizeTone(v: unknown): string {
  if (typeof v !== "string") return "neutral";
  if (v === "positive" || v === "neutral" || v === "deep" || v === "humor") return v;
  const found = TONE_OPTIONS.find((x) => x.label === v);
  return found?.value || "neutral";
}


function normalizeModeIdFromName(name: string) {
  let modeId = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!modeId) modeId = `CUSTOM_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  if (!/^[A-Z]/.test(modeId)) modeId = `CUSTOM_${modeId}`;
  return modeId;
}

function fallbackValueForField(fieldName: string) {
  const cleaned = fieldName.trim();
  if (!cleaned) return "Sample";
  return cleaned
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function defaultComposerState(catalog: ComposerCatalog | null): ComposerState {
  const defaultPreset = catalog?.presets?.[0]?.name || "";
  const defaultPresetMeta = catalog?.presets?.[0];
  const defaultFragment = catalog?.fragments?.[0];
  const defaultFragmentStack = Object.fromEntries(
    (catalog?.fragment_stack?.props || []).flatMap((prop) => (prop.default !== undefined ? [[prop.name, prop.default]] : [])),
  );
  return {
    layoutKind: "preset",
    bodyPreset: defaultPreset,
    presetProps: withPropDefaults({}, defaultPresetMeta?.props),
    fragments: defaultFragment
      ? [
          {
            id: randomComposerId(),
            fragment: defaultFragment.name,
            props: withPropDefaults({}, defaultFragment.props),
          },
        ]
      : [],
    fragmentStack: defaultFragmentStack,
    prompt: "",
    cacheable: true,
  };
}

function collectComposerFieldNames(
  composer: ComposerState,
  catalog: ComposerCatalog | null,
) {
  const names = new Set<string>();
  const collect = (metas: ComposerPropMeta[] | undefined, props: Record<string, unknown>) => {
    for (const meta of metas || []) {
      if (meta.value_kind !== "field") continue;
      const value = props[meta.name];
      if (typeof value === "string" && value.trim()) names.add(value.trim());
    }
  };
  if (composer.layoutKind === "preset") {
    const preset = findCatalogItem(catalog?.presets, composer.bodyPreset);
    collect(preset?.props, composer.presetProps);
  } else {
    for (const fragment of composer.fragments) {
      const item = findCatalogItem(catalog?.fragments, fragment.fragment);
      collect(item?.props, fragment.props);
    }
  }
  if (names.size === 0) names.add("text");
  return Array.from(names);
}

const FIELD_HINT_ZH: Record<string, string> = {
  title: "a short, punchy title",
  subtitle: "subtitle",
  meta: "brief meta info (category, source, etc.)",
  body: "main body text",
  text: "main body text",
  quote: "a quote or saying",
  author: "author or attribution",
  source: "source or origin",
  question: "a thought-provoking question",
  answer: "the answer",
  hint: "a hint or clue",
  note: "a brief supplementary note",
  word: "a word or short phrase",
  phonetic: "phonetic transcription",
  definition: "definition or explanation",
  example: "an example sentence or case",
  greeting: "greeting (e.g. 'Dear friend,')",
  closing: "closing (e.g. 'Best regards')",
  postscript: "postscript (P.S.)",
  tip: "a practical tip",
  category: "category label",
  name: "name",
  description: "brief description",
  summary: "summary",
  antidote: "advice or remedy",
  message: "a short message",
};
const FIELD_HINT_EN: Record<string, string> = {
  title: "a short, punchy title",
  subtitle: "subtitle",
  meta: "brief meta info (category, source, etc.)",
  body: "main body text",
  text: "main body text",
  quote: "a quote or saying",
  author: "author or attribution",
  source: "source or origin",
  question: "a thought-provoking question",
  answer: "the answer",
  hint: "a hint or clue",
  note: "a brief supplementary note",
  word: "a word or short phrase",
  phonetic: "phonetic transcription",
  definition: "definition or explanation",
  example: "an example sentence or case",
  greeting: "greeting (e.g. 'Dear friend,')",
  closing: "closing (e.g. 'Best regards')",
  postscript: "postscript (P.S.)",
  tip: "a practical tip",
  category: "category label",
  name: "name",
  description: "brief description",
  summary: "summary",
  antidote: "advice or remedy",
  message: "a short message",
};

function buildComposerPrompt(prompt: string, fieldNames: string[], isEn: boolean) {
  const hints = isEn ? FIELD_HINT_EN : FIELD_HINT_ZH;
  const userPrompt = prompt.trim();
  const fieldDescs = fieldNames.map((f) => {
    const hint = hints[f];
    return hint ? `"${f}": ${hint}` : `"${f}": ...`;
  });
  const schema = `{ ${fieldNames.map((f) => `"${f}": "..."`).join(", ")} }`;

  if (isEn) {
    return [
      `You are a content creator for a small e-ink screen.`,
      userPrompt ? `Theme: ${userPrompt}` : `Generate concise, interesting content.`,
      `Return ONLY valid JSON with these fields:`,
      ...fieldDescs.map((d) => `  - ${d}`),
      `All values must be strings. Keep each field concise (suitable for a small screen).`,
      `Example format: ${schema}`,
      `You may use the following context for inspiration, but do NOT just describe it:`,
      `{context}`,
    ].join("\n");
  }
  return [
    `You are a content creator for a small e-ink screen.`,
    userPrompt ? `Theme: ${userPrompt}` : `Generate concise, interesting content.`,
    `Return ONLY valid JSON with these fields:`,
    ...fieldDescs.map((d) => `  - ${d}`),
    `All values must be strings. Keep each field concise (suitable for a small screen).`,
    `Example format: ${schema}`,
    `You may use the following context for inspiration, but do NOT just describe it:`,
    `{context}`,
  ].join("\n");
}

function buildComposerModeDefinition(args: {
  composer: ComposerState;
  catalog: ComposerCatalog | null;
  modeName: string;
  modeDescription: string;
  isEn: boolean;
}) {
  const { composer, catalog, modeName, modeDescription, isEn } = args;
  const modeId = normalizeModeIdFromName(modeName || "Custom Mode");
  const displayName = modeName.trim() || modeId;
  const fieldNames = collectComposerFieldNames(composer, catalog);
  const outputSchema = Object.fromEntries(
    fieldNames.map((field) => [field, fallbackValueForField(field)]),
  );
  const fallback = Object.fromEntries(fieldNames.map((field) => [field, fallbackValueForField(field)]));
  const layout: Record<string, unknown> = {
    layout_engine: "component_tree",
    status_bar: { line_width: 1, dashed: false },
    footer: { label: modeId, attribution_template: "— InkSight" },
  };
  if (composer.layoutKind === "preset") {
    layout.body_preset = composer.bodyPreset;
    layout.preset_props = composer.presetProps;
  } else {
    layout.fragments = composer.fragments.map((fragment) => ({
      fragment: fragment.fragment,
      props: fragment.props,
    }));
    layout.fragment_stack = composer.fragmentStack;
  }
  return {
    mode_id: modeId,
    display_name: displayName,
    icon: "star",
    cacheable: composer.cacheable,
    description: modeDescription.trim() || composer.prompt.trim() || displayName,
    content: {
      type: "llm_json",
      prompt_template: buildComposerPrompt(composer.prompt, fieldNames, isEn),
      output_schema: outputSchema,
      temperature: 0.7,
      fallback,
    },
    layout,
  };
}

function parseComposerModeDefinition(
  raw: unknown,
  catalog: ComposerCatalog | null,
): { composer: ComposerState | null; error: string | null } {
  if (!raw || typeof raw !== "object") {
    return { composer: null, error: "Invalid mode definition" };
  }
  const modeDef = raw as Record<string, unknown>;
  const layout = (modeDef.layout && typeof modeDef.layout === "object") ? (modeDef.layout as Record<string, unknown>) : null;
  if (!layout || layout.layout_engine !== "component_tree") {
    return { composer: null, error: "Only component_tree preset/fragment layouts are supported in Composer." };
  }
  const content = (modeDef.content && typeof modeDef.content === "object") ? (modeDef.content as Record<string, unknown>) : null;
  const prompt = typeof content?.prompt_template === "string" ? content.prompt_template : "";
  const cacheable = modeDef.cacheable !== false;
  if (typeof layout.body_preset === "string" && layout.body_preset.trim()) {
    const presetName = layout.body_preset.trim();
    if (!findCatalogItem(catalog?.presets, presetName)) {
      return { composer: null, error: `Unsupported preset: ${presetName}` };
    }
    return {
      composer: {
        layoutKind: "preset",
        bodyPreset: presetName,
        presetProps: withPropDefaults(
          (layout.preset_props && typeof layout.preset_props === "object") ? (layout.preset_props as Record<string, unknown>) : {},
          findCatalogItem(catalog?.presets, presetName)?.props,
        ),
        fragments: [],
        fragmentStack: {},
        prompt,
        cacheable,
      },
      error: null,
    };
  }
  if (Array.isArray(layout.fragments)) {
    const fragments: ComposerFragmentState[] = [];
    for (const entry of layout.fragments) {
      if (!entry || typeof entry !== "object") {
        return { composer: null, error: "Unsupported fragment entry." };
      }
      const fragmentName = typeof (entry as Record<string, unknown>).fragment === "string"
        ? ((entry as Record<string, unknown>).fragment as string).trim()
        : "";
      const fragmentMeta = findCatalogItem(catalog?.fragments, fragmentName);
      if (!fragmentName || !fragmentMeta) {
        return { composer: null, error: `Unsupported fragment: ${fragmentName || "unknown"}` };
      }
      const props = "props" in (entry as Record<string, unknown>)
        ? (((entry as Record<string, unknown>).props && typeof (entry as Record<string, unknown>).props === "object")
            ? ((entry as Record<string, unknown>).props as Record<string, unknown>)
            : {})
        : Object.fromEntries(
            Object.entries(entry as Record<string, unknown>).filter(([key]) => key !== "fragment"),
          );
      fragments.push({
        id: randomComposerId(),
        fragment: fragmentName,
        props: withPropDefaults(props, fragmentMeta.props),
      });
    }
    return {
      composer: {
        layoutKind: "fragments",
        bodyPreset: catalog?.presets?.[0]?.name || "",
        presetProps: {},
        fragments,
        fragmentStack: withPropDefaults(
          (layout.fragment_stack && typeof layout.fragment_stack === "object") ? (layout.fragment_stack as Record<string, unknown>) : {},
          catalog?.fragment_stack?.props,
        ),
        prompt,
        cacheable,
      },
      error: null,
    };
  }
  return { composer: null, error: "Only body_preset or fragments layouts are supported in Composer." };
}

// Custom mode templates removed (AI-only creation)


const TABS = [
  { id: "modes", label: "Modes", icon: Settings },
  { id: "preferences", label: "Preferences", icon: Sliders },
  { id: "sharing", label: "Shared Members", icon: Users },
  { id: "stats", label: "Status", icon: BarChart3 },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface DeviceConfig {
  mac?: string;
  modes?: string[];
  refreshStrategy?: string;
  refreshInterval?: number;
  refresh_strategy?: string;
  refresh_minutes?: number;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  admin1?: string;
  country?: string;
  language?: string;
  contentTone?: string;
  content_tone?: string;
  characterTones?: string[];
  character_tones?: string[];
  llmProvider?: string;
  llmModel?: string;
  llm_provider?: string;
  llm_model?: string;
  imageProvider?: string;
  imageModel?: string;
  image_provider?: string;
  image_model?: string;
  countdownEvents?: { name: string; date: string }[];
  countdown_events?: { name: string; date: string }[];
  memoText?: string;
  memo_text?: string;
  mode_overrides?: Record<string, ModeOverride>;
  modeOverrides?: Record<string, ModeOverride>;
  is_focus_listening?: boolean;
  focus_listening?: number;
  is_always_active?: boolean;
  always_active?: number | boolean;
}

interface ModeOverride {
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  admin1?: string;
  country?: string;
  llm_provider?: string;
  llm_model?: string;
  [key: string]: unknown;
}

interface PendingPreviewConfirm {
  mode: string;
  forceNoCache: boolean;
  forcedModeOverride?: ModeOverride;
  usageSource?: string;
}

type ParamModalType = "quote" | "weather" | "memo" | "countdown" | "habit" | "lifebar" | "calendar" | "timetable";
interface ParamModalState {
  type: ParamModalType;
  mode: string;
  action: "preview" | "apply";
}

interface ModeSettingSchemaItem {
  key: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select" | "boolean";
  placeholder?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
  as_json?: boolean;
  options?: Array<{ value: string; label: string } | string>;
}

interface DeviceStats {
  total_renders?: number;
  cache_hit_rate?: number;
  last_battery_voltage?: number;
  last_rssi?: number;
  last_refresh?: string;
  error_count?: number;
  mode_frequency?: Record<string, number>;
}

type RuntimeMode = "active" | "interval" | "unknown";

function ConfigPageInner() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname || "/");
  const isEn = locale === "en";
  const tr = useCallback((_zh: string, en: string) => en, []);
  const searchParams = useSearchParams();
  const mac = searchParams.get("mac") || "";
  const preferMac = searchParams.get("prefer_mac") || "";
  const prefillCode = searchParams.get("code") || "";
  const [currentUser, setCurrentUser] = useState<{ user_id: number; username: string } | null | undefined>(undefined);
  const [userDevices, setUserDevices] = useState<UserDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [pairCodeInput, setPairCodeInput] = useState("");
  const [pairingDevice, setPairingDevice] = useState(false);
  const [bindMacInput, setBindMacInput] = useState("");
  const [bindNicknameInput, setBindNicknameInput] = useState("");
  const [deviceMembers, setDeviceMembers] = useState<DeviceMember[]>([]);
  const [pendingRequests, setPendingRequests] = useState<AccessRequestItem[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [shareUsernameInput, setShareUsernameInput] = useState("");
  const [macAccessDenied, setMacAccessDenied] = useState(false);

  const refreshCurrentUser = useCallback(() => {
    fetchCurrentUser()
      .then((d) => setCurrentUser(d ? { user_id: d.user_id, username: d.username } : null))
      .catch(() => setCurrentUser(null));
  }, []);

  useEffect(() => {
    refreshCurrentUser();
  }, [refreshCurrentUser]);

  useEffect(() => {
    const off = onAuthChanged(refreshCurrentUser);
    const onFocus = () => refreshCurrentUser();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshCurrentUser]);

  const loadUserDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await fetch("/api/user/devices", { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setUserDevices(data.devices || []);
      }
    } catch { /* ignore */ }
    finally { setDevicesLoading(false); }
  }, []);

  const loadPendingRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const res = await fetch("/api/user/devices/requests", { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setPendingRequests(data.requests || []);
      }
    } catch { /* ignore */ }
    finally { setRequestsLoading(false); }
  }, []);

  const loadDeviceMembers = useCallback(async (deviceMac: string) => {
    if (!deviceMac) return;
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/user/devices/${encodeURIComponent(deviceMac)}/members`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setDeviceMembers(data.members || []);
      } else {
        setDeviceMembers([]);
      }
    } catch {
      setDeviceMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser) {
      loadUserDevices();
      loadPendingRequests();
    }
  }, [currentUser, loadPendingRequests, loadUserDevices]);

  useEffect(() => {
    if (mac) return;
    const normalizedCode = prefillCode.trim().toUpperCase();
    if (normalizedCode) {
      setPairCodeInput((prev) => prev || normalizedCode);
    }
    const normalizedMac = preferMac.trim().toUpperCase();
    if (normalizedMac) {
      setBindMacInput((prev) => prev || normalizedMac);
    }
  }, [mac, preferMac, prefillCode]);

  useEffect(() => {
    if (mac || !preferMac || !currentUser || devicesLoading) return;
    const normalizedMac = preferMac.trim().toUpperCase();
    if (!normalizedMac) return;
    const alreadyBound = userDevices.some((item) => item.mac.toUpperCase() === normalizedMac);
    if (alreadyBound) {
      window.location.href = `${withLocalePath(locale, "/config")}?mac=${encodeURIComponent(normalizedMac)}`;
    }
  }, [currentUser, devicesLoading, locale, mac, preferMac, userDevices]);

  const handlePairDevice = async () => {
    const normalized = pairCodeInput.trim().toUpperCase();
    if (!normalized) return;
    setPairingDevice(true);
    try {
      const res = await fetch("/api/claim/consume", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ pair_code: normalized }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || tr("Pairing failed", "Pairing failed"), "error");
        return;
      }
      setPairCodeInput("");
      if (data.status === "claimed" || data.status === "already_member" || data.status === "active") {
        await loadUserDevices();
        await loadPendingRequests();
        window.location.href = `${withLocalePath(locale, "/config")}?mac=${encodeURIComponent(data.mac)}`;
        return;
      }
      await loadPendingRequests();
      showToast(tr("Binding request submitted. Waiting for owner approval", "Binding request submitted. Waiting for owner approval"), "info");
    } catch {
      showToast(tr("Pairing failed", "Pairing failed"), "error");
    } finally {
      setPairingDevice(false);
    }
  };

  const handleBindDevice = async (deviceMac: string, nickname?: string) => {
    try {
      const res = await fetch("/api/user/devices", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mac: deviceMac, nickname: nickname || "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || tr("Binding failed", "Binding failed"), "error");
        return null;
      }
      setBindMacInput("");
      setBindNicknameInput("");
      await loadUserDevices();
      await loadPendingRequests();
      return data;
    } catch {
      showToast(tr("Binding failed", "Binding failed"), "error");
      return null;
    }
  };

  const handleUnbindDevice = async (deviceMac: string, force = false) => {
    try {
      const url = `/api/user/devices/${encodeURIComponent(deviceMac)}${force ? "?force=true" : ""}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        await loadUserDevices();
        return;
      }
      if (res.status === 409 && !force) {
        const ok = confirm(tr(
          "This device still has shared members. Force unbinding will remove them all. Continue?",
          "This device still has shared members. Force unbind will remove all members. Continue?"
        ));
        if (ok) await handleUnbindDevice(deviceMac, true);
      }
    } catch { /* ignore */ }
  };

  const handleApproveRequest = async (requestId: number) => {
    try {
      const res = await fetch(`/api/user/devices/requests/${requestId}/approve`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      if (res.ok) {
        await loadPendingRequests();
        if (mac) await loadDeviceMembers(mac);
        showToast(tr("Binding request approved", "Binding request approved"), "success");
      } else {
        showToast(tr("Approval failed", "Approval failed"), "error");
      }
    } catch {
      showToast(tr("Approval failed", "Approval failed"), "error");
    }
  };

  const handleRejectRequest = async (requestId: number) => {
    try {
      const res = await fetch(`/api/user/devices/requests/${requestId}/reject`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      if (res.ok) {
        await loadPendingRequests();
        showToast(tr("Binding request rejected", "Binding request rejected"), "success");
      } else {
        showToast(tr("Rejection failed", "Rejection failed"), "error");
      }
    } catch {
      showToast(tr("Rejection failed", "Rejection failed"), "error");
    }
  };

  const handleShareDevice = async () => {
    if (!mac || !shareUsernameInput.trim()) return;
    try {
      const res = await fetch(`/api/user/devices/${encodeURIComponent(mac)}/share`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ username: shareUsernameInput.trim() }),
      });
      if (!res.ok) throw new Error("share failed");
      setShareUsernameInput("");
      await loadDeviceMembers(mac);
      await loadPendingRequests();
      showToast(tr("Shared successfully", "Shared successfully"), "success");
    } catch {
      showToast(tr("Share failed", "Share failed"), "error");
    }
  };

  const handleRemoveMember = async (targetUserId: number) => {
    if (!mac) return;
    try {
      const res = await fetch(`/api/user/devices/${encodeURIComponent(mac)}/members/${targetUserId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("remove failed");
      await loadDeviceMembers(mac);
      showToast(tr("Member removed", "Member removed"), "success");
    } catch {
      showToast(tr("Failed to remove member", "Failed to remove member"), "error");
    }
  };

  const [activeTab, setActiveTab] = useState<TabId>("modes");
  const [config, setConfig] = useState<DeviceConfig>({});
  const [selectedModes, setSelectedModes] = useState<Set<string>>(new Set(["STOIC", "ZEN", "DAILY"]));
  const [strategy, setStrategy] = useState("random");
  const [refreshMin, setRefreshMin] = useState(60);
  const [timeSlotRules, setTimeSlotRules] = useState<TimeSlotRule[]>([]);
  const [city, setCity] = useState("");
  const [locationMeta, setLocationMeta] = useState<LocationValue>({});
  const [modeLanguage, setModeLanguage] = useState("en");
  const [contentTone, setContentTone] = useState("neutral");
  const [characterTones, setCharacterTones] = useState<string[]>([]);
  const [customPersonaTone, setCustomPersonaTone] = useState("");
  const [modeOverrides, setModeOverrides] = useState<Record<string, ModeOverride>>({});
  const [settingsMode, setSettingsMode] = useState<string | null>(null);
  const [settingsJsonDrafts, setSettingsJsonDrafts] = useState<Record<string, string>>({});
  const [settingsJsonErrors, setSettingsJsonErrors] = useState<Record<string, string>>({});
  const [memoText, setMemoText] = useState("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "info" } | null>(null);
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStatusText, setPreviewStatusText] = useState("");
  const [previewMode, setPreviewMode] = useState("");
  const [previewColors, setPreviewColors] = useState(2);
  const [previewNoCacheOnce, setPreviewNoCacheOnce] = useState(false);
  const [previewCacheHit, setPreviewCacheHit] = useState<boolean | null>(null);
  const [previewLlmStatus, setPreviewLlmStatus] = useState<string | null>(null);
  const [previewConfirm, setPreviewConfirm] = useState<PendingPreviewConfirm | null>(null);

  // Multi-image upload dialog for the adaptive image mode (MY_ADAPTIVE).
  const adaptiveFileInputRef = useRef<HTMLInputElement | null>(null);
  const [adaptiveModal, setAdaptiveModal] = useState<{ action: "preview" | "apply" } | null>(null);
  const [adaptiveImageUrls, setAdaptiveImageUrls] = useState<string[]>([]);
  const [adaptiveUploading2, setAdaptiveUploading2] = useState(false);

  // Parameter dialogs aligned with the /preview page.
  const [paramModal, setParamModal] = useState<ParamModalState | null>(null);
  const [quoteDraft, setQuoteDraft] = useState("");
  const [authorDraft, setAuthorDraft] = useState("");
  const [weatherDraftLocation, setWeatherDraftLocation] = useState<LocationValue>({});
  const [memoDraft, setMemoDraft] = useState("");
  const [countdownName, setCountdownName] = useState("New Year");
  const [countdownDate, setCountdownDate] = useState("2027-01-01");
  const [habitItems, setHabitItems] = useState(
    isEn
      ? [{ name: "Wake up early", done: false }, { name: "Exercise", done: false }, { name: "Read", done: false }]
      : [{ name: "Wake up early", done: false }, { name: "Exercise", done: false }, { name: "Read", done: false }],
  );
  const [userAge, setUserAge] = useState(30);
  const [lifeExpectancy, setLifeExpectancy] = useState<100 | 120>(100);
  const [timetableData, setTimetableData] = useState<TimetableData>({
    style: "weekly",
    periods: ["08:00-09:30", "10:00-11:30", "14:00-15:30", "16:00-17:30"],
    courses: isEn
      ? {
          "0-0": "Calculus/A201", "0-2": "Linear Algebra/A201",
          "1-1": "English/B305", "1-3": "PE/Gym",
          "2-0": "Data Struct/C102", "2-2": "Networks/C102",
          "3-1": "Probability/A201", "3-3": "Politics/D405",
          "4-0": "OS/C102",
        }
      : {
          "0-0": "Advanced Mathematics/A201", "0-2": "Linear Algebra/A201",
          "1-1": "College English/B305", "1-3": "PE/Playground",
          "2-0": "Data Structures/C102", "2-2": "Computer Networks/C102",
          "3-1": "Probability Theory/A201", "3-3": "Modern Chinese History/D405",
          "4-0": "Operating Systems/C102",
        },
  });
  // Invitation-code dialog state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [redeemingInvite, setRedeemingInvite] = useState(false);
  const [pendingPreviewMode, setPendingPreviewMode] = useState<string | null>(null);
  const [, setCurrentMode] = useState<string>("");
  const [applyToScreenLoading, setApplyToScreenLoading] = useState(false);
  const [, setFavoritedModes] = useState<Set<string>>(new Set());
  const favoritesLoadedMacRef = useRef<string>("");
  const memoSettingsInputRef = useRef<HTMLTextAreaElement | null>(null);
  const previewStreamRef = useRef<EventSource | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("unknown");
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [isFocusListening, setIsFocusListening] = useState(false);
  const [alwaysActive, setAlwaysActive] = useState(false);
  const [focusToggleLoading, setFocusToggleLoading] = useState(false);
  const [focusAlertToken, setFocusAlertToken] = useState<string>("");
  const [showFocusTokenModal, setShowFocusTokenModal] = useState(false);

  const [customDesc, setCustomDesc] = useState("");
  const [customModeName, setCustomModeName] = useState("");
  const [customModeDescription, setCustomModeDescription] = useState("");
  const [customJson, setCustomJson] = useState("");
  const [customGenerating, setCustomGenerating] = useState(false);
  const [customPreviewImg, setCustomPreviewImg] = useState<string | null>(null);
  const [, setCustomPreviewLoading] = useState(false);
  const [editingCustomMode, setEditingCustomMode] = useState(false);
  const [customEditorSource, setCustomEditorSource] = useState<"ai" | "composer" | "json" | null>(null);
  const [customEditorTab, setCustomEditorTab] = useState<"ai" | "composer">("ai");
  const [composerCatalog, setComposerCatalog] = useState<ComposerCatalog | null>(null);
  const [composerState, setComposerState] = useState<ComposerState>({ layoutKind: "preset", bodyPreset: "", presetProps: {}, fragments: [], fragmentStack: {}, prompt: "", cacheable: true });
  const [composerSyncError, setComposerSyncError] = useState<string | null>(null);
  const [, setCustomJsonError] = useState<string | null>(null);
  const [composerPreviewUrl, setComposerPreviewUrl] = useState<string | null>(null);
  const [composerPreviewLoading, setComposerPreviewLoading] = useState(false);
  const [previewModeLabelOverride, setPreviewModeLabelOverride] = useState<string | null>(null);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);

  const [catalogItems, setCatalogItems] = useState<ModeCatalogItem[]>([]);

  const showToast = useCallback((msg: string, type: "success" | "error" | "info" = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const currentLocation = useMemo(
    () => buildLocationValue(city, locationMeta),
    [city, locationMeta],
  );
  const defaultWeatherLocation = useMemo(
    () => (currentLocation.city ? cleanLocationValue(currentLocation) : buildLocationValue("Hangzhou")),
    [currentLocation],
  );

  const applyGlobalLocation = useCallback((next: Partial<LocationValue> | null | undefined) => {
    const cleaned = cleanLocationValue(next);
    setCity(cleaned.city || "");
    setLocationMeta(cleaned);
  }, []);

  const replacePreviewImg = useCallback((nextUrl: string | null) => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    if (nextUrl) previewObjectUrlRef.current = nextUrl;
    setPreviewImg(nextUrl);
  }, []);

  const uploadLocalImage = useCallback(async (file: File): Promise<string> => {
    const fd = new FormData();
    fd.append("file", file);
    const up = await fetch("/api/uploads", { method: "POST", body: fd });
    if (!up.ok) {
      const err = await up.text().catch(() => "");
      throw new Error(err || `upload failed: ${up.status}`);
    }
    const data = (await up.json()) as { url?: string };
    if (!data.url) throw new Error("upload failed: missing url");
    return data.url;
  }, []);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, []);

  const nextConfigPath = useMemo(() => {
    const params = new URLSearchParams();
    if (mac) {
      params.set("mac", mac);
    } else {
      if (preferMac) params.set("prefer_mac", preferMac);
      if (prefillCode) params.set("code", prefillCode);
    }
    const query = params.toString();
    return query ? `${withLocalePath(locale, "/config")}?${query}` : withLocalePath(locale, "/config");
  }, [locale, mac, preferMac, prefillCode]);

  const refreshCatalog = useCallback(async () => {
    const params = new URLSearchParams();
    if (mac) params.append("mac", mac);
    try {
      const res = await fetch(`/api/modes/catalog?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) {
        console.error("[CONFIG] Catalog request failed:", res.status, res.statusText);
        return;
      }
      const data = await res.json().catch((err) => {
        console.error("[CONFIG] Failed to parse catalog JSON:", err);
        return {};
      });
      if (data.items && Array.isArray(data.items)) {
        setCatalogItems(data.items);
        setComposerCatalog((data.custom_mode_composer && typeof data.custom_mode_composer === "object")
          ? (data.custom_mode_composer as ComposerCatalog)
          : null);
      } else {
        console.error("[CONFIG] Invalid catalog response:", data);
      }
    } catch (err) {
      console.error("[CONFIG] Failed to load catalog:", err);
    }
  }, [mac]);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    if (!composerCatalog) return;
    setComposerState((prev) => {
      if (prev.bodyPreset || prev.fragments.length > 0) return prev;
      return defaultComposerState(composerCatalog);
    });
  }, [composerCatalog]);

  const syncComposerFromModeDef = useCallback((modeDef: unknown) => {
    const parsed = parseComposerModeDefinition(modeDef, composerCatalog);
    if (parsed.composer) {
      setComposerState(parsed.composer);
      setComposerSyncError(null);
      return true;
    }
    setComposerSyncError(parsed.error);
    return false;
  }, [composerCatalog]);

  const openCreateCustomMode = useCallback(() => {
    setCustomDesc("");
    setCustomModeName("");
    setCustomModeDescription("");
    setCustomJson("");
    setCustomJsonError(null);
    setCustomEditorSource(null);
    setComposerSyncError(null);
    setComposerState(defaultComposerState(composerCatalog));
    setCustomEditorTab("ai");
    setEditingCustomMode(true);
  }, [composerCatalog]);

  const handleComposerChange = useCallback((updater: (prev: ComposerState) => ComposerState) => {
    setCustomEditorSource("composer");
    setComposerState(updater);
    setComposerSyncError(null);
  }, []);

  const fetchComposerPreview = useCallback(async () => {
    if (!composerCatalog) return;
    const modeDef = buildComposerModeDefinition({
      composer: composerState,
      catalog: composerCatalog,
      modeName: customModeName || "Preview",
      modeDescription: customModeDescription,
      isEn,
    });
    setComposerPreviewLoading(true);
    try {
      const res = await fetch("/api/modes/custom/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode_def: modeDef, mac: mac || undefined, colors: previewColors, layout_only: true }),
      });
      if (!res.ok) {
        setComposerPreviewUrl(null);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setComposerPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch {
      setComposerPreviewUrl(null);
    } finally {
      setComposerPreviewLoading(false);
    }
  }, [composerCatalog, composerState, customModeName, customModeDescription, isEn, mac, previewColors]);

  useEffect(() => {
    if (!composerCatalog) return;
    if (customEditorSource !== "composer") return;
    const modeDef = buildComposerModeDefinition({
      composer: composerState,
      catalog: composerCatalog,
      modeName: customModeName,
      modeDescription: customModeDescription,
      isEn,
    });
    setCustomJson(JSON.stringify(modeDef, null, 2));
    setCustomEditorSource("composer");
    setCustomJsonError(null);
  }, [composerCatalog, composerState, customEditorSource, customModeDescription, customModeName, isEn]);

  useEffect(() => {
    if (mac && currentUser) {
      loadDeviceMembers(mac);
      loadPendingRequests();
    }
  }, [currentUser, loadDeviceMembers, loadPendingRequests, mac]);

  useEffect(() => {
    setMacAccessDenied(false);
  }, [mac]);

  useEffect(() => {
    if (!mac) return;
    fetch(`/api/device/${encodeURIComponent(mac)}/state`, { headers: authHeaders() })
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          setMacAccessDenied(true);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(async (d) => {
        if (!d?.last_persona) return;
        setCurrentMode(d.last_persona);
        setPreviewMode(d.last_persona);
      })
      .catch(() => {});
  }, [mac]);

  useEffect(() => {
    if (!mac) return;
    setLoading(true);
    fetch(`/api/config/${encodeURIComponent(mac)}`, { headers: authHeaders() })
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          setMacAccessDenied(true);
          throw new Error("Forbidden");
        }
        if (!r.ok) throw new Error("No config");
        return r.json();
      })
      .then((cfg: DeviceConfig) => {
        setConfig(cfg);
        if (cfg.modes?.length) setSelectedModes(new Set(cfg.modes.map((m) => m.toUpperCase())));
        if (cfg.refreshStrategy || cfg.refresh_strategy) setStrategy((cfg.refreshStrategy || cfg.refresh_strategy) as string);
        if (cfg.refreshInterval || cfg.refresh_minutes) setRefreshMin((cfg.refreshInterval || cfg.refresh_minutes) as number);
        applyGlobalLocation(extractLocationValue(cfg as Record<string, unknown>));
        setModeLanguage((cfg as Record<string, unknown>).modeLanguage as string || (cfg as Record<string, unknown>).mode_language as string || "zh");
        if (cfg.contentTone || cfg.content_tone) setContentTone(normalizeTone(cfg.contentTone || cfg.content_tone));
        if (cfg.characterTones || cfg.character_tones) setCharacterTones((cfg.characterTones || cfg.character_tones) as string[]);
        if (cfg.mode_overrides) setModeOverrides(cfg.mode_overrides);
        else if (cfg.modeOverrides) setModeOverrides(cfg.modeOverrides);
        setIsFocusListening(Boolean(cfg.is_focus_listening ?? Number(cfg.focus_listening || 0) === 1));
        setAlwaysActive(Boolean(cfg.is_always_active ?? Number(cfg.always_active || 0) === 1));
        const loadedOverrides = ((cfg.mode_overrides || cfg.modeOverrides || {}) as Record<string, ModeOverride>);
        const adaptiveOv = loadedOverrides?.MY_ADAPTIVE;
        if (adaptiveOv) {
          const urls = adaptiveOv.image_urls;
          if (Array.isArray(urls) && urls.length > 0) {
            setAdaptiveImageUrls(urls.filter((u: unknown) => typeof u === "string" && (u as string).trim()) as string[]);
          } else if (typeof adaptiveOv.image_url === "string" && (adaptiveOv.image_url as string).trim()) {
            setAdaptiveImageUrls([adaptiveOv.image_url as string]);
          }
        }
        const memoFromOverride = loadedOverrides?.MEMO?.memo_text;
        if (typeof memoFromOverride === "string" && memoFromOverride.trim()) {
          setMemoText(memoFromOverride);
        } else if (cfg.memoText || cfg.memo_text) {
          setMemoText((cfg.memoText || cfg.memo_text) as string);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [applyGlobalLocation, mac]);

  const getModeOverride = useCallback((modeId: string) => {
    return modeOverrides[modeId] || {};
  }, [modeOverrides]);

  const sanitizeModeOverride = useCallback((input: ModeOverride) => {
    const cleaned: ModeOverride = {};
    for (const [k, raw] of Object.entries(input)) {
      if (
        k === "city" ||
        k === "timezone" ||
        k === "admin1" ||
        k === "country" ||
        k === "llm_provider" ||
        k === "llm_model"
      ) {
        if (typeof raw === "string" && raw.trim()) cleaned[k] = raw.trim();
        continue;
      }
      if (k === "latitude" || k === "longitude") {
        if (typeof raw === "number" && Number.isFinite(raw)) cleaned[k] = raw;
        continue;
      }
      if (typeof raw === "string") {
        if (raw.trim()) cleaned[k] = raw.trim();
        continue;
      }
      if (typeof raw === "number") {
        if (!Number.isNaN(raw)) cleaned[k] = raw;
        continue;
      }
      if (typeof raw === "boolean") {
        cleaned[k] = raw;
        continue;
      }
      if (Array.isArray(raw)) {
        if (raw.length > 0) cleaned[k] = raw;
        continue;
      }
      if (raw && typeof raw === "object") {
        if (Object.keys(raw).length > 0) cleaned[k] = raw as Record<string, unknown>;
      }
    }
    return cleaned;
  }, []);

  const updateModeOverride = useCallback((modeId: string, patch: Partial<ModeOverride>) => {
    setModeOverrides((prev) => {
      const next = { ...(prev[modeId] || {}), ...patch } as ModeOverride;
      const cleaned = sanitizeModeOverride(next);
      if (!Object.keys(cleaned).length) {
        const copied = { ...prev };
        delete copied[modeId];
        return copied;
      }
      return { ...prev, [modeId]: cleaned };
    });
  }, [sanitizeModeOverride]);

  const requiresParamModal = useCallback((modeId: string) => {
    const m = (modeId || "").toUpperCase();
    return m === "WEATHER" || m === "MEMO" || m === "MY_QUOTE" || m === "COUNTDOWN" || m === "HABIT" || m === "LIFEBAR" || m === "CALENDAR" || m === "TIMETABLE";
  }, []);

  const openParamModal = useCallback((modeId: string, action: "preview" | "apply") => {
    const m = (modeId || "").toUpperCase();
    if (m === "WEATHER") {
      setWeatherDraftLocation({});
      setParamModal({ type: "weather", mode: m, action });
      return;
    }
    if (m === "MEMO") {
      const existing = (modeOverrides[m]?.memo_text as string) || memoText || "";
      setMemoDraft(existing);
      setParamModal({ type: "memo", mode: m, action });
      return;
    }
    if (m === "MY_QUOTE") {
      setQuoteDraft("");
      setAuthorDraft("");
      setParamModal({ type: "quote", mode: m, action });
      return;
    }
    if (m === "COUNTDOWN") {
      setParamModal({ type: "countdown", mode: m, action });
      return;
    }
    if (m === "HABIT") {
      const savedOv = modeOverrides["HABIT"] || {};
      const savedItems = Array.isArray(savedOv.habitItems) ? (savedOv.habitItems as Array<{ name: string; done?: boolean }>) : null;
      if (savedItems && savedItems.length > 0) {
        setHabitItems(savedItems.map((h) => ({ name: h.name, done: h.done ?? false })));
      }
      setParamModal({ type: "habit", mode: m, action });
      return;
    }
    if (m === "LIFEBAR") {
      setParamModal({ type: "lifebar", mode: m, action });
      return;
    }
    if (m === "CALENDAR") {
      setParamModal({ type: "calendar", mode: m, action });
      return;
    }
    if (m === "TIMETABLE") {
      const existing = (modeOverrides[m] || {}) as Record<string, unknown>;
      if (existing.periods && existing.courses) {
        setTimetableData({
          style: (existing.style as "daily" | "weekly") || "daily",
          periods: existing.periods as string[],
          courses: existing.courses as Record<string, string>,
        });
      }
      setParamModal({ type: "timetable", mode: m, action });
      return;
    }
  }, [memoText, modeOverrides]);

  const clearModeOverride = useCallback((modeId: string) => {
    setModeOverrides((prev) => {
      const copied = { ...prev };
      delete copied[modeId];
      return copied;
    });
    setSettingsJsonDrafts((prev) => {
      const copied = { ...prev };
      Object.keys(copied).forEach((k) => {
        if (k.startsWith(`${modeId}:`)) delete copied[k];
      });
      return copied;
    });
    setSettingsJsonErrors((prev) => {
      const copied = { ...prev };
      Object.keys(copied).forEach((k) => {
        if (k.startsWith(`${modeId}:`)) delete copied[k];
      });
      return copied;
    });
    if (modeId === "COUNTDOWN") {
      setConfig((prev) => ({
        ...prev,
        countdownEvents: [],
        countdown_events: [],
      }));
    }
  }, []);

  const modeSchemaMap = useMemo(
    () => Object.fromEntries(catalogItems.map((m) => [m.mode_id.toUpperCase(), m.settings_schema || []])),
    [catalogItems]
  );

  const applySettingsDrafts = useCallback((modeId: string) => {
    const schema = modeSchemaMap[modeId] || [];
    for (const item of schema) {
      if (!item.as_json) continue;
      const key = `${modeId}:${item.key}`;
      if (!(key in settingsJsonDrafts)) continue;
      const text = settingsJsonDrafts[key] || "";
      if (!text.trim()) {
        updateModeOverride(modeId, { [item.key]: undefined });
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        updateModeOverride(modeId, { [item.key]: parsed });
      } catch {
        setSettingsJsonErrors((prev) => ({ ...prev, [key]: tr("Invalid JSON", "Invalid JSON") }));
        showToast(`${item.label} ${tr("Invalid JSON", "Invalid JSON")}`, "error");
        return false;
      }
    }
    return true;
  }, [modeSchemaMap, settingsJsonDrafts, showToast, tr, updateModeOverride]);

  const handleSave = async () => {
    if (!mac) { showToast(tr("Please flash and provision to get the device MAC", "Please flash and provision to get the device MAC"), "error"); return; }
    if (macAccessDenied) { showToast(tr("No permission to configure this device", "No permission to configure this device"), "error"); return; }
    setSaving(true);
    try {
      const normalizedModeOverrides = Object.fromEntries(
        Object.entries(modeOverrides)
          .map(([modeId, ov]) => {
            const cleaned = sanitizeModeOverride(ov);
            return [modeId.toUpperCase(), cleaned] as const;
          })
          .filter(([, ov]) => Object.keys(ov).length > 0)
      );
      const body: Record<string, unknown> = {
        mac,
        modes: Array.from(selectedModes),
        refreshStrategy: strategy,
        refreshInterval: refreshMin,
        ...currentLocation,
        modeLanguage,
        contentTone,
        characterTones: characterTones,
        modeOverrides: normalizedModeOverrides,
        memoText: memoText,
        is_focus_listening: isFocusListening,
        always_active: alwaysActive,
        timeSlotRules: timeSlotRules,
      };
      const res = await fetch("/api/config", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      let onlineNow = isOnline;
      let refreshQueued = false;
      let latestLastSeen: string | null = lastSeen;
      const syncResult = await queueImmediateRefreshIfOnline(fetch, mac, authHeaders());
      onlineNow = syncResult.onlineNow ?? isOnline;
      refreshQueued = syncResult.refreshQueued;
      latestLastSeen = syncResult.lastSeen;
      if (syncResult.onlineNow !== null) {
        setIsOnline(syncResult.onlineNow);
      }
      setLastSeen(latestLastSeen);
      showToast(
        syncResult.onlineNow === null
          ? tr("Settings saved, but device status is currently unavailable", "Settings saved, but device status is currently unavailable")
          : onlineNow
            ? (refreshQueued
                ? tr("Settings saved, device notified to refresh now", "Settings saved, device notified to refresh now")
                : tr("Settings saved, device is online, but immediate refresh notification failed", "Settings saved, device is online, but immediate refresh notification failed"))
            : tr("Settings saved. Device is offline and will update when it comes online", "Settings saved. Device is offline and will update when it comes online"),
        syncResult.onlineNow === null || !refreshQueued ? "info" : "success",
      );
      setPreviewNoCacheOnce(true);
    } catch {
      showToast(tr("Save failed", "Save failed"), "error");
    } finally {
      setSaving(false);
    }
  };

  const [savingPrefs, setSavingPrefs] = useState(false);
  const handleSavePreferences = async () => {
    if (!mac) { showToast(tr("Please flash and provision to get the device MAC", "Please flash and provision to get the device MAC"), "error"); return; }
    if (macAccessDenied) { showToast(tr("No permission", "No permission"), "error"); return; }
    setSavingPrefs(true);
    try {
      const normalizedModeOverrides = Object.fromEntries(
        Object.entries(modeOverrides)
          .map(([modeId, ov]) => {
            const cleaned = sanitizeModeOverride(ov);
            return [modeId.toUpperCase(), cleaned] as const;
          })
          .filter(([, ov]) => Object.keys(ov).length > 0)
      );
      const body: Record<string, unknown> = {
        mac,
        modes: Array.from(selectedModes),
        refreshStrategy: strategy,
        refreshInterval: refreshMin,
        ...currentLocation,
        modeLanguage,
        contentTone,
        characterTones: characterTones,
        modeOverrides: normalizedModeOverrides,
        memoText: memoText,
        is_focus_listening: isFocusListening,
        always_active: alwaysActive,
        timeSlotRules: timeSlotRules,
      };
      const res = await fetch("/api/config", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      showToast(tr("Settings saved", "Settings saved"), "success");
      setPreviewNoCacheOnce(true);
    } catch {
      showToast(tr("Save failed", "Save failed"), "error");
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleToggleFocusListening = useCallback(async () => {
    if (!mac) return;
    const next = !isFocusListening;
    setFocusToggleLoading(true);
    try {
      const res = await fetch(
        `/api/config/${encodeURIComponent(mac)}/focus-listening?enabled=${next}`,
        { method: "PATCH", headers: authHeaders() },
      );
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        console.error("[FOCUS] Toggle failed:", res.status, errorText);
        throw new Error("focus-toggle-failed");
      }
      const data = (await res.json().catch(() => ({}))) as { alert_token?: string | null };
      setIsFocusListening(next);
      if (next && data?.alert_token) {
        setFocusAlertToken(data.alert_token);
        setShowFocusTokenModal(true);
      }
      showToast(
        next
          ? tr("Focus mode is ready, guarded by OpenCLAW", "Focus mode is ready, guarded by OpenCLAW")
          : tr("Focus listening disabled. The device will resume normal rotation", "Focus listening disabled. The device will resume normal rotation"),
        "success",
      );
    } catch (err) {
      console.error("[FOCUS] Toggle error:", err);
      showToast(tr("Failed to toggle Focus Listening. Please try again", "Failed to toggle Focus Listening. Please try again"), "error");
    } finally {
      setFocusToggleLoading(false);
    }
  }, [isFocusListening, mac, showToast, tr]);

  const buildPreviewParams = useCallback((mode?: string, forceNoCache = false, forcedModeOverride?: ModeOverride, clearSavedOverride = false) => {
    const m = mode || previewMode;
    const consumeNoCacheOnce = previewNoCacheOnce;
    const forceFresh = forceNoCache || consumeNoCacheOnce;
    const params = new URLSearchParams({ persona: m });
    if (mac) params.set("mac", mac);
    if (clearSavedOverride && m === "COUNTDOWN") {
      params.set("mode_override", JSON.stringify({ countdownEvents: [] }));
      if (previewColors > 2) params.set("colors", String(previewColors));
      if (forceFresh) params.set("no_cache", "1");
      return { m, params, consumeNoCacheOnce };
    }
    const modeOverrideSource = sanitizeModeOverride(
      clearSavedOverride
        ? {
            ...(m === "COUNTDOWN" ? { countdownEvents: [] } : {}),
            ...(forcedModeOverride || {}),
          }
        : {
            ...(modeOverrides[m] || {}),
            ...(forcedModeOverride || {}),
          }
    );
    const savedOverrides = (config.mode_overrides || config.modeOverrides || {}) as Record<string, ModeOverride>;
    const effectiveLocation = cleanLocationValue(
      modeOverrideSource.city
        ? extractLocationValue(modeOverrideSource as Record<string, unknown>)
        : currentLocation,
    );
    const savedEffectiveLocation = cleanLocationValue(
      savedOverrides[m]?.city
        ? extractLocationValue(savedOverrides[m] as Record<string, unknown>)
        : extractLocationValue(config as Record<string, unknown>),
    );
    const locationChanged = Boolean(effectiveLocation.city) && !locationsEqual(effectiveLocation, savedEffectiveLocation);

    const activeModeOverride = sanitizeModeOverride({
      ...modeOverrideSource,
      ...(locationChanged ? effectiveLocation : {}),
    });
    if (!clearSavedOverride && m === "MEMO" && memoText.trim() && !("memo_text" in activeModeOverride)) {
      activeModeOverride.memo_text = memoText.trim();
    }
    const hasModeOverride = Object.keys(activeModeOverride).length > 0;
    if (hasModeOverride) {
      params.set("mode_override", JSON.stringify(activeModeOverride));
    }
    if (m === "MEMO") {
      const memoCandidate = (
        typeof forcedModeOverride?.memo_text === "string" && forcedModeOverride.memo_text.trim()
          ? forcedModeOverride.memo_text
          : typeof activeModeOverride.memo_text === "string" && activeModeOverride.memo_text.trim()
          ? activeModeOverride.memo_text
          : memoText
      ).trim();
      if (memoCandidate) {
        params.set("memo_text", memoCandidate);
      }
    }
    if (locationChanged && effectiveLocation.city) params.set("city_override", effectiveLocation.city);
    if (previewColors > 2) params.set("colors", String(previewColors));
    if (forceFresh || locationChanged || hasModeOverride) params.set("no_cache", "1");
    return { m, params, consumeNoCacheOnce };
  }, [config, currentLocation, mac, memoText, modeOverrides, previewColors, previewMode, previewNoCacheOnce, sanitizeModeOverride]);

  const ownerUsername = useMemo(
    () => deviceMembers.find((member) => member.role === "owner")?.username || "",
    [deviceMembers],
  );

  const formatPreviewUsageText = useCallback((usageSource?: string) => {
    switch (usageSource) {
      case "current_user_api_key":
        return tr("Using your API key", "Using your API key");
      case "owner_api_key":
        return ownerUsername
          ? tr(`Using owner (${ownerUsername}) API key`, `Using ${ownerUsername}'s API key`)
          : tr("Using owner's API key", "Using owner's API key");
      case "owner_free_quota":
        return ownerUsername
          ? tr(`Using owner (${ownerUsername}) free quota`, `Using ${ownerUsername}'s free quota`)
          : tr("Using owner's free quota", "Using owner's free quota");
      case "current_user_free_quota":
        return tr("Using your free quota", "Using your free quota");
      default:
        return "";
    }
  }, [ownerUsername, tr]);

  const handlePreview = useCallback(async (mode?: string, forceNoCache = false, forcedModeOverride?: ModeOverride, confirmed = false, clearSavedOverride = false) => {
    const { m, params, consumeNoCacheOnce } = buildPreviewParams(mode, forceNoCache, forcedModeOverride, clearSavedOverride);
    if (!m) return;

    if (mac && !confirmed) {
      try {
        const intentParams = new URLSearchParams(params);
        intentParams.set("intent", "1");
        const intentRes = await fetch(`/api/preview?${intentParams.toString()}`, {
          cache: "no-store",
          headers: authHeaders(),
        });
        if (intentRes.ok) {
          const intentData = (await intentRes.json()) as {
            cache_hit?: boolean;
            usage_source?: string;
            requires_invite_code?: boolean;
            llm_mode_requires_quota?: boolean;
          };
          if (intentData.requires_invite_code) {
            setPreviewConfirm(null);
            setShowInviteModal(true);
            setPendingPreviewMode(m);
            setPreviewStatusText(formatPreviewUsageText(intentData.usage_source));
            return;
          }
          if (!intentData.cache_hit && intentData.llm_mode_requires_quota) {
            setPreviewConfirm({
              mode: m,
              forceNoCache,
              forcedModeOverride,
              usageSource: intentData.usage_source,
            });
            return;
          }
        }
      } catch {}
    }

    setPreviewConfirm(null);
    setPreviewCacheHit(null);
    setPreviewLlmStatus(null);
    setPreviewLoading(true);
    setPreviewStatusText(tr("Generating...", "Generating..."));
    try {
      previewStreamRef.current?.close();
      const stream = new EventSource(`/api/preview/stream?${params.toString()}`);
      previewStreamRef.current = stream;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        stream.addEventListener("status", (event) => {
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
            setPreviewStatusText(data.message || tr("Generating...", "Generating..."));
          } catch {
            setPreviewStatusText(tr("Generating...", "Generating..."));
          }
        });

        stream.addEventListener("error", (event) => {
          if (settled) return;
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as {
              error?: string;
              message?: string;
              requires_invite_code?: boolean;
              usage_source?: string;
            };
            if (data.requires_invite_code) {
              settled = true;
              stream.close();
              previewStreamRef.current = null;
              setPreviewConfirm(null);
              setShowInviteModal(true);
              setPendingPreviewMode(m);
              setPreviewStatusText(formatPreviewUsageText(data.usage_source));
              setPreviewLoading(false);
              resolve();
              return;
            }
            settled = true;
            stream.close();
            previewStreamRef.current = null;
            setPreviewLoading(false);
            reject(new Error(data.message || "Preview failed"));
          } catch {
            settled = true;
            stream.close();
            previewStreamRef.current = null;
            setPreviewLoading(false);
            reject(new Error("Preview failed"));
          }
        });

        stream.addEventListener("result", async (event) => {
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as {
              message?: string;
              image_url?: string;
              cache_hit?: boolean;
              preview_status?: string;
              llm_required?: boolean;
              usage_source?: string;
            };
            console.log("[PREVIEW] Result event received:", { hasImageUrl: !!data.image_url, message: data.message });
            if (!data.image_url) {
              settled = true;
              console.error("[PREVIEW] Missing image_url in result event");
              setPreviewLoading(false);
              reject(new Error("Preview image missing"));
              return;
            }
            settled = true;
            const imageResponse = await fetch(data.image_url, { cache: "no-store" });
            if (!imageResponse.ok) {
              setPreviewLoading(false);
              reject(new Error("Preview image unavailable"));
              return;
            }
            const imageBlob = await imageResponse.blob();
            const objectUrl = URL.createObjectURL(imageBlob);
            console.log("[PREVIEW] Setting preview image:", data.image_url.substring(0, 50) + "...");
            replacePreviewImg(objectUrl);
            setPreviewCacheHit(typeof data.cache_hit === "boolean" ? data.cache_hit : null);
            setPreviewStatusText(data.message || tr("Done", "Done"));
            const status = (data.preview_status || "").toLowerCase();
            const llmRequired = data.llm_required;
            if (status === "no_llm_required" || llmRequired === false) {
              setPreviewLlmStatus(null);
            } else if (status === "model_generated") {
              setPreviewLlmStatus("Model call succeeded");
            } else if (status === "fallback_used") {
              setPreviewLlmStatus("Model call failed, using fallback content");
            } else {
              setPreviewLlmStatus(null);
            }
            setPreviewLoading(false); // Reset loading state.
            stream.close();
            previewStreamRef.current = null;
            resolve();
          } catch (error) {
            console.error("[PREVIEW] Error processing result event:", error);
            setPreviewLoading(false);
            reject(error);
          }
        });

        stream.onerror = () => {
          if (settled) return;
          settled = true;
          stream.close();
          previewStreamRef.current = null;
          setPreviewLoading(false);
          reject(new Error("Preview failed"));
        };
      });
    } catch {
      showToast(tr("Preview failed", "Preview failed"), "error");
      setPreviewCacheHit(null);
      setPreviewStatusText("");
    } finally {
      setPreviewLoading(false);
      if (consumeNoCacheOnce) setPreviewNoCacheOnce(false);
    }
  }, [buildPreviewParams, formatPreviewUsageText, isEn, mac, replacePreviewImg, showToast, tr]);

  const handleRedeemInviteCode = async () => {
    if (!inviteCode.trim()) {
      showToast("Please enter an invitation code", "error");
      return;
    }

    setRedeemingInvite(true);
    try {
      const res = await fetch("/api/auth/redeem-invite-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite_code: inviteCode.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to redeem invitation code");
      }

      showToast(data.message || "Invitation code redeemed successfully", "success");
      setShowInviteModal(false);
      setInviteCode("");
      // Retry the preview after a successful redemption.
      if (pendingPreviewMode) {
        await handlePreview(pendingPreviewMode, true);
        setPendingPreviewMode(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to redeem invitation code";
      showToast(msg, "error");
    } finally {
      setRedeemingInvite(false);
    }
  };

  const loadStats = useCallback(async () => {
    if (!mac) return;
    try {
      const res = await fetch(`/api/stats/${encodeURIComponent(mac)}`, { headers: authHeaders() });
      if (res.ok) setStats(await res.json());
    } catch {}
  }, [mac]);

  const loadFavorites = useCallback(async (force = false) => {
    if (!mac) return;
    if (!force && favoritesLoadedMacRef.current === mac) return;
    try {
      const res = await fetch(`/api/device/${encodeURIComponent(mac)}/favorites?limit=100`, { headers: authHeaders() });
      if (res.status === 401 || res.status === 403) {
        setMacAccessDenied(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const modes = new Set<string>(
        (data.favorites || [])
          .map((item: { mode_id?: string }) => (item.mode_id || "").toUpperCase())
          .filter((modeId: string) => modeId.length > 0),
      );
      setFavoritedModes(modes);
      favoritesLoadedMacRef.current = mac;
    } catch {}
  }, [mac]);

  const loadRuntimeMode = useCallback(async () => {
    if (!mac) return;
    try {
      const res = await fetch(`/api/device/${encodeURIComponent(mac)}/state`, { cache: "no-store", headers: authHeaders() });
      if (res.status === 401 || res.status === 403) {
        setMacAccessDenied(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setIsOnline(Boolean(data?.is_online));
      setLastSeen(typeof data?.last_seen === "string" && data.last_seen ? data.last_seen : null);
      const mode = data?.runtime_mode;
      if (mode === "active" || mode === "interval") {
        setRuntimeMode(mode);
      } else {
        setRuntimeMode("interval");
      }
    } catch {
      setIsOnline(false);
      setLastSeen(null);
      setRuntimeMode("interval");
    }
  }, [mac]);

  useEffect(() => {
    if (activeTab === "stats" && mac) loadStats();
  }, [activeTab, mac, loadStats]);

  useEffect(() => {
    if (!mac) return;
    favoritesLoadedMacRef.current = "";
    loadFavorites();
  }, [mac, loadFavorites]);

  useEffect(() => {
    if (!mac) return;
    loadRuntimeMode();
  }, [mac, loadRuntimeMode]);

  useEffect(() => {
    if (!mac || !currentUser) {
      setSettingsMode(null);
    }
  }, [mac, currentUser]);

  useEffect(() => {
    return () => {
      previewStreamRef.current?.close();
      previewStreamRef.current = null;
    };
  }, []);

  const handleGenerateMode = async () => {
    if (!customDesc.trim()) { showToast(tr("Please enter a mode description", "Please enter a mode description"), "error"); return; }
    setCustomGenerating(true);
    try {
      const res = await fetch("/api/modes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          description: customDesc, 
          provider: "deepseek", 
          model: "deepseek-chat",
          mac: mac || undefined,
        }),
      });

      // Quota exhausted: the backend returns 402 per BILLING.md.
      if (res.status === 402) {
        const d = await res.json().catch(() => ({}));
        showToast(
          (d && d.error) || "Your free quota has been exhausted, please redeem an invitation code or configure your own API key in your profile.",
          "error",
        );
        setShowInviteModal(true);
        setCustomGenerating(false);
        return;
      }

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || tr("Generation failed", "Generation failed"));
      setCustomJson(JSON.stringify(data.mode_def, null, 2));
      setCustomJsonError(null);
      setCustomModeName((data.mode_def?.display_name || "").toString());
      setCustomModeDescription((data.mode_def?.description || "").toString());
      setCustomEditorSource("ai");
      setCustomEditorTab("composer");
      syncComposerFromModeDef(data.mode_def);
      showToast(tr("Mode generated successfully", "Mode generated successfully"), "success");

      // Close modal right after generation, then start preview on the right panel
      const finalName = (customModeName || data.mode_def?.display_name || "").toString().trim();
      setPreviewModeLabelOverride(finalName || null);
      setEditingCustomMode(false);
      requestAnimationFrame(() => {
        previewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });

      // show "previewing" on the right panel while preview is being built
      setPreviewLoading(true);
      setPreviewStatusText("Generating preview...");

      await handleCustomPreview(data.mode_def);
    } catch (e) {
      showToast(`${tr("Generation failed", "Generation failed")}: ${e instanceof Error ? e.message : tr("Unknown error", "Unknown error")}`, "error");
    } finally {
      setCustomGenerating(false);
    }
  };

  const handleCustomPreview = async (defOverride?: unknown) => {
    if (!defOverride && !customJson.trim()) return;
    setCustomPreviewLoading(true);
    setPreviewLoading(true);
    if (!previewStatusText) setPreviewStatusText("Generating preview...");
    try {
      const def = defOverride ? (defOverride as Record<string, unknown>) : (JSON.parse(customJson) as Record<string, unknown>);
      if (customModeName.trim()) {
        (def as Record<string, unknown>).display_name = customModeName.trim();
      }
      if (customModeDescription.trim()) {
        (def as Record<string, unknown>).description = customModeDescription.trim();
      }
      const modeIdRaw = (def as Record<string, unknown>).mode_id;
      if (typeof modeIdRaw !== "string" || !modeIdRaw.trim()) {
        (def as Record<string, unknown>).mode_id = normalizeModeIdFromName(customModeName || "Custom Preview");
      }
      let modeHint = "CUSTOM_PREVIEW";
      try {
        if (customModeName.trim()) {
          modeHint = customModeName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        } else {
          const modeIdRaw = (def as Record<string, unknown>)["mode_id"];
          if (typeof modeIdRaw === "string" && modeIdRaw.trim()) {
            modeHint = modeIdRaw.trim().toUpperCase();
          }
        }
      } catch {}
      const res = await fetch("/api/modes/custom/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode_def: def, mac: mac || undefined, colors: previewColors }),
      });

      // Quota exhausted: the backend returns 402.
      if (res.status === 402) {
        const d = await res.json().catch(() => ({}));
        showToast(
          (d && d.error) || "Your free quota has been exhausted, please redeem an invitation code or configure your own API key in your profile.",
          "error",
        );
        setShowInviteModal(true);
        setCustomPreviewLoading(false);
        return;
      }

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || tr("Preview failed", "Preview failed"));
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (customPreviewImg) {
        try { URL.revokeObjectURL(customPreviewImg); } catch {}
      }
      setCustomPreviewImg(objectUrl);

      // show custom-mode preview in the right E-Ink panel
      setPreviewMode(modeHint);
      setPreviewCacheHit(null);
      const status = (res.headers.get("x-preview-status") || "").toLowerCase();
      const llmRequiredHeader = (res.headers.get("x-llm-required") || "").toLowerCase();
      if (status === "no_llm_required" || llmRequiredHeader === "0" || llmRequiredHeader === "false") {
        setPreviewLlmStatus(null);
      } else if (status === "model_generated") {
        setPreviewLlmStatus("Model call succeeded");
      } else if (status === "fallback_used") {
        setPreviewLlmStatus("Model call failed, using fallback content");
      } else {
        setPreviewLlmStatus(null);
      }
      replacePreviewImg(objectUrl);
    } catch (e) {
      if (e instanceof SyntaxError) {
        setCustomJsonError(e.message);
      }
      showToast(`${tr("Preview failed", "Preview failed")}: ${e instanceof Error ? e.message : ""}`, "error");
    } finally {
      setCustomPreviewLoading(false);
      setPreviewLoading(false);
    }
  };

  const handleSaveCustomMode = async () => {
    if (!customJson.trim()) return;
    if (!mac) {
      showToast(tr("Please select a device first", "Please select a device first"), "error");
      return;
    }
    try {
      const def = JSON.parse(customJson);
      
      // Ensure mode_id exists - generate from display_name if missing
      if (!def.mode_id || !def.mode_id.trim()) {
        if (customModeName.trim()) {
          def.mode_id = customModeName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
          // Ensure it starts with a letter
          if (!/^[A-Z]/.test(def.mode_id)) {
            def.mode_id = "CUSTOM_" + def.mode_id;
          }
        } else if (def.display_name) {
          def.mode_id = def.display_name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
          if (!/^[A-Z]/.test(def.mode_id)) {
            def.mode_id = "CUSTOM_" + def.mode_id;
          }
        } else {
          // Generate a random mode_id if no name is available
          def.mode_id = "CUSTOM_" + Math.random().toString(36).substring(2, 10).toUpperCase();
        }
      }
      
      if (customModeName.trim()) {
        def.display_name = customModeName.trim();
      }
      if (customModeDescription.trim()) {
        def.description = customModeDescription.trim();
      }
      
      // Add mac to the request body
      def.mac = mac;
      
      const res = await fetch("/api/modes/custom", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(def),
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `${tr("Save failed", "Save failed")}: ${res.status}`);
      }
      
      const data = await res.json();
      if (data.ok || data.status === "ok") {
        showToast(`${tr("Mode", "Mode")} ${def.mode_id} ${tr("saved", "saved")}`, "success");
        // Refresh catalog (modes + categories + settings schema)
        refreshCatalog();
        setEditingCustomMode(false);
        setCustomJson("");
        setCustomDesc("");
        setCustomModeName("");
        setCustomModeDescription("");
        if (customPreviewImg) {
          try { URL.revokeObjectURL(customPreviewImg); } catch {}
        }
        setCustomPreviewImg(null);
        setCustomEditorSource(null);
      } else {
        throw new Error(data.error || tr("Save failed", "Save failed"));
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        setCustomJsonError(e.message);
      }
      showToast(`${tr("Save failed", "Save failed")}: ${e instanceof Error ? e.message : ""}`, "error");
    }
  };

  const toggleMode = useCallback((modeId: string) => {
    setSelectedModes((prev) => {
      const next = new Set(prev);
      if (next.has(modeId)) next.delete(modeId);
      else next.add(modeId);
      return next;
    });
  }, []);

  const handleModePreview = (m: string) => {
    const modeId = (m || "").toUpperCase();
    setPreviewMode(modeId);
    if (modeId === "MY_ADAPTIVE") {
      setAdaptiveModal({ action: "preview" });
      return;
    }
    if (requiresParamModal(modeId)) {
      openParamModal(modeId, "preview");
      return;
    }
    // Config page preview should bypass cache so it:
    // - reflects latest overrides
    // - triggers quota deduction when applicable (quota is only deducted on cache miss)
    handlePreview(modeId, true);
  };

  const handleModeApply = async (m: string) => {
    const modeId = (m || "").toUpperCase();
    if (modeId === "MY_ADAPTIVE" && !selectedModes.has(modeId)) {
      setAdaptiveModal({ action: "apply" });
      return;
    }
    if (requiresParamModal(modeId) && !selectedModes.has(modeId)) {
      // only require params when adding to carousel
      openParamModal(modeId, "apply");
      return;
    }
    const wasSelected = selectedModes.has(modeId);
    toggleMode(modeId);
    showToast(
      wasSelected
        ? tr("Removed from rotation", "Removed from rotation")
        : tr("Added to rotation", "Added to rotation"),
      "success",
    );
  };

  const handleCustomModeDelete = async (m: string) => {
    const modeId = (m || "").toUpperCase();
    if (!mac) {
      showToast(tr("Please select a device first", "Please select a device first"), "error");
      return;
    }
    const confirmed = window.confirm(
      tr(`Delete custom mode ${modeId}?`, `Delete custom mode ${modeId}?`),
    );
    if (!confirmed) return;
    try {
      const res = await fetch(
        `/api/modes/custom/${encodeURIComponent(modeId)}?mac=${encodeURIComponent(mac)}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      const data = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(data.error || tr("Delete failed", "Delete failed"));
      }
      setSelectedModes((prev) => {
        const next = new Set(prev);
        next.delete(modeId);
        return next;
      });
      setModeOverrides((prev) => {
        const copied = { ...prev };
        delete copied[modeId];
        return copied;
      });
      if (previewMode === modeId) {
        setPreviewMode("");
      }
      if (settingsMode === modeId) {
        setSettingsMode(null);
      }
      refreshCatalog();
      showToast(tr("Custom mode deleted", "Custom mode deleted"), "success");
    } catch (e) {
      showToast(`${tr("Delete failed", "Delete failed")}: ${e instanceof Error ? e.message : ""}`, "error");
    }
  };

  const commitModalAction = useCallback(async (modeId: string, action: "preview" | "apply", forcedOverride?: ModeOverride, clearSavedOverride = false) => {
    setParamModal(null);
    if (clearSavedOverride) {
      clearModeOverride(modeId);
    } else if (forcedOverride && Object.keys(forcedOverride).length > 0) {
      updateModeOverride(modeId, forcedOverride);
      if (modeId === "MEMO" && typeof forcedOverride.memo_text === "string") {
        setMemoText(forcedOverride.memo_text);
      }
      if (modeId === "WEATHER" && typeof forcedOverride.city === "string") {
        // keep global city as-is; weather override is per-mode
      }
    }

    setPreviewMode(modeId);
    await handlePreview(modeId, true, forcedOverride, false, clearSavedOverride);

    if (action === "apply") {
      if (!selectedModes.has(modeId)) {
        toggleMode(modeId);
        showToast(tr("Added to rotation", "Added to rotation"), "success");
      }
    }
  }, [clearModeOverride, handlePreview, selectedModes, showToast, toggleMode, tr, updateModeOverride]);

  const handlePreviewFromSettings = (addToCarousel: boolean) => {
    if (!settingsMode) return;
    const modeId = settingsMode;
    if (!applySettingsDrafts(modeId)) return;
    let forcedOverride: ModeOverride | undefined;
    if (modeId === "MEMO") {
      const latestMemo = memoSettingsInputRef.current?.value ?? "";
      if (latestMemo.trim()) {
        forcedOverride = { memo_text: latestMemo };
        updateModeOverride(modeId, { memo_text: latestMemo });
        setMemoText(latestMemo);
      }
    }
    if (addToCarousel && !selectedModes.has(modeId)) {
      toggleMode(modeId);
    }
    setSettingsMode(null);
    setPreviewMode(modeId);
    setTimeout(() => {
      handlePreview(modeId, true, forcedOverride);
    }, 0);
    showToast(
      addToCarousel
        ? tr("Added to rotation and preview refreshed", "Added to rotation and preview refreshed")
        : tr("Preview refreshed", "Preview refreshed"),
      "success",
    );
  };

  const handleApplyPreviewToScreen = async () => {
    if (!mac || !previewMode || !previewImg) return;
    setApplyToScreenLoading(true);
    try {
      const stateRes = await fetch(`/api/device/${encodeURIComponent(mac)}/state`, { cache: "no-store", headers: authHeaders() });
      if (!stateRes.ok) {
        showToast(tr("Unable to verify device status. Sending was blocked", "Unable to verify device status. Sending was blocked"), "error");
        return;
      }
      const stateData = await stateRes.json();
      const mode = stateData?.runtime_mode;
      if (mode === "active" || mode === "interval") {
        setRuntimeMode(mode);
      }
      if (mode !== "active") {
        showToast(tr("Device is in interval mode and cannot receive content", "Device is in interval mode and cannot receive content"), "error");
        return;
      }

      const previewResponse = await fetch(previewImg);
      if (!previewResponse.ok) throw new Error("preview image unavailable");
      const previewBlob = await previewResponse.blob();

      const qs = new URLSearchParams();
      qs.set("mode", previewMode);
      const res = await fetch(`/api/device/${encodeURIComponent(mac)}/apply-preview?${qs.toString()}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "image/png" }),
        body: previewBlob,
      });
      if (!res.ok) throw new Error("apply-preview failed");
      setCurrentMode(previewMode);
      await loadRuntimeMode();
      showToast(tr("Sent to E-Ink", "Sent to E-Ink"), "success");
    } catch {
      showToast(tr("Send failed", "Send failed"), "error");
    } finally {
      setApplyToScreenLoading(false);
    }
  };

  const handleAddCustomPersona = () => {
    const v = customPersonaTone.trim();
    if (!v) return;
    setCharacterTones((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setCustomPersonaTone("");
  };

  const modeMeta = useMemo(() => {
    const map: Record<string, { name: string; tip: string }> = {};
    for (const item of catalogItems) {
      const mid = (item.mode_id || "").toUpperCase();
      if (!mid) continue;
      const lang = isEn ? item.i18n?.en : item.i18n?.zh;
      const name = (lang?.name && String(lang.name)) || (item.display_name && String(item.display_name)) || mid;
      const tip = (lang?.tip && String(lang.tip)) || (item.description && String(item.description)) || "";
      map[mid] = { name, tip };
    }
    return map;
  }, [catalogItems, isEn]);

  const coreModes = useMemo(
    () => catalogItems.filter((m) => m.category === "core").map((m) => m.mode_id.toUpperCase()),
    [catalogItems],
  );
  const extraModes = useMemo(
    () => catalogItems.filter((m) => m.category === "more").map((m) => m.mode_id.toUpperCase()),
    [catalogItems],
  );
  const customModes = useMemo(
    () => catalogItems.filter((m) => m.category === "custom").map((m) => m.mode_id.toUpperCase()),
    [catalogItems],
  );
  const customModeMeta = useMemo(
    () =>
      Object.fromEntries(
        catalogItems
          .filter((m) => m.category === "custom")
          .map((m) => {
            const lang = isEn ? m.i18n?.en : m.i18n?.zh;
            return [
              m.mode_id.toUpperCase(),
              {
                name: (lang?.name && String(lang.name)) || m.display_name || m.mode_id,
                tip: (lang?.tip && String(lang.tip)) || m.description || "",
              },
            ];
          }),
      ),
    [catalogItems, isEn],
  );
  const activeModeSchema = settingsMode ? (modeSchemaMap[settingsMode] || []) : [];

  const batteryPct = stats?.last_battery_voltage
    ? Math.min(100, Math.max(0, Math.round((stats.last_battery_voltage / 3.3) * 100)))
    : null;
  const currentDeviceMembership = userDevices.find((d) => d.mac.toUpperCase() === mac.toUpperCase()) || null;
  const denyByMembership = Boolean(mac && currentUser && !devicesLoading && !currentDeviceMembership);
  const currentUserRole = currentDeviceMembership?.role || "";
  const formatPreviewConfirmText = useCallback((usageSource?: string) => {
    switch (usageSource) {
      case "current_user_api_key":
        return tr("This preview will use your API key. Continue?", "This preview will use your API key. Continue?");
      case "owner_api_key":
        return ownerUsername
          ? tr(`This preview will use owner (${ownerUsername}) API key. Continue?`, `This preview will use ${ownerUsername}'s API key. Continue?`)
          : tr("This preview will use the owner's API key. Continue?", "This preview will use the owner's API key. Continue?");
      case "owner_free_quota":
        return ownerUsername
          ? tr(`This preview will use owner (${ownerUsername}) free quota. Continue?`, `This preview will use ${ownerUsername}'s free quota. Continue?`)
          : tr("This preview will use the owner's free quota. Continue?", "This preview will use the owner's free quota. Continue?");
      case "current_user_free_quota":
        return tr("This preview will use your free quota. Continue?", "This preview will use your free quota. Continue?");
      default:
        return tr("No cache hit. A new preview will be generated. Continue?", "No cache hit. A new preview will be generated. Continue?");
    }
  }, [ownerUsername, tr]);
  const statusLabel = !isOnline
    ? tr("Offline", "Offline")
    : runtimeMode === "active"
    ? tr("Active", "Active")
    : tr("Interval", "Interval");
  const statusClass = !isOnline
    ? "bg-paper-dark text-ink-light border border-ink/10"
    : runtimeMode === "active"
    ? "bg-green-50 text-green-700 border border-green-200"
    : "bg-amber-50 text-amber-700 border border-amber-200";
  const statusIconClass = !isOnline
    ? "text-ink-light"
    : runtimeMode === "active"
    ? "text-green-600"
    : "text-amber-600";
  const tabs = isEn
    ? [
        { id: "modes", label: "Modes", icon: Settings },
        { id: "preferences", label: "Preferences", icon: Sliders },
        { id: "sharing", label: "Sharing", icon: Users },
        { id: "stats", label: "Status", icon: BarChart3 },
      ] as const
    : TABS;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      {/* Hidden file picker for MY_ADAPTIVE multi-image upload */}
      <input
        ref={adaptiveFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0] || null;
          e.currentTarget.value = "";
          if (!f) return;
          setAdaptiveUploading2(true);
          try {
            const url = await uploadLocalImage(f);
            setAdaptiveImageUrls((prev) => {
              if (prev.length >= 6) return prev;
              return [...prev, url];
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : tr("Please choose a local image", "Please choose a local image");
            showToast(msg, "error");
          } finally {
            setAdaptiveUploading2(false);
          }
        }}
      />
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-serif text-3xl font-bold text-ink mb-2">{tr("Device Configuration", "Device Configuration")}</h1>
        {currentUser === undefined ? (
          <div className="flex items-center gap-2 text-ink-light text-sm py-4">
            <Loader2 size={16} className="animate-spin" /> {tr("Loading...", "Loading...")}
          </div>
        ) : currentUser === null ? (
          <div className="flex items-start gap-2 p-3 rounded-sm border border-amber-200 bg-amber-50 text-sm text-amber-800">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">{tr("Please sign in first", "Please sign in first")}</p>
              <p className="text-xs mt-0.5">{mac ? tr("Sign in to configure this device.", "Sign in to configure this device.") : tr("Sign in to manage your device list.", "Sign in to manage your device list.")}</p>
              <Link href={`${withLocalePath(locale, "/login")}?next=${encodeURIComponent(nextConfigPath)}`}>
                <Button size="sm" className="mt-2">{tr("Sign In / Sign Up", "Sign In / Sign Up")}</Button>
              </Link>
            </div>
          </div>
        ) : (macAccessDenied || denyByMembership) ? (
          <div className="flex items-start gap-2 p-3 rounded-sm border border-red-200 bg-red-50 text-sm text-red-800">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">{tr("No permission to access this device", "No permission to access this device")}</p>
              <p className="text-xs mt-0.5">{tr("This device is not bound to your account, or you are not an authorized member.", "This device is not bound to your account, or you are not an authorized member.")}</p>
              <Link href={withLocalePath(locale, "/config")}>
                <Button size="sm" variant="outline" className="mt-2">{tr("Back to Device List", "Back to Device List")}</Button>
              </Link>
            </div>
          </div>
        ) : mac ? (
          <DeviceInfo
            mac={mac}
            currentUserRole={currentUserRole}
            statusIconClass={statusIconClass}
            statusClass={statusClass}
            statusLabel={statusLabel}
            lastSeen={lastSeen}
            isEn={isEn}
            localeConfigPath={withLocalePath(locale, "/config")}
            tr={tr}
            isFocusListening={isFocusListening}
            onToggleFocus={handleToggleFocusListening}
            focusToggleLoading={focusToggleLoading}
          />
        ) : (
          <div className="space-y-4">
            {requestsLoading ? (
              <div className="flex items-center gap-2 text-ink-light text-sm py-2">
                <Loader2 size={16} className="animate-spin" /> {tr("Loading pending requests...", "Loading pending requests...")}
              </div>
            ) : pendingRequests.length > 0 ? (
              <div className="p-3 rounded-sm border border-amber-200 bg-amber-50">
                <p className="text-sm font-medium text-amber-900 mb-2">{tr("Pending binding requests", "Pending binding requests")}</p>
                <div className="space-y-2">
                  {pendingRequests.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                      <div>
                        <p className="font-medium text-amber-900">{item.requester_username}</p>
                        <p className="text-xs text-amber-800 font-mono">{item.mac}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => handleRejectRequest(item.id)}>{tr("Reject", "Reject")}</Button>
                        <Button size="sm" onClick={() => handleApproveRequest(item.id)}>{tr("Approve", "Approve")}</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="p-3 rounded-sm border border-ink/10 bg-paper">
              <p className="text-sm font-medium text-ink mb-2 flex items-center gap-1">
                <Monitor size={14} /> {tr("Pair Device", "Pair Device")}
              </p>
              <p className="text-xs text-ink-light mb-3">{tr("Find the pair code in the device portal page, then claim or request binding.", "Find the pair code in the device portal page, then claim or request binding.")}</p>
              <div className="flex gap-2 flex-wrap items-center">
                <input
                  value={pairCodeInput}
                  onChange={(e) => setPairCodeInput(e.target.value.toUpperCase())}
                  placeholder={tr("Pair Code", "Pair Code")}
                  className="w-full sm:w-64 rounded-sm border border-ink/20 px-3 py-1.5 text-sm font-mono uppercase tracking-[0.2em]"
                />
                <Button size="sm" variant="outline" onClick={handlePairDevice} disabled={!pairCodeInput.trim() || pairingDevice}>
                  {pairingDevice ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
                  {tr("Pair Now", "Pair Now")}
                </Button>
              </div>
            </div>

            <div className="p-3 rounded-sm border border-ink/10 bg-paper">
              <p className="text-sm font-medium text-ink mb-2 flex items-center gap-1">
                <Plus size={14} /> {tr("Bind by MAC", "Bind by MAC")}
              </p>
              <p className="text-xs text-ink-light mb-3">{tr("Pair code is recommended first.", "Pair code is recommended first.")}</p>
              <div className="flex gap-2 flex-wrap items-center">
                <input
                  value={bindMacInput}
                  onChange={(e) => setBindMacInput(e.target.value)}
                  placeholder={tr("MAC address (e.g. AA:BB:CC:DD:EE:FF)", "MAC address (e.g. AA:BB:CC:DD:EE:FF)")}
                  className="w-full sm:w-[360px] rounded-sm border border-ink/20 px-3 py-1.5 text-sm font-mono"
                />
                <input
                  value={bindNicknameInput}
                  onChange={(e) => setBindNicknameInput(e.target.value)}
                  placeholder={tr("Nickname (optional)", "Nickname (optional)")}
                  className="w-32 rounded-sm border border-ink/20 px-3 py-1.5 text-sm"
                />
                <Button size="sm" variant="outline" onClick={async () => {
                  const targetMac = bindMacInput.trim();
                  if (!targetMac) return;
                  const result = await handleBindDevice(targetMac, bindNicknameInput.trim());
                  if (!result) return;
                  if (result.status === "claimed" || result.status === "active") {
                    showToast(tr("Device bound", "Device bound"), "success");
                    window.location.href = `${withLocalePath(locale, "/config")}?mac=${encodeURIComponent(targetMac)}`;
                    return;
                  }
                  if (result.status === "pending_approval") {
                    showToast(tr("Binding request submitted. Waiting for owner approval", "Binding request submitted. Waiting for owner approval"), "info");
                  }
                }}>
                  {tr("Bind", "Bind")}
                </Button>
              </div>
            </div>

            {/* Device list */}
            {devicesLoading ? (
              <div className="flex items-center gap-2 text-ink-light text-sm py-4">
                <Loader2 size={16} className="animate-spin" /> {tr("Loading devices...", "Loading devices...")}
              </div>
            ) : userDevices.length > 0 ? (
              <div className="space-y-2">
                {userDevices.map((d) => (
                  <div key={d.mac} className="flex items-center justify-between p-3 rounded-sm border border-ink/10 bg-paper hover:border-ink/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <Monitor size={18} className="text-ink-light" />
                      <div>
                        <p className="text-sm font-medium text-ink">
                          {d.nickname || d.mac}
                        </p>
                        {d.nickname && (
                          <p className="text-xs text-ink-light font-mono">{d.mac}</p>
                        )}
                        <p className="text-xs text-ink-light">
                          {tr("Role", "Role")}: {d.role === "owner" ? "Owner" : "Member"}
                        </p>
                        <p className="text-xs text-ink-light">
                          {d.last_seen
                            ? `${tr("Last seen", "Last seen")}: ${new Date(d.last_seen).toLocaleString(isEn ? "en-US" : "zh-CN")}`
                            : tr("Never online", "Never online")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link href={`${withLocalePath(locale, "/config")}?mac=${encodeURIComponent(d.mac)}`}>
                        <Button size="sm" variant="outline">
                          <Settings size={14} className="mr-1" /> {tr("Configure", "Configure")}
                        </Button>
                      </Link>
                      <button
                        onClick={() => handleUnbindDevice(d.mac)}
                        className="p-1.5 text-ink-light hover:text-red-600 transition-colors"
                        title={tr("Unbind device", "Unbind device")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-start gap-2 p-3 rounded-sm border border-amber-200 bg-amber-50 text-sm text-amber-800">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">{tr("No bound devices", "No bound devices")}</p>
                  <p className="text-xs mt-0.5">{tr("There are no devices under this account yet.", "There are no devices under this account yet.")}</p>
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {mac && currentUser && !(macAccessDenied || denyByMembership) && loading && (
        <div className="flex items-center justify-center py-20 text-ink-light">
          <Loader2 size={24} className="animate-spin mr-2" /> {tr("Loading configuration...", "Loading configuration...")}
        </div>
      )}

      {mac && currentUser && !(macAccessDenied || denyByMembership) && !loading && (
        <div className="space-y-4">
          <div className="flex gap-6">
            {/* Sidebar tabs */}
            <nav className="w-44 flex-shrink-0 hidden md:block">
            <div className="sticky top-24 space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-sm text-sm transition-colors ${
                    activeTab === tab.id
                      ? "bg-ink text-white font-medium"
                      : "text-ink-light hover:bg-paper-dark hover:text-ink"
                  }`}
                >
                  <tab.icon size={16} />
                  {tab.label}
                </button>
              ))}
              <div className="pt-4">
                <Button
                  variant="outline"
                  onClick={handleSave}
                  disabled={!mac || saving}
                  className="w-full bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : <Save size={14} className="mr-1" />}
                  {tr("Save to Device", "Save to Device")}
                </Button>
              </div>
            </div>
          </nav>

            {/* Mobile tabs */}
            <div className="md:hidden w-full mb-4 overflow-x-auto">
            <div className="flex gap-1 min-w-max pb-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-2 rounded-sm text-xs whitespace-nowrap transition-colors ${
                    activeTab === tab.id ? "bg-ink text-white" : "bg-paper-dark text-ink-light"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
            {/* Modes Tab */}
            {activeTab === "modes" && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-[520px_1fr] gap-6 items-start">
                  <ModeSelector
                    tr={tr}
                    selectedModes={selectedModes}
                    customModes={customModes}
                    customModeMeta={customModeMeta}
                    modeMeta={modeMeta}
                    coreModes={coreModes}
                    extraModes={extraModes}
                    handleModePreview={handleModePreview}
                    handleModeApply={handleModeApply}
                    handleCustomModeDelete={handleCustomModeDelete}
                    onCreateCustomMode={openCreateCustomMode}
                    previewColors={previewColors}
                    onColorsChange={setPreviewColors}
                  />

                  <div ref={previewPanelRef}>
                  <EInkPreviewPanel
                    tr={tr}
                    previewModeLabel={
                      previewModeLabelOverride ||
                      (previewMode
                        ? (modeMeta[previewMode]?.name || customModeMeta[previewMode]?.name || previewMode)
                        : tr("Select a mode", "Select a mode"))
                    }
                    previewLoading={previewLoading}
                    previewStatusText={previewStatusText}
                    previewImg={previewImg}
                    previewCacheHit={previewCacheHit}
                    previewLlmStatus={previewLlmStatus}
                    canApplyToScreen={Boolean(mac && previewMode && previewImg)}
                    applyToScreenLoading={applyToScreenLoading}
                    onRegenerate={() => handlePreview(previewMode, true)}
                    onApplyToScreen={handleApplyPreviewToScreen}
                    rightActions={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveCustomMode}
                        disabled={!Boolean(customJson.trim())}
                        className="bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
                      >
                        {tr("Save Mode", "Save Mode")}
                      </Button>
                    }
                  />
                  </div>
                </div>

                <Dialog
                  open={editingCustomMode}
                  onClose={() => {
                    setEditingCustomMode(false);
                  }}
                >
                  <DialogContent className="max-w-5xl">
                    <DialogHeader
                      onClose={() => {
                        setEditingCustomMode(false);
                      }}
                    >
                      <div>
                        <DialogTitle>{tr("Create Custom Mode", "Create Custom Mode")}</DialogTitle>
                        <DialogDescription>
                          {tr(
                            "Describe your idea for AI generation, or build it manually with a template.",
                            "Describe what you want and let AI generate it, or pick a layout template and customize it yourself.",
                          )}
                        </DialogDescription>
                      </div>
                    </DialogHeader>

                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="text-xs text-ink-light mb-1">{tr("Mode name", "Mode name")}</div>
                          <input
                            value={customModeName}
                            onChange={(e) => setCustomModeName(e.target.value)}
                            placeholder={tr("Mode name (e.g. Daily English)", "Mode name (e.g. Daily English)")}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                            disabled={customGenerating}
                          />
                        </div>
                        <div>
                          <div className="text-xs text-ink-light mb-1">{tr("Mode description", "Mode description")}</div>
                          <input
                            value={customModeDescription}
                            onChange={(e) => setCustomModeDescription(e.target.value)}
                            placeholder={tr("Shown in the mode list", "Shown in the mode list")}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                            disabled={customGenerating}
                          />
                        </div>
                      </div>

                      <div className="flex gap-2 border-b border-ink/10">
                        <button
                          type="button"
                          onClick={() => setCustomEditorTab("ai")}
                          className={`px-3 py-2 text-sm border-b-2 ${customEditorTab === "ai" ? "border-ink text-ink font-medium" : "border-transparent text-ink-light"}`}
                        >
                          {tr("Describe", "Describe")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCustomEditorTab("composer");
                            if (!customJson.trim()) {
                              setCustomEditorSource("composer");
                            }
                          }}
                          className={`px-3 py-2 text-sm border-b-2 ${customEditorTab === "composer" ? "border-ink text-ink font-medium" : "border-transparent text-ink-light"}`}
                        >
                          {tr("Template", "Template")}
                        </button>
                      </div>

                      {customEditorTab === "ai" ? (
                        <div className="space-y-3">
                          {customGenerating ? (
                            <div className="rounded-sm border border-ink/10 bg-paper px-3 py-3 text-sm text-ink-light flex items-center gap-2">
                              <Loader2 size={16} className="animate-spin" />
                              {tr("Generating mode...", "Generating mode...")}
                            </div>
                          ) : null}
                          <textarea
                            value={customDesc}
                            onChange={(e) => setCustomDesc(e.target.value)}
                            rows={4}
                            maxLength={2000}
                            placeholder={tr(
                              "Describe your mode, e.g. show one English word and its definition each day with a large centered font.",
                              "Describe your mode, e.g. show one English word and definition daily with a large centered font",
                            )}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm resize-y bg-white"
                            disabled={customGenerating}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                void handleGenerateMode();
                              }}
                              disabled={customGenerating || !customDesc.trim()}
                            >
                              {tr("AI Generate Preview", "AI Generate Preview")}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {customEditorTab === "composer" ? (
                        composerCatalog ? (
                          <ModeComposer
                            tr={tr}
                            isEn={isEn}
                            catalog={composerCatalog}
                            state={composerState}
                            onChange={handleComposerChange}
                            syncError={composerSyncError}
                            onPreview={async () => {
                              const modeDef = buildComposerModeDefinition({
                                composer: composerState,
                                catalog: composerCatalog,
                                modeName: customModeName,
                                modeDescription: customModeDescription,
                                isEn,
                              });
                              const json = JSON.stringify(modeDef, null, 2);
                              setCustomJson(json);
                              setCustomEditorSource("composer");
                              await handleCustomPreview(modeDef);
                              setEditingCustomMode(false);
                              requestAnimationFrame(() => {
                                previewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                              });
                            }}
                            previewDisabled={!customJson.trim()}
                            previewImgUrl={composerPreviewUrl}
                            previewLoading={composerPreviewLoading}
                            onRequestPreview={fetchComposerPreview}
                          />
                        ) : (
                          <div className="text-sm text-ink-light">{tr("Loading composer catalog...", "Loading composer catalog...")}</div>
                        )
                      ) : null}

                    </div>
                  </DialogContent>
                </Dialog>

              </div>
            )}

            {/* Preferences Tab */}
            {activeTab === "preferences" && (
              <div className="space-y-4">
                <RefreshStrategyEditor
                  tr={tr}
                  locale={isEn ? "en" : "zh"}
                  location={currentLocation}
                  setLocation={applyGlobalLocation}
                  modeLanguage={modeLanguage}
                  setModeLanguage={setModeLanguage}
                  modeLanguageOptions={MODE_LANGUAGE_OPTIONS}
                  contentTone={contentTone}
                  setContentTone={setContentTone}
                  characterTones={characterTones}
                  setCharacterTones={setCharacterTones}
                  customPersonaTone={customPersonaTone}
                  setCustomPersonaTone={setCustomPersonaTone}
                  handleAddCustomPersona={handleAddCustomPersona}
                  strategy={strategy}
                  setStrategy={setStrategy}
                  refreshMin={refreshMin}
                  setRefreshMin={setRefreshMin}
                  toneOptions={TONE_OPTIONS}
                  personaPresets={PERSONA_PRESETS}
                  strategies={STRATEGIES}
                  timeSlotRules={timeSlotRules}
                  setTimeSlotRules={setTimeSlotRules}
                  availableModes={selectedModes ? Array.from(selectedModes) : []}
                  modeMeta={modeMeta}
                />
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{tr("Device Active State", "Device Active State")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <label className="flex items-start gap-3 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={alwaysActive}
                        onChange={(e) => setAlwaysActive(e.target.checked)}
                        className="mt-1"
                      />
                      <div>
                        <div className="font-medium">{tr("Keep device always active", "Keep device always active")}</div>
                        <div className="text-xs text-ink-light mt-1">
                          {tr(
                            "When enabled, the device stays active continuously instead of entering interval mode or deep sleep.",
                            "When enabled, the device stays active continuously and will not enter interval mode or deep sleep.",
                          )}
                        </div>
                      </div>
                    </label>
                  </CardContent>
                </Card>
                <Button
                  variant="outline"
                  onClick={handleSavePreferences}
                  disabled={!mac || savingPrefs}
                  className="w-full bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
                >
                  {savingPrefs ? <Loader2 size={14} className="animate-spin mr-1" /> : <Save size={14} className="mr-1" />}
                  {tr("Save", "Save")}
                </Button>
              </div>
            )}

            {/* Sharing Tab */}
            {activeTab === "sharing" && (
              <div className="space-y-4">
                {currentUserRole === "owner" ? (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">{tr("Sharing", "Sharing")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex gap-2 flex-wrap">
                        <input
                          value={shareUsernameInput}
                          onChange={(e) => setShareUsernameInput(e.target.value)}
                          placeholder={tr("Enter username to share", "Enter username to share")}
                          className="flex-1 min-w-[220px] rounded-sm border border-ink/20 px-3 py-2 text-sm"
                        />
                        <Button variant="outline" size="sm" onClick={handleShareDevice} disabled={!shareUsernameInput.trim()}>
                          {tr("Share", "Share")}
                        </Button>
                      </div>
                      {membersLoading ? (
                        <div className="flex items-center gap-2 text-sm text-ink-light">
                          <Loader2 size={14} className="animate-spin" /> {tr("Loading members...", "Loading members...")}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {deviceMembers.map((member) => (
                            <div key={member.user_id} className="flex items-center justify-between rounded-sm border border-ink/10 p-2 text-sm">
                              <div>
                                <p className="font-medium text-ink">{member.username}</p>
                                <p className="text-xs text-ink-light">{member.role === "owner" ? "Owner" : "Member"}</p>
                              </div>
                              {member.role !== "owner" ? (
                                <Button variant="outline" size="sm" onClick={() => handleRemoveMember(member.user_id)}>
                                  {tr("Remove", "Remove")}
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ) : (
                  <div className="p-3 rounded-sm border border-ink/10 bg-paper text-sm text-ink-light">
                    {tr("Only the device owner can manage sharing.", "Only the device owner can manage sharing.")}
                  </div>
                )}

                {pendingRequests.some((item) => item.mac === mac) ? (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">{tr("Pending requests", "Pending requests")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {pendingRequests.filter((item) => item.mac === mac).map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-2 rounded-sm border border-ink/10 p-2 text-sm">
                          <div>
                            <p className="font-medium text-ink">{item.requester_username}</p>
                            <p className="text-xs text-ink-light">{tr("Requested to bind this device", "Requested to bind this device")}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => handleRejectRequest(item.id)}>
                              {tr("Reject", "Reject")}
                            </Button>
                            <Button size="sm" onClick={() => handleApproveRequest(item.id)}>
                              {tr("Approve", "Approve")}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            )}


            {/* Stats Tab */}
            {activeTab === "stats" && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 size={18} /> {tr("Device Status", "Device Status")}
                    {mac && <Button variant="ghost" size="sm" onClick={loadStats}><RefreshCw size={12} /></Button>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!mac && <p className="text-sm text-ink-light">{tr("Connect a device to view status", "Connect a device to view status")}</p>}
                  {mac && !stats && <p className="text-sm text-ink-light">{tr("No stats yet", "No stats yet")}</p>}
                  {stats && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                      <StatCard label={tr("Total Renders", "Total Renders")} value={stats.total_renders ?? "-"} />
                      <StatCard label={tr("Cache Hit Rate", "Cache Hit Rate")} value={stats.cache_hit_rate != null ? `${Math.round(stats.cache_hit_rate)}%` : "-"} />
                      <StatCard label={tr("Battery", "Battery")} value={batteryPct != null ? `${batteryPct}%` : "-"} />
                      <StatCard label={tr("Voltage", "Voltage")} value={stats.last_battery_voltage ? `${stats.last_battery_voltage.toFixed(2)}V` : "-"} />
                      <StatCard label={tr("WiFi RSSI", "WiFi RSSI")} value={stats.last_rssi ? `${stats.last_rssi} dBm` : "-"} />
                      <StatCard label={tr("Error Count", "Error Count")} value={stats.error_count ?? "-"} />
                      {stats.last_refresh && <StatCard label={tr("Last Refresh", "Last Refresh")} value={new Date(stats.last_refresh).toLocaleString(isEn ? "en-US" : "zh-CN")} />}
                    </div>
                  )}
                  {stats?.mode_frequency && Object.keys(stats.mode_frequency).length > 0 && (
                    <div className="mt-6">
                      <h4 className="text-sm font-medium mb-3">{tr("Mode Frequency", "Mode Frequency")}</h4>
                      <div className="space-y-2">
                        {Object.entries(stats.mode_frequency)
                          .sort(([, a], [, b]) => b - a)
                          .map(([mode, count]) => {
                            const max = Math.max(...Object.values(stats.mode_frequency!));
                            return (
                              <div key={mode} className="flex items-center gap-2 text-sm">
                                <span className="w-20 text-ink-light truncate">{modeMeta[mode]?.name || customModeMeta[mode]?.name || mode}</span>
                                <div className="flex-1 bg-paper-dark rounded-full h-4 overflow-hidden">
                                  <div className="bg-ink h-full rounded-full" style={{ width: `${(count / max) * 100}%` }} />
                                </div>
                                <span className="w-8 text-right text-ink-light text-xs">{count}</span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {mac && currentUser && settingsMode && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/30" onClick={() => setSettingsMode(null)} />
              <Card className="relative z-10 w-full max-w-md">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>
                      {tr("Mode Settings", "Mode Settings")}: {modeMeta[settingsMode]?.name || customModeMeta[settingsMode]?.name || settingsMode}
                    </span>
                    <button className="text-ink-light hover:text-ink" onClick={() => setSettingsMode(null)}>
                      <X size={16} />
                    </button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Field label="City (optional)">
                    <LocationPicker
                      value={extractLocationValue(getModeOverride(settingsMode) as Record<string, unknown>)}
                      onChange={(next) =>
                        updateModeOverride(settingsMode, {
                          city: next.city,
                          latitude: next.latitude,
                          longitude: next.longitude,
                          timezone: next.timezone,
                          admin1: next.admin1,
                          country: next.country,
                        })
                      }
                      locale={isEn ? "en" : "zh"}
                      placeholder={tr("Search a mode-specific place", "Search a mode-specific place")}
                      helperText={tr(
                        `Leave blank to use the global default: ${describeLocation(currentLocation) || "Hangzhou"}`,
                        `Leave empty to use global default: ${describeLocation(currentLocation) || "Hangzhou"}`,
                      )}
                      className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                    />
                  </Field>
                  {activeModeSchema.map((item) => {
                    const key = `${settingsMode}:${item.key}`;
                    const override = getModeOverride(settingsMode);
                    const rawValue = override[item.key] ?? item.default;
                    const valueType = item.type || "text";
                    const options = (item.options || []).map((opt) => typeof opt === "string"
                      ? { value: opt, label: opt }
                      : { value: opt.value, label: opt.label });

                    if (settingsMode === "COUNTDOWN" && item.key === "countdownEvents") {
                      const events = Array.isArray(rawValue)
                        ? rawValue.map((ev) => ({
                            name: typeof ev?.name === "string" ? ev.name : "",
                            date: typeof ev?.date === "string" ? ev.date : "",
                            type: ev?.type === "countup" ? "countup" : "countdown",
                          }))
                        : [];
                      return (
                        <Field key={key} label="Countdown event">
                          {events.map((ev, i) => (
                            <div key={`${key}:${i}`} className="flex gap-2 mb-2">
                              <input
                                value={ev.name}
                                onChange={(e) => {
                                  const next = [...events];
                                  next[i] = { ...next[i], name: e.target.value };
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                                placeholder="Event name"
                                className="flex-1 rounded-sm border border-ink/20 px-3 py-1.5 text-sm"
                              />
                              <input
                                type="date"
                                value={ev.date}
                                onChange={(e) => {
                                  const next = [...events];
                                  next[i] = { ...next[i], date: e.target.value };
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                                className="rounded-sm border border-ink/20 px-3 py-1.5 text-sm"
                              />
                              <select
                                value={ev.type}
                                onChange={(e) => {
                                  const next = [...events];
                                  next[i] = { ...next[i], type: e.target.value === "countup" ? "countup" : "countdown" };
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                                className="rounded-sm border border-ink/20 px-2 py-1.5 text-sm bg-white"
                              >
                                <option value="countdown">Countdown</option>
                                <option value="countup">Count up</option>
                              </select>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  const next = events.filter((_, j) => j !== i);
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                              >
                                x
                              </Button>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const next = [...events, { name: "", date: "", type: "countdown" }];
                              updateModeOverride(settingsMode, { [item.key]: next });
                            }}
                          >
                            + Add Event
                          </Button>
                        </Field>
                      );
                    }

                    if (item.as_json) {
                      const draft = settingsJsonDrafts[key] ?? (
                        rawValue === undefined ? "" : JSON.stringify(rawValue, null, 2)
                      );
                      return (
                        <Field key={key} label={item.label}>
                          <textarea
                            value={draft}
                            onChange={(e) => {
                              setSettingsJsonDrafts((prev) => ({ ...prev, [key]: e.target.value }));
                            }}
                            onBlur={() => {
                              const text = settingsJsonDrafts[key] ?? "";
                              if (!text.trim()) {
                                updateModeOverride(settingsMode, { [item.key]: undefined });
                                setSettingsJsonErrors((prev) => {
                                  const copied = { ...prev };
                                  delete copied[key];
                                  return copied;
                                });
                                return;
                              }
                              try {
                                const parsed = JSON.parse(text);
                                updateModeOverride(settingsMode, { [item.key]: parsed });
                                setSettingsJsonErrors((prev) => {
                                  const copied = { ...prev };
                                  delete copied[key];
                                  return copied;
                                });
                              } catch {
                                setSettingsJsonErrors((prev) => ({ ...prev, [key]: "Invalid JSON" }));
                              }
                            }}
                            rows={4}
                            placeholder={item.placeholder}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm font-mono"
                          />
                          {settingsJsonErrors[key] ? (
                            <p className="mt-1 text-xs text-red-600">{settingsJsonErrors[key]}</p>
                          ) : null}
                        </Field>
                      );
                    }

                    if (valueType === "textarea") {
                      return (
                        <Field key={key} label={item.label}>
                          <textarea
                            ref={settingsMode === "MEMO" && item.key === "memo_text" ? memoSettingsInputRef : undefined}
                            value={typeof rawValue === "string" ? rawValue : ""}
                            onChange={(e) => {
                              const next = e.target.value;
                              updateModeOverride(settingsMode, { [item.key]: next });
                              if (settingsMode === "MEMO" && item.key === "memo_text") {
                                setMemoText(next);
                              }
                            }}
                            rows={3}
                            placeholder={item.placeholder}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                          />
                        </Field>
                      );
                    }

                    if (valueType === "number") {
                      return (
                        <Field key={key} label={item.label}>
                          <input
                            type="number"
                            value={typeof rawValue === "number" ? rawValue : (item.default as number | undefined) ?? ""}
                            min={item.min}
                            max={item.max}
                            step={item.step}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) {
                                updateModeOverride(settingsMode, { [item.key]: undefined });
                                return;
                              }
                              updateModeOverride(settingsMode, { [item.key]: Number(v) });
                            }}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                          />
                        </Field>
                      );
                    }

                    if (valueType === "boolean") {
                      const checked = Boolean(rawValue);
                      return (
                        <Field key={key} label={item.label}>
                          <label className="inline-flex items-center gap-2 text-sm text-ink">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => updateModeOverride(settingsMode, { [item.key]: e.target.checked })}
                            />
                            Enable
                          </label>
                        </Field>
                      );
                    }

                    if (valueType === "select" && options.length > 0) {
                      const current = typeof rawValue === "string" ? rawValue : options[0].value;
                      return (
                        <Field key={key} label={item.label}>
                          <select
                            value={current}
                            onChange={(e) => updateModeOverride(settingsMode, { [item.key]: e.target.value })}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                          >
                            {options.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </Field>
                      );
                    }

                    return (
                      <Field key={key} label={item.label}>
                        <input
                          value={typeof rawValue === "string" ? rawValue : ""}
                          onChange={(e) => updateModeOverride(settingsMode, { [item.key]: e.target.value })}
                          placeholder={item.placeholder}
                          className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                        />
                      </Field>
                    );
                  })}
                  <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={() => clearModeOverride(settingsMode)}>
                      Reset Default
                    </Button>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handlePreviewFromSettings(false)}>
                        Preview
                      </Button>
                      <Button
                        variant={settingsMode && selectedModes.has(settingsMode) ? "default" : "outline"}
                        size="sm"
                        className={
                          settingsMode && selectedModes.has(settingsMode)
                            ? "bg-ink text-white border-ink hover:bg-ink hover:text-white"
                            : "bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white"
                        }
                        onClick={() => handlePreviewFromSettings(true)}
                      >
                        Preview and add to rotation
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          </div>
        </div>
      )}

      <Dialog
        open={showFocusTokenModal}
        onClose={() => {
          setShowFocusTokenModal(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader
            onClose={() => {
              setShowFocusTokenModal(false);
            }}
          >
            <div>
              <DialogTitle>{tr("Alert Token Generated", "Alert Token Generated")}</DialogTitle>
              <DialogDescription>
                {tr(
                  "Configure the token below in your OpenCLAW instance (or custom agent) to send urgent alerts to this device.",
                  "Copy this token into your OpenCLAW (or custom agent) to send urgent alerts to this device.",
                )}
              </DialogDescription>
              <div className="mt-2 text-[11px] text-ink-light">
                {tr(
                  "Tip: after enabling focus listening, the device usually needs a restart or a fresh boot flow before it starts polling for alerts every 10 seconds and showing them on-screen.",
                  "Tip: after enabling Focus Listening, the device usually needs a restart / re-enter startup flow before it starts 10s alert polling and displaying messages.",
                )}
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-sm border border-ink/20 bg-white px-3 py-2 text-xs font-mono break-all">
              {focusAlertToken || tr("(empty)", "(empty)")}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(focusAlertToken);
                    showToast(tr("Token copied", "Token copied"), "success");
                  } catch {
                    showToast(tr("Copy failed, please copy manually", "Copy failed, please copy manually"), "error");
                  }
                }}
                disabled={!focusAlertToken}
              >
                {tr("Copy Token", "Copy Token")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setShowFocusTokenModal(false);
                }}
              >
                {tr("Close", "Close")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile save button */}
      {mac && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-ink/10">
          <Button
            variant="outline"
            onClick={handleSave}
            disabled={!mac || saving}
            className="w-full bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
          >
            {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : <Save size={14} className="mr-1" />}
            {tr("Save to Device", "Save to Device")}
          </Button>
        </div>
      )}

      {previewConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle>Confirm Preview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-6 text-ink">
                {formatPreviewConfirmText(previewConfirm.usageSource)}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreviewConfirm(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    const pending = previewConfirm;
                    setPreviewConfirm(null);
                    if (pending) {
                      handlePreview(pending.mode, pending.forceNoCache, pending.forcedModeOverride, true);
                    }
                  }}
                  className="bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white"
                >
                  Confirm
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Invitation-code dialog */}
      {showInviteModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle>
                {currentUserRole === "member"
                  ? "Free Quota Exhausted"
                  : "Enter Invitation Code"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className={`${currentUserRole === "member" ? "text-base leading-7 text-ink" : "text-sm text-ink-light"}`}>
                {isEn
                  ? (currentUserRole === "member"
                    ? `This device owner's free quota is exhausted. Please contact ${ownerUsername || "the owner"}, or continue with device-free preview.`
                    : "Your free quota has been exhausted. You can enter an invitation code or configure your own API key in your profile.")
                  : (currentUserRole === "member"
                    ? `The free quota for device owner${ownerUsername ? ` (${ownerUsername})` : ""} has been exhausted. Please contact the owner or continue with online preview.`
                    : "Your free quota has been exhausted. You can enter an invitation code to get 50 more free LLM calls, or configure your own API key in your profile.")}
              </p>
              {currentUserRole === "member" ? (
                <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="text-xs leading-5 text-amber-800">
                    {isEn
                      ? "Member free quota only applies to device-free preview, not on-device generation."
                      : "Member free quota is only used for no-device preview, not for device-side generation."}
                  </p>
                </div>
              ) : (
                <>
                  <div className="p-3 rounded-sm border border-ink/20 bg-paper-dark">
                    <p className="text-xs text-ink-light mb-2">
                      {isEn
                        ? "Tip: If you have your own API key, you can configure it in your profile to avoid quota limits."
                        : "Tip: if you have your own API key, configure it in your profile to avoid quota limits."}
                    </p>
                    <Link href={withLocalePath(locale, "/profile")}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setShowInviteModal(false);
                        }}
                        className="w-full text-xs"
                      >
                        Go to Profile Settings
                      </Button>
                    </Link>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1">
                      Invitation Code
                    </label>
                    <input
                      type="text"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                      placeholder="Enter invitation code"
                      className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !redeemingInvite) {
                          handleRedeemInviteCode();
                        }
                      }}
                    />
                  </div>
                </>
              )}
              <div className={`flex gap-2 ${currentUserRole === "member" ? "flex-col-reverse sm:flex-row sm:justify-end" : "justify-end"}`}>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowInviteModal(false);
                    setInviteCode("");
                    setPendingPreviewMode(null);
                  }}
                  disabled={currentUserRole === "member" ? false : redeemingInvite}
                >
                  Cancel
                </Button>
                {currentUserRole === "member" && (
                  <Link href={withLocalePath(locale, "/preview")} className="sm:min-w-[180px]">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowInviteModal(false);
                        setInviteCode("");
                        setPendingPreviewMode(null);
                      }}
                      className="w-full bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
                    >
                      Continue Online Preview
                    </Button>
                  </Link>
                )}
                {currentUserRole !== "member" && (
                  <Button onClick={handleRedeemInviteCode} disabled={redeemingInvite || !inviteCode.trim()}>
                    {redeemingInvite ? (
                      <>
                        <Loader2 size={16} className="animate-spin mr-2" />
                        Redeeming...
                      </>
                    ) : (
                      "Redeem"
                    )}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Photo-frame multi-image dialog */}
      {adaptiveModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setAdaptiveModal(null)} />
          <div className="relative w-[min(520px,calc(100vw-32px))] rounded-sm border border-ink/15 bg-white shadow-xl">
            <div className="px-4 py-3 border-b border-ink/10 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink">
                {tr("Photo Frame Images", "Photo Frame Images")}
              </div>
              <button className="text-ink-light hover:text-ink" onClick={() => setAdaptiveModal(null)}>
                ✕
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="text-xs text-ink-light">
                {tr(
                  "Upload up to 6 images. The device shows the next one each time it refreshes.",
                  "Upload up to 6 images. The device cycles to the next image on each refresh.",
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {adaptiveImageUrls.map((url, i) => (
                  <div key={`${url}-${i}`} className="relative group aspect-[4/3] rounded border border-ink/15 overflow-hidden bg-paper-dark">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`photo ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => setAdaptiveImageUrls((prev) => prev.filter((_, idx) => idx !== i))}
                      title={tr("Remove", "Remove")}
                    >
                      ✕
                    </button>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/40 text-white text-[10px] text-center py-0.5">
                      {i + 1}
                    </div>
                  </div>
                ))}
                {adaptiveImageUrls.length < 6 && (
                  <button
                    className="aspect-[4/3] rounded border-2 border-dashed border-ink/20 flex flex-col items-center justify-center text-ink-light hover:text-ink hover:border-ink/40 transition-colors"
                    onClick={() => adaptiveFileInputRef.current?.click()}
                    disabled={adaptiveUploading2}
                  >
                    {adaptiveUploading2 ? (
                      <Loader2 size={20} className="animate-spin" />
                    ) : (
                      <>
                        <span className="text-xl leading-none">+</span>
                        <span className="text-[10px] mt-0.5">{tr("Add", "Add")}</span>
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => setAdaptiveModal(null)}
                >
                  {tr("Cancel", "Cancel")}
                </Button>
                <Button
                  variant="outline"
                  disabled={adaptiveImageUrls.length === 0 || previewLoading}
                  onClick={async () => {
                    const action = adaptiveModal.action;
                    const override: ModeOverride = { image_urls: [...adaptiveImageUrls], image_url: adaptiveImageUrls[0] || "" };
                    setAdaptiveModal(null);
                    await commitModalAction("MY_ADAPTIVE", action, override);
                  }}
                >
                  {adaptiveModal.action === "apply"
                    ? tr("Confirm & Add to Rotation", "Confirm & Add to Rotation")
                    : tr("Confirm & Preview", "Confirm & Preview")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Parameter dialogs aligned with /preview. They open for both preview and add-to-rotation flows. */}
      {paramModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setParamModal(null)} />
          <div className="relative w-[min(520px,calc(100vw-32px))] rounded-sm border border-ink/15 bg-white shadow-xl">
            <div className="px-4 py-3 border-b border-ink/10 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink">
                {paramModal.type === "quote"
                  ? tr("Custom Quote", "Custom Quote")
                  : paramModal.type === "weather"
                  ? tr("Weather Settings", "Weather Settings")
                  : paramModal.type === "memo"
                  ? tr("Memo Content", "Memo Content")
                  : paramModal.type === "countdown"
                  ? tr("Countdown Settings", "Countdown Settings")
                  : paramModal.type === "habit"
                  ? tr("Habit Tracker", "Habit Tracker")
                  : paramModal.type === "calendar"
                  ? tr("Calendar Reminders", "Calendar Reminders")
                  : paramModal.type === "timetable"
                  ? tr("Timetable Settings", "Timetable Settings")
                  : tr("Life Progress", "Life Progress")}
              </div>
              <button className="text-ink-light hover:text-ink" onClick={() => setParamModal(null)}>
                ✕
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              {paramModal.type === "quote" ? (
                <>
                  <div className="text-xs text-ink-light">
                    {tr(
                      "Generate a thoughtful quote, or paste your own text.",
                      "Generate a deep quote randomly, or paste your own text.",
                    )}
                  </div>
                  <textarea
                    value={quoteDraft}
                    onChange={(e) => setQuoteDraft(e.target.value)}
                    placeholder={tr("Type your quote...", "Type your quote...")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm min-h-28 bg-white"
                  />
                  <input
                    value={authorDraft}
                    onChange={(e) => setAuthorDraft(e.target.value)}
                    placeholder={tr("Author (optional)", "Author (optional)")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        commitModalAction(paramModal.mode, paramModal.action);
                      }}
                      disabled={previewLoading}
                    >
                      {tr("Random generate", "Random generate")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        const q = quoteDraft.trim();
                        const a = authorDraft.trim();
                        commitModalAction(
                          paramModal.mode,
                          paramModal.action,
                          q ? ({ quote: q, author: a } as ModeOverride) : undefined,
                        );
                      }}
                      disabled={previewLoading}
                    >
                      {tr("Use my input", "Use my input")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "weather" ? (
                <>
                  <div className="text-xs text-ink-light">
                    {tr(
                      "Search and choose a specific place to avoid ambiguous city matches.",
                      "Search and choose a specific place to avoid ambiguous city names.",
                    )}
                  </div>
                  <LocationPicker
                    value={weatherDraftLocation}
                    onChange={setWeatherDraftLocation}
                    locale={isEn ? "en" : "zh"}
                    placeholder={tr("Enter a place name (e.g. Shanghai, Paris, Singapore)", "Enter a place name (e.g. Shanghai, Paris, Singapore)")}
                    helperText={tr("Pick a precise result from the suggestion list.", "Pick a precise result from the suggestion list.")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                    autoFocus
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => setWeatherDraftLocation(defaultWeatherLocation)}
                      disabled={previewLoading}
                    >
                      {tr("Use default city", "Use default city")}
                    </Button>
                    <Button
                      onClick={() => {
                        const nextLocation = cleanLocationValue(weatherDraftLocation);
                        commitModalAction(
                          paramModal.mode,
                          paramModal.action,
                          nextLocation.city ? (nextLocation as ModeOverride) : undefined,
                        );
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview weather", "Preview weather")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "memo" ? (
                <>
                  <div className="text-xs text-ink-light">
                    {tr("Enter memo content to display on e-ink screen.", "Enter memo content to display on e-ink screen.")}
                  </div>
                  <textarea
                    value={memoDraft}
                    onChange={(e) => setMemoDraft(e.target.value)}
                    placeholder={tr("Enter memo content...", "Enter memo content...")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm min-h-32 bg-white"
                    autoFocus
                  />
                  <div className="flex justify-end pt-2">
                    <Button
                      onClick={() => {
                        const m = memoDraft.trim();
                        commitModalAction(
                          paramModal.mode,
                          paramModal.action,
                          m ? ({ memo_text: m } as ModeOverride) : undefined,
                        );
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview memo", "Preview memo")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "countdown" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr("Set countdown event name and date", "Set countdown event name and date")}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("Event Name", "Event Name")}
                      </label>
                      <input
                        value={countdownName}
                        onChange={(e) => setCountdownName(e.target.value)}
                        placeholder={tr("e.g., New Year, Birthday", "e.g., New Year, Birthday")}
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("Target Date", "Target Date")}
                      </label>
                      <input
                        type="date"
                        value={countdownDate}
                        onChange={(e) => setCountdownDate(e.target.value)}
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Use Default", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        const today = new Date();
                        const target = new Date(countdownDate);
                        const days = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                        commitModalAction(paramModal.mode, paramModal.action, {
                          events: [
                            {
                              name: countdownName || "Countdown",
                              date: countdownDate,
                              type: "countdown",
                              days,
                            },
                          ],
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview Countdown", "Preview Countdown")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "habit" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "Manage your habit list, check off what you completed today, and use ✕ to remove anything you no longer want to track.",
                      "Manage your habit list. Check off completed habits today. Use ✕ to remove habits you don't want to track.",
                    )}
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {habitItems.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(e) => {
                            const next = [...habitItems];
                            next[idx] = { ...next[idx], done: e.target.checked };
                            setHabitItems(next);
                          }}
                          className="w-4 h-4"
                        />
                        <input
                          value={item.name}
                          onChange={(e) => {
                            const next = [...habitItems];
                            next[idx] = { ...next[idx], name: e.target.value };
                            setHabitItems(next);
                          }}
                          className="flex-1 rounded-sm border border-ink/20 px-3 py-1.5 text-sm bg-white"
                        />
                        <button
                          onClick={() => setHabitItems(habitItems.filter((_, i) => i !== idx))}
                          className="text-ink-light hover:text-red-500 px-2"
                          title={tr("Remove this habit", "Remove this habit")}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => setHabitItems([...habitItems, { name: "", done: false }])}
                    className="w-full mt-2 px-3 py-2 rounded-sm border border-dashed border-ink/20 text-sm text-ink-light hover:text-ink hover:border-ink/40 transition-colors"
                  >
                    + {tr("Add Habit", "Add Habit")}
                  </button>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Use Default", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        const tracked = habitItems.filter((h) => h.name.trim());
                        commitModalAction(paramModal.mode, paramModal.action, {
                          habitItems: tracked.map((h) => ({ name: h.name.trim(), done: h.done })),
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview Habits", "Preview Habits")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "lifebar" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr("Set your age and life expectancy", "Set your age and life expectancy")}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("Your Age", "Your Age")}
                      </label>
                      <input
                        type="number"
                        value={userAge}
                        onChange={(e) => setUserAge(parseInt(e.target.value) || 0)}
                        min="0"
                        max="120"
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("Life Expectancy", "Life Expectancy")}
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setLifeExpectancy(100)}
                          className={`flex-1 px-3 py-2 rounded-sm text-sm transition-colors ${
                            lifeExpectancy === 100
                              ? "bg-ink text-white"
                              : "bg-paper-dark text-ink hover:bg-ink/10"
                          }`}
                        >
                          100 {tr("years", "years")}
                        </button>
                        <button
                          onClick={() => setLifeExpectancy(120)}
                          className={`flex-1 px-3 py-2 rounded-sm text-sm transition-colors ${
                            lifeExpectancy === 120
                              ? "bg-ink text-white"
                              : "bg-paper-dark text-ink hover:bg-ink/10"
                          }`}
                        >
                          120 {tr("years", "years")}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Use Default", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        const lifePct = ((userAge / lifeExpectancy) * 100).toFixed(1);
                        commitModalAction(paramModal.mode, paramModal.action, {
                          age: userAge,
                          life_expect: lifeExpectancy,
                          life_pct: parseFloat(lifePct),
                          life_label: "Life",
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview Progress", "Preview Progress")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "calendar" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "Add reminders for specific dates. They appear below each date in the calendar.",
                      "Add reminders for specific dates. They appear below each date in the calendar.",
                    )}
                  </div>
                  <CalendarReminders
                    reminders={
                      (getModeOverride("CALENDAR") as Record<string, unknown>)?.reminders as Record<string, string> ?? {}
                    }
                    onChange={(r) => {
                      updateModeOverride("CALENDAR", {
                        reminders: Object.keys(r).length > 0 ? r : undefined,
                      } as Record<string, unknown>);
                    }}
                    tr={tr}
                  />
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Skip Preview", "Skip Preview")}
                    </Button>
                    <Button
                      onClick={() => {
                        const reminders = (getModeOverride("CALENDAR") as Record<string, unknown>)?.reminders as Record<string, string> | undefined;
                        commitModalAction(paramModal.mode, paramModal.action,
                          reminders && Object.keys(reminders).length > 0
                            ? { reminders } as ModeOverride
                            : undefined,
                        );
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview Calendar", "Preview Calendar")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "timetable" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "Choose a timetable type and edit course entries by clicking any cell.",
                      "Choose timetable type and edit courses. Click any cell to modify.",
                    )}
                  </div>
                  <TimetableEditor
                    data={timetableData}
                    onChange={setTimetableData}
                    tr={tr}
                  />
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Use Default", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        commitModalAction(paramModal.mode, paramModal.action, {
                          style: timetableData.style,
                          periods: timetableData.periods,
                          courses: timetableData.courses,
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("Preview Timetable", "Preview Timetable")}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-sm text-sm font-medium shadow-lg animate-fade-in ${
          toast.type === "success" ? "bg-green-50 text-green-800 border border-green-200"
          : toast.type === "error" ? "bg-red-50 text-red-800 border border-red-200"
          : "bg-amber-50 text-amber-800 border border-amber-200"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default function ConfigPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen text-ink-light"><Loader2 size={24} className="animate-spin mr-2" /> Loading...</div>}>
      <ConfigPageInner />
    </Suspense>
  );
}
