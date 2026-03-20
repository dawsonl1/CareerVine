export default function PrivacyPolicyPage() {
  const lastUpdated = "February 18, 2026";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-10">
          <h1 className="text-[28px] leading-9 font-normal text-foreground">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground mt-1">Last updated: {lastUpdated}</p>
        </div>

        <div className="prose prose-sm max-w-none space-y-8 text-foreground">

          <section>
            <h2 className="text-lg font-medium mb-3">1. Overview</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is a personal networking CRM that helps you manage professional relationships, track meetings, and stay on top of follow-ups. This Privacy Policy explains what data we collect, how we use it, and your rights regarding that data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">2. Data We Collect</h2>
            <div className="space-y-4 text-muted-foreground leading-relaxed">
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Account Information</h3>
                <p>Your email address and password (stored securely via Supabase Auth) when you create an account.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Contact Data</h3>
                <p>Names, email addresses, phone numbers, job titles, companies, schools, locations, and notes that you manually enter or import via the Chrome extension.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Meeting &amp; Interaction Logs</h3>
                <p>Meeting notes, transcripts, dates, and interaction history that you record within the app.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Google Account Data (optional)</h3>
                <p>If you connect Gmail or Google Calendar, we access your emails and calendar events to display them in-app and sync meetings. We only read and display this data — we do not store the full content of your emails on our servers. Calendar events are cached locally in your CareerVine account to enable filtering and syncing features.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">LinkedIn Data (via Chrome Extension)</h3>
                <p>When you use the CareerVine Chrome extension on a LinkedIn profile page, the extension extracts publicly visible profile information (name, title, company, school, location) and sends it to our servers via OpenAI for parsing. This data is only processed when you initiate an import.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">File Attachments</h3>
                <p>Files you upload and attach to contacts or meetings are stored in a private, user-scoped storage bucket. Only you can access your files.</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">3. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground leading-relaxed">
              <li>To provide and operate the CareerVine service</li>
              <li>To sync and display your Gmail and Google Calendar data within the app</li>
              <li>To parse LinkedIn profiles using AI when you use the Chrome extension</li>
              <li>To generate AI-written emails using OpenAI when you use the &quot;Write with AI&quot; feature</li>
              <li>To send you follow-up reminder emails if you configure them</li>
              <li>We do not sell your data to third parties</li>
              <li>We do not use your data for advertising</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">4. Third-Party Services</h2>
            <div className="space-y-3 text-muted-foreground leading-relaxed">
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Supabase</h3>
                <p>We use Supabase for database storage and authentication. Your data is stored on Supabase-managed servers. See <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Supabase&apos;s Privacy Policy</a>.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Google APIs</h3>
                <p>When you connect your Google account, we use Gmail and Google Calendar APIs. CareerVine&apos;s use of Google user data complies with the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">OpenAI</h3>
                <p>Profile data extracted via the Chrome extension and email drafts generated with &quot;Write with AI&quot; are processed by OpenAI&apos;s API. See <a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">OpenAI&apos;s Privacy Policy</a>.</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">5. Google API Limited Use Disclosure</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine&apos;s use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google API Services User Data Policy</a>, including the Limited Use requirements. We only use Google data to provide and improve the features visible to you within CareerVine.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">6. Data Storage &amp; Security</h2>
            <p className="text-muted-foreground leading-relaxed">
              All data is stored with row-level security policies so that only your account can access your data. We use HTTPS for all data transmission. Google OAuth tokens are stored securely and used only to make API calls on your behalf.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">7. Your Rights</h2>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground leading-relaxed">
              <li>You can delete your account and all associated data at any time by contacting us</li>
              <li>You can disconnect Google at any time from your account settings, which will revoke our access to your Gmail and Calendar</li>
              <li>You can request an export of your data by contacting us</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">8. Chrome Extension</h2>
            <p className="text-muted-foreground leading-relaxed">
              The CareerVine Chrome extension only activates on LinkedIn profile pages. It stores your CareerVine session locally in Chrome&apos;s storage to keep you signed in. It does not track your browsing history or activity on any pages other than LinkedIn profiles when you explicitly initiate an import.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">9. Changes to This Policy</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update this policy from time to time. We will post the updated policy on this page with a new &quot;Last updated&quot; date. Continued use of CareerVine after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">10. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have any questions about this Privacy Policy, please contact us at{" "}
              <a href="mailto:dawsonlpitcher@gmail.com" className="text-primary hover:underline">
                dawsonlpitcher@gmail.com
              </a>
              .
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
