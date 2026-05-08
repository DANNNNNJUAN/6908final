"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sparkles, Search, Download, Image as ImageIcon, Upload, Loader2, Check } from "lucide-react";
import { authHeaders } from "@/lib/auth";
import { localeFromPathname } from "@/lib/i18n";

const categoryOptions = [
  { value: "all", legacy: "\u5168\u90e8", label: "All" },
  { value: "productivity", legacy: "\u6548\u7387", label: "Productivity" },
  { value: "learning", legacy: "\u5b66\u4e60", label: "Learning" },
  { value: "life", legacy: "\u751f\u6d3b", label: "Life" },
  { value: "fun", legacy: "\u8da3\u5473", label: "Fun" },
  { value: "geek", legacy: "\u6781\u5ba2", label: "Geek" },
];

const publishCategoryOptions = categoryOptions.filter((item) => item.value !== "all");

// Shared mode data
interface SharedMode {
  id: number;
  mode_id: string;
  name: string;
  description: string;
  category: string;
  thumbnail_url: string | null;
  created_at: string;
  author: string;
}

// User-created mode data
interface CustomMode {
  mode_id: string;
  display_name: string;
  description: string;
  source?: string;
}

// Device data
interface Device {
  mac: string;
  nickname: string;
  role: string;
  status: string;
}

export default function DiscoverPage() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname || "/");
  const isEn = locale === "en";
  const tr = useMemo(() => (zh: string, en: string) => (isEn ? en : zh), [isEn]);
  const categoryLabel = useCallback(
    (value: string) => categoryOptions.find((item) => item.value === value || item.legacy === value)?.label || value,
    [],
  );
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<string>(""); // Publish status message
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  
  // Data state
  const [modes, setModes] = useState<SharedMode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingModes, setInstallingModes] = useState<Set<number>>(new Set());
  const [installedModes, setInstalledModes] = useState<Set<number>>(new Set());
  
  // User-created modes
  const [customModes, setCustomModes] = useState<CustomMode[]>([]);
  const [isLoadingCustomModes, setIsLoadingCustomModes] = useState(false);
  
  // Device list
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  
  // Publish form state
  const [publishForm, setPublishForm] = useState({
    source_custom_mode_id: "",
    name: "",
    description: "",
    category: "",
    mac: "", // Device MAC address
  });
  
  // Device selection when installing a mode
  const [installDeviceModal, setInstallDeviceModal] = useState<{
    open: boolean;
    modeId: number | null;
  }>({ open: false, modeId: null });

  // Fetch shared modes
  const fetchModes = useCallback(async (category: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      const categoryMeta = categoryOptions.find((item) => item.value === category);
      if (categoryMeta && categoryMeta.value !== "all") {
        params.append("category", categoryMeta.legacy);
      }
      params.append("page", "1");
      params.append("limit", "100"); // Fetch enough entries for the client grid.

      const response = await fetch(`/api/discover/modes?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch modes: ${response.status}`);
      }

      const data = await response.json();
      setModes(data.modes || []);
    } catch (err) {
      console.error("Failed to fetch modes:", err);
      setError(err instanceof Error ? err.message : tr("Failed to fetch modes", "Failed to fetch modes"));
      setModes([]);
    } finally {
      setIsLoading(false);
    }
  }, [isEn, tr]);

  // Fetch devices
  const fetchDevices = useCallback(async () => {
    setIsLoadingDevices(true);
    try {
      const response = await fetch("/api/user/devices", {
        headers: authHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch devices: ${response.status}`);
      }

      const data = await response.json();
      setDevices(data.devices || []);
    } catch (err) {
      console.error("Failed to fetch devices:", err);
      setDevices([]);
    } finally {
      setIsLoadingDevices(false);
    }
  }, [isEn]);

  // Fetch custom modes, optionally filtered by device
  const fetchCustomModes = useCallback(async (mac?: string) => {
    setIsLoadingCustomModes(true);
    try {
      const params = new URLSearchParams();
      if (mac) {
        params.append("mac", mac);
      }

      const response = await fetch(`/api/modes?${params.toString()}`, {
        headers: authHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch custom modes: ${response.status}`);
      }

      const data = await response.json();
      // Keep only custom modes.
      const custom = (data.modes || []).filter(
        (mode: CustomMode) => mode.source === "custom"
      );
      setCustomModes(custom);
    } catch (err) {
      console.error("Failed to fetch custom modes:", err);
      setCustomModes([]);
    } finally {
      setIsLoadingCustomModes(false);
    }
  }, [isEn]);

  // Refetch when the category changes.
  useEffect(() => {
    fetchModes(selectedCategory);
  }, [selectedCategory, fetchModes]);

  // Fetch devices when the publish dialog opens.
  useEffect(() => {
    if (isPublishModalOpen) {
      fetchDevices();
    }
  }, [isPublishModalOpen, fetchDevices]);

  // Fetch custom modes when a device is selected.
  useEffect(() => {
    if (isPublishModalOpen && publishForm.mac) {
      fetchCustomModes(publishForm.mac);
    } else if (isPublishModalOpen && !publishForm.mac) {
      setCustomModes([]);
    }
  }, [isPublishModalOpen, publishForm.mac, fetchCustomModes]);

  // Open the device picker for installs.
  const handleInstallClick = (modeId: number) => {
    if (installingModes.has(modeId) || installedModes.has(modeId)) {
      return;
    }
    setInstallDeviceModal({ open: true, modeId });
    if (devices.length === 0) {
      fetchDevices();
    }
  };

  // Install a mode
  const handleInstall = async (modeId: number, mac: string) => {
    if (installingModes.has(modeId) || installedModes.has(modeId)) {
      return;
    }

    setInstallingModes((prev) => new Set(prev).add(modeId));
    setInstallDeviceModal({ open: false, modeId: null });

    try {
      const response = await fetch(`/api/discover/modes/${modeId}/install`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ mac }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Install failed: ${response.status}`);
      }

      const data = await response.json();
      
      // Mark the mode as installed.
      setInstalledModes((prev) => new Set(prev).add(modeId));
      
      // Show a success toast.
      setToastMessage(tr("Added to My Modes", "Added to My Modes"));
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
      
      console.log("Mode installed:", data.custom_mode_id);
    } catch (err) {
      console.error("Install failed:", err);
      setToastMessage(err instanceof Error ? err.message : tr("Install failed", "Install failed"));
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    } finally {
      setInstallingModes((prev) => {
        const next = new Set(prev);
        next.delete(modeId);
        return next;
      });
    }
  };

  // Publish a custom mode to the plaza.
  const handlePublish = async () => {
    if (!publishForm.source_custom_mode_id || !publishForm.name || !publishForm.category || !publishForm.mac) {
      setToastMessage(tr("Please complete all required fields, including the target device", "Please complete all required fields, including the target device"));
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
      return;
    }

    const payload = {
      source_custom_mode_id: publishForm.source_custom_mode_id,
      name: publishForm.name,
      description: publishForm.description,
      category: categoryOptions.find((item) => item.value === publishForm.category)?.legacy || publishForm.category,
      mac: publishForm.mac,
      // The backend generates the preview image automatically, so no thumbnail is required here.
    };

    setIsPublishing(true);
    setPublishStatus(tr("Preparing your mode for publishing...", "Preparing your mode for publishing..."));
    
    try {
      // Update the status while the backend prepares the preview image.
      const selectedMode = customModes.find(m => m.mode_id === publishForm.source_custom_mode_id);
      if (selectedMode) {
        setPublishStatus(tr("Generating preview image, please wait...", "Generating preview image, please wait..."));
      }

      // Use a longer timeout because image generation can take a while.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second timeout
      
      const response = await fetch("/api/discover/modes/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || `Publish failed: ${response.status}`;
        
        // Provide a friendlier message for timeout responses.
        if (response.status === 408) {
          throw new Error(tr("Image generation timed out. Please check your image API configuration or try again later.", "Image generation timed out. Please check your image API configuration or try again later."));
        }
        
        throw new Error(errorMessage);
      }

      const data = await response.json();
      console.log("Published mode:", data);
      
      setPublishStatus(tr("Published successfully!", "Published successfully!"));
      setIsPublishing(false);
      setIsPublishModalOpen(false);
      
      // Reset the form.
      setPublishForm({
        source_custom_mode_id: "",
        name: "",
        description: "",
        category: "",
        mac: "",
      });

      // Refresh the shared-mode list.
      await fetchModes(selectedCategory);
      
      // Show a success toast.
      setToastMessage(tr("Published successfully! Your mode is now visible in the plaza.", "Published successfully! Your mode is now visible in the plaza."));
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    } catch (error) {
      console.error("Publish failed:", error);
      setIsPublishing(false);
      setPublishStatus("");
      
      // Handle timeout errors separately.
      if (error instanceof Error && error.name === "AbortError") {
        setToastMessage(tr("Request timed out. Image generation may need more time. Please try again later.", "Request timed out. Image generation may need more time. Please try again later."));
      } else {
        setToastMessage(error instanceof Error ? error.message : tr("Publish failed", "Publish failed"));
      }
      
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    }
  };

  // Filter modes on the client.
  const filteredModes = modes.filter((mode) => {
    const matchesSearch =
      searchQuery === "" ||
      mode.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (mode.description && mode.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
      mode.author.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  return (
    <div className="min-h-screen bg-white">
      {/* Hero header */}
      <section className="border-b border-ink/10 bg-white bg-[linear-gradient(to_right,#f0f0f0_1px,transparent_1px),linear-gradient(to_bottom,#f0f0f0_1px,transparent_1px)] bg-[size:24px_24px]">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          {/* Title block */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 mb-4">
              <Sparkles size={28} className="text-ink" />
              <h1 className="font-serif text-4xl md:text-5xl font-bold text-ink">
                {tr("Explore Community Modes", "Explore Community Modes")}
              </h1>
            </div>
            <p className="text-base md:text-lg text-ink-light mt-4 max-w-2xl mx-auto">
              {tr("Discover, share, and install personalized e-ink modes created by the InkSight community.", "Discover, share, and install personalized e-ink modes created by the InkSight community.")}
            </p>
          </div>

          {/* Search input */}
          <div className="max-w-2xl mx-auto mb-8">
            <div className="relative">
              <Search
                size={20}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-light"
              />
              <input
                type="text"
                placeholder={tr("Search modes, authors, or descriptions...", "Search modes, authors, or descriptions...")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3.5 bg-white border border-gray-300 rounded-sm text-ink placeholder:text-gray-400 focus:outline-none focus:border-black transition-colors"
              />
            </div>
          </div>

          {/* Category chips and publish action */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap justify-center gap-3 flex-1">
              {categoryOptions.map((category) => (
                <button
                  key={category.value}
                  onClick={() => setSelectedCategory(category.value)}
                  className={`px-5 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                    selectedCategory === category.value
                      ? "bg-ink text-white shadow-[2px_2px_0_0_#000000]"
                      : "bg-white text-ink hover:bg-gray-50 border border-gray-300 hover:border-black hover:shadow-[2px_2px_0_0_#000000]"
                  }`}
                >
                  {category.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setIsPublishModalOpen(true)}
              className="bg-ink text-white rounded-full px-4 py-1.5 text-sm font-medium flex items-center gap-2 hover:bg-ink/90 transition-colors"
            >
              <Upload size={16} />
              {tr("Publish Mode", "Publish Mode")}
            </button>
          </div>
        </div>
      </section>

      {/* Mode grid */}
      <section className="mx-auto max-w-6xl px-6 py-12 md:py-16">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={32} className="text-ink-light animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-ink-light mb-2">{error}</p>
            <button
              onClick={() => fetchModes(selectedCategory)}
              className="text-sm text-ink underline hover:text-ink/70"
            >
              {tr("Retry", "Retry")}
            </button>
          </div>
        ) : filteredModes.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredModes.map((mode) => {
              const isInstalling = installingModes.has(mode.id);
              const isInstalled = installedModes.has(mode.id);
              
              return (
                <Card
                  key={mode.id}
                  className="group border border-gray-200 hover:border-black hover:shadow-[4px_4px_0_0_#000000] transition-all duration-200 flex flex-col"
                >
                  <CardContent className="pt-8 px-6 pb-6 flex flex-col flex-1">
                    {/* Header: name, author, category */}
                    <div className="mb-4">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <h3 className="font-semibold text-lg text-ink mb-1">
                            {mode.name}
                          </h3>
                          <p className="text-sm text-ink-light">{mode.author}</p>
                        </div>
                        <span className="px-2.5 py-1 text-xs font-medium text-ink bg-paper-dark rounded-sm whitespace-nowrap ml-3">
                          {categoryLabel(mode.category)}
                        </span>
                      </div>
                    </div>

                    {/* Thumbnail */}
                    <div className="w-full aspect-[4/3] mb-4 border border-gray-300 bg-white rounded-sm overflow-hidden relative">
                      {mode.thumbnail_url ? (
                        <Image
                          src={mode.thumbnail_url}
                          alt={mode.name}
                          fill
                          className="object-contain bg-white"
                          unoptimized
                        />
                      ) : (
                        <div className="w-full h-full border border-dashed border-gray-300 bg-white rounded-sm flex items-center justify-center flex-col">
                          <ImageIcon size={32} className="text-gray-400 mb-2" />
                          <span className="text-xs text-gray-400">{tr("Thumbnail placeholder", "Thumbnail placeholder")}</span>
                        </div>
                      )}
                    </div>

                    {/* Description */}
                    <p className="text-sm text-gray-700 mb-4 flex-1 line-clamp-2 font-serif leading-relaxed">
                      {mode.description || tr("No description yet", "No description yet")}
                    </p>

                    {/* Footer actions */}
                    <div className="mt-auto pt-4 border-t border-ink/5">
                      <Button
                        variant="outline"
                        onClick={() => handleInstallClick(mode.id)}
                        disabled={isInstalling || isInstalled}
                        className={`w-full transition-colors ${
                          isInstalled
                            ? "bg-gray-100 text-gray-600 border-gray-300 cursor-not-allowed"
                            : "bg-white text-black border border-black hover:bg-black hover:text-white"
                        }`}
                      >
                        {isInstalling ? (
                          <>
                            <Loader2 size={16} className="mr-2 animate-spin" />
                            {tr("Installing...", "Installing...")}
                          </>
                        ) : isInstalled ? (
                          <>
                            <Check size={16} className="mr-2" />
                            {tr("Installed", "Installed")}
                          </>
                        ) : (
                          <>
                            <Download size={16} className="mr-2" />
                            {tr("Install", "Install")}
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-16">
            <p className="text-ink-light">{tr("No matching modes yet", "No matching modes yet")}</p>
          </div>
        )}
      </section>

      {/* Publish dialog */}
      <Dialog open={isPublishModalOpen} onClose={() => setIsPublishModalOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader onClose={() => setIsPublishModalOpen(false)}>
            <DialogTitle>{tr("Publish a Mode to the Plaza", "Publish a Mode to the Plaza")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Device selection */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {tr("Select Device", "Select Device")} <span className="text-red-500">*</span>
              </label>
              {isLoadingDevices ? (
                <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm flex items-center justify-center">
                  <Loader2 size={16} className="text-ink-light animate-spin" />
                  <span className="ml-2 text-sm text-ink-light">{tr("Loading...", "Loading...")}</span>
                </div>
              ) : devices.length === 0 ? (
                <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink-light text-sm">
                  {tr("No devices yet. Please bind a device first.", "No devices yet. Please bind a device first.")}
                </div>
              ) : (
                <select
                  value={publishForm.mac}
                  onChange={(e) => {
                    setPublishForm({ ...publishForm, mac: e.target.value, source_custom_mode_id: "" });
                  }}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink focus:outline-none focus:border-black transition-colors"
                >
                  <option value="">{tr("Choose a device", "Choose a device")}</option>
                  {devices.map((device) => (
                    <option key={device.mac} value={device.mac}>
                      {device.nickname || device.mac} ({device.mac})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Mode selection */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {tr("Select Mode", "Select Mode")} <span className="text-red-500">*</span>
              </label>
              {isLoadingCustomModes ? (
                <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm flex items-center justify-center">
                  <Loader2 size={16} className="text-ink-light animate-spin" />
                  <span className="ml-2 text-sm text-ink-light">{tr("Loading...", "Loading...")}</span>
                </div>
              ) : customModes.length === 0 ? (
                <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink-light text-sm">
                  {tr("No custom modes yet. Please create one first.", "No custom modes yet. Please create one first.")}
                </div>
              ) : (
                <select
                  value={publishForm.source_custom_mode_id}
                  onChange={(e) => {
                    const selectedMode = customModes.find(
                      (m) => m.mode_id === e.target.value
                    );
                    setPublishForm({
                      ...publishForm,
                      source_custom_mode_id: e.target.value,
                      name: selectedMode?.display_name || publishForm.name,
                      description: selectedMode?.description || publishForm.description,
                    });
                  }}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink focus:outline-none focus:border-black transition-colors"
                >
                  <option value="">{tr("Choose a mode to share", "Choose a mode to share")}</option>
                  {customModes.map((mode) => (
                    <option key={mode.mode_id} value={mode.mode_id}>
                      {mode.mode_id}: {mode.display_name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Display name */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {tr("Display Name", "Display Name")} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={publishForm.name}
                onChange={(e) =>
                  setPublishForm({ ...publishForm, name: e.target.value })
                }
                placeholder={tr("Give your mode a memorable name", "Give your mode a memorable name")}
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink placeholder:text-gray-400 focus:outline-none focus:border-black transition-colors"
              />
            </div>

            {/* Mode description */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {tr("Description", "Description")}
              </label>
              <textarea
                value={publishForm.description}
                onChange={(e) =>
                  setPublishForm({ ...publishForm, description: e.target.value })
                }
                placeholder={tr("Describe what this mode is for and what makes it special...", "Describe what this mode is for and what makes it special...")}
                rows={4}
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink placeholder:text-gray-400 focus:outline-none focus:border-black transition-colors font-serif leading-relaxed resize-none"
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {tr("Category", "Category")} <span className="text-red-500">*</span>
              </label>
              <select
                value={publishForm.category}
                onChange={(e) =>
                  setPublishForm({ ...publishForm, category: e.target.value })
                }
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink focus:outline-none focus:border-black transition-colors"
              >
                <option value="">{tr("Choose a category", "Choose a category")}</option>
                {publishCategoryOptions.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-ink/10">
            <Button
              variant="outline"
              onClick={() => setIsPublishModalOpen(false)}
              disabled={isPublishing}
              className="bg-white text-black border border-black hover:bg-black hover:text-white transition-colors"
            >
              {tr("Cancel", "Cancel")}
            </Button>
            <Button
              onClick={handlePublish}
              disabled={
                isPublishing ||
                !publishForm.source_custom_mode_id ||
                !publishForm.name ||
                !publishForm.category
              }
              className="bg-ink text-white hover:bg-ink/90 transition-colors"
            >
              {isPublishing ? (
                <>
                  <Loader2 size={16} className="mr-2 animate-spin" />
                  {publishStatus || tr("Publishing...", "Publishing...")}
                </>
              ) : (
                tr("Confirm Publish", "Confirm Publish")
              )}
            </Button>
            {isPublishing && publishStatus && (
              <div className="mt-3 text-center">
                <p className="text-xs text-ink-light">
                  {publishStatus}
                </p>
                {publishStatus.includes("preview image") ? (
                  <p className="text-xs text-ink-light mt-1">
                    {tr("Waiting for image generation. This may take a few seconds to tens of seconds. Please hang tight...", "Waiting for image generation. This may take a few seconds to tens of seconds. Please hang tight...")}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Install device dialog */}
      <Dialog
        open={installDeviceModal.open}
        onClose={() => setInstallDeviceModal({ open: false, modeId: null })}
      >
        <DialogContent className="max-w-md">
          <DialogHeader onClose={() => setInstallDeviceModal({ open: false, modeId: null })}>
            <DialogTitle>{tr("Choose a Device to Install", "Choose a Device to Install")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {isLoadingDevices ? (
              <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm flex items-center justify-center">
                <Loader2 size={16} className="text-ink-light animate-spin" />
                <span className="ml-2 text-sm text-ink-light">{tr("Loading...", "Loading...")}</span>
              </div>
            ) : devices.length === 0 ? (
              <div className="w-full px-3 py-2 bg-white border border-gray-300 rounded-sm text-ink-light text-sm">
                {tr("No devices yet. Please bind a device first.", "No devices yet. Please bind a device first.")}
              </div>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <button
                    key={device.mac}
                    onClick={() => {
                      if (installDeviceModal.modeId !== null) {
                        handleInstall(installDeviceModal.modeId, device.mac);
                      }
                    }}
                    className="w-full px-4 py-3 bg-white border border-gray-300 rounded-sm text-left hover:border-black hover:shadow-[2px_2px_0_0_#000000] transition-all"
                  >
                    <div className="font-medium text-ink">{device.nickname || device.mac}</div>
                    <div className="text-sm text-ink-light mt-1">{device.mac}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-ink/10">
            <Button
              variant="outline"
              onClick={() => setInstallDeviceModal({ open: false, modeId: null })}
              className="bg-white text-black border border-black hover:bg-black hover:text-white transition-colors"
            >
              {tr("Cancel", "Cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-ink text-white px-4 py-3 rounded-sm shadow-[4px_4px_0_0_#000000] animate-fade-in">
          <p className="text-sm">{toastMessage}</p>
        </div>
      )}
    </div>
  );
}
