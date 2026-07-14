/**
 * Chrome Web Store listing for the CareerVine LinkedIn import extension.
 * Prefer the Vercel env var so the listing can move without a code change;
 * fall back to the published listing so local/preview builds still link correctly.
 */
export const EXTENSION_STORE_URL =
  process.env.NEXT_PUBLIC_EXTENSION_STORE_URL ||
  "https://chromewebstore.google.com/detail/careervine-linkedin-integ/jdiefmjeiihacjencfdempbgapnppooj";
