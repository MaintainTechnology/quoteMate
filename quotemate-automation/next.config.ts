import type { NextConfig } from "next";
import path from "node:path";

// Pin the Turbopack workspace root to this app directory so the dev server
// doesn't pick up a stray lockfile in the parent (the repo root has an
// orphaned package-lock.json from an accidental `npm install` outside this app).
const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "."),
  },
};

export default nextConfig;
