import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { SWRegister } from '@/components/sw-register'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://segment.iverfinne.no'),
  title: 'Subject Isolator',
  description: 'Isolate the subject of an image on a clean white background.',
  applicationName: 'Subject Isolator',
  appleWebApp: {
    capable: true,
    title: 'Subject Isolator',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#000000',
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased overscroll-none">
        {children}
        <SWRegister />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
