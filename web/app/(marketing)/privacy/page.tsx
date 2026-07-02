import type { Metadata } from 'next'

import { Kicker } from '@/components/ui/kicker'
import { GradientText } from '@/components/ui/gradient-text'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How SlimCast collects, uses, and protects your data. We do not sell your personal information.',
}

const LAST_UPDATED = 'July 1, 2026'

type Section = {
  heading: string
  body: React.ReactNode
}

const SECTIONS: Section[] = [
  {
    heading: '1. Who we are',
    body: (
      <p>
        SlimCast is operated by AbstraScapes LLC, a Florida, USA limited liability company
        (&ldquo;SlimCast,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). This policy explains what
        data we collect when you use the SlimCast website, dashboard, and OBS plugin, why we
        collect it, and the choices you have.
      </p>
    ),
  },
  {
    heading: '2. The short version',
    body: (
      <p>
        We collect only what&rsquo;s needed to run the service and bill you correctly.{' '}
        <strong className="text-ink">
          We do not sell your personal information, and we never will.
        </strong>{' '}
        Your platform stream keys and OAuth tokens are encrypted at rest and are never shared with
        the rented GPUs that transcode your video.
      </p>
    ),
  },
  {
    heading: '3. Information we collect',
    body: (
      <>
        <p>We collect the following categories of information:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong className="text-ink">Account information:</strong> your email address,
            authentication credentials (handled by our auth provider, Supabase), and account
            preferences (output resolution, bitrate, portrait-crop settings).
          </li>
          <li>
            <strong className="text-ink">Platform connections:</strong> if you connect Twitch,
            YouTube, or Kick via OAuth, we store the access/refresh tokens needed to fetch your
            stream key. If you paste a stream key manually (e.g. TikTok), we store that key. All
            keys and tokens are encrypted at rest with AES-256-GCM and decrypted only to configure
            your stream. For YouTube specifically, we request read/manage access to your YouTube
            account (the <code className="text-xs text-ink-faint">youtube</code> scope) solely to
            read your channel and live-broadcast information and create or manage the live
            broadcast SlimCast streams to on your behalf, and to retrieve its RTMP ingestion URL
            and stream key. We do not access your videos, playlists, comments, or any other
            YouTube data beyond what&rsquo;s needed for that live broadcast.
          </li>
          <li>
            <strong className="text-ink">Billing information:</strong> we use Stripe to process
            payments and manage subscriptions. We store your Stripe customer/subscription IDs and
            token balance — we do not see or store your full card number.
          </li>
          <li>
            <strong className="text-ink">Usage and session data:</strong> stream session start/end
            times, duration, platforms streamed to, and tokens deducted, so we can bill accurately
            and show you your history.
          </li>
          <li>
            <strong className="text-ink">Technical and connection data:</strong> IP address (for
            abuse prevention and rate limiting), device/API key identifiers used by the OBS
            plugin, and stream health metrics (bitrate, dropped frames) used to render the
            connection graph in the dock.
          </li>
        </ul>
      </>
    ),
  },
  {
    heading: '4. How we use your information',
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>To operate the service: provisioning a GPU, configuring outputs, and delivering your stream to the platforms you&rsquo;ve connected.</li>
        <li>To bill you correctly for tokens consumed and manage your subscription.</li>
        <li>To detect and prevent abuse, fraud, and violations of our Terms of Service.</li>
        <li>To provide support when you contact us.</li>
        <li>To send you service-related notices (billing receipts, low-balance warnings, security alerts). We do not send marketing email without your consent.</li>
      </ul>
    ),
  },
  {
    heading: '5. What we don’t do',
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>We do not sell, rent, or trade your personal information to data brokers or advertisers.</li>
        <li>We do not use third-party advertising trackers or ad-network cookies. Site analytics run on Vercel Analytics and Speed Insights, which are privacy-respecting and do not build cross-site ad profiles.</li>
        <li>We do not send your stream keys or OAuth tokens to the rented GPUs that transcode your video &mdash; those credentials stay on our trusted relay infrastructure.</li>
      </ul>
    ),
  },
  {
    heading: '6. Google API Services User Data',
    body: (
      <p>
        SlimCast&rsquo;s use and transfer of information received from Google APIs adheres to the{' '}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          className="text-primary underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. We use YouTube data only to create and manage
        the live broadcast you start through SlimCast and to retrieve its stream key; we do not
        use it to serve advertising, and we do not allow it to be read by humans except where
        necessary for security purposes, to comply with applicable law, or with your consent.
      </p>
    ),
  },
  {
    heading: '7. Who we share data with',
    body: (
      <>
        <p>
          We share data only with the service providers (&ldquo;subprocessors&rdquo;) needed to
          run SlimCast, each bound by their own privacy and security commitments:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li><strong className="text-ink">Supabase</strong> &mdash; authentication and database hosting.</li>
          <li><strong className="text-ink">Stripe</strong> &mdash; payment processing and subscription billing.</li>
          <li><strong className="text-ink">Vercel</strong> &mdash; application hosting, and privacy-respecting site analytics.</li>
          <li><strong className="text-ink">Vast.ai, RunPod, and Hetzner</strong> &mdash; on-demand cloud GPU and relay infrastructure used to transcode and deliver your stream. These providers never receive your stream keys.</li>
          <li><strong className="text-ink">Twitch, YouTube (Google), and Kick</strong> &mdash; only if you choose to connect an account via OAuth, to fetch your stream key on your behalf.</li>
        </ul>
        <p className="mt-3">
          We may also disclose information if required by law, or to protect the rights, property,
          or safety of SlimCast, our users, or others.
        </p>
      </>
    ),
  },
  {
    heading: '8. Data retention',
    body: (
      <p>
        We retain account and billing data for as long as your account is active, and for a
        reasonable period afterward to meet our legal, tax, and fraud-prevention obligations.
        Stream session history is kept to show you your usage. You can request deletion of your
        account and associated data at any time (see Section 10); purchased-token balances are
        forfeited or refunded per the process described in our{' '}
        <a href="/terms" className="text-primary underline underline-offset-4">
          Terms of Service
        </a>
        .
      </p>
    ),
  },
  {
    heading: '9. Security',
    body: (
      <p>
        Stream keys and OAuth tokens are encrypted at rest with AES-256-GCM. Data in transit is
        encrypted with TLS. Access to production data is restricted to what&rsquo;s needed to
        operate the service. No system is perfectly secure, and we can&rsquo;t guarantee absolute
        security, but we design SlimCast so that a compromised transcoding GPU never has access to
        your credentials.
      </p>
    ),
  },
  {
    heading: '10. Your rights and choices',
    body: (
      <>
        <p>You can, at any time:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>Access or update your account information from the dashboard.</li>
          <li>Disconnect a platform or revoke an OAuth connection.</li>
          <li>Rotate or revoke your OBS plugin API key.</li>
          <li>Request deletion of your account and personal data by contacting us, or using the account-deletion option in your dashboard settings.</li>
        </ul>
        <p className="mt-3">
          If you&rsquo;re located in a jurisdiction with statutory data rights (for example the
          EU/UK GDPR or the California CCPA/CPRA), you may also have rights to access, correct,
          port, or restrict processing of your data. Contact us and we&rsquo;ll honor applicable
          requests.
        </p>
      </>
    ),
  },
  {
    heading: '11. Children’s privacy',
    body: (
      <p>
        SlimCast is not directed at children under 13, and we do not knowingly collect personal
        information from children under 13. If you believe a child has provided us with personal
        information, contact us and we&rsquo;ll delete it.
      </p>
    ),
  },
  {
    heading: '12. International users',
    body: (
      <p>
        SlimCast is operated from the United States, and our infrastructure providers may process
        data in other countries. By using SlimCast, you consent to your information being
        transferred to and processed in the United States and other countries where our
        subprocessors operate.
      </p>
    ),
  },
  {
    heading: '13. Changes to this policy',
    body: (
      <p>
        We may update this policy as the service evolves. We&rsquo;ll update the &ldquo;last
        updated&rdquo; date above, and for material changes we&rsquo;ll make a reasonable effort to
        notify you (e.g. by email or an in-app notice).
      </p>
    ),
  },
  {
    heading: '14. Contact us',
    body: (
      <p>
        Questions about this policy or your data? Email{' '}
        <a href="mailto:oxlynum@gmail.com" className="text-primary underline underline-offset-4">
          oxlynum@gmail.com
        </a>
        . We&rsquo;re AbstraScapes LLC, Florida, USA.
      </p>
    ),
  },
]

export default function PrivacyPage() {
  return (
    <>
      <section className="border-b border-line">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-14 text-center md:pt-28">
          <div className="flex justify-center">
            <Kicker>Legal</Kicker>
          </div>
          <h1 className="mt-5 font-display text-[clamp(2.5rem,5.5vw,4rem)] leading-[1.05] font-bold tracking-[-0.02em] text-ink">
            Privacy <GradientText as="span">Policy</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-muted">
            Your stream keys stay encrypted. Your data stays yours. We don&rsquo;t sell it.
          </p>
          <p className="mt-4 text-sm text-ink-faint">Last updated {LAST_UPDATED}</p>
        </div>
      </section>

      <section className="py-16 md:py-20">
        <div className="mx-auto max-w-3xl px-6">
          <div className="space-y-12">
            {SECTIONS.map((section) => (
              <div key={section.heading}>
                <h2 className="font-display text-xl font-semibold tracking-[-0.01em] text-ink">
                  {section.heading}
                </h2>
                <div className="mt-3 text-sm leading-relaxed text-ink-muted">{section.body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
