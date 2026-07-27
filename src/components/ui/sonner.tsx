"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          /* Success toast — emerald accent */
          "--success-bg": "oklch(0.97 0.02 162 / 0.95)",
          "--success-text": "oklch(0.3 0.06 162)",
          "--success-border": "oklch(0.55 0.13 162 / 0.35)",
          /* Error toast — rose accent */
          "--error-bg": "oklch(0.97 0.02 25 / 0.95)",
          "--error-text": "oklch(0.4 0.15 25)",
          "--error-border": "oklch(0.58 0.22 25 / 0.35)",
          /* Warning toast — amber accent */
          "--warning-bg": "oklch(0.97 0.03 85 / 0.95)",
          "--warning-text": "oklch(0.35 0.12 85)",
          "--warning-border": "oklch(0.7 0.15 85 / 0.35)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
