"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { authHeaders, fetchCurrentUser } from "@/lib/auth";

function ClaimPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const pairCode = (searchParams.get("code") || "").trim().toUpperCase();
  const [status, setStatus] = useState<"loading" | "pending" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
        if (!token && !pairCode) {
        if (!cancelled) {
          setStatus("error");
          setMessage("Missing pairing information");
        }
        return;
      }
      try {
        const user = await fetchCurrentUser();
        if (!user) {
          const next = token
            ? `/claim?token=${encodeURIComponent(token)}`
            : `/claim?code=${encodeURIComponent(pairCode)}`;
          router.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        const res = await fetch("/api/claim/consume", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(token ? { token } : { pair_code: pairCode }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Claim failed");
        }
        if (data.status === "claimed" || data.status === "already_member") {
          router.replace(`/config?mac=${encodeURIComponent(data.mac)}`);
          return;
        }
        if (!cancelled) {
          setStatus("pending");
          setMessage(data.owner_username ? `Binding request submitted. Waiting for ${data.owner_username}'s approval.` : "Binding request submitted. Waiting for owner approval.");
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "Claim failed");
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [pairCode, router, token]);

  return (
    <div className="mx-auto max-w-md px-6 py-20">
      <Card>
        <CardHeader>
          <CardTitle className="text-center font-serif text-2xl">Claim Device</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          {status === "loading" && (
            <div className="flex items-center justify-center gap-2 text-sm text-ink-light">
              <Loader2 size={16} className="animate-spin" /> Verifying pairing information...
            </div>
          )}
          {status === "pending" && (
            <>
              <p className="text-sm text-ink">{message}</p>
              <Button variant="outline" onClick={() => router.push("/config")}>Back to devices</Button>
            </>
          )}
          {status === "error" && (
            <>
              <p className="text-sm text-red-600">{message}</p>
              <Button variant="outline" onClick={() => router.push("/config")}>Back to devices</Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ClaimPage() {
  return (
    <Suspense>
      <ClaimPageInner />
    </Suspense>
  );
}
