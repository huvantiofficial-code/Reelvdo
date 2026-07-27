import type { Metadata, Viewport } from "next";
import { Work_Sans } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import RegisterSW from "@/components/pwa/register-sw";
import InstallPrompt from "@/components/pwa/install-prompt";

const workSans = Work_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reel — Video Fetch & Download",
  description: "Paste a link. Fetch the video. Watch or download in one click.",
  keywords: ["video downloader", "m3u8", "mp4", "video fetch", "stream download"],
  authors: [{ name: "Reel" }],
  manifest: "/manifest.json",
  applicationName: "Reel",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Reel",
  },
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f0d" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${workSans.variable} font-sans antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
          <RegisterSW />
          <InstallPrompt />
        </ThemeProvider>
      </body>
    </html>
  );
}
