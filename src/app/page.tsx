import { redirect } from 'next/navigation'

// The whole UI is public/app.html — one static file, no build step,
// same pattern as sb-crm. This route just sends people there.
export default function Home() {
  redirect('/app.html')
}
