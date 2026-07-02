import type { Metadata } from 'next'

import { Kicker } from '@/components/ui/kicker'
import { GradientText } from '@/components/ui/gradient-text'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms governing your use of SlimCast.',
}

const LAST_UPDATED = 'July 1, 2026'

type Section = {
  heading: string
  body: React.ReactNode
}

const SECTIONS: Section[] = [
  {
    heading: '1. Agreement to terms',
    body: (
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) are an agreement between you and AbstraScapes
        LLC, a Florida, USA limited liability company (&ldquo;SlimCast,&rdquo; &ldquo;we,&rdquo;
        &ldquo;us&rdquo;), governing your use of the SlimCast website, dashboard, OBS plugin, and
        related infrastructure (together, the &ldquo;Service&rdquo;). By creating an account or
        using the Service, you agree to these Terms. If you don&rsquo;t agree, don&rsquo;t use the
        Service.
      </p>
    ),
  },
  {
    heading: '2. What SlimCast does',
    body: (
      <p>
        SlimCast lets you push a single video stream from OBS to our infrastructure, which
        transcodes and delivers it to the streaming platforms you connect (currently Twitch, Kick,
        YouTube, and TikTok). Usage is metered in tokens under the pricing described at{' '}
        <a href="/pricing" className="text-primary underline underline-offset-4">
          slimcast.io/pricing
        </a>
        , which is incorporated into these Terms by reference and may change from time to time.
      </p>
    ),
  },
  {
    heading: '3. Accounts and eligibility',
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>You must be at least 13 years old, and old enough to lawfully agree to these Terms in your jurisdiction, to use SlimCast.</li>
        <li>You&rsquo;re responsible for keeping your account credentials and OBS plugin API key confidential, and for all activity under your account.</li>
        <li>You must provide accurate account information and keep it up to date.</li>
        <li>You&rsquo;re responsible for complying with the terms of service of every platform you connect to SlimCast (Twitch, YouTube, Kick, TikTok, etc.) &mdash; SlimCast is a delivery tool, not a substitute for those platforms&rsquo; own rules.</li>
      </ul>
    ),
  },
  {
    heading: '4. Acceptable use',
    body: (
      <>
        <p>You agree not to use SlimCast to:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>Stream content that is illegal, infringes someone else&rsquo;s intellectual property, or violates a third party&rsquo;s rights.</li>
          <li>Harass, threaten, defraud, or abuse others, or stream content that is obscene, defamatory, or otherwise unlawful.</li>
          <li>Attempt to circumvent token metering, rate limits, or other technical or billing controls.</li>
          <li>Probe, scan, or attack SlimCast&rsquo;s infrastructure, or attempt to gain unauthorized access to another user&rsquo;s account, stream keys, or data.</li>
          <li>Reverse-engineer, resell, sublicense, or use the Service to build a competing product, except as permitted by law.</li>
          <li>Use the Service to transmit malware or otherwise interfere with the infrastructure that runs it, including the shared cloud GPUs used for transcoding.</li>
          <li>Use the Service in a way that we reasonably believe exposes SlimCast, our infrastructure providers, or other users to legal liability, abuse, or excessive cost.</li>
        </ul>
        <p className="mt-3">
          Violating this section is grounds for suspension or termination under Section 7.
        </p>
      </>
    ),
  },
  {
    heading: '5. Your content and platform connections',
    body: (
      <p>
        You retain all rights to the video and audio you stream through SlimCast. You&rsquo;re
        solely responsible for that content and for having the rights necessary to stream it to
        each platform you connect. When you connect a platform via OAuth or paste a stream key, you
        authorize SlimCast to store that credential (encrypted) and use it solely to deliver your
        stream to that platform on your instruction. Your stream keys are never exposed to the
        rented GPUs that transcode your video.
      </p>
    ),
  },
  {
    heading: '6. Billing, tokens, and refunds',
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>SlimCast is metered by tokens, purchased individually (pay-as-you-go) or granted monthly under a subscription, per the pricing page.</li>
        <li>Tokens are consumed based on your streaming activity as described in our pricing terms, and once consumed for a completed stream are not refundable.</li>
        <li>Subscriptions renew automatically until canceled; you can cancel anytime from your dashboard, effective at the end of the current billing period.</li>
        <li>Payments are processed by Stripe. We don&rsquo;t store your full card number.</li>
        <li>We may offer promotional or free tokens (e.g. on signup) at our discretion; these have no cash value and may be revoked if obtained through abuse of the promotion.</li>
      </ul>
    ),
  },
  {
    heading: '7. Suspension, termination, and refunds on revocation',
    body: (
      <>
        <p>
          <strong className="text-ink">
            SlimCast may suspend or terminate your access to the Service, and revoke your account,
            at any time and at our discretion
          </strong>
          , including (without limitation) for violating Section 4 (Acceptable Use), suspected
          fraud or abuse, non-payment, legal or security risk to SlimCast or other users, or
          extended account inactivity.
        </p>
        <p className="mt-3">
          If we revoke your account access,{' '}
          <strong className="text-ink">
            we will refund the value of your unused, purchased token balance
          </strong>{' '}
          to your original payment method, less any tokens already consumed by completed streams
          at the time of revocation. Promotional or subscription-allotment tokens that have no cash
          value are not refunded. We may withhold a refund where the revocation is due to fraud,
          chargeback abuse, or other unlawful conduct.
        </p>
        <p className="mt-3">
          You may stop using SlimCast and delete your account at any time from your dashboard
          settings; deleting your account destroys any active streaming session and, where you hold
          a purchased token balance, follows the same refund/forfeiture process described above and
          in our{' '}
          <a href="/privacy" className="text-primary underline underline-offset-4">
            Privacy Policy
          </a>
          .
        </p>
      </>
    ),
  },
  {
    heading: '8. Service availability',
    body: (
      <p>
        SlimCast depends on third-party infrastructure providers (cloud GPU and VPS providers,
        payment processors, and the platforms you stream to) that we don&rsquo;t control. We work
        to keep the Service reliable, but we don&rsquo;t guarantee uninterrupted or error-free
        operation, and we&rsquo;re not responsible for outages or failures caused by those
        third-party providers. We may modify, suspend, or discontinue any part of the Service at
        any time.
      </p>
    ),
  },
  {
    heading: '9. Disclaimer of warranties',
    body: (
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT
        WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT, TO THE MAXIMUM
        EXTENT PERMITTED BY LAW.
      </p>
    ),
  },
  {
    heading: '10. Limitation of liability',
    body: (
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, SLIMCAST AND ABSTRASCAPES LLC WILL NOT BE LIABLE
        FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
        PROFITS, REVENUE, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE. OUR TOTAL
        LIABILITY FOR ANY CLAIM ARISING FROM THESE TERMS OR THE SERVICE WILL NOT EXCEED THE AMOUNT
        YOU PAID TO SLIMCAST IN THE 3 MONTHS BEFORE THE CLAIM AROSE.
      </p>
    ),
  },
  {
    heading: '11. Indemnification',
    body: (
      <p>
        You agree to indemnify and hold harmless SlimCast and AbstraScapes LLC from any claims,
        damages, or expenses (including reasonable legal fees) arising from your content, your use
        of the Service in violation of these Terms, or your violation of a third party&rsquo;s
        rights, including any streaming platform&rsquo;s terms of service.
      </p>
    ),
  },
  {
    heading: '12. Changes to these Terms',
    body: (
      <p>
        We may update these Terms as the Service evolves. We&rsquo;ll update the &ldquo;last
        updated&rdquo; date above, and for material changes we&rsquo;ll make a reasonable effort to
        notify you. Continuing to use SlimCast after changes take effect means you accept the
        updated Terms.
      </p>
    ),
  },
  {
    heading: '13. Governing law',
    body: (
      <p>
        These Terms are governed by the laws of the State of Florida, USA, without regard to its
        conflict-of-laws rules. Any dispute arising from these Terms or the Service will be subject
        to the exclusive jurisdiction of the state and federal courts located in Florida, and you
        consent to personal jurisdiction there.
      </p>
    ),
  },
  {
    heading: '14. Contact us',
    body: (
      <p>
        Questions about these Terms? Email{' '}
        <a href="mailto:oxlynum@gmail.com" className="text-primary underline underline-offset-4">
          oxlynum@gmail.com
        </a>
        . We&rsquo;re AbstraScapes LLC, Florida, USA.
      </p>
    ),
  },
]

export default function TermsPage() {
  return (
    <>
      <section className="border-b border-line">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-14 text-center md:pt-28">
          <div className="flex justify-center">
            <Kicker>Legal</Kicker>
          </div>
          <h1 className="mt-5 font-display text-[clamp(2.5rem,5.5vw,4rem)] leading-[1.05] font-bold tracking-[-0.02em] text-ink">
            Terms of <GradientText as="span">Service</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-muted">
            The ground rules for using SlimCast — plain terms, no surprises.
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
