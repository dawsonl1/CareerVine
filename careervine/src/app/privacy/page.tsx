export default function PrivacyPolicyPage() {
  const lastUpdated = "July 19, 2026";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-10">
          <h1 className="text-[28px] leading-9 font-normal text-foreground">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground mt-1">Last updated: {lastUpdated}</p>
        </div>

        <div className="prose prose-sm max-w-none space-y-8 text-foreground">

          <section>
            <h2 className="text-lg font-medium mb-3">1. Overview</h2>
            <p className="text-muted-foreground leading-relaxed">
              CareerVine (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is a personal networking CRM that helps you manage professional relationships, track meetings, and stay on top of follow-ups. This Privacy Policy explains what data we collect, how we use it, and your rights regarding that data. It covers both the CareerVine web app and the CareerVine Chrome extension.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">2. Data We Collect</h2>
            <div className="space-y-4 text-muted-foreground leading-relaxed">
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Account Information</h3>
                <p>Your email address and password (stored securely via Supabase Auth) when you create an account. You can also sign in to the Chrome extension with the same credentials.</p>
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
                <p>If you connect Gmail or Google Calendar, we access your emails and calendar events to display them in-app and sync meetings. For messages we read from your inbox, we store only metadata and a short preview (sender, subject, date, and a snippet), not the full body. Calendar events are cached in your CareerVine account to enable filtering and syncing features. Emails you write and send through CareerVine are handled separately, as described next. Section 6 describes exactly with whom this Google data is and is not shared.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Emails You Send Through CareerVine</h3>
                <p>When you send, schedule, or draft an email through CareerVine, or when it sends an automated follow-up you set up, we store the full content of that message (its subject and body), its recipients, and its send status in your account. We keep this so you can re-read exactly what you sent, review and edit your scheduled messages and drafts, and manage your follow-up sequences without re-fetching from Gmail. These messages are stored as part of your account data and are deleted when you delete your account.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">LinkedIn Data (via Chrome Extension)</h3>
                <p>The CareerVine Chrome extension works on LinkedIn profile pages and handles profile data in two ways:</p>
                <p className="mt-2"><span className="font-medium text-foreground">Duplicate check (automatic while you are signed in):</span> when you view a LinkedIn profile, the extension sends that profile&apos;s URL (not the page content) to our servers to check whether the person is already one of your contacts, so it can show you an &quot;already in CareerVine&quot; indicator. Only the profile&apos;s URL is sent for this check.</p>
                <p className="mt-2"><span className="font-medium text-foreground">Profile import (when you choose to import):</span> when you start an import, the extension reads the publicly visible text of the profile as it appears in your browser (the person&apos;s name, headline, location, current and past roles and companies, their &quot;About&quot; summary, and education), along with the profile&apos;s URL and profile photo, and sends it to our servers, where it is parsed by AI (OpenAI) into structured contact fields for you to review and edit before saving. This full read happens only when you start an import, or, if you turn on the optional auto-analyze setting, when you open a profile page.</p>
                <p className="mt-2">In both cases the extension only accesses the LinkedIn profile you are viewing. It does not read your LinkedIn messages, connections, or feed, does not access your LinkedIn account or credentials, and does not use LinkedIn&apos;s private APIs.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Contact Enrichment &amp; Prospect Discovery (LinkedIn)</h3>
                <p>Separately from the Chrome extension, CareerVine collects publicly available LinkedIn profile information on our servers through a third-party data provider (Apify) to keep your contacts current and help you grow your network:</p>
                <p className="mt-2"><span className="font-medium text-foreground">Enriching your contacts:</span> when you save or refresh a contact, we look up their public LinkedIn profile to fill in details like their current role, company, location, and education.</p>
                <p className="mt-2"><span className="font-medium text-foreground">Finding an email address:</span> when a contact you save has no email address on file, we may run a paid lookup that attempts to find and verify a likely professional email address for them.</p>
                <p className="mt-2"><span className="font-medium text-foreground">Suggesting new people:</span> for discovery features, we collect publicly available profile information (such as name, headline, location, current role, and photo) for people who are not yet your contacts, for example recent hires in relevant roles at companies you follow, and store it as suggestions in your account. When you dismiss a suggestion or add it as a contact, we clear the stored profile details for that suggestion and keep only a minimal record so it does not resurface. Suggestions you never act on are removed automatically once they stop appearing in our searches. The curated contact lists you can subscribe to are built from the same kind of publicly available professional information, which can include professional email addresses.</p>
                <p className="mt-2">This collection uses only publicly available profile information, runs under per-account spending limits, and is used only to power the CareerVine features described in this policy. We do not sell it or use it for advertising.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">File Attachments</h3>
                <p>Files you upload and attach to contacts or meetings are stored in a private, user-scoped storage bucket. Only you can access your files.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Usage Analytics</h3>
                <p>We use product analytics (via PostHog) to understand how CareerVine is used so we can improve it. On the web app this includes usage events (for example, signing up, connecting Gmail or Calendar, importing a contact, or sending an email), page views, and interaction events, along with session recordings in which all text you type is masked and sensitive fields are redacted, so your email contents and contact details are not captured in recordings. The Chrome extension sends only a small set of usage events (that it was installed, that you signed in, and that you imported a profile); it does not record your session or capture the content of pages you visit. Analytics are linked to your account when you are signed in, or to an anonymous identifier before then. We do not sell this data or use it for advertising.</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">3. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground leading-relaxed">
              <li>To provide and operate the CareerVine service</li>
              <li>To sync and display your Gmail and Google Calendar data within the app</li>
              <li>To send emails from your Gmail address on your behalf when you compose, schedule, or set up automated follow-ups in CareerVine</li>
              <li>To parse LinkedIn profiles using AI when you use the Chrome extension</li>
              <li>To enrich your contacts with public profile details and suggest new people to add, using publicly available LinkedIn data collected through Apify</li>
              <li>To generate AI-written emails, parse transcripts, and power follow-up suggestions using OpenAI</li>
              <li>If you provide your own OpenAI API key, to route your AI requests through your OpenAI account instead of ours</li>
              <li>To transcribe audio/video recordings you upload using Deepgram (or, if you provide your own Deepgram API key, through your Deepgram account instead of ours)</li>
              <li>To send you follow-up reminder emails if you configure them</li>
              <li>To measure product usage with privacy-respecting analytics so we can improve CareerVine</li>
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
                <h3 className="text-sm font-medium text-foreground mb-1">OpenAI (optional BYO key)</h3>
                <p>By default, AI features (email drafting, transcript parsing, follow-up suggestions, LinkedIn profile parsing) are processed using CareerVine&apos;s shared OpenAI API key. If you add your own OpenAI API key in Settings → AI, your key is encrypted before storage and used server-side only for your requests. We never return it to your browser. You may optionally enable OpenAI&apos;s data-sharing program on your own account for free daily tokens; if you do, prompts sent through your key (which can include contact names and conversation content) may be used by OpenAI per their policies. See <a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">OpenAI&apos;s Privacy Policy</a>.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Deepgram (optional BYO key)</h3>
                <p>When you upload an audio or video recording of a meeting, the audio is sent to Deepgram to produce a transcript. By default this uses CareerVine&apos;s shared Deepgram API key. If you add your own Deepgram API key in Settings → AI, your key is encrypted before storage and used server-side only for your requests. We never return it to your browser, and transcription runs on your Deepgram account instead. See <a href="https://deepgram.com/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Deepgram&apos;s Privacy Policy</a>.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Apify (LinkedIn data)</h3>
                <p>We use Apify, a third-party web data platform, to collect publicly available LinkedIn profile information for contact enrichment, email-address lookup, and prospect discovery (see Section 2). See <a href="https://apify.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Apify&apos;s Privacy Policy</a>.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">PostHog</h3>
                <p>We use PostHog for product analytics and, on the web app, session replay (with all inputs masked). Usage data is processed on PostHog&apos;s infrastructure. See <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">PostHog&apos;s Privacy Policy</a>.</p>
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
            <h2 className="text-lg font-medium mb-3">6. How We Share Google User Data</h2>
            <div className="space-y-4 text-muted-foreground leading-relaxed">
              <p>
                This section describes with whom we share, transfer, or disclose Google user data, meaning the information we receive from Google APIs when you connect your Google account: your Gmail messages and their metadata, your Google Calendar events, your Gmail address and send-as aliases, and your Google OAuth tokens. We do not sell Google user data, and we do not share it with advertisers or data brokers. We share it only in the following limited circumstances:
              </p>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Service providers that process it on our behalf</h3>
                <p>We share Google user data with Supabase, which hosts our database and stores your synced Gmail data, calendar events, and encrypted Google OAuth tokens, and with Vercel, which hosts our application servers and processes this data in transit when we call Google APIs on your behalf. Both act as data processors for CareerVine, use the data solely to operate the service, and are bound by their own privacy and security commitments.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">At your direction</h3>
                <p>When you send an email through CareerVine, the message is delivered to the recipients you choose through Gmail. If you connect a third-party AI assistant to CareerVine through our MCP integration, that assistant and its provider can access the email subjects, previews, sender and recipient addresses, and calendar events you ask it to work with. This applies only to assistants you explicitly connect and authorize through CareerVine&apos;s sign-in and consent screen.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Legal reasons</h3>
                <p>We may disclose data if we believe in good faith that doing so is required by law, regulation, legal process, or an enforceable governmental request.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Business transfers</h3>
                <p>If CareerVine is involved in a merger, acquisition, or sale of assets, we will notify you and obtain your explicit consent before your Google user data is transferred as part of that transaction or becomes subject to a different privacy policy.</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Human access</h3>
                <p>No person at CareerVine reads your Gmail data or calendar events except with your explicit permission (for example, if you ask us to look at a specific issue while helping you with support), when necessary for security purposes such as investigating abuse, to comply with applicable law, or as part of aggregated and anonymized internal operations.</p>
              </div>
              <p>
                No one else receives your Google user data. In particular, we do not send your Gmail message content or calendar events to OpenAI or any other AI provider, they are not included in the analytics data we send to PostHog, and they are never used for advertising or model training.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">7. Data Storage, Security &amp; Retention</h2>
            <p className="text-muted-foreground leading-relaxed">
              All data is stored with row-level security policies so that only your account can access your data. We use HTTPS for all data transmission. Google OAuth tokens are encrypted before storage and used only to make API calls on your behalf.
</p>
            <p className="text-muted-foreground leading-relaxed mt-3">
              We retain your data for as long as your account is active. If you disconnect Gmail without deleting your account, we revoke our access token with Google and delete the email messages we synced from your inbox at that time; if you disconnect Google Calendar, we delete your cached calendar events. When you delete your account, we remove your data, including your contacts, sent and scheduled messages, and uploaded files, from our database and file storage, along with any contact photos we host on our content delivery network. We also periodically remove scraped profile data we no longer need, such as suggestions you have dismissed or added and prospects removed from curated lists. Some data is stored on our third-party providers&apos; systems (see Section 4) and is removed according to their retention practices.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">8. Your Rights</h2>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground leading-relaxed">
              <li>You can delete your account and all associated data at any time by contacting us</li>
              <li>You can disconnect Google at any time from your account settings, which revokes our access to your Gmail and Calendar and deletes the synced email messages and cached calendar events we hold (see Section 7)</li>
              <li>You can uninstall the Chrome extension at any time from your browser, which stops all collection by the extension and clears the data it stored locally</li>
              <li>You can request an export of your data, or ask us to stop using your data for product analytics, by contacting us</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">9. Chrome Extension</h2>
            <div className="space-y-3 text-muted-foreground leading-relaxed">
              <p>
                The CareerVine Chrome extension&apos;s in-page component runs only on LinkedIn (linkedin.com). To do its job it communicates in the background with CareerVine&apos;s servers, with Supabase (to sign you in), and with PostHog (to record the usage events described in Section 2). It requests only the browser permissions it needs: storage (to keep you signed in and cache your recent work) and access to LinkedIn pages (to detect profiles and import them).
              </p>
              <p>
                Stored locally in your browser: your CareerVine sign-in session (so you stay logged in), a short-lived cache of profiles you recently viewed (about two hours, so revisiting loads instantly), and your list of recent imports. Sent to our servers: the URL of a LinkedIn profile you view (for the duplicate check described in Section 2), the profile text you choose to import, and the small set of usage events described under &quot;Usage Analytics&quot;.
              </p>
              <p>
                The extension does not read your browsing history and does not access your LinkedIn account, credentials, private messages, connections, or feed. While you are signed in, when you view a LinkedIn profile it sends that profile&apos;s URL to our servers to check whether the person is already one of your contacts. It reads the full content of a profile only when you start an import, or when you enable the optional auto-analyze setting. It does not collect data from any site other than the LinkedIn profile you are viewing.
              </p>
              <p>
                <span className="font-medium text-foreground">Limited Use.</span> CareerVine&apos;s collection and use of information received through the Chrome extension complies with the <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Chrome Web Store User Data Policy</a>, including its Limited Use requirements. We use this data only to provide the profile-import feature you request. We do not sell it, use it for advertising, or use it for any purpose unrelated to the features described in this policy.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">10. Changes to This Policy</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update this policy from time to time. We will post the updated policy on this page with a new &quot;Last updated&quot; date, and continued use of CareerVine after changes constitutes acceptance of the updated policy. There is one exception: if a change means we would use your Google user data in a way this policy does not already describe, we will notify you and ask for your consent before applying that new practice to your data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">11. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have any questions about this Privacy Policy, please contact us at{" "}
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
