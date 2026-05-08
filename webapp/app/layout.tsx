import type { Metadata } from "next";
import { Inter, Noto_Serif_SC } from "next/font/google";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";
import { t } from "@/lib/i18n";
import { localeForRequest } from "@/lib/locale-server";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const notoSerifSc = Noto_Serif_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-serif-sc",
});

const baseMetadata: Metadata = {
  title: "InkSight | AI E-Ink Display",
  description: "InkSight is an AI-powered e-ink desktop companion with web flashing, device configuration, preview, and a community mode plaza.",
  keywords: ["InkSight", "AI e-ink display", "E-Ink", "ESP32", "LLM", "desktop companion"],
  manifest: "/manifest.json",
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "mobile-web-app-capable": "yes",
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await localeForRequest();
  return {
    ...baseMetadata,
    title: t(locale, "meta.title"),
    description: t(locale, "meta.description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await localeForRequest();
  const lang = locale === "en" ? "en-US" : "zh-CN";

  return (
    <html lang={lang}>
      <body className={`${inter.variable} ${notoSerifSc.variable} antialiased`}>
        <Navbar />
        <main className="min-h-screen">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
