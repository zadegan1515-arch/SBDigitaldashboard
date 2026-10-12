// The build's schema push (package.json "build"). Every Vercel deployment —
// production AND each branch preview — points at the same Neon database, so a
// preview built from a branch that hasn't merged main pushed its older schema
// over production's and dropped the newer column (Oct 12 2026: a branch
// without Brand.kind dropped it and every brand page failed "The column
// `Brand.kind` does not exist"). Only the production build changes the
// database now; a preview leaves it as main made it. Local builds
// (VERCEL_ENV unset) still push, to whatever DATABASE_URL you gave them.
import { execSync } from 'node:child_process'

const env = process.env.VERCEL_ENV
if (env && env !== 'production') {
  console.log(`db-push: skipped on a ${env} build — only production changes the shared database`)
} else {
  execSync('prisma db push --skip-generate', { stdio: 'inherit' })
}
