export const metadata = {
  title: 'SB Command Center',
  description: 'Sponsor prospecting and outreach for SB Agency',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
