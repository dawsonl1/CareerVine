import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service · CareerVine",
  description:
    "The terms that govern your use of CareerVine, the personal networking CRM.",
};

export default function TermsOfServicePage() {
  const lastUpdated = "July 11, 2026";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-10">
          <h1 className="text-[28px] leading-9 font-normal text-foreground">Terms of Service</h1>
          <p className="text-sm text-muted-foreground mt-1">Last updated: {lastUpdated}</p>
        </div>

        <div className="prose prose-sm max-w-none space-y-8 text-foreground">

          <section>
            <h2 className="text-lg font-medium mb-3">1. Acceptance of These Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              These Terms of Service (&quot;Terms&quot;) are a legal agreement between you and CareerVine (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) governing your use of the CareerVine web app and the CareerVine Chrome extension (together, the &quot;Service&quot;). By creating an account or using the Service, you agree to these Terms. If you do not agree, please do not use the Service. These Terms work alongside our <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>, which explains how we handle your data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">2. Description of the Service</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine is a personal networking CRM that helps you manage professional relationships, track meetings and interactions, and stay on top of follow-ups. Optional features include connecting Gmail and Google Calendar to view and sync your messages and events, a Chrome extension that imports LinkedIn profiles you choose to save, and AI-assisted tools that draft emails, parse transcripts, and suggest follow-ups. We may add, change, or remove features over time.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">3. Eligibility</h2>
            <p className="text-muted-foreground leading-relaxed">
              You must be at least 18 years old to use the Service. By using CareerVine, you represent that you meet this requirement and that you are able to enter into a binding agreement.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">4. Your Account</h2>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground leading-relaxed">
              <li>You are responsible for providing accurate information when you create an account</li>
              <li>You are responsible for keeping your password and sign-in credentials secure, including the credentials you use to sign in to the Chrome extension</li>
              <li>You are responsible for all activity that happens under your account</li>
              <li>You agree to notify us promptly if you believe your account has been accessed without your permission</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">5. Acceptable Use</h2>
            <p className="text-muted-foreground leading-relaxed mb-3">You agree not to:</p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground leading-relaxed">
              <li>Use the Service for any unlawful purpose or in violation of any applicable law or regulation</li>
              <li>Use the Service, or the Chrome extension, in a way that violates the terms of any third-party platform, including LinkedIn, Google, or your email provider</li>
              <li>Send unsolicited bulk email, spam, or harassing messages through the follow-up and outreach features</li>
              <li>Upload or store information about other people that you do not have the right to store, or use that information in violation of applicable privacy laws</li>
              <li>Attempt to reverse engineer, decompile, scrape, or gain unauthorized access to the Service or its underlying systems</li>
              <li>Interfere with, disrupt, or place an unreasonable load on the Service or its infrastructure</li>
              <li>Resell, sublicense, or commercially exploit the Service without our written permission</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">6. Your Content and Data</h2>
            <div className="space-y-3 text-muted-foreground leading-relaxed">
              <p>
                You retain ownership of the content you add to CareerVine, including your contacts, notes, meeting logs, transcripts, and file attachments (&quot;Your Content&quot;). You grant us a limited license to store, process, and display Your Content solely to operate and improve the Service for you, and to provide the features you use, such as AI drafting, transcription, and Gmail or Calendar syncing.
              </p>
              <p>
                Much of Your Content describes other people, such as the contacts you track. You are responsible for having a lawful basis to store and use that information, and for complying with any privacy or data-protection obligations that apply to you. We handle all data as described in our <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>.
              </p>
              <p>
                You can delete your content or your entire account at any time, as described in the Privacy Policy.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">7. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine relies on and integrates with third-party services, including Google (Gmail and Google Calendar), OpenAI, Deepgram, Supabase, and PostHog, and the Chrome extension operates on LinkedIn. Your use of those services through CareerVine may also be subject to their own terms and policies. We are not responsible for third-party services, and their availability within CareerVine may change. Where you provide your own OpenAI or Deepgram API key, your use of those accounts is governed by your agreements with those providers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">8. Google and LinkedIn Data</h2>
            <p className="text-muted-foreground leading-relaxed">
              When you connect your Google account, CareerVine&apos;s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google API Services User Data Policy</a>, including the Limited Use requirements. Our collection and use of information through the Chrome extension complies with the <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Chrome Web Store User Data Policy</a>, including its Limited Use requirements. The specifics of what we access and how we use it are described in our <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">9. AI-Assisted Features</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine uses AI to help you draft emails, parse LinkedIn profiles and transcripts, and generate follow-up suggestions. AI output can be inaccurate or incomplete. You are responsible for reviewing anything the AI produces before you rely on it or send it, including any message you send to a contact. CareerVine does not provide legal, financial, or professional career advice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">10. Fees</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine is currently offered free of charge. We may introduce paid features or plans in the future. If we do, we will show you the applicable pricing and terms before you are charged, and your continued use of a paid feature will be subject to those terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">11. Intellectual Property</h2>
            <p className="text-muted-foreground leading-relaxed">
              The Service, including the CareerVine name, software, and design, is owned by us and protected by intellectual-property laws. We grant you a limited, non-exclusive, non-transferable right to use the Service as intended by these Terms. Nothing in these Terms transfers any ownership of the Service to you, and you may not copy, modify, or redistribute the Service except as expressly allowed.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">12. Disclaimers</h2>
            <p className="text-muted-foreground leading-relaxed">
              The Service is provided on an &quot;as is&quot; and &quot;as available&quot; basis, without warranties of any kind, whether express or implied, to the fullest extent permitted by law. We do not warrant that the Service will be uninterrupted, error-free, or secure, or that any content or AI output will be accurate. You use the Service at your own discretion and risk.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">13. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              To the fullest extent permitted by law, CareerVine will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of data, profits, or goodwill, arising out of or related to your use of the Service. To the extent liability cannot be excluded, our total liability for any claim relating to the Service will not exceed the greater of the amount you paid us for the Service in the twelve months before the claim, or fifty US dollars.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">14. Termination</h2>
            <p className="text-muted-foreground leading-relaxed">
              You may stop using the Service at any time and may delete your account and associated data as described in the Privacy Policy. We may suspend or terminate your access if you violate these Terms or use the Service in a way that could harm CareerVine, other users, or third parties. Sections that by their nature should survive termination, such as intellectual property, disclaimers, and limitation of liability, will continue to apply.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">15. Changes to the Service and These Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update the Service and these Terms from time to time. When we change these Terms, we will post the updated version on this page with a new &quot;Last updated&quot; date. Your continued use of the Service after changes take effect constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">16. Governing Law</h2>
            <p className="text-muted-foreground leading-relaxed">
              These Terms are governed by the laws of the State of Utah, United States, without regard to its conflict-of-laws rules. You agree that any dispute relating to these Terms or the Service will be subject to the exclusive jurisdiction of the state and federal courts located in Utah, to the extent permitted by law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">17. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have any questions about these Terms, please contact us at{" "}
              <a href="mailto:dawson@careervine.app" className="text-primary hover:underline">
                dawson@careervine.app
              </a>
              .
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
